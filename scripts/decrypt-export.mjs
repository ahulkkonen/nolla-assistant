// Decrypts a full export (`*.zip.enc`) into the zip next to it, after the GCM tag checks out
// (docs/decisions/phase-35-security-fixes.md). The passphrase comes from stdin only:
//   node scripts/decrypt-export.mjs pa-vienti-2026-11-01-masked.zip.enc
//   printf %s "$PASS" | node scripts/decrypt-export.mjs <file>.zip.enc
import { existsSync } from 'node:fs';
import { ExportFormatError, exportDecrypt } from '../apps/server/src/zip.ts';
import { readSecret } from './read-secret.mjs';

const src = process.argv[2];
if (!src?.endsWith('.enc') || !existsSync(src)) {
  console.error('usage: node scripts/decrypt-export.mjs <file>.zip.enc');
  process.exit(2);
}
const dst = src.slice(0, -'.enc'.length);
if (existsSync(dst)) {
  console.error(`${dst} exists; move it first`);
  process.exit(1);
}
try {
  await exportDecrypt(src, dst, await readSecret('Passphrase'));
  console.error(`wrote ${dst}`);
} catch (err) {
  console.error(
    err instanceof ExportFormatError
      ? err.message
      : 'wrong passphrase, or the file has changed; nothing was written',
  );
  process.exit(1);
}
