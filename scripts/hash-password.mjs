// Prints the AUTH_PASSWORD_HASH value. The password comes from stdin only, never from argv:
//   node scripts/hash-password.mjs            (prompts with echo off on a terminal)
//   printf %s "$PW" | node scripts/hash-password.mjs
import { hashPassword } from '../apps/server/src/auth/password.ts';
import { readSecret } from './read-secret.mjs';

const password = await readSecret('Password');
if (!password) {
  console.error('empty password');
  process.exit(1);
}
console.log(await hashPassword(password));
