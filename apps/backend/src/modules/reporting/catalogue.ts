import mongoose, { Types, type PipelineStage } from 'mongoose';
import type { RequestContext } from '../../shared/context.js';
import { dec } from '../../shared/decimal.js';
import { StockBalanceModel, StockMovementModel } from '../inventory/index.js';
import { OpenItemModel, PartyBalanceModel } from '../finance/index.js';
import { JournalLineModel, LedgerAccountModel } from '../ledger/index.js';
import { PartyModel, ProductModel, PurityModel } from '../master/index.js';
import { TaxTransactionModel } from '../tax/index.js';
import {
  CreditNoteModel,
  GoodsReceiptModel,
  PurchaseInvoiceModel,
  SalesInvoiceModel,
} from '../trade/index.js';
import { BranchModel, WarehouseModel } from '../organisation/index.js';
import { dateFilter, type Range } from './statements.js';

export type Row = Record<string, unknown>;
export interface ReportDefinition {
  title: string;
  permission: 'report:read' | 'financials:view_cost';
  run: (ctx: RequestContext, range: Range) => Promise<Row[]>;
}

const POSTED = ['POSTED', 'PARTIALLY_RETURNED', 'RETURNED'];

function tradeMatch(ctx: RequestContext, range: Range): Record<string, unknown> {
  const match: Record<string, unknown> = {
    companyId: ctx.companyId,
    status: mongoose.trusted({ $in: POSTED }),
    ...dateFilter('docDate', range),
  };
  if (range.branchId) match.branchId = new Types.ObjectId(range.branchId);
  else if (ctx.branchScope !== 'ALL') match.branchId = mongoose.trusted({ $in: ctx.branchScope });
  return match;
}

const lineTotals = {
  documents: { $addToSet: '$_id' },
  fineWeight: { $sum: '$lines.fineWeight' },
  netWeight: { $sum: '$lines.netWeight' },
  taxable: { $sum: '$lines.taxableValue' },
  tax: { $sum: '$lines.taxAmount' },
  total: { $sum: '$lines.lineTotal' },
  cost: { $sum: '$lines.costAtIssue' },
};

async function grouped(
  ctx: RequestContext,
  range: Range,
  direction: 'SALE' | 'PURCHASE',
  key: unknown,
  extra: PipelineStage[] = [],
): Promise<Row[]> {
  const model = (direction === 'SALE'
    ? SalesInvoiceModel
    : PurchaseInvoiceModel) as unknown as typeof SalesInvoiceModel;
  const rows = await model.aggregate<Row>([
    { $match: tradeMatch(ctx, range) },
    { $unwind: '$lines' },
    { $match: { 'lines.returned': mongoose.trusted({ $ne: true }) } },
    { $group: { _id: key, ...lineTotals } } as PipelineStage,
    { $addFields: { documents: { $size: '$documents' } } },
    { $sort: { _id: 1 } },
    ...extra,
  ]);
  return rows.map((row) => ({
    group: String(row._id),
    documents: row.documents,
    fineWeight: dec(row.fineWeight as Types.Decimal128).toFixed(4),
    netWeight: dec(row.netWeight as Types.Decimal128).toFixed(3),
    taxable: dec(row.taxable as Types.Decimal128).toFixed(2),
    tax: dec(row.tax as Types.Decimal128).toFixed(2),
    total: dec(row.total as Types.Decimal128).toFixed(2),
    ...(direction === 'SALE'
      ? {
          cost: dec(row.cost as Types.Decimal128).toFixed(2),
          grossProfit: dec(row.taxable as Types.Decimal128)
            .minus(dec(row.cost as Types.Decimal128))
            .toFixed(2),
        }
      : {}),
  }));
}

const day = { $dateToString: { format: '%Y-%m-%d', date: '$docDate' } };
const month = { $dateToString: { format: '%Y-%m', date: '$docDate' } };

const hideCost = (rows: Row[]) => rows.map(({ cost: _c, grossProfit: _g, ...row }) => row);

const sales = (key: unknown, title: string): ReportDefinition => ({
  title,
  permission: 'report:read',
  run: async (ctx, range) => {
    const rows = await grouped(ctx, range, 'SALE', key);
    return ctx.permissions.has('financials:view_cost') ? rows : hideCost(rows);
  },
});
const purchases = (key: unknown, title: string): ReportDefinition => ({
  title,
  permission: 'report:read',
  run: (ctx, range) => grouped(ctx, range, 'PURCHASE', key),
});

async function stockRows(ctx: RequestContext, range: Range) {
  const match: Record<string, unknown> = { companyId: ctx.companyId };
  if (range.branchId) match.branchId = new Types.ObjectId(range.branchId);
  const [balances, products, purities, warehouses] = await Promise.all([
    StockBalanceModel.find(match).lean(),
    ProductModel.find({ companyId: ctx.companyId }).lean(),
    PurityModel.find({ companyId: ctx.companyId }).lean(),
    WarehouseModel.find({ companyId: ctx.companyId }).lean(),
  ]);
  const name = <T extends { _id: Types.ObjectId }>(list: T[], id: Types.ObjectId) =>
    list.find((item) => item._id.equals(id));
  return balances.map((b) => ({
    sku: name(products, b.productId)?.sku,
    product: name(products, b.productId)?.name,
    purity: name(purities, b.purityId)?.label,
    warehouse: name(warehouses, b.warehouseId)?.name,
    location: b.location,
    pieces: b.pieces,
    gross: dec(b.gross).toFixed(3),
    net: dec(b.net).toFixed(3),
    available: dec(b.availableNet).toFixed(3),
    fine: dec(b.fine).toFixed(4),
    value: dec(b.cost).toFixed(2),
  }));
}

function summarise(rows: Row[], key: string): Row[] {
  const groups = new Map<
    string,
    { net: ReturnType<typeof dec>; fine: ReturnType<typeof dec>; value: ReturnType<typeof dec> }
  >();
  for (const row of rows) {
    const name = String(row[key]);
    const group = groups.get(name) ?? { net: dec('0'), fine: dec('0'), value: dec('0') };
    group.net = group.net.plus(row.net as string);
    group.fine = group.fine.plus(row.fine as string);
    group.value = group.value.plus(row.value as string);
    groups.set(name, group);
  }
  return [...groups].map(([group, v]) => ({
    group,
    net: v.net.toFixed(3),
    fine: v.fine.toFixed(4),
    value: v.value.toFixed(2),
  }));
}

async function outstanding(ctx: RequestContext, side: 'RECEIVABLE' | 'PAYABLE', range: Range) {
  const [items, parties] = await Promise.all([
    OpenItemModel.find({
      companyId: ctx.companyId,
      side,
      status: 'OPEN',
      ...(range.branchId ? { branchId: new Types.ObjectId(range.branchId) } : {}),
    })
      .sort({ dueDate: 1 })
      .lean(),
    PartyModel.find({ companyId: ctx.companyId }).lean(),
  ]);
  return items.map((item) => ({
    party: parties.find((p) => p._id.equals(item.partyId))?.name,
    number: item.number,
    docDate: item.docDate.toISOString().slice(0, 10),
    dueDate: item.dueDate.toISOString().slice(0, 10),
    original: dec(item.original).toFixed(2),
    outstanding: dec(item.outstanding).toFixed(2),
  }));
}

async function vat(ctx: RequestContext, range: Range, direction?: 'INPUT' | 'OUTPUT') {
  const rows = await TaxTransactionModel.find({
    companyId: ctx.companyId,
    ...(direction ? { direction } : {}),
    ...dateFilter('date', range),
    ...(range.branchId ? { branchId: new Types.ObjectId(range.branchId) } : {}),
  })
    .sort({ date: 1 })
    .lean();
  return rows.map((row) => ({
    date: row.date.toISOString().slice(0, 10),
    direction: row.direction,
    source: row.sourceType,
    taxCode: row.taxCode,
    treatment: row.treatment,
    rate: dec(row.ratePercent).toFixed(),
    taxable: dec(row.taxable).toFixed(2),
    tax: dec(row.tax).toFixed(2),
  }));
}

async function vatSummary(ctx: RequestContext, range: Range) {
  const rows = await vat(ctx, range);
  const groups = new Map<
    string,
    { taxable: ReturnType<typeof dec>; tax: ReturnType<typeof dec> }
  >();
  for (const row of rows) {
    const key = `${row.direction} ${row.treatment} ${row.taxCode}`;
    const group = groups.get(key) ?? { taxable: dec('0'), tax: dec('0') };
    group.taxable = group.taxable.plus(row.taxable);
    group.tax = group.tax.plus(row.tax);
    groups.set(key, group);
  }
  return [...groups].map(([group, v]) => ({
    group,
    taxable: v.taxable.toFixed(2),
    tax: v.tax.toFixed(2),
  }));
}

const profitReport = (key: unknown, title: string): ReportDefinition => ({
  title,
  permission: 'financials:view_cost',
  run: async (ctx, range) => {
    const rows = await grouped(ctx, range, 'SALE', key);
    return rows.map((row) => {
      const revenue = dec(row.taxable as string);
      const gross = dec(row.grossProfit as string);
      return {
        group: row.group,
        fineWeight: row.fineWeight,
        revenue: revenue.toFixed(2),
        cost: row.cost,
        grossProfit: gross.toFixed(2),
        marginPercent: revenue.isZero() ? '0.00' : gross.dividedBy(revenue).times(100).toFixed(2),
        profitPerFineGram: dec(row.fineWeight as string).isZero()
          ? '0.00'
          : gross.dividedBy(row.fineWeight as string).toFixed(2),
      };
    });
  },
});

/** After expenses, by branch, straight from the ledger. */
async function branchNetProfit(ctx: RequestContext, range: Range): Promise<Row[]> {
  const accounts = await LedgerAccountModel.find({
    companyId: ctx.companyId,
    type: mongoose.trusted({ $in: ['INCOME', 'EXPENSE'] }),
  }).lean();
  const typeOf = new Map(accounts.map((a) => [String(a._id), a.type]));
  const groups = await JournalLineModel.aggregate<{
    _id: { branchId: Types.ObjectId; accountId: Types.ObjectId };
    debit: Types.Decimal128;
    credit: Types.Decimal128;
  }>([
    {
      $match: {
        companyId: ctx.companyId,
        accountId: { $in: accounts.map((a) => a._id) },
        closing: { $ne: true },
        ...dateFilter('postingDate', range),
      },
    },
    {
      $group: {
        _id: { branchId: '$branchId', accountId: '$accountId' },
        debit: { $sum: '$debit' },
        credit: { $sum: '$credit' },
      },
    },
  ]);
  const branches = await BranchModel.find({ companyId: ctx.companyId }).lean();
  return branches.map((branch) => {
    const lines = groups.filter((g) => g._id.branchId.equals(branch._id));
    const sum = (type: string) =>
      lines
        .filter((g) => typeOf.get(String(g._id.accountId)) === type)
        .reduce((t, g) => t.plus(dec(g.credit)).minus(dec(g.debit)), dec('0'));
    const income = sum('INCOME');
    const expense = sum('EXPENSE').negated();
    return {
      branch: branch.name,
      income: income.toFixed(2),
      expenses: expense.toFixed(2),
      netProfit: income.minus(expense).toFixed(2),
    };
  });
}

async function supplierPerformance(ctx: RequestContext, range: Range): Promise<Row[]> {
  const purchased = await grouped(ctx, range, 'PURCHASE', '$partyId');
  const parties = await PartyModel.find({ companyId: ctx.companyId }).lean();
  const name = new Map(parties.map((p) => [String(p._id), p.name]));
  const receipts = await GoodsReceiptModel.find({
    companyId: ctx.companyId,
    ...dateFilter('receiptDate', range),
  }).lean();
  const returns = await CreditNoteModel.find({
    companyId: ctx.companyId,
    kind: 'SUPPLIER',
    ...dateFilter('docDate', range),
  }).lean();
  return purchased.map((row) => {
    const own = receipts.filter((r) => String(r.partyId) === row.group);
    const lines = own.flatMap((r) => r.lines as { varianceWeight?: Types.Decimal128 }[]);
    const shortfall = lines.reduce((sum, l) => sum.plus(dec(l.varianceWeight)), dec('0'));
    const returned = returns
      .filter((c) => String(c.partyId) === row.group)
      .reduce((sum, c) => sum.plus(dec(c.total)), dec('0'));
    const bought = dec(row.total as string);
    return {
      supplier: name.get(row.group as string) ?? row.group,
      invoices: row.documents,
      fineWeight: row.fineWeight,
      value: bought.toFixed(2),
      goodsReceipts: own.length,
      weightVariance: shortfall.toFixed(3),
      returnedValue: returned.toFixed(2),
      returnRatePercent: bought.isZero()
        ? '0.00'
        : returned.dividedBy(bought).times(100).toFixed(2),
    };
  });
}

/** The desk's exposure: metal held against metal owed to or by customers. */
async function metalPosition(ctx: RequestContext): Promise<Row[]> {
  const [stock] = await StockBalanceModel.aggregate([
    { $match: { companyId: ctx.companyId } },
    { $group: { _id: null, fine: { $sum: '$fine' } } },
  ]);
  const [unfixed] = await PartyBalanceModel.aggregate([
    { $match: { companyId: ctx.companyId } },
    { $group: { _id: null, fine: { $sum: '$metalFine' } } },
  ]);
  const held = dec(stock?.fine);
  const owed = dec(unfixed?.fine);
  return [
    {
      fineInStock: held.toFixed(4),
      netFineOwedToParties: owed.toFixed(4),
      netPosition: held.minus(owed).toFixed(4),
    },
  ];
}

export const REPORTS: Record<string, ReportDefinition> = {
  'profit-by-customer': profitReport('$partySnapshot.name', 'Profit by customer'),
  'profit-by-product': profitReport('$lines.productName', 'Profit by product'),
  'profit-by-purity': profitReport('$lines.purityLabel', 'Profit by purity'),
  'profit-by-month': profitReport(month, 'Profit by month'),
  'branch-net-profit': {
    title: 'Net profit by branch',
    permission: 'financials:view_cost',
    run: branchNetProfit,
  },
  'supplier-performance': {
    title: 'Supplier performance',
    permission: 'report:read',
    run: supplierPerformance,
  },
  'metal-position': {
    title: 'Metal position',
    permission: 'financials:view_cost',
    run: metalPosition,
  },
  'sales-daily': sales(day, 'Daily sales'),
  'sales-monthly': sales(month, 'Monthly sales'),
  'sales-by-customer': sales('$partySnapshot.name', 'Sales by customer'),
  'sales-by-product': sales('$lines.productName', 'Sales by product'),
  'sales-by-purity': sales('$lines.purityLabel', 'Sales by purity'),
  'sales-by-branch': sales('$branchId', 'Sales by branch'),
  'purchases-daily': purchases(day, 'Daily purchases'),
  'purchases-monthly': purchases(month, 'Monthly purchases'),
  'purchases-by-supplier': purchases('$partySnapshot.name', 'Purchases by supplier'),
  'stock-current': { title: 'Current stock', permission: 'financials:view_cost', run: stockRows },
  'stock-by-purity': {
    title: 'Stock by purity',
    permission: 'financials:view_cost',
    run: async (ctx, range) => summarise(await stockRows(ctx, range), 'purity'),
  },
  'stock-by-warehouse': {
    title: 'Stock by warehouse',
    permission: 'financials:view_cost',
    run: async (ctx, range) => summarise(await stockRows(ctx, range), 'warehouse'),
  },
  'stock-movements': {
    title: 'Stock movements',
    permission: 'report:read',
    run: async (ctx, range) => {
      const rows = await StockMovementModel.find({
        companyId: ctx.companyId,
        ...dateFilter('at', range),
        ...(range.branchId ? { branchId: new Types.ObjectId(range.branchId) } : {}),
      })
        .sort({ at: -1 })
        .limit(5000)
        .lean();
      return rows.map((row) => ({
        at: row.at.toISOString(),
        type: row.type,
        source: row.sourceType,
        location: row.location,
        pieces: row.pieces,
        net: dec(row.net).toFixed(3),
        fine: dec(row.fine).toFixed(4),
      }));
    },
  },
  'customer-outstanding': {
    title: 'Customer outstanding',
    permission: 'report:read',
    run: (ctx, range) => outstanding(ctx, 'RECEIVABLE', range),
  },
  'supplier-outstanding': {
    title: 'Supplier outstanding',
    permission: 'report:read',
    run: (ctx, range) => outstanding(ctx, 'PAYABLE', range),
  },
  'vat-summary': { title: 'VAT summary', permission: 'report:read', run: vatSummary },
  'vat-input': { title: 'Input VAT', permission: 'report:read', run: (c, r) => vat(c, r, 'INPUT') },
  'vat-output': {
    title: 'Output VAT',
    permission: 'report:read',
    run: (c, r) => vat(c, r, 'OUTPUT'),
  },
  'vat-details': { title: 'Tax transactions', permission: 'report:read', run: (c, r) => vat(c, r) },
};
