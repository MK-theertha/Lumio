import { caseDecisionSchema, objectIdSchema } from '@lumio/validation';
import { Router } from 'express';
import { Types } from 'mongoose';
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
  let opened = 0;
  for (const rule of rules) {
    if (rule.amlClasses.length && !rule.amlClasses.includes(event.amlClass ?? '')) continue;
    if (dec(event.amount).lessThan(dec(rule.thresholdAmount))) continue;
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
