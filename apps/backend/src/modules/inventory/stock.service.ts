import { ErrorCode } from '@lumio/shared-types';
import mongoose, { Types } from 'mongoose';
import { retryDuplicateKeyInTransaction } from '../../database/transaction.js';
import { assertTransactional, type RequestContext } from '../../shared/context.js';
import { d128, dec, Decimal } from '../../shared/decimal.js';
import { BusinessRuleError, NotFoundError } from '../../shared/errors.js';
import { StockBalanceModel, StockItemModel, StockMovementModel } from './inventory.models.js';

type Id = Types.ObjectId | string;

export interface StockKey {
  branchId: Id;
  warehouseId: Id;
  location: string;
  productId: Id;
  purityId: Id;
  lotId?: Id | undefined;
}

export interface Quantity {
  pieces: number;
  gross: Decimal;
  net: Decimal;
  fine: Decimal;
}

export interface MovementSource {
  type: string;
  sourceType: string;
  sourceId: string;
  lineId: string;
}

const insufficient = () =>
  new BusinessRuleError(
    'There is not enough stock for this operation.',
    ErrorCode.INSUFFICIENT_STOCK,
  );

const balanceKey = (ctx: RequestContext, key: StockKey) => ({
  companyId: ctx.companyId,
  warehouseId: new Types.ObjectId(String(key.warehouseId)),
  location: key.location,
  productId: new Types.ObjectId(String(key.productId)),
  purityId: new Types.ObjectId(String(key.purityId)),
  lotId: key.lotId ? new Types.ObjectId(String(key.lotId)) : null,
});

async function writeMovement(
  ctx: RequestContext,
  key: StockKey,
  quantity: Quantity,
  cost: Decimal,
  source: MovementSource,
  sign: 1 | -1,
  stockItemId?: Id,
): Promise<void> {
  await StockMovementModel.create(
    [
      {
        companyId: ctx.companyId,
        ...source,
        branchId: key.branchId,
        warehouseId: key.warehouseId,
        location: key.location,
        productId: key.productId,
        purityId: key.purityId,
        ...(key.lotId ? { lotId: key.lotId } : {}),
        ...(stockItemId ? { stockItemId } : {}),
        pieces: sign * quantity.pieces,
        gross: d128(quantity.gross.times(sign)),
        net: d128(quantity.net.times(sign)),
        fine: d128(quantity.fine.times(sign)),
        cost: d128(cost.times(sign)),
        actorId: ctx.userId,
        at: new Date(),
      },
    ],
    { session: ctx.session ?? null },
  );
}

/** Adds stock and its cost. The balance and the ledger row commit together. */
export async function stockIn(
  ctx: RequestContext,
  key: StockKey,
  quantity: Quantity,
  cost: Decimal,
  source: MovementSource,
  stockItemId?: Id,
): Promise<void> {
  assertTransactional(ctx, 'stockIn');
  await StockBalanceModel.updateOne(
    balanceKey(ctx, key),
    {
      $setOnInsert: { branchId: key.branchId, reservedNet: d128('0') },
      $inc: {
        pieces: quantity.pieces,
        gross: d128(quantity.gross),
        net: d128(quantity.net),
        fine: d128(quantity.fine),
        availableNet: d128(quantity.net),
        cost: d128(cost),
      },
    },
    { upsert: true, session: ctx.session },
  ).catch(retryDuplicateKeyInTransaction);
  await writeMovement(ctx, key, quantity, cost, source, 1, stockItemId);
}

/**
 * Removes stock, returning the cost relieved. The availability test and the decrement are one
 * atomic write, so concurrent issues cannot oversell. Lots relieve at moving average per fine gram.
 */
export async function stockOut(
  ctx: RequestContext,
  key: StockKey,
  quantity: Quantity,
  source: MovementSource,
  options: { allowNegative: boolean; moneyScale: number; stockItemId?: Id },
): Promise<Decimal> {
  assertTransactional(ctx, 'stockOut');
  const filter = balanceKey(ctx, key);
  let cost: Decimal;

  if (options.stockItemId) {
    const item = await StockItemModel.findOneAndUpdate(
      {
        companyId: ctx.companyId,
        _id: options.stockItemId,
        status: 'IN_STOCK',
        warehouseId: key.warehouseId,
      },
      { $set: { status: 'ISSUED', issuedBy: source.sourceId } },
      { session: ctx.session },
    ).lean();
    if (!item) throw insufficient();
    cost = dec(item.cost);
  } else {
    const balance = await StockBalanceModel.findOne(filter).session(ctx.session).lean();
    if (!balance && !options.allowNegative) throw insufficient();
    const onHandFine = dec(balance?.fine);
    cost = onHandFine.greaterThan(0)
      ? dec(balance?.cost)
          .times(quantity.fine)
          .dividedBy(onHandFine)
          .toDecimalPlaces(options.moneyScale)
      : new Decimal(0);
    cost = Decimal.min(cost, Decimal.max(dec(balance?.cost), 0));
  }

  const guard = options.allowNegative
    ? {}
    : { availableNet: mongoose.trusted({ $gte: d128(quantity.net) }) };
  const result = await StockBalanceModel.updateOne(
    { ...filter, ...guard },
    {
      $setOnInsert: { branchId: key.branchId, reservedNet: d128('0') },
      $inc: {
        pieces: -quantity.pieces,
        gross: d128(quantity.gross.negated()),
        net: d128(quantity.net.negated()),
        fine: d128(quantity.fine.negated()),
        availableNet: d128(quantity.net.negated()),
        cost: d128(cost.negated()),
      },
    },
    { upsert: options.allowNegative, session: ctx.session },
  ).catch(retryDuplicateKeyInTransaction);
  if (result.matchedCount === 0 && result.upsertedCount === 0) throw insufficient();

  await writeMovement(ctx, key, quantity, cost, source, -1, options.stockItemId);
  return cost;
}

export interface LotAllocation {
  lotId?: string;
  pieces: number;
  gross: string;
  net: string;
  fine: string;
  cost: string;
}

/** Relieves lot-tracked stock oldest lot first when no specific lot was chosen. */
export async function stockOutOldestFirst(
  ctx: RequestContext,
  key: Omit<StockKey, 'lotId'>,
  quantity: Quantity,
  source: MovementSource,
  options: { allowNegative: boolean; moneyScale: number },
): Promise<{ cost: Decimal; allocations: LotAllocation[] }> {
  assertTransactional(ctx, 'stockOutOldestFirst');
  const filter: Partial<ReturnType<typeof balanceKey>> = balanceKey(ctx, key);
  delete filter.lotId;
  const balances = (await StockBalanceModel.find({
    ...filter,
    availableNet: mongoose.trusted({ $gt: d128('0') }),
  })
    .sort({ _id: 1 })
    .session(ctx.session)
    .lean()) as {
    lotId?: Types.ObjectId | null;
    availableNet: Types.Decimal128;
    pieces: number;
  }[];

  const takes: { lotId?: Types.ObjectId | undefined; net: Decimal; pieces: number }[] = [];
  let remaining = quantity.net;
  let piecesLeft = quantity.pieces;
  for (const balance of balances) {
    if (remaining.isZero()) break;
    const net = Decimal.min(remaining, dec(balance.availableNet));
    const pieces = Math.min(piecesLeft, Math.max(balance.pieces, 0));
    takes.push({ lotId: balance.lotId ?? undefined, net, pieces });
    remaining = remaining.minus(net);
    piecesLeft -= pieces;
  }
  if (remaining.greaterThan(0)) {
    if (!options.allowNegative) throw insufficient();
    takes.push({ net: remaining, pieces: 0 });
  }
  const last = takes[takes.length - 1];
  if (last) last.pieces += piecesLeft;

  let cost = new Decimal(0);
  let grossLeft = quantity.gross;
  let fineLeft = quantity.fine;
  const allocations: LotAllocation[] = [];
  for (const [index, take] of takes.entries()) {
    const isLast = index === takes.length - 1;
    const share = quantity.net.isZero() ? new Decimal(1) : take.net.dividedBy(quantity.net);
    const gross = isLast ? grossLeft : quantity.gross.times(share).toDecimalPlaces(3);
    const fine = isLast ? fineLeft : quantity.fine.times(share).toDecimalPlaces(4);
    grossLeft = grossLeft.minus(gross);
    fineLeft = fineLeft.minus(fine);
    const lineCost = await stockOut(
      ctx,
      { ...key, lotId: take.lotId },
      { pieces: take.pieces, gross, net: take.net, fine },
      { ...source, lineId: `${source.lineId}.${index}` },
      options,
    );
    cost = cost.plus(lineCost);
    allocations.push({
      ...(take.lotId ? { lotId: take.lotId.toString() } : {}),
      pieces: take.pieces,
      gross: gross.toFixed(),
      net: take.net.toFixed(),
      fine: fine.toFixed(),
      cost: lineCost.toFixed(),
    });
  }
  return { cost, allocations };
}

export async function loadStockItem(ctx: RequestContext, id: Id) {
  const item = await StockItemModel.findOne({ companyId: ctx.companyId, _id: id })
    .session(ctx.session ?? null)
    .lean();
  if (!item) throw new NotFoundError('The stock item was not found.');
  return item;
}

export const quantityOfItem = (item: Awaited<ReturnType<typeof loadStockItem>>): Quantity => ({
  pieces: 1,
  gross: dec(item.gross),
  net: dec(item.net),
  fine: dec(item.fine),
});
