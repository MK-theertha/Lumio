import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;

export function base32Encode(data: Buffer): string {
  let bits = '';
  for (const byte of data) bits += byte.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) {
    out += ALPHABET[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  }
  return out;
}

export function base32Decode(text: string): Buffer {
  let bits = '';
  for (const char of text.replace(/=+$/, '').toUpperCase()) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error('Invalid base32');
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export const generateTotpSecret = () => base32Encode(randomBytes(20));

/** RFC 6238 with SHA-1 and six digits, the combination authenticator apps expect. */
export function totpAt(secret: string, unixSeconds: number, digits = 6): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(unixSeconds / STEP_SECONDS)));
  const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = (hmac[hmac.length - 1] as number) & 0xf;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, '0');
}

/** Accepts one step either side, to tolerate clock drift. */
export function verifyTotp(secret: string, code: string, now = Date.now() / 1000): boolean {
  const supplied = Buffer.from(code.padEnd(6, ' '));
  return [-1, 0, 1].some((step) => {
    const expected = Buffer.from(totpAt(secret, now + step * STEP_SECONDS));
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  });
}

export function otpauthUrl(secret: string, account: string): string {
  const label = encodeURIComponent(`Lumio:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=Lumio&digits=6&period=30`;
}
