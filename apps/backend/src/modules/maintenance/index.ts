import { Router } from 'express';
import mongoose, { type Types } from 'mongoose';
import { runtime } from '../../config/runtime.js';
import { requirePermission } from '../../middleware/auth.js';
import type { RequestContext } from '../../shared/context.js';
import { dec } from '../../shared/decimal.js';
import { sendSuccess } from '../../shared/http.js';
import type { Logger } from '../../shared/logger.js';
import { plain } from '../../shared/serialize.js';
import { importSanctionsList, SanctionsListModel } from '../compliance/index.js';
import { createObjectStore, DocumentModel, type ObjectStore } from '../documents/index.js';
import { OpenItemModel } from '../finance/index.js';
import {
  releaseReservation,
  StockBalanceModel,
  StockReservationModel,
} from '../inventory/index.js';
import { ProductModel } from '../master/index.js';
import { notify } from '../notifications/index.js';
import { CompanyModel } from '../organisation/index.js';
import { sealAuditLog } from './audit-seal.js';
import { IntegrityRunModel, runIntegrityChecks } from './integrity.js';

export { AuditSealModel, sealAuditLog, verifyAuditSeals } from './audit-seal.js';
export { IntegrityRunModel, runIntegrityChecks } from './integrity.js';

export const NIGHTLY_EVENT = 'maintenance.nightly';
const UN_SOURCE = 'UN';
const REMIND_DAYS = 30;

const systemContext = (companyId: Types.ObjectId): RequestContext => ({
  companyId,
  userId: 'system',
  branchScope: 'ALL',
  permissions: new Set(),
  correlationId: `nightly-${Date.now()}`,
});

const today = () => new Date().toISOString().slice(0, 10);

export async function expireReservations(companyId: Types.ObjectId): Promise<number> {
  const due = await StockReservationModel.find({
    companyId,
    status: 'ACTIVE',
    expiresAt: mongoose.trusted({ $lte: new Date() }),
  })
    .select({ _id: 1 })
    .lean();
  for (const reservation of due) {
    await releaseReservation(systemContext(companyId), String(reservation._id));
  }
  return due.length;
}

export async function raiseDocumentReminders(companyId: Types.ObjectId): Promise<void> {
  const soon = new Date(Date.now() + REMIND_DAYS * 86_400_000);
  const rows = await DocumentModel.find({
    companyId,
    archivedAt: null,
    expiresAt: mongoose.trusted({ $lte: soon }),
  })
    .select({ fileName: 1, category: 1, expiresAt: 1, ownerType: 1 })
    .lean();
  for (const row of rows) {
    await notify(companyId, {
      key: `document-expiry:${String(row._id)}`,
      // Identity documents go only to people allowed to see them.
      audience: row.ownerType === 'KYC' ? 'kyc:read' : 'document:read',
      severity: 'WARNING',
      title: 'Document expiring',
      body: `${row.fileName} (${row.category}) expires on ${row.expiresAt.toISOString().slice(0, 10)}.`,
      link: '/documents',
    });
  }
}

export async function raiseStockAlerts(companyId: Types.ObjectId): Promise<void> {
  const products = await ProductModel.find({
    companyId,
    archivedAt: null,
    reorderLevelNet: mongoose.trusted({ $ne: null }),
  })
    .select({ reorderLevelNet: 1 })
    .lean();
  if (products.length === 0) return;
  const held = await StockBalanceModel.aggregate([
    { $match: { companyId } },
    { $group: { _id: '$productId', net: { $sum: '$availableNet' } } },
  ]);
  const onHand = new Map(
    held.map((h: { _id: Types.ObjectId; net: never }) => [h._id.toString(), dec(h.net)]),
  );
  const low = products.filter((p) =>
    (onHand.get(String(p._id)) ?? dec('0')).lessThan(dec(p.reorderLevelNet)),
  );
  if (low.length === 0) return;
  await notify(companyId, {
    key: `low-stock:${today()}`,
    audience: 'stock:read',
    severity: 'WARNING',
    title: 'Stock below reorder level',
    body: `${low.length} product(s) are below their reorder level.`,
    link: '/stock',
  });
}

export async function raisePaymentAlerts(companyId: Types.ObjectId): Promise<void> {
  const overdue = await OpenItemModel.find({
    companyId,
    status: 'OPEN',
    dueDate: mongoose.trusted({ $lt: new Date() }),
  })
    .select({ side: 1, outstanding: 1 })
    .lean();
  for (const side of ['RECEIVABLE', 'PAYABLE'] as const) {
    const items = overdue.filter((item) => item.side === side);
    if (items.length === 0) continue;
    const total = items.reduce((sum, item) => sum.plus(dec(item.outstanding)), dec('0'));
    await notify(companyId, {
      key: `overdue-${side}:${today()}`,
      audience: 'payment:read',
      severity: 'WARNING',
      title: side === 'RECEIVABLE' ? 'Overdue customer invoices' : 'Overdue supplier invoices',
      body: `${items.length} item(s) totalling ${total.toFixed(2)} are past due.`,
      link: '/payments',
    });
  }
}

/** Downloads the UN list once and updates each company that uses it, if the list has changed. */
export async function refreshUnSanctionsList(
  companies: Types.ObjectId[],
  url: string | undefined,
  logger: Logger,
  download: (target: string) => Promise<string> = async (target) => {
    const response = await fetch(target, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Download failed with status ${response.status}`);
    return response.text();
  },
): Promise<number> {
  if (!url) return 0;
  const content = await download(url);
  const version = /dateGenerated="([^"]+)"/.exec(content)?.[1];
  let updated = 0;
  for (const companyId of companies) {
    const latest = await SanctionsListModel.findOne({ companyId, source: UN_SOURCE })
      .sort({ importedAt: -1 })
      .lean();
    // A company starts using the list by importing it once, which records its compliance decision.
    if (!latest || latest.version === version) continue;
    await importSanctionsList(
      systemContext(companyId),
      { source: UN_SOURCE, format: 'UN_XML' },
      content,
    );
    updated += 1;
    logger.info({ companyId: companyId.toString(), version }, 'Sanctions list refreshed');
  }
  return updated;
}

/** One failure must not stop the other jobs, or the other companies. */
export async function runNightlyMaintenance(logger: Logger, store: ObjectStore): Promise<void> {
  const companies = (await CompanyModel.find({ status: 'ACTIVE' }).select({ _id: 1 }).lean()).map(
    (c) => c._id,
  );
  const attempt = async (
    name: string,
    companyId: Types.ObjectId | null,
    job: () => Promise<unknown>,
  ) => {
    try {
      await job();
    } catch (error) {
      logger.error(
        { err: error, job: name, companyId: companyId?.toString() },
        'Nightly job failed',
      );
    }
  };
  await attempt('sanctions', null, () =>
    refreshUnSanctionsList(companies, runtime().SANCTIONS_UN_URL, logger),
  );
  for (const companyId of companies) {
    await attempt('reservations', companyId, () => expireReservations(companyId));
    await attempt('documents', companyId, () => raiseDocumentReminders(companyId));
    await attempt('stock', companyId, () => raiseStockAlerts(companyId));
    await attempt('payments', companyId, () => raisePaymentAlerts(companyId));
    await attempt('seal', companyId, () => sealAuditLog(companyId, store));
    await attempt('integrity', companyId, async () => {
      const run = await runIntegrityChecks(companyId, store);
      if (run.status === 'FAILED') {
        logger.fatal(
          { companyId: companyId.toString(), findings: run.findings.length },
          'Integrity check failed',
        );
      }
    });
  }
}

export function createIntegrityRouter(): Router {
  const router = Router();
  router.get('/', requirePermission('audit:read'), async (req, res) => {
    const rows = await IntegrityRunModel.find({ companyId: req.ctx.companyId })
      .sort({ startedAt: -1 })
      .limit(50)
      .lean();
    sendSuccess(req, res, plain(rows));
  });
  router.post('/', requirePermission('settings:manage'), async (req, res) => {
    const run = await runIntegrityChecks(req.ctx.companyId, createObjectStore(runtime()));
    sendSuccess(req, res, plain(run), 201);
  });
  return router;
}
