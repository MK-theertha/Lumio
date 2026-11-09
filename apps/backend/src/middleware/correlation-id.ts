import { randomUUID } from 'node:crypto';
import { correlationIdSchema } from '@lumio/validation';
import type { RequestHandler } from 'express';

export const CORRELATION_HEADER = 'X-Correlation-Id';

export const correlationId: RequestHandler = (req, res, next) => {
  const supplied = correlationIdSchema.safeParse(req.get(CORRELATION_HEADER));
  req.correlationId = supplied.success ? supplied.data : randomUUID();
  res.setHeader(CORRELATION_HEADER, req.correlationId);
  next();
};
