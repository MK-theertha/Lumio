import { createServer, type Server, type AddressInfo } from 'node:net';
import { initRuntime } from '@lumio/backend/config/runtime.js';
import {
  createObjectStore,
  DocumentModel,
  uploadDocument,
} from '@lumio/backend/modules/documents/index.js';
import { EInvoiceModel } from '@lumio/backend/modules/einvoice/index.js';
import { OutboxRelay } from '@lumio/backend/modules/platform/outbox/index.js';
import { createApp } from '@lumio/backend/app.js';
import { Queue } from 'bullmq';
import type { Express } from 'express';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestRedis,
  silentLogger,
  startTestDatabase,
  stopTestDatabase,
  testContext,
  testEnv,
} from '../../backend/test/harness.js';
import { api, auth, oid, tenantKit, type Tenant } from '../../backend/test/tenant-kit.js';
import { createHandlers } from './handlers.js';
import {
  createEventWorker,
  createPublisher,
  DOMAIN_EVENTS_QUEUE,
  type EventQueue,
} from './queues.js';

// Built from parts so that scanners on developer machines do not quarantine this source file.
const EICAR = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'].join(
  '',
);
const PDF = Buffer.from('%PDF-1.7\nworker test\n%%EOF');

let app: Express;
let redis: Redis;
let connection: Redis;
let clamd: Server | undefined;
let t: Tenant;
let stop: () => Promise<void>;
const kit = tenantKit(() => app);

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out, last value ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Follows the clamd wire format, for runs without a real daemon. */
async function startClamdStandIn(): Promise<number> {
  clamd = createServer((socket) => {
    let received = Buffer.alloc(0);
    socket.on('data', (part) => {
      received = Buffer.concat([received, part]);
      if (received.subarray(-4).readUInt32BE(0) !== 0) return;
      socket.end(
        received.includes('EICAR') ? 'stream: Win.Test.EICAR_HDB-1 FOUND\0' : 'stream: OK\0',
      );
    });
  });
  await new Promise<void>((resolve) => clamd?.listen(0, '127.0.0.1', resolve));
  return (clamd.address() as AddressInfo).port;
}

beforeAll(async () => {
  await startTestDatabase();
  redis = createTestRedis();
  await redis.flushall();
  // TEST_CLAMAV_HOST and _PORT run this against a real ClamAV daemon.
  const realHost = process.env.TEST_CLAMAV_HOST;
  initRuntime({
    ...testEnv,
    EINVOICE_PROVIDER: 'simulated',
    CLAMAV_HOST: realHost ?? '127.0.0.1',
    CLAMAV_PORT: realHost
      ? Number(process.env.TEST_CLAMAV_PORT ?? 3310)
      : await startClamdStandIn(),
    SMTP_URL: 'smtp://127.0.0.1:1',
  });
  app = createApp({
    env: { NODE_ENV: 'test', CORS_ORIGINS: ['https://erp.example.com'], TRUST_PROXY_HOPS: 0 },
    logger: silentLogger,
    cacheRedis: redis,
    healthChecks: {},
    generalRateLimit: { limit: 100_000, windowMs: 60_000 },
    authRateLimit: 100_000,
  });
  t = await kit.setupTenant('WORK');

  connection = new Redis(process.env.TEST_REDIS_URL as string, { maxRetriesPerRequest: null });
  const queue: EventQueue = new Queue(DOMAIN_EVENTS_QUEUE, { connection });
  const { worker, deadLetters } = createEventWorker(
    connection,
    createHandlers(silentLogger),
    silentLogger,
  );
  const relay = new OutboxRelay(createPublisher(queue), silentLogger, { pollIntervalMs: 50 });
  relay.start();
  stop = async () => {
    await relay.stop();
    await worker.close();
    await deadLetters.close();
    await queue.close();
    connection.disconnect();
  };
});

afterAll(async () => {
  await stop();
  clamd?.close();
  redis.disconnect();
  await stopTestDatabase();
  initRuntime(testEnv);
});

describe('events through the outbox, queue and worker', () => {
  const store = () => createObjectStore(testEnv);
  const send = (data: Buffer, stored = store()) =>
    uploadDocument(
      testContext({ companyId: oid(t.companyId), permissions: new Set(['kyc:read']) }),
      { ownerType: 'PARTY', ownerId: t.customer, category: 'OTHER', fileName: 'x.pdf' },
      data,
      stored,
      // Any scanner marks the upload as awaiting a scan; the worker uses the configured one.
      { scan: () => Promise.reject(new Error('not called here')) },
    ) as Promise<{ _id: { toString(): string } }>;
  const scanOf = (id: string) =>
    DocumentModel.findOne({ companyId: oid(t.companyId), _id: id }).lean() as Promise<{
      scanStatus: string;
      scanSignature?: string;
    }>;

  it('marks a clean upload clean', async () => {
    const created = await send(PDF);
    const row = await waitFor(
      () => scanOf(created._id.toString()),
      (d) => d.scanStatus !== 'PENDING',
    );
    expect(row.scanStatus).toBe('CLEAN');
  });

  it('marks a test virus infected', async () => {
    // The test signature only matches at the start of a file, which could not pass the type check.
    const real = store();
    const created = await send(PDF, {
      ...real,
      put: (key, _body, type) => real.put(key, Buffer.from(EICAR), type),
    });
    const row = await waitFor(
      () => scanOf(created._id.toString()),
      (d) => d.scanStatus !== 'PENDING',
    );
    expect(row.scanStatus).toBe('INFECTED');
    expect(row.scanSignature).toMatch(/EICAR/i);
  });

  it('rechecks every party after a list is imported', async () => {
    const created = await request(app)
      .post(api('/parties'))
      .set(auth(t.token))
      .send({
        code: 'LATE',
        name: 'Marek Holloway',
        type: 'INDIVIDUAL',
        roles: ['CUSTOMER'],
      });
    const id = created.body.data.id as string;
    await request(app)
      .post(api('/sanctions/lists/import'))
      .query({ source: 'T', format: 'CSV' })
      .set(auth(t.token))
      .set('Content-Type', 'text/csv')
      .send('externalId,name,aliases,type\nZ1,Marek Holloway,,INDIVIDUAL\n')
      .expect(201);
    const party = await waitFor(
      async () =>
        (
          await request(app)
            .get(api(`/parties/${id}`))
            .set(auth(t.token))
        ).body.data,
      (p: { sanctionsStatus: string }) => p.sanctionsStatus === 'POTENTIAL_MATCH',
    );
    expect(party.sanctionsStatus).toBe('POTENTIAL_MATCH');
  });

  it('sends an e-invoice when a business sale is posted', async () => {
    await kit.trade(t, 'purchase-invoices', t.supplier, '10.000');
    const { id, posted } = await kit.trade(t, 'sales-invoices', t.customer, '1.000');
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    const row = await waitFor(
      () =>
        EInvoiceModel.findOne({ companyId: oid(t.companyId), sourceId: id }).lean() as Promise<{
          status: string;
        } | null>,
      (r) => r?.status === 'ACCEPTED',
    );
    expect(row?.status).toBe('ACCEPTED');
  });
});
