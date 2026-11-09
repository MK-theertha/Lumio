import { createHash } from 'node:crypto';
import { canonicalJson } from '@lumio/shared-utils';
import mongoose, { type Model, type Types } from 'mongoose';
import { RS, tenantModel, tenantSchema } from '../../database/tenant-schema.js';
import { dec, Decimal } from '../../shared/decimal.js';
import { plain } from '../../shared/serialize.js';
import type { ObjectStore } from '../documents/index.js';
import { PartyBalanceModel, PaymentModel } from '../finance/index.js';
import { StockBalanceModel, StockMovementModel } from '../inventory/index.js';
import {
  FinancialPeriodModel,
  JournalEntryModel,
  JournalLineModel,
  LedgerAccountModel,
  PostingProfileModel,
} from '../ledger/index.js';
import { MetalTransactionModel } from '../metal/index.js';
import { notify } from '../notifications/index.js';
import { CreditNoteModel, PurchaseInvoiceModel, SalesInvoiceModel } from '../trade/index.js';
import { verifyAuditSeals } from './audit-seal.js';

const WEIGHT_TOLERANCE = '0.001';
const MONEY_TOLERANCE = '0.05';

const integrityRunSchema = tenantSchema(
  'integrityRuns',
  {
    status: { type: String, enum: ['PASSED', 'FAILED'], required: true },
    checks: { type: [String], required: true },
    findings: { type: [{ _id: false, check: RS, detail: RS }], default: [] },
    startedAt: { type: Date, required: true },
    finishedAt: { type: Date, required: true },
  },
  { appendOnly: true },
);
integrityRunSchema.index({ companyId: 1, startedAt: -1 });
export const IntegrityRunModel = tenantModel('IntegrityRun', integrityRunSchema);

export interface Finding {
  check: string;
  detail: string;
}
type Check = (companyId: Types.ObjectId, store?: ObjectStore) => Promise<string[]>;

const LIMIT = 50;

/** I1: lines add up, and agree with the totals on their header. */
const journalsBalance: Check = async (companyId) => {
  const groups = await JournalLineModel.aggregate([
    { $match: { companyId } },
    { $group: { _id: '$entryId', debit: { $sum: '$debit' }, credit: { $sum: '$credit' } } },
  ]);
  const totals = new Map(
    groups.map((g: { _id: Types.ObjectId; debit: unknown; credit: unknown }) => [
      g._id.toString(),
      g,
    ]),
  );
  const entries = await JournalEntryModel.find({ companyId })
    .select({ number: 1, totalDebit: 1, totalCredit: 1 })
    .lean();
  const problems: string[] = [];
  for (const entry of entries) {
    const lines = totals.get(String(entry._id));
    const debit = dec(lines?.debit as never);
    const credit = dec(lines?.credit as never);
    if (!debit.equals(credit)) problems.push(`Journal ${entry.number} does not balance.`);
    else if (!debit.equals(dec(entry.totalDebit)) || !credit.equals(dec(entry.totalCredit))) {
      problems.push(`Journal ${entry.number} disagrees with its header.`);
    }
  }
  return problems;
};

/** I3: every stock balance equals the sum of its movements. */
const stockMatchesMovements: Check = async (companyId) => {
  const key = (row: Record<string, unknown>) =>
    ['warehouseId', 'location', 'productId', 'lotId']
      .map((field) => String(row[field] ?? ''))
      .join('|');
  const movements = await StockMovementModel.aggregate([
    { $match: { companyId } },
    {
      $group: {
        _id: {
          warehouseId: '$warehouseId',
          location: '$location',
          productId: '$productId',
          lotId: '$lotId',
        },
        net: { $sum: '$net' },
      },
    },
  ]);
  const totals = new Map(
    movements.map((m: { _id: Record<string, unknown>; net: never }) => [key(m._id), dec(m.net)]),
  );
  const balances = await StockBalanceModel.find({ companyId }).lean();
  const problems: string[] = [];
  for (const balance of balances) {
    const expected = totals.get(key(balance)) ?? new Decimal(0);
    if (dec(balance.net).minus(expected).abs().greaterThan(WEIGHT_TOLERANCE)) {
      problems.push(
        `Stock balance ${String(balance._id)} is ${dec(balance.net).toFixed(3)} but its movements add up to ${expected.toFixed(3)}.`,
      );
    }
  }
  return problems;
};

async function ledgerBalance(companyId: Types.ObjectId, role: string): Promise<Decimal> {
  const account = await LedgerAccountModel.findOne({ companyId, systemRole: role }).lean();
  if (!account) return new Decimal(0);
  // A role can post to branch accounts as well as its main one.
  const profiles = await PostingProfileModel.find({ companyId, role }).lean();
  const accountIds = [account._id, ...profiles.map((p) => p.accountId)];
  const [total] = await JournalLineModel.aggregate([
    { $match: { companyId, accountId: { $in: accountIds } } },
    { $group: { _id: null, debit: { $sum: '$debit' }, credit: { $sum: '$credit' } } },
  ]);
  return dec(total?.debit).minus(dec(total?.credit));
}

const compare = (label: string, books: Decimal, subledger: Decimal): string[] =>
  books.minus(subledger).abs().greaterThan(MONEY_TOLERANCE)
    ? [`${label}: ledger ${books.toFixed(2)}, detail ${subledger.toFixed(2)}.`]
    : [];

/** I6: the inventory control account equals the value of stock on hand. */
const inventoryMatchesLedger: Check = async (companyId) => {
  const [total] = await StockBalanceModel.aggregate([
    { $match: { companyId } },
    { $group: { _id: null, cost: { $sum: '$cost' } } },
  ]);
  return compare('Inventory', await ledgerBalance(companyId, 'INVENTORY'), dec(total?.cost));
};

/** I7: the receivable and payable control accounts equal the party balances. */
const controlAccountsMatch: Check = async (companyId) => {
  const [total] = await PartyBalanceModel.aggregate([
    { $match: { companyId } },
    { $group: { _id: null, receivable: { $sum: '$receivable' }, payable: { $sum: '$payable' } } },
  ]);
  return [
    ...compare('Accounts receivable', await ledgerBalance(companyId, 'AR'), dec(total?.receivable)),
    ...compare(
      'Accounts payable',
      (await ledgerBalance(companyId, 'AP')).negated(),
      dec(total?.payable),
    ),
  ];
};

/** The unfixed metal account equals the carrying value held against parties. */
const metalMatchesLedger: Check = async (companyId) => {
  const [total] = await PartyBalanceModel.aggregate([
    { $match: { companyId } },
    { $group: { _id: null, value: { $sum: '$metalValue' }, fine: { $sum: '$metalFine' } } },
  ]);
  const [entries] = await MetalTransactionModel.aggregate([
    { $match: { companyId } },
    { $group: { _id: null, fine: { $sum: '$fineGrams' } } },
  ]);
  const fineGap = dec(total?.fine).minus(dec(entries?.fine)).abs();
  return [
    ...compare(
      'Unfixed metal',
      (await ledgerBalance(companyId, 'METAL_CLEARING')).negated(),
      dec(total?.value),
    ),
    ...(fineGap.greaterThan(WEIGHT_TOLERANCE)
      ? [`Party metal balances differ from their entries by ${fineGap.toFixed(4)} fine grams.`]
      : []),
  ];
};

/** I8: business numbers run without gaps inside each series. */
const numbersAreGapless: Check = async (companyId) => {
  const problems: string[] = [];
  const sources = [
    ['Sales invoice', SalesInvoiceModel],
    ['Purchase invoice', PurchaseInvoiceModel],
    ['Payment', PaymentModel],
    ['Credit note', CreditNoteModel],
    ['Journal', JournalEntryModel],
  ] as const;
  for (const [label, source] of sources) {
    const model = source as unknown as Model<{ number?: string }>;
    const rows = await model
      .find({ companyId, number: mongoose.trusted({ $type: 'string' }) })
      .select({ number: 1 })
      .lean();
    const series = new Map<string, number[]>();
    for (const { number } of rows as { number: string }[]) {
      const match = /^(.*?)(\d+)$/.exec(number);
      if (!match) continue;
      const list = series.get(match[1] as string) ?? [];
      list.push(Number(match[2]));
      series.set(match[1] as string, list);
    }
    for (const [prefix, numbers] of series) {
      const present = new Set(numbers);
      const max = Math.max(...numbers);
      for (let n = 1; n <= max && problems.length < LIMIT; n += 1) {
        if (!present.has(n)) problems.push(`${label} ${prefix}${n} is missing from its series.`);
      }
    }
  }
  return problems;
};

/** I9: every journal that claims a source document has one. */
const journalsTraceToSource: Check = async (companyId) => {
  const sources = {
    SALES_INVOICE: SalesInvoiceModel,
    PURCHASE_INVOICE: PurchaseInvoiceModel,
    PAYMENT: PaymentModel,
    CREDIT_NOTE: CreditNoteModel,
  } as const;
  const problems: string[] = [];
  for (const [sourceType, source] of Object.entries(sources)) {
    const model = source as unknown as Model<{ _id: Types.ObjectId }>;
    const entries = await JournalEntryModel.find({ companyId, sourceType })
      .select({ number: 1, sourceId: 1 })
      .lean();
    const found = new Set(
      (
        await model
          .find({ companyId, _id: mongoose.trusted({ $in: entries.map((e) => e.sourceId) }) })
          .select({ _id: 1 })
          .lean()
      ).map((row) => String(row._id)),
    );
    for (const entry of entries) {
      if (!found.has(entry.sourceId)) problems.push(`Journal ${entry.number} has no source.`);
    }
  }
  return problems;
};

/** I10: nothing was posted into a period after it closed. */
const closedPeriodsUntouched: Check = async (companyId) => {
  const periods = await FinancialPeriodModel.find({ companyId, status: 'CLOSED' }).lean();
  const problems: string[] = [];
  for (const period of periods) {
    const late = await JournalEntryModel.countDocuments({
      companyId,
      periodId: period._id,
      postedAt: mongoose.trusted({ $gt: period.updatedAt }),
    });
    if (late > 0)
      problems.push(`${late} journal(s) were posted into ${period.name} after it closed.`);
  }
  return problems;
};

/** I2: a posted invoice still matches the hash taken when it was posted. */
const postedDocumentsUnchanged: Check = async (companyId) => {
  const problems: string[] = [];
  for (const model of [SalesInvoiceModel, PurchaseInvoiceModel]) {
    // A return legitimately marks lines, so only documents still in their posted state are comparable.
    const rows = await model.find({ companyId, status: 'POSTED' }).lean();
    for (const doc of rows) {
      const hash = createHash('sha256')
        .update(
          canonicalJson(
            plain({
              number: doc.number,
              lines: doc.lines,
              partyId: doc.partyId,
              total: doc.grandTotal,
            }),
          ),
        )
        .digest('hex');
      if (hash !== doc.postedHash) problems.push(`Invoice ${doc.number} has been altered.`);
    }
  }
  return problems;
};

const CHECKS: Record<string, Check> = {
  'Journals balance': journalsBalance,
  'Stock equals movements': stockMatchesMovements,
  'Inventory equals ledger': inventoryMatchesLedger,
  'Control accounts equal party balances': controlAccountsMatch,
  'Unfixed metal equals ledger': metalMatchesLedger,
  'Numbers are gapless': numbersAreGapless,
  'Journals trace to a source': journalsTraceToSource,
  'Closed periods are untouched': closedPeriodsUntouched,
  'Posted invoices are unchanged': postedDocumentsUnchanged,
  'Audit log matches its seals': verifyAuditSeals,
};

/** Reports problems and never repairs them: correcting the books is a person's decision. */
export async function runIntegrityChecks(companyId: Types.ObjectId, store?: ObjectStore) {
  const startedAt = new Date();
  const findings: Finding[] = [];
  for (const [check, run] of Object.entries(CHECKS)) {
    try {
      findings.push(...(await run(companyId, store)).map((detail) => ({ check, detail })));
    } catch (error) {
      findings.push({ check, detail: `The check could not run: ${(error as Error).message}` });
    }
  }
  const status = findings.length ? 'FAILED' : 'PASSED';
  const run = await IntegrityRunModel.create({
    companyId,
    status,
    checks: Object.keys(CHECKS),
    findings: findings.slice(0, 500),
    startedAt,
    finishedAt: new Date(),
  });
  if (findings.length) {
    await notify(companyId, {
      key: `integrity:${run._id.toString()}`,
      audience: 'audit:read',
      severity: 'CRITICAL',
      title: 'Integrity check failed',
      body: `${findings.length} problem(s) were found in the books and need investigating.`,
      link: '/integrity',
    });
  }
  return run.toObject();
}
