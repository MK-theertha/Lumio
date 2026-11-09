import mongoose, { Types } from 'mongoose';
import type { RequestContext } from '../../shared/context.js';
import { dec, Decimal } from '../../shared/decimal.js';
import { StockAdjustmentModel, StockBalanceModel, StockTransferModel } from '../inventory/index.js';
import { JournalLineModel, LedgerAccountModel } from '../ledger/index.js';
import { ProductModel } from '../master/index.js';
import { AuditLogModel } from '../platform/audit/index.js';
import { GoldRateModel } from '../pricing/index.js';
import { FinancialAccountModel } from '../finance/index.js';
import { PurchaseInvoiceModel, SalesInvoiceModel } from '../trade/index.js';
import { profitAndLoss, type Range } from './statements.js';

const POSTED = mongoose.trusted({ $in: ['POSTED', 'PARTIALLY_RETURNED', 'RETURNED'] });

async function tradeTotal(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- both invoice models share a shape
  model: any,
  ctx: RequestContext,
  from: Date,
  to: Date,
  branch?: Types.ObjectId,
) {
  const rows = await model.aggregate([
    {
      $match: {
        companyId: ctx.companyId,
        status: POSTED,
        docDate: mongoose.trusted({ $gte: from, $lte: to }),
        ...(branch ? { branchId: branch } : {}),
      },
    },
    {
      $group: {
        _id: null,
        total: { $sum: '$grandTotal' },
        taxable: { $sum: '$taxableTotal' },
        n: { $sum: 1 },
      },
    },
  ]);
  return {
    total: dec(rows[0]?.total).toFixed(2),
    taxable: dec(rows[0]?.taxable).toFixed(2),
    count: rows[0]?.n ?? 0,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- both invoice models share a shape
async function trend(model: any, ctx: RequestContext, from: Date) {
  const rows: { _id: string; total: Types.Decimal128 }[] = await model.aggregate([
    {
      $match: {
        companyId: ctx.companyId,
        status: POSTED,
        docDate: mongoose.trusted({ $gte: from }),
      },
    },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$docDate' } },
        total: { $sum: '$grandTotal' },
      },
    },
    { $sort: { _id: 1 } },
  ]);
  return rows.map((row) => ({ date: row._id, total: dec(row.total).toFixed(2) }));
}

async function ledgerBalance(
  ctx: RequestContext,
  accountIds: Types.ObjectId[],
  branch?: Types.ObjectId,
) {
  if (accountIds.length === 0) return new Decimal(0);
  const rows = await JournalLineModel.aggregate<{
    debit: Types.Decimal128;
    credit: Types.Decimal128;
  }>([
    {
      $match: {
        companyId: ctx.companyId,
        accountId: mongoose.trusted({ $in: accountIds }),
        ...(branch ? { branchId: branch } : {}),
      },
    },
    { $group: { _id: null, debit: { $sum: '$debit' }, credit: { $sum: '$credit' } } },
  ]);
  return dec(rows[0]?.debit).minus(dec(rows[0]?.credit));
}

/** Every figure here is computed from posted records. */
export async function buildDashboard(ctx: RequestContext, range: Range) {
  const now = new Date();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const trendFrom = new Date(dayStart.getTime() - 29 * 86_400_000);
  const branch = range.branchId ? new Types.ObjectId(range.branchId) : undefined;

  const [
    accounts,
    financial,
    balances,
    products,
    sales,
    purchases,
    salesTrend,
    purchaseTrend,
    recent,
    rates,
  ] = await Promise.all([
    LedgerAccountModel.find({ companyId: ctx.companyId }).lean(),
    FinancialAccountModel.find({ companyId: ctx.companyId, archivedAt: null }).lean(),
    StockBalanceModel.find({
      companyId: ctx.companyId,
      ...(branch ? { branchId: branch } : {}),
    }).lean(),
    ProductModel.find({
      companyId: ctx.companyId,
      reorderLevelNet: mongoose.trusted({ $ne: null }),
    }).lean(),
    tradeTotal(SalesInvoiceModel, ctx, range.from ?? dayStart, range.to ?? now, branch),
    tradeTotal(PurchaseInvoiceModel, ctx, range.from ?? dayStart, range.to ?? now, branch),
    trend(SalesInvoiceModel, ctx, trendFrom),
    trend(PurchaseInvoiceModel, ctx, trendFrom),
    AuditLogModel.find({ companyId: ctx.companyId }).sort({ at: -1 }).limit(10).lean(),
    GoldRateModel.find({ companyId: ctx.companyId }).sort({ effectiveAt: -1 }).limit(6).lean(),
  ]);

  const ledgerIdsFor = (kind: string) =>
    financial.filter((a) => a.kind === kind).map((a) => a.ledgerAccountId);
  const byRole = (role: string) => accounts.filter((a) => a.systemRole === role).map((a) => a._id);
  const [cash, bank, receivable, payable] = await Promise.all([
    ledgerBalance(ctx, ledgerIdsFor('CASH'), branch),
    ledgerBalance(ctx, ledgerIdsFor('BANK'), branch),
    ledgerBalance(ctx, byRole('AR'), branch),
    ledgerBalance(ctx, byRole('AP'), branch),
  ]);

  const stock = balances.reduce(
    (acc, b) => ({
      fine: acc.fine.plus(dec(b.fine)),
      net: acc.net.plus(dec(b.net)),
      value: acc.value.plus(dec(b.cost)),
    }),
    { fine: new Decimal(0), net: new Decimal(0), value: new Decimal(0) },
  );

  const netByProduct = new Map<string, Decimal>();
  for (const b of balances) {
    const key = b.productId.toString();
    netByProduct.set(key, (netByProduct.get(key) ?? new Decimal(0)).plus(dec(b.availableNet)));
  }
  const lowStock = products
    .filter((p) =>
      (netByProduct.get(p._id.toString()) ?? new Decimal(0)).lessThan(dec(p.reorderLevelNet)),
    )
    .map((p) => ({
      sku: p.sku,
      name: p.name,
      available: (netByProduct.get(p._id.toString()) ?? new Decimal(0)).toFixed(3),
      reorderLevel: dec(p.reorderLevelNet).toFixed(3),
    }));

  const pendingStatus = { companyId: ctx.companyId, status: 'PENDING_APPROVAL' };
  const [pendingSales, pendingPurchases, pendingAdjustments, pendingTransfers] = await Promise.all([
    SalesInvoiceModel.countDocuments(pendingStatus),
    PurchaseInvoiceModel.countDocuments(pendingStatus),
    StockAdjustmentModel.countDocuments({ companyId: ctx.companyId, status: 'PENDING' }),
    StockTransferModel.countDocuments({ companyId: ctx.companyId, status: 'REQUESTED' }),
  ]);

  const canSeeCost = ctx.permissions.has('financials:view_cost');
  const pnl = canSeeCost
    ? await profitAndLoss(ctx, {
        from: range.from ?? dayStart,
        to: range.to ?? now,
        branchId: range.branchId,
      })
    : null;

  return {
    stock: {
      fineWeight: stock.fine.toFixed(4),
      netWeight: stock.net.toFixed(3),
      ...(canSeeCost ? { valuation: stock.value.toFixed(2) } : {}),
    },
    sales,
    purchases,
    cashBalance: cash.toFixed(2),
    bankBalance: bank.toFixed(2),
    receivable: receivable.toFixed(2),
    payable: payable.negated().toFixed(2),
    grossProfit: pnl?.netProfit ?? null,
    lowStock,
    pendingApprovals: {
      sales: pendingSales,
      purchases: pendingPurchases,
      adjustments: pendingAdjustments,
      transfers: pendingTransfers,
    },
    salesTrend,
    purchaseTrend,
    recentActivity: recent.map((row) => ({
      id: row._id.toString(),
      action: row.action,
      entityType: row.entityType,
      at: row.at.toISOString(),
    })),
    rates: rates.map((rate) => ({
      id: rate._id.toString(),
      basis: rate.basis,
      valuePerGram: dec(rate.valuePerGram).toFixed(4),
      currency: rate.currency,
      source: rate.source,
      effectiveAt: rate.effectiveAt.toISOString(),
    })),
  };
}
