import * as Sentry from '@sentry/node';
import { Redis } from 'ioredis';
import { createApp } from './app.js';
import { loadEnv } from './config/env.js';
import { initRuntime } from './config/runtime.js';
import { connectDatabase, disconnectDatabase, pingDatabase } from './database/connection.js';
import { createLogger } from './shared/logger.js';

const SHUTDOWN_TIMEOUT_MS = 25_000;

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL, 'api');
initRuntime(env);

if (env.SENTRY_DSN) Sentry.init({ dsn: env.SENTRY_DSN, environment: env.NODE_ENV });

await connectDatabase(env.MONGODB_URI);
const cacheRedis = new Redis(env.REDIS_CACHE_URL);
const queueRedis = new Redis(env.REDIS_QUEUE_URL);
for (const client of [cacheRedis, queueRedis]) {
  client.on('error', (error) => logger.error({ err: error }, 'Redis connection error'));
}

const app = createApp({
  env,
  logger,
  cacheRedis,
  healthChecks: {
    mongodb: pingDatabase,
    redisCache: () => cacheRedis.ping(),
    redisQueue: () => queueRedis.ping(),
  },
});

const server = app.listen(env.PORT, () => logger.info({ port: env.PORT }, 'API listening'));

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down');
  const forced = setTimeout(() => {
    logger.fatal('Graceful shutdown timed out');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forced.unref();

  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await disconnectDatabase();
  cacheRedis.disconnect();
  queueRedis.disconnect();
  logger.info('Shutdown complete');
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    shutdown(signal).catch((error: unknown) => {
      logger.fatal({ err: error }, 'Shutdown failed');
      process.exit(1);
    });
  });
}
