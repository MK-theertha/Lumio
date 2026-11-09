import { runtime } from '../../config/runtime.js';
import { randomUUID } from 'node:crypto';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  inviteUserSchema,
  loginSchema,
  mfaCodeSchema,
  mfaDisableSchema,
  mfaLoginSchema,
  objectIdSchema,
  resetPasswordSchema,
  switchCompanySchema,
  updateUserSchema,
} from '@lumio/validation';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import type { Redis } from 'ioredis';
import { Types } from 'mongoose';
import { z } from 'zod';
import { authenticate, requirePermission } from '../../middleware/auth.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { validate } from '../../middleware/validate.js';
import { AppError } from '../../shared/errors.js';
import { sendSuccess } from '../../shared/http.js';
import type { Logger } from '../../shared/logger.js';
import { plain } from '../../shared/serialize.js';
import {
  changePassword,
  inviteUser,
  listCompanyUsers,
  listSessions,
  requestPasswordReset,
  revokeSession,
  setPasswordWithToken,
  updateUser,
} from './account.service.js';
import {
  beginMfaEnrolment,
  completeMfa,
  confirmMfaEnrolment,
  describeUser,
  disableMfa,
  listUserCompanies,
  login,
  refresh,
  revokeSessionByToken,
  switchCompany,
  type LoginOutcome,
} from './auth.service.js';

const DEPLOYED = ['production', 'staging'];
const COOKIE = 'lumio_refresh';
const COOKIE_PATH = '/api/v1/auth';
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60 * 1000;

const client = (req: Request) => ({ ip: req.ip, device: req.get('user-agent')?.slice(0, 200) });
const validated = <T>(req: Request) => req.validated.body as T;

function readCookie(req: Request): string | undefined {
  return (req.cookies as Record<string, string> | undefined)?.[COOKIE];
}

function respond(req: Request, res: Response, outcome: LoginOutcome): void {
  if (outcome.mfaToken) {
    sendSuccess(req, res, { mfaRequired: true, mfaToken: outcome.mfaToken });
    return;
  }
  res.cookie(COOKIE, outcome.refreshToken, {
    httpOnly: true,
    // Never left to request headers in a deployed environment, where TLS ends at a proxy.
    secure: req.secure || DEPLOYED.includes(runtime().NODE_ENV),
    sameSite: 'strict',
    path: COOKIE_PATH,
    maxAge: COOKIE_MAX_AGE,
  });
  sendSuccess(req, res, outcome.auth);
}

/** The refresh cookie is the only ambient credential, so its routes need an explicit CSRF defence. */
function csrfGuard(allowedOrigins: string[]): RequestHandler {
  return (req, _res, next) => {
    const origin = req.get('origin');
    if (req.get('x-requested-with') !== 'lumio' || (origin && !allowedOrigins.includes(origin))) {
      throw new AppError(403, 'FORBIDDEN', 'Cross-site request refused.');
    }
    next();
  };
}

export function createAuthRouter(deps: {
  redis: Redis;
  logger: Logger;
  allowedOrigins: string[];
  authRateLimit?: number;
}): Router {
  const router = Router();
  const limit = rateLimit({
    redis: deps.redis,
    logger: deps.logger,
    name: 'auth',
    limit: deps.authRateLimit ?? 20,
    windowMs: 60_000,
    onStoreFailure: 'reject',
  });
  // Every page load refreshes the session, so this needs a far looser limit than password guessing.
  const refreshLimit = rateLimit({
    redis: deps.redis,
    logger: deps.logger,
    name: 'auth-refresh',
    limit: Math.max(deps.authRateLimit ?? 0, 300),
    windowMs: 60_000,
    onStoreFailure: 'reject',
  });
  const csrf = csrfGuard(deps.allowedOrigins);

  router.post('/login', limit, validate({ body: loginSchema }), async (req, res) => {
    const body = validated<z.infer<typeof loginSchema>>(req);
    respond(req, res, await login(body.email, body.password, client(req)));
  });

  router.post('/mfa', limit, validate({ body: mfaLoginSchema }), async (req, res) => {
    const body = validated<z.infer<typeof mfaLoginSchema>>(req);
    respond(req, res, await completeMfa(body.mfaToken, body.code, client(req)));
  });

  router.post('/refresh', refreshLimit, csrf, async (req, res) => {
    const token = readCookie(req);
    if (!token) throw new AppError(401, 'UNAUTHENTICATED', 'The session has expired.');
    respond(req, res, await refresh(token, client(req)));
  });

  router.post('/logout', csrf, async (req, res) => {
    const token = readCookie(req);
    if (token) await revokeSessionByToken(token);
    res.clearCookie(COOKIE, { path: COOKIE_PATH });
    res.status(204).end();
  });

  router.post(
    '/forgot-password',
    limit,
    validate({ body: forgotPasswordSchema }),
    async (req, res) => {
      const { email } = validated<{ email: string }>(req);
      await requestPasswordReset(email, {
        companyId: new Types.ObjectId('000000000000000000000000'),
        userId: 'system',
        branchScope: 'ALL',
        permissions: new Set(),
        correlationId: req.correlationId || randomUUID(),
      });
      sendSuccess(req, res, { sent: true });
    },
  );

  router.post(
    '/reset-password',
    limit,
    validate({ body: resetPasswordSchema }),
    async (req, res) => {
      const body = validated<z.infer<typeof resetPasswordSchema>>(req);
      await setPasswordWithToken(body.token, body.password);
      sendSuccess(req, res, { done: true });
    },
  );

  router.use(authenticate);

  router.get('/me', async (req, res) => {
    sendSuccess(req, res, await describeUser(req.auth.userId));
  });

  router.post('/change-password', validate({ body: changePasswordSchema }), async (req, res) => {
    const body = validated<z.infer<typeof changePasswordSchema>>(req);
    await changePassword(
      req.auth.userId,
      req.auth.sessionId,
      body.currentPassword,
      body.newPassword,
    );
    sendSuccess(req, res, { done: true });
  });

  router.get('/companies', async (req, res) => {
    sendSuccess(req, res, await listUserCompanies(req.auth.userId));
  });

  router.post('/switch-company', validate({ body: switchCompanySchema }), async (req, res) => {
    const { companyId } = validated<{ companyId: string }>(req);
    sendSuccess(req, res, await switchCompany(req.auth, companyId));
  });

  router.post('/mfa/enrol', async (req, res) => {
    sendSuccess(req, res, await beginMfaEnrolment(req.auth.userId));
  });

  router.post('/mfa/confirm', validate({ body: mfaCodeSchema }), async (req, res) => {
    const { code } = validated<{ code: string }>(req);
    sendSuccess(req, res, { recoveryCodes: await confirmMfaEnrolment(req.auth.userId, code) });
  });

  router.post('/mfa/disable', validate({ body: mfaDisableSchema }), async (req, res) => {
    await disableMfa(req.auth.userId, validated<{ password: string }>(req).password);
    sendSuccess(req, res, { done: true });
  });

  router.get('/sessions', async (req, res) => {
    const sessions = plain<{ id: string }[]>(await listSessions(req.auth.userId));
    sendSuccess(
      req,
      res,
      sessions.map((s) => ({ ...s, current: s.id === req.auth.sessionId })),
    );
  });

  router.delete(
    '/sessions/:id',
    validate({ params: z.object({ id: objectIdSchema }) }),
    async (req, res) => {
      await revokeSession(req.auth.userId, String(req.params.id));
      res.status(204).end();
    },
  );

  return router;
}

export function createUsersRouter(): Router {
  const router = Router();
  router.use(requirePermission('users:manage'));

  router.get('/', async (req, res) => {
    sendSuccess(req, res, plain(await listCompanyUsers(req.ctx)));
  });

  router.post('/', validate({ body: inviteUserSchema }), async (req, res) => {
    const body = validated<z.infer<typeof inviteUserSchema>>(req);
    sendSuccess(req, res, await inviteUser(req.ctx, body), 201);
  });

  router.patch(
    '/:id',
    validate({ params: z.object({ id: objectIdSchema }), body: updateUserSchema }),
    async (req, res) => {
      await updateUser(
        req.ctx,
        String(req.params.id),
        validated<z.infer<typeof updateUserSchema>>(req),
      );
      sendSuccess(req, res, { done: true });
    },
  );

  return router;
}
