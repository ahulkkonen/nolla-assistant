// Reads a secret from stdin, never from argv: a prompt with echo off on a terminal, else the
// whole of stdin without its last line break. Shared by hash-password.mjs and decrypt-export.mjs.
import { readFileSync } from 'node:fs';

async function prompt(label) {
  process.stderr.write(`${label}: `);
  process.stdin.setRawMode(true);
  let secret = '';
  try {
    for await (const chunk of process.stdin) {
      for (const c of chunk.toString('utf8')) {
        if (c === '\r' || c === '\n') return secret;
        if (c === '\u0003') process.exit(130);
        secret = c === '\u007f' ? secret.slice(0, -1) : secret + c;
      }
    }
    return secret;
  } finally {
    process.stdin.setRawMode(false);
    process.stderr.write('\n');
  }
}

export const readSecret = async (label) =>
  process.stdin.isTTY ? await prompt(label) : readFileSync(0, 'utf8').replace(/\r?\n$/, '');
