import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import type { Redis } from 'ioredis';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import type { Env } from './config/env.js';
import { correlationId } from './middleware/correlation-id.js';
import { createErrorHandler, notFoundHandler } from './middleware/error-handler.js';
import { rateLimit } from './middleware/rate-limit.js';
import { createHealthRouter, type HealthCheck } from './modules/health/index.js';
import { createApiRouter } from './routes/index.js';
import { buildOpenApiDocument } from './routes/openapi.js';
import type { Logger } from './shared/logger.js';

export interface AppDependencies {
  env: Pick<Env, 'NODE_ENV' | 'CORS_ORIGINS' | 'TRUST_PROXY_HOPS'>;
  logger: Logger;
  cacheRedis: Redis;
  healthChecks: Record<string, HealthCheck>;
  generalRateLimit?: { limit: number; windowMs: number };
  authRateLimit?: number;
}

export function createApp(deps: AppDependencies): Express {
  const { env, logger, cacheRedis, healthChecks } = deps;
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY_HOPS);

  app.use(correlationId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as express.Request).correlationId,
      // Paths only: query strings can carry personal data.
      serializers: {
        req: (req: { id: string; method: string; url: string }) => ({
          id: req.id,
          method: req.method,
          path: req.url.split('?')[0],
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );

  // Health probes come before rate limiting so orchestrators are never throttled.
  app.use('/healthz', createHealthRouter(healthChecks));

  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGINS, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  if (env.NODE_ENV !== 'production') {
    app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(buildOpenApiDocument()));
  }

  app.use(
    '/api/v1',
    rateLimit({
      redis: cacheRedis,
      logger,
      name: 'general',
      limit: deps.generalRateLimit?.limit ?? 600,
      windowMs: deps.generalRateLimit?.windowMs ?? 60_000,
      onStoreFailure: 'allow',
    }),
    createApiRouter({
      redis: cacheRedis,
      logger,
      allowedOrigins: env.CORS_ORIGINS,
      ...(deps.authRateLimit ? { authRateLimit: deps.authRateLimit } : {}),
    }),
  );

  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));
  return app;
}
