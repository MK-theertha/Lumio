import {
  D128,
  OID,
  RD128,
  ROID,
  RS,
  tenantSchema,
  tenantModel,
} from '../../database/tenant-schema.js';

const paymentMethodSchema = tenantSchema(
  'paymentMethods',
  { code: RS, name: RS, amlClass: RS, archivedAt: Date },
  { timestamps: true },
);
paymentMethodSchema.index({ companyId: 1, code: 1 }, { unique: true });
export const PaymentMethodModel = tenantModel('PaymentMethod', paymentMethodSchema);

const financialAccountSchema = tenantSchema(
  'financialAccounts',
  { code: RS, name: RS, kind: RS, ledgerAccountId: ROID, branchId: OID, archivedAt: Date },
  { timestamps: true },
);
financialAccountSchema.index({ companyId: 1, code: 1 }, { unique: true });
export const FinancialAccountModel = tenantModel('FinancialAccount', financialAccountSchema);

const openItemSchema = tenantSchema(
  'openItems',
  {
    partyId: ROID,
    side: { type: String, enum: ['RECEIVABLE', 'PAYABLE'], required: true },
    sourceType: RS,
    sourceId: RS,
    number: RS,
    branchId: ROID,
    docDate: { type: Date, required: true },
    dueDate: { type: Date, required: true },
    original: RD128,
    outstanding: RD128,
    status: { type: String, enum: ['OPEN', 'SETTLED'], required: true },
  },
  { timestamps: true },
);
openItemSchema.index({ companyId: 1, sourceType: 1, sourceId: 1 }, { unique: true });
openItemSchema.index({ companyId: 1, partyId: 1, side: 1, status: 1, dueDate: 1 });
export const OpenItemModel = tenantModel('OpenItem', openItemSchema);

const partyBalanceSchema = tenantSchema('partyBalances', {
  partyId: ROID,
  receivable: RD128,
  payable: RD128,
  // Reserved for gram-denominated accounts, pending open question Q9.
  metalFine: D128,
});
partyBalanceSchema.index({ companyId: 1, partyId: 1 }, { unique: true });
export const PartyBalanceModel = tenantModel('PartyBalance', partyBalanceSchema);

const paymentSchema = tenantSchema(
  'payments',
  {
    number: RS,
    direction: { type: String, enum: ['RECEIPT', 'PAYMENT'], required: true },
    side: { type: String, enum: ['RECEIVABLE', 'PAYABLE'], required: true },
    partyId: ROID,
    branchId: ROID,
    financialAccountId: ROID,
    methodId: ROID,
    amlClass: RS,
    amount: RD128,
    paymentDate: { type: Date, required: true },
    reference: String,
    status: { type: String, enum: ['POSTED', 'REVERSED'], required: true },
    journalEntryId: ROID,
    sourceType: String,
    sourceId: String,
    createdBy: RS,
  },
  { timestamps: true },
);
paymentSchema.index({ companyId: 1, number: 1 }, { unique: true });
paymentSchema.index({ companyId: 1, partyId: 1, paymentDate: -1 });
paymentSchema.index({ companyId: 1, paymentDate: -1 });
export const PaymentModel = tenantModel('Payment', paymentSchema);

const allocationSchema = tenantSchema(
  'paymentAllocations',
  { paymentId: ROID, openItemId: ROID, amount: RD128, at: { type: Date, required: true } },
  { appendOnly: true },
);
allocationSchema.index({ companyId: 1, paymentId: 1 });
allocationSchema.index({ companyId: 1, openItemId: 1 });
export const PaymentAllocationModel = tenantModel('PaymentAllocation', allocationSchema);
