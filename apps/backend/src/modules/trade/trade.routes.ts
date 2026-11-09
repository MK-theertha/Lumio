import type { Permission } from '@lumio/shared-types';
import {
  objectIdSchema,
  offsetPageQuerySchema,
  tradeDocumentSchema,
  tradeReturnSchema,
} from '@lumio/validation';
import { Router, type Request } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { requirePermission } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { sendSuccess } from '../../shared/http.js';
import { idempotencyKeyOf } from '../../shared/idempotent-route.js';
import { plain } from '../../shared/serialize.js';
import { executeIdempotent } from '../platform/idempotency/index.js';
import type { Direction, TradeInput } from './pricing.service.js';
import {
  createDraft,
  decideDocument,
  getDocument,
  postDocument,
  quoteTrade,
  returnLines,
  submitDraft,
  updateDraft,
  voidDraft,
} from './trade.service.js';
import { CreditNoteModel, PurchaseInvoiceModel, SalesInvoiceModel } from './trade.models.js';

const idParams = validate({ params: z.object({ id: objectIdSchema }) });

/** Cost and margin are visible only with the matching permission. */
function maskCost(row: Record<string, unknown>, req: Request) {
  if (req.ctx.permissions.has('financials:view_cost')) return row;
  const lines = row.lines as Record<string, unknown>[] | undefined;
  return {
    ...row,
    lines: lines?.map(({ costAtIssue: _cost, ...line }) => {
      const snapshot = line.snapshot as Record<string, unknown> | undefined;
      return snapshot ? { ...line } : line;
    }),
  };
}

export function createTradeRouter(direction: Direction): Router {
  const router = Router();
  const resource = direction === 'SALE' ? 'sale' : 'purchase';
  const allow = (action: string) => requirePermission(`${resource}:${action}` as Permission);
  const model = direction === 'SALE' ? SalesInvoiceModel : PurchaseInvoiceModel;
  const id = (req: Request) => String(req.params.id);

  router.get('/', allow('read'), async (req, res) => {
    const { page, limit } = offsetPageQuerySchema.parse({
      page: req.query.page,
      limit: req.query.limit,
    });
    const filter: Record<string, unknown> = { companyId: req.ctx.companyId };
    for (const key of ['status', 'partyId', 'branchId']) {
      if (typeof req.query[key] === 'string' && req.query[key]) filter[key] = req.query[key];
    }
    if (req.ctx.branchScope !== 'ALL' && !filter.branchId) {
      filter.branchId = mongoose.trusted({ $in: req.ctx.branchScope });
    }
    const [rows, total] = await Promise.all([
      model
        .find(filter)
        .select({ 'lines.snapshot': 0, 'lines.input': 0 })
        .sort({ docDate: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      model.countDocuments(filter),
    ]);
    res.json({
      data: rows.map((row) => maskCost(plain(row), req)),
      meta: { correlationId: req.correlationId, page: { page, limit, total } },
    });
  });

  router.post(
    '/quote',
    allow('read'),
    validate({ body: tradeDocumentSchema }),
    async (req, res) => {
      sendSuccess(req, res, await quoteTrade(req.ctx, direction, req.validated.body as TradeInput));
    },
  );

  router.get('/:id', allow('read'), idParams, async (req, res) => {
    const doc = await getDocument(req.ctx, direction, id(req));
    sendSuccess(req, res, maskCost(doc as Record<string, unknown>, req));
  });

  router.post('/', allow('create'), validate({ body: tradeDocumentSchema }), async (req, res) => {
    sendSuccess(
      req,
      res,
      await createDraft(req.ctx, direction, req.validated.body as TradeInput),
      201,
    );
  });

  router.put(
    '/:id',
    allow('update'),
    validate({ params: z.object({ id: objectIdSchema }), body: tradeDocumentSchema }),
    async (req, res) => {
      const body = req.validated.body as TradeInput;
      sendSuccess(req, res, await updateDraft(req.ctx, direction, id(req), body));
    },
  );

  router.post('/:id/submit', allow('update'), idParams, async (req, res) => {
    sendSuccess(req, res, await submitDraft(req.ctx, direction, id(req)));
  });
  router.post('/:id/approve', allow('approve'), idParams, async (req, res) => {
    sendSuccess(req, res, await decideDocument(req.ctx, direction, id(req), true));
  });
  router.post('/:id/reject', allow('reject'), idParams, async (req, res) => {
    sendSuccess(req, res, await decideDocument(req.ctx, direction, id(req), false));
  });
  router.post('/:id/void', allow('update'), idParams, async (req, res) => {
    sendSuccess(req, res, await voidDraft(req.ctx, direction, id(req)));
  });

  router.post('/:id/post', allow('post'), idParams, async (req, res) => {
    const outcome = await executeIdempotent(
      req.ctx,
      idempotencyKeyOf(req),
      { op: 'post', direction, id: id(req) },
      (tx) => postDocument(tx, direction, id(req)),
    );
    sendSuccess(req, res, outcome.result);
  });

  router.post(
    '/:id/returns',
    allow('reverse'),
    validate({ params: z.object({ id: objectIdSchema }), body: tradeReturnSchema }),
    async (req, res) => {
      const body = req.validated.body as z.infer<typeof tradeReturnSchema>;
      const outcome = await executeIdempotent(
        req.ctx,
        idempotencyKeyOf(req),
        { op: 'return', direction, id: id(req), body },
        (tx) => returnLines(tx, direction, id(req), body),
      );
      sendSuccess(req, res, outcome.result, 201);
    },
  );

  router.get('/:id/credit-notes', allow('read'), idParams, async (req, res) => {
    const rows = await CreditNoteModel.find({
      companyId: req.ctx.companyId,
      originalId: id(req),
    }).lean();
    sendSuccess(req, res, plain(rows));
  });

  return router;
}
