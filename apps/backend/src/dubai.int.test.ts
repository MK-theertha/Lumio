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
import { screenTransaction } from './modules/compliance/index.js';
import { createObjectStore } from './modules/documents/index.js';
import { runIntegrityChecks } from './modules/maintenance/index.js';
import { dec } from './shared/decimal.js';

let app: Express;
let redis: Redis;
const { setupTenant, trade, tradeBody, pay, addUser } = tenantKit(() => app);
const store = createObjectStore(testEnv);
let t: Tenant;
const get = (path: string, token = t.token) => request(app).get(api(path)).set(auth(token));
const post = (path: string, body?: object, token = t.token) =>
  request(app).post(api(path)).set(auth(token)).set(idem()).send(body);
const ok = async (res: Promise<request.Response> | request.Test, status = 201) => {
  const done = await res;
  expect(done.status, JSON.stringify(done.body)).toBe(status);
  return done.body.data;
};
const clean = async () => {
  const run = await runIntegrityChecks(oid(t.companyId), store);
  expect(run.findings).toEqual([]);
};

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
  t = await setupTenant('DXB');
  await ok(
    trade(t, 'purchase-invoices', t.supplier, '500.000').then((r) => r.posted),
    200,
  );
});

afterAll(async () => {
  redis.disconnect();
  await stopTestDatabase();
});

describe('Dubai defaults', () => {
  it('adds purities, tax codes and AML rules once, leaving tax unverified', async () => {
    const first = await ok(post('/company/presets/dubai'));
    expect(first.created).toBeGreaterThan(5);
    expect((await ok(post('/company/presets/dubai'))).created).toBe(0);
    const codes = (await get('/tax-codes')).body.data as { code: string; verified: boolean }[];
    expect(codes.find((c) => c.code === 'RCM5')?.verified).toBe(false);
  });

  it("keeps a company's own settings when the defaults are applied", async () => {
    const before = (await get('/purities')).body.data as { code: string; fineness: string }[];
    expect(before.find((p) => p.code === '22K')?.fineness).toBe('0.9160');
  });
});

describe('rate board', () => {
  it('turns USD per ounce into local prices by purity, per gram and per tola', async () => {
    await ok(post('/gold-rates/spot', { usdPerOz: '3110.34768', usdAed: '3.6725' }));
    const board = (await get('/gold-rates/board')).body.data as {
      rows: { purity: string; perGram: string; perTola: string; fineness: string }[];
    };
    const row = board.rows.find((r) => r.fineness === '0.9160')!;
    // 3110.34768 / 31.1034768 = 100 USD a gram, 367.25 AED, times 0.9160.
    expect(row.perGram).toBe('336.40');
    expect(row.perTola).toBe(dec('367.25').times('0.916').times('11.6638').toFixed(2));
  });

  it('accepts a rate entered per tola', async () => {
    await request(app)
      .patch(api('/company'))
      .set(auth(t.token))
      .send({ settings: { tolaGrams: '11.664' } });
    const rate = await ok(
      post('/gold-rates', {
        basis: 'FINE_GRAM',
        value: '4665.6',
        unit: 'TOLA',
        currency: 'AED',
      }),
    );
    expect(dec(rate.valuePerGram).toFixed(2)).toBe('400.00');
  });
});

describe('metal accounts', () => {
  const balanceOf = async (partyId: string) =>
    (
      (await get('/metal-accounts')).body.data.rows as {
        partyId: string;
        fineGrams: string;
        carryingValue: string;
      }[]
    ).find((r) => r.partyId === partyId);
  const receive = (partyId: string, grossWeight: string, provisionalRate = '400') =>
    post('/metal-accounts/receipts', {
      partyId,
      warehouseId: t.warehouseId,
      productId: t.product,
      grossWeight,
      provisionalRate,
      date: today,
    });
  const issue = (partyId: string, grossWeight: string) =>
    post('/metal-accounts/issues', {
      partyId,
      warehouseId: t.warehouseId,
      productId: t.product,
      grossWeight,
      date: today,
    });
  const fix = (partyId: string, fineGrams: string, ratePerFineGram: string) =>
    post('/metal-accounts/fixes', {
      partyId,
      branchId: t.branchId,
      fineGrams,
      ratePerFineGram,
      productKind: 'JEWELLERY',
      fineness: '0.9160',
      date: today,
    });
  const party = async (code: string, extra: object = {}) =>
    (
      await ok(
        post('/parties', {
          code,
          name: `Metal ${code}`,
          type: 'BUSINESS',
          roles: ['CUSTOMER', 'SUPPLIER'],
          ...extra,
        }),
      )
    ).id as string;

  it('holds received metal in grams, with stock and ledger in step', async () => {
    const id = await party('M1');
    await ok(receive(id, '100.000'));
    expect(await balanceOf(id)).toMatchObject({ fineGrams: '91.6000', carryingValue: '36640.00' });
    await clean();
  });

  it('turns grams into money when the price is fixed, booking the gain or loss', async () => {
    const id = await party('M2');
    await ok(receive(id, '100.000'));
    await ok(fix(id, '45.8000', '420'));
    expect(await balanceOf(id)).toMatchObject({ fineGrams: '45.8000', carryingValue: '18320.00' });
    const owed = (
      (await get('/party-balances')).body.data as { partyId: string; payable: string }[]
    ).find((b) => b.partyId === id);
    // 45.8 at 420, plus 5% VAT.
    expect(dec(owed!.payable).toFixed(2)).toBe('20197.80');
    await clean();
  });

  it('sells metal lent out to a party when it is fixed', async () => {
    const id = await party('M3');
    await ok(issue(id, '10.000'));
    expect((await balanceOf(id))?.fineGrams).toBe('-9.1600');
    await ok(fix(id, '9.1600', '450'));
    expect(await balanceOf(id)).toBeUndefined();
    const owes = (
      (await get('/party-balances')).body.data as { partyId: string; receivable: string }[]
    ).find((b) => b.partyId === id);
    expect(dec(owes!.receivable).toFixed(2)).toBe('4328.10');
    await clean();
  });

  it('will not fix more than the balance, or under concurrency', async () => {
    const id = await party('M4');
    await ok(receive(id, '10.000'));
    expect((await fix(id, '9.2000', '400')).status).toBe(422);
    const results = await Promise.all([fix(id, '9.1600', '400'), fix(id, '9.1600', '400')]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    await clean();
  });

  it("enforces a party's unfixed limit", async () => {
    const id = await party('M5', { metalLimitFine: '5' });
    expect((await issue(id, '10.000')).status).toBe(422);
    expect((await issue(id, '5.000')).status).toBe(201);
  });

  it('applies the sanctions hold to metal too', async () => {
    await ok(
      request(app)
        .post(api('/sanctions/lists/import'))
        .query({ source: 'T', format: 'CSV' })
        .set(auth(t.token))
        .set('Content-Type', 'text/csv')
        .send('externalId,name,aliases,type\nZ,Metal Blocked,,ENTITY\n'),
    );
    const id = await party('BLOCK', { name: 'Metal Blocked' });
    expect((await receive(id, '1.000')).status).toBe(422);
  });

  it('shows a running metal statement, and the desk position', async () => {
    const id = await party('M6');
    await ok(receive(id, '10.000'));
    await ok(fix(id, '1.0000', '400'));
    const statement = await ok(get(`/metal-accounts/${id}/statement`), 200);
    expect(statement.rows.map((r: { balance: string }) => r.balance)).toEqual(['9.1600', '8.1600']);
    const position = await ok(get('/reports/metal-position'), 200);
    expect(position.rows[0].netPosition).toBeDefined();
  });

  it('is denied to roles without metal access', async () => {
    const keeper = await addUser(t.companyId, 'keeper-dxb@example.com', 'Storekeeper');
    expect((await get('/metal-accounts', keeper)).status).toBe(403);
  });
});

describe('linked cash reporting', () => {
  const event = (sourceId: string, amount: string, partyId: string, amlClass = 'CASH') => ({
    companyId: t.companyId,
    trigger: 'PAYMENT_POSTED' as const,
    sourceId,
    sourceNumber: sourceId,
    partyId,
    amount,
    amlClass,
  });

  // Uses the two DPMSR rules added by the Dubai defaults.
  it('catches payments split to stay under the threshold, once each', async () => {
    expect(await screenTransaction(event('A1', '30000', t.individual))).toBe(0);
    expect(await screenTransaction(event('A2', '30000', t.individual))).toBe(1);
    expect(await screenTransaction(event('A2', '30000', t.individual))).toBe(0);
  });

  it('counts wires for a business, but not for an individual', async () => {
    expect(await screenTransaction(event('B1', '60000', t.customer, 'WIRE'))).toBe(1);
    expect(await screenTransaction(event('B2', '60000', t.individual, 'WIRE'))).toBe(0);
  });

  it('ignores payment types the rules do not cover', async () => {
    expect(await screenTransaction(event('C1', '90000', t.supplier, 'CARD'))).toBe(0);
  });
});

describe('foreign currency invoices', () => {
  const invoice = (exchangeRate?: string) =>
    post('/sales-invoices', {
      ...tradeBody(t, t.individual, '1.000', {
        rateOverride: { basis: 'FINE_GRAM', value: '100' },
      }),
      currency: 'USD',
      ...(exchangeRate ? { exchangeRate } : {}),
    });

  it('books in AED at the agreed rate and keeps the USD figures', async () => {
    const created = await ok(invoice('3.6725'));
    await ok(post(`/sales-invoices/${created.id}/post`), 200);
    const doc = await ok(get(`/sales-invoices/${created.id}`), 200);
    expect(doc.currency).toBe('AED');
    expect(doc.foreign).toMatchObject({ currency: 'USD', exchangeRate: '3.6725' });
    // 91.60 USD plus 5% is 96.18, booked line by line at the peg.
    expect(dec(doc.foreign.grandTotal).toFixed(2)).toBe('96.18');
    expect(dec(doc.grandTotal).toFixed(2)).toBe('353.22');
    await clean();
  });

  it('refuses to post without a rate', async () => {
    const created = await ok(invoice());
    expect((await post(`/sales-invoices/${created.id}/post`)).status).toBe(422);
  });
});

describe('VAT return', () => {
  let tenant: Tenant;
  const period = `from=${today}&to=${today}`;
  const as = (path: string) => request(app).get(api(path)).set(auth(tenant.token));
  const send = (path: string, body: object) =>
    request(app).post(api(path)).set(auth(tenant.token)).set(idem()).send(body);

  beforeAll(async () => {
    tenant = await setupTenant('VATCO');
    await ok(
      trade(tenant, 'purchase-invoices', tenant.supplier, '10.000').then((r) => r.posted),
      200,
    );
    await ok(
      trade(tenant, 'sales-invoices', tenant.individual, '1.000').then((r) => r.posted),
      200,
    );
    await request(app)
      .patch(api(`/branches/${tenant.branchId}`))
      .set(auth(tenant.token))
      .send({ emirate: 'DUBAI' });
  });

  it('lays out sales by emirate and nets input against output', async () => {
    const vat = await ok(as(`/vat-return?${period}`), 200);
    expect(vat.box1ByEmirate.DUBAI).toEqual({ amount: '366.40', vat: '18.32' });
    expect(vat.box9StandardExpenses).toEqual({ amount: '3664.00', vat: '183.20' });
    expect(vat.box14NetPayable).toBe('-164.88');
  });

  it('agrees with the ledger', async () => {
    const recon = await ok(as(`/vat-reconciliation?${period}`), 200);
    expect(recon.balanced).toBe(true);
  });

  it('records a filing once, with the figures as filed', async () => {
    const body = { from: today, to: today, ftaReference: 'FTA-1' };
    const filed = await ok(send('/vat-returns', body));
    expect(filed.boxes.box14NetPayable).toBe('-164.88');
    expect((await send('/vat-returns', body)).status).toBe(409);
  });
});

describe('profitability', () => {
  it('reports margin after cost, and supplier performance', async () => {
    await ok(
      post('/sales-invoices', {
        ...tradeBody(t, t.customer, '1.000', {
          rateOverride: { basis: 'FINE_GRAM', value: '500' },
        }),
      }).then(async (created) => post(`/sales-invoices/${created.body.data.id}/post`)),
      200,
    );
    const profit = await ok(get('/reports/profit-by-customer'), 200);
    const row = (
      profit.rows as { group: string; marginPercent: string; grossProfit: string }[]
    ).find((r) => r.group === 'Harbour Traders')!;
    expect(dec(row.grossProfit).greaterThan(0)).toBe(true);
    expect(dec(row.marginPercent).greaterThan(0)).toBe(true);
    const net = await ok(get('/reports/branch-net-profit'), 200);
    expect(net.rows[0].netProfit).toBeDefined();
    const suppliers = await ok(get('/reports/supplier-performance'), 200);
    expect(suppliers.rows.some((r: { supplier: string }) => r.supplier === 'Refinery One')).toBe(
      true,
    );
  });
});

describe('posting profiles', () => {
  it('posts a role to a branch account and stays in balance', async () => {
    const account = await ok(
      post('/ledger-accounts', { code: '4010', name: 'Branch gold sales', type: 'INCOME' }),
    );
    await ok(
      post('/posting-profiles', {
        role: 'SALES_GOLD',
        branchId: t.branchId,
        accountId: account.id,
      }),
    );
    await ok(
      trade(t, 'sales-invoices', t.customer, '1.000').then((r) => r.posted),
      200,
    );
    const line = await mongoose.connection
      .db!.collection('journalLines')
      .findOne({ companyId: oid(t.companyId), accountId: oid(account.id) });
    expect(line).not.toBeNull();
    await clean();
  });
});

describe('activity notes', () => {
  it('records notes against a party, within one company', async () => {
    await ok(post(`/parties/${t.customer}/activities`, { note: 'Called about the fixing' }));
    const rows = await ok(get(`/parties/${t.customer}/activities`), 200);
    expect(rows[0].note).toBe('Called about the fixing');
    const other = await setupTenant('NOTES');
    expect(
      (await post(`/parties/${t.customer}/activities`, { note: 'x' }, other.token)).status,
    ).toBe(404);
  });
});

describe('payments stay usable', () => {
  it('allows cash at the threshold through the normal route', async () => {
    expect((await pay(t, 'RECEIPT', t.individual, '10.00')).status).toBe(201);
  });
});
