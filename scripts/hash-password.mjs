// Usage: node scripts/hash-password.mjs <password>   or   echo -n <password> | node scripts/hash-password.mjs
// Prints the AUTH_PASSWORD_HASH value.
import { readFileSync } from 'node:fs';
import { hashPassword } from '../apps/server/src/auth/password.ts';

const password = process.argv[2] ?? readFileSync(0, 'utf8').replace(/\r?\n$/, '');
if (!password) {
  console.error('empty password');
  process.exit(1);
}
console.log(hashPassword(password));
