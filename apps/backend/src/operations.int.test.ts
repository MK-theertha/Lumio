import type { Express } from 'express';
import { strFromU8, unzipSync } from 'fflate';
import type { Redis } from 'ioredis';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createTestRedis,
  silentLogger,
  startTestDatabase,
  stopTestDatabase,
  testEnv,
} from '../test/harness.js';
import { api, auth, idem, oid, tenantKit, today, type Tenant } from '../test/tenant-kit.js';
import { createApp } from './app.js';
import { initRuntime } from './config/runtime.js';
import { createObjectStore } from './modules/documents/index.js';
import { EInvoiceModel, issueEInvoice, simulatedProvider } from './modules/einvoice/index.js';
import { runIntegrityChecks } from './modules/maintenance/index.js';
import { OutboxEventModel } from './modules/platform/outbox/index.js';
import { runDueSchedules, type ReportEmail } from './modules/reporting/index.js';
import { dueRange } from './modules/reporting/schedules.js';
import { decrypt } from './shared/crypto.js';
import { dec } from './shared/decimal.js';

let app: Express;
let redis: Redis;
const { addUser, setupTenant, trade, tradeBody, pay } = tenantKit(() => app);
const store = createObjectStore(testEnv);
let t: Tenant;
const get = (path: string, token = t.token) => request(app).get(api(path)).set(auth(token));
const post = (path: string, body?: object, token = t.token) =>
  request(app).post(api(path)).set(auth(token)).set(idem()).send(body);
const binary = (path: string, query: object = {}) =>
  request(app)
    .get(api(path))
    .query(query)
    .set(auth(t.token))
    .buffer(true)
    .parse((res, done) => {
      const parts: Buffer[] = [];
      res.on('data', (part: Buffer) => parts.push(part));
      res.on('end', () => done(null, Buffer.concat(parts)));
    });
const clean = async () => {
  const run = await runIntegrityChecks(oid(t.companyId), store);
  expect(run.findings).toEqual([]);
};

const stock = async () =>
  ((await get('/stock/balances')).body.data as { productId: string; net: string }[])
    .filter((r) => r.productId === t.product)
    .reduce((sum, r) => sum.plus(dec(r.net)), dec('0'));

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
  t = await setupTenant('OPS');
  const bought = await trade(t, 'purchase-invoices', t.supplier, '200.000');
  expect(bought.posted.status, JSON.stringify(bought.posted.body)).toBe(200);
});

afterAll(async () => {
  redis.disconnect();
  await stopTestDatabase();
});

const lineOf = async (path: string, id: string) =>
  (await get(`/${path}/${id}`)).body.data as {
    number: string;
    status: string;
    grandTotal: string;
    lines: {
      lineId: string;
      grossWeight: string;
      lineTotal: string;
      taxableValue: string;
      taxAmount: string;
      returned: boolean;
    }[];
  };

describe('partial returns', () => {
  it('returns part of a line, and the two parts still add up to the original', async () => {
    const { id, posted } = await trade(t, 'sales-invoices', t.customer, '3.000');
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    const before = await lineOf('sales-invoices', id);
    const line = before.lines[0]!;
    const held = await stock();
    const returned = await post(`/sales-invoices/${id}/returns`, {
      partial: [{ lineId: line.lineId, grossWeight: '1.000' }],
      reason: 'One bar returned',
      docDate: today,
    });
    expect(returned.status, JSON.stringify(returned.body)).toBe(201);
    expect((await stock()).toFixed(3)).toBe(held.plus(1).toFixed(3));

    const after = await lineOf('sales-invoices', id);
    expect(after.status).toBe('PARTIALLY_RETURNED');
    expect(after.lines).toHaveLength(2);
    const total = after.lines.reduce((sum, l) => sum.plus(dec(l.lineTotal)), dec('0'));
    expect(total.toFixed(2)).toBe(dec(line.lineTotal).toFixed(2));
    const gross = after.lines.reduce((sum, l) => sum.plus(dec(l.grossWeight)), dec('0'));
    expect(gross.toFixed(3)).toBe('3.000');
    await clean();
  });

  it('can return what is left, then nothing more', async () => {
    const { id } = await trade(t, 'sales-invoices', t.customer, '2.000');
    const doc = await lineOf('sales-invoices', id);
    await post(`/sales-invoices/${id}/returns`, {
      partial: [{ lineId: doc.lines[0]!.lineId, grossWeight: '0.500' }],
      reason: 'Part',
      docDate: today,
    });
    const rest = (await lineOf('sales-invoices', id)).lines.find((l) => !l.returned)!;
    const res = await post(`/sales-invoices/${id}/returns`, {
      lineIds: [rest.lineId],
      reason: 'Rest',
      docDate: today,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((await lineOf('sales-invoices', id)).status).toBe('RETURNED');
    await clean();
  });

  it('refuses a return of the whole line or more through the partial route', async () => {
    const { id } = await trade(t, 'sales-invoices', t.customer, '1.000');
    const doc = await lineOf('sales-invoices', id);
    const res = await post(`/sales-invoices/${id}/returns`, {
      partial: [{ lineId: doc.lines[0]!.lineId, grossWeight: '1.000' }],
      reason: 'x',
      docDate: today,
    });
    expect(res.status).toBe(422);
  });
});

describe('goods receipts', () => {
  const receive = (extra: object = {}, line: object = {}) =>
    post('/goods-receipts', {
      partyId: t.supplier,
      branchId: t.branchId,
      receiptDate: today,
      lines: [
        {
          productId: t.product,
          warehouseId: t.warehouseId,
          grossWeight: '10.000',
          cost: '3600.00',
          ...line,
        },
      ],
      ...extra,
    });

  it('brings stock in at receipt, and the invoice only settles the accrual', async () => {
    const before = await stock();
    const receipt = await receive();
    expect(receipt.status, JSON.stringify(receipt.body)).toBe(201);
    expect((await stock()).toFixed(3)).toBe(before.plus(10).toFixed(3));
    await clean();

    const created = await post(
      '/purchase-invoices',
      tradeBody(t, t.supplier, '10.000', {}) && {
        ...tradeBody(t, t.supplier, '10.000'),
        goodsReceiptId: receipt.body.data.id,
      },
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const posted = await post(`/purchase-invoices/${created.body.data.id}/post`);
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    expect((await stock()).toFixed(3)).toBe(before.plus(10).toFixed(3));
    const list = await get('/goods-receipts');
    expect(
      (list.body.data as { id: string; status: string }[]).find(
        (r) => r.id === receipt.body.data.id,
      )?.status,
    ).toBe('INVOICED');
    await clean();
  });

  it('cannot be invoiced twice, or against different goods', async () => {
    const receipt = await receive();
    const invoice = (gross: string) =>
      post('/purchase-invoices', {
        ...tradeBody(t, t.supplier, gross),
        goodsReceiptId: receipt.body.data.id,
      });
    const wrong = await invoice('9.000');
    expect((await post(`/purchase-invoices/${wrong.body.data.id}/post`)).status).toBe(422);
    const first = await invoice('10.000');
    expect((await post(`/purchase-invoices/${first.body.data.id}/post`)).status).toBe(200);
    const second = await invoice('10.000');
    expect((await post(`/purchase-invoices/${second.body.data.id}/post`)).status).toBe(409);
    await clean();
  });

  it('keeps a purchase order open until everything has arrived', async () => {
    const order = await post('/purchase-orders', {
      partyId: t.supplier,
      branchId: t.branchId,
      orderDate: today,
      lines: [{ productId: t.product, expectedWeight: '20.000' }],
    });
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    const purchaseOrderId = order.body.data.id as string;
    const statusOf = async () =>
      ((await get('/purchase-orders')).body.data as { id: string; status: string }[]).find(
        (o) => o.id === purchaseOrderId,
      )?.status;
    const part = await receive({ purchaseOrderId }, { expectedWeight: '12.000' });
    expect(dec(part.body.data.lines[0].varianceWeight).toFixed(3)).toBe('-2.000');
    expect(await statusOf()).toBe('OPEN');
    await receive({ purchaseOrderId });
    expect(await statusOf()).toBe('CLOSED');
    expect((await receive({ purchaseOrderId })).status).toBe(422);
  });
});

describe('documents after a return', () => {
  let invoiceId: string;
  let noteId: string;

  beforeAll(async () => {
    const { id } = await trade(t, 'sales-invoices', t.customer, '1.000');
    invoiceId = id;
    const doc = await lineOf('sales-invoices', id);
    const res = await post(`/sales-invoices/${id}/returns`, {
      lineIds: [doc.lines[0]!.lineId],
      reason: 'Wrong item',
      docDate: today,
    });
    noteId = res.body.data.id as string;
  });

  it('issues a credit note as a PDF', async () => {
    const pdf = await binary(`/sales-invoices/${invoiceId}/credit-notes/${noteId}/pdf`);
    expect(pdf.status).toBe(200);
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('sends the credit note as an e-invoice referring to the original', async () => {
    await issueEInvoice(oid(t.companyId), noteId, simulatedProvider);
    const row = (await EInvoiceModel.findOne({
      companyId: oid(t.companyId),
      sourceId: noteId,
    }).lean()) as { status: string; xml: string };
    const original = await lineOf('sales-invoices', invoiceId);
    expect(row.status).toBe('ACCEPTED');
    expect(row.xml).toContain('<cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode>');
    expect(row.xml).toContain(`<cbc:ID>${original.number}</cbc:ID>`);
    expect(row.xml).toContain('<cac:CreditNoteLine>');
  });

  it('queues an emailed invoice with the address sealed', async () => {
    const queued = await post(`/sales-invoices/${invoiceId}/email`, { to: 'buyer@example.com' });
    expect(queued.status, JSON.stringify(queued.body)).toBe(200);
    const event = (await OutboxEventModel.findOne({ type: 'invoice.email' })
      .sort({ _id: -1 })
      .lean()) as { payload: { sealedTo: string } };
    expect(JSON.stringify(event.payload)).not.toContain('buyer@example.com');
    expect(decrypt(event.payload.sealedTo)).toBe('buyer@example.com');
  });

  it('will not email to nobody', async () => {
    const res = await post(`/sales-invoices/${invoiceId}/email`, {});
    expect(res.status).toBe(422);
  });

  it('draws Arabic names without failing', async () => {
    const created = await post('/parties', {
      code: 'AR1',
      name: 'شركة الميناء للتجارة',
      type: 'BUSINESS',
      roles: ['CUSTOMER'],
    });
    const { id } = await trade(t, 'sales-invoices', created.body.data.id as string, '1.000');
    const pdf = await binary(`/sales-invoices/${id}/pdf`);
    expect(pdf.status).toBe(200);
    expect((pdf.body as Buffer).toString('latin1')).toContain('NotoNaskhArabic');
  });
});

describe('bank items and period close', () => {
  const statement = (rows: string[]) =>
    post('/bank-statements/import', {
      financialAccountId: t.bank,
      csv: ['Date,Description,Amount', ...rows].join('\n'),
      dateOrder: 'YMD',
    });
  const unmatched = async () =>
    (
      await request(app)
        .get(api('/bank-statement-lines'))
        .query({ financialAccountId: t.bank, status: 'UNMATCHED' })
        .set(auth(t.token))
    ).body.data as { id: string; amount: string }[];

  it('nets a returned cheque against its deposit, and only exact opposites', async () => {
    await statement([
      `${today},Cheque in,700.00`,
      `${today},Cheque returned,-700.00`,
      `${today},Other,-1.00`,
    ]);
    const open = await unmatched();
    const deposit = open.find((l) => Number(l.amount) === 700)!;
    const returned = open.find((l) => Number(l.amount) === -700)!;
    const other = open.find((l) => Number(l.amount) === -1)!;
    expect(
      (await post(`/bank-statement-lines/${deposit.id}/net`, { otherLineId: other.id })).status,
    ).toBe(422);
    expect((await unmatched()).length).toBe(3);
    const netted = await post(`/bank-statement-lines/${deposit.id}/net`, {
      otherLineId: returned.id,
    });
    expect(netted.status, JSON.stringify(netted.body)).toBe(200);
    expect((await unmatched()).length).toBe(1);
  });

  it('will not start closing a period with unexplained bank lines', async () => {
    const periods = (await get('/periods')).body.data as {
      id: string;
      from: string;
      to: string;
    }[];
    const now = Date.now();
    const current = periods.find(
      (p) => new Date(p.from).getTime() <= now && now <= new Date(p.to).getTime(),
    )!;
    const res = await post(`/periods/${current.id}/begin-close`);
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('bank statement');
  });

  it('shows a running cash book', async () => {
    await pay(t, 'RECEIPT', t.customer, '500.00');
    await pay(t, 'PAYMENT', t.supplier, '125.00');
    const res = await get(`/cash-book?financialAccountId=${t.bank}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.closing).toBe('375.00');
    expect(res.body.data.rows.at(-1).balance).toBe('375.00');
  });
});

describe('foreign currency', () => {
  const accounts = async () => {
    const rows = (await get('/ledger-accounts')).body.data as { id: string; code: string }[];
    return [rows.find((r) => r.code === '1010')!.id, rows.find((r) => r.code === '3000')!.id];
  };

  it('records foreign detail on a journal, and rejects a rate that does not agree', async () => {
    const [bank, equity] = await accounts();
    const draft = (base: string) =>
      post('/journal-drafts', {
        postingDate: today,
        memo: 'USD deposit',
        branchId: t.branchId,
        lines: [
          {
            accountId: bank,
            debit: base,
            credit: '0',
            currency: 'USD',
            foreignAmount: '100.00',
            exchangeRate: '3.6725',
          },
          { accountId: equity, debit: '0', credit: base },
        ],
      });
    expect((await draft('999.00')).status).toBe(422);
    const created = await draft('367.25');
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const posted = await post(`/journal-drafts/${created.body.data.id}/post`, undefined, t.second);
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    const line = await mongoose.connection
      .db!.collection('journalLines')
      .findOne({ companyId: oid(t.companyId), currency: 'USD' });
    expect(String(line!.foreignAmount)).toBe('100.00');
    expect(String(line!.debit)).toBe('367.25');
  });

  it('will not post an invoice in another currency at face value', async () => {
    const created = await post('/sales-invoices', {
      ...tradeBody(t, t.customer, '1.000'),
      currency: 'USD',
      lines: [
        {
          productId: t.product,
          warehouseId: t.warehouseId,
          grossWeight: '1.000',
          rateOverride: { basis: 'FINE_GRAM', value: '100' },
        },
      ],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const posted = await post(`/sales-invoices/${created.body.data.id}/post`);
    expect(posted.status).toBe(422);
    expect(posted.body.error.message).toContain('AED');
  });
});

describe('reports', () => {
  const keyOf = async () =>
    ((await get('/reports')).body.data as { key: string }[]).find((r) => r.key.startsWith('sales'))!
      .key;

  it('exports a real workbook, keeping text out of formulas', async () => {
    const key = await keyOf();
    const res = await binary(`/reports/${key}`, { format: 'xlsx' });
    expect(res.status).toBe(200);
    const files = unzipSync(new Uint8Array(res.body as Buffer));
    expect(Object.keys(files)).toContain('xl/worksheets/sheet1.xml');
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml']!);
    expect(sheet).toContain('<sheetData>');
    expect(sheet).not.toContain('<f>');
  });

  it('exports a PDF', async () => {
    const res = await binary(`/reports/${await keyOf()}`, { format: 'pdf' });
    expect((res.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('refuses an export without the export permission', async () => {
    const keeper = await addUser(t.companyId, 'keeper-ops@example.com', 'Sales Executive');
    const role = await post('/roles', { name: 'Readers', permissions: ['report:read'] });
    expect(role.status).toBe(201);
    const reader = await addUser(t.companyId, 'reader-ops@example.com', 'Readers');
    const res = await request(app)
      .get(api(`/reports/${await keyOf()}`))
      .query({ format: 'xlsx' })
      .set(auth(reader));
    expect(res.status).toBe(403);
    expect(keeper).toBeTruthy();
  });

  it('works out which schedules are due', () => {
    const monday = new Date('2026-11-09T02:00:00Z');
    const tuesday = new Date('2026-11-10T02:00:00Z');
    const first = new Date('2026-12-01T02:00:00Z');
    expect(dueRange('DAILY', tuesday)?.from.toISOString().slice(0, 10)).toBe('2026-11-09');
    expect(dueRange('WEEKLY', tuesday)).toBeNull();
    expect(dueRange('WEEKLY', monday)?.from.toISOString().slice(0, 10)).toBe('2026-11-02');
    expect(dueRange('MONTHLY', monday)).toBeNull();
    expect(dueRange('MONTHLY', first)?.from.toISOString().slice(0, 10)).toBe('2026-11-01');
  });

  it('emails a scheduled report once a day', async () => {
    const created = await post('/report-schedules', {
      reportKey: await keyOf(),
      frequency: 'DAILY',
      format: 'XLSX',
      recipients: ['owner@example.com'],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const sent: ReportEmail[] = [];
    const send = (email: ReportEmail) => {
      sent.push(email);
      return Promise.resolve();
    };
    expect(await runDueSchedules(oid(t.companyId), send)).toBe(1);
    expect(await runDueSchedules(oid(t.companyId), send)).toBe(0);
    expect(sent[0]?.to).toEqual(['owner@example.com']);
    expect(sent[0]?.attachments[0]?.filename).toMatch(/xlsx$/);
  });

  it('refuses a schedule for a report the person cannot see', async () => {
    const res = await post('/report-schedules', {
      reportKey: 'no-such-report',
      frequency: 'DAILY',
      format: 'PDF',
      recipients: ['a@example.com'],
    });
    expect(res.status).toBe(422);
  });

  it('builds a statement with a running balance', async () => {
    const created = await post('/parties', {
      code: 'ST1',
      name: 'Statement Co',
      type: 'BUSINESS',
      roles: ['CUSTOMER'],
    });
    const partyId = created.body.data.id as string;
    await trade(t, 'sales-invoices', partyId, '1.000');
    await pay(t, 'RECEIPT', partyId, '100.00');
    const res = await get(`/party-statements/${partyId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.rows).toHaveLength(2);
    const [sale, receipt] = res.body.data.rows as {
      debit: string;
      credit: string;
      balance: string;
    }[];
    expect(dec(receipt!.balance).toFixed(2)).toBe(dec(sale!.debit).minus(100).toFixed(2));
    expect(res.body.data.closing).toBe(receipt!.balance);
  });
});

describe('year-end close', () => {
  it('moves the profit to retained earnings, without changing the profit reported', async () => {
    const year = new Date().getUTCFullYear() - 1;
    const created = await post('/periods/year', { year });
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
    const lastDay = `${year}-12-15`;
    const bought = await post('/purchase-invoices', {
      ...tradeBody(t, t.supplier, '5.000'),
      docDate: lastDay,
    });
    expect((await post(`/purchase-invoices/${bought.body.data.id}/post`)).status).toBe(200);
    const sold = await post('/sales-invoices', {
      ...tradeBody(t, t.individual, '1.000', {
        rateOverride: { basis: 'FINE_GRAM', value: '500' },
      }),
      docDate: lastDay,
    });
    const posted = await post(`/sales-invoices/${sold.body.data.id}/post`);
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);

    const range = `from=${year}-01-01&to=${year}-12-31`;
    const profit = async () =>
      (await get(`/statements/profit-and-loss?${range}`)).body.data.netProfit as string;
    const before = await profit();
    expect((await post('/periods/year-end', { year })).status).toBe(422);

    const periods = mongoose.connection.db!.collection('financialPeriods');
    await periods.updateMany(
      {
        companyId: oid(t.companyId),
        from: { $gte: new Date(Date.UTC(year, 0, 1)), $lt: new Date(Date.UTC(year, 11, 1)) },
      },
      { $set: { status: 'CLOSED', updatedAt: new Date() } },
    );
    const closed = await post('/periods/year-end', { year });
    expect(closed.status, JSON.stringify(closed.body)).toBe(201);
    expect((await post('/periods/year-end', { year })).status).toBe(409);
    expect(dec(before).greaterThan(0)).toBe(true);
    expect(await profit()).toBe(before);

    const sheet = await get(`/statements/balance-sheet?to=${year}-12-31`);
    expect(sheet.body.data.balanced).toBe(true);
    expect(sheet.body.data.currentEarnings).toBe('0.00');
    const retained = (sheet.body.data.equity as { code: string; amount: string }[]).find(
      (e) => e.code === '3100',
    );
    expect(retained?.amount).toBe(before);
    await clean();
  });
});

describe('working across companies', () => {
  it('switches company only where a role is held, and access follows', async () => {
    const other = await setupTenant('OTHER');
    const email = 'multi@example.com';
    const token = await addUser(t.companyId, email, 'Accountant');
    const roles = await request(app).get(api('/roles')).set(auth(other.token));
    const storekeeper = (roles.body.data as { id: string; name: string }[]).find(
      (r) => r.name === 'Storekeeper',
    )!;
    const added = await request(app)
      .post(api('/users'))
      .set(auth(other.token))
      .send({ email, name: 'Multi', assignments: [{ roleId: storekeeper.id, branchIds: [] }] });
    expect(added.status, JSON.stringify(added.body)).toBe(201);

    const companies = await get('/auth/companies', token);
    expect(companies.body.data).toHaveLength(2);
    expect((await get('/journals', token)).status).toBe(200);

    const switched = await post('/auth/switch-company', { companyId: other.companyId }, token);
    expect(switched.status, JSON.stringify(switched.body)).toBe(200);
    const next = switched.body.data.accessToken as string;
    expect(switched.body.data.user.companyId).toBe(other.companyId);
    expect((await get('/journals', next)).status).toBe(403);
    expect((await get('/stock/balances', next)).status).toBe(200);
  });

  it('refuses a company where no role is held', async () => {
    const stranger = await setupTenant('STRANGER');
    const res = await post('/auth/switch-company', { companyId: stranger.companyId });
    expect(res.status).toBe(403);
  });
});

describe('breached passwords', () => {
  const email = 'admin-OPS@example.com';
  const change = (next: string) =>
    post('/auth/change-password', { currentPassword: 'correct-horse-battery', newPassword: next });

  it('rejects a known breached password, sending only part of its hash', async () => {
    initRuntime({ ...testEnv, PASSWORD_BREACH_CHECK: true });
    const password = 'password1234567';
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha1').update(password).digest('hex').toUpperCase();
    const real = globalThis.fetch;
    const urls: string[] = [];
    const stub = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      if (!url.includes('pwnedpasswords')) return real(input, init);
      urls.push(url);
      return Promise.resolve(new Response(`AAAA:1\r\n${hash.slice(5)}:42\r\nFFFF:0`));
    });
    try {
      const res = await change(password);
      expect(res.status).toBe(422);
      expect(res.body.error.message).toContain('data breach');
      expect(urls[0]).toMatch(new RegExp(`/range/${hash.slice(0, 5)}$`));
      expect(urls[0]).not.toContain(hash.slice(5));
    } finally {
      stub.mockRestore();
      initRuntime(testEnv);
    }
  });

  it('still lets people change password if the service is down', async () => {
    initRuntime({ ...testEnv, PASSWORD_BREACH_CHECK: true });
    const real = globalThis.fetch;
    const stub = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation((input, init) =>
        String(input).includes('pwnedpasswords')
          ? Promise.reject(new Error('offline'))
          : real(input, init),
      );
    try {
      const res = await change('a-long-and-unusual-passphrase');
      expect(res.status).toBe(200);
    } finally {
      stub.mockRestore();
      initRuntime(testEnv);
    }
    expect(email).toBeTruthy();
  });
});
