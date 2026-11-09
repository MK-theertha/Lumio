import { Schema } from 'mongoose';
import {
  D128,
  OID,
  RD128,
  ROID,
  RS,
  tenantSchema,
  tenantModel,
} from '../../database/tenant-schema.js';

const lineSchema = new Schema(
  {
    lineId: RS,
    productId: ROID,
    productName: RS,
    sku: RS,
    kind: RS,
    tracking: RS,
    purityId: ROID,
    purityLabel: RS,
    fineness: RD128,
    warehouseId: ROID,
    location: RS,
    stockItemId: OID,
    lotId: OID,
    lotNo: String,
    tag: String,
    pieces: { type: Number, required: true },
    grossWeight: RD128,
    stoneWeight: RD128,
    netWeight: RD128,
    fineWeight: RD128,
    goldValue: RD128,
    wastageValue: RD128,
    makingCharge: RD128,
    discount: RD128,
    taxableValue: RD128,
    taxAmount: RD128,
    notionalTax: RD128,
    lineTotal: RD128,
    costAtIssue: D128,
    taxCode: RS,
    taxTreatment: RS,
    taxRatePercent: RD128,
    returned: { type: Boolean, default: false },
    // Which lots a line drew from, so a return can restore exactly those.
    allocations: { type: [Schema.Types.Mixed], default: [] },
    // The exact basis of this line, preserved permanently: rate, source, policy and engine trace.
    input: { type: Schema.Types.Mixed, required: true },
    snapshot: { type: Schema.Types.Mixed, required: true },
  },
  { _id: false },
);

const STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'POSTED',
  'PARTIALLY_RETURNED',
  'RETURNED',
  'VOID',
];

function tradeSchema(collection: string) {
  const schema = tenantSchema(
    collection,
    {
      number: String,
      status: { type: String, enum: STATUSES, required: true },
      partyId: ROID,
      partySnapshot: { type: Schema.Types.Mixed, required: true },
      branchId: ROID,
      currency: RS,
      docDate: { type: Date, required: true },
      dueDate: Date,
      supplierInvoiceNo: String,
      lines: { type: [lineSchema], required: true },
      plannedPayments: { type: [Schema.Types.Mixed], default: [] },
      taxableTotal: RD128,
      taxTotal: RD128,
      discountTotal: RD128,
      grandTotal: RD128,
      notes: String,
      createdBy: RS,
      approvedBy: String,
      postedBy: String,
      postedAt: Date,
      postedHash: String,
      journalEntryId: OID,
      openItemId: OID,
    },
    { timestamps: true },
  );
  schema.index(
    { companyId: 1, number: 1 },
    { unique: true, partialFilterExpression: { number: { $type: 'string' } } },
  );
  schema.index({ companyId: 1, status: 1, docDate: -1 });
  schema.index({ companyId: 1, branchId: 1, docDate: -1 });
  schema.index({ companyId: 1, partyId: 1, docDate: -1 });
  return schema;
}

const purchaseSchema = tradeSchema('purchaseInvoices');
purchaseSchema.index(
  { companyId: 1, partyId: 1, supplierInvoiceNo: 1 },
  { unique: true, partialFilterExpression: { supplierInvoiceNo: { $type: 'string' } } },
);

export const SalesInvoiceModel = tenantModel('SalesInvoice', tradeSchema('salesInvoices'));
export const PurchaseInvoiceModel = tenantModel('PurchaseInvoice', purchaseSchema);

const creditNoteSchema = tenantSchema(
  'creditNotes',
  {
    number: RS,
    kind: { type: String, enum: ['CUSTOMER', 'SUPPLIER'], required: true },
    originalId: ROID,
    originalNumber: RS,
    partyId: ROID,
    branchId: ROID,
    docDate: { type: Date, required: true },
    reason: RS,
    lineIds: { type: [String], required: true },
    taxable: RD128,
    tax: RD128,
    total: RD128,
    journalEntryId: ROID,
    createdBy: RS,
  },
  { timestamps: true },
);
creditNoteSchema.index({ companyId: 1, number: 1 }, { unique: true });
creditNoteSchema.index({ companyId: 1, originalId: 1 });
export const CreditNoteModel = tenantModel('CreditNote', creditNoteSchema);

const purchaseOrderSchema = tenantSchema(
  'purchaseOrders',
  {
    number: RS,
    partyId: ROID,
    branchId: ROID,
    orderDate: { type: Date, required: true },
    status: { type: String, enum: ['OPEN', 'CLOSED', 'CANCELLED'], required: true },
    notes: String,
    lines: { type: [Schema.Types.Mixed], required: true },
    createdBy: RS,
  },
  { timestamps: true },
);
purchaseOrderSchema.index({ companyId: 1, number: 1 }, { unique: true });
export const PurchaseOrderModel = tenantModel('PurchaseOrder', purchaseOrderSchema);
