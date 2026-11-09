import type { Types } from 'mongoose';
import { ComplianceRuleModel } from '../compliance/index.js';
import { PaymentMethodModel } from '../finance/index.js';
import { PurityModel } from '../master/index.js';
import { CompanyModel } from '../organisation/index.js';
import { TaxCodeModel, TaxRuleModel } from '../tax/index.js';

/**
 * Common Dubai trade conventions, from public sources gathered on 2026-11-09. These are starting
 * values, not advice: tax codes stay unverified, so with verified-only tax on (the default) they
 * cannot be used until an adviser confirms them, and pricing stays marked as not signed off.
 */
const PURITIES = [
  ['24K', '24 karat', '24', '0.9999'],
  ['22K', '22 karat', '22', '0.9167'],
  ['21K', '21 karat', '21', '0.8750'],
  ['18K', '18 karat', '18', '0.7500'],
] as const;

const TAX_CODES = [
  [
    'VAT5',
    'Standard rate 5%',
    '5',
    'STANDARD',
    'Jewellery and gold below 99% to unregistered buyers',
  ],
  [
    'RCM5',
    'Reverse charge 5%',
    '5',
    'REVERSE_CHARGE',
    'Gold and diamonds between registered businesses',
  ],
  ['ZERO-IPM', 'Investment precious metals', '0', 'ZERO', 'Investment grade metal of 99% or more'],
] as const;

const METHODS = [
  ['EXCH', 'Exchange house', 'EXCHANGE_HOUSE'],
  ['WIRE', 'International wire', 'WIRE'],
] as const;

export const LINKED_WINDOW_DAYS = 30;
const DPMSR_THRESHOLD = '55000';
const AML_REFERENCE =
  'DPMSR, reported as Cabinet Resolution 134 of 2025 Art 3(3). Confirm with your compliance officer.';

/** Safe to run repeatedly: anything that already exists is left exactly as it is. */
export async function applyDubaiPreset(companyId: Types.ObjectId): Promise<{ created: number }> {
  let created = 0;
  const add = async (result: { upsertedCount: number }) => {
    created += result.upsertedCount;
  };
  const purityIds = new Map<string, Types.ObjectId>();
  for (const [code, label, karat, fineness] of PURITIES) {
    await add(
      await PurityModel.updateOne(
        { companyId, code },
        { $setOnInsert: { label, karat, fineness } },
        { upsert: true },
      ),
    );
    const row = await PurityModel.findOne({ companyId, code }).lean();
    if (row) purityIds.set(code, row._id);
  }
  const codeIds = new Map<string, Types.ObjectId>();
  for (const [code, name, ratePercent, treatment, legalReference] of TAX_CODES) {
    await add(
      await TaxCodeModel.updateOne(
        { companyId, code },
        { $setOnInsert: { name, ratePercent, treatment, legalReference, verified: false } },
        { upsert: true },
      ),
    );
    const row = await TaxCodeModel.findOne({ companyId, code }).lean();
    if (row) codeIds.set(code, row._id);
  }
  const rules = [
    {
      name: 'Dubai: investment gold 99% or more',
      priority: 10,
      taxCodeId: codeIds.get('ZERO-IPM'),
      productKinds: ['BAR', 'BULLION', 'COIN'],
      minFineness: '0.99',
    },
    {
      name: 'Dubai: registered buyer, reverse charge',
      priority: 20,
      taxCodeId: codeIds.get('RCM5'),
      partyVatRegistered: true,
    },
    { name: 'Dubai: everything else at 5%', priority: 30, taxCodeId: codeIds.get('VAT5') },
  ];
  for (const { name, ...rule } of rules) {
    await add(
      await TaxRuleModel.updateOne(
        { companyId, name },
        { $setOnInsert: { ...rule, direction: 'ANY' } },
        { upsert: true },
      ),
    );
  }
  for (const [code, name, amlClass] of METHODS) {
    await add(
      await PaymentMethodModel.updateOne(
        { companyId, code },
        { $setOnInsert: { name, amlClass } },
        { upsert: true },
      ),
    );
  }
  const amlRules = [
    {
      name: 'DPMSR: individual, linked cash',
      amlClasses: ['CASH'],
      partyTypes: ['INDIVIDUAL'],
    },
    {
      name: 'DPMSR: business, cash, exchange house and wires',
      amlClasses: ['CASH', 'EXCHANGE_HOUSE', 'WIRE'],
      partyTypes: ['BUSINESS'],
    },
  ];
  for (const { name, ...rule } of amlRules) {
    await add(
      await ComplianceRuleModel.updateOne(
        { companyId, name },
        {
          $setOnInsert: {
            ...rule,
            trigger: 'PAYMENT_POSTED',
            thresholdAmount: DPMSR_THRESHOLD,
            severity: 'MEDIUM',
            active: true,
            aggregateDays: LINKED_WINDOW_DAYS,
            legalReference: AML_REFERENCE,
          },
        },
        { upsert: true },
      ),
    );
  }
  await CompanyModel.updateOne(
    { _id: companyId, 'settings.tolaGrams': null },
    { $set: { 'settings.tolaGrams': '11.6638' } },
  );
  return { created };
}
