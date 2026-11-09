import mongoose from 'mongoose';
import type { RequestContext, TransactionalContext } from '../shared/context.js';

const DUPLICATE_KEY = 11000;

/**
 * Runs `work` in a snapshot-isolation, majority-write transaction. The driver retries the callback
 * on transient errors, so `work` must not perform external side effects; use the outbox for those.
 * A nested call joins the enclosing transaction.
 */
export async function runInTransaction<T>(
  ctx: RequestContext,
  work: (tx: TransactionalContext) => Promise<T>,
): Promise<T> {
  if (ctx.session) return work(ctx as TransactionalContext);

  const session = await mongoose.startSession();
  try {
    let result: T | undefined;
    await session.withTransaction(
      async () => {
        result = await work({ ...ctx, session });
      },
      {
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
        readPreference: 'primary',
      },
    );
    return result as T;
  } finally {
    await session.endSession();
  }
}

/**
 * When concurrent transactions race to create the same unique document, the loser can fail with
 * a duplicate-key error that the driver would not retry. Marking it transient makes the retry
 * observe the winner's committed document.
 */
export function retryDuplicateKeyInTransaction(error: unknown): never {
  if (error instanceof mongoose.mongo.MongoServerError && error.code === DUPLICATE_KEY) {
    error.addErrorLabel('TransientTransactionError');
  }
  throw error;
}
