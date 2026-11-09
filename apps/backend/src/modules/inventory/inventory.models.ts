import {
  D128,
  OID,
  RD128,
  ROID,
  RS,
  tenantSchema,
  tenantModel,
} from '../../database/tenant-schema.js';

const stockBalanceSchema = tenantSchema('stockBalances', {
  branchId: ROID,
  warehouseId: ROID,
  location: RS,
  productId: ROID,
  purityId: ROID,
  lotId: OID,
  pieces: { type: Number, required: true },
  gross: RD128,
  net: RD128,
  fine: RD128,
  availableNet: RD128,
  reservedNet: RD128,
  cost: RD128,
});
stockBalanceSchema.index(
  { companyId: 1, warehouseId: 1, location: 1, productId: 1, purityId: 1, lotId: 1 },
  { unique: true },
);
stockBalanceSchema.index({ companyId: 1, productId: 1 });
export const StockBalanceModel = tenantModel('StockBalance', stockBalanceSchema);

const stockMovementSchema = tenantSchema(
  'stockMovements',
  {
    type: RS,
    branchId: ROID,
    warehouseId: ROID,
    location: RS,
    productId: ROID,
    purityId: ROID,
    lotId: OID,
    stockItemId: OID,
    pieces: { type: Number, required: true },
    gross: RD128,
    net: RD128,
    fine: RD128,
    cost: RD128,
    sourceType: RS,
    sourceId: RS,
    lineId: RS,
    actorId: RS,
    at: { type: Date, required: true },
  },
  { appendOnly: true },
);
stockMovementSchema.index(
  { companyId: 1, sourceType: 1, sourceId: 1, lineId: 1, type: 1 },
  { unique: true },
);
stockMovementSchema.index({ companyId: 1, productId: 1, at: -1 });
stockMovementSchema.index({ companyId: 1, at: -1 });
export const StockMovementModel = tenantModel('StockMovement', stockMovementSchema);

const stockLotSchema = tenantSchema(
  'stockLots',
  { lotNo: RS, productId: ROID, purityId: ROID, sourceType: String, sourceId: String },
  { timestamps: true },
);
stockLotSchema.index({ companyId: 1, lotNo: 1 }, { unique: true });
export const StockLotModel = tenantModel('StockLot', stockLotSchema);

const stockItemSchema = tenantSchema(
  'stockItems',
  {
    tag: RS,
    productId: ROID,
    purityId: ROID,
    branchId: ROID,
    warehouseId: ROID,
    location: RS,
    gross: RD128,
    stone: RD128,
    net: RD128,
    fine: RD128,
    cost: RD128,
    status: {
      type: String,
      enum: ['IN_STOCK', 'RESERVED', 'ISSUED', 'IN_TRANSIT'],
      required: true,
    },
    issuedBy: String,
  },
  { timestamps: true },
);
stockItemSchema.index({ companyId: 1, tag: 1 }, { unique: true });
stockItemSchema.index({ companyId: 1, warehouseId: 1, status: 1 });
export const StockItemModel = tenantModel('StockItem', stockItemSchema);

const stockReservationSchema = tenantSchema(
  'stockReservations',
  {
    balanceId: ROID,
    netWeight: RD128,
    reference: RS,
    expiresAt: Date,
    status: { type: String, enum: ['ACTIVE', 'RELEASED'], required: true },
  },
  { timestamps: true },
);
stockReservationSchema.index({ companyId: 1, status: 1, expiresAt: 1 });
export const StockReservationModel = tenantModel('StockReservation', stockReservationSchema);

const workflow = { status: RS, createdBy: RS, decidedBy: String };

const stockAdjustmentSchema = tenantSchema(
  'stockAdjustments',
  { ...workflow, payload: { type: Object, required: true }, costApplied: D128 },
  { timestamps: true },
);
stockAdjustmentSchema.index({ companyId: 1, status: 1, _id: -1 });
export const StockAdjustmentModel = tenantModel('StockAdjustment', stockAdjustmentSchema);

const stockTransferSchema = tenantSchema(
  'stockTransfers',
  {
    ...workflow,
    fromWarehouseId: ROID,
    toWarehouseId: ROID,
    location: RS,
    lines: { type: [Object], required: true },
  },
  { timestamps: true },
);
stockTransferSchema.index({ companyId: 1, status: 1, _id: -1 });
export const StockTransferModel = tenantModel('StockTransfer', stockTransferSchema);

const stockCountSchema = tenantSchema(
  'stockCounts',
  { ...workflow, warehouseId: ROID, location: RS, lines: { type: [Object], required: true } },
  { timestamps: true },
);
stockCountSchema.index({ companyId: 1, status: 1, _id: -1 });
export const StockCountModel = tenantModel('StockCount', stockCountSchema);
