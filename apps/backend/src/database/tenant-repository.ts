import type { Model, PipelineStage, QueryFilter, UpdateQuery } from 'mongoose';
import type { RequestContext } from '../shared/context.js';

/**
 * Base for tenant-scoped repositories. Every method takes the context and applies its tenant and
 * session, so a concrete repository cannot forget either.
 */
export abstract class TenantRepository<T> {
  protected constructor(protected readonly model: Model<T>) {}

  protected scoped(ctx: RequestContext, filter: QueryFilter<T> = {}): QueryFilter<T> {
    return { ...filter, companyId: ctx.companyId } as QueryFilter<T>;
  }

  find(ctx: RequestContext, filter?: QueryFilter<T>) {
    return this.model.find(this.scoped(ctx, filter)).session(ctx.session ?? null);
  }

  findOne(ctx: RequestContext, filter?: QueryFilter<T>) {
    return this.model.findOne(this.scoped(ctx, filter)).session(ctx.session ?? null);
  }

  updateOne(ctx: RequestContext, filter: QueryFilter<T>, update: UpdateQuery<T>) {
    return this.model.updateOne(this.scoped(ctx, filter), update).session(ctx.session ?? null);
  }

  aggregate<R>(ctx: RequestContext, pipeline: PipelineStage[]) {
    const first: PipelineStage = { $match: { companyId: ctx.companyId } };
    return this.model.aggregate<R>([first, ...pipeline]).session(ctx.session ?? null);
  }
}
