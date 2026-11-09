import { describe, expect, it } from 'vitest';
import { canonicalJson, REDACTED, redactSensitive } from './index.js';

describe('canonicalJson', () => {
  it('is independent of key order, at any depth', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [{ f: 3, e: 4 }] } })).toBe(
      canonicalJson({ a: { c: [{ e: 4, f: 3 }], d: 2 }, b: 1 }),
    );
  });

  it('preserves array order', () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });
});

describe('redactSensitive', () => {
  it('redacts sensitive keys at any depth', () => {
    const result = redactSensitive({
      name: 'A',
      passwordHash: 'x',
      nested: [{ refreshToken: 'y', amount: '10.00' }],
      kyc: { emiratesId: '784', passportNumber: 'P1' },
    });
    expect(result).toEqual({
      name: 'A',
      passwordHash: REDACTED,
      nested: [{ refreshToken: REDACTED, amount: '10.00' }],
      kyc: { emiratesId: REDACTED, passportNumber: REDACTED },
    });
  });

  it('does not mutate its input and survives cycles', () => {
    const input: Record<string, unknown> = { password: 'x' };
    input.self = input;
    const result = redactSensitive(input);
    expect(input.password).toBe('x');
    expect(result.self).toBe('[Circular]');
  });

  it('leaves class instances intact', () => {
    class Id {
      token = 'internal';
    }
    const id = new Id();
    expect(redactSensitive({ id }).id).toBe(id);
  });
});
