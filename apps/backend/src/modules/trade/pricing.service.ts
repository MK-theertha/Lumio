import {
  priceDocument,
  priceLine,
  type DiscountRule,
  type GoldRate,
  type LineInput,
  type MakingRule,
  type PricingPolicy,
  type WastageRule,
} from '@lumio/calc-engine';
import type { tradeDocumentSchema } from '@lumio/validation';
import type { z } from 'zod';
import { Types } from 'mongoose';
import type { RequestContext } from '../../shared/context.js';
import { d128, dec } from '../../shared/decimal.js';
import { BusinessRuleError, NotFoundError } from '../../shared/errors.js';
import { loadStockItem, productWithPurity, stockPolicy } from '../inventory/index.js';
import { PartyModel, PartyPricingModel } from '../master/index.js';
import { resolveRate } from '../pricing/index.js';
import { determineTax } from '../tax/index.js';

export type Direction = 'SALE' | 'PURCHASE';
export type TradeInput = z.infer<typeof tradeDocumentSchema>;
type TradeLineInput = TradeInput['lines'][number];

function makingRule(rule?: { mode: string; value?: string | undefined } | null): MakingRule {
  if (!rule?.mode || rule.mode === 'NONE') return { mode: 'NONE' };
  const value = rule.value ?? '0';
  switch (rule.mode) {
    case 'PER_GRAM_NET':
    case 'PER_GRAM_GROSS':
    case 'PER_PIECE':
      return { mode: rule.mode, rate: value };
    case 'PERCENT_OF_GOLD_VALUE':
      return { mode: rule.mode, percent: value };
    case 'FIXED':
      return { mode: rule.mode, amount: value };
    default:
      throw new BusinessRuleError(`Unknown making charge mode: ${rule.mode}`);
  }
}

function wastageRule(rule?: { mode: string; value?: string | undefined } | null): WastageRule {
  if (!rule?.mode || rule.mode === 'NONE') return { mode: 'NONE' };
  const value = rule.value ?? '0';
  switch (rule.mode) {
    case 'PERCENT_OF_WEIGHT':
    case 'PERCENT_OF_GOLD_VALUE':
      return { mode: rule.mode, percent: value };
    case 'FIXED_GRAMS':
      return { mode: rule.mode, grams: value };
    default:
      throw new BusinessRuleError(`Unknown wastage mode: ${rule.mode}`);
  }
}

function discountRule(line: TradeLineInput): DiscountRule {
  if (!line.discount) return { kind: 'NONE' };
  const { kind, target, value } = line.discount;
  return kind === 'PERCENT' ? { kind, target, percent: value } : { kind, target, amount: value };
}

export function policyOf(company: Awaited<ReturnType<typeof stockPolicy>>): PricingPolicy {
  const p = company.settings?.pricing;
  return {
    version: p?.version ?? '1',
    taxRounding: (p?.taxRounding ?? 'LINE') as PricingPolicy['taxRounding'],
    rounding: {
      weightScale: p?.weightScale ?? 3,
      fineWeightScale: p?.fineWeightScale ?? 4,
      finenessScale: p?.finenessScale ?? 4,
      rateScale: p?.rateScale ?? 4,
      moneyScale: p?.moneyScale ?? 2,
      mode: (p?.mode ?? 'HALF_UP') as PricingPolicy['rounding']['mode'],
    },
  };
}

/** Prices a document from current master data. The server's figures are the only ones stored. */
export async function priceTrade(ctx: RequestContext, direction: Direction, input: TradeInput) {
  const company = await stockPolicy(ctx);
  const policy = policyOf(company);
  const party = await PartyModel.findOne({ companyId: ctx.companyId, _id: input.partyId })
    .session(ctx.session ?? null)
    .lean();
  if (!party) throw new NotFoundError('The party was not found.');
  const role = direction === 'SALE' ? 'CUSTOMER' : 'SUPPLIER';
  if (!party.roles.includes(role)) {
    throw new BusinessRuleError(`This party is not set up as a ${role.toLowerCase()}.`);
  }
  const partyRule = await PartyPricingModel.findOne({
    companyId: ctx.companyId,
    partyId: party._id,
    archivedAt: null,
  })
    .session(ctx.session ?? null)
    .lean();

  const requireVerified = company.settings?.requireVerifiedTaxCodes ?? true;
  const lines = [];

  for (const [index, line] of input.lines.entries()) {
    const { product, purity } = await productWithPurity(ctx, line.productId);
    const fineness = dec(purity.fineness).toFixed();

    // A tagged piece carries its own weights, so what is priced is what actually leaves stock.
    let weights = { gross: line.grossWeight, stone: line.stoneWeight, pieces: line.pieces };
    let tag: string | undefined;
    if (product.tracking === 'PIECE' && direction === 'SALE') {
      if (!line.stockItemId)
        throw new BusinessRuleError(`${product.name} requires a tagged piece.`);
      const item = await loadStockItem(ctx, line.stockItemId);
      weights = { gross: dec(item.gross).toFixed(), stone: dec(item.stone).toFixed(), pieces: 1 };
      tag = item.tag;
    }

    let rate: GoldRate;
    let rateSnapshot: Record<string, unknown>;
    if (line.rateOverride) {
      rate =
        line.rateOverride.basis === 'FINE_GRAM'
          ? { basis: 'FINE_GRAM', value: line.rateOverride.value }
          : { basis: 'PURITY_GRAM', value: line.rateOverride.value, fineness };
      rateSnapshot = {
        ...rate,
        source: 'MANUAL_OVERRIDE',
        currency: input.currency,
        at: new Date(),
      };
    } else {
      const resolved = await resolveRate(ctx, {
        purityId: purity._id,
        fineness,
        branchId: input.branchId,
        currency: input.currency,
        at: new Date(),
      });
      rate = resolved.rate;
      rateSnapshot = {
        ...rate,
        rateId: resolved.rateId,
        source: resolved.source,
        currency: resolved.currency,
        at: resolved.effectiveAt,
      };
    }
    rate = { ...rate, value: dec(rate.value).toDecimalPlaces(policy.rounding.rateScale).toFixed() };

    const tax = await determineTax(
      ctx,
      {
        direction,
        productKind: product.kind,
        fineness,
        partyVatRegistered: party.vatRegistered ?? false,
      },
      requireVerified,
    );
    // Reverse-charged supplies carry no VAT on the document; the recipient self-accounts.
    const isReverseCharge = tax.treatment === 'REVERSE_CHARGE';
    const chargedRate = isReverseCharge ? '0' : tax.ratePercent;

    const partyMaking =
      direction === 'SALE' && partyRule?.makingMode
        ? { mode: partyRule.makingMode, value: partyRule.makingValue ?? '0' }
        : undefined;
    const partyDiscount: DiscountRule | undefined =
      !line.discount && direction === 'SALE' && partyRule?.discountPercent
        ? { kind: 'PERCENT', target: 'MAKING', percent: partyRule.discountPercent }
        : undefined;

    const engineInput: LineInput = {
      grossWeight: weights.gross,
      stoneWeight: weights.stone,
      fineness,
      pieces: weights.pieces,
      rate,
      wastage: wastageRule(line.wastage ?? product.defaultWastage),
      making: makingRule(line.making ?? partyMaking ?? product.defaultMaking),
      stoneValue: line.stoneValue,
      otherCharges: line.otherCharges,
      discount: partyDiscount ?? discountRule(line),
      tax: { mode: line.taxInclusive ? 'INCLUSIVE' : 'EXCLUSIVE', ratePercent: chargedRate },
    };
    const result = priceLine(engineInput, policy);
    const notional = isReverseCharge
      ? dec(result.taxableValue)
          .times(tax.ratePercent)
          .dividedBy(100)
          .toDecimalPlaces(policy.rounding.moneyScale)
      : dec('0');

    lines.push({
      lineId: String(index + 1),
      productId: product._id,
      productName: product.name,
      sku: product.sku,
      kind: product.kind,
      tracking: product.tracking,
      purityId: purity._id,
      purityLabel: purity.label,
      fineness: purity.fineness,
      warehouseId: new Types.ObjectId(line.warehouseId),
      location: line.location,
      ...(line.stockItemId ? { stockItemId: new Types.ObjectId(line.stockItemId) } : {}),
      ...(line.lotId ? { lotId: new Types.ObjectId(line.lotId) } : {}),
      ...(tag ? { tag } : {}),
      pieces: weights.pieces,
      grossWeight: d128(weights.gross),
      stoneWeight: d128(weights.stone),
      netWeight: d128(result.netWeight),
      fineWeight: d128(result.fineWeight),
      goldValue: d128(result.goldValue),
      wastageValue: d128(result.wastageValue),
      makingCharge: d128(result.makingCharge),
      discount: d128(result.discount),
      taxableValue: d128(result.taxableValue),
      taxAmount: d128(result.taxAmount),
      notionalTax: d128(notional),
      lineTotal: d128(result.lineTotal),
      taxCode: tax.code,
      taxTreatment: tax.treatment,
      taxRatePercent: d128(tax.ratePercent),
      input: line,
      snapshot: { rate: rateSnapshot, policy, tax, engine: result },
      result,
    });
  }

  const totals = priceDocument(
    lines.map((l) => l.result),
    { adjustment: '0' },
    policy,
  );
  return {
    company,
    party,
    policy,
    totals,
    lines: lines.map(({ result: _result, ...line }) => line),
  };
}
