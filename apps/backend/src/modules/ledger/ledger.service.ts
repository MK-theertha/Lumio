import mongoose, { Types } from 'mongoose';
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
  type LedgerRole,
} from './ledger.models.js';

export interface PostingLine {
  role?: LedgerRole;
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

async function accountByRole(ctx: RequestContext, role: LedgerRole): Promise<Types.ObjectId> {
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
  }[] = [];
  for (const line of request.lines) {
    const debit = dec(line.debit);
    const credit = dec(line.credit);
    if (debit.isZero() && credit.isZero()) continue;
    if (debit.isNegative() || credit.isNegative()) {
      throw new BusinessRuleError('Journal amounts must not be negative.');
    }
    const accountId = line.role
      ? await accountByRole(ctx, line.role)
      : new Types.ObjectId(String(line.accountId));
    resolved.push({
      accountId,
      debit,
      credit,
      ...(line.partyId ? { partyId: line.partyId } : {}),
      branchId: line.branchId ?? request.branchId,
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
      companyId: ctx.companyId,
      entryId,
      accountId: line.accountId,
      branchId: line.branchId,
      partyId: line.partyId,
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
    { companyId: ctx.companyId, _id: id, status: expected },
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
