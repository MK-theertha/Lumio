import {
  objectIdSchema,
  sanctionsDecisionSchema,
  sanctionsImportQuerySchema,
} from '@lumio/validation';
import express, { Router } from 'express';
import type { Types } from 'mongoose';
import mongoose from 'mongoose';
import { z } from 'zod';
import { ROID, RS, tenantModel, tenantSchema } from '../../database/tenant-schema.js';
import { runInTransaction } from '../../database/transaction.js';
import { requirePermission } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import type { RequestContext, TransactionalContext } from '../../shared/context.js';
import { BusinessRuleError, ConflictError, NotFoundError } from '../../shared/errors.js';
import { sendSuccess } from '../../shared/http.js';
import { plain } from '../../shared/serialize.js';
import { PartyModel } from '../master/index.js';
import { recordAudit } from '../platform/audit/index.js';
import { enqueueEvent } from '../platform/outbox/index.js';
import { nameSimilarity, normaliseName } from './name-match.js';
import { parseSanctionsCsv, parseUnConsolidatedXml } from './sanctions-list.js';

export const SANCTIONS_IMPORTED_EVENT = 'sanctions.list_imported';
/** Deliberately favours false alarms: a reviewer clears those, but nobody reviews a miss. */
export const MATCH_THRESHOLD = 0.88;
const MAX_LIST_BYTES = 20 * 1024 * 1024;

const listSchema = tenantSchema('sanctionsLists', {
  source: RS,
  version: RS,
  entryCount: { type: Number, required: true },
  importedBy: RS,
  importedAt: { type: Date, required: true },
});
listSchema.index({ companyId: 1, source: 1, importedAt: -1 });
export const SanctionsListModel = tenantModel('SanctionsList', listSchema);

const entrySchema = tenantSchema('sanctionsEntries', {
  source: RS,
  externalId: RS,
  name: RS,
  aliases: { type: [String], default: [] },
  searchNames: { type: [String], required: true },
  type: RS,
  dateOfBirth: String,
  nationality: String,
  program: String,
});
entrySchema.index({ companyId: 1, source: 1, externalId: 1 }, { unique: true });
export const SanctionsEntryModel = tenantModel('SanctionsEntry', entrySchema);

const matchSchema = tenantSchema(
  'sanctionsMatches',
  {
    partyId: ROID,
    // PARTY, or the name of the beneficial owner who matched.
    subject: { type: String, required: true, default: 'PARTY' },
    screenedName: RS,
    source: RS,
    externalId: RS,
    // A copy, so the evidence survives the entry being removed from a later list.
    listedName: RS,
    matchedName: RS,
    score: { type: Number, required: true },
    entryType: RS,
    dateOfBirth: String,
    nationality: String,
    program: String,
    status: { type: String, enum: ['OPEN', 'FALSE_POSITIVE', 'CONFIRMED'], required: true },
    decisionNote: String,
    decidedBy: String,
    decidedAt: Date,
  },
  { timestamps: true },
);
matchSchema.index(
  { companyId: 1, partyId: 1, source: 1, externalId: 1, subject: 1 },
  { unique: true },
);
matchSchema.index({ companyId: 1, status: 1, _id: -1 });
export const SanctionsMatchModel = tenantModel('SanctionsMatch', matchSchema);

interface Entry {
  source: string;
  externalId: string;
  name: string;
  aliases: string[];
  searchNames: string[];
  type: string;
  dateOfBirth?: string;
  nationality?: string;
  program?: string;
}

const loadEntries = (companyId: Types.ObjectId) =>
  SanctionsEntryModel.find({ companyId }).lean() as unknown as Promise<Entry[]>;

async function refreshStatus(companyId: Types.ObjectId, partyId: Types.ObjectId): Promise<void> {
  const count = (status: 'OPEN' | 'CONFIRMED') =>
    SanctionsMatchModel.countDocuments({ companyId, partyId, status });
  const sanctionsStatus =
    (await count('CONFIRMED')) > 0
      ? 'CONFIRMED_MATCH'
      : (await count('OPEN')) > 0
        ? 'POTENTIAL_MATCH'
        : 'CLEAR';
  await PartyModel.updateOne(
    { companyId, _id: partyId },
    { $set: { sanctionsStatus, sanctionsCheckedAt: new Date() } },
  );
}

async function screenName(
  companyId: Types.ObjectId,
  partyId: Types.ObjectId,
  screened: { subject: string; name: string },
  entries: Entry[],
): Promise<number> {
  const name = normaliseName(screened.name);
  let found = 0;
  for (const entry of entries) {
    let score = 0;
    let matchedAt = 0;
    entry.searchNames.forEach((candidate, index) => {
      const similarity = nameSimilarity(name, candidate);
      if (similarity > score) {
        score = similarity;
        matchedAt = index;
      }
    });
    if (score < MATCH_THRESHOLD) continue;
    found += 1;
    const key = {
      companyId,
      partyId,
      source: entry.source,
      externalId: entry.externalId,
      subject: screened.subject,
    };
    await SanctionsMatchModel.updateOne(
      key,
      {
        $set: {
          listedName: entry.name,
          matchedName: [entry.name, ...entry.aliases][matchedAt] ?? entry.name,
          score,
          entryType: entry.type,
          dateOfBirth: entry.dateOfBirth,
          nationality: entry.nationality,
          program: entry.program,
        },
        $setOnInsert: { screenedName: screened.name, status: 'OPEN' },
      },
      { upsert: true },
    );
    // A cleared match only answers for the name that was reviewed.
    await SanctionsMatchModel.updateOne(
      { ...key, status: 'FALSE_POSITIVE', screenedName: mongoose.trusted({ $ne: screened.name }) },
      {
        $set: { status: 'OPEN', screenedName: screened.name },
        $unset: { decisionNote: 1, decidedBy: 1, decidedAt: 1 },
      },
    );
  }
  return found;
}

/** Screens the party and each person who owns or controls it. */
async function screenAgainst(
  companyId: Types.ObjectId,
  party: { _id: Types.ObjectId; name: string; beneficialOwners?: string[] },
  entries: Entry[],
): Promise<number> {
  let found = await screenName(
    companyId,
    party._id,
    { subject: 'PARTY', name: party.name },
    entries,
  );
  for (const owner of party.beneficialOwners ?? []) {
    found += await screenName(companyId, party._id, { subject: owner, name: owner }, entries);
  }
  await refreshStatus(companyId, party._id);
  return found;
}

/** With no list imported the party stays NOT_SCREENED: absence of a list is never a clear result. */
export async function screenParty(
  companyId: Types.ObjectId,
  partyId: Types.ObjectId | string,
): Promise<number> {
  const party = await PartyModel.findOne({ companyId, _id: partyId }).lean();
  if (!party) throw new NotFoundError();
  const entries = await loadEntries(companyId);
  if (entries.length === 0) return 0;
  return screenAgainst(companyId, party, entries);
}

/** Runs in the worker after an import. Every party is checked against the new list. */
export async function rescreenAllParties(companyId: Types.ObjectId): Promise<number> {
  const entries = await loadEntries(companyId);
  if (entries.length === 0) return 0;
  let found = 0;
  for await (const party of PartyModel.find({ companyId })
    .select({ name: 1, beneficialOwners: 1 })
    .lean()
    .cursor()) {
    found += await screenAgainst(companyId, party as never, entries);
  }
  return found;
}

/** Stops dealings with a party while a possible listing is unresolved or confirmed. */
export async function assertPartyNotOnHold(
  tx: TransactionalContext,
  partyId: Types.ObjectId | string,
): Promise<void> {
  const party = await PartyModel.findOne({ companyId: tx.companyId, _id: partyId })
    .select({ sanctionsStatus: 1 })
    .session(tx.session)
    .lean();
  if (
    party?.sanctionsStatus === 'POTENTIAL_MATCH' ||
    party?.sanctionsStatus === 'CONFIRMED_MATCH'
  ) {
    // Worded so that staff at the counter do not learn, or reveal, the reason.
    throw new BusinessRuleError('This party is on hold. Please contact your compliance officer.');
  }
}

export async function importSanctionsList(
  ctx: RequestContext,
  input: z.infer<typeof sanctionsImportQuerySchema>,
  content: string,
) {
  const { version, entries } =
    input.format === 'UN_XML' ? parseUnConsolidatedXml(content) : parseSanctionsCsv(content);
  // An empty parse must never replace a working list.
  if (entries.length === 0) throw new BusinessRuleError('The file contains no list entries.');

  const unique = [...new Map(entries.map((entry) => [entry.externalId, entry])).values()];
  return runInTransaction(ctx, async (tx) => {
    await SanctionsEntryModel.deleteMany({ companyId: tx.companyId, source: input.source }).session(
      tx.session,
    );
    await SanctionsEntryModel.insertMany(
      unique.map((entry) => ({
        ...entry,
        companyId: tx.companyId,
        source: input.source,
        searchNames: [entry.name, ...entry.aliases].map(normaliseName),
      })),
      { session: tx.session },
    );
    const [list] = await SanctionsListModel.create(
      [
        {
          companyId: tx.companyId,
          source: input.source,
          version,
          entryCount: unique.length,
          importedBy: tx.userId,
          importedAt: new Date(),
        },
      ],
      { session: tx.session },
    );
    await recordAudit(tx, {
      action: 'sanctions.import',
      entityType: 'sanctions_list',
      entityId: input.source,
      after: { version, entryCount: unique.length },
    });
    await enqueueEvent(tx, SANCTIONS_IMPORTED_EVENT, { source: input.source });
    return list?.toObject();
  });
}

async function decideMatch(
  ctx: RequestContext,
  id: string,
  input: z.infer<typeof sanctionsDecisionSchema>,
) {
  const match = await SanctionsMatchModel.findOneAndUpdate(
    { companyId: ctx.companyId, _id: id, status: 'OPEN' },
    {
      $set: {
        status: input.decision,
        decisionNote: input.note,
        decidedBy: ctx.userId,
        decidedAt: new Date(),
      },
    },
    { returnDocument: 'after' },
  ).lean();
  if (!match) throw new ConflictError('This match has already been decided.');
  if (input.decision === 'CONFIRMED') {
    await PartyModel.updateOne(
      { companyId: ctx.companyId, _id: match.partyId },
      { $set: { riskLevel: 'HIGH' } },
    );
  }
  await refreshStatus(ctx.companyId, match.partyId);
  await recordAudit(ctx, {
    action: 'sanctions.decide',
    entityType: 'sanctions_match',
    entityId: id,
    after: input,
  });
  return match;
}

export function createSanctionsRouter(): Router {
  const router = Router();

  router.get('/lists', requirePermission('sanctions:review'), async (req, res) => {
    const rows = await SanctionsListModel.find({ companyId: req.ctx.companyId })
      .sort({ importedAt: -1 })
      .limit(50)
      .lean();
    sendSuccess(req, res, plain(rows));
  });

  router.post(
    '/lists/import',
    requirePermission('sanctions:import'),
    validate({ query: sanctionsImportQuerySchema }),
    express.text({ type: () => true, limit: MAX_LIST_BYTES }),
    async (req, res) => {
      if (typeof req.body !== 'string' || !req.body) {
        throw new BusinessRuleError('The file is empty.');
      }
      const query = req.validated.query as z.infer<typeof sanctionsImportQuerySchema>;
      sendSuccess(req, res, plain(await importSanctionsList(req.ctx, query, req.body)), 201);
    },
  );

  router.get('/matches', requirePermission('sanctions:review'), async (req, res) => {
    const filter: Record<string, unknown> = { companyId: req.ctx.companyId };
    if (typeof req.query.status === 'string' && req.query.status) filter.status = req.query.status;
    const rows = await SanctionsMatchModel.find(filter).sort({ _id: -1 }).limit(200).lean();
    sendSuccess(req, res, plain(rows));
  });

  router.post(
    '/matches/:id/decision',
    requirePermission('sanctions:review'),
    validate({ params: z.object({ id: objectIdSchema }), body: sanctionsDecisionSchema }),
    async (req, res) => {
      const body = req.validated.body as z.infer<typeof sanctionsDecisionSchema>;
      sendSuccess(req, res, plain(await decideMatch(req.ctx, String(req.params.id), body)));
    },
  );

  router.post(
    '/parties/:id/screen',
    requirePermission('sanctions:review'),
    validate({ params: z.object({ id: objectIdSchema }) }),
    async (req, res) => {
      const matches = await screenParty(req.ctx.companyId, String(req.params.id));
      sendSuccess(req, res, { matches });
    },
  );

  return router;
}
