import type { ClientSession, Types } from 'mongoose';
import { AppError } from './errors.js';

/**
 * The verified identity and scope of the current operation. Built by middleware from authenticated
 * data only, never from request parameters, and passed explicitly through services and repositories.
 */
export interface RequestContext {
  readonly companyId: Types.ObjectId;
  readonly userId: string;
  readonly branchScope: 'ALL' | readonly Types.ObjectId[];
  readonly permissions: ReadonlySet<string>;
  readonly correlationId: string;
  readonly session?: ClientSession;
}

export interface TransactionalContext extends RequestContext {
  readonly session: ClientSession;
}

export function assertBranchAccess(ctx: RequestContext, branchId: Types.ObjectId | string): void {
  if (ctx.branchScope === 'ALL') return;
  if (!ctx.branchScope.some((id) => id.toString() === branchId.toString())) {
    throw new AppError(404, 'NOT_FOUND', 'The requested resource was not found.');
  }
}

export function assertTransactional(
  ctx: RequestContext,
  operation: string,
): asserts ctx is TransactionalContext {
  if (!ctx.session) throw new Error(`${operation} must run inside a transaction`);
}
