import { assertTransactional, type RequestContext } from '../../../shared/context.js';
import { OutboxEventModel } from './outbox.model.js';

/** Records an event atomically with the business change that caused it. */
export async function enqueueEvent(
  ctx: RequestContext,
  type: string,
  payload: unknown,
): Promise<void> {
  assertTransactional(ctx, 'enqueueEvent');
  await OutboxEventModel.create(
    [
      {
        companyId: ctx.companyId,
        type,
        payload,
        correlationId: ctx.correlationId,
        status: 'PENDING',
        attempts: 0,
        nextAttemptAt: new Date(),
      },
    ],
    { session: ctx.session },
  );
}
