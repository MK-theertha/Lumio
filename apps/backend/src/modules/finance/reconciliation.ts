import { createHash } from 'node:crypto';
import type { Permission } from '@lumio/shared-types';
import {
  bankLineAdjustSchema,
  bankLineMatchSchema,
  bankLineNetSchema,
  bankStatementImportSchema,
  objectIdSchema,
  reconciliationCreateSchema,
} from '@lumio/validation';
import { Router } from 'express';
import mongoose, { Types, type Model } from 'mongoose';
import { z } from 'zod';
import {
  D128,
  OID,
  RD128,
  ROID,
  RS,
  tenantModel,
  tenantSchema,
} from '../../database/tenant-schema.js';
import { runInTransaction } from '../../database/transaction.js';
import { requirePermission } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { assertBranchAccess, type RequestContext } from '../../shared/context.js';
import { d128, dec, Decimal } from '../../shared/decimal.js';
import { BusinessRuleError, ConflictError, NotFoundError } from '../../shared/errors.js';
import { sendSuccess } from '../../shared/http.js';
import { plain } from '../../shared/serialize.js';
import { FinancialPeriodModel, JournalLineModel, postJournal } from '../ledger/index.js';
import { recordAudit } from '../platform/audit/index.js';
import { FinancialAccountModel, PaymentModel } from './finance.models.js';
import { parseStatementCsv, type DateOrder } from './statement-csv.js';

const lineSchema = tenantSchema(
  'bankStatementLines',
  {
    financialAccountId: ROID,
    date: { type: Date, required: true },
    description: { type: String, default: '' },
    reference: { type: String, default: '' },
    amount: RD128,
    balance: D128,
    fingerprint: RS,
    importedBy: RS,
    status: { type: String, enum: ['UNMATCHED', 'MATCHED', 'ADJUSTED', 'NETTED'], required: true },
    nettedWith: OID,
    adjustmentEntryId: OID,
    // Set when a completed reconciliation has relied on this line.
    reconciliationId: OID,
  },
  { timestamps: true },
);
lineSchema.index({ companyId: 1, financialAccountId: 1, fingerprint: 1 }, { unique: true });
lineSchema.index({ companyId: 1, financialAccountId: 1, status: 1, date: 1 });
export const BankStatementLineModel = tenantModel('BankStatementLine', lineSchema);

const matchSchema = tenantSchema('bankMatches', {
  paymentId: ROID,
  statementLineId: ROID,
  financialAccountId: ROID,
  direction: RS,
  amount: RD128,
  paymentDate: { type: Date, required: true },
  lineDate: { type: Date, required: true },
  matchedBy: RS,
});
// The guarantee that one payment can never clear against two statement lines.
matchSchema.index({ companyId: 1, paymentId: 1 }, { unique: true });
matchSchema.index({ companyId: 1, statementLineId: 1 });
matchSchema.index({ companyId: 1, financialAccountId: 1, lineDate: 1 });
export const BankMatchModel = tenantModel('BankMatch', matchSchema);

const reconciliationSchema = tenantSchema(
  'reconciliations',
  {
    financialAccountId: ROID,
    statementDate: { type: Date, required: true },
    closingBalance: RD128,
    openingBalance: RD128,
    status: { type: String, enum: ['OPEN', 'COMPLETED'], required: true },
    summary: { type: Object },
    createdBy: RS,
    completedBy: String,
    completedAt: Date,
  },
  { timestamps: true },
);
reconciliationSchema.index(
  { companyId: 1, financialAccountId: 1 },
  { unique: true, partialFilterExpression: { status: 'OPEN' } },
);
reconciliationSchema.index({ companyId: 1, financialAccountId: 1, statementDate: -1 });
export const ReconciliationModel = tenantModel('Reconciliation', reconciliationSchema);

const DATE_TOLERANCE_MS = 3 * 86_400_000;
const signed = (direction: string, amount: Decimal) =>
  direction === 'RECEIPT' ? amount : amount.negated();
const endOfDay = (date: Date) => new Date(date.getTime() + 86_399_999);

async function findAccount(ctx: RequestContext, id: string | Types.ObjectId) {
  const account = await FinancialAccountModel.findOne({ companyId: ctx.companyId, _id: id })
    .session(ctx.session ?? null)
    .lean();
  if (!account) throw new NotFoundError('The account was not found.');
  return account;
}

/** Re-importing an overlapping statement is safe: lines already held are recognised and skipped. */
export async function importStatement(
  ctx: RequestContext,
  input: { financialAccountId: string; csv: string; dateOrder: DateOrder },
) {
  const account = await findAccount(ctx, input.financialAccountId);
  const rows = parseStatementCsv(input.csv, input.dateOrder);
  if (rows.length === 0) throw new BusinessRuleError('The file contains no transactions.');

  // Two genuinely identical lines in one file are told apart by how many came before.
  const seen = new Map<string, number>();
  const documents = rows.map((row) => {
    const identity = [
      row.date.toISOString().slice(0, 10),
      row.amount.toFixed(2),
      row.reference,
      row.description,
    ].join('|');
    const occurrence = seen.get(identity) ?? 0;
    seen.set(identity, occurrence + 1);
    return {
      companyId: ctx.companyId,
      financialAccountId: account._id,
      date: row.date,
      description: row.description,
      reference: row.reference,
      amount: d128(row.amount),
      ...(row.balance ? { balance: d128(row.balance) } : {}),
      fingerprint: createHash('sha256').update(`${identity}|${occurrence}`).digest('hex'),
      importedBy: ctx.userId,
      status: 'UNMATCHED',
    };
  });

  let imported: number;
  try {
    const created = await BankStatementLineModel.insertMany(documents, { ordered: false });
    imported = created.length;
  } catch (error) {
    if (!(error instanceof mongoose.mongo.MongoBulkWriteError)) throw error;
    const failures = [error.writeErrors].flat();
    if (failures.some((failure) => failure.code !== 11000)) throw error;
    imported = documents.length - failures.length;
  }
  await recordAudit(ctx, {
    action: 'bank_statement.import',
    entityType: 'financial_account',
    entityId: String(account._id),
    after: { lines: documents.length, imported },
  });
  return { lines: documents.length, imported, duplicates: documents.length - imported };
}

/** Clears payments against a statement line. The amounts must agree exactly. */
export function matchLine(ctx: RequestContext, lineId: string, paymentIds: string[]) {
  return runInTransaction(ctx, async (tx) => {
    const line = await BankStatementLineModel.findOneAndUpdate(
      { companyId: tx.companyId, _id: lineId, status: 'UNMATCHED' },
      { $set: { status: 'MATCHED' } },
      { returnDocument: 'after', session: tx.session },
    ).lean();
    if (!line) throw new ConflictError('This statement line has already been dealt with.');
    const unique = [...new Set(paymentIds)];
    const payments = await PaymentModel.find({
      companyId: tx.companyId,
      _id: mongoose.trusted({ $in: unique }),
      financialAccountId: line.financialAccountId,
      status: 'POSTED',
    })
      .session(tx.session)
      .lean();
    if (payments.length !== unique.length) {
      throw new BusinessRuleError('A payment is reversed or belongs to another account.');
    }
    const total = payments.reduce(
      (sum, p) => sum.plus(signed(p.direction, dec(p.amount))),
      new Decimal(0),
    );
    if (!total.equals(dec(line.amount))) {
      throw new BusinessRuleError('The selected payments do not add up to the statement line.');
    }
    try {
      await BankMatchModel.insertMany(
        payments.map((p) => ({
          companyId: tx.companyId,
          paymentId: p._id,
          statementLineId: line._id,
          financialAccountId: line.financialAccountId,
          direction: p.direction,
          amount: p.amount,
          paymentDate: p.paymentDate,
          lineDate: line.date,
          matchedBy: tx.userId,
        })),
        { session: tx.session },
      );
    } catch (error) {
      if (error instanceof mongoose.mongo.MongoServerError && error.code === 11000) {
        throw new ConflictError('A selected payment has already been matched.');
      }
      throw error;
    }
    await recordAudit(tx, {
      action: 'bank_statement.match',
      entityType: 'bank_statement_line',
      entityId: lineId,
      after: { paymentIds: unique },
    });
    return { id: lineId, status: 'MATCHED' };
  });
}

export function unmatchLine(ctx: RequestContext, lineId: string) {
  return runInTransaction(ctx, async (tx) => {
    const line = await BankStatementLineModel.findOneAndUpdate(
      { companyId: tx.companyId, _id: lineId, status: 'MATCHED', reconciliationId: null },
      { $set: { status: 'UNMATCHED' } },
      { session: tx.session },
    ).lean();
    if (!line) {
      throw new ConflictError('Only a matched line outside a completed reconciliation can change.');
    }
    await BankMatchModel.deleteMany({
      companyId: tx.companyId,
      statementLineId: line._id,
    }).session(tx.session);
    await recordAudit(tx, {
      action: 'bank_statement.unmatch',
      entityType: 'bank_statement_line',
      entityId: lineId,
    });
    return { id: lineId, status: 'UNMATCHED' };
  });
}

/** Books an item only the bank knows about, such as a fee or interest. */
export function adjustLine(
  ctx: RequestContext,
  lineId: string,
  input: z.infer<typeof bankLineAdjustSchema>,
) {
  assertBranchAccess(ctx, input.branchId);
  return runInTransaction(ctx, async (tx) => {
    const line = await BankStatementLineModel.findOneAndUpdate(
      { companyId: tx.companyId, _id: lineId, status: 'UNMATCHED' },
      { $set: { status: 'ADJUSTED' } },
      { returnDocument: 'after', session: tx.session },
    ).lean();
    if (!line) throw new ConflictError('This statement line has already been dealt with.');
    const account = await findAccount(tx, line.financialAccountId);
    const amount = dec(line.amount);
    const value = amount.abs();
    const journal = await postJournal(tx, {
      postingDate: line.date,
      branchId: input.branchId,
      memo: input.memo,
      sourceType: 'BANK_ADJUSTMENT',
      sourceId: lineId,
      kind: 'POSTING',
      lines: [
        {
          accountId: account.ledgerAccountId,
          ...(amount.isPositive() ? { debit: value } : { credit: value }),
        },
        {
          accountId: input.ledgerAccountId,
          ...(amount.isPositive() ? { credit: value } : { debit: value }),
        },
      ],
    });
    await BankStatementLineModel.updateOne(
      { companyId: tx.companyId, _id: line._id },
      { $set: { adjustmentEntryId: journal.entryId } },
    ).session(tx.session);
    await recordAudit(tx, {
      action: 'bank_statement.adjust',
      entityType: 'bank_statement_line',
      entityId: lineId,
      after: { journal: journal.number, ledgerAccountId: input.ledgerAccountId },
    });
    return { id: lineId, status: 'ADJUSTED', journalNumber: journal.number };
  });
}

/** Two lines that cancel out, such as a cheque paid in and then returned unpaid. */
export function netLines(ctx: RequestContext, lineId: string, otherLineId: string) {
  return runInTransaction(ctx, async (tx) => {
    if (lineId === otherLineId) throw new BusinessRuleError('Choose two different lines.');
    const claim = (id: string, partner: string) =>
      BankStatementLineModel.findOneAndUpdate(
        { companyId: tx.companyId, _id: id, status: 'UNMATCHED' },
        { $set: { status: 'NETTED', nettedWith: partner } },
        { returnDocument: 'after', session: tx.session },
      ).lean();
    const first = await claim(lineId, otherLineId);
    const second = await claim(otherLineId, lineId);
    if (!first || !second) throw new ConflictError('Both lines must still be unmatched.');
    if (!first.financialAccountId.equals(second.financialAccountId)) {
      throw new BusinessRuleError('The lines belong to different accounts.');
    }
    if (!dec(first.amount).plus(dec(second.amount)).isZero()) {
      throw new BusinessRuleError('The two lines do not cancel out.');
    }
    await recordAudit(tx, {
      action: 'bank_statement.net',
      entityType: 'bank_statement_line',
      entityId: lineId,
      after: { otherLineId },
    });
    return { id: lineId, status: 'NETTED' };
  });
}

/** A period should not close with bank activity nobody has explained. */
export async function assertBankLinesExplained(ctx: RequestContext, periodId: string) {
  const period = await FinancialPeriodModel.findOne({
    companyId: ctx.companyId,
    _id: periodId,
  }).lean();
  if (!period) throw new NotFoundError();
  const open = await BankStatementLineModel.countDocuments({
    companyId: ctx.companyId,
    status: 'UNMATCHED',
    date: mongoose.trusted({ $lte: period.to }),
  });
  if (open > 0) {
    throw new BusinessRuleError(
      `${open} bank statement line(s) in or before ${period.name} still need matching or booking.`,
    );
  }
}

/** Every receipt and payment on an account, with a running balance. */
export async function cashBook(
  ctx: RequestContext,
  accountId: string,
  from: Date | undefined,
  to: Date | undefined,
) {
  const account = await findAccount(ctx, accountId);
  const before = from ? { $lt: from } : null;
  const range = {
    ...(from ? { $gte: from } : {}),
    ...(to ? { $lte: endOfDay(to) } : {}),
  };
  const hasRange = Object.keys(range).length > 0;
  const scope = { companyId: ctx.companyId, financialAccountId: account._id };
  const posted = { ...scope, status: 'POSTED' as const };
  const adjusted = { ...scope, status: 'ADJUSTED' as const };

  let opening = new Decimal(0);
  if (before) {
    const earlier = await sumBy(PaymentModel, { ...posted, paymentDate: before }, ctx);
    const fees = await BankStatementLineModel.find({
      ...adjusted,
      date: mongoose.trusted(before),
    })
      .select({ amount: 1 })
      .lean();
    opening = earlier.receipts
      .minus(earlier.payments)
      .plus(fees.reduce((sum, row) => sum.plus(dec(row.amount)), new Decimal(0)));
  }
  const payments = await PaymentModel.find({
    ...posted,
    ...(hasRange ? { paymentDate: mongoose.trusted(range) } : {}),
  })
    .select({ number: 1, direction: 1, amount: 1, paymentDate: 1, reference: 1 })
    .limit(5000)
    .lean();
  const adjustments = await BankStatementLineModel.find({
    ...adjusted,
    ...(hasRange ? { date: mongoose.trusted(range) } : {}),
  })
    .select({ amount: 1, date: 1, description: 1 })
    .limit(5000)
    .lean();

  const movements = [
    ...payments.map((p) => ({
      id: String(p._id),
      date: p.paymentDate as Date,
      number: p.number as string,
      description: (p.reference ?? '') as string,
      amount: signed(p.direction, dec(p.amount)),
    })),
    ...adjustments.map((a) => ({
      id: String(a._id),
      date: a.date as Date,
      number: 'BANK',
      description: a.description as string,
      amount: dec(a.amount),
    })),
  ].sort((a, b) => a.date.getTime() - b.date.getTime() || a.id.localeCompare(b.id));

  let balance = opening;
  const rows = movements.map((m) => {
    balance = balance.plus(m.amount);
    return {
      id: m.id,
      date: m.date.toISOString(),
      number: m.number,
      description: m.description,
      receipt: m.amount.isPositive() ? m.amount.toFixed(2) : '',
      payment: m.amount.isNegative() ? m.amount.abs().toFixed(2) : '',
      balance: balance.toFixed(2),
    };
  });
  return { opening: opening.toFixed(2), closing: balance.toFixed(2), rows };
}

interface OpenPayment {
  _id: Types.ObjectId;
  number: string;
  direction: string;
  amount: Types.Decimal128;
  paymentDate: Date;
  reference?: string;
  partyId: Types.ObjectId;
}

/** Payments on this account that have not yet appeared on a statement. */
async function unmatchedPayments(ctx: RequestContext, accountId: string): Promise<OpenPayment[]> {
  const matched = (await BankMatchModel.find({
    companyId: ctx.companyId,
    financialAccountId: accountId,
  })
    .select({ paymentId: 1 })
    .lean()) as { paymentId: Types.ObjectId }[];
  return (await PaymentModel.find({
    companyId: ctx.companyId,
    financialAccountId: accountId,
    status: 'POSTED',
    _id: mongoose.trusted({ $nin: matched.map((m) => m.paymentId) }),
  })
    .select({ number: 1, direction: 1, amount: 1, paymentDate: 1, reference: 1, partyId: 1 })
    .sort({ paymentDate: 1 })
    .limit(2000)
    .lean()) as unknown as OpenPayment[];
}

/** Matches only what is unambiguous. Anything with two plausible candidates is left to a person. */
export async function autoMatch(ctx: RequestContext, accountId: string) {
  await findAccount(ctx, accountId);
  const lines = await BankStatementLineModel.find({
    companyId: ctx.companyId,
    financialAccountId: accountId,
    status: 'UNMATCHED',
  })
    .sort({ date: 1 })
    .limit(2000)
    .lean();
  const open = await unmatchedPayments(ctx, accountId);
  const used = new Set<string>();
  let matched = 0;
  for (const line of lines) {
    const amount = dec(line.amount);
    const candidates = open.filter(
      (p) =>
        !used.has(p._id.toString()) &&
        signed(p.direction, dec(p.amount)).equals(amount) &&
        Math.abs(p.paymentDate.getTime() - line.date.getTime()) <= DATE_TOLERANCE_MS,
    );
    const text = `${line.reference} ${line.description}`.toUpperCase();
    const byReference = candidates.filter(
      (p) =>
        text.includes(p.number.toUpperCase()) ||
        (p.reference && text.includes(p.reference.toUpperCase())),
    );
    const chosen =
      byReference.length === 1
        ? byReference[0]
        : candidates.length === 1 && byReference.length === 0
          ? candidates[0]
          : undefined;
    if (!chosen) continue;
    used.add(chosen._id.toString());
    await matchLine(ctx, line._id.toString(), [chosen._id.toString()]);
    matched += 1;
  }
  return { matched, remaining: lines.length - matched };
}

interface ReconciliationRow {
  _id: Types.ObjectId;
  financialAccountId: Types.ObjectId;
  statementDate: Date;
  closingBalance: Types.Decimal128;
  openingBalance: Types.Decimal128;
  status: string;
}

async function sumBy<T>(
  model: Model<T>,
  match: Record<string, unknown>,
  ctx: RequestContext,
): Promise<{ receipts: Decimal; payments: Decimal }> {
  const groups = await model
    .aggregate([
      { $match: { companyId: ctx.companyId, ...match } },
      { $group: { _id: '$direction', total: { $sum: '$amount' } } },
    ])
    .session(ctx.session ?? null);
  const total = (direction: string) =>
    dec(groups.find((g: { _id: string }) => g._id === direction)?.total);
  return { receipts: total('RECEIPT'), payments: total('PAYMENT') };
}

/**
 * The bank reconciliation statement:
 * statement closing + deposits in transit - outstanding payments must equal the cash book.
 * The cash book is the opening balance plus every posted payment and booked adjustment to date.
 */
export async function reconciliationSummary(ctx: RequestContext, row: ReconciliationRow) {
  const to = endOfDay(row.statementDate);
  const accountId = new Types.ObjectId(row.financialAccountId.toString());
  const upTo = { $lte: to };
  const book = await sumBy(
    PaymentModel,
    { financialAccountId: accountId, status: 'POSTED', paymentDate: upTo },
    ctx,
  );
  // A payment counts as cleared only if the line clearing it falls within this statement.
  const cleared = await sumBy(
    BankMatchModel,
    { financialAccountId: accountId, lineDate: upTo, paymentDate: upTo },
    ctx,
  );
  const adjustmentGroups = await BankStatementLineModel.aggregate([
    {
      $match: {
        companyId: ctx.companyId,
        financialAccountId: accountId,
        status: 'ADJUSTED',
        date: upTo,
      },
    },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]).session(ctx.session ?? null);
  const adjustments = dec(adjustmentGroups[0]?.total);
  const unmatchedLines = await BankStatementLineModel.countDocuments({
    companyId: ctx.companyId,
    financialAccountId: accountId,
    status: 'UNMATCHED',
    date: mongoose.trusted(upTo),
  }).session(ctx.session ?? null);

  const account = await findAccount(ctx, accountId);
  const ledger = await JournalLineModel.aggregate([
    {
      $match: {
        companyId: ctx.companyId,
        accountId: account.ledgerAccountId,
        postingDate: upTo,
      },
    },
    { $group: { _id: null, debit: { $sum: '$debit' }, credit: { $sum: '$credit' } } },
  ]).session(ctx.session ?? null);

  const opening = dec(row.openingBalance);
  const closing = dec(row.closingBalance);
  const depositsInTransit = book.receipts.minus(cleared.receipts);
  const outstandingPayments = book.payments.minus(cleared.payments);
  const adjustedBank = closing.plus(depositsInTransit).minus(outstandingPayments);
  const cashBook = opening.plus(book.receipts).minus(book.payments).plus(adjustments);
  return {
    closingBalance: closing.toFixed(2),
    depositsInTransit: depositsInTransit.toFixed(2),
    outstandingPayments: outstandingPayments.toFixed(2),
    adjustedBankBalance: adjustedBank.toFixed(2),
    cashBookBalance: cashBook.toFixed(2),
    difference: adjustedBank.minus(cashBook).toFixed(2),
    unmatchedLines,
    // For information: differs from the cash book if the ledger account is shared or journalled.
    ledgerMovement: dec(ledger[0]?.debit).minus(dec(ledger[0]?.credit)).toFixed(2),
  };
}

export async function createReconciliation(
  ctx: RequestContext,
  input: z.infer<typeof reconciliationCreateSchema>,
) {
  const account = await findAccount(ctx, input.financialAccountId);
  const previous = await ReconciliationModel.findOne({
    companyId: ctx.companyId,
    financialAccountId: account._id,
    status: 'COMPLETED',
  })
    .sort({ statementDate: -1 })
    .lean();
  const statementDate = new Date(input.statementDate);
  if (previous && statementDate <= previous.statementDate) {
    throw new BusinessRuleError('The statement date must be after the last reconciliation.');
  }
  if (!previous && input.openingBalance === undefined) {
    throw new BusinessRuleError(
      'Enter the balance of this account before its first recorded payment.',
    );
  }
  try {
    const created = await ReconciliationModel.create({
      companyId: ctx.companyId,
      financialAccountId: account._id,
      statementDate,
      closingBalance: d128(input.closingBalance),
      // The cash book is built from all payments, so the starting point stays the same throughout.
      openingBalance: previous ? previous.openingBalance : d128(input.openingBalance),
      status: 'OPEN',
      createdBy: ctx.userId,
    });
    return created.toObject();
  } catch (error) {
    if (error instanceof mongoose.mongo.MongoServerError && error.code === 11000) {
      throw new ConflictError('This account already has a reconciliation in progress.');
    }
    throw error;
  }
}

/** Refuses anything that does not balance, then fixes the lines it relied on. */
export function completeReconciliation(ctx: RequestContext, id: string) {
  return runInTransaction(ctx, async (tx) => {
    const row = (await ReconciliationModel.findOne({
      companyId: tx.companyId,
      _id: id,
      status: 'OPEN',
    })
      .session(tx.session)
      .lean()) as ReconciliationRow | null;
    if (!row) throw new ConflictError('This reconciliation is not in progress.');
    const summary = await reconciliationSummary(tx, row);
    if (summary.unmatchedLines > 0) {
      throw new BusinessRuleError(
        `${summary.unmatchedLines} statement line(s) still need matching or booking.`,
      );
    }
    if (!dec(summary.difference).isZero()) {
      throw new BusinessRuleError(`The reconciliation is out by ${summary.difference}.`);
    }
    await BankStatementLineModel.updateMany(
      {
        companyId: tx.companyId,
        financialAccountId: row.financialAccountId,
        date: mongoose.trusted({ $lte: endOfDay(row.statementDate) }),
        reconciliationId: null,
      },
      { $set: { reconciliationId: row._id } },
    ).session(tx.session);
    const updated = await ReconciliationModel.findOneAndUpdate(
      { companyId: tx.companyId, _id: id, status: 'OPEN' },
      {
        $set: {
          status: 'COMPLETED',
          summary,
          completedBy: tx.userId,
          completedAt: new Date(),
        },
      },
      { returnDocument: 'after', session: tx.session },
    ).lean();
    await recordAudit(tx, {
      action: 'bank_reconciliation.complete',
      entityType: 'reconciliation',
      entityId: id,
      after: summary,
    });
    return updated;
  });
}

const idParams = validate({ params: z.object({ id: objectIdSchema }) });
const allow = (action: string) => requirePermission(`bank_reconciliation:${action}` as Permission);

export function createBankReconciliationRouter(): Router {
  const router = Router();

  router.post(
    '/bank-statements/import',
    allow('manage'),
    validate({ body: bankStatementImportSchema }),
    async (req, res) => {
      const body = req.validated.body as z.infer<typeof bankStatementImportSchema>;
      sendSuccess(req, res, await importStatement(req.ctx, body), 201);
    },
  );

  router.get('/bank-statement-lines', allow('read'), async (req, res) => {
    const account = objectIdSchema.parse(req.query.financialAccountId);
    const filter: Record<string, unknown> = {
      companyId: req.ctx.companyId,
      financialAccountId: account,
    };
    if (typeof req.query.status === 'string' && req.query.status) filter.status = req.query.status;
    const rows = await BankStatementLineModel.find(filter)
      .sort({ date: -1, _id: -1 })
      .limit(500)
      .lean();
    sendSuccess(req, res, plain(rows));
  });

  router.get('/bank-unmatched-payments', allow('read'), async (req, res) => {
    const account = objectIdSchema.parse(req.query.financialAccountId);
    sendSuccess(req, res, plain(await unmatchedPayments(req.ctx, account)));
  });

  router.post(
    '/bank-statement-lines/:id/match',
    allow('manage'),
    validate({ params: z.object({ id: objectIdSchema }), body: bankLineMatchSchema }),
    async (req, res) => {
      const { paymentIds } = req.validated.body as z.infer<typeof bankLineMatchSchema>;
      sendSuccess(req, res, await matchLine(req.ctx, String(req.params.id), paymentIds));
    },
  );

  router.post('/bank-statement-lines/:id/unmatch', allow('manage'), idParams, async (req, res) => {
    sendSuccess(req, res, await unmatchLine(req.ctx, String(req.params.id)));
  });

  router.post(
    '/bank-statement-lines/:id/adjust',
    allow('manage'),
    validate({ params: z.object({ id: objectIdSchema }), body: bankLineAdjustSchema }),
    async (req, res) => {
      const body = req.validated.body as z.infer<typeof bankLineAdjustSchema>;
      sendSuccess(req, res, await adjustLine(req.ctx, String(req.params.id), body));
    },
  );

  router.post(
    '/bank-statement-lines/:id/net',
    allow('manage'),
    validate({ params: z.object({ id: objectIdSchema }), body: bankLineNetSchema }),
    async (req, res) => {
      const { otherLineId } = req.validated.body as z.infer<typeof bankLineNetSchema>;
      sendSuccess(req, res, await netLines(req.ctx, String(req.params.id), otherLineId));
    },
  );

  router.get('/cash-book', requirePermission('payment:read'), async (req, res) => {
    const query = z
      .object({
        financialAccountId: objectIdSchema,
        from: z.iso.date().optional(),
        to: z.iso.date().optional(),
      })
      .parse(req.query);
    sendSuccess(
      req,
      res,
      await cashBook(
        req.ctx,
        query.financialAccountId,
        query.from ? new Date(query.from) : undefined,
        query.to ? new Date(query.to) : undefined,
      ),
    );
  });

  router.post(
    '/bank-reconciliations/auto-match',
    allow('manage'),
    validate({ body: z.strictObject({ financialAccountId: objectIdSchema }) }),
    async (req, res) => {
      const { financialAccountId } = req.validated.body as { financialAccountId: string };
      sendSuccess(req, res, await autoMatch(req.ctx, financialAccountId));
    },
  );

  router.get('/bank-reconciliations', allow('read'), async (req, res) => {
    const filter: Record<string, unknown> = { companyId: req.ctx.companyId };
    if (typeof req.query.financialAccountId === 'string' && req.query.financialAccountId) {
      filter.financialAccountId = objectIdSchema.parse(req.query.financialAccountId);
    }
    const rows = (await ReconciliationModel.find(filter)
      .sort({ statementDate: -1 })
      .limit(100)
      .lean()) as unknown as (ReconciliationRow & { summary?: unknown })[];
    const withSummary = [];
    for (const row of rows) {
      const summary =
        row.status === 'OPEN' ? await reconciliationSummary(req.ctx, row) : row.summary;
      withSummary.push({ ...plain<object>(row), summary });
    }
    sendSuccess(req, res, withSummary);
  });

  router.post(
    '/bank-reconciliations',
    allow('manage'),
    validate({ body: reconciliationCreateSchema }),
    async (req, res) => {
      const body = req.validated.body as z.infer<typeof reconciliationCreateSchema>;
      sendSuccess(req, res, plain(await createReconciliation(req.ctx, body)), 201);
    },
  );

  router.post(
    '/bank-reconciliations/:id/complete',
    allow('complete'),
    idParams,
    async (req, res) => {
      sendSuccess(req, res, plain(await completeReconciliation(req.ctx, String(req.params.id))));
    },
  );

  return router;
}
