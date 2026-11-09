import { z } from 'zod';
import { PERMISSIONS } from '@lumio/shared-types';
import { decimalString, objectIdSchema } from './primitives.js';

export const PERMISSION_KEYS: readonly string[] = PERMISSIONS;

const text = z.string().trim().min(1).max(200);
const optionalText = z.string().trim().max(1000).optional();
const code = z.string().trim().min(1).max(40);
const id = objectIdSchema;
const decimalNonNegative = decimalString.refine((v) => !v.startsWith('-'), 'Must not be negative');

export const offsetPageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  sort: z
    .string()
    .regex(/^-?[A-Za-z.]+$/)
    .optional(),
});

/* Identity */
export const passwordSchema = z.string().min(12, 'Use at least 12 characters').max(200);
export const loginSchema = z.strictObject({
  email: z.email(),
  password: z.string().min(1).max(200),
});
export const mfaLoginSchema = z.strictObject({
  mfaToken: z.string().min(1),
  code: z.string().min(6).max(16),
});
export const forgotPasswordSchema = z.strictObject({ email: z.email() });
export const resetPasswordSchema = z.strictObject({
  token: z.string().min(16),
  password: passwordSchema,
});
export const changePasswordSchema = z.strictObject({
  currentPassword: z.string().min(1),
  newPassword: passwordSchema,
});
export const mfaCodeSchema = z.strictObject({ code: z.string().min(6).max(8) });
export const mfaDisableSchema = z.strictObject({ password: z.string().min(1) });

const assignment = z.strictObject({
  roleId: id,
  branchIds: z.array(id).default([]),
});
export const inviteUserSchema = z.strictObject({
  email: z.email(),
  name: text,
  assignments: z.array(assignment).min(1),
});
export const updateUserSchema = z.strictObject({
  name: text.optional(),
  status: z.enum(['ACTIVE', 'DISABLED']).optional(),
  assignments: z.array(assignment).min(1).optional(),
});
export const roleSchema = z.strictObject({
  name: text,
  permissions: z.array(z.enum(PERMISSIONS as unknown as [string, ...string[]])).default([]),
});

export const provisionCompanySchema = z.strictObject({
  code,
  legalName: text,
  baseCurrency: z.string().length(3),
  adminEmail: z.email(),
  adminName: text,
  branchName: text,
});

/* Organisation */
export const companySettingsSchema = z.strictObject({
  legalName: text.optional(),
  taxRegistrationNumber: optionalText,
  address: optionalText,
  goamlEntityId: optionalText,
  settings: z
    .strictObject({
      allowNegativeStock: z.boolean().optional(),
      numberingScope: z
        .enum(['COMPANY', 'COMPANY_FISCAL_YEAR', 'BRANCH', 'BRANCH_FISCAL_YEAR'])
        .optional(),
      rateApprovalRequired: z.boolean().optional(),
      requireVerifiedTaxCodes: z.boolean().optional(),
      saleApprovalAmount: decimalNonNegative.optional(),
      purchaseApprovalAmount: decimalNonNegative.optional(),
      discountApprovalPercent: decimalNonNegative.optional(),
    })
    .optional(),
});
export const branchSchema = z.strictObject({
  code,
  name: text,
  address: optionalText,
  phone: optionalText,
});
export const warehouseSchema = z.strictObject({ code, name: text, branchId: id });
export const departmentSchema = z.strictObject({ code, name: text });
export const employeeSchema = z.strictObject({
  employeeNo: code,
  name: text,
  email: z.email().optional(),
  phone: optionalText,
  departmentId: id.optional(),
  branchId: id.optional(),
  userId: id.optional(),
  jobTitle: optionalText,
});

/* Master data */
export const partySchema = z.strictObject({
  code,
  name: text,
  type: z.enum(['INDIVIDUAL', 'BUSINESS']),
  roles: z.array(z.enum(['CUSTOMER', 'SUPPLIER'])).min(1),
  email: z.email().optional(),
  phone: optionalText,
  taxRegistrationNumber: optionalText,
  vatRegistered: z.boolean().default(false),
  billingAddress: optionalText,
  shippingAddress: optionalText,
  category: optionalText,
  creditLimit: decimalNonNegative.optional(),
  notes: optionalText,
  dateOfBirth: z.iso.date().optional(),
  nationality: z.string().trim().length(2).toUpperCase().optional(),
  beneficialOwners: z.array(text).max(50).optional(),
});
const chargeRule = z.strictObject({
  mode: z.string().min(1),
  value: decimalNonNegative.optional(),
});
export const productSchema = z.strictObject({
  sku: code,
  barcode: optionalText,
  name: text,
  kind: z.enum([
    'RAW_GOLD',
    'BAR',
    'BULLION',
    'COIN',
    'JEWELLERY',
    'SCRAP',
    'RECYCLED',
    'OTHER_METAL',
  ]),
  purityId: id,
  tracking: z.enum(['PIECE', 'LOT']),
  reorderLevelNet: decimalNonNegative.optional(),
  defaultMaking: chargeRule.optional(),
  defaultWastage: chargeRule.optional(),
});
export const puritySchema = z.strictObject({
  code,
  label: text,
  karat: decimalNonNegative.optional(),
  fineness: decimalNonNegative.refine(
    (v) => Number.parseFloat(v) > 0 && Number.parseFloat(v) <= 1,
    'Must be above 0 and at most 1',
  ),
});
export const partyPricingSchema = z.strictObject({
  partyId: id,
  makingMode: z.string().optional(),
  makingValue: decimalNonNegative.optional(),
  discountPercent: decimalNonNegative.optional(),
});
export const goldRateSchema = z.strictObject({
  purityId: id.optional(),
  branchId: id.optional(),
  basis: z.enum(['FINE_GRAM', 'PURITY_GRAM']),
  value: decimalNonNegative,
  unit: z.enum(['G', 'KG', 'TOZ']).default('G'),
  currency: z.string().length(3),
  source: text.default('MANUAL'),
});

/* Finance and ledger */
export const paymentMethodSchema = z.strictObject({
  code,
  name: text,
  amlClass: z.enum(['CASH', 'BANK', 'CARD', 'EXCHANGE_HOUSE', 'OTHER']),
});
export const financialAccountSchema = z.strictObject({
  code,
  name: text,
  kind: z.enum(['CASH', 'BANK', 'PAYMENT']),
  ledgerAccountId: id,
  branchId: id.optional(),
});
export const ledgerAccountSchema = z.strictObject({
  code,
  name: text,
  type: z.enum(['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE']),
  systemRole: z.string().optional(),
  cashFlowClass: z.enum(['OPERATING', 'INVESTING', 'FINANCING']).default('OPERATING'),
});
export const journalDraftSchema = z.strictObject({
  postingDate: z.iso.date(),
  memo: text,
  branchId: id,
  lines: z
    .array(
      z.strictObject({
        accountId: id,
        debit: decimalNonNegative.default('0'),
        credit: decimalNonNegative.default('0'),
        partyId: id.optional(),
        // Optional foreign currency detail. Debit and credit are always in the base currency.
        currency: z.string().length(3).toUpperCase().optional(),
        foreignAmount: decimalNonNegative.optional(),
        exchangeRate: decimalNonNegative.optional(),
      }),
    )
    .min(2),
});
export const yearEndSchema = z.strictObject({ year: z.number().int().min(2000).max(2100) });
export const bankLineNetSchema = z.strictObject({ otherLineId: id });
export const reasonSchema = z.strictObject({ reason: text });
export const periodYearSchema = z.strictObject({ year: z.number().int().min(2000).max(2100) });

/* Tax */
const treatment = z.enum(['STANDARD', 'ZERO', 'EXEMPT', 'REVERSE_CHARGE', 'OUT_OF_SCOPE']);
export const taxCodeSchema = z.strictObject({
  code,
  name: text,
  ratePercent: decimalNonNegative,
  treatment,
  verified: z.boolean().default(false),
  legalReference: optionalText,
});
export const taxRuleSchema = z.strictObject({
  name: text,
  priority: z.number().int().min(0),
  taxCodeId: id,
  direction: z.enum(['SALE', 'PURCHASE', 'ANY']).default('ANY'),
  productKinds: z.array(z.string()).default([]),
  minFineness: decimalNonNegative.optional(),
  maxFineness: decimalNonNegative.optional(),
  partyVatRegistered: z.boolean().optional(),
});

/* Inventory */
const location = z.string().trim().min(1).max(40).default('MAIN');
const quantities = {
  pieces: z.number().int().min(1).default(1),
  grossWeight: decimalNonNegative,
  stoneWeight: decimalNonNegative.default('0'),
};
export const stockReceiptSchema = z.strictObject({
  warehouseId: id,
  location,
  productId: id,
  ...quantities,
  totalCost: decimalNonNegative,
  tag: optionalText,
  lotNo: optionalText,
  reason: text,
});
export const stockIssueSchema = z.strictObject({
  warehouseId: id,
  location,
  productId: id,
  stockItemId: id.optional(),
  lotId: id.optional(),
  ...quantities,
  reason: text,
});
export const stockAdjustmentSchema = z.strictObject({
  warehouseId: id,
  location,
  productId: id,
  lotId: id.optional(),
  direction: z.enum(['GAIN', 'LOSS']),
  ...quantities,
  unitCostValue: decimalNonNegative.optional(),
  reason: text,
});
export const stockTransferSchema = z.strictObject({
  fromWarehouseId: id,
  toWarehouseId: id,
  location,
  lines: z
    .array(
      z.strictObject({
        productId: id,
        lotId: id.optional(),
        stockItemId: id.optional(),
        ...quantities,
      }),
    )
    .min(1)
    .max(500),
});
export const stockReservationSchema = z.strictObject({
  warehouseId: id,
  location,
  productId: id,
  lotId: id.optional(),
  netWeight: decimalNonNegative,
  reference: text,
  expiresAt: z.iso.datetime().optional(),
});
export const stockCountSchema = z.strictObject({
  warehouseId: id,
  location,
  lines: z
    .array(
      z.strictObject({
        productId: id,
        lotId: id.optional(),
        countedNet: decimalNonNegative,
        countedGross: decimalNonNegative.optional(),
        pieces: z.number().int().min(0).optional(),
      }),
    )
    .min(1),
});

/* Trade */
const tradeLine = z.strictObject({
  productId: id,
  warehouseId: id,
  location,
  stockItemId: id.optional(),
  lotId: id.optional(),
  pieces: z.number().int().min(1).default(1),
  grossWeight: decimalNonNegative,
  stoneWeight: decimalNonNegative.default('0'),
  rateOverride: z
    .strictObject({ basis: z.enum(['FINE_GRAM', 'PURITY_GRAM']), value: decimalNonNegative })
    .optional(),
  wastage: chargeRule.optional(),
  making: chargeRule.optional(),
  stoneValue: decimalNonNegative.default('0'),
  otherCharges: decimalNonNegative.default('0'),
  discount: z
    .strictObject({
      kind: z.enum(['PERCENT', 'AMOUNT']),
      target: z.enum(['GOLD_VALUE', 'MAKING', 'LINE']),
      value: decimalNonNegative,
    })
    .optional(),
  taxInclusive: z.boolean().default(false),
});
const settlement = z.strictObject({
  financialAccountId: id,
  methodId: id,
  amount: decimalNonNegative,
  reference: optionalText,
});
export const tradeDocumentSchema = z.strictObject({
  partyId: id,
  branchId: id,
  docDate: z.iso.date(),
  dueDate: z.iso.date().optional(),
  supplierInvoiceNo: optionalText,
  goodsReceiptId: id.optional(),
  currency: z.string().length(3),
  lines: z.array(tradeLine).min(1).max(500),
  payments: z.array(settlement).default([]),
  notes: optionalText,
});
export const tradeReturnSchema = z
  .strictObject({
    lineIds: z.array(z.string().min(1)).default([]),
    /** Part of a line's weight. The rest of the line stays on the invoice. */
    partial: z
      .array(z.strictObject({ lineId: z.string().min(1), grossWeight: decimalNonNegative }))
      .default([]),
    reason: text,
    docDate: z.iso.date(),
  })
  .refine((v) => v.lineIds.length + v.partial.length > 0, 'Choose something to return');
export const invoiceEmailSchema = z.strictObject({ to: z.email().optional() });
export const purchaseOrderSchema = z.strictObject({
  partyId: id,
  branchId: id,
  orderDate: z.iso.date(),
  notes: optionalText,
  lines: z
    .array(
      z.strictObject({
        productId: id,
        expectedWeight: decimalNonNegative,
        expectedRate: decimalNonNegative.optional(),
      }),
    )
    .min(1),
});

/* Payments */
export const paymentSchema = z.strictObject({
  direction: z.enum(['RECEIPT', 'PAYMENT']),
  side: z.enum(['RECEIVABLE', 'PAYABLE']).optional(),
  partyId: id,
  branchId: id,
  financialAccountId: id,
  methodId: id,
  amount: decimalNonNegative,
  paymentDate: z.iso.date(),
  reference: optionalText,
  allocations: z.array(z.strictObject({ openItemId: id, amount: decimalNonNegative })).optional(),
});

/* Compliance */
export const kycRecordSchema = z.strictObject({
  partyId: id,
  documentType: z.enum(['EMIRATES_ID', 'PASSPORT', 'TRADE_LICENCE', 'OTHER']),
  documentNumber: text,
  expiresAt: z.iso.date().optional(),
  status: z.enum(['PENDING', 'VERIFIED', 'REJECTED']).default('PENDING'),
});
export const complianceRuleSchema = z.strictObject({
  name: text,
  trigger: z.enum(['SALE_POSTED', 'PURCHASE_POSTED', 'PAYMENT_POSTED']),
  amlClasses: z.array(z.string()).default([]),
  thresholdAmount: decimalNonNegative,
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  active: z.boolean().default(true),
  legalReference: optionalText,
});
export const caseDecisionSchema = z.strictObject({
  status: z.enum(['UNDER_REVIEW', 'CLEARED', 'REPORTED']),
  decisionNote: text,
});

/* Documents */
export const DOCUMENT_OWNER_TYPES = ['PARTY', 'KYC', 'SALE', 'PURCHASE', 'PAYMENT'] as const;
export const documentUploadQuerySchema = z.object({
  ownerType: z.enum(DOCUMENT_OWNER_TYPES),
  ownerId: id,
  category: z.enum([
    'EMIRATES_ID',
    'PASSPORT',
    'TRADE_LICENCE',
    'ASSAY_CERTIFICATE',
    'CONTRACT',
    'BANK_PROOF',
    'OTHER',
  ]),
  fileName: z.string().trim().min(1).max(200),
  expiresAt: z.iso.date().optional(),
  replaces: id.optional(),
});
export const documentListQuerySchema = z.object({
  ownerType: z.enum(DOCUMENT_OWNER_TYPES).optional(),
  ownerId: id.optional(),
  expiringWithinDays: z.coerce.number().int().min(0).max(3650).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/* Sanctions */
export const sanctionsImportQuerySchema = z.object({
  source: z.string().trim().min(1).max(40).toUpperCase(),
  format: z.enum(['UN_XML', 'CSV']),
});
export const sanctionsDecisionSchema = z.strictObject({
  decision: z.enum(['FALSE_POSITIVE', 'CONFIRMED']),
  note: text,
});

/* goAML */
export const goamlCreateSchema = z.strictObject({
  reportType: z.enum(['DPMSR', 'STR']),
  caseIds: z.array(id).min(1).max(100),
  reason: z.string().trim().min(1).max(4000),
  action: z.string().trim().max(4000).optional(),
  indicators: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
});
export const goamlSubmittedSchema = z.strictObject({ fiuReference: text });

/* Bank reconciliation */
export const bankStatementImportSchema = z.strictObject({
  financialAccountId: id,
  csv: z.string().min(1).max(900_000),
  dateOrder: z.enum(['DMY', 'MDY', 'YMD']).default('DMY'),
});
export const bankLineMatchSchema = z.strictObject({ paymentIds: z.array(id).min(1).max(100) });
export const bankLineAdjustSchema = z.strictObject({
  ledgerAccountId: id,
  branchId: id,
  memo: text,
});
export const reconciliationCreateSchema = z.strictObject({
  financialAccountId: id,
  statementDate: z.iso.date(),
  closingBalance: decimalString,
  // Required on an account's first reconciliation; carried forward afterwards.
  openingBalance: decimalString.optional(),
});

/* Browser error reports */
export const clientErrorSchema = z.strictObject({
  message: z.string().max(2000),
  stack: z.string().max(10_000).optional(),
  componentStack: z.string().max(10_000).optional(),
  path: z.string().max(500).optional(),
});

/* Goods receipts */
export const goodsReceiptSchema = z.strictObject({
  partyId: id,
  branchId: id,
  receiptDate: z.iso.date(),
  purchaseOrderId: id.optional(),
  lines: z
    .array(
      z.strictObject({
        productId: id,
        warehouseId: id,
        location,
        ...quantities,
        expectedWeight: decimalNonNegative.optional(),
        cost: decimalNonNegative,
        tag: optionalText,
      }),
    )
    .min(1)
    .max(500),
});

/* Report schedules */
export const reportScheduleSchema = z.strictObject({
  reportKey: code,
  frequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY']),
  format: z.enum(['XLSX', 'PDF']),
  recipients: z.array(z.email()).min(1).max(20),
});
export const switchCompanySchema = z.strictObject({ companyId: id });
