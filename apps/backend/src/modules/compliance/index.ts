import { caseDecisionSchema, objectIdSchema } from '@lumio/validation';
import { Router } from 'express';
import mongoose, { Types } from 'mongoose';
import { z } from 'zod';
import { OID, RD128, ROID, RS, tenantSchema, tenantModel } from '../../database/tenant-schema.js';
import { requirePermission } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import type { RequestContext } from '../../shared/context.js';
import { d128, dec } from '../../shared/decimal.js';
import { sendSuccess } from '../../shared/http.js';
import { plain } from '../../shared/serialize.js';
import { NotFoundError } from '../../shared/errors.js';
import { PartyModel } from '../master/index.js';
import { recordAudit } from '../platform/audit/index.js';

export * from './sanctions.js';

const kycSchema = tenantSchema(
  'kycRecords',
  {
    partyId: ROID,
    documentType: RS,
    documentNumberSealed: RS,
    documentNumberIndex: RS,
    documentNumberLast4: RS,
    expiresAt: Date,
    status: RS,
    archivedAt: Date,
  },
  { timestamps: true },
);
kycSchema.index({ companyId: 1, partyId: 1 });
kycSchema.index({ companyId: 1, documentNumberIndex: 1 });
export const KycRecordModel = tenantModel('KycRecord', kycSchema);

const ruleSchema = tenantSchema(
  'complianceRules',
  {
    name: RS,
    trigger: RS,
    amlClasses: { type: [String], default: [] },
    thresholdAmount: RD128,
    aggregateDays: Number,
    partyTypes: { type: [String], default: [] },
    severity: RS,
    active: { type: Boolean, default: true },
    legalReference: String,
    archivedAt: Date,
  },
  { timestamps: true },
);
ruleSchema.index({ companyId: 1, trigger: 1, active: 1 });
export const ComplianceRuleModel = tenantModel('ComplianceRule', ruleSchema);

const caseSchema = tenantSchema(
  'complianceCases',
  {
    ruleId: ROID,
    ruleName: RS,
    severity: RS,
    partyId: OID,
    sourceType: RS,
    sourceId: RS,
    sourceNumber: String,
    amount: RD128,
    status: { type: String, enum: ['OPEN', 'UNDER_REVIEW', 'CLEARED', 'REPORTED'], required: true },
    decisionNote: String,
    decidedBy: String,
    decidedAt: Date,
  },
  { timestamps: true },
);
caseSchema.index({ companyId: 1, ruleId: 1, sourceId: 1 }, { unique: true });
caseSchema.index({ companyId: 1, status: 1, _id: -1 });
export const ComplianceCaseModel = tenantModel('ComplianceCase', caseSchema);

const exposureSchema = tenantSchema('amlExposures', {
  partyId: ROID,
  trigger: RS,
  amlClass: String,
  sourceId: RS,
  amount: RD128,
  at: { type: Date, required: true },
});
exposureSchema.index({ companyId: 1, trigger: 1, sourceId: 1 }, { unique: true });
exposureSchema.index({ companyId: 1, partyId: 1, trigger: 1, at: -1 });
export const AmlExposureModel = tenantModel('AmlExposure', exposureSchema);

/** The total for one party across the window, so splitting a payment does not avoid a report. */
async function linkedTotal(
  companyId: Types.ObjectId,
  event: ScreenableEvent,
  rule: { amlClasses: string[]; aggregateDays?: number | null },
) {
  const since = new Date(Date.now() - (rule.aggregateDays ?? 0) * 86_400_000);
  const rows = await AmlExposureModel.find({
    companyId,
    partyId: event.partyId,
    trigger: event.trigger,
    at: mongoose.trusted({ $gte: since }),
    ...(rule.amlClasses.length ? { amlClass: mongoose.trusted({ $in: rule.amlClasses }) } : {}),
  })
    .select({ amount: 1 })
    .lean();
  return rows.reduce((sum, row) => sum.plus(dec(row.amount)), dec('0'));
}

export interface ScreenableEvent {
  companyId: string;
  trigger: 'SALE_POSTED' | 'PURCHASE_POSTED' | 'PAYMENT_POSTED';
  sourceId: string;
  sourceNumber: string;
  partyId: string;
  amount: string;
  amlClass?: string;
}

/**
 * Applies the company's configured thresholds and opens a case for review. Idempotent: the unique
 * index makes redelivery harmless. Thresholds are configuration, subject to legal review.
 */
export async function screenTransaction(event: ScreenableEvent): Promise<number> {
  const companyId = new Types.ObjectId(event.companyId);
  const rules = await ComplianceRuleModel.find({
    companyId,
    trigger: event.trigger,
    active: true,
    archivedAt: null,
  }).lean();
  // Recorded first, and once per source, so a redelivered event is not counted twice.
  await AmlExposureModel.updateOne(
    { companyId, trigger: event.trigger, sourceId: event.sourceId },
    {
      $setOnInsert: {
        partyId: event.partyId,
        amount: d128(event.amount),
        at: new Date(),
        ...(event.amlClass ? { amlClass: event.amlClass } : {}),
      },
    },
    { upsert: true },
  );
  const party = await PartyModel.findOne({ companyId, _id: event.partyId }).lean();
  let opened = 0;
  for (const rule of rules) {
    if (rule.amlClasses.length && !rule.amlClasses.includes(event.amlClass ?? '')) continue;
    if (rule.partyTypes.length && !rule.partyTypes.includes(party?.type ?? '')) continue;
    const amount = rule.aggregateDays
      ? await linkedTotal(companyId, event, rule)
      : dec(event.amount);
    if (amount.lessThan(dec(rule.thresholdAmount))) continue;
    const result = await ComplianceCaseModel.updateOne(
      { companyId, ruleId: rule._id, sourceId: event.sourceId },
      {
        $setOnInsert: {
          ruleName: rule.name,
          severity: rule.severity,
          partyId: event.partyId,
          sourceType: event.trigger,
          sourceNumber: event.sourceNumber,
          amount: d128(event.amount),
          status: 'OPEN',
        },
      },
      { upsert: true },
    );
    opened += result.upsertedCount;
    if (result.upsertedCount && rule.severity === 'HIGH') {
      await PartyModel.updateOne(
        { companyId, _id: event.partyId },
        { $set: { riskLevel: 'HIGH' } },
      );
    }
  }
  return opened;
}

export function createComplianceCaseRouter(): Router {
  const router = Router();

  router.get('/', requirePermission('compliance_case:read'), async (req, res) => {
    const rows = await ComplianceCaseModel.find({ companyId: req.ctx.companyId })
      .sort({ _id: -1 })
      .limit(200)
      .lean();
    sendSuccess(req, res, plain(rows));
  });

  router.post(
    '/:id/decision',
    requirePermission('compliance_case:update'),
    validate({ params: z.object({ id: objectIdSchema }), body: caseDecisionSchema }),
    async (req, res) => {
      const body = req.validated.body as z.infer<typeof caseDecisionSchema>;
      const updated = await decideCase(req.ctx, String(req.params.id), body);
      sendSuccess(req, res, plain(updated));
    },
  );
  return router;
}

async function decideCase(
  ctx: RequestContext,
  id: string,
  body: z.infer<typeof caseDecisionSchema>,
) {
  const updated = await ComplianceCaseModel.findOneAndUpdate(
    { companyId: ctx.companyId, _id: id },
    { $set: { ...body, decidedBy: ctx.userId, decidedAt: new Date() } },
    { returnDocument: 'after' },
  ).lean();
  if (!updated) throw new NotFoundError();
  await recordAudit(ctx, {
    action: 'compliance_case.decide',
    entityType: 'compliance_case',
    entityId: id,
    after: body,
  });
  return updated;
}
