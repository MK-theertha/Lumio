import type { z } from 'zod';
import type {
  stockAdjustmentSchema,
  stockCountSchema,
  stockIssueSchema,
  stockReceiptSchema,
  stockReservationSchema,
  stockTransferSchema,
} from '@lumio/validation';
import mongoose, { Types } from 'mongoose';
import { runInTransaction } from '../../database/transaction.js';
import {
  assertBranchAccess,
  type RequestContext,
  type TransactionalContext,
} from '../../shared/context.js';
import { d128, dec, Decimal } from '../../shared/decimal.js';
import { BusinessRuleError, ConflictError, NotFoundError } from '../../shared/errors.js';
import { ProductModel, PurityModel } from '../master/index.js';
import { CompanyModel, WarehouseModel } from '../organisation/index.js';
import { recordAudit } from '../platform/audit/index.js';
import { postJournal } from '../ledger/index.js';
import {
  StockAdjustmentModel,
  StockBalanceModel,
  StockCountModel,
  StockItemModel,
  StockLotModel,
  StockReservationModel,
  StockTransferModel,
} from './inventory.models.js';
import { stockIn, stockOut, stockOutOldestFirst, type Quantity } from './stock.service.js';

type Id = string | Types.ObjectId;

async function warehouseOf(ctx: RequestContext, id: Id) {
  const warehouse = await WarehouseModel.findOne({ companyId: ctx.companyId, _id: id })
    .session(ctx.session ?? null)
    .lean();
  if (!warehouse) throw new NotFoundError('The warehouse was not found.');
  assertBranchAccess(ctx, warehouse.branchId);
  return warehouse;
}

export async function productWithPurity(ctx: RequestContext, id: Id) {
  const product = await ProductModel.findOne({ companyId: ctx.companyId, _id: id })
    .session(ctx.session ?? null)
    .lean();
  if (!product) throw new NotFoundError('The product was not found.');
  const purity = await PurityModel.findOne({ companyId: ctx.companyId, _id: product.purityId })
    .session(ctx.session ?? null)
    .lean();
  if (!purity) throw new NotFoundError('The purity was not found.');
  return { product, purity };
}

export async function stockPolicy(ctx: RequestContext) {
  const company = await CompanyModel.findById(ctx.companyId)
    .session(ctx.session ?? null)
    .lean();
  if (!company) throw new NotFoundError('The company was not found.');
  return company;
}

function quantityFrom(pieces: number, gross: string, stone: string, fineness: unknown): Quantity {
  const net = dec(gross).minus(stone);
  if (net.isNegative()) throw new BusinessRuleError('Stone weight exceeds gross weight.');
  return {
    pieces,
    gross: dec(gross),
    net,
    fine: net.times(dec(fineness as string)).toDecimalPlaces(4),
  };
}

function stockJournal(
  tx: TransactionalContext,
  args: {
    branchId: Id;
    amount: Decimal;
    increase: boolean;
    contra: 'OPENING_EQUITY' | 'STOCK_GAIN_LOSS';
    memo: string;
    sourceType: string;
    sourceId: string;
  },
) {
  if (args.amount.isZero()) return undefined;
  return postJournal(tx, {
    postingDate: new Date(),
    branchId: args.branchId,
    memo: args.memo,
    sourceType: args.sourceType,
    sourceId: args.sourceId,
    kind: 'STOCK',
    lines: [
      { role: 'INVENTORY', ...(args.increase ? { debit: args.amount } : { credit: args.amount }) },
      { role: args.contra, ...(args.increase ? { credit: args.amount } : { debit: args.amount }) },
    ],
  });
}

async function ensureLot(
  tx: TransactionalContext,
  lotNo: string,
  productId: Id,
  purityId: Id,
  sourceType: string,
  sourceId: string,
) {
  const existing = await StockLotModel.findOne({ companyId: tx.companyId, lotNo })
    .session(tx.session)
    .lean();
  if (existing) return existing._id;
  const [lot] = await StockLotModel.create(
    [{ companyId: tx.companyId, lotNo, productId, purityId, sourceType, sourceId }],
    { session: tx.session },
  );
  return (lot as { _id: Types.ObjectId })._id;
}

/** Brings goods in, creating the piece or lot record that tracks them. */
export async function receiveInto(
  tx: TransactionalContext,
  args: {
    warehouseId: Id;
    location: string;
    productId: Id;
    pieces: number;
    grossWeight: string;
    stoneWeight: string;
    cost: Decimal;
    tag?: string | undefined;
    lotNo?: string | undefined;
    sourceType: string;
    sourceId: string;
    lineId: string;
    type: string;
  },
) {
  const warehouse = await warehouseOf(tx, args.warehouseId);
  const { product, purity } = await productWithPurity(tx, args.productId);
  const quantity = quantityFrom(args.pieces, args.grossWeight, args.stoneWeight, purity.fineness);
  const source = {
    type: args.type,
    sourceType: args.sourceType,
    sourceId: args.sourceId,
    lineId: args.lineId,
  };
  const key = {
    branchId: warehouse.branchId,
    warehouseId: warehouse._id,
    location: args.location,
    productId: product._id,
    purityId: purity._id,
  };

  if (product.tracking === 'PIECE') {
    if (args.pieces !== 1) throw new BusinessRuleError('Piece-tracked items are received singly.');
    const tag = args.tag ?? `${product.sku}-${new Types.ObjectId().toString().slice(-8)}`;
    const [item] = await StockItemModel.create(
      [
        {
          companyId: tx.companyId,
          tag,
          productId: product._id,
          purityId: purity._id,
          branchId: warehouse.branchId,
          warehouseId: warehouse._id,
          location: args.location,
          gross: d128(quantity.gross),
          stone: d128(args.stoneWeight),
          net: d128(quantity.net),
          fine: d128(quantity.fine),
          cost: d128(args.cost),
          status: 'IN_STOCK',
        },
      ],
      { session: tx.session },
    );
    const stockItemId = (item as { _id: Types.ObjectId })._id;
    await stockIn(tx, key, quantity, args.cost, source, stockItemId);
    return { branchId: warehouse.branchId, stockItemId };
  } else {
    const lotNo = args.lotNo ?? `LOT-${args.sourceId.slice(-8)}-${args.lineId}`;
    const lotId = await ensureLot(
      tx,
      lotNo,
      product._id,
      purity._id,
      args.sourceType,
      args.sourceId,
    );
    await stockIn(tx, { ...key, lotId }, quantity, args.cost, source);
    return { branchId: warehouse.branchId, lotId };
  }
}

export function receiveStock(ctx: RequestContext, input: z.infer<typeof stockReceiptSchema>) {
  return runInTransaction(ctx, async (tx) => {
    const sourceId = new Types.ObjectId().toString();
    const { branchId } = await receiveInto(tx, {
      ...input,
      cost: dec(input.totalCost),
      sourceType: 'STOCK_RECEIPT',
      sourceId,
      lineId: '1',
      type: 'RECEIPT',
    });
    await stockJournal(tx, {
      branchId,
      amount: dec(input.totalCost),
      increase: true,
      contra: 'OPENING_EQUITY',
      memo: `Stock receipt: ${input.reason}`,
      sourceType: 'STOCK_RECEIPT',
      sourceId,
    });
    await recordAudit(tx, {
      action: 'stock.receive',
      entityType: 'stock',
      entityId: sourceId,
      after: input,
    });
    return { id: sourceId };
  });
}

export function issueStock(ctx: RequestContext, input: z.infer<typeof stockIssueSchema>) {
  return runInTransaction(ctx, async (tx) => {
    const warehouse = await warehouseOf(tx, input.warehouseId);
    const company = await stockPolicy(tx);
    const { product, purity } = await productWithPurity(tx, input.productId);
    const sourceId = new Types.ObjectId().toString();
    const key = {
      branchId: warehouse.branchId,
      warehouseId: warehouse._id,
      location: input.location,
      productId: product._id,
      purityId: purity._id,
    };
    const quantity = quantityFrom(
      input.pieces,
      input.grossWeight,
      input.stoneWeight,
      purity.fineness,
    );
    const source = { type: 'ISSUE', sourceType: 'STOCK_ISSUE', sourceId, lineId: '1' };
    const policy = {
      allowNegative: company.settings?.allowNegativeStock ?? false,
      moneyScale: company.settings?.pricing?.moneyScale ?? 2,
    };
    const cost =
      product.tracking === 'LOT' && !input.lotId
        ? (await stockOutOldestFirst(tx, key, quantity, source, policy)).cost
        : await stockOut(tx, { ...key, lotId: input.lotId }, quantity, source, {
            ...policy,
            ...(input.stockItemId ? { stockItemId: input.stockItemId } : {}),
          });
    await stockJournal(tx, {
      branchId: warehouse.branchId,
      amount: cost,
      increase: false,
      contra: 'STOCK_GAIN_LOSS',
      memo: `Stock issue: ${input.reason}`,
      sourceType: 'STOCK_ISSUE',
      sourceId,
    });
    await recordAudit(tx, {
      action: 'stock.issue',
      entityType: 'stock',
      entityId: sourceId,
      after: input,
    });
    return { id: sourceId };
  });
}

export async function requestAdjustment(
  ctx: RequestContext,
  input: z.infer<typeof stockAdjustmentSchema>,
) {
  await warehouseOf(ctx, input.warehouseId);
  const adjustment = await StockAdjustmentModel.create({
    companyId: ctx.companyId,
    payload: input,
    status: 'PENDING',
    createdBy: ctx.userId,
  });
  await recordAudit(ctx, {
    action: 'stock.adjustment_requested',
    entityType: 'stock_adjustment',
    entityId: adjustment._id.toString(),
    after: input,
  });
  return adjustment.toObject();
}

async function applyAdjustment(
  tx: TransactionalContext,
  input: z.infer<typeof stockAdjustmentSchema>,
  sourceId: string,
): Promise<Decimal> {
  const warehouse = await warehouseOf(tx, input.warehouseId);
  const company = await stockPolicy(tx);
  const { product, purity } = await productWithPurity(tx, input.productId);
  const quantity = quantityFrom(
    input.pieces,
    input.grossWeight,
    input.stoneWeight,
    purity.fineness,
  );
  const key = {
    branchId: warehouse.branchId,
    warehouseId: warehouse._id,
    location: input.location,
    productId: product._id,
    purityId: purity._id,
    lotId: input.lotId,
  };
  const source = {
    type: `ADJUST_${input.direction}`,
    sourceType: 'STOCK_ADJUSTMENT',
    sourceId,
    lineId: input.productId,
  };
  const gain = input.direction === 'GAIN';
  const cost = gain
    ? dec(input.unitCostValue)
    : await stockOut(tx, key, quantity, source, {
        allowNegative: company.settings?.allowNegativeStock ?? false,
        moneyScale: company.settings?.pricing?.moneyScale ?? 2,
      });
  if (gain) await stockIn(tx, key, quantity, cost, source);
  await stockJournal(tx, {
    branchId: warehouse.branchId,
    amount: cost,
    increase: gain,
    contra: 'STOCK_GAIN_LOSS',
    memo: `Stock adjustment: ${input.reason}`,
    sourceType: 'STOCK_ADJUSTMENT',
    sourceId,
  });
  return cost;
}

export function decideAdjustment(ctx: RequestContext, id: string, approve: boolean) {
  return runInTransaction(ctx, async (tx) => {
    const adjustment = await StockAdjustmentModel.findOne({
      companyId: tx.companyId,
      _id: id,
      status: 'PENDING',
    })
      .session(tx.session)
      .lean();
    if (!adjustment) throw new ConflictError('This adjustment has already been decided.');
    if (adjustment.createdBy === tx.userId) {
      throw new BusinessRuleError('You cannot decide your own adjustment.');
    }
    const cost = approve
      ? await applyAdjustment(tx, adjustment.payload as z.infer<typeof stockAdjustmentSchema>, id)
      : new Decimal(0);
    await StockAdjustmentModel.updateOne(
      { companyId: tx.companyId, _id: id },
      {
        $set: {
          status: approve ? 'APPROVED' : 'REJECTED',
          decidedBy: tx.userId,
          costApplied: d128(cost),
        },
      },
    ).session(tx.session);
    await recordAudit(tx, {
      action: approve ? 'stock.adjustment_approved' : 'stock.adjustment_rejected',
      entityType: 'stock_adjustment',
      entityId: id,
    });
    return { status: approve ? 'APPROVED' : 'REJECTED' };
  });
}

export async function createTransfer(
  ctx: RequestContext,
  input: z.infer<typeof stockTransferSchema>,
) {
  await warehouseOf(ctx, input.fromWarehouseId);
  await warehouseOf(ctx, input.toWarehouseId);
  if (input.fromWarehouseId === input.toWarehouseId) {
    throw new BusinessRuleError('Source and destination must differ.');
  }
  const transfer = await StockTransferModel.create({
    companyId: ctx.companyId,
    ...input,
    status: 'REQUESTED',
    createdBy: ctx.userId,
  });
  return transfer.toObject();
}

interface TransferLine {
  productId: string;
  lotId?: string;
  stockItemId?: string;
  pieces: number;
  grossWeight: string;
  stoneWeight: string;
  cost?: string;
}

const IN_TRANSIT = 'IN_TRANSIT';

export function dispatchTransfer(ctx: RequestContext, id: string) {
  return runInTransaction(ctx, async (tx) => {
    const transfer = await StockTransferModel.findOne({
      companyId: tx.companyId,
      _id: id,
      status: 'REQUESTED',
    })
      .session(tx.session)
      .lean();
    if (!transfer) throw new ConflictError('Only a requested transfer can be dispatched.');
    if (transfer.createdBy === tx.userId) {
      throw new BusinessRuleError('A second person must authorise this transfer.');
    }
    const from = await warehouseOf(tx, transfer.fromWarehouseId);
    const company = await stockPolicy(tx);
    const lines: TransferLine[] = [];
    for (const [index, raw] of (transfer.lines as TransferLine[]).entries()) {
      const { product, purity } = await productWithPurity(tx, raw.productId);
      const quantity = quantityFrom(raw.pieces, raw.grossWeight, raw.stoneWeight, purity.fineness);
      const key = {
        branchId: from.branchId,
        warehouseId: from._id,
        productId: product._id,
        purityId: purity._id,
        lotId: raw.lotId,
      };
      const lineId = String(index);
      const cost = await stockOut(
        tx,
        { ...key, location: transfer.location },
        quantity,
        { type: 'TRANSFER_OUT', sourceType: 'STOCK_TRANSFER', sourceId: id, lineId },
        {
          allowNegative: false,
          moneyScale: company.settings?.pricing?.moneyScale ?? 2,
          ...(raw.stockItemId ? { stockItemId: raw.stockItemId } : {}),
        },
      );
      await stockIn(tx, { ...key, location: IN_TRANSIT }, quantity, cost, {
        type: 'TRANSIT_IN',
        sourceType: 'STOCK_TRANSFER',
        sourceId: id,
        lineId,
      });
      lines.push({ ...raw, cost: cost.toFixed() });
    }
    await StockTransferModel.updateOne(
      { companyId: tx.companyId, _id: id },
      { $set: { status: 'IN_TRANSIT', decidedBy: tx.userId, lines } },
    ).session(tx.session);
    await recordAudit(tx, {
      action: 'stock.transfer_dispatched',
      entityType: 'stock_transfer',
      entityId: id,
    });
    return { status: 'IN_TRANSIT' };
  });
}

export function receiveTransfer(ctx: RequestContext, id: string) {
  return runInTransaction(ctx, async (tx) => {
    const transfer = await StockTransferModel.findOne({
      companyId: tx.companyId,
      _id: id,
      status: 'IN_TRANSIT',
    })
      .session(tx.session)
      .lean();
    if (!transfer) throw new ConflictError('Only an in-transit transfer can be received.');
    const from = await warehouseOf(tx, transfer.fromWarehouseId);
    const to = await warehouseOf(tx, transfer.toWarehouseId);
    let total = new Decimal(0);

    for (const [index, raw] of (transfer.lines as TransferLine[]).entries()) {
      const { product, purity } = await productWithPurity(tx, raw.productId);
      const quantity = quantityFrom(raw.pieces, raw.grossWeight, raw.stoneWeight, purity.fineness);
      const cost = dec(raw.cost);
      const lineId = String(index);
      const common = { productId: product._id, purityId: purity._id, lotId: raw.lotId };
      await stockOut(
        tx,
        { ...common, branchId: from.branchId, warehouseId: from._id, location: IN_TRANSIT },
        quantity,
        { type: 'TRANSIT_OUT', sourceType: 'STOCK_TRANSFER', sourceId: id, lineId },
        { allowNegative: false, moneyScale: 6 },
      );
      await stockIn(
        tx,
        { ...common, branchId: to.branchId, warehouseId: to._id, location: transfer.location },
        quantity,
        cost,
        {
          type: 'TRANSFER_IN',
          sourceType: 'STOCK_TRANSFER',
          sourceId: id,
          lineId,
        },
        raw.stockItemId,
      );
      if (raw.stockItemId) {
        await StockItemModel.updateOne(
          { companyId: tx.companyId, _id: raw.stockItemId },
          {
            $set: {
              status: 'IN_STOCK',
              branchId: to.branchId,
              warehouseId: to._id,
              location: transfer.location,
            },
          },
        ).session(tx.session);
      }
      total = total.plus(cost);
    }

    if (!from.branchId.equals(to.branchId) && total.greaterThan(0)) {
      await postJournal(tx, {
        postingDate: new Date(),
        branchId: to.branchId,
        memo: `Inter-branch stock transfer ${id}`,
        sourceType: 'STOCK_TRANSFER',
        sourceId: id,
        kind: 'TRANSFER',
        lines: [
          { role: 'INVENTORY', debit: total, branchId: to.branchId },
          { role: 'INTER_BRANCH', credit: total, branchId: to.branchId },
          { role: 'INTER_BRANCH', debit: total, branchId: from.branchId },
          { role: 'INVENTORY', credit: total, branchId: from.branchId },
        ],
      });
    }
    await StockTransferModel.updateOne(
      { companyId: tx.companyId, _id: id },
      { $set: { status: 'RECEIVED' } },
    ).session(tx.session);
    await recordAudit(tx, {
      action: 'stock.transfer_received',
      entityType: 'stock_transfer',
      entityId: id,
    });
    return { status: 'RECEIVED' };
  });
}

/** Lot-tracked stock is held per lot, so a line without one would read a balance of zero. */
function assertLotGiven(product: { name: string; tracking: string }, lotId?: string): void {
  if (product.tracking === 'LOT' && !lotId) {
    throw new BusinessRuleError(`Choose a lot for ${product.name}.`);
  }
}

export function reserveStock(ctx: RequestContext, input: z.infer<typeof stockReservationSchema>) {
  return runInTransaction(ctx, async (tx) => {
    const warehouse = await warehouseOf(tx, input.warehouseId);
    const { product, purity } = await productWithPurity(tx, input.productId);
    assertLotGiven(product, input.lotId);
    const net = d128(input.netWeight);
    const balance = await StockBalanceModel.findOneAndUpdate(
      {
        companyId: tx.companyId,
        warehouseId: warehouse._id,
        location: input.location,
        productId: product._id,
        purityId: purity._id,
        lotId: input.lotId ?? null,
        availableNet: mongoose.trusted({ $gte: net }),
      },
      { $inc: { availableNet: d128(dec(input.netWeight).negated()), reservedNet: net } },
      { session: tx.session },
    ).lean();
    if (!balance)
      throw new BusinessRuleError(
        'There is not enough available stock to reserve.',
        'INSUFFICIENT_STOCK',
      );
    const [reservation] = await StockReservationModel.create(
      [
        {
          companyId: tx.companyId,
          balanceId: balance._id,
          netWeight: net,
          reference: input.reference,
          ...(input.expiresAt ? { expiresAt: new Date(input.expiresAt) } : {}),
          status: 'ACTIVE',
        },
      ],
      { session: tx.session },
    );
    return reservation?.toObject();
  });
}

export function releaseReservation(ctx: RequestContext, id: string) {
  return runInTransaction(ctx, async (tx) => {
    const reservation = await StockReservationModel.findOneAndUpdate(
      { companyId: tx.companyId, _id: id, status: 'ACTIVE' },
      { $set: { status: 'RELEASED' } },
      { session: tx.session },
    ).lean();
    if (!reservation) throw new ConflictError('This reservation is no longer active.');
    await StockBalanceModel.updateOne(
      { companyId: tx.companyId, _id: reservation.balanceId },
      {
        $inc: {
          availableNet: reservation.netWeight,
          reservedNet: d128(dec(reservation.netWeight).negated()),
        },
      },
    ).session(tx.session);
    return { status: 'RELEASED' };
  });
}

export async function createCount(ctx: RequestContext, input: z.infer<typeof stockCountSchema>) {
  await warehouseOf(ctx, input.warehouseId);
  const lines = [];
  for (const line of input.lines) {
    const { product, purity } = await productWithPurity(ctx, line.productId);
    assertLotGiven(product, line.lotId);
    const balance = await StockBalanceModel.findOne({
      companyId: ctx.companyId,
      warehouseId: input.warehouseId,
      location: input.location,
      productId: line.productId,
      purityId: purity._id,
      lotId: line.lotId ?? null,
    }).lean();
    const book = dec(balance?.net);
    lines.push({
      ...line,
      bookNet: book.toFixed(),
      varianceNet: dec(line.countedNet).minus(book).toFixed(),
    });
  }
  const count = await StockCountModel.create({
    companyId: ctx.companyId,
    warehouseId: input.warehouseId,
    location: input.location,
    lines,
    status: 'PENDING',
    createdBy: ctx.userId,
  });
  return count.toObject();
}

export function approveCount(ctx: RequestContext, id: string) {
  return runInTransaction(ctx, async (tx) => {
    const count = await StockCountModel.findOne({
      companyId: tx.companyId,
      _id: id,
      status: 'PENDING',
    })
      .session(tx.session)
      .lean();
    if (!count) throw new ConflictError('This count has already been decided.');
    if (count.createdBy === tx.userId) {
      throw new BusinessRuleError('A second person must approve this count.');
    }
    const lines = count.lines as {
      productId: string;
      lotId?: string;
      varianceNet: string;
      bookNet: string;
    }[];
    for (const [index, line] of lines.entries()) {
      const variance = dec(line.varianceNet);
      if (variance.isZero()) continue;
      const balance = await StockBalanceModel.findOne({
        companyId: tx.companyId,
        warehouseId: count.warehouseId,
        location: count.location,
        productId: line.productId,
        lotId: line.lotId ?? null,
      })
        .session(tx.session)
        .lean();
      const unitCost = dec(balance?.net).greaterThan(0)
        ? dec(balance?.cost).dividedBy(dec(balance?.net))
        : new Decimal(0);
      await applyAdjustment(
        tx,
        {
          warehouseId: count.warehouseId.toString(),
          location: count.location,
          productId: line.productId,
          ...(line.lotId ? { lotId: line.lotId } : {}),
          direction: variance.isNegative() ? 'LOSS' : 'GAIN',
          pieces: 0,
          grossWeight: variance.abs().toFixed(),
          stoneWeight: '0',
          unitCostValue: unitCost.times(variance.abs()).toDecimalPlaces(2).toFixed(),
          reason: `Stock count ${id}`,
        },
        `${id}-${index}`,
      );
    }
    await StockCountModel.updateOne(
      { companyId: tx.companyId, _id: id },
      { $set: { status: 'APPROVED', decidedBy: tx.userId } },
    ).session(tx.session);
    await recordAudit(tx, {
      action: 'stock.count_approved',
      entityType: 'stock_count',
      entityId: id,
    });
    return { status: 'APPROVED' };
  });
}
