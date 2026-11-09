import type { PublishableEvent, Publisher } from '@lumio/backend/modules/platform/outbox/index.js';
import { NIGHTLY_EVENT } from '@lumio/backend/modules/maintenance/index.js';
import { countJob } from '@lumio/backend/shared/metrics.js';
import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';
import type { Logger } from 'pino';

export const DOMAIN_EVENTS_QUEUE = 'domain-events';
export const DEAD_LETTER_QUEUE = 'dead-letter';

export type EventQueue = Queue<PublishableEvent, void, string>;
export type EventHandler = (event: PublishableEvent) => Promise<void>;

export interface RetryPolicy {
  attempts: number;
  backoffMs: number;
}

const DEFAULT_RETRY: RetryPolicy = { attempts: 5, backoffMs: 1000 };

export function createPublisher(queue: EventQueue, retry = DEFAULT_RETRY): Publisher {
  return async (event) => {
    await queue.add(event.type, event, {
      // The event id as job id makes a repeated publish from the relay a no-op.
      jobId: event.id,
      attempts: retry.attempts,
      backoff: { type: 'exponential', delay: retry.backoffMs },
      removeOnComplete: { count: 1000 },
      removeOnFail: false,
    });
  };
}

/** Repeating job. Redis keeps the schedule, so several workers still produce one run a night. */
export async function scheduleNightlyMaintenance(queue: EventQueue): Promise<void> {
  await queue.upsertJobScheduler(
    'nightly-maintenance',
    { pattern: '0 2 * * *', tz: 'Asia/Dubai' },
    {
      name: NIGHTLY_EVENT,
      data: {
        id: 'nightly',
        companyId: '',
        type: NIGHTLY_EVENT,
        payload: {},
        correlationId: 'nightly-maintenance',
      },
    },
  );
}

export function createEventWorker(
  connection: ConnectionOptions,
  handlers: Record<string, EventHandler>,
  logger: Logger,
): { worker: Worker<PublishableEvent, void, string>; deadLetters: Queue } {
  const deadLetters = new Queue(DEAD_LETTER_QUEUE, { connection });

  const worker = new Worker<PublishableEvent, void, string>(
    DOMAIN_EVENTS_QUEUE,
    async (job: Job<PublishableEvent, void, string>) => {
      const handler = handlers[job.data.type];
      if (handler) await handler(job.data);
    },
    { connection, concurrency: 10 },
  );

  worker.on('completed', (job) => countJob('completed', { type: job.data.type }));
  worker.on('failed', (job, error) => {
    if (!job) return;
    countJob('failed', { type: job.data.type });
    const exhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
    logger.error({ jobId: job.id, type: job.data.type, exhausted, err: error }, 'Job failed');
    if (exhausted) {
      deadLetters
        .add('dead', { event: job.data, reason: error.message }, { jobId: job.id ?? job.data.id })
        .catch((dlqError: unknown) => {
          logger.fatal({ err: dlqError, jobId: job.id }, 'Could not record dead letter');
        });
    }
  });

  return { worker, deadLetters };
}
