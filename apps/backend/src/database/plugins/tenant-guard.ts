import { Types, type Aggregate, type Query, type Schema } from 'mongoose';
import { TenantGuardError } from '../../shared/errors.js';

const QUERY_OPERATIONS = [
  'find',
  'findOne',
  'findOneAndUpdate',
  'findOneAndDelete',
  'findOneAndReplace',
  'updateOne',
  'updateMany',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'countDocuments',
  'distinct',
] as const;

const CROSS_COLLECTION_STAGES = ['$lookup', '$graphLookup', '$unionWith'] as const;

function isConcreteTenant(value: unknown): boolean {
  return value instanceof Types.ObjectId || typeof value === 'string';
}

function hasTenant(filter: unknown): boolean {
  return isConcreteTenant((filter as { companyId?: unknown } | undefined)?.companyId);
}

function assertAggregateScoped(pipeline: Record<string, unknown>[], model: string): void {
  if (!hasTenant(pipeline[0]?.$match)) throw new TenantGuardError(model, 'aggregate');
  for (const stage of pipeline) {
    for (const operator of CROSS_COLLECTION_STAGES) {
      if (stage[operator] && !JSON.stringify(stage[operator]).includes('companyId')) {
        throw new TenantGuardError(model, operator);
      }
    }
  }
}

/**
 * Backstop for tenant isolation: rejects any operation that reaches the driver without a concrete
 * companyId. It has no bypass. Platform-wide collections simply do not use this plugin.
 */
export function tenantGuardPlugin(schema: Schema): void {
  if (!schema.path('companyId')) throw new Error('Tenant-scoped schemas require a companyId path');

  for (const operation of QUERY_OPERATIONS) {
    schema.pre(operation, function (this: Query<unknown, unknown>) {
      if (!hasTenant(this.getFilter())) throw new TenantGuardError(this.model.modelName, operation);
    });
  }

  schema.pre('estimatedDocumentCount', function (this: Query<unknown, unknown>) {
    throw new TenantGuardError(this.model.modelName, 'estimatedDocumentCount');
  });

  schema.pre('aggregate', function (this: Aggregate<unknown>) {
    const pipeline = this.pipeline() as unknown as Record<string, unknown>[];
    assertAggregateScoped(pipeline, this.model().modelName);
  });

  // The published types omit the model-level bulkWrite hook.
  const preBulkWrite = schema.pre.bind(schema) as unknown as (
    name: 'bulkWrite',
    hook: (ops: Record<string, Record<string, unknown>>[]) => void,
  ) => void;
  preBulkWrite('bulkWrite', (ops) => {
    for (const op of ops) {
      const [operation, body] = Object.entries(op)[0] as [string, Record<string, unknown>];
      const scoped = operation === 'insertOne' ? hasTenant(body.document) : hasTenant(body.filter);
      if (!scoped) throw new TenantGuardError(schema.get('collection') ?? 'unknown', 'bulkWrite');
    }
  });
}
