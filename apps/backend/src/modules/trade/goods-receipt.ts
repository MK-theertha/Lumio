import { goodsReceiptSchema, objectIdSchema } from '@lumio/validation';
import { Router } from 'express';
import mongoose, { Types } from 'mongoose';
import type { z } from 'zod';
import { runInTransaction } from '../../database/transaction.js';
import { requirePermission } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { assertBranchAccess, type RequestContext } from '../../shared/context.js';
import { d128, dec, Decimal } from '../../shared/decimal.js';
import { BusinessRuleError, NotFoundError } from '../../shared/errors.js';
import { sendSuccess } from '../../shared/http.js';
import { plain } from '../../shared/serialize.js';
import { assertPartyNotOnHold } from '../compliance/index.js';
import { receiveInto } from '../inventory/index.js';
import { postJournal } from '../ledger/index.js';
import { PartyModel } from '../master/index.js';
import { recordAudit } from '../platform/audit/index.js';
import { allocateNumber } from '../platform/numbering/index.js';
import { GoodsReceiptModel, PurchaseOrderModel } from './trade.models.js';

type Input = z.infer<typeof goodsReceiptSchema>;

interface OrderLine {
  productId: string;
  expectedWeight: string;
  receivedWeight?: string;
}

/** Records goods arriving before the supplier's invoice, accruing what is owed for them. */
export function createGoodsReceipt(ctx: RequestContext, input: Input) {
  assertBranchAccess(ctx, input.branchId);
  return runInTransaction(ctx, async (tx) => {
    const party = await PartyModel.findOne({ companyId: tx.companyId, _id: input.partyId })
      .session(tx.session)
      .lean();
    if (!party?.roles.includes('SUPPLIER')) throw new NotFoundError('The supplier was not found.');
    await assertPartyNotOnHold(tx, party._id);

    const id = new Types.ObjectId();
    const date = new Date(input.receiptDate);
    const number = await allocateNumber(tx, {
      documentType: 'GRN',
      scope: 'COMPANY',
      prefix: 'GRN-',
      padding: 6,
    });
    const lines = [];
    let total = new Decimal(0);
    for (const [index, line] of input.lines.entries()) {
      const cost = dec(line.cost);
      const received = await receiveInto(tx, {
        warehouseId: line.warehouseId,
        location: line.location,
        productId: line.productId,
        pieces: line.pieces,
        grossWeight: line.grossWeight,
        stoneWeight: line.stoneWeight,
        cost,
        ...(line.tag ? { tag: line.tag } : {}),
        sourceType: 'GOODS_RECEIPT',
        sourceId: id.toString(),
        lineId: String(index + 1),
        type: 'PURCHASE',
      });
      total = total.plus(cost);
      const variance = line.expectedWeight
        ? dec(line.grossWeight).minus(dec(line.expectedWeight))
        : undefined;
      lines.push({
        productId: line.productId,
        warehouseId: line.warehouseId,
        location: line.location,
        pieces: line.pieces,
        grossWeight: d128(line.grossWeight),
        ...(line.expectedWeight ? { expectedWeight: d128(line.expectedWeight) } : {}),
        ...(variance ? { varianceWeight: d128(variance) } : {}),
        cost: d128(cost),
        ...(received.lotId ? { lotId: received.lotId } : {}),
        ...(received.stockItemId ? { stockItemId: received.stockItemId } : {}),
      });
    }
    const journal = await postJournal(tx, {
      postingDate: date,
      branchId: input.branchId,
      memo: `Goods receipt ${number}`,
      sourceType: 'GOODS_RECEIPT',
      sourceId: id.toString(),
      kind: 'POSTING',
      lines: [
        { role: 'INVENTORY', debit: total },
        { role: 'GRNI', credit: total },
      ],
    });
    if (input.purchaseOrderId) await applyToOrder(tx, input);
    const [created] = await GoodsReceiptModel.create(
      [
        {
          _id: id,
          companyId: tx.companyId,
          number,
          partyId: input.partyId,
          branchId: input.branchId,
          receiptDate: date,
          ...(input.purchaseOrderId ? { purchaseOrderId: input.purchaseOrderId } : {}),
          status: 'RECEIVED',
          lines,
          total: d128(total),
          journalEntryId: journal.entryId,
          createdBy: tx.userId,
        },
      ],
      { session: tx.session },
    );
    await recordAudit(tx, {
      action: 'goods_receipt.post',
      entityType: 'goods_receipt',
      entityId: id.toString(),
      after: { number, total: total.toFixed() },
    });
    return created?.toObject();
  });
}

/** Adds what arrived to the order. It stays open until every line has been fully received. */
async function applyToOrder(
  tx: RequestContext & { session: mongoose.ClientSession },
  input: Input,
) {
  const order = await PurchaseOrderModel.findOne({
    companyId: tx.companyId,
    _id: input.purchaseOrderId,
    partyId: input.partyId,
    status: 'OPEN',
  })
    .session(tx.session)
    .lean();
  if (!order) throw new BusinessRuleError('The purchase order is not open for this supplier.');
  const lines = (order.lines as OrderLine[]).map((line) => {
    const arrived = input.lines
      .filter((l) => l.productId === String(line.productId))
      .reduce((sum, l) => sum.plus(dec(l.grossWeight)), dec(line.receivedWeight));
    return { ...line, receivedWeight: arrived.toFixed() };
  });
  const complete = lines.every((l) => dec(l.receivedWeight).gte(dec(l.expectedWeight)));
  await PurchaseOrderModel.updateOne(
    { companyId: tx.companyId, _id: order._id },
    { $set: { lines, status: complete ? 'CLOSED' : 'OPEN' } },
  ).session(tx.session);
}

export function createGoodsReceiptRouter(): Router {
  const router = Router();
  router.get('/', requirePermission('purchase:read'), async (req, res) => {
    const filter: Record<string, unknown> = { companyId: req.ctx.companyId };
    if (req.ctx.branchScope !== 'ALL') {
      filter.branchId = mongoose.trusted({ $in: req.ctx.branchScope });
    }
    if (typeof req.query.status === 'string' && req.query.status) filter.status = req.query.status;
    if (typeof req.query.partyId === 'string' && req.query.partyId) {
      filter.partyId = objectIdSchema.parse(req.query.partyId);
    }
    const rows = await GoodsReceiptModel.find(filter).sort({ _id: -1 }).limit(200).lean();
    sendSuccess(req, res, plain(rows));
  });
  router.post(
    '/',
    requirePermission('purchase:create'),
    validate({ body: goodsReceiptSchema }),
    async (req, res) => {
      const created = await createGoodsReceipt(req.ctx, req.validated.body as Input);
      sendSuccess(req, res, plain(created), 201);
    },
  );
  return router;
}
