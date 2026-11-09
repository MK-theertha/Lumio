import mongoose, { Schema } from 'mongoose';
import { tenantGuardPlugin } from '../../../database/plugins/tenant-guard.js';

export interface NumberSeries {
  companyId: mongoose.Types.ObjectId;
  scopeKey: string;
  last: number;
}

const numberSeriesSchema = new Schema<NumberSeries>(
  {
    companyId: { type: Schema.Types.ObjectId, required: true },
    scopeKey: { type: String, required: true },
    last: { type: Number, required: true, default: 0 },
  },
  { collection: 'numberSeries', versionKey: false, strict: 'throw' },
);

numberSeriesSchema.index({ companyId: 1, scopeKey: 1 }, { unique: true });
numberSeriesSchema.plugin(tenantGuardPlugin);

export const NumberSeriesModel = mongoose.model<NumberSeries>('NumberSeries', numberSeriesSchema);
