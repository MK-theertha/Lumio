import type { Express } from 'express';
import type { Redis } from 'ioredis';
import type mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestRedis,
  silentLogger,
  startTestDatabase,
  stopTestDatabase,
  testEnv,
} from '../test/harness.js';
import {
  api,
  auth,
  idem,
  oid,
  PASSWORD,
  tenantKit,
  today,
  type Tenant,
} from '../test/tenant-kit.js';
import { createApp } from './app.js';
import { initRuntime } from './config/runtime.js';
import { JournalLineModel } from './modules/ledger/index.js';
import { createFirstPlatformAdmin, type EmailMessage } from './modules/identity/index.js';
import { OutboxEventModel } from './modules/platform/outbox/index.js';
import { decrypt } from './shared/crypto.js';
import { dec } from './shared/decimal.js';

let app: Express;
let redis: Redis;
const { login, addUser, setupTenant, trade, tradeBody, pay } = tenantKit(() => app);
let t: Tenant;

const get = (path: string, token = t.token) => request(app).get(api(path)).set(auth(token));
const post = (path: string, body?: object, token = t.token) =>
  request(app).post(api(path)).set(auth(token)).send(body);

/** The most recent email queued to an address, read back the way the worker would. */
async function lastEmailTo(to: string): Promise<EmailMessage> {
  const events = (await OutboxEventModel.find({ companyId: oid(t.companyId), type: 'email.send' })
    .sort({ _id: -1 })
    .lean()) as { payload: { sealed: string } }[];
  const [found] = events
    .map((e) => JSON.parse(decrypt(e.payload.sealed)) as EmailMessage)
    .filter((m) => m.to === to);
  if (!found) throw new Error(`No email queued for ${to}`);
  return found;
}
const tokenIn = (message: EmailMessage) => /token=([\w-]+)/.exec(message.text)?.[1] as string;

async function bookTotals() {
  const lines = (await JournalLineModel.find({ companyId: oid(t.companyId) }).lean()) as {
    debit: mongoose.Types.Decimal128;
    credit: mongoose.Types.Decimal128;
  }[];
  return {
    debit: lines.reduce((s, l) => s.plus(dec(l.debit)), dec('0')).toFixed(2),
    credit: lines.reduce((s, l) => s.plus(dec(l.credit)), dec('0')).toFixed(2),
  };
}

interface BalanceRow {
  productId: string;
  lotId?: string;
  location: string;
  net: string;
  availableNet: string;
  reservedNet: string;
}
const lotRows = async () =>
  ((await get('/stock/balances')).body.data as BalanceRow[]).filter(
    (r) => r.productId === t.product && r.location === 'MAIN' && dec(r.net).greaterThan(0),
  );
/** The fullest lot of the test product. */
const balance = async () => (await lotRows()).sort((x, y) => dec(y.net).comparedTo(dec(x.net)))[0]!;
const totalStock = async () =>
  (await lotRows()).reduce((sum, row) => sum.plus(dec(row.net)), dec('0'));
const lotBalance = async (lotId: string) =>
  ((await get('/stock/balances')).body.data as BalanceRow[]).find((r) => r.lotId === lotId)!;

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
  t = await setupTenant('GAPS');
  const stocked = await trade(t, 'purchase-invoices', t.supplier, '100.000');
  expect(stocked.posted.status, JSON.stringify(stocked.posted.body)).toBe(200);
});

afterAll(async () => {
  redis.disconnect();
  await stopTestDatabase();
});

describe('going live', () => {
  it('creates the first platform administrator once, who can then create companies', async () => {
    const admin = {
      email: 'Owner@Example.com',
      name: 'Platform Owner',
      password: PASSWORD,
    };
    await createFirstPlatformAdmin(admin);
    await expect(createFirstPlatformAdmin({ ...admin, email: 'b@example.com' })).rejects.toThrow(
      /already exists/,
    );
    const token = await login('owner@example.com');
    const created = await post(
      '/platform/companies',
      {
        code: 'NEWCO',
        legalName: 'New Company LLC',
        baseCurrency: 'AED',
        adminEmail: 'first@newco.example.com',
        adminName: 'First Admin',
        branchName: 'Main',
      },
      token,
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const list = await get('/platform/companies', token);
    expect(list.body.data.map((c: { code: string }) => c.code)).toContain('NEWCO');
  });

  it('keeps company administrators out of platform routes', async () => {
    expect((await get('/platform/companies')).status).toBe(403);
    expect((await post('/platform/companies', {})).status).toBe(400);
  });

  it('marks the refresh cookie Secure in production, even behind a plain-HTTP proxy', async () => {
    const email = 'admin-GAPS@example.com';
    const attempt = () => request(app).post(api('/auth/login')).send({ email, password: PASSWORD });
    expect((await attempt()).headers['set-cookie']?.[0]).not.toMatch(/Secure/);
    initRuntime({ ...testEnv, NODE_ENV: 'production' });
    try {
      expect((await attempt()).headers['set-cookie']?.[0]).toMatch(/Secure/);
    } finally {
      initRuntime(testEnv);
    }
  });
});

describe('invitations and password reset', () => {
  const email = 'invited@example.com';

  it('lets an invited person set a password once and sign in', async () => {
    const roles = await get('/roles');
    const role = (roles.body.data as { id: string; name: string }[]).find(
      (r) => r.name === 'Storekeeper',
    )!;
    const invited = await post('/users', {
      email,
      name: 'Invited Person',
      assignments: [{ roleId: role.id, branchIds: [] }],
    });
    expect(invited.status, JSON.stringify(invited.body)).toBe(201);
    expect(
      (await request(app).post(api('/auth/login')).send({ email, password: PASSWORD })).status,
    ).toBe(401);

    const token = tokenIn(await lastEmailTo(email));
    const accept = await request(app)
      .post(api('/auth/reset-password'))
      .send({ token, password: PASSWORD });
    expect(accept.status, JSON.stringify(accept.body)).toBe(200);
    await login(email);
    const reused = await request(app)
      .post(api('/auth/reset-password'))
      .send({ token, password: 'another-long-password' });
    expect(reused.status).toBe(422);
  });

  it('replaces the password and ends existing sessions on reset', async () => {
    const before = await login(email);
    expect((await get('/auth/me', before)).status).toBe(200);
    const asked = await request(app).post(api('/auth/forgot-password')).send({ email });
    expect(asked.status).toBe(200);
    const events = (await OutboxEventModel.find({ type: 'email.send' })
      .sort({ _id: -1 })
      .limit(1)
      .lean()) as { payload: { sealed: string } }[];
    const message = JSON.parse(decrypt(events[0]!.payload.sealed)) as EmailMessage;
    expect(message.to).toBe(email);
    const next = 'a-brand-new-long-password';
    const reset = await request(app)
      .post(api('/auth/reset-password'))
      .send({ token: tokenIn(message), password: next });
    expect(reset.status, JSON.stringify(reset.body)).toBe(200);
    const old = await request(app).post(api('/auth/login')).send({ email, password: PASSWORD });
    expect(old.status).toBe(401);
    const fresh = await request(app).post(api('/auth/login')).send({ email, password: next });
    expect(fresh.status).toBe(200);
  });

  it('answers the same for an unknown address', async () => {
    const res = await request(app)
      .post(api('/auth/forgot-password'))
      .send({ email: 'nobody@example.com' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ sent: true });
  });
});

describe('manual journals', () => {
  const accounts = async () => {
    const rows = (await get('/ledger-accounts')).body.data as { id: string; code: string }[];
    return {
      cash: rows.find((r) => r.code === '1000')!.id,
      equity: rows.find((r) => r.code === '3000')!.id,
    };
  };
  const draft = async (debit: string, credit: string) => {
    const { cash, equity } = await accounts();
    return post('/journal-drafts', {
      postingDate: today,
      memo: 'Opening cash',
      branchId: t.branchId,
      lines: [
        { accountId: cash, debit, credit: '0' },
        { accountId: equity, debit: '0', credit },
      ],
    });
  };

  it('needs a second person, posts once, and can be reversed once', async () => {
    const created = await draft('250.00', '250.00');
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.data.id as string;
    expect((await post(`/journal-drafts/${id}/post`)).status).toBe(422);
    const posted = await post(`/journal-drafts/${id}/post`, undefined, t.second);
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    expect((await post(`/journal-drafts/${id}/post`, undefined, t.second)).status).toBe(409);

    const journals = (await get('/journals')).body.data as { id: string; number: string }[];
    const entry = journals.find((j) => j.number === posted.body.data.number)!;
    const reverse = () =>
      request(app)
        .post(api(`/journals/${entry.id}/reverse`))
        .set(auth(t.second))
        .set(idem())
        .send({ reason: 'Entered in error' });
    expect((await reverse()).status, 'first reversal').toBeLessThan(300);
    expect((await reverse()).status).toBeGreaterThanOrEqual(409);
    const totals = await bookTotals();
    expect(totals.debit).toBe(totals.credit);
  });

  it('refuses to post an unbalanced journal', async () => {
    const created = await draft('100.00', '90.00');
    if (created.status === 201) {
      const res = await post(`/journal-drafts/${created.body.data.id}/post`, undefined, t.second);
      expect(res.status).toBe(422);
    } else {
      expect(created.status).toBe(400);
    }
  });
});

describe('refunds and returns', () => {
  const balanceOf = async (partyId: string) =>
    (
      (await get('/party-balances')).body.data as {
        partyId: string;
        receivable: string;
        payable: string;
      }[]
    ).find((b) => b.partyId === partyId)!;

  it('refunds a customer by paying from the receivable side', async () => {
    const before = dec((await balanceOf(t.individual))?.receivable ?? '0');
    const receipt = await pay(t, 'RECEIPT', t.individual, '300.00');
    expect(receipt.status, JSON.stringify(receipt.body)).toBe(201);
    const refund = await pay(t, 'PAYMENT', t.individual, '300.00', undefined, {
      side: 'RECEIVABLE',
    });
    expect(refund.status, JSON.stringify(refund.body)).toBe(201);
    expect(dec((await balanceOf(t.individual)).receivable).toFixed(2)).toBe(before.toFixed(2));
    const totals = await bookTotals();
    expect(totals.debit).toBe(totals.credit);
  });

  it('returns a purchase line: less stock, less owed, once only', async () => {
    const { id, posted } = await trade(t, 'purchase-invoices', t.supplier, '10.000');
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    const doc = (await get(`/purchase-invoices/${id}`)).body.data as {
      grandTotal: string;
      lines: { lineId: string }[];
    };
    const owedBefore = dec((await balanceOf(t.supplier)).payable);
    const stockBefore = await totalStock();
    const send = () =>
      request(app)
        .post(api(`/purchase-invoices/${id}/returns`))
        .set(auth(t.token))
        .set(idem())
        .send({ lineIds: [doc.lines[0]!.lineId], reason: 'Assay failed', docDate: today });
    const returned = await send();
    expect(returned.status, JSON.stringify(returned.body)).toBe(201);
    expect((await totalStock()).toFixed(3)).toBe(stockBefore.minus('10').toFixed(3));
    expect(dec((await balanceOf(t.supplier)).payable).toFixed(2)).toBe(
      owedBefore.minus(doc.grandTotal).toFixed(2),
    );
    expect((await send()).status).toBe(409);
    const totals = await bookTotals();
    expect(totals.debit).toBe(totals.credit);
  });
});

describe('pricing through the API', () => {
  const quote = async (partyId: string, line: object = {}) => {
    const res = await post('/sales-invoices/quote', tradeBody(t, partyId, '1.000', line));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.data;
  };

  it('applies a party pricing rule only to that party', async () => {
    const plain = await quote(t.customer);
    const rule = await post('/party-pricing', {
      partyId: t.customer,
      makingMode: 'PER_GRAM_NET',
      makingValue: '30',
    });
    expect(rule.status, JSON.stringify(rule.body)).toBe(201);
    const priced = await quote(t.customer);
    expect(dec(priced.lines[0].makingCharge).toFixed(2)).toBe('30.00');
    expect(dec(plain.lines[0].makingCharge).toFixed(2)).toBe('0.00');
    const other = await quote(t.individual);
    expect(dec(other.lines[0].makingCharge).toFixed(2)).toBe('0.00');
  });

  it('takes VAT out of a tax-inclusive price rather than adding it', async () => {
    const { id, posted } = await trade(t, 'sales-invoices', t.individual, '1.000', {
      taxInclusive: true,
    });
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    const doc = (await get(`/sales-invoices/${id}`)).body.data as {
      grandTotal: string;
      taxTotal: string;
      taxableTotal: string;
    };
    // 1 g at 0.916 fine and 400 per fine gram is 366.40, which already includes the 5%.
    expect(dec(doc.grandTotal).toFixed(2)).toBe('366.40');
    expect(dec(doc.taxTotal).toFixed(2)).toBe('17.45');
    expect(dec(doc.taxableTotal).toFixed(2)).toBe('348.95');
  });
});

describe('reservations', () => {
  const reserve = (netWeight: string, lotId?: string) =>
    post('/stock/reservations', {
      warehouseId: t.warehouseId,
      productId: t.product,
      netWeight,
      reference: 'Held for a customer',
      ...(lotId ? { lotId } : {}),
    });

  it('holds stock back until released, once', async () => {
    const before = await balance();
    const lotId = before.lotId as string;
    const held = await reserve('5.000', lotId);
    expect(held.status, JSON.stringify(held.body)).toBe(201);
    const during = await lotBalance(lotId);
    expect(dec(during.availableNet).toFixed(3)).toBe(dec(before.availableNet).minus(5).toFixed(3));
    expect(dec(during.net).toFixed(3)).toBe(dec(before.net).toFixed(3));
    const id = held.body.data.id as string;
    expect((await post(`/stock/reservations/${id}/release`)).status).toBe(200);
    expect((await post(`/stock/reservations/${id}/release`)).status).toBe(409);
    expect(dec((await lotBalance(lotId)).availableNet).toFixed(3)).toBe(
      dec(before.availableNet).toFixed(3),
    );
  });

  it('refuses to reserve more than is available', async () => {
    expect((await reserve('999999.000', (await balance()).lotId)).status).toBe(422);
  });

  it('insists on a lot for lot-tracked stock', async () => {
    const res = await reserve('1.000');
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('Choose a lot');
  });
});

describe('physical counts', () => {
  it('books a variance after a second person approves it', async () => {
    const before = await balance();
    const countedNet = dec(before.net).minus(3).toFixed(3);
    const count = await post('/stock/counts', {
      warehouseId: t.warehouseId,
      lines: [{ productId: t.product, lotId: before.lotId, countedNet }],
    });
    expect(count.status, JSON.stringify(count.body)).toBe(201);
    expect(dec(count.body.data.lines[0].varianceNet).toFixed(3)).toBe('-3.000');
    const id = count.body.data.id as string;
    expect((await post(`/stock/counts/${id}/approve`)).status).toBe(422);
    const approved = await post(`/stock/counts/${id}/approve`, undefined, t.second);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(dec((await lotBalance(before.lotId as string)).net).toFixed(3)).toBe(countedNet);
    expect((await post(`/stock/counts/${id}/approve`, undefined, t.second)).status).toBe(409);
    const totals = await bookTotals();
    expect(totals.debit).toBe(totals.credit);
  });
});

describe('physical counts on lot-tracked stock', () => {
  it('will not count without a lot, which would book the whole weight as a gain', async () => {
    const res = await post('/stock/counts', {
      warehouseId: t.warehouseId,
      lines: [{ productId: t.product, countedNet: '1.000' }],
    });
    expect(res.status).toBe(422);
  });
});

describe('a role that may only count stock', () => {
  it('cannot post journals', async () => {
    const storekeeper = await addUser(t.companyId, 'keeper@example.com', 'Storekeeper');
    expect((await get('/journals', storekeeper)).status).toBe(403);
  });
});
