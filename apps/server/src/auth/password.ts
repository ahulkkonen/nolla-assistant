import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

// scrypt defaults: N=16384, r=8, p=1. Shared with scripts/hash-password.mjs.
const KEYLEN = 64;

/** Returns `scrypt$<saltB64>$<hashB64>`. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${scryptSync(password, salt, KEYLEN).toString('base64')}`;
}

export function verifyPassword(stored: string, password: string): boolean {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  if (expected.length !== KEYLEN) return false;
  return timingSafeEqual(scryptSync(password, Buffer.from(salt, 'base64'), KEYLEN), expected);
}
