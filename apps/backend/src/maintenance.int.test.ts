import type { Express } from 'express';
import type { Redis } from 'ioredis';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestRedis,
  silentLogger,
  startTestDatabase,
  stopTestDatabase,
  testEnv,
} from '../test/harness.js';
import { api, auth, idem, oid, tenantKit, today, type Tenant } from '../test/tenant-kit.js';
import { createApp } from './app.js';
import { createObjectStore } from './modules/documents/index.js';
import {
  expireReservations,
  raiseDocumentReminders,
  raisePaymentAlerts,
  raiseStockAlerts,
  refreshUnSanctionsList,
  runIntegrityChecks,
  runNightlyMaintenance,
  sealAuditLog,
} from './modules/maintenance/index.js';
import { d128 } from './shared/decimal.js';

let app: Express;
let redis: Redis;
const { setupTenant, trade, pay, addUser } = tenantKit(() => app);
const store = createObjectStore(testEnv);
let t: Tenant;

const db = () => mongoose.connection.db!;
const scope = () => ({ companyId: oid(t.companyId) });
const failures = async () => {
  const run = await runIntegrityChecks(oid(t.companyId), store);
  return run.findings as { check: string; detail: string }[];
};
const notifications = async (token = t.token) =>
  (await request(app).get(api('/notifications')).set(auth(token))).body.data as {
    id: string;
    title: string;
    body: string;
    read: boolean;
  }[];

beforeAll(async () => {
  await startTestDatabase();
  redis = createTestRedis();
  await redis.flushall();
  app = createApp({
    env: { NODE_ENV: 'test', CORS_ORIGINS: ['https://erp.example.com'], TRUST_PROXY_HOPS: 0 },
    logger: silentLogger,
    cacheRedis: redis,
    healthChecks: {},
    generalRateLimit: { limit: 100_000, windowMs: 60_000 },
    authRateLimit: 100_000,
  });
  t = await setupTenant('MAINT');
  const bought = await trade(t, 'purchase-invoices', t.supplier, '50.000');
  expect(bought.posted.status, JSON.stringify(bought.posted.body)).toBe(200);
  const sold = await trade(t, 'sales-invoices', t.customer, '2.000');
  expect(sold.posted.status, JSON.stringify(sold.posted.body)).toBe(200);
  await pay(t, 'RECEIPT', t.customer, '100.00');
  const doc = await request(app)
    .get(api(`/sales-invoices/${sold.id}`))
    .set(auth(t.token));
  const another = await trade(t, 'sales-invoices', t.individual, '1.000');
  const docB = await request(app)
    .get(api(`/sales-invoices/${another.id}`))
    .set(auth(t.token));
  const returned = await request(app)
    .post(api(`/sales-invoices/${another.id}/returns`))
    .set(auth(t.token))
    .set(idem())
    .send({ lineIds: [docB.body.data.lines[0].lineId], reason: 'Change of mind', docDate: today });
  expect(returned.status, JSON.stringify(returned.body)).toBe(201);
  expect(doc.body.data.number).toBeTruthy();
});

afterAll(async () => {
  redis.disconnect();
  await stopTestDatabase();
});

describe('integrity checks', () => {
  it('pass on books produced by normal trading', async () => {
    expect(await failures()).toEqual([]);
  });

  it('catch a journal line changed directly in the database', async () => {
    const lines = db().collection('journalLines');
    const row = await lines.findOne({ ...scope(), debit: { $gt: d128('0') } });
    await lines.updateOne({ _id: row!._id }, { $set: { debit: d128('1.00') } });
    const found = await failures();
    await lines.updateOne({ _id: row!._id }, { $set: { debit: row!.debit } });
    expect(found.some((f) => f.check === 'Journals balance')).toBe(true);
  });

  it('catch a stock balance that disagrees with its movements', async () => {
    const balances = db().collection('stockBalances');
    const row = await balances.findOne(scope());
    await balances.updateOne({ _id: row!._id }, { $set: { net: d128('9999.000') } });
    const found = await failures();
    await balances.updateOne({ _id: row!._id }, { $set: { net: row!.net } });
    expect(found.some((f) => f.check === 'Stock equals movements')).toBe(true);
  });

  it('catch inventory value drifting from the ledger', async () => {
    const balances = db().collection('stockBalances');
    const row = await balances.findOne(scope());
    await balances.updateOne({ _id: row!._id }, { $set: { cost: d128('1.00') } });
    const found = await failures();
    await balances.updateOne({ _id: row!._id }, { $set: { cost: row!.cost } });
    expect(found.some((f) => f.check === 'Inventory equals ledger')).toBe(true);
  });

  it('catch a party balance edited behind the ledger', async () => {
    const balances = db().collection('partyBalances');
    const row = await balances.findOne(scope());
    await balances.updateOne({ _id: row!._id }, { $set: { receivable: d128('7777.00') } });
    const found = await failures();
    await balances.updateOne({ _id: row!._id }, { $set: { receivable: row!.receivable } });
    expect(found.some((f) => f.check === 'Control accounts equal party balances')).toBe(true);
  });

  it('catch a posted invoice altered after posting', async () => {
    const invoices = db().collection('salesInvoices');
    const row = await invoices.findOne({ ...scope(), status: 'POSTED' });
    const lines = row!.lines as { lineTotal: unknown }[];
    const changed = [{ ...lines[0], lineTotal: d128('1.00') }, ...lines.slice(1)];
    await invoices.updateOne({ _id: row!._id }, { $set: { lines: changed } });
    const found = await failures();
    await invoices.updateOne({ _id: row!._id }, { $set: { lines } });
    expect(found.some((f) => f.check === 'Posted invoices are unchanged')).toBe(true);
  });

  it('catch a deleted invoice, as both a numbering gap and a journal without a source', async () => {
    const invoices = db().collection('salesInvoices');
    const [row] = await invoices.find(scope()).sort({ number: 1 }).limit(1).toArray();
    await invoices.deleteOne({ _id: row!._id });
    const found = await failures();
    await invoices.insertOne(row!);
    expect(found.some((f) => f.check === 'Numbers are gapless')).toBe(true);
    expect(found.some((f) => f.check === 'Journals trace to a source')).toBe(true);
  });

  it('catch a posting into a period after it closed', async () => {
    const periods = db().collection('financialPeriods');
    const entries = db().collection('journalEntries');
    const entry = await entries.findOne(scope());
    const period = await periods.findOne({ _id: entry!.periodId });
    await periods.updateOne(
      { _id: period!._id },
      { $set: { status: 'CLOSED', updatedAt: new Date(entry!.postedAt.getTime() - 1000) } },
    );
    const found = await failures();
    await periods.updateOne(
      { _id: period!._id },
      { $set: { status: period!.status, updatedAt: period!.updatedAt } },
    );
    expect(found.some((f) => f.check === 'Closed periods are untouched')).toBe(true);
  });

  it('never repairs anything it finds, and tells the right people', async () => {
    const balances = db().collection('stockBalances');
    const row = await balances.findOne(scope());
    await balances.updateOne({ _id: row!._id }, { $set: { net: d128('1234.000') } });
    await failures();
    const after = await balances.findOne({ _id: row!._id });
    await balances.updateOne({ _id: row!._id }, { $set: { net: row!.net } });
    expect(after!.net.toString()).toBe('1234.000');
    expect((await notifications()).some((n) => n.title === 'Integrity check failed')).toBe(true);
  });
});

describe('audit sealing', () => {
  const logs = () => db().collection('auditLogs');

  beforeAll(async () => {
    // Sealing only takes rows old enough that their transaction must have committed.
    await logs().updateMany(scope(), { $set: { at: new Date(Date.now() - 3_600_000) } });
  });

  it('seals settled rows once, and exports each seal outside the database', async () => {
    const sealed = await sealAuditLog(oid(t.companyId), store);
    expect(sealed).toBeGreaterThan(0);
    expect(await sealAuditLog(oid(t.companyId), store)).toBe(0);
    const seal = await db().collection('auditSeals').findOne(scope());
    const copy = JSON.parse((await store.get(seal!.exportKey)).toString()) as { hash: string };
    expect(copy.hash).toBe(seal!.hash);
    expect(await failures()).toEqual([]);
  });

  it('detects a changed audit row', async () => {
    const seal = await db().collection('auditSeals').findOne(scope());
    const row = await logs().findOne({ _id: seal!.firstRowId });
    await logs().updateOne({ _id: row!._id }, { $set: { actorId: 'someone-else' } });
    const found = await failures();
    await logs().updateOne({ _id: row!._id }, { $set: { actorId: row!.actorId } });
    expect(found.some((f) => f.check === 'Audit log matches its seals')).toBe(true);
  });

  it('detects a removed audit row', async () => {
    const seal = await db().collection('auditSeals').findOne(scope());
    const row = await logs().findOne({ _id: seal!.lastRowId });
    await logs().deleteOne({ _id: row!._id });
    const found = await failures();
    await logs().insertOne(row!);
    expect(found.some((f) => f.check === 'Audit log matches its seals')).toBe(true);
  });

  it('detects a seal rewritten to hide a change', async () => {
    const seals = db().collection('auditSeals');
    const seal = await seals.findOne(scope());
    await seals.updateOne({ _id: seal!._id }, { $set: { hash: 'f'.repeat(64) } });
    const found = await failures();
    await seals.updateOne({ _id: seal!._id }, { $set: { hash: seal!.hash } });
    expect(found.some((f) => /exported copy|changed/.test(f.detail))).toBe(true);
  });
});

describe('nightly jobs', () => {
  it('releases reservations whose time has run out, and no others', async () => {
    const lots = await request(app).get(api('/stock/lots')).set(auth(t.token));
    const reserve = (expiresAt?: string) =>
      request(app)
        .post(api('/stock/reservations'))
        .set(auth(t.token))
        .send({
          warehouseId: t.warehouseId,
          productId: t.product,
          lotId: lots.body.data[0].id,
          netWeight: '1.000',
          reference: 'Hold',
          ...(expiresAt ? { expiresAt } : {}),
        });
    const expired = await reserve(new Date(Date.now() - 60_000).toISOString());
    const future = await reserve(new Date(Date.now() + 3_600_000).toISOString());
    expect(expired.status, JSON.stringify(expired.body)).toBe(201);
    expect(await expireReservations(oid(t.companyId))).toBe(1);
    const list = await request(app).get(api('/stock/reservations')).set(auth(t.token));
    const status = (id: string) =>
      (list.body.data as { id: string; status: string }[]).find((r) => r.id === id)?.status;
    expect(status(expired.body.data.id)).toBe('RELEASED');
    expect(status(future.body.data.id)).toBe('ACTIVE');
    expect(await failures()).toEqual([]);
  });

  it('warns once about a document close to expiry', async () => {
    const soon = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    const upload = await request(app)
      .post(api('/documents'))
      .query({
        ownerType: 'PARTY',
        ownerId: t.customer,
        category: 'TRADE_LICENCE',
        fileName: 'licence.pdf',
        expiresAt: soon,
      })
      .set(auth(t.token))
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('%PDF-1.7 x'));
    expect(upload.status, JSON.stringify(upload.body)).toBe(201);
    await raiseDocumentReminders(oid(t.companyId));
    await raiseDocumentReminders(oid(t.companyId));
    const found = (await notifications()).filter((n) => n.title === 'Document expiring');
    expect(found).toHaveLength(1);
  });

  it('alerts on low stock, only to those who can see stock', async () => {
    await request(app)
      .patch(api(`/products/${t.product}`))
      .set(auth(t.token))
      .send({ reorderLevelNet: '999999.000' });
    await raiseStockAlerts(oid(t.companyId));
    expect((await notifications()).some((n) => n.title === 'Stock below reorder level')).toBe(true);
    const sales = await addUser(t.companyId, 'exec@example.com', 'Storekeeper');
    expect((await notifications(sales)).some((n) => n.title === 'Stock below reorder level')).toBe(
      true,
    );
    const auditorRole = await request(app)
      .post(api('/roles'))
      .set(auth(t.token))
      .send({ name: 'Report only', permissions: ['report:read'] });
    expect(auditorRole.status).toBe(201);
    const reader = await addUser(t.companyId, 'reports@example.com', 'Report only');
    expect(await notifications(reader)).toEqual([]);
  });

  it('alerts on overdue invoices', async () => {
    await db()
      .collection('openItems')
      .updateMany(scope(), { $set: { dueDate: new Date(Date.now() - 86_400_000) } });
    await raisePaymentAlerts(oid(t.companyId));
    expect((await notifications()).some((n) => n.title === 'Overdue customer invoices')).toBe(true);
  });

  it('marks a notification read for one person only', async () => {
    const [first] = await notifications();
    await request(app)
      .post(api(`/notifications/${first!.id}/read`))
      .set(auth(t.token));
    expect((await notifications()).find((n) => n.id === first!.id)?.read).toBe(true);
    expect((await notifications(t.second)).find((n) => n.id === first!.id)?.read).toBe(false);
  });

  describe('sanctions list refresh', () => {
    const xml = (version: string, id: string) =>
      `<CONSOLIDATED_LIST dateGenerated="${version}"><INDIVIDUALS><INDIVIDUAL><DATAID>1</DATAID><FIRST_NAME>NEW</FIRST_NAME><SECOND_NAME>PERSON</SECOND_NAME><REFERENCE_NUMBER>${id}</REFERENCE_NUMBER></INDIVIDUAL></INDIVIDUALS></CONSOLIDATED_LIST>`;
    const lists = async () =>
      (await request(app).get(api('/sanctions/lists')).set(auth(t.token))).body.data as {
        source: string;
        version: string;
      }[];

    it('only updates companies that chose the list, and only when it has changed', async () => {
      const company = oid(t.companyId);
      const run = (version: string) =>
        refreshUnSanctionsList([company], 'https://example.invalid', silentLogger, () =>
          Promise.resolve(xml(version, 'A.1')),
        );
      expect(await run('2026-01-01')).toBe(0);
      expect(await lists()).toEqual([]);

      const first = await request(app)
        .post(api('/sanctions/lists/import'))
        .query({ source: 'UN', format: 'UN_XML' })
        .set(auth(t.token))
        .set('Content-Type', 'text/xml')
        .send(xml('2026-01-01', 'A.1'));
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      expect(await run('2026-01-01')).toBe(0);
      expect(await run('2026-02-01')).toBe(1);
      expect((await lists())[0]?.version).toBe('2026-02-01');
    });

    it('does nothing without a configured address', async () => {
      expect(await refreshUnSanctionsList([oid(t.companyId)], undefined, silentLogger)).toBe(0);
    });
  });

  it('holds a company whose owner is listed', async () => {
    const res = await request(app)
      .post(api('/parties'))
      .set(auth(t.token))
      .send({
        code: 'OWNED',
        name: 'Blue Sky Trading',
        type: 'BUSINESS',
        roles: ['CUSTOMER'],
        beneficialOwners: ['New Person'],
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const party = await request(app)
      .get(api(`/parties/${res.body.data.id}`))
      .set(auth(t.token));
    expect(party.body.data.sanctionsStatus).toBe('POTENTIAL_MATCH');
    const matches = await request(app).get(api('/sanctions/matches')).set(auth(t.token));
    expect(
      (matches.body.data as { subject: string; partyId: string }[]).find(
        (m) => m.partyId === res.body.data.id,
      )?.subject,
    ).toBe('New Person');
  });

  it('runs every nightly job without failing', async () => {
    await expect(runNightlyMaintenance(silentLogger, store)).resolves.toBeUndefined();
  });
});

describe('browser error reports', () => {
  it('are accepted without signing in, and limited in size', async () => {
    const ok = await request(app).post(api('/client-errors')).send({ message: 'boom', path: '/x' });
    expect(ok.status).toBe(204);
    const big = await request(app)
      .post(api('/client-errors'))
      .send({ message: 'x'.repeat(5000) });
    expect(big.status).toBe(400);
  });
});
