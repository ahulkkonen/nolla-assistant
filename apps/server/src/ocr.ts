import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

/**
 * Local OCR of a scanned PDF (docs/decisions/phase-16-polish.md, decisions 14 to 18): Poppler's
 * `pdftoppm` renders one page at a time and Tesseract reads it. No shell, no remote service, and
 * the text is never logged.
 */
const run = promisify(execFile);
const MIN_CHARS_PER_PAGE = 50;
const OCR_MAX_PAGES = 30;
export const OCR_BUDGET_MS = 90_000;
const MAX_BUFFER = 16 * 1024 * 1024;

type Warn = (msg: string, data?: object) => void;
let unavailable = false;

/** True when the text layer has fewer than 50 non-space characters per page on average. */
export const needsOcr = (text: string, pages: number) =>
  pages > 0 && text.replace(/\s/g, '').length / pages < MIN_CHARS_PER_PAGE;

/** The tail of the chain: one OCR pipeline per process at a time (phase-16 decision 22). */
let queue: Promise<unknown> = Promise.resolve();

/**
 * The OCR text of the first 30 pages before `deadline` (epoch ms, shared by the files of one
 * message), pages joined with `--- sivu N ---`; a note ends a cut text, and a file that waited past
 * the deadline gets only the note. Undefined when the binaries are missing or the first page
 * fails: the caller keeps its text. `pdf` is the stored upload; `scratch` holds a temp dir with one
 * page image at a time.
 */
export function ocrPdf(
  pdf: string,
  pages: number,
  scratch: string,
  deadline: number,
  warn?: Warn,
): Promise<string | undefined> {
  const job = () => ocrPages(pdf, pages, scratch, deadline, warn);
  const next = queue.then(job, job);
  queue = next.catch(() => {});
  return next;
}

async function ocrPages(
  pdf: string,
  pages: number,
  scratch: string,
  deadline: number,
  warn?: Warn,
): Promise<string | undefined> {
  if (unavailable) return undefined;
  const last = Math.min(pages, OCR_MAX_PAGES);
  const out: string[] = [];
  if (Date.now() >= deadline) return cut(out, pages);
  await mkdir(scratch, { recursive: true });
  const dir = await mkdtemp(join(scratch, '.ocr-'));
  // Only what the binaries need; one thread, because the container has a memory limit.
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    OMP_THREAD_LIMIT: '1',
  };
  const opts = () => ({ timeout: Math.max(1, deadline - Date.now()), maxBuffer: MAX_BUFFER, env });
  let n = 1;
  try {
    for (; n <= last && Date.now() < deadline; n++) {
      const page = String(n);
      const png = join(dir, 'p');
      // `-scale-to` caps the long side, so a huge MediaBox cannot allocate gigabytes.
      const args = [
        '-r',
        '200',
        '-scale-to',
        '2000',
        '-png',
        '-singlefile',
        '-f',
        page,
        '-l',
        page,
      ];
      await run('pdftoppm', [...args, pdf, png], opts());
      const { stdout } = await run(
        'tesseract',
        [`${png}.png`, '-', '-l', 'fin+swe+eng', '--psm', '3'],
        opts(),
      );
      await rm(`${png}.png`, { force: true });
      out.push(`--- sivu ${n} ---\n${stdout.trim()}`);
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { killed?: boolean };
    if (e.code === 'ENOENT') {
      unavailable = true;
      warn?.('ocr unavailable: pdftoppm or tesseract not on PATH');
      return undefined;
    }
    // A run killed by the timeout is the time cap; the others are logged. The pages read so far stay.
    if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') warn?.('ocr output too large', { page: n });
    else if (!e.killed) warn?.('ocr failed', { code: e.code ?? 'unknown', page: n });
    if (out.length === 0 && !e.killed) return undefined;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return cut(out, pages);
}

/** The pages, and the note when fewer than `pages` were read. */
function cut(out: string[], pages: number) {
  return [
    ...out,
    ...(out.length < pages ? [`(OCR katkaistu: ${out.length}/${pages} sivua)`] : []),
  ].join('\n\n');
}
