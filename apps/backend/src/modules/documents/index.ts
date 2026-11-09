import { createHash } from 'node:crypto';
import type { Permission } from '@lumio/shared-types';
import {
  documentListQuerySchema,
  documentUploadQuerySchema,
  objectIdSchema,
} from '@lumio/validation';
import express, { Router, type Request } from 'express';
import mongoose, { Types } from 'mongoose';
import { z } from 'zod';
import { runtime } from '../../config/runtime.js';
import { runInTransaction } from '../../database/transaction.js';
import { OID, ROID, RS, tenantModel, tenantSchema } from '../../database/tenant-schema.js';
import { requirePermission } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { assertBranchAccess, type RequestContext } from '../../shared/context.js';
import { AppError, BusinessRuleError, ConflictError, NotFoundError } from '../../shared/errors.js';
import { sendSuccess } from '../../shared/http.js';
import { plain } from '../../shared/serialize.js';
import { KycRecordModel } from '../compliance/index.js';
import { PaymentModel } from '../finance/index.js';
import { PartyModel } from '../master/index.js';
import { recordAudit } from '../platform/audit/index.js';
import { enqueueEvent } from '../platform/outbox/index.js';
import { PurchaseInvoiceModel, SalesInvoiceModel } from '../trade/index.js';
import {
  clamavScanner,
  createObjectStore,
  type MalwareScanner,
  type ObjectStore,
} from './storage.js';

export { clamavScanner, createObjectStore } from './storage.js';
export type { MalwareScanner, ObjectStore, ScanResult } from './storage.js';

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const DOCUMENT_UPLOADED_EVENT = 'document.uploaded';

const SCAN_STATUSES = ['PENDING', 'CLEAN', 'INFECTED', 'SCAN_SKIPPED'] as const;

const documentSchema = tenantSchema(
  'documents',
  {
    ownerType: RS,
    ownerId: ROID,
    branchId: OID,
    category: RS,
    fileName: RS,
    mime: RS,
    size: { type: Number, required: true },
    sha256: RS,
    storageKey: RS,
    scanStatus: { type: String, enum: SCAN_STATUSES, required: true },
    scanSignature: String,
    scannedAt: Date,
    expiresAt: Date,
    version: { type: Number, required: true },
    previousVersionId: OID,
    uploadedBy: RS,
    archivedAt: Date,
  },
  { timestamps: true },
);
documentSchema.index({ companyId: 1, ownerType: 1, ownerId: 1, _id: -1 });
documentSchema.index({ companyId: 1, expiresAt: 1 });
export const DocumentModel = tenantModel('Document', documentSchema);

type UploadQuery = z.infer<typeof documentUploadQuerySchema>;

/** Decides the type from the file's own bytes: the client's Content-Type is not evidence. */
export function detectFileType(data: Buffer): string | null {
  if (data.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  return null;
}

/** Strips paths and control characters; the name is only ever echoed back as a download name. */
function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'document';
  // eslint-disable-next-line no-control-regex -- removing control characters is the purpose
  return base.replace(/[\u0000-\u001f\u007f"]/g, '').trim() || 'document';
}

const OWNER_MODELS = {
  PARTY: PartyModel,
  KYC: KycRecordModel,
  SALE: SalesInvoiceModel,
  PURCHASE: PurchaseInvoiceModel,
  PAYMENT: PaymentModel,
} as const;

/** The owner must exist in this company and be within the caller's branches. */
async function resolveOwner(
  ctx: RequestContext,
  ownerType: UploadQuery['ownerType'],
  ownerId: string,
): Promise<{ branchId?: Types.ObjectId }> {
  const owner = (await OWNER_MODELS[ownerType]
    .findOne({ companyId: ctx.companyId, _id: ownerId })
    .select({ branchId: 1 })
    .lean()) as { branchId?: Types.ObjectId } | null;
  if (!owner) throw new NotFoundError('The record this document belongs to was not found.');
  if (owner.branchId) assertBranchAccess(ctx, owner.branchId);
  return owner.branchId ? { branchId: owner.branchId } : {};
}

function assertKycAccess(ctx: RequestContext, ownerType: string): void {
  // Identity documents get the KYC permission as well as the general document one.
  if (ownerType === 'KYC' && !ctx.permissions.has('kyc:read' satisfies Permission)) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to do this.');
  }
}

export async function uploadDocument(
  ctx: RequestContext,
  input: UploadQuery,
  data: Buffer,
  store: ObjectStore,
  scanner: MalwareScanner | null,
) {
  assertKycAccess(ctx, input.ownerType);
  const owner = await resolveOwner(ctx, input.ownerType, input.ownerId);
  const mime = detectFileType(data);
  if (!mime) throw new BusinessRuleError('Only PDF, PNG and JPEG files can be uploaded.');

  const id = new Types.ObjectId();
  const storageKey = `${ctx.companyId.toString()}/${id.toString()}`;
  // Stored first: a failure after this leaves an unreferenced object, never a record without a file.
  await store.put(storageKey, data, mime);

  return runInTransaction(ctx, async (tx) => {
    let version = 1;
    if (input.replaces) {
      const previous = await DocumentModel.findOneAndUpdate(
        {
          companyId: tx.companyId,
          _id: input.replaces,
          ownerType: input.ownerType,
          ownerId: input.ownerId,
          archivedAt: null,
        },
        { $set: { archivedAt: new Date() } },
        { session: tx.session },
      ).lean();
      if (!previous) throw new ConflictError('The document being replaced is no longer current.');
      version = previous.version + 1;
    }
    const [created] = await DocumentModel.create(
      [
        {
          _id: id,
          companyId: tx.companyId,
          ownerType: input.ownerType,
          ownerId: input.ownerId,
          ...owner,
          category: input.category,
          fileName: safeFileName(input.fileName),
          mime,
          size: data.length,
          sha256: createHash('sha256').update(data).digest('hex'),
          storageKey,
          scanStatus: scanner ? 'PENDING' : 'SCAN_SKIPPED',
          ...(input.expiresAt ? { expiresAt: new Date(input.expiresAt) } : {}),
          version,
          ...(input.replaces ? { previousVersionId: input.replaces } : {}),
          uploadedBy: tx.userId,
        },
      ],
      { session: tx.session },
    );
    await recordAudit(tx, {
      action: 'document.upload',
      entityType: 'document',
      entityId: id.toString(),
      after: { ownerType: input.ownerType, ownerId: input.ownerId, category: input.category },
    });
    if (scanner) await enqueueEvent(tx, DOCUMENT_UPLOADED_EVENT, { id: id.toString() });
    return created?.toObject();
  });
}

/** Runs in the worker. Idempotent, and a scanner failure leaves the file undownloadable. */
export async function scanDocument(
  companyId: string,
  id: string,
  store: ObjectStore,
  scanner: MalwareScanner,
): Promise<void> {
  const scope = { companyId: new Types.ObjectId(companyId), _id: id };
  const document = await DocumentModel.findOne(scope).lean();
  if (!document || document.scanStatus !== 'PENDING') return;
  const result = await scanner.scan(await store.get(document.storageKey));
  if (!result.clean) await store.delete(document.storageKey);
  await DocumentModel.updateOne(scope, {
    $set: {
      scanStatus: result.clean ? 'CLEAN' : 'INFECTED',
      scannedAt: new Date(),
      ...(result.signature ? { scanSignature: result.signature } : {}),
    },
  });
}

export function configuredScanner(): MalwareScanner | null {
  const { CLAMAV_HOST, CLAMAV_PORT } = runtime();
  return CLAMAV_HOST ? clamavScanner(CLAMAV_HOST, CLAMAV_PORT) : null;
}

const idParams = validate({ params: z.object({ id: objectIdSchema }) });

function asciiName(name: string): string {
  return name.replace(/[^\x20-\x7e]/g, '_');
}

export function createDocumentRouter(
  dependencies: {
    store?: ObjectStore;
    scanner?: MalwareScanner | null;
  } = {},
): Router {
  const router = Router();
  const store = () => (dependencies.store ??= createObjectStore(runtime()));
  const scanner = () =>
    dependencies.scanner === undefined ? configuredScanner() : dependencies.scanner;

  const load = async (req: Request) => {
    const document = await DocumentModel.findOne({
      companyId: req.ctx.companyId,
      _id: req.params.id,
    }).lean();
    if (!document) throw new NotFoundError();
    if (document.branchId) assertBranchAccess(req.ctx, document.branchId);
    assertKycAccess(req.ctx, document.ownerType);
    return document;
  };

  router.get(
    '/',
    requirePermission('document:read'),
    validate({ query: documentListQuerySchema }),
    async (req, res) => {
      const query = req.validated.query as z.infer<typeof documentListQuerySchema>;
      const filter: Record<string, unknown> = { companyId: req.ctx.companyId, archivedAt: null };
      if (query.ownerType) filter.ownerType = query.ownerType;
      if (query.ownerId) filter.ownerId = query.ownerId;
      if (query.expiringWithinDays !== undefined) {
        filter.expiresAt = mongoose.trusted({
          $lte: new Date(Date.now() + query.expiringWithinDays * 86_400_000),
        });
      }
      if (req.ctx.branchScope !== 'ALL') {
        filter.branchId = mongoose.trusted({ $in: [...req.ctx.branchScope, null] });
      }
      if (!req.ctx.permissions.has('kyc:read')) {
        if (query.ownerType === 'KYC') assertKycAccess(req.ctx, 'KYC');
        filter.ownerType ??= mongoose.trusted({ $ne: 'KYC' });
      }
      const [rows, total] = await Promise.all([
        DocumentModel.find(filter)
          .select({ storageKey: 0 })
          .sort({ _id: -1 })
          .skip((query.page - 1) * query.limit)
          .limit(query.limit)
          .lean(),
        DocumentModel.countDocuments(filter),
      ]);
      res.json({
        data: plain(rows),
        meta: {
          correlationId: req.correlationId,
          page: { page: query.page, limit: query.limit, total },
        },
      });
    },
  );

  router.post(
    '/',
    requirePermission('document:create'),
    validate({ query: documentUploadQuerySchema }),
    express.raw({ type: () => true, limit: MAX_DOCUMENT_BYTES }),
    async (req, res) => {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        throw new BusinessRuleError('The file is empty.');
      }
      const created = await uploadDocument(
        req.ctx,
        req.validated.query as UploadQuery,
        req.body,
        store(),
        scanner(),
      );
      const visible = plain<Record<string, unknown>>(created);
      delete visible.storageKey;
      sendSuccess(req, res, visible, 201);
    },
  );

  router.get('/:id/content', requirePermission('document:read'), idParams, async (req, res) => {
    const document = await load(req);
    if (document.archivedAt) throw new NotFoundError();
    if (document.scanStatus !== 'CLEAN' && document.scanStatus !== 'SCAN_SKIPPED') {
      throw new ConflictError(
        document.scanStatus === 'INFECTED'
          ? 'This file failed the malware scan and cannot be downloaded.'
          : 'This file is still being scanned.',
      );
    }
    const data = await store().get(document.storageKey);
    await recordAudit(req.ctx, {
      action: 'document.download',
      entityType: 'document',
      entityId: String(req.params.id),
    });
    const encoded = encodeURIComponent(document.fileName);
    res
      .status(200)
      .set({
        'Content-Type': document.mime,
        'Content-Disposition': `attachment; filename="${asciiName(document.fileName)}"; filename*=UTF-8''${encoded}`,
        'Cache-Control': 'no-store',
      })
      .send(data);
  });

  // Archives only: identity and transaction records have retention duties still to be confirmed.
  router.delete('/:id', requirePermission('document:delete'), idParams, async (req, res) => {
    await load(req);
    await DocumentModel.updateOne(
      { companyId: req.ctx.companyId, _id: req.params.id },
      { $set: { archivedAt: new Date() } },
    );
    await recordAudit(req.ctx, {
      action: 'document.archive',
      entityType: 'document',
      entityId: String(req.params.id),
    });
    res.status(204).end();
  });

  return router;
}
