import { createServer } from 'node:http';
import { loadEnv } from '@lumio/backend/config/env.js';
import { initRuntime } from '@lumio/backend/config/runtime.js';
import {
  connectDatabase,
  disconnectDatabase,
  pingDatabase,
} from '@lumio/backend/database/connection.js';
import { OutboxEventModel, OutboxRelay } from '@lumio/backend/modules/platform/outbox/index.js';
import { createLogger } from '@lumio/backend/shared/logger.js';
import { observeGauge, startMetrics } from '@lumio/backend/shared/metrics.js';
import * as Sentry from '@sentry/node';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { createHandlers } from './handlers.js';
import {
  createEventWorker,
  createPublisher,
  DOMAIN_EVENTS_QUEUE,
  scheduleNightlyMaintenance,
  type EventQueue,
} from './queues.js';

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL, 'worker');
initRuntime(env);

if (env.SENTRY_DSN) Sentry.init({ dsn: env.SENTRY_DSN, environment: env.NODE_ENV });

await connectDatabase(env.MONGODB_URI);
const connection = new Redis(env.REDIS_QUEUE_URL, { maxRetriesPerRequest: null });
connection.on('error', (error) => logger.error({ err: error }, 'Redis connection error'));

const queue: EventQueue = new Queue(DOMAIN_EVENTS_QUEUE, { connection });
const { worker, deadLetters } = createEventWorker(connection, createHandlers(logger), logger);
const relay = new OutboxRelay(createPublisher(queue), logger);
relay.start();
await scheduleNightlyMaintenance(queue);
startMetrics(env.METRICS_PORT);
observeGauge('queue_waiting', () => queue.getWaitingCount());
observeGauge('queue_dead_letters', () =>
  deadLetters.getJobCounts('waiting').then((c) => c.waiting ?? 0),
);
observeGauge('outbox_pending', () => OutboxEventModel.countDocuments({ status: 'PENDING' }));

const health = createServer((req, res) => {
  if (req.url !== '/healthz/ready') {
    res.writeHead(404).end();
    return;
  }
  Promise.all([pingDatabase(), connection.ping()])
    .then(() => res.writeHead(200).end('up'))
    .catch(() => res.writeHead(503).end('down'));
}).listen(env.WORKER_HEALTH_PORT);

logger.info('Worker started');

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down');
  health.close();
  await relay.stop();
  await worker.close();
  await deadLetters.close();
  await queue.close();
  connection.disconnect();
  await disconnectDatabase();
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
