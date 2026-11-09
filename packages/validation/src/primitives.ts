import { z } from 'zod';

/** Decimal values cross the API as strings so they are never parsed into floats. */
export const decimalString = z.string().regex(/^-?\d+(\.\d+)?$/, 'Must be a decimal string');

export const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, 'Must be a valid identifier');

export const idempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,128}$/, 'Must be 8-128 URL-safe characters');

export const correlationIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

export const MAX_PAGE_LIMIT = 200;

export const cursorPageQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(50),
  cursor: z.string().min(1).optional(),
});

const metaSchema = z.object({ correlationId: z.string() });

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.array(z.object({ path: z.string(), issue: z.string() })).optional(),
    correlationId: z.string(),
  }),
});

export function successEnvelope<T extends z.ZodType>(data: T) {
  return z.object({ data, meta: metaSchema });
}

const healthStatus = z.enum(['up', 'down']);

export const livenessSchema = z.object({ status: z.literal('up') });

export const readinessSchema = z.object({
  status: healthStatus,
  checks: z.record(z.string(), healthStatus),
});
