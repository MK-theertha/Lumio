import { randomUUID } from 'node:crypto';
import { Router, type Express } from 'express';
import type { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTestRedis, silentLogger } from '../test/harness.js';
import { createApp, type AppDependencies } from './app.js';
import { rateLimit } from './middleware/rate-limit.js';
import { validate } from './middleware/validate.js';
import { BusinessRuleError } from './shared/errors.js';

let redis: Redis;

function buildApp(overrides: Partial<AppDependencies> = {}): Express {
  return createApp({
    env: { NODE_ENV: 'test', CORS_ORIGINS: ['https://erp.example.com'], TRUST_PROXY_HOPS: 0 },
    logger: silentLogger,
    cacheRedis: redis,
    healthChecks: { mongodb: async () => undefined, redisCache: () => redis.ping() },
    ...overrides,
  });
}

beforeAll(() => {
  redis = createTestRedis();
});
afterAll(() => {
  redis.disconnect();
});

describe('health endpoints', () => {
  it('reports liveness with no dependency checks', async () => {
    const app = buildApp({
      healthChecks: { mongodb: () => Promise.reject(new Error('down')) },
    });
    const res = await request(app).get('/healthz/live');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ status: 'up' });
  });

  it('reports ready when dependencies respond', async () => {
    const res = await request(buildApp()).get('/healthz/ready');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      status: 'up',
      checks: { mongodb: 'up', redisCache: 'up' },
    });
  });

  it('returns 503 naming the failed dependency, without internal detail', async () => {
    const app = buildApp({
      healthChecks: {
        mongodb: () => Promise.reject(new Error('mongodb://user:hunter2@host failed')),
      },
    });
    const res = await request(app).get('/healthz/ready');
    expect(res.status).toBe(503);
    expect(res.body.data.checks.mongodb).toBe('down');
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
  });
});

describe('request pipeline', () => {
  it('echoes a valid correlation id and replaces an invalid one', async () => {
    const app = buildApp();
    const valid = await request(app).get('/healthz/live').set('X-Correlation-Id', 'abc-12345678');
    expect(valid.headers['x-correlation-id']).toBe('abc-12345678');
    expect(valid.body.meta.correlationId).toBe('abc-12345678');

    const invalid = await request(app).get('/healthz/live').set('X-Correlation-Id', 'bad id!');
    expect(invalid.headers['x-correlation-id']).not.toBe('bad id!');
  });

  it('returns the error envelope for unknown routes', async () => {
    const res = await request(buildApp()).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: 'NOT_FOUND' });
    expect(res.body.error.correlationId).toBeTruthy();
  });

  it('rejects malformed JSON with 400, not 500', async () => {
    const res = await request(buildApp())
      .post('/api/v1/anything')
      .set('Content-Type', 'application/json')
      .send('{"broken":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MALFORMED_REQUEST');
  });

  it('sets security headers on API responses and hides the framework', async () => {
    const res = await request(buildApp()).get('/nope');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('allows configured CORS origins only', async () => {
    const app = buildApp();
    const allowed = await request(app).get('/api/v1/x').set('Origin', 'https://erp.example.com');
    expect(allowed.headers['access-control-allow-origin']).toBe('https://erp.example.com');
    const denied = await request(app).get('/api/v1/x').set('Origin', 'https://evil.example.com');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('applies the general rate limit to the API', async () => {
    const app = buildApp({ generalRateLimit: { limit: 2, windowMs: 60_000 } });
    await redis.flushall();
    await request(app).get('/api/v1/x');
    await request(app).get('/api/v1/x');
    const res = await request(app).get('/api/v1/x');
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
  });
});

describe('middleware behaviour on error paths', () => {
  /** Mounts a route on a fresh app that uses the real error handler. */
  async function appWith(mount: (router: Router) => void) {
    const { default: express } = await import('express');
    const { correlationId } = await import('./middleware/correlation-id.js');
    const { createErrorHandler } = await import('./middleware/error-handler.js');
    const app = express();
    const router = Router();
    mount(router);
    app.use(correlationId, express.json(), router, createErrorHandler(silentLogger));
    return app;
  }

  it('maps validation failures to field-level details', async () => {
    const app = await appWith((r) =>
      r.post('/t', validate({ body: z.strictObject({ qty: z.string() }) }), (_q, s) => {
        s.sendStatus(204);
      }),
    );
    const res = await request(app).post('/t').send({ qty: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.details[0].path).toBe('body.qty');
  });

  it('passes the business error status and code through', async () => {
    const app = await appWith((r) =>
      r.get('/t', () => {
        throw new BusinessRuleError('Not enough stock');
      }),
    );
    const res = await request(app).get('/t');
    expect(res.status).toBe(422);
    expect(res.body.error.message).toBe('Not enough stock');
  });

  it('never leaks internal error messages', async () => {
    const app = await appWith((r) =>
      r.get('/t', () => {
        throw new Error('mongodb://user:hunter2@host exploded');
      }),
    );
    const res = await request(app).get('/t');
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
  });

  it('fails closed or open according to the limiter configuration', async () => {
    const broken = {
      eval: () => Promise.reject(new Error('redis down')),
    } as unknown as Redis;
    const options = {
      redis: broken,
      logger: silentLogger,
      name: randomUUID(),
      limit: 1,
      windowMs: 1000,
    };
    const app = await appWith((r) => {
      r.get('/open', rateLimit({ ...options, onStoreFailure: 'allow' }), (_q, s) => {
        s.sendStatus(204);
      });
      r.get('/closed', rateLimit({ ...options, onStoreFailure: 'reject' }), (_q, s) => {
        s.sendStatus(204);
      });
    });
    expect((await request(app).get('/open')).status).toBe(204);
    expect((await request(app).get('/closed')).status).toBe(503);
  });
});
