import mongoose, { Schema } from 'mongoose';
import { tenantGuardPlugin } from '../../../database/plugins/tenant-guard.js';

export interface IdempotencyKey {
  companyId: mongoose.Types.ObjectId;
  userId: string;
  key: string;
  requestHash: string;
  /** Stored as JSON text so replays are byte-for-byte what the first caller received. */
  response?: string;
  expiresAt: Date;
}

const idempotencyKeySchema = new Schema<IdempotencyKey>(
  {
    companyId: { type: Schema.Types.ObjectId, required: true },
    userId: { type: String, required: true },
    key: { type: String, required: true },
    requestHash: { type: String, required: true },
    response: String,
    expiresAt: { type: Date, required: true },
  },
  { collection: 'idempotencyKeys', versionKey: false, strict: 'throw' },
);

idempotencyKeySchema.index({ companyId: 1, userId: 1, key: 1 }, { unique: true });
idempotencyKeySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
idempotencyKeySchema.plugin(tenantGuardPlugin);

export const IdempotencyKeyModel = mongoose.model<IdempotencyKey>(
  'IdempotencyKey',
  idempotencyKeySchema,
);
