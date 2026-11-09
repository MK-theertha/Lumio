import { createHash } from 'node:crypto';
import { ErrorCode } from '@lumio/shared-types';
import { canonicalJson } from '@lumio/shared-utils';
import { retryDuplicateKeyInTransaction, runInTransaction } from '../../../database/transaction.js';
import type { RequestContext, TransactionalContext } from '../../../shared/context.js';
import { BusinessRuleError } from '../../../shared/errors.js';
import { IdempotencyKeyModel } from './idempotency.model.js';

const KEY_LIFETIME_MS = 72 * 60 * 60 * 1000;

export interface IdempotentResult<T> {
  result: T;
  replayed: boolean;
}

/**
 * Executes `work` at most once per key. The key is claimed in the same transaction as the work, so
 * a crash can never leave a claim without its effect. Concurrent duplicates conflict on the unique
 * index, retry, and then replay the winner's stored response.
 */
export async function executeIdempotent<T>(
  ctx: RequestContext,
  key: string,
  request: unknown,
  work: (tx: TransactionalContext) => Promise<T>,
): Promise<IdempotentResult<T>> {
  const requestHash = createHash('sha256').update(canonicalJson(request)).digest('hex');
  const identity = { companyId: ctx.companyId, userId: ctx.userId, key };

  return runInTransaction(ctx, async (tx) => {
    const existing = await IdempotencyKeyModel.findOne(identity).session(tx.session).lean();
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new BusinessRuleError(
          'This idempotency key was already used for a different request.',
          ErrorCode.IDEMPOTENCY_KEY_REUSED,
        );
      }
      return { result: JSON.parse(existing.response ?? 'null') as T, replayed: true };
    }

    await IdempotencyKeyModel.create(
      [{ ...identity, requestHash, expiresAt: new Date(Date.now() + KEY_LIFETIME_MS) }],
      { session: tx.session },
    ).catch(retryDuplicateKeyInTransaction);

    const output = await work(tx);
    const response = JSON.stringify(output ?? null);
    await IdempotencyKeyModel.updateOne(identity, { $set: { response } }, { session: tx.session });
    return { result: JSON.parse(response) as T, replayed: false };
  });
}
