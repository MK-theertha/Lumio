import { ErrorCode } from '@lumio/shared-types';
import { idempotencyKeySchema } from '@lumio/validation';
import type { Request } from 'express';
import { AppError } from './errors.js';

export function idempotencyKeyOf(req: Request): string {
  const parsed = idempotencyKeySchema.safeParse(req.get('idempotency-key'));
  if (!parsed.success) {
    throw new AppError(
      400,
      ErrorCode.IDEMPOTENCY_KEY_REQUIRED,
      'A valid Idempotency-Key header is required for this operation.',
    );
  }
  return parsed.data;
}
