import type { Types } from 'mongoose';
import {
  D128,
  OID,
  RD128,
  ROID,
  RS,
  tenantSchema,
  tenantModel,
} from '../../database/tenant-schema.js';
import { assertTransactional, type RequestContext } from '../../shared/context.js';
import { d128, dec } from '../../shared/decimal.js';
import { BusinessRuleError } from '../../shared/errors.js';

const taxCodeSchema = tenantSchema(
  'taxCodes',
  {
    code: RS,
    name: RS,
    ratePercent: RD128,
    treatment: RS,
    verified: { type: Boolean, default: false },
    legalReference: String,
    archivedAt: Date,
  },
  { timestamps: true },
);
taxCodeSchema.index({ companyId: 1, code: 1 }, { unique: true });
export const TaxCodeModel = tenantModel('TaxCode', taxCodeSchema);

const taxRuleSchema = tenantSchema(
  'taxRules',
  {
    name: RS,
    priority: { type: Number, required: true },
    taxCodeId: ROID,
    direction: { type: String, default: 'ANY' },
    productKinds: { type: [String], default: [] },
    minFineness: D128,
    maxFineness: D128,
    partyVatRegistered: Boolean,
    archivedAt: Date,
  },
  { timestamps: true },
);
taxRuleSchema.index({ companyId: 1, priority: 1 });
export const TaxRuleModel = tenantModel('TaxRule', taxRuleSchema);

const taxTransactionSchema = tenantSchema(
  'taxTransactions',
  {
    sourceType: RS,
    sourceId: RS,
    branchId: OID,
    partyId: OID,
    direction: { type: String, enum: ['INPUT', 'OUTPUT'], required: true },
    treatment: RS,
    taxCode: RS,
    ratePercent: RD128,
    taxable: RD128,
    tax: RD128,
    date: { type: Date, required: true },
  },
  { appendOnly: true },
);
taxTransactionSchema.index({ companyId: 1, date: 1, direction: 1 });
taxTransactionSchema.index({ companyId: 1, sourceType: 1, sourceId: 1 });
export const TaxTransactionModel = tenantModel('TaxTransaction', taxTransactionSchema);

export interface TaxDecision {
  code: string;
  name: string;
  ratePercent: string;
  treatment: string;
  verified: boolean;
}

/** Applies the company's configured rules. With no matching rule it refuses to assume a treatment. */
export async function determineTax(
  ctx: RequestContext,
  facts: {
    direction: 'SALE' | 'PURCHASE';
    productKind: string;
    fineness: string;
    partyVatRegistered: boolean;
  },
  requireVerified: boolean,
): Promise<TaxDecision> {
  const rules = await TaxRuleModel.find({ companyId: ctx.companyId, archivedAt: null })
    .sort({ priority: 1 })
    .session(ctx.session ?? null)
    .lean();
  const fineness = dec(facts.fineness);
  const match = rules.find(
    (rule) =>
      (rule.direction === 'ANY' || rule.direction === facts.direction) &&
      (rule.productKinds.length === 0 || rule.productKinds.includes(facts.productKind)) &&
      (!rule.minFineness || fineness.gte(dec(rule.minFineness))) &&
      (!rule.maxFineness || fineness.lte(dec(rule.maxFineness))) &&
      (rule.partyVatRegistered === undefined ||
        rule.partyVatRegistered === null ||
        rule.partyVatRegistered === facts.partyVatRegistered),
  );
  if (!match) {
    throw new BusinessRuleError(
      'No tax rule matches this line. Configure tax rules before transacting.',
    );
  }
  const code = await TaxCodeModel.findOne({ companyId: ctx.companyId, _id: match.taxCodeId })
    .session(ctx.session ?? null)
    .lean();
  if (!code) throw new BusinessRuleError(`Tax rule ${match.name} refers to a missing tax code.`);
  if (requireVerified && !code.verified) {
    throw new BusinessRuleError(
      `Tax code ${code.code} has not been verified by a tax adviser, so it cannot be used.`,
    );
  }
  return {
    code: code.code,
    name: code.name,
    ratePercent: code.ratePercent.toString(),
    treatment: code.treatment,
    verified: code.verified ?? false,
  };
}

export async function recordTaxTransaction(
  ctx: RequestContext,
  entry: {
    sourceType: string;
    sourceId: string;
    branchId: Types.ObjectId | string;
    partyId: Types.ObjectId | string;
    direction: 'INPUT' | 'OUTPUT';
    treatment: string;
    taxCode: string;
    ratePercent: string;
    taxable: string;
    tax: string;
    date: Date;
  },
): Promise<void> {
  assertTransactional(ctx, 'recordTaxTransaction');
  await TaxTransactionModel.create(
    [
      {
        ...entry,
        companyId: ctx.companyId,
        ratePercent: d128(entry.ratePercent),
        taxable: d128(entry.taxable),
        tax: d128(entry.tax),
      },
    ],
    { session: ctx.session },
  );
}
