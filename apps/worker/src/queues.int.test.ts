import { randomUUID } from 'node:crypto';
import type { PublishableEvent } from '@lumio/backend/modules/platform/outbox/index.js';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createEventWorker,
  createPublisher,
  DEAD_LETTER_QUEUE,
  DOMAIN_EVENTS_QUEUE,
  type EventHandler,
  type EventQueue,
} from './queues.js';

const logger = pino({ level: 'silent' });
const retry = { attempts: 3, backoffMs: 10 };
const cleanups: (() => Promise<unknown>)[] = [];

function event(type: string): PublishableEvent {
  return { id: randomUUID(), companyId: 'c', type, payload: {}, correlationId: 'corr-1234' };
}

async function setup(handlers: Record<string, EventHandler>) {
  const connection = new Redis(process.env.TEST_REDIS_URL as string, {
    maxRetriesPerRequest: null,
  });
  await connection.flushall();
  const queue: EventQueue = new Queue(DOMAIN_EVENTS_QUEUE, { connection });
  const { worker, deadLetters } = createEventWorker(connection, handlers, logger);
  cleanups.push(async () => {
    await worker.close();
    await deadLetters.close();
    await queue.close();
    connection.disconnect();
  });
  return { queue, deadLetters, publish: createPublisher(queue, retry) };
}

async function waitFor(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 15_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('event queue', () => {
  it('delivers an event to its handler', async () => {
    const seen: string[] = [];
    const { publish } = await setup({
      'sale.posted': async (e) => {
        seen.push(e.id);
      },
    });
    const published = event('sale.posted');
    await publish(published);
    await waitFor(() => seen.length === 1);
    expect(seen).toEqual([published.id]);
  });

  it('ignores a repeated publish of the same event', async () => {
    let calls = 0;
    const { publish, queue } = await setup({
      'sale.posted': async () => {
        calls += 1;
      },
    });
    const published = event('sale.posted');
    await publish(published);
    await publish(published);
    await waitFor(() => calls >= 1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(calls).toBe(1);
    expect(await queue.getJobCountByTypes('completed')).toBe(1);
  });

  it('retries a failing handler and then succeeds', async () => {
    let calls = 0;
    const { publish, deadLetters } = await setup({
      flaky: async () => {
        calls += 1;
        if (calls < 3) throw new Error('temporary');
      },
    });
    await publish(event('flaky'));
    await waitFor(() => calls === 3);
    expect(await deadLetters.getJobCountByTypes('waiting')).toBe(0);
  });

  it('moves an exhausted job to the dead-letter queue, keeping the reason', async () => {
    let calls = 0;
    const { publish, deadLetters } = await setup({
      broken: async () => {
        calls += 1;
        throw new Error('permanent failure');
      },
    });
    const published = event('broken');
    await publish(published);
    await waitFor(async () => (await deadLetters.getJobCountByTypes('waiting')) === 1);
    expect(calls).toBe(retry.attempts);
    const [dead] = await deadLetters.getJobs(['waiting']);
    expect(dead?.queueName).toBe(DEAD_LETTER_QUEUE);
    expect(dead?.data).toMatchObject({
      reason: 'permanent failure',
      event: { id: published.id },
    });
  });
});
