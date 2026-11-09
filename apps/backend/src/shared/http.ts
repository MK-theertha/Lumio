import type { ApiSuccess } from '@lumio/shared-types';
import type { Request, Response } from 'express';

export function sendSuccess<T>(req: Request, res: Response, data: T, status = 200): void {
  const body: ApiSuccess<T> = { data, meta: { correlationId: req.correlationId } };
  res.status(status).json(body);
}
