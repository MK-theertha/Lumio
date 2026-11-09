import { Decimal } from 'decimal.js';
import { CalculationError } from './errors.js';
import type { RoundingMode } from './types.js';

/** 34 significant digits matches MongoDB Decimal128, so intermediates lose nothing on storage. */
export const D = Decimal.clone({
  precision: 34,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -40,
  toExpPos: 40,
});
export type Dec = InstanceType<typeof D>;

const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;

const MODES: Record<RoundingMode, Decimal.Rounding> = {
  HALF_UP: Decimal.ROUND_HALF_UP,
  HALF_EVEN: Decimal.ROUND_HALF_EVEN,
  DOWN: Decimal.ROUND_DOWN,
};

/** Parses a decimal string. JS numbers are refused so floats can never enter a calculation. */
export function dec(value: unknown, field: string): Dec {
  if (typeof value !== 'string' || !DECIMAL_PATTERN.test(value)) {
    throw new CalculationError('INVALID_DECIMAL', `${field} must be a decimal string`);
  }
  return new D(value);
}

export function assertScale(value: Dec, scale: number, field: string): void {
  if (value.decimalPlaces() > scale) {
    throw new CalculationError(
      'EXCESS_PRECISION',
      `${field} allows at most ${scale} decimal places`,
    );
  }
}

export function round(value: Dec, scale: number, mode: RoundingMode): Dec {
  return value.toDecimalPlaces(scale, MODES[mode]);
}

export function assertNonNegative(value: Dec, field: string): void {
  if (value.isNegative() && !value.isZero()) {
    throw new CalculationError('NEGATIVE_VALUE', `${field} must not be negative`);
  }
}

export function percentOf(base: Dec, percent: Dec): Dec {
  return base.times(percent).dividedBy(100);
}
