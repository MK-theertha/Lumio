import {
  metalFixSchema,
  metalIssueSchema,
  metalReceiptSchema,
  objectIdSchema,
} from '@lumio/validation';
import { Router } from 'express';
import mongoose, { Types } from 'mongoose';
import { z } from 'zod';
import { runInTransaction, retryDuplicateKeyInTransaction } from '../../database/transaction.js';
import {
  D128,
  OID,
  ROID,
  RD128,
  RS,
  tenantModel,
  tenantSchema,
} from '../../database/tenant-schema.js';
import { requirePermission } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import {
  assertBranchAccess,
  type RequestContext,
  type TransactionalContext,
} from '../../shared/context.js';
import { d128, dec, Decimal } from '../../shared/decimal.js';
import { BusinessRuleError, NotFoundError } from '../../shared/errors.js';
import { sendSuccess } from '../../shared/http.js';
import { plain } from '../../shared/serialize.js';
import { assertPartyNotOnHold } from '../compliance/index.js';
import { changePartyBalance, createOpenItem, PartyBalanceModel } from '../finance/index.js';
import {
  productWithPurity,
  receiveInto,
  stockOut,
  stockOutOldestFirst,
  stockPolicy,
} from '../inventory/index.js';
import { postJournal, type PostingLine } from '../ledger/index.js';
import { PartyModel } from '../master/index.js';
import { WarehouseModel } from '../organisation/index.js';
import { recordAudit } from '../platform/audit/index.js';
import { allocateNumber } from '../platform/numbering/index.js';
import { enqueueEvent } from '../platform/outbox/index.js';
import { determineTax, recordTaxTransaction } from '../tax/index.js';

export const METAL_FIXED_EVENT = 'metal.fixed';

const metalTransactionSchema = tenantSchema(
  'metalTransactions',
  {
    number: RS,
    type: { type: String, enum: ['RECEIVE', 'ISSUE', 'FIX'], required: true },
    partyId: ROID,
    branchId: ROID,
    date: { type: Date, required: true },
    // Positive when the company owes the party metal after this entry adds to the balance.
    fineGrams: RD128,
    carryingValue: RD128,
    productId: OID,
    grossWeight: D128,
    ratePerFineGram: D128,
    taxable: D128,
    tax: D128,
    memo: String,
    journalEntryId: ROID,
    createdBy: RS,
    at: { type: Date, required: true },
  },
  { appendOnly: true },
);
metalTransactionSchema.index({ companyId: 1, number: 1 }, { unique: true });
metalTransactionSchema.index({ companyId: 1, partyId: 1, at: 1 });
export const MetalTransactionModel = tenantModel('MetalTransaction', metalTransactionSchema);

type ReceiptInput = z.infer<typeof metalReceiptSchema>;
type IssueInput = z.infer<typeof metalIssueSchema>;
type FixInput = z.infer<typeof metalFixSchema>;

async function loadParty(tx: TransactionalContext, partyId: string) {
  const party = await PartyModel.findOne({ companyId: tx.companyId, _id: partyId })
    .session(tx.session)
    .lean();
  if (!party) throw new NotFoundError('The party was not found.');
  await assertPartyNotOnHold(tx, party._id);
  return party;
}

async function branchOf(tx: TransactionalContext, warehouseId: string): Promise<Types.ObjectId> {
  const warehouse = await WarehouseModel.findOne({ companyId: tx.companyId, _id: warehouseId })
    .session(tx.session)
    .lean();
  if (!warehouse) throw new NotFoundError('The warehouse was not found.');
  return warehouse.branchId as Types.ObjectId;
}

function changeMetal(
  tx: TransactionalContext,
  partyId: Types.ObjectId | string,
  fine: Decimal,
  value: Decimal,
) {
  return PartyBalanceModel.updateOne(
    { companyId: tx.companyId, partyId },
    {
      $inc: {
        metalFine: d128(fine),
        metalValue: d128(value),
        receivable: d128(new Decimal(0)),
        payable: d128(new Decimal(0)),
      },
    },
    { upsert: true, session: tx.session },
  ).catch(retryDuplicateKeyInTransaction);
}

const nextNumber = (tx: TransactionalContext) =>
  allocateNumber(tx, { documentType: 'MTL', scope: 'COMPANY', prefix: 'MTL-', padding: 7 });

async function writeEntry(
  tx: TransactionalContext,
  entry: Record<string, unknown> & { number: string; type: string },
) {
  const [created] = await MetalTransactionModel.create(
    [{ ...entry, companyId: tx.companyId, createdBy: tx.userId, at: new Date() }] as never[],
    { session: tx.session },
  );
  await recordAudit(tx, {
    action: `metal.${entry.type.toLowerCase()}`,
    entityType: 'metal_transaction',
    entityId: String((created as unknown as { _id: Types.ObjectId })._id),
    after: { number: entry.number, fineGrams: String(entry.fineGrams) },
  });
  return (created as unknown as { toObject(): unknown }).toObject();
}

/** Takes in metal with no price agreed. The company owes the party those fine grams. */
export function receiveUnfixed(ctx: RequestContext, input: ReceiptInput) {
  return runInTransaction(ctx, async (tx) => {
    const party = await loadParty(tx, input.partyId);
    const branchId = await branchOf(tx, input.warehouseId);
    assertBranchAccess(tx, branchId);
    const { purity } = await productWithPurity(tx, input.productId);
    const net = dec(input.grossWeight).minus(input.stoneWeight);
    if (net.lessThanOrEqualTo(0)) throw new BusinessRuleError('The net weight must be positive.');
    const fine = net.times(dec(purity.fineness)).toDecimalPlaces(4);
    const cost = fine.times(dec(input.provisionalRate)).toDecimalPlaces(2);
    const number = await nextNumber(tx);
    const sourceId = new Types.ObjectId().toString();
    await receiveInto(tx, {
      warehouseId: input.warehouseId,
      location: input.location,
      productId: input.productId,
      pieces: input.pieces,
      grossWeight: input.grossWeight,
      stoneWeight: input.stoneWeight,
      cost,
      ...(input.tag ? { tag: input.tag } : {}),
      sourceType: 'METAL_RECEIPT',
      sourceId,
      lineId: '1',
      type: 'METAL_RECEIPT',
    });
    const journal = await postJournal(tx, {
      postingDate: new Date(input.date),
      branchId,
      memo: `Unfixed metal received ${number}`,
      sourceType: 'METAL_RECEIPT',
      sourceId,
      kind: 'POSTING',
      lines: [
        { role: 'INVENTORY', debit: cost },
        { role: 'METAL_CLEARING', credit: cost, partyId: party._id },
      ],
    });
    await changeMetal(tx, party._id, fine, cost);
    return plain(
      await writeEntry(tx, {
        number,
        type: 'RECEIVE',
        partyId: party._id,
        branchId,
        date: new Date(input.date),
        fineGrams: d128(fine),
        carryingValue: d128(cost),
        productId: input.productId,
        grossWeight: d128(input.grossWeight),
        ratePerFineGram: d128(input.provisionalRate),
        ...(input.memo ? { memo: input.memo } : {}),
        journalEntryId: journal.entryId,
      }),
    );
  });
}

/** Gives out metal with no price agreed. The party then owes the company those fine grams. */
export function issueUnfixed(ctx: RequestContext, input: IssueInput) {
  return runInTransaction(ctx, async (tx) => {
    const party = await loadParty(tx, input.partyId);
    const branchId = await branchOf(tx, input.warehouseId);
    assertBranchAccess(tx, branchId);
    const { product, purity } = await productWithPurity(tx, input.productId);
    const company = await stockPolicy(tx);
    const net = dec(input.grossWeight).minus(input.stoneWeight);
    if (net.lessThanOrEqualTo(0)) throw new BusinessRuleError('The net weight must be positive.');
    const fine = net.times(dec(purity.fineness)).toDecimalPlaces(4);

    const balance = await PartyBalanceModel.findOne({ companyId: tx.companyId, partyId: party._id })
      .session(tx.session)
      .lean();
    if (party.metalLimitFine !== undefined && party.metalLimitFine !== null) {
      const owedAfter = dec(balance?.metalFine).minus(fine).negated();
      if (owedAfter.greaterThan(dec(party.metalLimitFine))) {
        throw new BusinessRuleError("This would exceed the party's unfixed metal limit.");
      }
    }

    const sourceId = new Types.ObjectId().toString();
    const key = {
      branchId,
      warehouseId: input.warehouseId,
      location: input.location,
      productId: product._id,
      purityId: purity._id,
    };
    const quantity = { pieces: input.pieces, gross: dec(input.grossWeight), net, fine };
    const source = { type: 'METAL_ISSUE', sourceType: 'METAL_ISSUE', sourceId, lineId: '1' };
    const policy = { allowNegative: false, moneyScale: company.settings?.pricing?.moneyScale ?? 2 };
    const cost = input.lotId
      ? await stockOut(tx, { ...key, lotId: input.lotId }, quantity, source, policy)
      : product.tracking === 'LOT'
        ? (await stockOutOldestFirst(tx, key, quantity, source, policy)).cost
        : await stockOut(tx, key, quantity, source, policy);

    const number = await nextNumber(tx);
    const journal = await postJournal(tx, {
      postingDate: new Date(input.date),
      branchId,
      memo: `Unfixed metal issued ${number}`,
      sourceType: 'METAL_ISSUE',
      sourceId,
      kind: 'POSTING',
      lines: [
        { role: 'METAL_CLEARING', debit: cost, partyId: party._id },
        { role: 'INVENTORY', credit: cost },
      ],
    });
    await changeMetal(tx, party._id, fine.negated(), cost.negated());
    return plain(
      await writeEntry(tx, {
        number,
        type: 'ISSUE',
        partyId: party._id,
        branchId,
        date: new Date(input.date),
        fineGrams: d128(fine.negated()),
        carryingValue: d128(cost.negated()),
        productId: input.productId,
        grossWeight: d128(input.grossWeight),
        ...(input.memo ? { memo: input.memo } : {}),
        journalEntryId: journal.entryId,
      }),
    );
  });
}

/**
 * Agrees a price for part of a party's balance. A positive balance is the company buying the metal;
 * a negative one is the company selling it. Any difference from the value it was carried at is a
 * trading gain or loss, and VAT follows the company's configured rules at the point of fixing.
 */
export function fixMetal(ctx: RequestContext, input: FixInput) {
  assertBranchAccess(ctx, input.branchId);
  return runInTransaction(ctx, async (tx) => {
    const party = await loadParty(tx, input.partyId);
    const balance = await PartyBalanceModel.findOne({ companyId: tx.companyId, partyId: party._id })
      .session(tx.session)
      .lean();
    const held = dec(balance?.metalFine);
    const fine = dec(input.fineGrams);
    if (fine.lessThanOrEqualTo(0) || fine.greaterThan(held.abs())) {
      throw new BusinessRuleError('Fix more than zero, and no more than the unfixed balance.');
    }
    const buying = held.isPositive();
    const direction = buying ? ('PURCHASE' as const) : ('SALE' as const);
    const carrying = dec(balance?.metalValue)
      .abs()
      .times(fine)
      .dividedBy(held.abs())
      .toDecimalPlaces(2);
    const taxable = fine.times(dec(input.ratePerFineGram)).toDecimalPlaces(2);

    const company = await stockPolicy(tx);
    const taxDecision = await determineTax(
      tx,
      {
        direction,
        productKind: input.productKind,
        fineness: input.fineness,
        partyVatRegistered: party.vatRegistered ?? false,
      },
      company.settings?.requireVerifiedTaxCodes ?? true,
    );
    const reverse = taxDecision.treatment === 'REVERSE_CHARGE';
    const computed = taxable.times(taxDecision.ratePercent).dividedBy(100).toDecimalPlaces(2);
    const tax = reverse ? new Decimal(0) : computed;
    const total = taxable.plus(tax);
    const difference = taxable.minus(carrying);

    const date = new Date(input.date);
    const number = await nextNumber(tx);
    const sourceId = new Types.ObjectId().toString();
    const lines: PostingLine[] = buying
      ? [
          { role: 'METAL_CLEARING', debit: carrying, partyId: party._id },
          difference.isNegative()
            ? { role: 'STOCK_GAIN_LOSS', credit: difference.abs() }
            : { role: 'STOCK_GAIN_LOSS', debit: difference },
          { role: 'INPUT_VAT', debit: tax.plus(reverse ? computed : 0) },
          { role: 'OUTPUT_VAT', credit: reverse ? computed : new Decimal(0) },
          { role: 'AP', credit: total, partyId: party._id },
        ]
      : [
          { role: 'AR', debit: total, partyId: party._id },
          { role: 'METAL_CLEARING', credit: carrying, partyId: party._id },
          difference.isNegative()
            ? { role: 'STOCK_GAIN_LOSS', debit: difference.abs() }
            : { role: 'STOCK_GAIN_LOSS', credit: difference },
          { role: 'OUTPUT_VAT', credit: tax },
        ];
    const journal = await postJournal(tx, {
      postingDate: date,
      branchId: input.branchId,
      memo: `Metal fixing ${number}`,
      sourceType: 'METAL_FIX',
      sourceId,
      kind: 'POSTING',
      lines,
    });
    await recordTaxTransaction(tx, {
      sourceType: 'METAL_FIX',
      sourceId,
      branchId: input.branchId,
      partyId: party._id,
      direction: buying ? 'INPUT' : 'OUTPUT',
      treatment: taxDecision.treatment,
      taxCode: taxDecision.code,
      ratePercent: taxDecision.ratePercent,
      taxable: taxable.toFixed(),
      tax: (reverse ? computed : tax).toFixed(),
      date,
    });

    const side = buying ? ('PAYABLE' as const) : ('RECEIVABLE' as const);
    await createOpenItem(tx, {
      partyId: party._id,
      side,
      sourceType: 'METAL_FIX',
      sourceId,
      number,
      branchId: input.branchId,
      docDate: date,
      dueDate: date,
      amount: total,
    });
    await changePartyBalance(tx, party._id, side, total);
    const fineChange = buying ? fine.negated() : fine;
    const valueChange = buying ? carrying.negated() : carrying;
    await changeMetal(tx, party._id, fineChange, valueChange);
    const entry = await writeEntry(tx, {
      number,
      type: 'FIX',
      partyId: party._id,
      branchId: input.branchId,
      date,
      fineGrams: d128(fineChange),
      carryingValue: d128(valueChange),
      ratePerFineGram: d128(input.ratePerFineGram),
      taxable: d128(taxable),
      tax: d128(tax),
      ...(input.memo ? { memo: input.memo } : {}),
      journalEntryId: journal.entryId,
    });
    await enqueueEvent(tx, METAL_FIXED_EVENT, {
      id: sourceId,
      number,
      partyId: party._id.toString(),
      total: total.toFixed(),
      direction,
    });
    return plain(entry);
  });
}

export function createMetalRouter(): Router {
  const router = Router();

  router.get('/', requirePermission('metal:read'), async (req, res) => {
    const rows = await PartyBalanceModel.find({
      companyId: req.ctx.companyId,
      metalFine: mongoose.trusted({ $nin: [null, d128('0')] }),
    }).lean();
    const parties = await PartyModel.find({
      companyId: req.ctx.companyId,
      _id: mongoose.trusted({ $in: rows.map((r) => r.partyId) }),
    })
      .select({ name: 1, code: 1 })
      .lean();
    const name = new Map(parties.map((p) => [String(p._id), `${p.code} ${p.name}`]));
    const output = rows
      .filter((r) => !dec(r.metalFine).isZero())
      .map((r) => ({
        id: String(r.partyId),
        partyId: String(r.partyId),
        party: name.get(String(r.partyId)) ?? '',
        fineGrams: dec(r.metalFine).toFixed(4),
        carryingValue: dec(r.metalValue).toFixed(2),
      }));
    const net = output.reduce((sum, r) => sum.plus(r.fineGrams), new Decimal(0));
    sendSuccess(req, res, { netFineOwedToParties: net.toFixed(4), rows: output });
  });

  router.get(
    '/:id/statement',
    requirePermission('metal:read'),
    validate({ params: z.object({ id: objectIdSchema }) }),
    async (req, res) => {
      const party = await PartyModel.findOne({
        companyId: req.ctx.companyId,
        _id: req.params.id,
      }).lean();
      if (!party) throw new NotFoundError();
      const rows = await MetalTransactionModel.find({
        companyId: req.ctx.companyId,
        partyId: req.params.id,
      })
        .sort({ at: 1, _id: 1 })
        .limit(5000)
        .lean();
      let balance = new Decimal(0);
      sendSuccess(req, res, {
        party: party.name,
        rows: rows.map((row) => {
          balance = balance.plus(dec(row.fineGrams));
          return { ...plain<object>(row), balance: balance.toFixed(4) };
        }),
      });
    },
  );

  router.post(
    '/receipts',
    requirePermission('metal:create'),
    validate({ body: metalReceiptSchema }),
    async (req, res) => {
      sendSuccess(req, res, await receiveUnfixed(req.ctx, req.validated.body as ReceiptInput), 201);
    },
  );
  router.post(
    '/issues',
    requirePermission('metal:create'),
    validate({ body: metalIssueSchema }),
    async (req, res) => {
      sendSuccess(req, res, await issueUnfixed(req.ctx, req.validated.body as IssueInput), 201);
    },
  );
  router.post(
    '/fixes',
    requirePermission('metal:fix'),
    validate({ body: metalFixSchema }),
    async (req, res) => {
      sendSuccess(req, res, await fixMetal(req.ctx, req.validated.body as FixInput), 201);
    },
  );
  return router;
}
