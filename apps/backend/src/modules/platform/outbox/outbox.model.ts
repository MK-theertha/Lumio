import mongoose, { Schema } from 'mongoose';

export type OutboxStatus = 'PENDING' | 'PROCESSING' | 'PUBLISHED' | 'FAILED';

export interface OutboxEvent {
  companyId: mongoose.Types.ObjectId;
  type: string;
  payload: unknown;
  correlationId: string;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt: Date;
  lockedUntil?: Date;
  processedAt?: Date;
  lastError?: string;
}

const RETAIN_PUBLISHED_SECONDS = 30 * 24 * 60 * 60;

// Deliberately has no tenant guard: the relay is a platform process that spans all companies.
const outboxEventSchema = new Schema<OutboxEvent>(
  {
    companyId: { type: Schema.Types.ObjectId, required: true },
    type: { type: String, required: true },
    payload: Schema.Types.Mixed,
    correlationId: { type: String, required: true },
    status: {
      type: String,
      enum: ['PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED'],
      required: true,
    },
    attempts: { type: Number, required: true },
    nextAttemptAt: { type: Date, required: true },
    lockedUntil: Date,
    processedAt: Date,
    lastError: String,
  },
  { collection: 'outboxEvents', versionKey: false, strict: 'throw' },
);

outboxEventSchema.index({ status: 1, nextAttemptAt: 1 });
outboxEventSchema.index({ status: 1, lockedUntil: 1 });
outboxEventSchema.index({ processedAt: 1 }, { expireAfterSeconds: RETAIN_PUBLISHED_SECONDS });

export const OutboxEventModel = mongoose.model<OutboxEvent>('OutboxEvent', outboxEventSchema);
