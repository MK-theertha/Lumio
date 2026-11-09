import {
  D128,
  OID,
  RD128,
  ROID,
  RS,
  tenantSchema,
  tenantModel,
} from '../../database/tenant-schema.js';

export const LEDGER_ROLES = [
  'AR',
  'AP',
  'INVENTORY',
  'SALES_GOLD',
  'SALES_MAKING',
  'SALES_DISCOUNT',
  'COGS',
  'OUTPUT_VAT',
  'INPUT_VAT',
  'STOCK_GAIN_LOSS',
  'OPENING_EQUITY',
  'RETAINED_EARNINGS',
  'INTER_BRANCH',
  'GRNI',
] as const;
export type LedgerRole = (typeof LEDGER_ROLES)[number];

const ledgerAccountSchema = tenantSchema(
  'ledgerAccounts',
  {
    code: RS,
    name: RS,
    type: {
      type: String,
      enum: ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'],
      required: true,
    },
    systemRole: String,
    cashFlowClass: { type: String, default: 'OPERATING' },
    isCash: { type: Boolean, default: false },
    archivedAt: Date,
  },
  { timestamps: true },
);
ledgerAccountSchema.index({ companyId: 1, code: 1 }, { unique: true });
ledgerAccountSchema.index(
  { companyId: 1, systemRole: 1 },
  { unique: true, partialFilterExpression: { systemRole: { $type: 'string' } } },
);
export const LedgerAccountModel = tenantModel('LedgerAccount', ledgerAccountSchema);

const periodSchema = tenantSchema(
  'financialPeriods',
  {
    name: RS,
    from: { type: Date, required: true },
    to: { type: Date, required: true },
    status: { type: String, enum: ['OPEN', 'CLOSING', 'CLOSED'], required: true },
    closingStartedAt: Date,
    history: { type: [Object], default: [] },
  },
  { timestamps: true },
);
periodSchema.index({ companyId: 1, from: 1 }, { unique: true });
export const FinancialPeriodModel = tenantModel('FinancialPeriod', periodSchema);

const journalEntrySchema = tenantSchema(
  'journalEntries',
  {
    number: RS,
    postingDate: { type: Date, required: true },
    periodId: ROID,
    branchId: ROID,
    memo: RS,
    sourceType: RS,
    sourceId: RS,
    kind: RS,
    totalDebit: RD128,
    totalCredit: RD128,
    reversesEntryId: OID,
    postedBy: RS,
    postedAt: { type: Date, required: true },
  },
  { appendOnly: true },
);
journalEntrySchema.index({ companyId: 1, number: 1 }, { unique: true });
journalEntrySchema.index({ companyId: 1, sourceType: 1, sourceId: 1, kind: 1 }, { unique: true });
journalEntrySchema.index(
  { companyId: 1, reversesEntryId: 1 },
  { unique: true, partialFilterExpression: { reversesEntryId: { $type: 'objectId' } } },
);
journalEntrySchema.index({ companyId: 1, postingDate: -1 });
export const JournalEntryModel = tenantModel('JournalEntry', journalEntrySchema);

const journalLineSchema = tenantSchema(
  'journalLines',
  {
    entryId: ROID,
    accountId: ROID,
    branchId: ROID,
    partyId: OID,
    postingDate: { type: Date, required: true },
    debit: RD128,
    credit: RD128,
    // Moves the year's profit to retained earnings, so it is not itself part of that profit.
    closing: Boolean,
    currency: String,
    foreignAmount: D128,
    exchangeRate: D128,
  },
  { appendOnly: true },
);
journalLineSchema.index({ companyId: 1, accountId: 1, postingDate: 1 });
journalLineSchema.index({ companyId: 1, branchId: 1, accountId: 1, postingDate: 1 });
journalLineSchema.index({ companyId: 1, partyId: 1, postingDate: 1 });
journalLineSchema.index({ companyId: 1, entryId: 1 });
export const JournalLineModel = tenantModel('JournalLine', journalLineSchema);

const journalDraftSchema = tenantSchema(
  'journalDrafts',
  {
    postingDate: { type: Date, required: true },
    memo: RS,
    branchId: ROID,
    lines: {
      type: [
        {
          _id: false,
          accountId: ROID,
          debit: D128,
          credit: D128,
          partyId: OID,
          currency: String,
          foreignAmount: D128,
          exchangeRate: D128,
        },
      ],
      required: true,
    },
    status: { type: String, enum: ['DRAFT', 'POSTED', 'REJECTED'], required: true },
    createdBy: RS,
    entryId: OID,
  },
  { timestamps: true },
);
journalDraftSchema.index({ companyId: 1, status: 1, _id: -1 });
export const JournalDraftModel = tenantModel('JournalDraft', journalDraftSchema);
