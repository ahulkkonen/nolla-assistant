// Prints the AUTH_PASSWORD_HASH value. The password comes from stdin only, never from argv:
//   node scripts/hash-password.mjs            (prompts with echo off on a terminal)
//   printf %s "$PW" | node scripts/hash-password.mjs
import { readFileSync } from 'node:fs';
import { hashPassword } from '../apps/server/src/auth/password.ts';

async function prompt() {
  process.stderr.write('Password: ');
  process.stdin.setRawMode(true);
  let pw = '';
  try {
    for await (const chunk of process.stdin) {
      for (const c of chunk.toString('utf8')) {
        if (c === '\r' || c === '\n') return pw;
        if (c === '\u0003') process.exit(130);
        pw = c === '\u007f' ? pw.slice(0, -1) : pw + c;
      }
    }
    return pw;
  } finally {
    process.stdin.setRawMode(false);
    process.stderr.write('\n');
  }
}

const password = process.stdin.isTTY
  ? await prompt()
  : readFileSync(0, 'utf8').replace(/\r?\n$/, '');
if (!password) {
  console.error('empty password');
  process.exit(1);
}
console.log(await hashPassword(password));
