import { describe, expect, it } from 'vitest';
import {
  cursorPageQuerySchema,
  decimalString,
  idempotencyKeySchema,
  MAX_PAGE_LIMIT,
} from './index.js';

describe('decimalString', () => {
  it.each(['0', '10.500', '-3.25'])('accepts %s', (v) => {
    expect(decimalString.safeParse(v).success).toBe(true);
  });

  it.each(['', '1e5', '1.', '.5', 'NaN', '1,000.00', ' 1'])('rejects %j', (v) => {
    expect(decimalString.safeParse(v).success).toBe(false);
  });

  it('rejects JSON numbers', () => {
    expect(decimalString.safeParse(10.5).success).toBe(false);
  });
});

describe('cursorPageQuerySchema', () => {
  it('applies the default limit and coerces strings', () => {
    expect(cursorPageQuerySchema.parse({}).limit).toBe(50);
    expect(cursorPageQuerySchema.parse({ limit: '10' }).limit).toBe(10);
  });

  it('caps the limit and rejects unknown parameters', () => {
    expect(cursorPageQuerySchema.safeParse({ limit: MAX_PAGE_LIMIT + 1 }).success).toBe(false);
    expect(cursorPageQuerySchema.safeParse({ $where: 'x' }).success).toBe(false);
  });
});

describe('idempotencyKeySchema', () => {
  it('rejects short keys and unsafe characters', () => {
    expect(idempotencyKeySchema.safeParse('short').success).toBe(false);
    expect(idempotencyKeySchema.safeParse('abc def ghi').success).toBe(false);
    expect(idempotencyKeySchema.safeParse('d290f1ee-6c54-4b01').success).toBe(true);
  });
});
