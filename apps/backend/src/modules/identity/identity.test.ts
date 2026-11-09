import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, totpAt, verifyTotp } from './totp.js';

// RFC 6238 Appendix B test secret ("12345678901234567890"), eight-digit vectors.
const secret = base32Encode(Buffer.from('12345678901234567890'));

describe('TOTP', () => {
  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1234567890, '89005924'],
    [20000000000, '65353130'],
  ])('matches the RFC vector at %i', (time, expected) => {
    expect(totpAt(secret, time, 8)).toBe(expected);
  });

  it('round-trips base32', () => {
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
  });

  it('accepts adjacent steps and rejects others', () => {
    const now = 1_700_000_000;
    expect(verifyTotp(secret, totpAt(secret, now), now)).toBe(true);
    expect(verifyTotp(secret, totpAt(secret, now - 30), now)).toBe(true);
    expect(verifyTotp(secret, totpAt(secret, now - 300), now)).toBe(false);
    expect(verifyTotp(secret, '12', now)).toBe(false);
  });
});
