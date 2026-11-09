import mongoose, { Schema } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearCollections,
  silentLogger,
  startTestDatabase,
  stopTestDatabase,
  testContext,
} from '../../../test/harness.js';
import { tenantGuardPlugin } from '../../database/plugins/tenant-guard.js';
import { migrations } from '../../database/migrations/index.js';
import { runMigrations } from '../../database/migrations/runner.js';
import { TenantRepository } from '../../database/tenant-repository.js';
import { runInTransaction } from '../../database/transaction.js';
import { TenantGuardError } from '../../shared/errors.js';
import { AuditLogModel, recordAudit } from './audit/index.js';
import { executeIdempotent } from './idempotency/index.js';
import { allocateNumber, buildScopeKey, type NumberRequest } from './numbering/index.js';
import { enqueueEvent, OutboxEventModel, OutboxRelay, type Publisher } from './outbox/index.js';

interface Widget {
  companyId: mongoose.Types.ObjectId;
  name: string;
}

const widgetSchema = new Schema<Widget>(
  { companyId: { type: Schema.Types.ObjectId, required: true }, name: String },
  { collection: 'testWidgets' },
);
widgetSchema.plugin(tenantGuardPlugin);
const WidgetModel = mongoose.model<Widget>('TestWidget', widgetSchema);

class WidgetRepository extends TenantRepository<Widget> {
  constructor() {
    super(WidgetModel);
  }
}

const invoiceNumber: NumberRequest = {
  documentType: 'SI',
  scope: 'COMPANY',
  prefix: 'SI-',
  padding: 6,
};

beforeAll(async () => {
  await startTestDatabase();
  await WidgetModel.createCollection();
});
afterAll(stopTestDatabase);
beforeEach(clearCollections);

describe('tenant guard', () => {
  it.each([
    ['find', () => WidgetModel.find({ name: 'x' })],
    ['findOne', () => WidgetModel.findOne({})],
    ['findById', () => WidgetModel.findById(new mongoose.Types.ObjectId())],
    ['updateMany', () => WidgetModel.updateMany({}, { name: 'y' })],
    ['deleteMany', () => WidgetModel.deleteMany({})],
    ['countDocuments', () => WidgetModel.countDocuments({})],
    ['estimatedDocumentCount', () => WidgetModel.estimatedDocumentCount()],
    ['aggregate', () => WidgetModel.aggregate([{ $match: { name: 'x' } }])],
  ])('rejects an unscoped %s', async (_name, run) => {
    await expect(run()).rejects.toBeInstanceOf(TenantGuardError);
  });

  it('rejects a companyId that is an operator rather than a concrete value', async () => {
    const filter = { companyId: mongoose.trusted({ $ne: null }) };
    await expect(WidgetModel.find(filter)).rejects.toBeInstanceOf(TenantGuardError);
  });

  it('rejects $lookup without a tenant condition', async () => {
    const companyId = new mongoose.Types.ObjectId();
    await expect(
      WidgetModel.aggregate([
        { $match: { companyId } },
        { $lookup: { from: 'x', localField: 'a', foreignField: 'b', as: 'c' } },
      ]),
    ).rejects.toBeInstanceOf(TenantGuardError);
  });

  it('rejects bulkWrite operations without a tenant', async () => {
    await expect(WidgetModel.bulkWrite([{ deleteMany: { filter: {} } }])).rejects.toBeInstanceOf(
      TenantGuardError,
    );
  });

  it('isolates tenants through the repository', async () => {
    const a = testContext();
    const b = testContext();
    await WidgetModel.create([
      { companyId: a.companyId, name: 'A' },
      { companyId: b.companyId, name: 'B' },
    ]);
    const repository = new WidgetRepository();
    expect((await repository.find(a).lean()).map((w) => w.name)).toEqual(['A']);
    const rows = await repository.aggregate<{ name: string }>(b, []);
    expect(rows.map((w) => w.name)).toEqual(['B']);
  });

  it('cannot be escaped by a caller-supplied companyId', async () => {
    const a = testContext();
    const b = testContext();
    await WidgetModel.create({ companyId: b.companyId, name: 'B' });
    const found = await new WidgetRepository().find(a, { companyId: b.companyId }).lean();
    expect(found).toEqual([]);
  });
});

describe('query sanitisation', () => {
  it('refuses operator objects supplied as filter values', async () => {
    const ctx = testContext();
    await WidgetModel.create({ companyId: ctx.companyId, name: 'secret' });
    const attack = JSON.parse('{"$ne":"nothing"}') as string;
    await expect(new WidgetRepository().find(ctx, { name: attack }).lean()).rejects.toThrow(
      /Cast to string failed/,
    );
  });
});

describe('transactions', () => {
  it('rolls back every write when work fails', async () => {
    const ctx = testContext();
    await expect(
      runInTransaction(ctx, async (tx) => {
        await WidgetModel.create([{ companyId: ctx.companyId, name: 'x' }], {
          session: tx.session,
        });
        await recordAudit(tx, { action: 'a', entityType: 'b', entityId: 'c' });
        await enqueueEvent(tx, 'test.event', {});
        await allocateNumber(tx, invoiceNumber);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(await WidgetModel.countDocuments({ companyId: ctx.companyId })).toBe(0);
    expect(await AuditLogModel.countDocuments({ companyId: ctx.companyId })).toBe(0);
    expect(await OutboxEventModel.countDocuments({ companyId: ctx.companyId })).toBe(0);
    const next = await runInTransaction(ctx, (tx) => allocateNumber(tx, invoiceNumber));
    expect(next).toBe('SI-000001');
  });

  it('joins an enclosing transaction rather than nesting', async () => {
    const ctx = testContext();
    await runInTransaction(ctx, async (outer) => {
      await runInTransaction(outer, async (inner) => {
        expect(inner.session).toBe(outer.session);
      });
    });
  });
});

describe('numbering', () => {
  it('builds the configured scope key, and requires its inputs', () => {
    const base = { ...invoiceNumber, branchCode: 'DXB', fiscalYear: '2026' };
    expect(buildScopeKey({ ...base, scope: 'COMPANY' })).toBe('SI');
    expect(buildScopeKey({ ...base, scope: 'BRANCH' })).toBe('SI/DXB');
    expect(buildScopeKey({ ...base, scope: 'COMPANY_FISCAL_YEAR' })).toBe('SI/2026');
    expect(buildScopeKey({ ...base, scope: 'BRANCH_FISCAL_YEAR' })).toBe('SI/DXB/2026');
    expect(() => buildScopeKey({ ...invoiceNumber, scope: 'BRANCH' })).toThrow(/branchCode/);
  });

  it('refuses to allocate outside a transaction', async () => {
    await expect(allocateNumber(testContext(), invoiceNumber)).rejects.toThrow(/transaction/);
  });

  it('gives unique, gapless numbers to 50 concurrent transactions', async () => {
    const ctx = testContext();
    const numbers = await Promise.all(
      Array.from({ length: 50 }, () =>
        runInTransaction(ctx, (tx) => allocateNumber(tx, invoiceNumber)),
      ),
    );
    const expected = Array.from({ length: 50 }, (_, i) => `SI-${String(i + 1).padStart(6, '0')}`);
    expect([...numbers].sort()).toEqual(expected);
  });

  it('keeps separate sequences per tenant', async () => {
    const [a, b] = [testContext(), testContext()];
    expect(await runInTransaction(a, (tx) => allocateNumber(tx, invoiceNumber))).toBe('SI-000001');
    expect(await runInTransaction(b, (tx) => allocateNumber(tx, invoiceNumber))).toBe('SI-000001');
  });
});

describe('idempotency', () => {
  const key = 'test-key-0001';

  it('performs the work once for ten concurrent identical requests', async () => {
    const ctx = testContext();
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        executeIdempotent(ctx, key, { amount: '10.00' }, async (tx) => {
          await WidgetModel.create([{ companyId: ctx.companyId, name: 'effect' }], {
            session: tx.session,
          });
          return { number: await allocateNumber(tx, invoiceNumber) };
        }),
      ),
    );
    expect(await WidgetModel.countDocuments({ companyId: ctx.companyId })).toBe(1);
    expect(new Set(results.map((r) => r.result.number))).toEqual(new Set(['SI-000001']));
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
  });

  it('treats key order in the body as the same request', async () => {
    const ctx = testContext();
    await executeIdempotent(ctx, key, { a: 1, b: 2 }, async () => 'first');
    const second = await executeIdempotent(ctx, key, { b: 2, a: 1 }, async () => 'second');
    expect(second).toEqual({ result: 'first', replayed: true });
  });

  it('rejects the same key with a different body', async () => {
    const ctx = testContext();
    await executeIdempotent(ctx, key, { amount: '10.00' }, async () => 'ok');
    await expect(
      executeIdempotent(ctx, key, { amount: '20.00' }, async () => 'ok'),
    ).rejects.toMatchObject({ status: 422, code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('releases the key when the work fails, so a retry can succeed', async () => {
    const ctx = testContext();
    await expect(
      executeIdempotent(ctx, key, {}, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const retry = await executeIdempotent(ctx, key, {}, async () => 'done');
    expect(retry).toEqual({ result: 'done', replayed: false });
  });

  it('scopes keys per user and per tenant', async () => {
    const ctx = testContext();
    await executeIdempotent(ctx, key, {}, async () => 'a');
    const otherUser = await executeIdempotent(
      { ...ctx, userId: 'someone-else' },
      key,
      {},
      async () => 'b',
    );
    expect(otherUser.replayed).toBe(false);
  });
});

describe('audit', () => {
  it('redacts sensitive fields and records the actor and correlation id', async () => {
    const ctx = testContext();
    await recordAudit(ctx, {
      action: 'user.update',
      entityType: 'user',
      entityId: '1',
      after: { name: 'A', passwordHash: 'x' },
    });
    const [row] = await AuditLogModel.find({ companyId: ctx.companyId }).lean();
    expect(row).toMatchObject({
      actorId: ctx.userId,
      correlationId: ctx.correlationId,
      after: { name: 'A', passwordHash: '[REDACTED]' },
    });
  });
});

describe('outbox relay', () => {
  async function seed(count: number) {
    const ctx = testContext();
    await runInTransaction(ctx, async (tx) => {
      for (let i = 0; i < count; i += 1) await enqueueEvent(tx, 'test.event', { i });
    });
    return ctx;
  }

  it('refuses to enqueue outside a transaction', async () => {
    await expect(enqueueEvent(testContext(), 't', {})).rejects.toThrow(/transaction/);
  });

  it('publishes committed events once and marks them', async () => {
    const ctx = await seed(3);
    const publish = vi.fn<Publisher>().mockResolvedValue();
    const relay = new OutboxRelay(publish, silentLogger);
    expect(await relay.tick()).toBe(3);
    expect(await relay.tick()).toBe(0);
    expect(publish).toHaveBeenCalledTimes(3);
    expect(publish.mock.calls[0]?.[0]).toMatchObject({
      type: 'test.event',
      companyId: ctx.companyId.toString(),
      correlationId: ctx.correlationId,
    });
    expect(await OutboxEventModel.countDocuments({ status: 'PUBLISHED' })).toBe(3);
  });

  it('never double-claims across competing relays', async () => {
    await seed(40);
    const published: string[] = [];
    const publish: Publisher = async (event) => {
      published.push(event.id);
    };
    const relays = Array.from({ length: 4 }, () => new OutboxRelay(publish, silentLogger));
    await Promise.all(relays.map((relay) => relay.tick()));
    expect(published).toHaveLength(40);
    expect(new Set(published).size).toBe(40);
  });

  it('retries with backoff, then marks the event failed', async () => {
    await seed(1);
    const publish = vi.fn<Publisher>().mockRejectedValue(new Error('queue down'));
    const relay = new OutboxRelay(publish, silentLogger, { maxAttempts: 2, baseBackoffMs: 100 });
    await relay.tick();
    expect(await OutboxEventModel.findOne({}).lean()).toMatchObject({
      status: 'PENDING',
      attempts: 1,
      lastError: 'queue down',
    });
    // The backoff holds the event back until its delay has passed.
    expect(await relay.tick()).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await relay.tick();
    expect(await OutboxEventModel.findOne({}).lean()).toMatchObject({
      status: 'FAILED',
      attempts: 2,
    });
    expect(await relay.tick()).toBe(0);
  });

  it('recovers an event whose relay crashed mid-publish', async () => {
    await seed(1);
    await OutboxEventModel.updateOne(
      {},
      { $set: { status: 'PROCESSING', lockedUntil: new Date(Date.now() - 1000) } },
    );
    const publish = vi.fn<Publisher>().mockResolvedValue();
    await new OutboxRelay(publish, silentLogger).tick();
    expect(publish).toHaveBeenCalledOnce();
  });
});

describe('migrations', () => {
  it('applies each migration once', async () => {
    expect(await runMigrations(migrations, silentLogger)).toEqual([]);
  });

  it('refuses to run concurrently with a live lock', async () => {
    const collection = mongoose.connection.db!.collection<{ _id: string; appliedAt: Date }>(
      'migrations',
    );
    await collection.insertOne({ _id: '__lock__', appliedAt: new Date() });
    await expect(runMigrations(migrations, silentLogger)).rejects.toThrow(/in progress/);
    await collection.deleteOne({ _id: '__lock__' });
  });

  it('created the unique index that guards number series', async () => {
    const indexes = await NumberIndexes();
    expect(indexes.some((i) => i.unique && i.key.scopeKey === 1)).toBe(true);
  });
});

function NumberIndexes() {
  return mongoose.connection.db!.collection('numberSeries').indexes();
}
