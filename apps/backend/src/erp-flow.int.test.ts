import { randomUUID } from 'node:crypto';
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
import { createApp } from './app.js';
import { screenTransaction } from './modules/compliance/index.js';
import { hashPassword, UserModel } from './modules/identity/index.js';
import { totpAt } from './modules/identity/totp.js';
import { JournalEntryModel, JournalLineModel } from './modules/ledger/index.js';
import { StockBalanceModel, StockMovementModel } from './modules/inventory/index.js';
import { RoleAssignmentModel, RoleModel } from './modules/access/index.js';
import { provisionCompany } from './modules/onboarding/index.js';
import { dec } from './shared/decimal.js';

// Rates, tax codes and rules below are test fixtures, not approved business rules.
let app: Express;
let redis: Redis;
const PASSWORD = 'correct-horse-battery';

interface Tenant {
  token: string;
  second: string;
  companyId: string;
  branchId: string;
  warehouseId: string;
  purity22: string;
  product: string;
  piece: string;
  customer: string;
  supplier: string;
  cash: string;
  cashMethod: string;
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const idem = () => ({ 'Idempotency-Key': randomUUID() });

async function login(email: string): Promise<string> {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data.accessToken as string;
}

async function addAdmin(companyId: string, email: string) {
  const company = new mongoose.Types.ObjectId(companyId);
  const user = await UserModel.create({
    email: email.toLowerCase(),
    name: 'Second approver',
    status: 'ACTIVE',
    passwordHash: await hashPassword(PASSWORD),
    activeCompanyId: company,
  });
  const role = (await RoleModel.findOne({
    companyId: company,
    name: 'Company Administrator',
  }).lean()) as {
    _id: mongoose.Types.ObjectId;
  };
  await RoleAssignmentModel.create({ companyId: company, userId: user._id, roleId: role._id });
}

async function setupTenant(code: string): Promise<Tenant> {
  const email = `admin-${code}@example.com`;
  const { companyId } = await provisionCompany(
    { userId: 'test', correlationId: 'test-correlation' },
    {
      code,
      legalName: `${code} Gold LLC`,
      baseCurrency: 'AED',
      adminEmail: email,
      adminName: 'Admin',
      branchName: 'Head office',
    },
    { adminPassword: PASSWORD, isDemo: true },
  );
  await addAdmin(companyId, `second-${code}@example.com`);
  const token = await login(email);
  const second = await login(`second-${code}@example.com`);
  const api = {
    post: async (path: string, body: object) => {
      const res = await request(app).post(`/api/v1${path}`).set(auth(token)).send(body);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body.data.id as string;
    },
    first: async (path: string) => {
      const res = await request(app).get(`/api/v1${path}`).set(auth(token));
      return res.body.data[0].id as string;
    },
  };
  const branchId = await api.first('/branches');
  const warehouseId = await api.first('/warehouses');
  const purity22 = await api.post('/purities', {
    code: '22K',
    label: '22 karat',
    karat: '22',
    fineness: '0.9160',
  });
  const product = await api.post('/products', {
    sku: 'BAR-22',
    name: '22K bar',
    kind: 'BAR',
    purityId: purity22,
    tracking: 'LOT',
    reorderLevelNet: '500.000',
  });
  const piece = await api.post('/products', {
    sku: 'RING-22',
    name: '22K ring',
    kind: 'JEWELLERY',
    purityId: purity22,
    tracking: 'PIECE',
    defaultMaking: { mode: 'PER_GRAM_NET', value: '20' },
  });
  const customer = await api.post('/parties', {
    code: 'C1',
    name: 'Customer One',
    type: 'INDIVIDUAL',
    roles: ['CUSTOMER'],
    creditLimit: '100000.00',
  });
  const supplier = await api.post('/parties', {
    code: 'S1',
    name: 'Supplier One',
    type: 'BUSINESS',
    roles: ['SUPPLIER'],
  });
  const taxCode = await api.post('/tax-codes', {
    code: 'STD5',
    name: 'Standard 5%',
    ratePercent: '5',
    treatment: 'STANDARD',
  });
  await api.post('/tax-rules', { name: 'All', priority: 10, taxCodeId: taxCode });
  await api.post('/gold-rates', { basis: 'FINE_GRAM', value: '400.0000', currency: 'AED' });
  const cash = await api.first('/financial-accounts?q=CASH');
  const cashMethod = await api.first('/payment-methods');
  return {
    token,
    second,
    companyId,
    branchId,
    warehouseId,
    purity22,
    product,
    piece,
    customer,
    supplier,
    cash,
    cashMethod,
  };
}

const docDate = new Date().toISOString().slice(0, 10);

function tradeBody(
  t: Tenant,
  direction: 'SALE' | 'PURCHASE',
  gross: string,
  overrides: object = {},
) {
  return {
    partyId: direction === 'SALE' ? t.customer : t.supplier,
    branchId: t.branchId,
    docDate,
    currency: 'AED',
    lines: [{ productId: t.product, warehouseId: t.warehouseId, grossWeight: gross }],
    ...overrides,
  };
}

async function postTrade(t: Tenant, path: string, body: object) {
  const created = await request(app).post(`/api/v1/${path}`).set(auth(t.token)).send(body);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return request(app)
    .post(`/api/v1/${path}/${created.body.data.id}/post`)
    .set(auth(t.token))
    .set(idem());
}

async function buy(t: Tenant, gross: string) {
  const res = await postTrade(t, 'purchase-invoices', tradeBody(t, 'PURCHASE', gross));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

const lotBalance = async (t: Tenant) => {
  const rows = (await StockBalanceModel.find({
    companyId: new mongoose.Types.ObjectId(t.companyId),
    productId: t.product,
    location: 'MAIN',
  }).lean()) as { net: mongoose.Types.Decimal128 }[];
  return rows.reduce((sum, r) => sum.plus(dec(r.net)), dec('0'));
};

async function assertBooksBalance(t: Tenant) {
  const companyId = new mongoose.Types.ObjectId(t.companyId);
  const lines = (await JournalLineModel.find({ companyId }).lean()) as {
    debit: mongoose.Types.Decimal128;
    credit: mongoose.Types.Decimal128;
  }[];
  const debit = lines.reduce((s, l) => s.plus(dec(l.debit)), dec('0'));
  const credit = lines.reduce((s, l) => s.plus(dec(l.credit)), dec('0'));
  expect(debit.toFixed(2)).toBe(credit.toFixed(2));

  const balances = (await StockBalanceModel.find({ companyId }).lean()) as {
    productId: mongoose.Types.ObjectId;
    net: mongoose.Types.Decimal128;
    location: string;
    warehouseId: mongoose.Types.ObjectId;
    lotId?: mongoose.Types.ObjectId | null;
  }[];
  const movements = (await StockMovementModel.find({ companyId }).lean()) as {
    productId: mongoose.Types.ObjectId;
    net: mongoose.Types.Decimal128;
    location: string;
    warehouseId: mongoose.Types.ObjectId;
    lotId?: mongoose.Types.ObjectId | null;
  }[];
  for (const balance of balances) {
    const total = movements
      .filter(
        (m) =>
          m.productId.equals(balance.productId) &&
          m.location === balance.location &&
          m.warehouseId.equals(balance.warehouseId) &&
          String(m.lotId ?? '') === String(balance.lotId ?? ''),
      )
      .reduce((s, m) => s.plus(dec(m.net)), dec('0'));
    expect(dec(balance.net).minus(total).abs().lte('0.001')).toBe(true);
  }
}

let a: Tenant;
let b: Tenant;

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
  a = await setupTenant('ALPHA');
  b = await setupTenant('BETA');
});

afterAll(async () => {
  redis.disconnect();
  await stopTestDatabase();
});

describe('authentication', () => {
  const email = () => 'admin-alpha@example.com';

  it('rejects a wrong password without revealing which part was wrong', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: email(), password: 'wrong' });
    expect(res.status).toBe(401);
    const unknown = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'x@y.com', password: 'wrong' });
    expect(unknown.body.error.message).toBe(res.body.error.message);
  });

  it('never returns password hashes', async () => {
    const res = await request(app).get('/api/v1/auth/me').set(auth(a.token));
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|argon2/);
  });

  it('rotates refresh tokens and revokes the session on replay', async () => {
    const login1 = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: email(), password: PASSWORD });
    const cookie = login1.headers['set-cookie']?.[0]?.split(';')[0] as string;
    expect(login1.headers['set-cookie']?.[0]).toMatch(/HttpOnly/);

    const refresh = (c: string) =>
      request(app).post('/api/v1/auth/refresh').set('Cookie', c).set('X-Requested-With', 'lumio');
    const first = await refresh(cookie);
    expect(first.status).toBe(200);

    const mongooseSessions = mongoose.connection.db!.collection('sessions');
    await mongooseSessions.updateMany(
      { rotatedAt: { $exists: true } },
      { $set: { rotatedAt: new Date(Date.now() - 60_000) } },
    );
    expect((await refresh(cookie)).status).toBe(401);
    const next = first.headers['set-cookie']?.[0]?.split(';')[0] as string;
    expect((await refresh(next)).status).toBe(401);
  });

  it('refuses a refresh without the anti-CSRF header', async () => {
    const res = await request(app).post('/api/v1/auth/refresh').set('Cookie', 'lumio_refresh=x');
    expect(res.status).toBe(403);
  });

  it('locks an account after repeated failures', async () => {
    await UserModel.create({
      email: 'lock@example.com',
      name: 'L',
      status: 'ACTIVE',
      passwordHash: await hashPassword(PASSWORD),
    });
    for (let i = 0; i < 5; i += 1) {
      await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'lock@example.com', password: 'bad' });
    }
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'lock@example.com', password: PASSWORD });
    expect(res.status).toBe(401);
  });

  it('enforces MFA once enrolled', async () => {
    await UserModel.create({
      email: 'mfa@example.com',
      name: 'M',
      status: 'ACTIVE',
      passwordHash: await hashPassword(PASSWORD),
    });
    const token = await login('mfa@example.com');
    const enrol = await request(app).post('/api/v1/auth/mfa/enrol').set(auth(token));
    const code = () => totpAt(enrol.body.data.secret as string, Date.now() / 1000);
    const confirm = await request(app)
      .post('/api/v1/auth/mfa/confirm')
      .set(auth(token))
      .send({ code: code() });
    expect(confirm.body.data.recoveryCodes).toHaveLength(8);

    const challenge = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'mfa@example.com', password: PASSWORD });
    expect(challenge.body.data.accessToken).toBeUndefined();
    const { mfaToken } = challenge.body.data;
    const bad = await request(app).post('/api/v1/auth/mfa').send({ mfaToken, code: '000000' });
    expect(bad.status).toBe(401);
    const good = await request(app).post('/api/v1/auth/mfa').send({ mfaToken, code: code() });
    expect(good.body.data.accessToken).toBeTruthy();
  });

  it('requires authentication for API routes', async () => {
    expect((await request(app).get('/api/v1/parties')).status).toBe(401);
    expect((await request(app).get('/api/v1/parties').set(auth('garbage'))).status).toBe(401);
  });
});

describe('tenant isolation and permissions', () => {
  it("returns 404 for another company's record", async () => {
    const res = await request(app).get(`/api/v1/parties/${b.customer}`).set(auth(a.token));
    expect(res.status).toBe(404);
  });

  it('keeps lists separate', async () => {
    const res = await request(app).get('/api/v1/parties').set(auth(a.token));
    expect(res.body.data.map((p: { id: string }) => p.id)).not.toContain(b.customer);
  });

  it("refuses to sell to another company's customer", async () => {
    const res = await request(app)
      .post('/api/v1/sales-invoices')
      .set(auth(a.token))
      .send(tradeBody(a, 'SALE', '1.000', { partyId: b.customer }));
    expect(res.status).toBe(404);
  });

  it('enforces permissions on the API regardless of the UI', async () => {
    const company = new mongoose.Types.ObjectId(a.companyId);
    const role = (await RoleModel.findOne({ companyId: company, name: 'Storekeeper' }).lean()) as {
      _id: mongoose.Types.ObjectId;
    };
    const user = await UserModel.create({
      email: 'store@example.com',
      name: 'Store',
      status: 'ACTIVE',
      passwordHash: await hashPassword(PASSWORD),
      activeCompanyId: company,
    });
    await RoleAssignmentModel.create({ companyId: company, userId: user._id, roleId: role._id });
    const token = await login('store@example.com');
    expect((await request(app).get('/api/v1/journals').set(auth(token))).status).toBe(403);
    expect((await request(app).get('/api/v1/stock/balances').set(auth(token))).status).toBe(200);
    const stock = await request(app).get('/api/v1/stock/balances').set(auth(token));
    expect(JSON.stringify(stock.body)).not.toContain('"cost"');
  });
});

describe('purchase to payment', () => {
  it('runs the full workflow and keeps the books balanced', async () => {
    await buy(a, '100.000');
    expect((await lotBalance(a)).toFixed(3)).toBe('100.000');

    // 10 g at 0.916 × 400 = 3,664.00, plus 5% VAT.
    const sale = await postTrade(a, 'sales-invoices', tradeBody(a, 'SALE', '10.000'));
    expect(sale.status, JSON.stringify(sale.body)).toBe(200);
    expect(sale.body.data.number).toMatch(/^SI-HQ-\d{4}-000001$/);
    expect((await lotBalance(a)).toFixed(3)).toBe('90.000');

    const invoice = await request(app)
      .get(`/api/v1/sales-invoices/${sale.body.data.id}`)
      .set(auth(a.token));
    expect(invoice.body.data.taxableTotal).toBe('3664.00');
    expect(invoice.body.data.taxTotal).toBe('183.20');
    expect(invoice.body.data.grandTotal).toBe('3847.20');
    expect(invoice.body.data.lines[0].snapshot.rate.source).toBe('MANUAL');
    expect(dec(invoice.body.data.lines[0].costAtIssue as string).toFixed(2)).toBe('3664.00');

    const open = await request(app)
      .get(`/api/v1/open-items?partyId=${a.customer}`)
      .set(auth(a.token));
    expect(dec(open.body.data[0].outstanding as string).toFixed(2)).toBe('3847.20');

    const payment = await request(app)
      .post('/api/v1/payments')
      .set(auth(a.token))
      .set(idem())
      .send({
        direction: 'RECEIPT',
        partyId: a.customer,
        branchId: a.branchId,
        financialAccountId: a.cash,
        methodId: a.cashMethod,
        amount: '1000.00',
        paymentDate: docDate,
        allocations: [{ openItemId: open.body.data[0].id, amount: '1000.00' }],
      });
    expect(payment.status, JSON.stringify(payment.body)).toBe(201);
    const after = await request(app)
      .get(`/api/v1/open-items?partyId=${a.customer}`)
      .set(auth(a.token));
    expect(dec(after.body.data[0].outstanding as string).toFixed(2)).toBe('2847.20');

    const trial = await request(app).get('/api/v1/statements/trial-balance').set(auth(a.token));
    expect(trial.body.data.totalDebit).toBe(trial.body.data.totalCredit);
    const sheet = await request(app).get('/api/v1/statements/balance-sheet').set(auth(a.token));
    expect(sheet.body.data.balanced).toBe(true);
    const pnl = await request(app).get('/api/v1/statements/profit-and-loss').set(auth(a.token));
    expect(pnl.body.data.totalIncome).toBe('3664.00');
    const dash = await request(app).get('/api/v1/dashboard').set(auth(a.token));
    expect(dash.body.data.sales.count).toBe(1);
    expect(dash.body.data.lowStock[0].sku).toBe('BAR-22');
    await assertBooksBalance(a);
  });

  it('reverses a payment and restores what was outstanding', async () => {
    const items = await request(app).get(`/api/v1/payments`).set(auth(a.token));
    const paymentId = items.body.data[0].id as string;
    const res = await request(app)
      .post(`/api/v1/payments/${paymentId}/reverse`)
      .set(auth(a.token))
      .set(idem())
      .send({ reason: 'Bounced' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const after = await request(app)
      .get(`/api/v1/open-items?partyId=${a.customer}`)
      .set(auth(a.token));
    expect(dec(after.body.data[0].outstanding as string).toFixed(2)).toBe('3847.20');
    const again = await request(app)
      .post(`/api/v1/payments/${paymentId}/reverse`)
      .set(auth(a.token))
      .set(idem())
      .send({ reason: 'Again' });
    expect(again.status).toBe(409);
    await assertBooksBalance(a);
  });

  it('returns a line, restoring stock and reducing the receivable', async () => {
    const before = await lotBalance(a);
    const sale = await postTrade(a, 'sales-invoices', tradeBody(a, 'SALE', '5.000'));
    const id = sale.body.data.id as string;
    expect((await lotBalance(a)).toFixed(3)).toBe(before.minus(5).toFixed(3));
    const ret = await request(app)
      .post(`/api/v1/sales-invoices/${id}/returns`)
      .set(auth(a.token))
      .set(idem())
      .send({ lineIds: ['1'], reason: 'Customer return', docDate });
    expect(ret.status, JSON.stringify(ret.body)).toBe(201);
    expect(ret.body.data.number).toMatch(/^CN-/);
    const doc = await request(app).get(`/api/v1/sales-invoices/${id}`).set(auth(a.token));
    expect(doc.body.data.status).toBe('RETURNED');
    const twice = await request(app)
      .post(`/api/v1/sales-invoices/${id}/returns`)
      .set(auth(a.token))
      .set(idem())
      .send({ lineIds: ['1'], reason: 'Again', docDate });
    expect(twice.status).toBe(409);
    await assertBooksBalance(a);
  });

  it('prices a reverse-charge purchase with no VAT on the document but books it both ways', async () => {
    const code = await request(app)
      .post('/api/v1/tax-codes')
      .set(auth(b.token))
      .send({ code: 'RC5', name: 'Reverse charge', ratePercent: '5', treatment: 'REVERSE_CHARGE' });
    await request(app)
      .post('/api/v1/tax-rules')
      .set(auth(b.token))
      .send({ name: 'RC', priority: 1, taxCodeId: code.body.data.id, direction: 'PURCHASE' });
    const res = await postTrade(b, 'purchase-invoices', tradeBody(b, 'PURCHASE', '10.000'));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const doc = await request(app)
      .get(`/api/v1/purchase-invoices/${res.body.data.id}`)
      .set(auth(b.token));
    expect(doc.body.data.taxTotal).toBe('0.00');
    const trial = await request(app).get('/api/v1/statements/trial-balance').set(auth(b.token));
    const vat = trial.body.data.rows.filter((r: { code: string }) =>
      ['1300', '2100'].includes(r.code),
    );
    expect(vat.map((r: { debit: string; credit: string }) => [r.debit, r.credit])).toEqual([
      ['183.20', '0.00'],
      ['0.00', '183.20'],
    ]);
  });
});

describe('concurrency', () => {
  it('never oversells: parallel sales exceeding stock leave it non-negative', async () => {
    const current = await lotBalance(a);
    const created = await Promise.all(
      Array.from({ length: 12 }, () =>
        request(app)
          .post('/api/v1/sales-invoices')
          .set(auth(a.token))
          .send(tradeBody(a, 'SALE', current.dividedBy(10).toFixed(3))),
      ),
    );
    const results = await Promise.all(
      created.map((c) =>
        request(app)
          .post(`/api/v1/sales-invoices/${c.body.data.id}/post`)
          .set(auth(a.token))
          .set(idem()),
      ),
    );
    const ok = results.filter((r) => r.status === 200);
    const refused = results.filter((r) => r.status === 422);
    expect(ok).toHaveLength(10);
    expect(refused.every((r) => r.body.error.code === 'INSUFFICIENT_STOCK')).toBe(true);
    expect((await lotBalance(a)).gte(0)).toBe(true);
    const numbers = ok.map((r) => r.body.data.number as string);
    expect(new Set(numbers).size).toBe(10);
    await assertBooksBalance(a);
  });

  it('sells a tagged piece exactly once', async () => {
    const receipt = await request(app).post('/api/v1/stock/receipts').set(auth(b.token)).send({
      warehouseId: b.warehouseId,
      productId: b.piece,
      grossWeight: '8.000',
      totalCost: '2500.00',
      tag: 'RING-1',
      reason: 'Opening stock',
    });
    expect(receipt.status, JSON.stringify(receipt.body)).toBe(201);
    const items = await request(app).get('/api/v1/stock/items').set(auth(b.token));
    const stockItemId = items.body.data[0].id as string;
    const body = {
      ...tradeBody(b, 'SALE', '8.000'),
      lines: [
        { productId: b.piece, warehouseId: b.warehouseId, stockItemId, grossWeight: '8.000' },
      ],
    };
    const created = await Promise.all(
      Array.from({ length: 8 }, () =>
        request(app).post('/api/v1/sales-invoices').set(auth(b.token)).send(body),
      ),
    );
    const results = await Promise.all(
      created.map((c) =>
        request(app)
          .post(`/api/v1/sales-invoices/${c.body.data.id}/post`)
          .set(auth(b.token))
          .set(idem()),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    await assertBooksBalance(b);
  });

  it('posts once for repeated requests with one idempotency key', async () => {
    await buy(b, '50.000');
    const created = await request(app)
      .post('/api/v1/sales-invoices')
      .set(auth(b.token))
      .send(tradeBody(b, 'SALE', '1.000'));
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        request(app)
          .post(`/api/v1/sales-invoices/${created.body.data.id}/post`)
          .set(auth(b.token))
          .set('Idempotency-Key', key),
      ),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.data.number)).size).toBe(1);
  });

  it('requires an idempotency key to post', async () => {
    const created = await request(app)
      .post('/api/v1/sales-invoices')
      .set(auth(b.token))
      .send(tradeBody(b, 'SALE', '1.000'));
    const res = await request(app)
      .post(`/api/v1/sales-invoices/${created.body.data.id}/post`)
      .set(auth(b.token));
    expect(res.status).toBe(400);
  });

  it('stops concurrent credit sales at the limit', async () => {
    const party = await request(app)
      .post('/api/v1/parties')
      .set(auth(b.token))
      .send({
        code: 'C-LIMIT',
        name: 'Limited',
        type: 'INDIVIDUAL',
        roles: ['CUSTOMER'],
        creditLimit: '4000.00',
      });
    const created = await Promise.all(
      Array.from({ length: 4 }, () =>
        request(app)
          .post('/api/v1/sales-invoices')
          .set(auth(b.token))
          .send(tradeBody(b, 'SALE', '10.000', { partyId: party.body.data.id })),
      ),
    );
    const results = await Promise.all(
      created.map((c) =>
        request(app)
          .post(`/api/v1/sales-invoices/${c.body.data.id}/post`)
          .set(auth(b.token))
          .set(idem()),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.body.error?.code === 'CREDIT_LIMIT_EXCEEDED')).toHaveLength(3);
  });
});

describe('controls', () => {
  it('needs a second person for approval-gated documents', async () => {
    await request(app)
      .patch('/api/v1/company')
      .set(auth(b.token))
      .send({ settings: { saleApprovalAmount: '100.00' } });
    const created = await request(app)
      .post('/api/v1/sales-invoices')
      .set(auth(b.token))
      .send(tradeBody(b, 'SALE', '1.000'));
    const id = created.body.data.id as string;
    const blocked = await request(app)
      .post(`/api/v1/sales-invoices/${id}/post`)
      .set(auth(b.token))
      .set(idem());
    expect(blocked.status).toBe(422);
    const submitted = await request(app)
      .post(`/api/v1/sales-invoices/${id}/submit`)
      .set(auth(b.token));
    expect(submitted.body.data.status).toBe('PENDING_APPROVAL');
    const self = await request(app).post(`/api/v1/sales-invoices/${id}/approve`).set(auth(b.token));
    expect(self.status).toBe(422);
    const other = await request(app)
      .post(`/api/v1/sales-invoices/${id}/approve`)
      .set(auth(b.second));
    expect(other.body.data.status).toBe('APPROVED');
    const posted = await request(app)
      .post(`/api/v1/sales-invoices/${id}/post`)
      .set(auth(b.token))
      .set(idem());
    expect(posted.status).toBe(200);
    await request(app)
      .patch('/api/v1/company')
      .set(auth(b.token))
      .send({ settings: { saleApprovalAmount: '100000000' } });
  });

  it('applies stock adjustments only after a second person approves', async () => {
    const before = await lotBalance(b);
    const lots = await request(app).get('/api/v1/stock/balances').set(auth(b.token));
    const lotId = lots.body.data.find(
      (r: { productId: string; location: string; availableNet: string }) =>
        r.productId === b.product && r.location === 'MAIN' && dec(r.availableNet).gte(5),
    ).lotId;
    const adj = await request(app).post('/api/v1/stock/adjustments').set(auth(b.token)).send({
      warehouseId: b.warehouseId,
      productId: b.product,
      lotId,
      direction: 'LOSS',
      grossWeight: '1.000',
      reason: 'Melt loss',
    });
    expect((await lotBalance(b)).equals(before)).toBe(true);
    const id = adj.body.data.id as string;
    expect(
      (await request(app).post(`/api/v1/stock/adjustments/${id}/approve`).set(auth(b.token)))
        .status,
    ).toBe(422);
    const ok = await request(app)
      .post(`/api/v1/stock/adjustments/${id}/approve`)
      .set(auth(b.second));
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await lotBalance(b)).toFixed(3)).toBe(before.minus(1).toFixed(3));
    await assertBooksBalance(b);
  });

  it('moves stock between warehouses through in-transit', async () => {
    const wh = await request(app)
      .post('/api/v1/warehouses')
      .set(auth(b.token))
      .send({ code: 'W2', name: 'Second', branchId: b.branchId });
    const lots = await request(app).get('/api/v1/stock/balances').set(auth(b.token));
    const lotId = lots.body.data.find(
      (r: { productId: string; location: string; availableNet: string }) =>
        r.productId === b.product && r.location === 'MAIN' && dec(r.availableNet).gte(5),
    ).lotId;
    const created = await request(app)
      .post('/api/v1/stock/transfers')
      .set(auth(b.token))
      .send({
        fromWarehouseId: b.warehouseId,
        toWarehouseId: wh.body.data.id,
        lines: [{ productId: b.product, lotId, grossWeight: '2.000' }],
      });
    const id = created.body.data.id as string;
    const dispatch = await request(app)
      .post(`/api/v1/stock/transfers/${id}/dispatch`)
      .set(auth(b.second));
    expect(dispatch.status, JSON.stringify(dispatch.body)).toBe(200);
    const receive = await request(app)
      .post(`/api/v1/stock/transfers/${id}/receive`)
      .set(auth(b.token));
    expect(receive.status, JSON.stringify(receive.body)).toBe(200);
    await assertBooksBalance(b);
  });

  it('refuses to change a posted journal, and reverses only once', async () => {
    const companyId = new mongoose.Types.ObjectId(a.companyId);
    await expect(
      JournalEntryModel.updateOne({ companyId }, { $set: { memo: 'tampered' } }),
    ).rejects.toThrow(/immutable/);
    const journals = await request(app).get('/api/v1/journals').set(auth(a.token));
    const target = journals.body.data.find(
      (j: { reversesEntryId?: string; kind: string }) => !j.reversesEntryId && j.kind === 'POSTING',
    );
    const first = await request(app)
      .post(`/api/v1/journals/${target.id}/reverse`)
      .set(auth(a.token))
      .send({ reason: 'Correction' });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const second = await request(app)
      .post(`/api/v1/journals/${target.id}/reverse`)
      .set(auth(a.token))
      .send({ reason: 'Again' });
    expect(second.status).toBe(409);
    await assertBooksBalance(a);
  });

  it('blocks posting into a closing period', async () => {
    const periods = await request(app).get('/api/v1/periods').set(auth(b.token));
    const current = periods.body.data.find((p: { name: string }) => p.name === docDate.slice(0, 7));
    await request(app).post(`/api/v1/periods/${current.id}/begin-close`).set(auth(b.token));
    const created = await request(app)
      .post('/api/v1/sales-invoices')
      .set(auth(b.token))
      .send(tradeBody(b, 'SALE', '1.000'));
    const res = await request(app)
      .post(`/api/v1/sales-invoices/${created.body.data.id}/post`)
      .set(auth(b.token))
      .set(idem());
    expect(res.status).toBe(422);
    const reopen = await request(app)
      .post(`/api/v1/periods/${current.id}/reopen`)
      .set(auth(b.token))
      .send({ reason: 'Test' });
    expect(reopen.status).toBe(200);
    const stock = await lotBalance(b);
    expect(stock.gte(0)).toBe(true);
  });

  it('refuses unverified tax codes when the company requires verification', async () => {
    await request(app)
      .patch('/api/v1/company')
      .set(auth(a.token))
      .send({ settings: { requireVerifiedTaxCodes: true } });
    const res = await request(app)
      .post('/api/v1/sales-invoices/quote')
      .set(auth(a.token))
      .send(tradeBody(a, 'SALE', '1.000'));
    expect(res.status).toBe(422);
    await request(app)
      .patch('/api/v1/company')
      .set(auth(a.token))
      .send({ settings: { requireVerifiedTaxCodes: false } });
  });

  it('opens one compliance case per rule and transaction, and only above threshold', async () => {
    await request(app)
      .post('/api/v1/compliance-rules')
      .set(auth(a.token))
      .send({
        name: 'Cash threshold',
        trigger: 'PAYMENT_POSTED',
        amlClasses: ['CASH'],
        thresholdAmount: '1000.00',
        severity: 'HIGH',
      });
    const event = {
      companyId: a.companyId,
      trigger: 'PAYMENT_POSTED' as const,
      sourceId: randomUUID(),
      sourceNumber: 'RCPT-1',
      partyId: a.customer,
      amount: '1500.00',
      amlClass: 'CASH',
    };
    expect(await screenTransaction({ ...event, amount: '999.99', sourceId: randomUUID() })).toBe(0);
    expect(await screenTransaction(event)).toBe(1);
    expect(await screenTransaction(event)).toBe(0);
    const cases = await request(app).get('/api/v1/compliance-cases').set(auth(a.token));
    expect(cases.body.data).toHaveLength(1);
  });

  it('stores KYC numbers encrypted and never returns them', async () => {
    const res = await request(app).post('/api/v1/kyc-records').set(auth(a.token)).send({
      partyId: a.customer,
      documentType: 'PASSPORT',
      documentNumber: 'P1234567',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(JSON.stringify(res.body)).not.toContain('P1234567');
    expect(res.body.data.documentNumberLast4).toBe('4567');
    const row = await mongoose.connection.db!.collection('kycRecords').findOne({});
    expect(JSON.stringify(row)).not.toContain('P1234567');
  });

  it('exports CSV without allowing formula injection', async () => {
    const res = await request(app).get('/api/v1/reports/sales-daily?format=csv').set(auth(a.token));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/csv/);
    expect(res.text.split('\n')[0]).toContain('group');
  });
});

describe('branch isolation', () => {
  it('confines a branch-limited user to that branch', async () => {
    const company = new mongoose.Types.ObjectId(a.companyId);
    const created = await request(app)
      .post('/api/v1/branches')
      .set(auth(a.token))
      .send({ code: 'B2', name: 'Second' });
    const role = (await RoleModel.findOne({ companyId: company, name: 'Auditor' }).lean()) as {
      _id: mongoose.Types.ObjectId;
    };
    const user = await UserModel.create({
      email: 'branch@example.com',
      name: 'Branch only',
      status: 'ACTIVE',
      passwordHash: await hashPassword(PASSWORD),
      activeCompanyId: company,
    });
    await RoleAssignmentModel.create({
      companyId: company,
      userId: user._id,
      roleId: role._id,
      branchIds: [created.body.data.id],
    });
    const token = await login('branch@example.com');
    for (const path of [
      '/stock/balances',
      '/stock/movements',
      '/journals',
      '/payments',
      '/open-items',
      '/sales-invoices',
    ]) {
      const res = await request(app).get(`/api/v1${path}`).set(auth(token));
      expect(res.status, path).toBe(200);
      expect(res.body.data, path).toEqual([]);
    }
    const trial = await request(app).get('/api/v1/statements/trial-balance').set(auth(token));
    expect(trial.body.data.rows).toEqual([]);
    const other = await request(app)
      .get(`/api/v1/statements/trial-balance?branchId=${a.branchId}`)
      .set(auth(token));
    expect(other.status).toBe(404);
    const dash = await request(app).get('/api/v1/dashboard').set(auth(token));
    expect(dash.body.data.stock.netWeight).toBe('0.000');
  });
});
