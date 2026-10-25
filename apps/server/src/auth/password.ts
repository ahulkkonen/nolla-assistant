import { randomBytes, type ScryptOptions, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify<string, Buffer, number, ScryptOptions, Buffer>(scryptCb);

const N = 131072;
const R = 8;
const P = 1;
const KEYLEN = 64;
// scrypt needs about 128 * N * r bytes; allow twice that.
const maxmem = (n: number, r: number) => 256 * n * r;

/** Returns `scrypt$N$r$p$<saltB64>$<hashB64>`. Shared with scripts/hash-password.mjs. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEYLEN, { N, r: R, p: P, maxmem: maxmem(N, R) });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/** Verifies against the parameters stored in the hash string. */
export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  const [cost, block, par] = [Number(n), Number(r), Number(p)];
  if (scheme !== 'scrypt' || !salt || !hash || ![cost, block, par].every(Number.isInteger))
    return false;
  const expected = Buffer.from(hash, 'base64');
  if (expected.length === 0) return false;
  try {
    const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, {
      N: cost,
      r: block,
      p: par,
      maxmem: maxmem(cost, block),
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
