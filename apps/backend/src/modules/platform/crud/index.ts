import type { Permission } from '@lumio/shared-types';
import { offsetPageQuerySchema, objectIdSchema } from '@lumio/validation';
import { Router, type Request } from 'express';
import mongoose, { type Model } from 'mongoose';
import { z } from 'zod';
import { requirePermission } from '../../../middleware/auth.js';
import { validate } from '../../../middleware/validate.js';
import { assertBranchAccess } from '../../../shared/context.js';
import { ConflictError, NotFoundError } from '../../../shared/errors.js';
import { sendSuccess } from '../../../shared/http.js';
import { plain } from '../../../shared/serialize.js';
import { recordAudit } from '../audit/index.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the factory is generic over any tenant model
export type AnyModel = Model<any>;

export interface CrudOptions {
  model: AnyModel;
  permission: string;
  entityType: string;
  create: z.ZodType;
  update: z.ZodType;
  searchFields?: string[];
  sortable?: string[];
  filters?: string[];
  /** Field holding a branch id, enforcing branch scope on read and write. */
  branchField?: string;
  /** Prepares a validated body for storage, e.g. to encrypt or derive fields. */
  prepare?: (body: Record<string, unknown>) => Record<string, unknown>;
  /** Hides or changes fields before returning a record. */
  present?: (row: Record<string, unknown>, req: Request) => Record<string, unknown>;
  /** Follow-up work on a saved record. Its failure is logged and does not fail the request. */
  afterSave?: (id: string, req: Request) => Promise<unknown>;
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const idParams = z.object({ id: objectIdSchema });

export function buildListFilter(req: Request, options: CrudOptions): Record<string, unknown> {
  const filter: Record<string, unknown> = { companyId: req.ctx.companyId };
  const q = req.query.q;
  if (typeof q === 'string' && q && options.searchFields?.length) {
    const prefix = mongoose.trusted({ $regex: `^${escapeRegex(q)}`, $options: 'i' });
    filter.$or = options.searchFields.map((field) => ({ [field]: prefix }));
  }
  for (const field of options.filters ?? []) {
    const value = req.query[field];
    if (typeof value === 'string' && value) filter[field] = value;
  }
  if (req.query.includeArchived !== 'true') filter.archivedAt = null;
  if (options.branchField && req.ctx.branchScope !== 'ALL') {
    filter[options.branchField] = mongoose.trusted({ $in: req.ctx.branchScope });
  }
  return filter;
}

function duplicateAsConflict(error: unknown): never {
  if (error instanceof mongoose.mongo.MongoServerError && error.code === 11000) {
    throw new ConflictError('A record with this code already exists.');
  }
  throw error;
}

/** REST endpoints for a tenant-owned master record: list, read, create, update, archive. */
export function crudRouter(options: CrudOptions): Router {
  const router = Router();
  const { model, entityType } = options;
  const allow = (action: string) =>
    requirePermission(`${options.permission}:${action}` as Permission);
  const present = (row: unknown, req: Request) => {
    const output = plain<Record<string, unknown>>(row);
    return options.present ? options.present(output, req) : output;
  };

  const runAfterSave = async (id: string, req: Request) => {
    await options.afterSave?.(id, req).catch((error: unknown) => {
      req.log.error({ err: error, entityType }, 'After-save step failed');
    });
  };

  const findScoped = async (req: Request) => {
    const row = (await model
      .findOne({ companyId: req.ctx.companyId, _id: req.params.id })
      .lean()) as Record<string, unknown> | null;
    if (!row) throw new NotFoundError();
    if (options.branchField && row[options.branchField]) {
      assertBranchAccess(req.ctx, row[options.branchField] as string);
    }
    return row;
  };

  router.get('/', allow('read'), async (req, res) => {
    const { page, limit, sort } = offsetPageQuerySchema.parse({
      page: req.query.page,
      limit: req.query.limit,
      sort: req.query.sort,
    });
    const key = sort?.replace(/^-/, '');
    if (key && !options.sortable?.includes(key)) {
      throw new ConflictError(`Sorting by ${key} is not supported.`);
    }
    const filter = buildListFilter(req, options);
    const [rows, total] = await Promise.all([
      model
        .find(filter)
        .sort(key ? { [key]: sort?.startsWith('-') ? -1 : 1 } : { _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      model.countDocuments(filter),
    ]);
    res.json({
      data: rows.map((row) => present(row, req)),
      meta: { correlationId: req.correlationId, page: { page, limit, total } },
    });
  });

  router.get('/:id', allow('read'), validate({ params: idParams }), async (req, res) => {
    sendSuccess(req, res, present(await findScoped(req), req));
  });

  router.post('/', allow('create'), validate({ body: options.create }), async (req, res) => {
    const body = req.validated.body as Record<string, unknown>;
    if (options.branchField && body[options.branchField]) {
      assertBranchAccess(req.ctx, body[options.branchField] as string);
    }
    const values = options.prepare ? options.prepare(body) : body;
    const created = await model
      .create({ ...values, companyId: req.ctx.companyId })
      .catch(duplicateAsConflict);
    await recordAudit(req.ctx, {
      action: `${entityType}.create`,
      entityType,
      entityId: String(created._id),
      after: plain(body),
    });
    await runAfterSave(String(created._id), req);
    sendSuccess(req, res, present(created.toObject(), req), 201);
  });

  router.patch(
    '/:id',
    allow('update'),
    validate({ params: idParams, body: options.update }),
    async (req, res) => {
      const before = await findScoped(req);
      const body = req.validated.body as Record<string, unknown>;
      const values = options.prepare ? options.prepare(body) : body;
      const updated = await model
        .findOneAndUpdate(
          { companyId: req.ctx.companyId, _id: req.params.id },
          { $set: values },
          { returnDocument: 'after', runValidators: true },
        )
        .lean()
        .catch(duplicateAsConflict);
      await recordAudit(req.ctx, {
        action: `${entityType}.update`,
        entityType,
        entityId: String(req.params.id),
        before: plain(before),
        after: plain(body),
      });
      await runAfterSave(String(req.params.id), req);
      sendSuccess(req, res, present(updated, req));
    },
  );

  router.delete('/:id', allow('delete'), validate({ params: idParams }), async (req, res) => {
    await findScoped(req);
    await model.updateOne(
      { companyId: req.ctx.companyId, _id: req.params.id },
      { $set: { archivedAt: new Date() } },
    );
    await recordAudit(req.ctx, {
      action: `${entityType}.archive`,
      entityType,
      entityId: String(req.params.id),
    });
    res.status(204).end();
  });

  return router;
}
