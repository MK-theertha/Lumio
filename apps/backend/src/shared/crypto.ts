import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { runtime } from '../config/runtime.js';

const key = () => createHash('sha256').update(runtime().ENCRYPTION_KEY).digest();

/** AES-256-GCM. Output carries a version prefix so keys can be rotated later. */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    data.toString('base64'),
  ].join(':');
}

export function decrypt(sealed: string): string {
  const [version, iv, tag, data] = sealed.split(':');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('Unrecognised ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString(
    'utf8',
  );
}

/** Deterministic keyed hash, for exact-match lookup of encrypted identifiers. */
export function blindIndex(value: string): string {
  return createHmac('sha256', runtime().BLIND_INDEX_KEY)
    .update(value.trim().toUpperCase())
    .digest('hex');
}

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
