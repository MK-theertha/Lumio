import mongoose, {
  Schema,
  type InferRawDocType,
  type Model,
  type SchemaDefinition,
  type Types,
} from 'mongoose';
import { ConflictError } from '../shared/errors.js';
import { tenantGuardPlugin } from './plugins/tenant-guard.js';

export const D128 = { type: Schema.Types.Decimal128 } as const;
export const RD128 = { type: Schema.Types.Decimal128, required: true } as const;
export const OID = { type: Schema.Types.ObjectId } as const;
export const ROID = { type: Schema.Types.ObjectId, required: true } as const;
export const RS = { type: String, required: true } as const;

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

export type TenantDoc<D> = InferRawDocType<D & { companyId: typeof ROID }> & {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};

/** The type of each model comes from its schema, so services see the real field names. */
export function tenantSchema<const D extends Record<string, unknown>>(
  collection: string,
  definition: D,
  options: { timestamps?: boolean; appendOnly?: boolean } = {},
): Schema<TenantDoc<D>> {
  const schema = new Schema(
    { companyId: ROID, ...(definition as SchemaDefinition) },
    {
      collection,
      versionKey: false,
      strict: 'throw',
      timestamps: options.timestamps ?? false,
    },
  );
  schema.plugin(tenantGuardPlugin);
  if (options.appendOnly) schema.plugin(appendOnlyPlugin);
  return schema as unknown as Schema<TenantDoc<D>>;
}

export const tenantModel = <T>(name: string, schema: Schema<T>): Model<T> =>
  mongoose.model<T>(name, schema) as unknown as Model<T>;
