import { Decimal } from 'decimal.js';
import { Types } from 'mongoose';

type Numeric = Decimal | Types.Decimal128 | string | null | undefined;

export const dec = (value: Numeric): Decimal =>
  value === null || value === undefined ? new Decimal(0) : new Decimal(value.toString());

/** Strings keep their written scale, so "3664.00" is stored and returned as "3664.00". */
export const d128 = (value: Numeric): Types.Decimal128 =>
  Types.Decimal128.fromString(typeof value === 'string' ? value : dec(value).toFixed());

export const money = (value: Numeric, scale = 2): string => dec(value).toFixed(scale);

export { Decimal };
