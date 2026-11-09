import mongoose, { Schema } from 'mongoose';
import { tenantGuardPlugin } from '../../database/plugins/tenant-guard.js';
import { tenantModel } from '../../database/tenant-schema.js';

const options = { versionKey: false, strict: 'throw', timestamps: true } as const;
const companyId = { type: Schema.Types.ObjectId, required: true };

const settingsSchema = new Schema(
  {
    allowNegativeStock: { type: Boolean, default: false },
    numberingScope: {
      type: String,
      enum: ['COMPANY', 'COMPANY_FISCAL_YEAR', 'BRANCH', 'BRANCH_FISCAL_YEAR'],
      default: 'BRANCH_FISCAL_YEAR',
    },
    rateApprovalRequired: { type: Boolean, default: false },
    requireVerifiedTaxCodes: { type: Boolean, default: true },
    // Documents at or above these limits need a second person. Empty disables the check.
    saleApprovalAmount: String,
    purchaseApprovalAmount: String,
    discountApprovalPercent: String,
    tolaGrams: String,
    // Unapproved proposal until the business signs off: see open questions Q1-Q6.
    pricing: {
      version: { type: String, default: '1' },
      signedOff: { type: Boolean, default: false },
      weightScale: { type: Number, default: 3 },
      fineWeightScale: { type: Number, default: 4 },
      finenessScale: { type: Number, default: 4 },
      rateScale: { type: Number, default: 4 },
      moneyScale: { type: Number, default: 2 },
      mode: { type: String, enum: ['HALF_UP', 'HALF_EVEN', 'DOWN'], default: 'HALF_UP' },
      taxRounding: { type: String, enum: ['LINE', 'DOCUMENT'], default: 'LINE' },
    },
  },
  { _id: false },
);

const companySchema = new Schema(
  {
    code: { type: String, required: true },
    legalName: { type: String, required: true },
    baseCurrency: { type: String, required: true },
    taxRegistrationNumber: String,
    address: String,
    goamlEntityId: String,
    status: { type: String, enum: ['ACTIVE', 'SUSPENDED'], default: 'ACTIVE' },
    isDemo: { type: Boolean, default: false },
    settings: { type: settingsSchema, default: () => ({}) },
  },
  { ...options, collection: 'companies' },
);
companySchema.index({ code: 1 }, { unique: true });
export const CompanyModel = mongoose.model('Company', companySchema);

function tenantCollection(
  name: string,
  collection: string,
  definition: Record<string, unknown>,
  uniqueOn = 'code',
) {
  const schema = new Schema(
    { companyId, archivedAt: Date, ...definition },
    { ...options, collection },
  );
  schema.index({ companyId: 1, [uniqueOn]: 1 }, { unique: true });
  schema.plugin(tenantGuardPlugin);
  return tenantModel(name, schema);
}

export const BranchModel = tenantCollection('Branch', 'branches', {
  code: { type: String, required: true },
  name: { type: String, required: true },
  emirate: String,
  address: String,
  phone: String,
});

export const WarehouseModel = tenantCollection('Warehouse', 'warehouses', {
  code: { type: String, required: true },
  name: { type: String, required: true },
  branchId: { type: Schema.Types.ObjectId, required: true },
});

export const DepartmentModel = tenantCollection('Department', 'departments', {
  code: { type: String, required: true },
  name: { type: String, required: true },
});

export const EmployeeModel = tenantCollection(
  'Employee',
  'employees',
  {
    employeeNo: { type: String, required: true },
    name: { type: String, required: true },
    email: String,
    phone: String,
    departmentId: Schema.Types.ObjectId,
    branchId: Schema.Types.ObjectId,
    userId: Schema.Types.ObjectId,
    jobTitle: String,
  },
  'employeeNo',
);
