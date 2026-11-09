import { vatFilingSchema, vatPeriodQuerySchema } from '@lumio/validation';
import { Router } from 'express';
import mongoose, { Types } from 'mongoose';
import type { z } from 'zod';
import { RS, tenantModel, tenantSchema } from '../../database/tenant-schema.js';
import { requirePermission } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import type { RequestContext } from '../../shared/context.js';
import { dec, Decimal } from '../../shared/decimal.js';
import { ConflictError } from '../../shared/errors.js';
import { sendSuccess } from '../../shared/http.js';
import { plain } from '../../shared/serialize.js';
import { JournalLineModel, LedgerAccountModel } from '../ledger/index.js';
import { BranchModel } from '../organisation/index.js';
import { recordAudit } from '../platform/audit/index.js';
import { TaxTransactionModel } from '../tax/index.js';

const vatReturnSchema = tenantSchema(
  'vatReturns',
  {
    from: { type: Date, required: true },
    to: { type: Date, required: true },
    boxes: { type: Object, required: true },
    ftaReference: RS,
    filedBy: RS,
    filedAt: { type: Date, required: true },
  },
  { appendOnly: true },
);
vatReturnSchema.index({ companyId: 1, from: 1, to: 1 }, { unique: true });
export const VatReturnModel = tenantModel('VatReturn', vatReturnSchema);

export const EMIRATES = [
  'ABU_DHABI',
  'DUBAI',
  'SHARJAH',
  'AJMAN',
  'UMM_AL_QUWAIN',
  'RAS_AL_KHAIMAH',
  'FUJAIRAH',
] as const;

type Amounts = { amount: Decimal; vat: Decimal };
const zero = (): Amounts => ({ amount: new Decimal(0), vat: new Decimal(0) });
const out = (a: Amounts) => ({ amount: a.amount.toFixed(2), vat: a.vat.toFixed(2) });

const dayRange = (from: string, to: string) => ({
  from: new Date(`${from}T00:00:00.000Z`),
  to: new Date(`${to}T23:59:59.999Z`),
});

/**
 * Lays out VAT Form 201 from tax transactions. Imports, adjustments and tourist refunds are not
 * captured by this system, so those boxes are zero and must be completed on the FTA portal.
 */
export async function vatReturn(ctx: RequestContext, from: string, to: string) {
  const range = dayRange(from, to);
  const rows = await TaxTransactionModel.find({
    companyId: ctx.companyId,
    date: mongoose.trusted({ $gte: range.from, $lte: range.to }),
  }).lean();
  const branches = await BranchModel.find({ companyId: ctx.companyId }).lean();
  const emirateOf = new Map(branches.map((b) => [String(b._id), b.emirate as string | undefined]));

  const byEmirate = new Map<string, Amounts>();
  const box = { three: zero(), four: zero(), five: zero(), nine: zero(), ten: zero() };
  const reverseChargeSales = zero();
  const add = (target: Amounts, taxable: Decimal, tax: Decimal) => {
    target.amount = target.amount.plus(taxable);
    target.vat = target.vat.plus(tax);
  };
  for (const row of rows) {
    const taxable = dec(row.taxable);
    const tax = dec(row.tax);
    if (row.direction === 'OUTPUT') {
      if (row.treatment === 'STANDARD') {
        const emirate = emirateOf.get(String(row.branchId)) ?? 'UNASSIGNED';
        const target = byEmirate.get(emirate) ?? zero();
        add(target, taxable, tax);
        byEmirate.set(emirate, target);
      } else if (row.treatment === 'ZERO') add(box.four, taxable, new Decimal(0));
      else if (row.treatment === 'EXEMPT') add(box.five, taxable, new Decimal(0));
      else if (row.treatment === 'REVERSE_CHARGE') add(reverseChargeSales, taxable, new Decimal(0));
    } else if (row.treatment === 'REVERSE_CHARGE') {
      add(box.three, taxable, tax);
      add(box.ten, taxable, tax);
    } else if (row.treatment === 'STANDARD') add(box.nine, taxable, tax);
  }

  const sum = (...items: Amounts[]) => {
    const total = zero();
    for (const item of items) add(total, item.amount, item.vat);
    return total;
  };
  const standard = [...byEmirate.values()];
  const eight = sum(...standard, box.three, box.four, box.five);
  const eleven = sum(box.nine, box.ten);
  const warnings: string[] = [];
  if (byEmirate.has('UNASSIGNED')) {
    warnings.push('Some sales are from a branch with no emirate set. Set it under Branches.');
  }
  if (!reverseChargeSales.amount.isZero()) {
    warnings.push(
      'Sales under the reverse charge are shown separately. Confirm with your adviser where they are declared.',
    );
  }
  return {
    from,
    to,
    box1ByEmirate: Object.fromEntries([...byEmirate].map(([k, v]) => [k, out(v)])),
    box2TouristRefunds: out(zero()),
    box3ReverseCharge: out(box.three),
    box4ZeroRated: out(box.four),
    box5Exempt: out(box.five),
    box6Imports: out(zero()),
    box7ImportAdjustments: out(zero()),
    box8TotalOutput: out(eight),
    box9StandardExpenses: out(box.nine),
    box10ReverseChargeRecoverable: out(box.ten),
    box11TotalInput: out(eleven),
    box12TotalDue: eight.vat.toFixed(2),
    box13TotalRecoverable: eleven.vat.toFixed(2),
    box14NetPayable: eight.vat.minus(eleven.vat).toFixed(2),
    reverseChargeSalesMemo: out(reverseChargeSales),
    warnings,
  };
}

async function ledgerNet(ctx: RequestContext, role: string, from: Date, to: Date) {
  const account = await LedgerAccountModel.findOne({
    companyId: ctx.companyId,
    systemRole: role,
  }).lean();
  if (!account) return new Decimal(0);
  const [total] = await JournalLineModel.aggregate([
    {
      $match: {
        companyId: ctx.companyId,
        accountId: new Types.ObjectId(account._id.toString()),
        postingDate: { $gte: from, $lte: to },
      },
    },
    { $group: { _id: null, debit: { $sum: '$debit' }, credit: { $sum: '$credit' } } },
  ]);
  return dec(total?.debit).minus(dec(total?.credit));
}

/** Compares the VAT reported with what the ledger holds. Any difference needs explaining. */
export async function vatReconciliation(ctx: RequestContext, from: string, to: string) {
  const range = dayRange(from, to);
  const rows = await TaxTransactionModel.find({
    companyId: ctx.companyId,
    date: mongoose.trusted({ $gte: range.from, $lte: range.to }),
  }).lean();
  let reportedOutput = new Decimal(0);
  let reportedInput = new Decimal(0);
  for (const row of rows) {
    const tax = dec(row.tax);
    if (row.direction === 'INPUT') {
      reportedInput = reportedInput.plus(tax);
      // A reverse charge purchase also accounts for output VAT.
      if (row.treatment === 'REVERSE_CHARGE') reportedOutput = reportedOutput.plus(tax);
    } else if (row.treatment === 'STANDARD') reportedOutput = reportedOutput.plus(tax);
  }
  const ledgerOutput = (await ledgerNet(ctx, 'OUTPUT_VAT', range.from, range.to)).negated();
  const ledgerInput = await ledgerNet(ctx, 'INPUT_VAT', range.from, range.to);
  const line = (reported: Decimal, ledger: Decimal) => ({
    reported: reported.toFixed(2),
    ledger: ledger.toFixed(2),
    difference: ledger.minus(reported).toFixed(2),
  });
  const output = line(reportedOutput, ledgerOutput);
  const input = line(reportedInput, ledgerInput);
  return {
    from,
    to,
    output,
    input,
    balanced: dec(output.difference).isZero() && dec(input.difference).isZero(),
  };
}

type Period = z.infer<typeof vatPeriodQuerySchema>;

export function createVatRouter(): Router {
  const router = Router();
  const query = validate({ query: vatPeriodQuerySchema });

  router.get('/vat-return', requirePermission('tax:read'), query, async (req, res) => {
    const { from, to } = req.validated.query as Period;
    sendSuccess(req, res, await vatReturn(req.ctx, from, to));
  });
  router.get('/vat-reconciliation', requirePermission('tax:read'), query, async (req, res) => {
    const { from, to } = req.validated.query as Period;
    sendSuccess(req, res, await vatReconciliation(req.ctx, from, to));
  });
  router.get('/vat-returns', requirePermission('tax:read'), async (req, res) => {
    const rows = await VatReturnModel.find({ companyId: req.ctx.companyId })
      .sort({ from: -1 })
      .limit(100)
      .lean();
    sendSuccess(req, res, plain(rows));
  });
  /** Records a filing made on the FTA portal, keeping the figures exactly as filed. */
  router.post(
    '/vat-returns',
    requirePermission('tax:update'),
    validate({ body: vatFilingSchema }),
    async (req, res) => {
      const { from, to, ftaReference } = req.validated.body as z.infer<typeof vatFilingSchema>;
      const range = dayRange(from, to);
      const boxes = await vatReturn(req.ctx, from, to);
      try {
        const filed = await VatReturnModel.create({
          companyId: req.ctx.companyId,
          ...range,
          boxes,
          ftaReference,
          filedBy: req.ctx.userId,
          filedAt: new Date(),
        });
        await recordAudit(req.ctx, {
          action: 'vat_return.file',
          entityType: 'vat_return',
          entityId: String(filed._id),
          after: { from, to, ftaReference },
        });
        sendSuccess(req, res, plain(filed.toObject()), 201);
      } catch (error) {
        if (error instanceof mongoose.mongo.MongoServerError && error.code === 11000) {
          throw new ConflictError('A return for this period has already been filed.');
        }
        throw error;
      }
    },
  );
  return router;
}
