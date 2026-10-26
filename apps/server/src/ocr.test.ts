import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chats, files, openDb } from '@pa/db';
import sharp from 'sharp';
import { afterEach, expect, test } from 'vitest';
import { ingestAttachments, splitBlocks } from './files.ts';
import { needsOcr, ocrPdf } from './ocr.ts';
import { runCleanups, tempDir } from './test-utils.ts';

afterEach(runCleanups);

const onPath = (bin: string) => {
  try {
    execFileSync(bin, ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

/** A one-page PDF that holds only a JPEG: no text layer, as a scanner writes it. */
function imagePdf(jpeg: Buffer, w: number, h: number): Buffer {
  const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
  const objects: (string | Buffer)[][] = [
    ['<< /Type /Catalog /Pages 2 0 R >>'],
    ['<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
    [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`,
    ],
    [
      `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
      jpeg,
      '\nendstream',
    ],
    [`<< /Length ${content.length} >>\nstream\n${content}\nendstream`],
  ];
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n')];
  const offsets: number[] = [];
  let size = parts[0]?.length ?? 0;
  const push = (b: Buffer) => {
    parts.push(b);
    size += b.length;
  };
  objects.forEach((obj, i) => {
    offsets.push(size);
    push(Buffer.from(`${i + 1} 0 obj\n`));
    for (const p of obj) push(Buffer.isBuffer(p) ? p : Buffer.from(p));
    push(Buffer.from('\nendobj\n'));
  });
  const xref = size;
  const rows = offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  push(
    Buffer.from(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${rows}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
    ),
  );
  return Buffer.concat(parts);
}

test('needsOcr: under 50 non-space characters per page', () => {
  expect(needsOcr('', 1)).toBe(true);
  expect(needsOcr(`${'a '.repeat(49)}`, 1)).toBe(true);
  expect(needsOcr('a'.repeat(100), 2)).toBe(false);
  expect(needsOcr('', 0)).toBe(false);
});

test('splitBlocks reads an OCR block under its document name', () => {
  const text = 'Lue tämä\n\n[Liite: skannaus.pdf (OCR)]\n--- sivu 1 ---\nteksti';
  expect(splitBlocks(text, ['skannaus.pdf'])).toEqual({ own: 'Lue tämä', names: ['skannaus.pdf'] });
});

test('ocr: a failing page keeps the pages before it; the children get only PATH and HOME', async () => {
  const bin = tempDir('pa-ocr-bin-');
  // pdftoppm writes the PNG it is asked for; tesseract prints its environment, fails on call 3.
  writeFileSync(join(bin, 'pdftoppm'), '#!/bin/sh\nfor a; do :; done\n: > "$a.png"\n', {
    mode: 0o755,
  });
  writeFileSync(
    join(bin, 'tesseract'),
    `#!/bin/sh\nn=$(($(cat ${bin}/n 2>/dev/null || echo 0) + 1)); echo $n > ${bin}/n\n[ $n -lt 3 ] || exit 1\necho "sivu$n $(env | cut -d= -f1 | sort | tr '\\n' ' ')"\n`,
    { mode: 0o755 },
  );
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  process.env.PA_OCR_SECRET = 'x';
  const warns: unknown[] = [];
  try {
    const text = await ocrPdf(
      join(bin, 'in.pdf'),
      5,
      join(bin, 'files'),
      Date.now() + 10_000,
      (m, d) => warns.push([m, d]),
    );
    expect(text).toContain('--- sivu 1 ---\nsivu1');
    expect(text).toContain('--- sivu 2 ---\nsivu2');
    expect(text).toMatch(/\(OCR katkaistu: 2\/5 sivua\)$/);
    expect(text).not.toContain('PA_OCR_SECRET');
    expect(text).toContain('OMP_THREAD_LIMIT');
    expect(warns).toEqual([['ocr failed', { code: 1, page: 3 }]]);
  } finally {
    process.env.PATH = path;
    delete process.env.PA_OCR_SECRET;
  }
});

// Runs in the server-test image (docs/decisions/phase-16-polish.md, gate 3); skipped without the binaries.
test.skipIf(!onPath('tesseract') || !onPath('pdftoppm'))(
  'ocr: a scanned PDF gives its text',
  { timeout: 60_000 },
  async () => {
    const dir = tempDir('pa-ocr-');
    const [w, h] = [1240, 400];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
      <rect width="100%" height="100%" fill="white"/>
      <text x="60" y="220" font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="64" fill="black">Kokous pidetään torstaina</text>
    </svg>`;
    const jpeg = await sharp(Buffer.from(svg))
      .toColourspace('b-w')
      .jpeg({ quality: 90 })
      .toBuffer();
    const pdf = join(dir, 'skannaus.pdf');
    writeFileSync(pdf, imagePdf(jpeg, w, h));
    const scratch = join(dir, 'files');
    const text = await ocrPdf(pdf, 1, scratch, Date.now() + 60_000);
    expect(text).toMatch(/^--- sivu 1 ---\n/);
    expect(text?.toLowerCase()).toContain('torstaina');
    // The page image and the temp dir are gone.
    expect(readdirSync(scratch)).toEqual([]);
    // Past the shared deadline: only the note.
    expect(await ocrPdf(pdf, 2, scratch, Date.now())).toBe('(OCR katkaistu: 0/2 sivua)');

    // Through the attachment path: no text layer, so the block is OCR text with the label suffix.
    const { db, sqlite } = openDb(join(dir, 'app.db'));
    const now = new Date().toISOString();
    const chat = { id: 'c1', userId: 'u1', agentId: 'assistant', sessionPath: 's/' };
    db.insert(chats)
      .values({ ...chat, createdAt: now, updatedAt: now })
      .run();
    mkdirSync(join(scratch, 'u1'));
    copyFileSync(pdf, join(scratch, 'u1', 'f1'));
    const ref = { id: 'f1', name: 'skannaus.pdf', mime: 'application/pdf', size: 1 } as const;
    db.insert(files)
      .values({ ...ref, userId: 'u1', chatId: null, path: 'files/u1/f1', createdAt: now })
      .run();
    const { text: prompt } = await ingestAttachments(db, { dataDir: dir }, 'u1', 'c1', [
      { ...ref, kind: 'document' },
    ]);
    sqlite.close();
    expect(prompt).toMatch(/^\n\n\[Liite: skannaus\.pdf \(OCR\)\]\n--- sivu 1 ---\n/);
    expect(prompt.toLowerCase()).toContain('torstaina');
  },
);
