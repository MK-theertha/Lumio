import {
  D128,
  OID,
  RD128,
  ROID,
  RS,
  tenantSchema,
  tenantModel,
} from '../../database/tenant-schema.js';

const chargeRule = { _id: false, mode: String, value: String };

const partySchema = tenantSchema(
  'parties',
  {
    code: RS,
    name: RS,
    type: { type: String, enum: ['INDIVIDUAL', 'BUSINESS'], required: true },
    roles: { type: [String], required: true },
    email: String,
    phone: String,
    taxRegistrationNumber: String,
    vatRegistered: { type: Boolean, default: false },
    billingAddress: String,
    shippingAddress: String,
    category: String,
    creditLimit: D128,
    notes: String,
    dateOfBirth: String,
    nationality: String,
    kycStatus: { type: String, default: 'NONE' },
    sanctionsStatus: {
      type: String,
      enum: ['NOT_SCREENED', 'CLEAR', 'POTENTIAL_MATCH', 'CONFIRMED_MATCH'],
      default: 'NOT_SCREENED',
    },
    sanctionsCheckedAt: Date,
    riskLevel: { type: String, default: 'UNRATED' },
    archivedAt: Date,
  },
  { timestamps: true },
);
partySchema.index({ companyId: 1, code: 1 }, { unique: true });
partySchema.index({ companyId: 1, roles: 1, name: 1 });
export const PartyModel = tenantModel('Party', partySchema);

const puritySchema = tenantSchema(
  'purities',
  { code: RS, label: RS, karat: D128, fineness: RD128, archivedAt: Date },
  { timestamps: true },
);
puritySchema.index({ companyId: 1, code: 1 }, { unique: true });
export const PurityModel = tenantModel('Purity', puritySchema);

const productSchema = tenantSchema(
  'products',
  {
    sku: RS,
    barcode: String,
    name: RS,
    kind: RS,
    purityId: ROID,
    tracking: { type: String, enum: ['PIECE', 'LOT'], required: true },
    reorderLevelNet: D128,
    defaultMaking: chargeRule,
    defaultWastage: chargeRule,
    archivedAt: Date,
  },
  { timestamps: true },
);
productSchema.index({ companyId: 1, sku: 1 }, { unique: true });
productSchema.index(
  { companyId: 1, barcode: 1 },
  { unique: true, partialFilterExpression: { barcode: { $type: 'string' } } },
);
export const ProductModel = tenantModel('Product', productSchema);

const partyPricingSchema = tenantSchema(
  'partyPricingRules',
  {
    partyId: ROID,
    makingMode: String,
    makingValue: String,
    discountPercent: String,
    archivedAt: Date,
  },
  { timestamps: true },
);
partyPricingSchema.index({ companyId: 1, partyId: 1 }, { unique: true });
export const PartyPricingModel = tenantModel('PartyPricing', partyPricingSchema);

const partyActivitySchema = tenantSchema(
  'partyActivities',
  { partyId: OID, type: RS, note: RS, userId: RS, at: { type: Date, required: true } },
  { appendOnly: true },
);
partyActivitySchema.index({ companyId: 1, partyId: 1, at: -1 });
export const PartyActivityModel = tenantModel('PartyActivity', partyActivitySchema);
