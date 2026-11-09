import mongoose, { Schema } from 'mongoose';
import { tenantGuardPlugin } from '../../../database/plugins/tenant-guard.js';

export interface AuditLog {
  companyId: mongoose.Types.ObjectId;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  correlationId: string;
  at: Date;
}

const auditLogSchema = new Schema<AuditLog>(
  {
    companyId: { type: Schema.Types.ObjectId, required: true },
    actorId: { type: String, required: true },
    action: { type: String, required: true },
    entityType: { type: String, required: true },
    entityId: { type: String, required: true },
    before: Schema.Types.Mixed,
    after: Schema.Types.Mixed,
    correlationId: { type: String, required: true },
    at: { type: Date, required: true },
  },
  { collection: 'auditLogs', versionKey: false, strict: 'throw' },
);

auditLogSchema.index({ companyId: 1, entityType: 1, entityId: 1, at: -1 });
auditLogSchema.index({ companyId: 1, actorId: 1, at: -1 });
auditLogSchema.plugin(tenantGuardPlugin);

export const AuditLogModel = mongoose.model<AuditLog>('AuditLog', auditLogSchema);
