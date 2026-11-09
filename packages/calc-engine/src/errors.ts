export type CalculationErrorCode =
  | 'INVALID_DECIMAL'
  | 'EXCESS_PRECISION'
  | 'NEGATIVE_VALUE'
  | 'INVALID_WEIGHT'
  | 'STONE_EXCEEDS_GROSS'
  | 'INVALID_FINENESS'
  | 'INVALID_RATE'
  | 'RATE_PURITY_MISMATCH'
  | 'INVALID_PERCENT'
  | 'INVALID_PIECES'
  | 'DISCOUNT_EXCEEDS_TARGET'
  | 'INVALID_POLICY'
  | 'UNSUPPORTED_UNIT'
  | 'INVALID_ALLOCATION'
  | 'INVALID_APPORTIONMENT';

export class CalculationError extends Error {
  constructor(
    readonly code: CalculationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CalculationError';
  }
}
