/** All numeric values are decimal strings. See docs/business-rules/02-calculation-engine.md. */
export type DecimalString = string;

export type RoundingMode = 'HALF_UP' | 'HALF_EVEN' | 'DOWN';

export interface RoundingProfile {
  weightScale: number;
  fineWeightScale: number;
  finenessScale: number;
  rateScale: number;
  moneyScale: number;
  mode: RoundingMode;
}

export interface PricingPolicy {
  version: string;
  rounding: RoundingProfile;
  taxRounding: 'LINE' | 'DOCUMENT';
}

/** FINE_GRAM: price per gram of pure gold. PURITY_GRAM: price per gram of metal at `fineness`. */
export type GoldRate =
  | { basis: 'FINE_GRAM'; value: DecimalString }
  | { basis: 'PURITY_GRAM'; value: DecimalString; fineness: DecimalString };

export type WastageRule =
  | { mode: 'NONE' }
  | { mode: 'PERCENT_OF_WEIGHT'; percent: DecimalString }
  | { mode: 'PERCENT_OF_GOLD_VALUE'; percent: DecimalString }
  | { mode: 'FIXED_GRAMS'; grams: DecimalString };

export type MakingRule =
  | { mode: 'NONE' }
  | { mode: 'PER_GRAM_NET'; rate: DecimalString }
  | { mode: 'PER_GRAM_GROSS'; rate: DecimalString }
  | { mode: 'PER_PIECE'; rate: DecimalString }
  | { mode: 'PERCENT_OF_GOLD_VALUE'; percent: DecimalString }
  | { mode: 'FIXED'; amount: DecimalString };

export type DiscountRule =
  | { kind: 'NONE' }
  | { kind: 'PERCENT'; target: DiscountTarget; percent: DecimalString }
  | { kind: 'AMOUNT'; target: DiscountTarget; amount: DecimalString };

export type DiscountTarget = 'GOLD_VALUE' | 'MAKING' | 'LINE';

export interface TaxRule {
  mode: 'EXCLUSIVE' | 'INCLUSIVE';
  ratePercent: DecimalString;
}

export interface LineInput {
  grossWeight: DecimalString;
  stoneWeight: DecimalString;
  fineness: DecimalString;
  pieces: number;
  rate: GoldRate;
  wastage: WastageRule;
  making: MakingRule;
  stoneValue: DecimalString;
  otherCharges: DecimalString;
  discount: DiscountRule;
  tax: TaxRule;
}

export interface TraceStep {
  step: string;
  formula: string;
  inputs: Record<string, string>;
  output: string;
}

export interface LineResult {
  netWeight: DecimalString;
  chargeableWeight: DecimalString;
  /** Physical pure gold in this line, from net weight. Stock moves by this figure. */
  fineWeight: DecimalString;
  /** Pure gold billed, including any weight-based wastage. */
  chargeableFineWeight: DecimalString;
  goldValue: DecimalString;
  wastageValue: DecimalString;
  makingCharge: DecimalString;
  stoneValue: DecimalString;
  otherCharges: DecimalString;
  grossLineValue: DecimalString;
  discount: DecimalString;
  taxableValue: DecimalString;
  taxRatePercent: DecimalString;
  taxMode: TaxRule['mode'];
  /** Before rounding. Used when policy rounds tax per document. */
  unroundedTax: DecimalString;
  /** Value on which tax applies before rounding: tax-exclusive base or tax-inclusive gross. */
  taxBase: DecimalString;
  taxAmount: DecimalString;
  lineTotal: DecimalString;
  trace: TraceStep[];
  engineVersion: string;
  policyVersion: string;
}

export interface DocumentResult {
  taxableTotal: DecimalString;
  taxTotal: DecimalString;
  discountTotal: DecimalString;
  adjustment: DecimalString;
  grandTotal: DecimalString;
}

export interface OpenItem {
  id: string;
  outstanding: DecimalString;
  /** ISO 8601 date; earliest is settled first. */
  dueDate: string;
}

export type AllocationStrategy =
  | { kind: 'OLDEST_FIRST' }
  | { kind: 'MANUAL'; allocations: { id: string; amount: DecimalString }[] };

export interface AllocationResult {
  allocations: { id: string; amount: DecimalString }[];
  unallocated: DecimalString;
}

export type WeightUnit = 'G' | 'KG' | 'TOZ' | 'TOLA';

export interface UnitOptions {
  /** Required for TOLA, since trade conventions differ. */
  tolaGrams?: DecimalString;
}
