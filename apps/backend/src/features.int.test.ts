import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
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
  testContext,
  testEnv,
} from '../test/harness.js';
import { createApp } from './app.js';
import { RoleAssignmentModel, RoleModel } from './modules/access/index.js';
import { rescreenAllParties, screenTransaction } from './modules/compliance/index.js';
import {
  clamavScanner,
  createObjectStore,
  DocumentModel,
  scanDocument,
  uploadDocument,
} from './modules/documents/index.js';
import {
  EInvoiceModel,
  issueEInvoice,
  simulatedProvider,
  type EInvoiceProvider,
} from './modules/einvoice/index.js';
import { hashPassword, UserModel } from './modules/identity/index.js';
import { provisionCompany } from './modules/onboarding/index.js';

// Names, rates and tax codes below are test fixtures, not approved business rules.
let app: Express;
let redis: Redis;
const PASSWORD = 'correct-horse-battery';
const today = new Date().toISOString().slice(0, 10);
const PDF = Buffer.from('%PDF-1.7\nfixture file\n%%EOF');

interface Tenant {
  token: string;
  second: string;
  companyId: string;
  branchId: string;
  warehouseId: string;
  product: string;
  customer: string;
  individual: string;
  supplier: string;
  bank: string;
  method: string;
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const idem = () => ({ 'Idempotency-Key': randomUUID() });
const oid = (id: string) => new mongoose.Types.ObjectId(id);
const api = (path: string) => `/api/v1${path}`;

async function login(email: string): Promise<string> {
  const res = await request(app).post(api('/auth/login')).send({ email, password: PASSWORD });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data.accessToken as string;
}

async function addUser(companyId: string, email: string, roleName: string): Promise<string> {
  const company = oid(companyId);
  const user = await UserModel.create({
    email: email.toLowerCase(),
    name: 'Second Person',
    status: 'ACTIVE',
    passwordHash: await hashPassword(PASSWORD),
    activeCompanyId: company,
  });
  const role = (await RoleModel.findOne({ companyId: company, name: roleName }).lean()) as {
    _id: mongoose.Types.ObjectId;
  };
  await RoleAssignmentModel.create({ companyId: company, userId: user._id, roleId: role._id });
  return login(email);
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
      adminName: 'Admin User',
      branchName: 'Head office',
    },
    { adminPassword: PASSWORD, isDemo: true },
  );
  const token = await login(email);
  const second = await addUser(companyId, `second-${code}@example.com`, 'Company Administrator');
  const post = async (path: string, body: object) => {
    const res = await request(app).post(api(path)).set(auth(token)).send(body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.data.id as string;
  };
  const first = async (path: string) => {
    const res = await request(app).get(api(path)).set(auth(token));
    return res.body.data[0].id as string;
  };
  const patched = await request(app)
    .patch(api('/company'))
    .set(auth(token))
    .send({
      taxRegistrationNumber: '100000000000003',
      settings: { requireVerifiedTaxCodes: false },
    });
  expect(patched.status, JSON.stringify(patched.body)).toBe(200);
  const branchId = await first('/branches');
  const warehouseId = await first('/warehouses');
  const purity = await post('/purities', {
    code: '22K',
    label: '22 karat',
    karat: '22',
    fineness: '0.9160',
  });
  const product = await post('/products', {
    sku: 'BAR-22',
    name: '22K bar',
    kind: 'BAR',
    purityId: purity,
    tracking: 'LOT',
  });
  const party = (partyCode: string, name: string, type: string, roles: string[]) =>
    post('/parties', { code: partyCode, name, type, roles });
  const customer = await party('C1', 'Harbour Traders', 'BUSINESS', ['CUSTOMER']);
  const individual = await party('C2', 'Layla Rahman', 'INDIVIDUAL', ['CUSTOMER']);
  const supplier = await party('S1', 'Refinery One', 'BUSINESS', ['SUPPLIER']);
  const tax = await post('/tax-codes', {
    code: 'STD5',
    name: 'Standard 5%',
    ratePercent: '5',
    treatment: 'STANDARD',
  });
  await post('/tax-rules', { name: 'All', priority: 10, taxCodeId: tax });
  await post('/gold-rates', { basis: 'FINE_GRAM', value: '400.0000', currency: 'AED' });
  const bank = await first('/financial-accounts?q=BANK');
  const method = await first('/payment-methods');
  return {
    token,
    second,
    companyId,
    branchId,
    warehouseId,
    product,
    customer,
    individual,
    supplier,
    bank,
    method,
  };
}

async function trade(t: Tenant, path: string, partyId: string, gross: string) {
  const created = await request(app)
    .post(api(`/${path}`))
    .set(auth(t.token))
    .send({
      partyId,
      branchId: t.branchId,
      docDate: today,
      currency: 'AED',
      lines: [{ productId: t.product, warehouseId: t.warehouseId, grossWeight: gross }],
    });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.data.id as string;
  const posted = await request(app)
    .post(api(`/${path}/${id}/post`))
    .set(auth(t.token))
    .set(idem());
  return { id, posted };
}

const pay = (t: Tenant, direction: string, partyId: string, amount: string, reference?: string) =>
  request(app)
    .post(api('/payments'))
    .set(auth(t.token))
    .set(idem())
    .send({
      direction,
      partyId,
      branchId: t.branchId,
      financialAccountId: t.bank,
      methodId: t.method,
      amount,
      paymentDate: today,
      ...(reference ? { reference } : {}),
      allocations: [],
    });

const upload = (t: Tenant, data: Buffer, query: Record<string, string>) =>
  request(app)
    .post(api('/documents'))
    .query({ category: 'OTHER', fileName: 'proof.pdf', ...query })
    .set(auth(t.token))
    .set('Content-Type', 'application/octet-stream')
    .send(data);

const importList = (t: Tenant, csv: string, source = 'TEST') =>
  request(app)
    .post(api('/sanctions/lists/import'))
    .query({ source, format: 'CSV' })
    .set(auth(t.token))
    .set('Content-Type', 'text/csv')
    .send(csv);

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
  const stocked = await trade(a, 'purchase-invoices', a.supplier, '1000.000');
  expect(stocked.posted.status, JSON.stringify(stocked.posted.body)).toBe(200);
});

afterAll(async () => {
  redis.disconnect();
  await stopTestDatabase();
});

describe('documents', () => {
  it('stores a file privately and returns exactly those bytes', async () => {
    const created = await upload(a, PDF, { ownerType: 'PARTY', ownerId: a.customer });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data).toMatchObject({
      mime: 'application/pdf',
      scanStatus: 'SCAN_SKIPPED',
    });
    expect(JSON.stringify(created.body)).not.toContain('storageKey');
    const download = await request(app)
      .get(api(`/documents/${created.body.data.id}/content`))
      .set(auth(a.token))
      .buffer(true)
      .parse((res, done) => {
        const parts: Buffer[] = [];
        res.on('data', (part: Buffer) => parts.push(part));
        res.on('end', () => done(null, Buffer.concat(parts)));
      });
    expect(download.status).toBe(200);
    expect(download.headers['content-disposition']).toContain('attachment');
    expect((download.body as Buffer).equals(PDF)).toBe(true);
  });

  it('judges the type by content, not by what the client claims', async () => {
    const res = await upload(a, Buffer.from('MZ pretending to be a pdf'), {
      ownerType: 'PARTY',
      ownerId: a.customer,
      fileName: 'invoice.pdf',
    });
    expect(res.status).toBe(422);
  });

  it('removes any path from the file name', async () => {
    const res = await upload(a, PDF, {
      ownerType: 'PARTY',
      ownerId: a.customer,
      fileName: '../../etc/pass"wd.pdf',
    });
    expect(res.body.data.fileName).toBe('passwd.pdf');
  });

  it('refuses files over the size limit', async () => {
    const res = await upload(a, Buffer.concat([PDF, Buffer.alloc(11 * 1024 * 1024)]), {
      ownerType: 'PARTY',
      ownerId: a.customer,
    });
    expect(res.status).toBe(413);
  });

  it('keeps each company to its own documents', async () => {
    const created = await upload(a, PDF, { ownerType: 'PARTY', ownerId: a.customer });
    const read = await request(app)
      .get(api(`/documents/${created.body.data.id}/content`))
      .set(auth(b.token));
    expect(read.status).toBe(404);
    const attach = await upload(b, PDF, { ownerType: 'PARTY', ownerId: a.customer });
    expect(attach.status).toBe(404);
  });

  it('versions a replacement and archives what it replaced', async () => {
    const first = await upload(a, PDF, { ownerType: 'PARTY', ownerId: a.individual });
    const next = await upload(a, PDF, {
      ownerType: 'PARTY',
      ownerId: a.individual,
      replaces: first.body.data.id,
    });
    expect(next.body.data.version).toBe(2);
    const list = await request(app)
      .get(api('/documents'))
      .query({ ownerType: 'PARTY', ownerId: a.individual })
      .set(auth(a.token));
    expect(list.body.data.map((d: { id: string }) => d.id)).toEqual([next.body.data.id]);
  });

  it('lists documents that are close to expiring', async () => {
    const soon = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    const created = await upload(a, PDF, {
      ownerType: 'PARTY',
      ownerId: a.supplier,
      expiresAt: soon,
    });
    const list = await request(app)
      .get(api('/documents'))
      .query({ expiringWithinDays: 30 })
      .set(auth(a.token));
    expect(list.body.data.map((d: { id: string }) => d.id)).toContain(created.body.data.id);
  });

  it('holds KYC files back from roles without KYC access', async () => {
    const kyc = await request(app).post(api('/kyc-records')).set(auth(a.token)).send({
      partyId: a.individual,
      documentType: 'PASSPORT',
      documentNumber: 'P7654321',
    });
    const created = await upload(a, PDF, { ownerType: 'KYC', ownerId: kyc.body.data.id });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const role = await request(app)
      .post(api('/roles'))
      .set(auth(a.token))
      .send({ name: 'Doc reader', permissions: ['document:read'] });
    expect(role.status, JSON.stringify(role.body)).toBe(201);
    const reader = await addUser(a.companyId, 'reader-alpha@example.com', 'Doc reader');
    const direct = await request(app)
      .get(api(`/documents/${created.body.data.id}/content`))
      .set(auth(reader));
    expect(direct.status).toBe(403);
    const list = await request(app).get(api('/documents')).set(auth(reader));
    expect(list.status).toBe(200);
    expect(list.body.data.some((d: { ownerType: string }) => d.ownerType === 'KYC')).toBe(false);
  });

  describe('malware scanning through the clamd protocol', () => {
    let clamd: Server;
    let scanner: ReturnType<typeof clamavScanner>;
    const store = createObjectStore(testEnv);
    const ctx = () =>
      testContext({ companyId: oid(a.companyId), permissions: new Set(['kyc:read']) });
    const send = (data: Buffer) =>
      uploadDocument(
        ctx(),
        { ownerType: 'PARTY', ownerId: a.customer, category: 'OTHER', fileName: 'x.pdf' },
        data,
        store,
        scanner,
      ) as Promise<{ _id: mongoose.Types.ObjectId }>;
    const content = (id: string) =>
      request(app)
        .get(api(`/documents/${id}/content`))
        .set(auth(a.token));

    beforeAll(async () => {
      // A stand-in for the daemon that follows its wire format: length-prefixed chunks, zero to end.
      clamd = createServer((socket) => {
        let buffer = Buffer.alloc(0);
        socket.on('data', (part) => {
          buffer = Buffer.concat([buffer, part]);
          const body = buffer.subarray('zINSTREAM\0'.length);
          let offset = 0;
          const payload: Buffer[] = [];
          while (offset + 4 <= body.length) {
            const size = body.readUInt32BE(offset);
            if (size === 0) {
              socket.end(
                Buffer.concat(payload).includes('EICAR')
                  ? 'stream: Eicar-Test-Signature FOUND\0'
                  : 'stream: OK\0',
              );
              return;
            }
            if (offset + 4 + size > body.length) return;
            payload.push(body.subarray(offset + 4, offset + 4 + size));
            offset += 4 + size;
          }
        });
      });
      await new Promise<void>((resolve) => clamd.listen(0, '127.0.0.1', resolve));
      scanner = clamavScanner('127.0.0.1', (clamd.address() as AddressInfo).port);
    });

    afterAll(() => {
      clamd.close();
    });

    it('blocks download until a clean verdict arrives', async () => {
      const created = await send(PDF);
      const id = created._id.toString();
      expect((await content(id)).status).toBe(409);
      await scanDocument(a.companyId, id, store, scanner);
      expect((await content(id)).status).toBe(200);
    });

    it('deletes an infected file and never serves it', async () => {
      const created = await send(Buffer.concat([PDF, Buffer.from('EICAR')]));
      const id = created._id.toString();
      await scanDocument(a.companyId, id, store, scanner);
      const row = (await DocumentModel.findOne({
        companyId: oid(a.companyId),
        _id: id,
      }).lean()) as {
        scanStatus: string;
        scanSignature: string;
        storageKey: string;
      };
      expect(row).toMatchObject({ scanStatus: 'INFECTED', scanSignature: 'Eicar-Test-Signature' });
      expect((await content(id)).status).toBe(409);
      await expect(store.get(row.storageKey)).rejects.toThrow();
    });

    it('leaves the file blocked when the scanner is unavailable', async () => {
      const created = await send(PDF);
      const id = created._id.toString();
      const offline = clamavScanner('127.0.0.1', 1);
      await expect(scanDocument(a.companyId, id, store, offline)).rejects.toThrow();
      expect((await content(id)).status).toBe(409);
    });
  });
});

describe('sanctions screening', () => {
  const LIST =
    'externalId,name,aliases,type\nT1,Viktor Dragomir,V. Dragomir;Victor Dragomirov,INDIVIDUAL\n';
  const newParty = async (t: Tenant, partyCode: string, name: string) => {
    const res = await request(app)
      .post(api('/parties'))
      .set(auth(t.token))
      .send({ code: partyCode, name, type: 'INDIVIDUAL', roles: ['CUSTOMER'] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.data.id as string;
  };
  const status = async (t: Tenant, id: string) =>
    (
      await request(app)
        .get(api(`/parties/${id}`))
        .set(auth(t.token))
    ).body.data.sanctionsStatus as string;
  const matches = async (t: Tenant, partyId: string) =>
    (
      (await request(app).get(api('/sanctions/matches')).set(auth(t.token))).body.data as {
        id: string;
        partyId: string;
        status: string;
      }[]
    ).filter((m) => m.partyId === partyId);
  const decide = (t: Tenant, id: string, decision: string) =>
    request(app)
      .post(api(`/sanctions/matches/${id}/decision`))
      .set(auth(t.token))
      .send({ decision, note: 'Reviewed against passport' });

  it('does not call a party clear when no list has been imported', async () => {
    const id = await newParty(b, 'NOLIST', 'Viktor Dragomir');
    expect(await status(b, id)).toBe('NOT_SCREENED');
  });

  it('flags a new party on a list, under a spelling variation', async () => {
    expect((await importList(a, LIST)).status).toBe(201);
    const id = await newParty(a, 'HIT1', 'Dragomir, Victor');
    expect(await status(a, id)).toBe('POTENTIAL_MATCH');
    const clean = await newParty(a, 'OK1', 'Priya Nair');
    expect(await status(a, clean)).toBe('CLEAR');
  });

  it('never lets an empty file replace a working list', async () => {
    expect((await importList(a, 'externalId,name,aliases,type\n')).status).toBe(422);
    const lists = await request(app).get(api('/sanctions/lists')).set(auth(a.token));
    expect(lists.body.data.length).toBeGreaterThan(0);
  });

  it('stops sales and payments for a flagged party, without saying why', async () => {
    const id = await newParty(a, 'HIT2', 'Viktor Dragomir');
    const sale = await trade(a, 'sales-invoices', id, '1.000');
    expect(sale.posted.status).toBe(422);
    expect(sale.posted.body.error.message).not.toMatch(/sanction|list/i);
    const payment = await pay(a, 'RECEIPT', id, '10.00');
    expect(payment.status).toBe(422);
  });

  it('lifts the hold once a reviewer clears the match', async () => {
    const id = await newParty(a, 'HIT3', 'Viktor Dragomir ');
    const [match] = await matches(a, id);
    expect((await decide(a, match!.id, 'FALSE_POSITIVE')).status).toBe(200);
    expect(await status(a, id)).toBe('CLEAR');
    const sale = await trade(a, 'sales-invoices', id, '1.000');
    expect(sale.posted.status, JSON.stringify(sale.posted.body)).toBe(200);
    expect((await decide(a, match!.id, 'CONFIRMED')).status).toBe(409);
  });

  it('remembers a cleared match, but reviews it again if the name changes', async () => {
    const id = await newParty(a, 'HIT4', 'Viktor Dragomir');
    const [match] = await matches(a, id);
    await decide(a, match!.id, 'FALSE_POSITIVE');
    await rescreenAllParties(oid(a.companyId));
    expect(await status(a, id)).toBe('CLEAR');
    await request(app)
      .patch(api(`/parties/${id}`))
      .set(auth(a.token))
      .send({ name: 'Victor Dragomir' });
    expect(await status(a, id)).toBe('POTENTIAL_MATCH');
  });

  it('keeps a confirmed party blocked and raises its risk', async () => {
    const id = await newParty(a, 'HIT5', 'Viktor Dragomir');
    const [match] = await matches(a, id);
    await decide(a, match!.id, 'CONFIRMED');
    const party = await request(app)
      .get(api(`/parties/${id}`))
      .set(auth(a.token));
    expect(party.body.data).toMatchObject({
      sanctionsStatus: 'CONFIRMED_MATCH',
      riskLevel: 'HIGH',
    });
    expect((await trade(a, 'sales-invoices', id, '1.000')).posted.status).toBe(422);
  });

  it('checks existing parties against a newly imported list', async () => {
    const id = await newParty(a, 'LATER', 'Samira Haddad');
    expect(await status(a, id)).toBe('CLEAR');
    await importList(a, 'externalId,name,aliases,type\nT9,Samira Haddad,,INDIVIDUAL\n', 'LOCAL');
    await rescreenAllParties(oid(a.companyId));
    expect(await status(a, id)).toBe('POTENTIAL_MATCH');
  });

  it('keeps matches away from roles that are only allowed to read', async () => {
    const accountant = await addUser(a.companyId, 'acct-alpha@example.com', 'Accountant');
    const res = await request(app).get(api('/sanctions/matches')).set(auth(accountant));
    expect(res.status).toBe(403);
  });

  it('keeps lists and matches within one company', async () => {
    const own = await newParty(a, 'ISO', 'Viktor Dragomir');
    const [match] = await matches(a, own);
    expect((await decide(b, match!.id, 'FALSE_POSITIVE')).status).toBe(409);
    expect(await status(a, own)).toBe('POTENTIAL_MATCH');
  });
});

describe('goAML reports', () => {
  const report = (token: string, caseIds: string[], reportType = 'DPMSR') =>
    request(app)
      .post(api('/goaml-reports'))
      .set(auth(token))
      .send({ reportType, caseIds, reason: 'Cash purchase above the threshold', indicators: [] });

  async function openCase(t: Tenant, amount: string): Promise<string> {
    const rule = await request(app)
      .post(api('/compliance-rules'))
      .set(auth(t.token))
      .send({
        name: `Cash ${randomUUID()}`,
        trigger: 'SALE_POSTED',
        thresholdAmount: '1',
        severity: 'MEDIUM',
      });
    expect(rule.status, JSON.stringify(rule.body)).toBe(201);
    const { id: sourceId } = await trade(t, 'sales-invoices', t.individual, '1.000');
    await screenTransaction({
      companyId: t.companyId,
      trigger: 'SALE_POSTED',
      sourceId,
      sourceNumber: 'INV',
      partyId: t.individual,
      amount,
    });
    const cases = await request(app).get(api('/compliance-cases')).set(auth(t.token));
    return (cases.body.data as { id: string; sourceId: string }[]).find(
      (c) => c.sourceId === sourceId,
    )!.id;
  }

  it('warns about missing subject details while it can still be fixed', async () => {
    const id = await openCase(a, '60000.00');
    const res = await report(a.token, [id]);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.status).toBe('DRAFT');
    expect(res.body.data.warnings).toContain('The company has no goAML reporting entity ID.');
    expect(res.body.data.warnings).toContain('Layla Rahman: no date of birth.');
    expect(JSON.stringify(res.body)).not.toContain('xmlSealed');
  });

  it('takes a second person and an entity ID, then files and closes the case', async () => {
    const caseId = await openCase(a, '61000.00');
    const created = await report(a.token, [caseId]);
    const id = created.body.data.id as string;
    const approve = (token: string) =>
      request(app)
        .post(api(`/goaml-reports/${id}/approve`))
        .set(auth(token));

    expect((await approve(a.token)).status).toBe(422);
    expect((await approve(a.second)).status).toBe(422);
    await request(app)
      .patch(api('/company'))
      .set(auth(a.token))
      .send({ goamlEntityId: 'RE-12345' });
    const approved = await approve(a.second);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.data).toMatchObject({ status: 'APPROVED', hasXml: true });

    const xml = await request(app)
      .get(api(`/goaml-reports/${id}/xml`))
      .set(auth(a.token));
    expect(xml.headers['content-type']).toMatch(/xml/);
    expect(xml.text).toContain('<rentity_id>RE-12345</rentity_id>');
    expect(xml.text).toContain('<report_code>DPMSR</report_code>');
    expect(xml.text).toContain('<last_name>Rahman</last_name>');

    const stored = await mongoose.connection.db!.collection('goamlReports').findOne({
      _id: oid(id),
    });
    expect(JSON.stringify(stored)).not.toContain('<last_name>');

    const filed = await request(app)
      .post(api(`/goaml-reports/${id}/submitted`))
      .set(auth(a.token))
      .send({ fiuReference: 'FIU-777' });
    expect(filed.status, JSON.stringify(filed.body)).toBe(200);
    const cases = await request(app).get(api('/compliance-cases')).set(auth(a.token));
    expect(cases.body.data.find((c: { id: string }) => c.id === caseId).status).toBe('REPORTED');
    expect((await report(a.token, [caseId])).status).toBe(409);
  });

  it('includes the verified identity number in the frozen report', async () => {
    const kyc = await request(app).post(api('/kyc-records')).set(auth(a.token)).send({
      partyId: a.individual,
      documentType: 'PASSPORT',
      documentNumber: 'P9998887',
      status: 'VERIFIED',
    });
    expect(kyc.status, JSON.stringify(kyc.body)).toBe(201);
    const caseId = await openCase(a, '62000.00');
    const created = await report(a.token, [caseId], 'STR');
    await request(app)
      .post(api(`/goaml-reports/${created.body.data.id}/approve`))
      .set(auth(a.second));
    const xml = await request(app)
      .get(api(`/goaml-reports/${created.body.data.id}/xml`))
      .set(auth(a.token));
    expect(xml.text).toContain('<number>P9998887</number>');
  });

  it('is not visible to read-only roles, or to other companies', async () => {
    const auditor = await addUser(a.companyId, 'audit-alpha@example.com', 'Auditor');
    expect((await request(app).get(api('/goaml-reports')).set(auth(auditor))).status).toBe(403);
    const caseId = await openCase(a, '63000.00');
    expect((await report(b.token, [caseId])).status).toBe(404);
  });
});

describe('invoice PDF', () => {
  it('produces a PDF for a posted invoice and refuses a draft', async () => {
    const { id, posted } = await trade(a, 'sales-invoices', a.customer, '2.000');
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    const pdf = await request(app)
      .get(api(`/sales-invoices/${id}/pdf`))
      .set(auth(a.token))
      .buffer(true)
      .parse((res, done) => {
        const parts: Buffer[] = [];
        res.on('data', (part: Buffer) => parts.push(part));
        res.on('end', () => done(null, Buffer.concat(parts)));
      });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    expect((pdf.body as Buffer).toString('latin1').match(/\/Type \/Page\b/g)).toHaveLength(1);

    const draft = await request(app)
      .post(api('/sales-invoices'))
      .set(auth(a.token))
      .send({
        partyId: a.customer,
        branchId: a.branchId,
        docDate: today,
        currency: 'AED',
        lines: [{ productId: a.product, warehouseId: a.warehouseId, grossWeight: '1.000' }],
      });
    const refused = await request(app)
      .get(api(`/sales-invoices/${draft.body.data.id}/pdf`))
      .set(auth(a.token));
    expect(refused.status).toBe(409);
    const other = await request(app)
      .get(api(`/sales-invoices/${id}/pdf`))
      .set(auth(b.token));
    expect(other.status).toBe(404);
  });
});

describe('e-invoicing', () => {
  const row = (t: Tenant, id: string) =>
    EInvoiceModel.findOne({ companyId: oid(t.companyId), sourceId: id }).lean() as Promise<{
      status: string;
      attempts: number;
      providerReference?: string;
      xml: string;
    } | null>;

  it('renders valid amounts into the invoice XML, even with no provider', async () => {
    const { id } = await trade(a, 'sales-invoices', a.customer, '1.000');
    const res = await request(app)
      .get(api(`/e-invoices/sales/${id}/xml`))
      .set(auth(a.token));
    expect(res.status).toBe(200);
    expect(res.text).toContain('<cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>');
    expect(res.text).toContain('schemeID="0235">100000000000003</cbc:EndpointID>');
    expect(res.text).toContain('unitCode="GRM">1.000</cbc:InvoicedQuantity>');
    expect(await row(a, id)).toBeNull();
  });

  it('does nothing when no provider is configured', async () => {
    const { id } = await trade(a, 'sales-invoices', a.customer, '1.000');
    await issueEInvoice(oid(a.companyId), id, null);
    expect(await row(a, id)).toBeNull();
  });

  it('submits once, however many times the event is delivered', async () => {
    const { id } = await trade(a, 'sales-invoices', a.customer, '1.000');
    await issueEInvoice(oid(a.companyId), id, simulatedProvider);
    await issueEInvoice(oid(a.companyId), id, simulatedProvider);
    expect(await row(a, id)).toMatchObject({ status: 'ACCEPTED', attempts: 1 });
  });

  it('leaves retail sales out of scope', async () => {
    const { id } = await trade(a, 'sales-invoices', a.individual, '1.000');
    await issueEInvoice(oid(a.companyId), id, simulatedProvider);
    expect(await row(a, id)).toBeNull();
  });

  it('records an outage and lets the queue try again', async () => {
    const { id } = await trade(a, 'sales-invoices', a.customer, '1.000');
    const down: EInvoiceProvider = {
      name: 'down',
      submit: () => Promise.reject(new Error('gateway timeout')),
    };
    await expect(issueEInvoice(oid(a.companyId), id, down)).rejects.toThrow('gateway timeout');
    expect(await row(a, id)).toMatchObject({ status: 'FAILED' });
    await issueEInvoice(oid(a.companyId), id, simulatedProvider);
    expect(await row(a, id)).toMatchObject({ status: 'ACCEPTED', attempts: 2 });
  });

  it('treats a rejection as final until someone resubmits', async () => {
    const { id } = await trade(a, 'sales-invoices', a.customer, '1.000');
    const reject: EInvoiceProvider = {
      name: 'strict',
      submit: () => Promise.resolve({ status: 'REJECTED', message: 'Bad TRN' }),
    };
    await issueEInvoice(oid(a.companyId), id, reject);
    await issueEInvoice(oid(a.companyId), id, simulatedProvider);
    expect(await row(a, id)).toMatchObject({ status: 'REJECTED', attempts: 1 });
    await issueEInvoice(oid(a.companyId), id, simulatedProvider, { retry: true });
    expect(await row(a, id)).toMatchObject({ status: 'ACCEPTED' });
  });
});

describe('bank reconciliation', () => {
  let t: Tenant;
  const statement = (rows: string[]) =>
    request(app)
      .post(api('/bank-statements/import'))
      .set(auth(t.token))
      .send({
        financialAccountId: t.bank,
        csv: ['Date,Description,Reference,Amount', ...rows].join('\n'),
        dateOrder: 'YMD',
      });
  const lines = async (status?: string) =>
    (
      await request(app)
        .get(api('/bank-statement-lines'))
        .query({ financialAccountId: t.bank, ...(status ? { status } : {}) })
        .set(auth(t.token))
    ).body.data as { id: string; amount: string; status: string }[];
  const autoMatch = () =>
    request(app)
      .post(api('/bank-reconciliations/auto-match'))
      .set(auth(t.token))
      .send({ financialAccountId: t.bank });
  const match = (lineId: string, paymentIds: string[], token = t.token) =>
    request(app)
      .post(api(`/bank-statement-lines/${lineId}/match`))
      .set(auth(token))
      .send({ paymentIds });
  const begin = (closingBalance: string, openingBalance?: string) =>
    request(app)
      .post(api('/bank-reconciliations'))
      .set(auth(t.token))
      .send({
        financialAccountId: t.bank,
        statementDate: today,
        closingBalance,
        ...(openingBalance ? { openingBalance } : {}),
      });
  const complete = (id: string) =>
    request(app)
      .post(api(`/bank-reconciliations/${id}/complete`))
      .set(auth(t.token));
  const expense = async () => {
    const res = await request(app).get(api('/ledger-accounts')).set(auth(t.token));
    return (res.body.data as { id: string; code: string }[]).find((x) => x.code === '5100')!.id;
  };

  beforeAll(async () => {
    t = await setupTenant('GAMMA');
  });

  it('imports a statement once, even if it is uploaded twice', async () => {
    const rows = [`${today},Deposit A,REF-A,500.00`, `${today},Deposit A,REF-A,500.00`];
    const first = await statement(rows);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.data).toEqual({ lines: 2, imported: 2, duplicates: 0 });
    const again = await statement(rows);
    expect(again.body.data).toEqual({ lines: 2, imported: 0, duplicates: 2 });
    expect(await lines()).toHaveLength(2);
  });

  it('uses the reference to choose between payments of the same amount', async () => {
    await statement([`${today},Transfer REF-Z,,321.00`]);
    await pay(t, 'RECEIPT', t.customer, '321.00', 'REF-Y');
    const wanted = await pay(t, 'RECEIPT', t.customer, '321.00', 'REF-Z');
    expect((await autoMatch()).body.data.matched).toBe(1);
    const open = await request(app)
      .get(api('/bank-unmatched-payments'))
      .query({ financialAccountId: t.bank })
      .set(auth(t.token));
    const ids = (open.body.data as { id: string }[]).map((p) => p.id);
    expect(ids).not.toContain(wanted.body.data.id);
  });

  it('leaves a line for a person when two payments fit equally well', async () => {
    await statement([`${today},No clue,,444.00`]);
    await pay(t, 'RECEIPT', t.customer, '444.00');
    await pay(t, 'RECEIPT', t.customer, '444.00');
    await autoMatch();
    expect((await lines('UNMATCHED')).some((l) => Number(l.amount) === 444)).toBe(true);
  });

  it('requires matched payments to add up exactly', async () => {
    await statement([`${today},Odd amount,,777.00`]);
    const paid = await pay(t, 'RECEIPT', t.customer, '700.00');
    const line = (await lines('UNMATCHED')).find((l) => l.amount.startsWith('777'))!;
    expect((await match(line.id, [paid.body.data.id as string])).status).toBe(422);
    expect((await lines('UNMATCHED')).some((l) => l.id === line.id)).toBe(true);
  });

  it('clears a payment against only one line under concurrency', async () => {
    await statement([`${today},Race one,R1,50.00`, `${today},Race two,R2,50.00`]);
    const paid = await pay(t, 'RECEIPT', t.customer, '50.00');
    const id = paid.body.data.id as string;
    const race = (await lines('UNMATCHED')).filter((l) => Number(l.amount) === 50);
    const results = await Promise.all(race.map((l) => match(l.id, [id])));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  });

  it('refuses to reverse a payment that has cleared the bank', async () => {
    await statement([`${today},Cleared,C1,60.00`]);
    const paid = await pay(t, 'RECEIPT', t.customer, '60.00');
    const line = (await lines('UNMATCHED')).find((l) => Number(l.amount) === 60)!;
    await match(line.id, [paid.body.data.id as string]);
    const reversal = await request(app)
      .post(api(`/payments/${paid.body.data.id}/reverse`))
      .set(auth(t.token))
      .set(idem())
      .send({ reason: 'Bounced' });
    expect(reversal.status).toBe(409);
  });

  it('balances only when every item is explained, then locks the period', async () => {
    t = await setupTenant('DELTA');
    await statement([
      `${today},Customer receipt,RCV-1,1000.00`,
      `${today},Supplier payment,PAY-1,-400.00`,
      `${today},Monthly fee,FEE,-25.00`,
    ]);
    await pay(t, 'RECEIPT', t.customer, '1000.00', 'RCV-1');
    await pay(t, 'PAYMENT', t.supplier, '400.00', 'PAY-1');
    const uncleared = await pay(t, 'PAYMENT', t.supplier, '90.00', 'NOT-YET');
    expect(uncleared.status).toBe(201);
    await autoMatch();

    const recon = await begin('10575.00', '10000.00');
    expect(recon.status, JSON.stringify(recon.body)).toBe(201);
    expect((await begin('10575.00', '10000.00')).status).toBe(409);
    const id = recon.body.data.id as string;

    const blocked = await complete(id);
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.message).toContain('1 statement line');

    const fee = (await lines('UNMATCHED'))[0]!;
    const adjusted = await request(app)
      .post(api(`/bank-statement-lines/${fee.id}/adjust`))
      .set(auth(t.token))
      .send({ ledgerAccountId: await expense(), branchId: t.branchId, memo: 'Bank fee' });
    expect(adjusted.status, JSON.stringify(adjusted.body)).toBe(200);

    const list = await request(app)
      .get(api('/bank-reconciliations'))
      .query({ financialAccountId: t.bank })
      .set(auth(t.token));
    expect(list.body.data[0].summary).toMatchObject({
      closingBalance: '10575.00',
      depositsInTransit: '0.00',
      outstandingPayments: '90.00',
      adjustedBankBalance: '10485.00',
      cashBookBalance: '10485.00',
      difference: '0.00',
      unmatchedLines: 0,
    });

    const done = await complete(id);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.data.status).toBe('COMPLETED');

    const matched = (await lines('MATCHED'))[0]!;
    const unmatch = await request(app)
      .post(api(`/bank-statement-lines/${matched.id}/unmatch`))
      .set(auth(t.token));
    expect(unmatch.status).toBe(409);
  });

  it('will not complete with a difference', async () => {
    t = await setupTenant('EPSILON');
    await statement([`${today},Receipt,X,100.00`]);
    await pay(t, 'RECEIPT', t.customer, '100.00', 'X');
    await autoMatch();
    const recon = await begin('999.00', '0');
    const res = await complete(recon.body.data.id as string);
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('out by');
  });

  it('keeps statements within one company', async () => {
    const res = await request(app)
      .post(api('/bank-statements/import'))
      .set(auth(b.token))
      .send({ financialAccountId: t.bank, csv: `Date,Amount\n${today},1`, dateOrder: 'YMD' });
    expect(res.status).toBe(404);
  });
});
