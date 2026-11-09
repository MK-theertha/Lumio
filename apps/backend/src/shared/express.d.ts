import 'express';
import type { RequestContext } from './context.js';

declare global {
  namespace Express {
    interface Request {
      correlationId: string;
      ctx: RequestContext;
      auth: { userId: string; sessionId: string; companyId: string | null };
      validated: { body?: unknown; query?: unknown; params?: unknown };
    }
  }
}
