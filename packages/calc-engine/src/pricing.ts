import { CalculationError } from './errors.js';
import { assertNonNegative, assertScale, D, dec, percentOf, round, type Dec } from './decimal.js';
import type {
  DiscountRule,
  LineInput,
  LineResult,
  MakingRule,
  PricingPolicy,
  RoundingProfile,
  TraceStep,
  WastageRule,
} from './types.js';
import { assertFinenessRange } from './units.js';

export const ENGINE_VERSION = '1.0.0';

export function assertPolicy(policy: PricingPolicy): void {
  const profile = policy?.rounding;
  const scales = [
    profile?.weightScale,
    profile?.fineWeightScale,
    profile?.finenessScale,
    profile?.rateScale,
    profile?.moneyScale,
  ];
  const validScales = scales.every((s) => typeof s === 'number' && new D(s).isInteger() && s >= 0);
  if (!policy?.version || !validScales || !profile.mode || !policy.taxRounding) {
    throw new CalculationError('INVALID_POLICY', 'Pricing policy is incomplete');
  }
}

function percent(value: string, field: string): Dec {
  const parsed = dec(value, field);
  if (parsed.isNegative() || parsed.greaterThan(100)) {
    throw new CalculationError('INVALID_PERCENT', `${field} must be between 0 and 100`);
  }
  return parsed;
}

function nonNegative(value: string, field: string): Dec {
  const parsed = dec(value, field);
  assertNonNegative(parsed, field);
  return parsed;
}

function wastageWeight(rule: WastageRule, net: Dec, profile: RoundingProfile): Dec {
  switch (rule.mode) {
    case 'PERCENT_OF_WEIGHT':
      return round(
        percentOf(net, percent(rule.percent, 'wastage.percent')),
        profile.weightScale,
        profile.mode,
      );
    case 'FIXED_GRAMS':
      return nonNegative(rule.grams, 'wastage.grams');
    case 'NONE':
    case 'PERCENT_OF_GOLD_VALUE':
      return new D(0);
    default:
      throw new CalculationError('INVALID_POLICY', 'Unknown wastage rule');
  }
}

function goldValueOf(
  input: LineInput,
  chargeable: Dec,
  chargeableFine: Dec,
  fineness: Dec,
  scale: number,
): Dec {
  const rate = dec(input.rate.value, 'rate.value');
  if (rate.lessThanOrEqualTo(0))
    throw new CalculationError('INVALID_RATE', 'rate must be positive');
  assertScale(rate, scale, 'rate.value');

  switch (input.rate.basis) {
    case 'FINE_GRAM':
      return chargeableFine.times(rate);
    case 'PURITY_GRAM':
      if (!dec(input.rate.fineness, 'rate.fineness').equals(fineness)) {
        throw new CalculationError(
          'RATE_PURITY_MISMATCH',
          "A purity-based rate must have the same fineness as the line's metal",
        );
      }
      return chargeable.times(rate);
    default:
      throw new CalculationError('INVALID_RATE', 'Unknown rate basis');
  }
}

function makingOf(rule: MakingRule, ctx: { gross: Dec; net: Dec; gold: Dec; pieces: number }): Dec {
  switch (rule.mode) {
    case 'NONE':
      return new D(0);
    case 'PER_GRAM_NET':
      return ctx.net.times(nonNegative(rule.rate, 'making.rate'));
    case 'PER_GRAM_GROSS':
      return ctx.gross.times(nonNegative(rule.rate, 'making.rate'));
    case 'PER_PIECE':
      return new D(ctx.pieces).times(nonNegative(rule.rate, 'making.rate'));
    case 'PERCENT_OF_GOLD_VALUE':
      return percentOf(ctx.gold, percent(rule.percent, 'making.percent'));
    case 'FIXED':
      return nonNegative(rule.amount, 'making.amount');
    default:
      throw new CalculationError('INVALID_POLICY', 'Unknown making rule');
  }
}

function discountOf(
  rule: DiscountRule,
  targets: Record<string, Dec>,
  profile: RoundingProfile,
): Dec {
  if (rule.kind === 'NONE') return new D(0);
  const base = targets[rule.target];
  if (!base) throw new CalculationError('INVALID_POLICY', 'Unknown discount target');
  const amount =
    rule.kind === 'PERCENT'
      ? round(
          percentOf(base, percent(rule.percent, 'discount.percent')),
          profile.moneyScale,
          profile.mode,
        )
      : nonNegative(rule.amount, 'discount.amount');
  assertScale(amount, profile.moneyScale, 'discount');
  if (amount.greaterThan(base)) {
    throw new CalculationError(
      'DISCOUNT_EXCEEDS_TARGET',
      'Discount exceeds the amount it applies to',
    );
  }
  return amount;
}

/** Prices one line. Pure and deterministic: identical input always yields identical output. */
export function priceLine(input: LineInput, policy: PricingPolicy): LineResult {
  assertPolicy(policy);
  const p = policy.rounding;
  const trace: TraceStep[] = [];
  const money = (v: Dec) => round(v, p.moneyScale, p.mode);
  const record = (step: string, formula: string, inputs: Record<string, Dec>, output: Dec) => {
    const asText = Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v.toString()]));
    trace.push({ step, formula, inputs: asText, output: output.toString() });
    return output;
  };

  const gross = nonNegative(input.grossWeight, 'grossWeight');
  const stone = nonNegative(input.stoneWeight, 'stoneWeight');
  assertScale(gross, p.weightScale, 'grossWeight');
  assertScale(stone, p.weightScale, 'stoneWeight');
  if (gross.isZero()) throw new CalculationError('INVALID_WEIGHT', 'grossWeight must be positive');
  if (stone.greaterThan(gross)) {
    throw new CalculationError('STONE_EXCEEDS_GROSS', 'stoneWeight exceeds grossWeight');
  }
  if (!new D(input.pieces).isInteger() || input.pieces < 1) {
    throw new CalculationError('INVALID_PIECES', 'pieces must be a positive whole number');
  }
  const fineness = dec(input.fineness, 'fineness');
  assertFinenessRange(fineness, 'fineness');
  assertScale(fineness, p.finenessScale, 'fineness');

  const net = record('netWeight', 'gross - stone', { gross, stone }, gross.minus(stone));
  const extra = wastageWeight(input.wastage, net, p);
  const chargeable = record(
    'chargeableWeight',
    'net + wastageWeight',
    { net, extra },
    net.plus(extra),
  );
  const fine = record(
    'fineWeight',
    'net x fineness',
    { net, fineness },
    round(net.times(fineness), p.fineWeightScale, p.mode),
  );
  const chargeableFine = record(
    'chargeableFineWeight',
    'chargeable x fineness',
    { chargeable, fineness },
    round(chargeable.times(fineness), p.fineWeightScale, p.mode),
  );

  const gold = record(
    'goldValue',
    input.rate.basis === 'FINE_GRAM' ? 'chargeableFine x rate' : 'chargeable x rate',
    { chargeable, chargeableFine, rate: dec(input.rate.value, 'rate.value') },
    money(goldValueOf(input, chargeable, chargeableFine, fineness, p.rateScale)),
  );

  const wastageValue =
    input.wastage.mode === 'PERCENT_OF_GOLD_VALUE'
      ? record(
          'wastageValue',
          'gold x percent / 100',
          { gold },
          money(percentOf(gold, percent(input.wastage.percent, 'wastage.percent'))),
        )
      : new D(0);

  const making = record(
    'makingCharge',
    input.making.mode,
    { gross, net, gold },
    money(makingOf(input.making, { gross, net, gold, pieces: input.pieces })),
  );
  const stoneValue = nonNegative(input.stoneValue, 'stoneValue');
  const otherCharges = nonNegative(input.otherCharges, 'otherCharges');
  assertScale(stoneValue, p.moneyScale, 'stoneValue');
  assertScale(otherCharges, p.moneyScale, 'otherCharges');

  const grossLine = record(
    'grossLineValue',
    'gold + wastage + making + stones + other',
    { gold, wastageValue, making, stoneValue, otherCharges },
    gold.plus(wastageValue).plus(making).plus(stoneValue).plus(otherCharges),
  );
  const discount = record(
    'discount',
    input.discount.kind,
    { grossLine },
    discountOf(input.discount, { GOLD_VALUE: gold, MAKING: making, LINE: grossLine }, p),
  );
  const afterDiscount = grossLine.minus(discount);

  const rate = percent(input.tax.ratePercent, 'tax.ratePercent');
  const exclusive = input.tax.mode === 'EXCLUSIVE';
  const unroundedTax = exclusive
    ? percentOf(afterDiscount, rate)
    : afterDiscount.times(rate).dividedBy(rate.plus(100));
  const tax = record('tax', `${input.tax.mode}`, { afterDiscount, rate }, money(unroundedTax));
  const taxable = exclusive ? afterDiscount : afterDiscount.minus(tax);
  const total = record('lineTotal', 'taxable + tax', { taxable, tax }, taxable.plus(tax));

  const fixedMoney = (v: Dec) => v.toFixed(p.moneyScale);
  return {
    netWeight: net.toFixed(p.weightScale),
    chargeableWeight: chargeable.toFixed(p.weightScale),
    fineWeight: fine.toFixed(p.fineWeightScale),
    chargeableFineWeight: chargeableFine.toFixed(p.fineWeightScale),
    goldValue: fixedMoney(gold),
    wastageValue: fixedMoney(wastageValue),
    makingCharge: fixedMoney(making),
    stoneValue: fixedMoney(stoneValue),
    otherCharges: fixedMoney(otherCharges),
    grossLineValue: fixedMoney(grossLine),
    discount: fixedMoney(discount),
    taxableValue: fixedMoney(taxable),
    taxRatePercent: rate.toString(),
    taxMode: input.tax.mode,
    unroundedTax: unroundedTax.toString(),
    taxBase: afterDiscount.toString(),
    taxAmount: fixedMoney(tax),
    lineTotal: fixedMoney(total),
    trace,
    engineVersion: ENGINE_VERSION,
    policyVersion: policy.version,
  };
}
