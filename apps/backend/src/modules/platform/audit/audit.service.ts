import { redactSensitive } from '@lumio/shared-utils';
import type { RequestContext } from '../../../shared/context.js';
import { AuditLogModel } from './audit.model.js';

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
}

/** Appends an audit row. Inside a transaction it commits or rolls back with the business change. */
export async function recordAudit(ctx: RequestContext, entry: AuditEntry): Promise<void> {
  await AuditLogModel.create(
    [
      {
        ...entry,
        before: redactSensitive(entry.before),
        after: redactSensitive(entry.after),
        companyId: ctx.companyId,
        actorId: ctx.userId,
        correlationId: ctx.correlationId,
        at: new Date(),
      },
    ],
    { session: ctx.session ?? null },
  );
}
