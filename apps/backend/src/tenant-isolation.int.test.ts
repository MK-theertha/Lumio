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
} from '../test/harness.js';
import { api, auth, idem, oid, tenantKit, today, type Tenant } from '../test/tenant-kit.js';
import { createApp } from './app.js';
import { notify } from './modules/notifications/index.js';
import { describeApiRoutes, type RouteInfo } from './routes/route-table.js';

let app: Express;
let redis: Redis;
const { setupTenant, trade, tradeBody, pay } = tenantKit(() => app);
let a: Tenant;
let b: Tenant;

/** Routes whose id is listed somewhere other than their own collection path. */
const LIST_FOR: [RegExp, string][] = [
  [/^\/sanctions\/parties\//, '/parties'],
  [/^\/party-statements\//, '/parties'],
  [/^\/statements\/general-ledger\//, '/ledger-accounts'],
  [/^\/e-invoices\/sales\//, '/sales-invoices'],
  [/^\/journals\//, '/journals'],
  [/^\/gold-rates\/requests\//, '/gold-rates/requests'],
  [/^\/stock\/adjustments\//, '/stock/adjustments'],
  [/^\/stock\/counts\//, '/stock/counts'],
  [/^\/stock\/reservations\//, '/stock/reservations'],
  [/^\/stock\/transfers\//, '/stock/transfers'],
  [/^\/sanctions\/matches\//, '/sanctions/matches'],
];

/** Parameters that are not tenant records, or that belong to a user rather than a company. */
const OUT_OF_SCOPE = [/^\/reports\/:key$/, /^\/auth\/sessions\/:id$/];

const trade_ = () => tradeBody(a, a.customer, '1.000');
/** A valid body for each route that has one, so validation cannot mask the tenant check. */
const BODIES: Record<string, () => object> = {
  'POST /bank-statement-lines/:id/adjust': () => ({
    ledgerAccountId: a.bank,
    branchId: b.branchId,
    memo: 'x',
  }),
  'POST /bank-statement-lines/:id/match': () => ({ paymentIds: [a.bank] }),
  'POST /bank-statement-lines/:id/net': () => ({ otherLineId: a.bank }),
  'POST /compliance-cases/:id/decision': () => ({ status: 'CLEARED', decisionNote: 'x' }),
  'POST /goaml-reports/:id/submitted': () => ({ fiuReference: 'x' }),
  'POST /journals/:id/reverse': () => ({ reason: 'x' }),
  'POST /payments/:id/reverse': () => ({ reason: 'x' }),
  'POST /periods/:id/reopen': () => ({ reason: 'x' }),
  'PATCH /roles/:id': () => ({ name: 'x', permissions: [] }),
  'PUT /purchase-invoices/:id': trade_,
  'PUT /sales-invoices/:id': trade_,
  'POST /purchase-invoices/:id/returns': () => ({ lineIds: ['x'], reason: 'x', docDate: today }),
  'POST /sales-invoices/:id/returns': () => ({ lineIds: ['x'], reason: 'x', docDate: today }),
  'POST /sanctions/matches/:id/decision': () => ({ decision: 'FALSE_POSITIVE', note: 'x' }),
};

const short = (route: RouteInfo) => route.path.replace('/api/v1', '');
const key = (route: RouteInfo) => `${route.method.toUpperCase()} ${short(route)}`;
const scoped = () =>
  describeApiRoutes().filter(
    (r) => short(r).includes(':') && !OUT_OF_SCOPE.some((p) => p.test(short(r))),
  );

const listPathFor = (path: string) =>
  LIST_FOR.find(([pattern]) => pattern.test(path))?.[1] ?? `/${path.split('/')[1]}`;

async function firstId(list: string): Promise<string> {
  const query = /bank-statement-lines/.test(list) ? `?financialAccountId=${a.bank}` : '';
  const res = await request(app)
    .get(api(`${list}${query}`))
    .set(auth(a.token));
  const rows = (res.body.data.rows ?? res.body.data) as { id: string }[];
  expect(rows.length, `seed data has no rows for ${list}`).toBeGreaterThan(0);
  return rows[0]!.id;
}

function send(route: RouteInfo, id: string) {
  const method = route.method as 'get' | 'post' | 'put' | 'patch' | 'delete';
  const path = api(short(route).replace(/:(id|noteId)/g, id));
  const pending = request(app)[method](path).set(auth(b.token)).set(idem());
  if (method === 'get' || method === 'delete') return pending;
  return pending.send(BODIES[key(route)]?.() ?? {});
}

/** Correlation ids differ on every response, so they are left out of the comparison. */
const errorOf = (res: { body: { error?: { code: string; message: string } } }) =>
  res.body.error ? { code: res.body.error.code, message: res.body.error.message } : undefined;

/** Everything company A holds, for comparison before and after company B's attempts. */
async function snapshot(companyId: string): Promise<string> {
  const db = mongoose.connection.db!;
  const output: Record<string, unknown> = {};
  for (const collection of await db.collections()) {
    const name = collection.collectionName;
    if (['auditLogs', 'idempotencyKeys', 'idempotencyRecords'].includes(name)) continue;
    output[name] = await collection.find({ companyId: oid(companyId) }).toArray();
  }
  return JSON.stringify(output);
}

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
  a = await setupTenant('A');
  b = await setupTenant('B');

  const post = async (path: string, body: object = {}) => {
    const res = await request(app).post(api(path)).set(auth(a.token)).set(idem()).send(body);
    expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
    return res.body.data as { id: string };
  };
  const postRaw = (path: string, query: object, type: string, data: string | Buffer) =>
    request(app)
      .post(api(path))
      .query(query)
      .set(auth(a.token))
      .set('Content-Type', type)
      .send(data);

  await trade(a, 'purchase-invoices', a.supplier, '100.000');
  const sale = await trade(a, 'sales-invoices', a.customer, '1.000');
  expect(sale.posted.status).toBe(200);
  await pay(a, 'RECEIPT', a.customer, '10.00');
  const stock = { warehouseId: a.warehouseId, productId: a.product };
  const lots = await request(app).get(api('/stock/lots')).set(auth(a.token));
  const lotId = lots.body.data[0].id as string;

  await post('/departments', { code: 'D1', name: 'Dept' });
  await post('/employees', { employeeNo: 'E1', name: 'Employee' });
  await post('/party-pricing', { partyId: a.customer, discountPercent: '1' });
  await post('/kyc-records', {
    partyId: a.individual,
    documentType: 'PASSPORT',
    documentNumber: 'P1',
  });
  await post('/stock/adjustments', {
    ...stock,
    lotId,
    direction: 'GAIN',
    grossWeight: '1.000',
    unitCostValue: '1',
    reason: 'x',
  });
  await post('/stock/reservations', { ...stock, lotId, netWeight: '1.000', reference: 'x' });
  await post('/stock/counts', {
    warehouseId: a.warehouseId,
    lines: [{ productId: a.product, lotId, countedNet: '1.000' }],
  });
  const second = await post('/warehouses', { code: 'W2', name: 'Second', branchId: a.branchId });
  await post('/stock/transfers', {
    fromWarehouseId: a.warehouseId,
    toWarehouseId: second.id,
    lines: [{ productId: a.product, lotId, grossWeight: '1.000' }],
  });
  const accounts = await request(app).get(api('/ledger-accounts')).set(auth(a.token));
  const [one, two] = accounts.body.data as { id: string }[];
  await post('/journal-drafts', {
    postingDate: today,
    memo: 'x',
    branchId: a.branchId,
    lines: [
      { accountId: one!.id, debit: '1', credit: '0' },
      { accountId: two!.id, debit: '0', credit: '1' },
    ],
  });
  await request(app)
    .patch(api('/company'))
    .set(auth(a.token))
    .send({ settings: { rateApprovalRequired: true } });
  await post('/gold-rates', { basis: 'FINE_GRAM', value: '401.0000', currency: 'AED' });
  const rule = await post('/compliance-rules', {
    name: 'Any',
    trigger: 'SALE_POSTED',
    thresholdAmount: '1',
    severity: 'LOW',
  });
  expect(rule.id).toBeTruthy();
  await notify(oid(a.companyId), {
    key: 'isolation-test',
    audience: 'audit:read',
    severity: 'INFO',
    title: 'Seed',
    body: 'Seed',
  });
  const { screenTransaction } = await import('./modules/compliance/index.js');
  await screenTransaction({
    companyId: a.companyId,
    trigger: 'SALE_POSTED',
    sourceId: sale.id,
    sourceNumber: 'INV',
    partyId: a.individual,
    amount: '100',
  });
  const cases = await request(app).get(api('/compliance-cases')).set(auth(a.token));
  await post('/goaml-reports', {
    reportType: 'STR',
    caseIds: [cases.body.data[0].id],
    reason: 'x',
    indicators: [],
  });
  await postRaw(
    '/sanctions/lists/import',
    { source: 'T', format: 'CSV' },
    'text/csv',
    'externalId,name,aliases,type\nX,Harbour Traders,,ENTITY\n',
  );
  const parties = await request(app).get(api('/parties')).set(auth(a.token));
  for (const party of parties.body.data as { id: string }[]) {
    await post(`/sanctions/parties/${party.id}/screen`);
  }
  const reports = await request(app).get(api('/reports')).set(auth(a.token));
  await post('/report-schedules', {
    reportKey: reports.body.data[0].key,
    frequency: 'DAILY',
    format: 'XLSX',
    recipients: ['x@example.com'],
  });
  await postRaw(
    '/documents',
    { ownerType: 'PARTY', ownerId: a.customer, category: 'OTHER', fileName: 'a.pdf' },
    'application/octet-stream',
    '%PDF-1.7 x',
  );
  await post('/bank-statements/import', {
    financialAccountId: a.bank,
    csv: `Date,Amount\n${today},5.00`,
    dateOrder: 'YMD',
  });
  await post('/bank-reconciliations', {
    financialAccountId: a.bank,
    statementDate: today,
    closingBalance: '1',
    openingBalance: '0',
  });
});

afterAll(async () => {
  redis.disconnect();
  await stopTestDatabase();
});

describe('tenant isolation, generated from the real routes', () => {
  it('finds the routes to test', () => {
    expect(scoped().length).toBeGreaterThan(90);
  });

  it("treats another company's id exactly like one that does not exist", async () => {
    const before = await snapshot(a.companyId);
    const failures: string[] = [];
    for (const route of scoped()) {
      const real = await firstId(listPathFor(short(route)));
      const ghost = new mongoose.Types.ObjectId().toString();
      const [other, missing] = [await send(route, real), await send(route, ghost)];
      const answer = (res: typeof other) =>
        JSON.stringify({ status: res.status, body: { ...res.body, meta: 0, error: errorOf(res) } });
      if (other.status === 400) failures.push(`${key(route)}: needs a valid body in BODIES`);
      else if (other.status >= 500) failures.push(`${key(route)}: ${other.status}`);
      else if (route.method !== 'get' && other.status < 300) {
        failures.push(`${key(route)}: changed something, status ${other.status}`);
      } else if (answer(other) !== answer(missing)) {
        failures.push(`${key(route)}: real id ${answer(other)}, unknown id ${answer(missing)}`);
      }
    }
    expect(failures).toEqual([]);
    expect(await snapshot(a.companyId)).toBe(before);
  });

  it("never returns one company's records from a list", async () => {
    const lists = describeApiRoutes().filter(
      (r) => r.method === 'get' && !short(r).includes(':') && r.authenticated,
    );
    const secrets = [a.companyId, a.customer, a.supplier, a.product, a.bank, a.branchId];
    const leaks: string[] = [];
    for (const route of lists) {
      if (short(route) === '/platform/companies') continue;
      const res = await request(app)
        .get(api(short(route)))
        .query({ financialAccountId: b.bank })
        .set(auth(b.token));
      if (secrets.some((secret) => res.text.includes(secret))) leaks.push(short(route));
      if (res.status >= 500) leaks.push(`${short(route)}: ${res.status}`);
    }
    expect(leaks).toEqual([]);
  });
});
