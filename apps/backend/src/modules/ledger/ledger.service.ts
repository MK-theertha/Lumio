import mongoose, { Types } from 'mongoose';
import { runInTransaction } from '../../database/transaction.js';
import { assertTransactional, type RequestContext } from '../../shared/context.js';
import { d128, dec, Decimal } from '../../shared/decimal.js';
import { BusinessRuleError, ConflictError, NotFoundError } from '../../shared/errors.js';
import { recordAudit } from '../platform/audit/index.js';
import { allocateNumber } from '../platform/numbering/index.js';
import {
  FinancialPeriodModel,
  JournalEntryModel,
  JournalLineModel,
  LedgerAccountModel,
  PostingProfileModel,
  type LedgerRole,
} from './ledger.models.js';

export interface PostingLine {
  role?: LedgerRole;
  closing?: boolean;
  currency?: string;
  foreignAmount?: Decimal | string;
  exchangeRate?: Decimal | string;
  accountId?: Types.ObjectId | string;
  debit?: Decimal | string;
  credit?: Decimal | string;
  partyId?: Types.ObjectId | string;
  branchId?: Types.ObjectId | string;
}

export interface PostingRequest {
  postingDate: Date;
  branchId: Types.ObjectId | string;
  memo: string;
  sourceType: string;
  sourceId: string;
  kind: string;
  lines: PostingLine[];
  reversesEntryId?: Types.ObjectId;
}

export function assertOpenPeriod(ctx: RequestContext, date: Date) {
  return FinancialPeriodModel.findOne({
    companyId: ctx.companyId,
    from: mongoose.trusted({ $lte: date }),
    to: mongoose.trusted({ $gte: date }),
  })
    .session(ctx.session ?? null)
    .lean()
    .then((period) => {
      if (!period) throw new BusinessRuleError('No financial period covers this date.');
      if (period.status !== 'OPEN') {
        throw new BusinessRuleError(`The period ${period.name} is closed to new postings.`);
      }
      return period;
    });
}

async function accountByRole(
  ctx: RequestContext,
  role: LedgerRole,
  branchId: Types.ObjectId | string,
): Promise<Types.ObjectId> {
  // A branch can post a role to its own account, such as a branch sales account.
  const profile = await PostingProfileModel.findOne({
    companyId: ctx.companyId,
    role,
    branchId,
    archivedAt: null,
  })
    .session(ctx.session ?? null)
    .lean();
  if (profile) return profile.accountId;
  const account = await LedgerAccountModel.findOne({ companyId: ctx.companyId, systemRole: role })
    .session(ctx.session ?? null)
    .lean();
  if (!account) throw new BusinessRuleError(`The chart of accounts has no account for ${role}.`);
  return account._id;
}

/** The only way a journal enters the books. Entry and lines commit with the business change. */
export async function postJournal(ctx: RequestContext, request: PostingRequest) {
  assertTransactional(ctx, 'postJournal');
  const period = await assertOpenPeriod(ctx, request.postingDate);

  const resolved: {
    accountId: Types.ObjectId;
    debit: Decimal;
    credit: Decimal;
    partyId?: Types.ObjectId | string;
    branchId: Types.ObjectId | string;
    closing?: boolean;
    currency?: string;
    foreignAmount?: Types.Decimal128;
    exchangeRate?: Types.Decimal128;
  }[] = [];
  for (const line of request.lines) {
    const debit = dec(line.debit);
    const credit = dec(line.credit);
    if (debit.isZero() && credit.isZero()) continue;
    if (debit.isNegative() || credit.isNegative()) {
      throw new BusinessRuleError('Journal amounts must not be negative.');
    }
    const accountId = line.role
      ? await accountByRole(ctx, line.role, line.branchId ?? request.branchId)
      : new Types.ObjectId(String(line.accountId));
    resolved.push({
      accountId,
      debit,
      credit,
      ...(line.partyId ? { partyId: line.partyId } : {}),
      branchId: line.branchId ?? request.branchId,
      ...(line.closing ? { closing: true } : {}),
      ...(line.currency && line.foreignAmount && line.exchangeRate
        ? {
            currency: line.currency,
            foreignAmount: d128(line.foreignAmount),
            exchangeRate: d128(line.exchangeRate),
          }
        : {}),
    });
  }

  const totalDebit = resolved.reduce((sum, l) => sum.plus(l.debit), new Decimal(0));
  const totalCredit = resolved.reduce((sum, l) => sum.plus(l.credit), new Decimal(0));
  if (resolved.length < 2 || totalDebit.isZero()) {
    throw new BusinessRuleError('A journal needs at least two non-zero lines.');
  }
  if (!totalDebit.equals(totalCredit)) {
    throw new BusinessRuleError(
      `The journal does not balance: debit ${totalDebit.toFixed()}, credit ${totalCredit.toFixed()}.`,
    );
  }

  const number = await allocateNumber(ctx, {
    documentType: 'JV',
    scope: 'COMPANY',
    prefix: 'JV-',
    padding: 8,
  });
  const entryId = new Types.ObjectId();
  const now = new Date();
  await JournalEntryModel.create(
    [
      {
        _id: entryId,
        companyId: ctx.companyId,
        number,
        postingDate: request.postingDate,
        periodId: period._id,
        branchId: request.branchId,
        memo: request.memo,
        sourceType: request.sourceType,
        sourceId: request.sourceId,
        kind: request.kind,
        totalDebit: d128(totalDebit),
        totalCredit: d128(totalCredit),
        ...(request.reversesEntryId ? { reversesEntryId: request.reversesEntryId } : {}),
        postedBy: ctx.userId,
        postedAt: now,
      },
    ],
    { session: ctx.session },
  );
  await JournalLineModel.insertMany(
    resolved.map((line) => ({
      ...line,
      companyId: ctx.companyId,
      entryId,
      postingDate: request.postingDate,
      debit: d128(line.debit),
      credit: d128(line.credit),
    })),
    { session: ctx.session },
  );
  return { entryId, number };
}

/** Corrects a posted entry by mirroring it. A unique index permits only one reversal per entry. */
export async function reverseJournal(
  ctx: RequestContext,
  entryId: Types.ObjectId | string,
  reason: string,
  postingDate: Date,
) {
  assertTransactional(ctx, 'reverseJournal');
  const entry = await JournalEntryModel.findOne({ companyId: ctx.companyId, _id: entryId })
    .session(ctx.session)
    .lean();
  if (!entry) throw new NotFoundError();
  if (entry.reversesEntryId) throw new BusinessRuleError('A reversal cannot itself be reversed.');
  const already = await JournalEntryModel.findOne({
    companyId: ctx.companyId,
    reversesEntryId: entry._id,
  })
    .session(ctx.session)
    .lean();
  if (already) throw new ConflictError('This entry has already been reversed.');

  const lines = await JournalLineModel.find({ companyId: ctx.companyId, entryId: entry._id })
    .session(ctx.session)
    .lean();
  const result = await postJournal(ctx, {
    postingDate,
    branchId: entry.branchId,
    memo: `Reversal of ${entry.number}: ${reason}`,
    sourceType: 'JOURNAL_REVERSAL',
    sourceId: entry._id.toString(),
    kind: 'REVERSAL',
    reversesEntryId: entry._id,
    lines: lines.map((line) => ({
      accountId: line.accountId,
      debit: dec(line.credit),
      credit: dec(line.debit),
      branchId: line.branchId,
      ...(line.partyId ? { partyId: line.partyId } : {}),
    })),
  });
  await recordAudit(ctx, {
    action: 'journal.reverse',
    entityType: 'journal',
    entityId: entry._id.toString(),
    after: { reason, reversalNumber: result.number },
  });
  return result;
}

const CLOSE_DRAIN_MS = 2 * 60 * 1000;

function changePeriod(
  ctx: RequestContext,
  id: string,
  expected: string,
  status: string,
  action: string,
  extra: Record<string, unknown> = {},
  note: Record<string, unknown> = {},
) {
  return FinancialPeriodModel.findOneAndUpdate(
    { companyId: ctx.companyId, _id: id, status: expected as 'OPEN' | 'CLOSING' | 'CLOSED' },
    {
      $set: { status, ...extra },
      $push: { history: { action, by: ctx.userId, at: new Date(), ...extra, ...note } },
    },
    { returnDocument: 'after' },
  ).lean();
}

/** Stops new postings. Completion waits longer than a transaction can live, so none are in flight. */
export async function beginPeriodClose(ctx: RequestContext, id: string) {
  const period = await changePeriod(ctx, id, 'OPEN', 'CLOSING', 'CLOSE_STARTED', {
    closingStartedAt: new Date(),
  });
  if (!period) throw new ConflictError('Only an open period can be closed.');
  await recordAudit(ctx, { action: 'period.close_started', entityType: 'period', entityId: id });
  return period;
}

export async function completePeriodClose(
  ctx: RequestContext,
  id: string,
  drainMs = CLOSE_DRAIN_MS,
) {
  const current = await FinancialPeriodModel.findOne({ companyId: ctx.companyId, _id: id }).lean();
  if (!current) throw new NotFoundError();
  const started = current.closingStartedAt?.getTime() ?? 0;
  if (current.status !== 'CLOSING' || Date.now() - started < drainMs) {
    throw new ConflictError('The period is still draining in-flight postings. Try again shortly.');
  }
  const period = await changePeriod(ctx, id, 'CLOSING', 'CLOSED', 'CLOSED');
  if (!period) throw new ConflictError('The period is no longer closing.');
  await recordAudit(ctx, { action: 'period.closed', entityType: 'period', entityId: id });
  return period;
}

export async function reopenPeriod(ctx: RequestContext, id: string, reason: string) {
  const period =
    (await changePeriod(ctx, id, 'CLOSED', 'OPEN', 'REOPENED', {}, { reason })) ??
    (await changePeriod(ctx, id, 'CLOSING', 'OPEN', 'REOPENED', {}, { reason }));
  if (!period) throw new ConflictError('Only a closed period can be reopened.');
  await recordAudit(ctx, {
    action: 'period.reopened',
    entityType: 'period',
    entityId: id,
    after: { reason },
  });
  return period;
}

export async function createYearPeriods(ctx: RequestContext, year: number) {
  const months = Array.from({ length: 12 }, (_, month) => ({
    companyId: ctx.companyId,
    name: `${year}-${String(month + 1).padStart(2, '0')}`,
    from: new Date(Date.UTC(year, month, 1)),
    to: new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999)),
    status: 'OPEN',
  }));
  try {
    await FinancialPeriodModel.insertMany(months, { session: ctx.session ?? null });
  } catch (error) {
    if (error instanceof mongoose.mongo.MongoServerError && error.code === 11000) {
      throw new ConflictError(`Periods for ${year} already exist.`);
    }
    throw error;
  }
}

/**
 * Moves the year's income and expense to retained earnings. Posted on the last day of the year,
 * so that month must still be open and every earlier one closed, or the result could change.
 */
export function closeFinancialYear(ctx: RequestContext, year: number) {
  return runInTransaction(ctx, async (tx) => {
    const from = new Date(Date.UTC(year, 0, 1));
    const to = new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999));
    const periods = await FinancialPeriodModel.find({
      companyId: tx.companyId,
      from: mongoose.trusted({ $gte: from, $lte: to }),
    })
      .sort({ from: 1 })
      .session(tx.session)
      .lean();
    const last = periods.at(-1);
    if (!last) throw new NotFoundError(`No periods exist for ${year}.`);
    if (last.status !== 'OPEN' || periods.slice(0, -1).some((p) => p.status !== 'CLOSED')) {
      throw new BusinessRuleError('Close every earlier month, and keep the last month open.');
    }
    const accounts = await LedgerAccountModel.find({
      companyId: tx.companyId,
      type: mongoose.trusted({ $in: ['INCOME', 'EXPENSE'] }),
    })
      .select({ _id: 1 })
      .session(tx.session)
      .lean();
    const totals = await JournalLineModel.aggregate<{
      _id: { accountId: Types.ObjectId; branchId: Types.ObjectId };
      debit: Types.Decimal128;
      credit: Types.Decimal128;
    }>([
      {
        $match: {
          companyId: tx.companyId,
          accountId: { $in: accounts.map((a) => a._id) },
          postingDate: { $gte: from, $lte: to },
          closing: { $ne: true },
        },
      },
      {
        $group: {
          _id: { accountId: '$accountId', branchId: '$branchId' },
          debit: { $sum: '$debit' },
          credit: { $sum: '$credit' },
        },
      },
    ]).session(tx.session);

    const lines: PostingLine[] = [];
    const profitByBranch = new Map<string, Decimal>();
    for (const { _id, debit, credit } of totals) {
      const balance = dec(debit).minus(dec(credit));
      if (balance.isZero()) continue;
      const branch = _id.branchId.toString();
      lines.push({
        accountId: _id.accountId,
        branchId: _id.branchId,
        closing: true,
        ...(balance.isPositive() ? { credit: balance } : { debit: balance.abs() }),
      });
      profitByBranch.set(branch, (profitByBranch.get(branch) ?? new Decimal(0)).minus(balance));
    }
    if (lines.length === 0) throw new BusinessRuleError('There is nothing to close for this year.');
    for (const [branchId, profit] of profitByBranch) {
      if (profit.isZero()) continue;
      lines.push({
        role: 'RETAINED_EARNINGS',
        branchId,
        closing: true,
        ...(profit.isPositive() ? { credit: profit } : { debit: profit.abs() }),
      });
    }
    let posted;
    try {
      posted = await postJournal(tx, {
        postingDate: last.to,
        branchId: [...profitByBranch.keys()][0] as string,
        memo: `Year-end closing ${year}`,
        sourceType: 'YEAR_END',
        sourceId: String(year),
        kind: 'YEAR_END',
        lines,
      });
    } catch (error) {
      if (error instanceof mongoose.mongo.MongoServerError && error.code === 11000) {
        throw new ConflictError(`${year} has already been closed.`);
      }
      throw error;
    }
    await recordAudit(tx, {
      action: 'period.year_end',
      entityType: 'period',
      entityId: String(year),
      after: { journal: posted.number },
    });
    return { number: posted.number };
  });
}
