import mongoose, { Types } from 'mongoose';
import type { RequestContext } from '../../shared/context.js';
import { dec, Decimal } from '../../shared/decimal.js';
import { JournalEntryModel, JournalLineModel, LedgerAccountModel } from '../ledger/index.js';

export interface Range {
  from?: Date | undefined;
  to?: Date | undefined;
  branchId?: string | undefined;
}

export const dateFilter = (field: string, range: Range) => {
  const condition: Record<string, Date> = {};
  if (range.from) condition.$gte = range.from;
  if (range.to) condition.$lte = range.to;
  return Object.keys(condition).length ? { [field]: mongoose.trusted(condition) } : {};
};

async function accountTotals(ctx: RequestContext, range: Range) {
  const match: Record<string, unknown> = {
    companyId: ctx.companyId,
    ...dateFilter('postingDate', range),
  };
  if (range.branchId) match.branchId = new Types.ObjectId(range.branchId);
  const [accounts, totals] = await Promise.all([
    LedgerAccountModel.find({ companyId: ctx.companyId }).sort({ code: 1 }).lean(),
    JournalLineModel.aggregate<{
      _id: Types.ObjectId;
      debit: Types.Decimal128;
      credit: Types.Decimal128;
    }>([
      { $match: match },
      { $group: { _id: '$accountId', debit: { $sum: '$debit' }, credit: { $sum: '$credit' } } },
    ]),
  ]);
  const byId = new Map(totals.map((t) => [t._id.toString(), t]));
  return accounts.map((account) => {
    const row = byId.get(account._id.toString());
    return { account, debit: dec(row?.debit), credit: dec(row?.credit) };
  });
}

const sum = (values: Decimal[]) => values.reduce((a, b) => a.plus(b), new Decimal(0));
const f = (value: Decimal) => value.toFixed(2);

export async function trialBalance(ctx: RequestContext, range: Range) {
  const rows = (await accountTotals(ctx, range)).filter(
    (r) => !r.debit.isZero() || !r.credit.isZero(),
  );
  return {
    rows: rows.map(({ account, debit, credit }) => ({
      code: account.code,
      name: account.name,
      type: account.type,
      debit: f(debit),
      credit: f(credit),
    })),
    totalDebit: f(sum(rows.map((r) => r.debit))),
    totalCredit: f(sum(rows.map((r) => r.credit))),
  };
}

export async function profitAndLoss(ctx: RequestContext, range: Range) {
  const rows = await accountTotals(ctx, range);
  const pick = (type: string, natural: 'credit' | 'debit') =>
    rows
      .filter((r) => r.account.type === type)
      .map((r) => ({
        code: r.account.code,
        name: r.account.name,
        amount: natural === 'credit' ? r.credit.minus(r.debit) : r.debit.minus(r.credit),
      }))
      .filter((r) => !r.amount.isZero());
  const income = pick('INCOME', 'credit');
  const expenses = pick('EXPENSE', 'debit');
  const totalIncome = sum(income.map((r) => r.amount));
  const totalExpenses = sum(expenses.map((r) => r.amount));
  const present = (list: typeof income) => list.map((r) => ({ ...r, amount: f(r.amount) }));
  return {
    income: present(income),
    expenses: present(expenses),
    totalIncome: f(totalIncome),
    totalExpenses: f(totalExpenses),
    netProfit: f(totalIncome.minus(totalExpenses)),
  };
}

export async function balanceSheet(ctx: RequestContext, range: Range) {
  const rows = await accountTotals(ctx, { ...range, from: undefined });
  const section = (type: string, natural: 'credit' | 'debit') =>
    rows
      .filter((r) => r.account.type === type)
      .map((r) => ({
        code: r.account.code,
        name: r.account.name,
        amount: natural === 'debit' ? r.debit.minus(r.credit) : r.credit.minus(r.debit),
      }))
      .filter((r) => !r.amount.isZero());
  const income = sum(
    rows.filter((r) => r.account.type === 'INCOME').map((r) => r.credit.minus(r.debit)),
  );
  const expense = sum(
    rows.filter((r) => r.account.type === 'EXPENSE').map((r) => r.debit.minus(r.credit)),
  );
  const earnings = income.minus(expense);
  const assets = section('ASSET', 'debit');
  const liabilities = section('LIABILITY', 'credit');
  const equity = section('EQUITY', 'credit');
  const totalAssets = sum(assets.map((r) => r.amount));
  const totalLiabilities = sum(liabilities.map((r) => r.amount));
  const totalEquity = sum(equity.map((r) => r.amount)).plus(earnings);
  const present = (list: typeof assets) => list.map((r) => ({ ...r, amount: f(r.amount) }));
  return {
    assets: present(assets),
    liabilities: present(liabilities),
    equity: present(equity),
    currentEarnings: f(earnings),
    totalAssets: f(totalAssets),
    totalLiabilities: f(totalLiabilities),
    totalEquity: f(totalEquity),
    balanced: totalAssets.equals(totalLiabilities.plus(totalEquity)),
  };
}

export async function generalLedger(ctx: RequestContext, accountId: string, range: Range) {
  const lines = await JournalLineModel.find({
    companyId: ctx.companyId,
    accountId,
    ...dateFilter('postingDate', range),
    ...(range.branchId ? { branchId: new Types.ObjectId(range.branchId) } : {}),
  })
    .sort({ postingDate: 1, _id: 1 })
    .limit(5000)
    .lean();
  const entries = await JournalEntryModel.find({
    companyId: ctx.companyId,
    _id: mongoose.trusted({ $in: lines.map((l) => l.entryId) }),
  }).lean();
  const byId = new Map(entries.map((e) => [e._id.toString(), e]));
  let running = new Decimal(0);
  return lines.map((line) => {
    running = running.plus(dec(line.debit)).minus(dec(line.credit));
    const entry = byId.get(line.entryId.toString());
    return {
      date: line.postingDate.toISOString().slice(0, 10),
      number: entry?.number,
      memo: entry?.memo,
      debit: f(dec(line.debit)),
      credit: f(dec(line.credit)),
      balance: f(running),
    };
  });
}

/** Direct method: each entry's cash movement is classified by its counter-account's class. */
export async function cashFlow(ctx: RequestContext, range: Range) {
  const accounts = await LedgerAccountModel.find({ companyId: ctx.companyId }).lean();
  const cashIds = accounts.filter((a) => a.isCash).map((a) => a._id);
  const classOf = new Map(accounts.map((a) => [a._id.toString(), a.cashFlowClass ?? 'OPERATING']));
  const cashLines = await JournalLineModel.find({
    companyId: ctx.companyId,
    accountId: mongoose.trusted({ $in: cashIds }),
    ...dateFilter('postingDate', range),
    ...(range.branchId ? { branchId: new Types.ObjectId(range.branchId) } : {}),
  }).lean();
  const entryIds = [...new Set(cashLines.map((l) => l.entryId.toString()))];
  const others = await JournalLineModel.find({
    companyId: ctx.companyId,
    entryId: mongoose.trusted({ $in: entryIds }),
    accountId: mongoose.trusted({ $nin: cashIds }),
  }).lean();
  const entryClass = new Map(
    others.map((l) => [l.entryId.toString(), classOf.get(l.accountId.toString()) ?? 'OPERATING']),
  );
  const totals: Record<string, Decimal> = {
    OPERATING: new Decimal(0),
    INVESTING: new Decimal(0),
    FINANCING: new Decimal(0),
  };
  for (const line of cashLines) {
    const key = entryClass.get(line.entryId.toString()) ?? 'OPERATING';
    totals[key] = (totals[key] as Decimal).plus(dec(line.debit)).minus(dec(line.credit));
  }
  return {
    operating: f(totals.OPERATING as Decimal),
    investing: f(totals.INVESTING as Decimal),
    financing: f(totals.FINANCING as Decimal),
    netChange: f(sum(Object.values(totals))),
  };
}
