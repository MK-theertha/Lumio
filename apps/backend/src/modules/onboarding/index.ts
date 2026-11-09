import { SYSTEM_ROLES } from '@lumio/shared-types';
import type { provisionCompanySchema } from '@lumio/validation';
import { Types } from 'mongoose';
import type { z } from 'zod';
import type { RequestContext } from '../../shared/context.js';
import { runInTransaction } from '../../database/transaction.js';
import { RoleModel, RoleAssignmentModel } from '../access/index.js';
import { hashPassword, inviteUser, normaliseEmail, UserModel } from '../identity/index.js';
import { createYearPeriods, LedgerAccountModel } from '../ledger/index.js';
import { BranchModel, CompanyModel, WarehouseModel } from '../organisation/index.js';
import { FinancialAccountModel, PaymentMethodModel } from '../finance/index.js';

/** A starting template. Each company's accountant can edit it; see posting rules in the docs. */
const CHART: [string, string, string, string | null, boolean?][] = [
  ['1000', 'Cash on hand', 'ASSET', null, true],
  ['1010', 'Bank', 'ASSET', null, true],
  ['1100', 'Accounts receivable', 'ASSET', 'AR'],
  ['1200', 'Gold inventory', 'ASSET', 'INVENTORY'],
  ['1300', 'Input VAT recoverable', 'ASSET', 'INPUT_VAT'],
  ['1900', 'Inter-branch clearing', 'ASSET', 'INTER_BRANCH'],
  ['2000', 'Accounts payable', 'LIABILITY', 'AP'],
  ['2100', 'Output VAT payable', 'LIABILITY', 'OUTPUT_VAT'],
  ['3000', 'Opening balance equity', 'EQUITY', 'OPENING_EQUITY'],
  ['3100', 'Retained earnings', 'EQUITY', 'RETAINED_EARNINGS'],
  ['4000', 'Gold sales', 'INCOME', 'SALES_GOLD'],
  ['4100', 'Making charge income', 'INCOME', 'SALES_MAKING'],
  ['4900', 'Sales discounts', 'INCOME', 'SALES_DISCOUNT'],
  ['5000', 'Cost of goods sold', 'EXPENSE', 'COGS'],
  ['5100', 'Stock gains and losses', 'EXPENSE', 'STOCK_GAIN_LOSS'],
];

const METHODS: [string, string, string][] = [
  ['CASH', 'Cash', 'CASH'],
  ['BANK', 'Bank transfer', 'BANK'],
  ['CARD', 'Card', 'CARD'],
];

export async function provisionCompany(
  platform: Pick<RequestContext, 'userId' | 'correlationId'>,
  input: z.infer<typeof provisionCompanySchema>,
  options: { isDemo?: boolean; adminPassword?: string } = {},
) {
  const companyId = new Types.ObjectId();
  const base: RequestContext = {
    companyId,
    userId: platform.userId,
    branchScope: 'ALL',
    permissions: new Set(),
    correlationId: platform.correlationId,
  };

  const adminRoleId = await runInTransaction(base, async (tx) => {
    const session = tx.session;
    await CompanyModel.create(
      [
        {
          _id: companyId,
          code: input.code,
          legalName: input.legalName,
          baseCurrency: input.baseCurrency.toUpperCase(),
          isDemo: options.isDemo ?? false,
          settings: options.isDemo ? { requireVerifiedTaxCodes: false } : {},
        },
      ],
      { session },
    );
    const roles = await RoleModel.insertMany(
      Object.entries(SYSTEM_ROLES).map(([name, permissions]) => ({
        companyId,
        name,
        permissions,
        isSystem: true,
      })),
      { session },
    );
    const accounts = await LedgerAccountModel.insertMany(
      CHART.map(([code, name, type, systemRole, isCash]) => ({
        companyId,
        code,
        name,
        type,
        ...(systemRole ? { systemRole } : {}),
        isCash: isCash ?? false,
      })),
      { session },
    );
    const [branch] = await BranchModel.create([{ companyId, code: 'HQ', name: input.branchName }], {
      session,
    });
    await WarehouseModel.create(
      [{ companyId, code: 'MAIN', name: 'Main vault', branchId: branch?._id }],
      { session },
    );
    const account = (code: string) => accounts.find((a) => a.code === code)?._id;
    await FinancialAccountModel.insertMany(
      [
        {
          companyId,
          code: 'CASH',
          name: 'Cash on hand',
          kind: 'CASH',
          ledgerAccountId: account('1000'),
        },
        {
          companyId,
          code: 'BANK',
          name: 'Main bank',
          kind: 'BANK',
          ledgerAccountId: account('1010'),
        },
      ],
      { session },
    );
    await PaymentMethodModel.insertMany(
      METHODS.map(([code, name, amlClass]) => ({ companyId, code, name, amlClass })),
      { session },
    );
    await createYearPeriods(tx, new Date().getUTCFullYear());
    return roles.find((r) => r.name === 'Company Administrator')?._id as Types.ObjectId;
  });

  const invited = await inviteUser(base, {
    email: input.adminEmail,
    name: input.adminName,
    assignments: [{ roleId: adminRoleId.toString(), branchIds: [] }],
  });
  if (options.adminPassword) {
    await UserModel.updateOne(
      { email: normaliseEmail(input.adminEmail) },
      { $set: { passwordHash: await hashPassword(options.adminPassword), status: 'ACTIVE' } },
    );
  }
  return { companyId: companyId.toString(), adminUserId: invited.id };
}

export { RoleAssignmentModel };
