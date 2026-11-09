import { createHash } from 'node:crypto';
import { canonicalJson } from '@lumio/shared-utils';
import mongoose, { type Types } from 'mongoose';
import { ROID, RS, tenantModel, tenantSchema } from '../../database/tenant-schema.js';
import { plain } from '../../shared/serialize.js';
import type { ObjectStore } from '../documents/index.js';
import { AuditLogModel } from '../platform/audit/index.js';

/** Rows younger than this may belong to a transaction that has not committed yet. */
const SETTLE_MS = 10 * 60 * 1000;
const BATCH = 5000;
const GENESIS = '0'.repeat(64);

const auditSealSchema = tenantSchema(
  'auditSeals',
  {
    sequence: { type: Number, required: true },
    firstRowId: ROID,
    lastRowId: ROID,
    rowCount: { type: Number, required: true },
    previousHash: RS,
    hash: RS,
    exportKey: RS,
    sealedAt: { type: Date, required: true },
  },
  { appendOnly: true },
);
auditSealSchema.index({ companyId: 1, sequence: 1 }, { unique: true });
export const AuditSealModel = tenantModel('AuditSeal', auditSealSchema);

function chain(previous: string, rows: unknown[]): string {
  return rows.reduce<string>(
    (hash, row) =>
      createHash('sha256')
        .update(hash + canonicalJson(plain(row)))
        .digest('hex'),
    previous,
  );
}

interface SealRow {
  sequence: number;
  firstRowId: Types.ObjectId;
  lastRowId: Types.ObjectId;
  rowCount: number;
  previousHash: string;
  hash: string;
  exportKey: string;
}

const sealKey = (companyId: Types.ObjectId, sequence: number) =>
  `audit-seals/${companyId.toString()}/${String(sequence).padStart(8, '0')}.json`;

/** Chains settled audit rows into hashed batches and copies each seal outside the database. */
export async function sealAuditLog(companyId: Types.ObjectId, store: ObjectStore): Promise<number> {
  let sealed = 0;
  for (;;) {
    const last = (await AuditSealModel.findOne({ companyId })
      .sort({ sequence: -1 })
      .lean()) as SealRow | null;
    const rows = await AuditLogModel.find({
      companyId,
      at: mongoose.trusted({ $lte: new Date(Date.now() - SETTLE_MS) }),
      ...(last ? { _id: mongoose.trusted({ $gt: last.lastRowId }) } : {}),
    })
      .sort({ _id: 1 })
      .limit(BATCH)
      .lean();
    if (rows.length === 0) return sealed;
    const previousHash = last?.hash ?? GENESIS;
    const sequence = (last?.sequence ?? 0) + 1;
    const hash = chain(previousHash, rows);
    const exportKey = sealKey(companyId, sequence);
    const seal = {
      companyId,
      sequence,
      firstRowId: (rows[0] as { _id: Types.ObjectId })._id,
      lastRowId: (rows.at(-1) as { _id: Types.ObjectId })._id,
      rowCount: rows.length,
      previousHash,
      hash,
      exportKey,
      sealedAt: new Date(),
    };
    await store.put(exportKey, Buffer.from(JSON.stringify(seal)), 'application/json');
    await AuditSealModel.create(seal);
    sealed += rows.length;
  }
}

/** Recomputes each batch. A changed, removed or inserted audit row breaks its seal. */
export async function verifyAuditSeals(
  companyId: Types.ObjectId,
  store?: ObjectStore,
): Promise<string[]> {
  const problems: string[] = [];
  let previous = GENESIS;
  const seals = (await AuditSealModel.find({ companyId })
    .sort({ sequence: 1 })
    .lean()) as SealRow[];
  for (const seal of seals) {
    const rows = await AuditLogModel.find({
      companyId,
      _id: mongoose.trusted({ $gte: seal.firstRowId, $lte: seal.lastRowId }),
    })
      .sort({ _id: 1 })
      .lean();
    if (seal.previousHash !== previous) problems.push(`Seal ${seal.sequence} is out of sequence.`);
    if (rows.length !== seal.rowCount || chain(seal.previousHash, rows) !== seal.hash) {
      problems.push(`Audit rows in seal ${seal.sequence} have changed.`);
    }
    if (store) {
      const exported = JSON.parse((await store.get(seal.exportKey)).toString()) as { hash: string };
      if (exported.hash !== seal.hash) {
        problems.push(`Seal ${seal.sequence} differs from its exported copy.`);
      }
    }
    previous = seal.hash;
  }
  return problems;
}
