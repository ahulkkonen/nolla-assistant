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
export const OCR_MAX_PAGES = 30;
export const OCR_BUDGET_MS = 90_000;
const MAX_BUFFER = 16 * 1024 * 1024;

type Warn = (msg: string, data?: object) => void;
let unavailable = false;

/** True when the text layer has fewer than 50 non-space characters per page on average. */
export const needsOcr = (text: string, pages: number) =>
  pages > 0 && text.replace(/\s/g, '').length / pages < MIN_CHARS_PER_PAGE;

/**
 * The OCR text of the first 30 pages within 90 s, pages joined with `--- sivu N ---`; a note ends
 * a cut text. Undefined when the binaries are missing or a run fails: the caller keeps its text.
 * `pdf` is the stored upload; `scratch` holds a temp dir with one page image at a time.
 */
export async function ocrPdf(
  pdf: string,
  pages: number,
  scratch: string,
  warn?: Warn,
  budgetMs = OCR_BUDGET_MS,
): Promise<string | undefined> {
  if (unavailable) return undefined;
  const deadline = Date.now() + budgetMs;
  await mkdir(scratch, { recursive: true });
  const dir = await mkdtemp(join(scratch, '.ocr-'));
  // One thread: the container has a memory limit, and one page at a time is enough.
  const env = { ...process.env, OMP_THREAD_LIMIT: '1' };
  const out: string[] = [];
  try {
    const last = Math.min(pages, OCR_MAX_PAGES);
    for (let n = 1; n <= last; n++) {
      const opts = () => ({ timeout: deadline - Date.now(), maxBuffer: MAX_BUFFER, env });
      if (opts().timeout <= 0) break;
      const page = String(n);
      const png = join(dir, 'p');
      await run(
        'pdftoppm',
        ['-r', '200', '-png', '-singlefile', '-f', page, '-l', page, pdf, png],
        opts(),
      );
      if (opts().timeout <= 0) break;
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
    // A run killed by the timeout is the time cap: keep the pages read so far.
    if (!e.killed) {
      warn?.('ocr failed', { code: e.code ?? 'unknown' });
      return undefined;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  if (out.length === 0) return undefined;
  if (out.length < pages) out.push(`(OCR katkaistu: ${out.length}/${pages} sivua)`);
  return out.join('\n\n');
}
