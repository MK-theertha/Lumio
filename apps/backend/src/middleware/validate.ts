import type { RequestHandler } from 'express';
import type { z } from 'zod';
import { ValidationError } from '../shared/errors.js';

interface RequestSchemas {
  body?: z.ZodType;
  query?: z.ZodType;
  params?: z.ZodType;
}

/** Parses request parts against their schemas and exposes only the result on `req.validated`. */
export function validate(schemas: RequestSchemas): RequestHandler {
  const handler: RequestHandler = (req, _res, next) => {
    req.validated = {};
    for (const part of ['body', 'query', 'params'] as const) {
      const schema = schemas[part];
      if (!schema) continue;
      const parsed = schema.safeParse(req[part]);
      if (!parsed.success) {
        throw new ValidationError(
          parsed.error.issues.map((issue) => ({
            path: [part, ...issue.path].join('.'),
            issue: issue.message,
          })),
        );
      }
      req.validated[part] = parsed.data;
    }
    next();
  };
  return Object.assign(handler, { requestSchemas: schemas });
}
