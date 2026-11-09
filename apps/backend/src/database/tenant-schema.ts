import mongoose, { Schema, type Model, type SchemaDefinition } from 'mongoose';
import { ConflictError } from '../shared/errors.js';
import { tenantGuardPlugin } from './plugins/tenant-guard.js';

export const D128 = { type: Schema.Types.Decimal128 };
export const RD128 = { type: Schema.Types.Decimal128, required: true };
export const OID = { type: Schema.Types.ObjectId };
export const ROID = { type: Schema.Types.ObjectId, required: true };
export const RS = { type: String, required: true };

const UPDATE_HOOKS = [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'findOneAndReplace',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
] as const;

/** Application-level refusal of changes. The MongoDB role in infrastructure/mongo is the backstop. */
export function appendOnlyPlugin(schema: Schema): void {
  for (const hook of UPDATE_HOOKS) {
    schema.pre(hook, function () {
      throw new ConflictError('This record is immutable. Post a reversing entry instead.');
    });
  }
}

export function tenantSchema(
  collection: string,
  definition: SchemaDefinition,
  options: { timestamps?: boolean; appendOnly?: boolean } = {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- definitions are built dynamically, so inference is unavailable
): Schema<any> {
  const schema = new Schema(
    { companyId: ROID, ...definition },
    {
      collection,
      versionKey: false,
      strict: 'throw',
      timestamps: options.timestamps ?? false,
    },
  );
  schema.plugin(tenantGuardPlugin);
  if (options.appendOnly) schema.plugin(appendOnlyPlugin);
  return schema;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see tenantSchema; services type their own reads
export const tenantModel = (name: string, schema: Schema<any>): Model<any> =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mongoose.model<any>(name, schema) as unknown as Model<any>;
