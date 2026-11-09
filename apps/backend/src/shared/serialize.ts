import { Types } from 'mongoose';

/** Converts database values to their API form: ids and decimals become strings, never floats. */
export function plain<T = unknown>(value: unknown): T {
  return walk(value) as T;
}

function walk(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Types.ObjectId || value instanceof Types.Decimal128) return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(walk);
  if (typeof value === 'object') {
    const entries = Object.entries(value).map(([key, nested]) => [
      key === '_id' ? 'id' : key,
      walk(nested),
    ]);
    return Object.fromEntries(entries);
  }
  return value;
}
