import { CalculationError } from './errors.js';
import { assertNonNegative, D, dec, round, type Dec } from './decimal.js';
import type { DecimalString, RoundingMode, UnitOptions, WeightUnit } from './types.js';

const TROY_OUNCE_GRAMS = '31.1034768';
const KILOGRAM_GRAMS = '1000';

function gramsPerUnit(unit: WeightUnit, options: UnitOptions): Dec {
  switch (unit) {
    case 'G':
      return new D(1);
    case 'KG':
      return new D(KILOGRAM_GRAMS);
    case 'TOZ':
      return new D(TROY_OUNCE_GRAMS);
    case 'TOLA': {
      if (!options.tolaGrams) {
        throw new CalculationError('UNSUPPORTED_UNIT', 'TOLA requires a configured tolaGrams');
      }
      return dec(options.tolaGrams, 'tolaGrams');
    }
    default:
      throw new CalculationError('UNSUPPORTED_UNIT', `Unknown weight unit: ${String(unit)}`);
  }
}

export function convertWeight(
  value: DecimalString,
  from: WeightUnit,
  to: WeightUnit,
  options: UnitOptions = {},
): DecimalString {
  const parsed = dec(value, 'value');
  assertNonNegative(parsed, 'value');
  return parsed.times(gramsPerUnit(from, options)).dividedBy(gramsPerUnit(to, options)).toString();
}

/** Converts a price per unit of weight, e.g. AED per kilogram into AED per gram. */
export function convertRate(
  value: DecimalString,
  from: WeightUnit,
  to: WeightUnit,
  options: UnitOptions = {},
): DecimalString {
  const parsed = dec(value, 'value');
  assertNonNegative(parsed, 'value');
  return parsed.times(gramsPerUnit(to, options)).dividedBy(gramsPerUnit(from, options)).toString();
}

/** For configuring purity records only. Line pricing always uses the record's explicit fineness. */
export function finenessFromKarat(
  karat: DecimalString,
  scale: number,
  mode: RoundingMode,
): DecimalString {
  const parsed = dec(karat, 'karat');
  if (parsed.lessThanOrEqualTo(0) || parsed.greaterThan(24)) {
    throw new CalculationError('INVALID_FINENESS', 'karat must be above 0 and at most 24');
  }
  return round(parsed.dividedBy(24), scale, mode).toFixed(scale);
}

export function karatFromFineness(
  fineness: DecimalString,
  scale: number,
  mode: RoundingMode,
): DecimalString {
  const parsed = dec(fineness, 'fineness');
  assertFinenessRange(parsed, 'fineness');
  return round(parsed.times(24), scale, mode).toFixed(scale);
}

/** Weight of metal at `toFineness` that holds the same pure gold as `weight` at `fromFineness`. */
export function convertPurity(
  weight: DecimalString,
  fromFineness: DecimalString,
  toFineness: DecimalString,
  scale: number,
  mode: RoundingMode,
): DecimalString {
  const parsed = dec(weight, 'weight');
  assertNonNegative(parsed, 'weight');
  const from = dec(fromFineness, 'fromFineness');
  const to = dec(toFineness, 'toFineness');
  assertFinenessRange(from, 'fromFineness');
  assertFinenessRange(to, 'toFineness');
  return round(parsed.times(from).dividedBy(to), scale, mode).toFixed(scale);
}

export function assertFinenessRange(value: Dec, field: string): void {
  if (value.lessThanOrEqualTo(0) || value.greaterThan(1)) {
    throw new CalculationError('INVALID_FINENESS', `${field} must be above 0 and at most 1`);
  }
}
