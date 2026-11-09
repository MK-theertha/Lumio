import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { expect } from 'vitest';
import { RoleAssignmentModel, RoleModel } from '../src/modules/access/index.js';
import { hashPassword, UserModel } from '../src/modules/identity/index.js';
import { provisionCompany } from '../src/modules/onboarding/index.js';

export const PASSWORD = 'correct-horse-battery';
export const today = new Date().toISOString().slice(0, 10);
export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
export const idem = () => ({ 'Idempotency-Key': randomUUID() });
export const oid = (id: string) => new mongoose.Types.ObjectId(id);
export const api = (path: string) => `/api/v1${path}`;

export interface Tenant {
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
  cash: string;
  method: string;
}

// Names, rates and tax codes are test fixtures, not approved business rules.
export function tenantKit(getApp: () => Express) {
  async function login(email: string): Promise<string> {
    const res = await request(getApp())
      .post(api('/auth/login'))
      .send({ email, password: PASSWORD });
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
    const app = getApp();
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
    const cash = await first('/financial-accounts?q=CASH');
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
      cash,
      method,
    };
  }

  const tradeBody = (t: Tenant, partyId: string, gross: string, overrides: object = {}) => ({
    partyId,
    branchId: t.branchId,
    docDate: today,
    currency: 'AED',
    lines: [{ productId: t.product, warehouseId: t.warehouseId, grossWeight: gross, ...overrides }],
  });

  async function trade(t: Tenant, path: string, partyId: string, gross: string, line: object = {}) {
    const created = await request(getApp())
      .post(api(`/${path}`))
      .set(auth(t.token))
      .send(tradeBody(t, partyId, gross, line));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.data.id as string;
    const posted = await request(getApp())
      .post(api(`/${path}/${id}/post`))
      .set(auth(t.token))
      .set(idem());
    return { id, posted };
  }

  const pay = (
    t: Tenant,
    direction: string,
    partyId: string,
    amount: string,
    reference?: string,
    extra: object = {},
  ) =>
    request(getApp())
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
        ...extra,
      });

  return { login, addUser, setupTenant, trade, tradeBody, pay };
}
