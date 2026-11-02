import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FxRate } from '@nolla/protocol';
import { z } from 'zod';

/**
 * The ECB USD/EUR reference rate (docs/decisions/phase-13-thread.md, "Egress"). One fixed GET with
 * no key and no user data, at start and every 6 hours; the last value is cached in
 * `DATA_DIR/fx/usd-eur.json`. `source` is the API base or `off` (no request; the cache still loads).
 */

export const ECB_PATH =
  '/service/data/EXR/D.USD.EUR.SP00.A?lastNObservations=1&format=csvdata&detail=dataonly';
const EVERY_MS = 6 * 60 * 60_000;
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 64 * 1024;
const Cache = FxRate.extend({ fetchedAt: z.iso.datetime() });

/** The rate from the ECB data-only CSV; throws on anything else. */
export function parseEcbCsv(text: string): FxRate {
  const [head, row] = text.trim().split(/\r?\n/);
  const cols = head?.split(',') ?? [];
  const cells = row?.split(',') ?? [];
  const date = cells[cols.indexOf('TIME_PERIOD')] ?? '';
  const usdPerEur = Number(cells[cols.indexOf('OBS_VALUE')]);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('ECB CSV: no date');
  if (!(usdPerEur > 0.5 && usdPerEur < 3)) throw new Error('ECB CSV: rate out of range');
  return FxRate.parse({ usdPerEur, date });
}

/** The body as text, refused past `max` bytes (also the web search response, phase-14). */
export async function capped(res: Response, max: number) {
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const r = await reader?.read();
    if (!r || r.done) break;
    size += r.value.byteLength;
    if (size > max) {
      await reader?.cancel();
      const err = new Error('response too large');
      err.name = 'ResponseTooLarge';
      throw err;
    }
    chunks.push(r.value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export type Fx = ReturnType<typeof fxRates>;

export function fxRates(opts: {
  dataDir: string;
  source: string;
  fetch?: typeof fetch;
  /** Every new value (not the cached one at `start`). */
  onChange: (rate: FxRate) => void;
  warn: (msg: string, data?: object) => void;
}) {
  const path = join(opts.dataDir, 'fx', 'usd-eur.json');
  let rate: FxRate | null = null;
  let timer: NodeJS.Timeout | undefined;
  let started = false;
  // `close` aborts a request in flight; a refresh that ends after it writes nothing.
  const closing = new AbortController();

  /** True when it got a rate. A failure keeps the cached value. */
  const refresh = async () => {
    if (opts.source === 'off' || closing.signal.aborted) return false;
    try {
      const res = await (opts.fetch ?? fetch)(`${opts.source}${ECB_PATH}`, {
        headers: { accept: 'text/csv' },
        redirect: 'error',
        signal: AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), closing.signal]),
      });
      if (!res.ok) throw new Error(`ECB status ${res.status}`);
      const next = parseEcbCsv(await capped(res, MAX_BYTES));
      if (closing.signal.aborted) return false;
      mkdirSync(join(opts.dataDir, 'fx'), { recursive: true });
      writeFileSync(
        `${path}.tmp`,
        JSON.stringify({ ...next, fetchedAt: new Date().toISOString() }),
      );
      renameSync(`${path}.tmp`, path);
      const changed = next.date !== rate?.date || next.usdPerEur !== rate?.usdPerEur;
      rate = next;
      if (changed) opts.onChange(next);
      return true;
    } catch (err) {
      // The message only: never the body.
      if (!closing.signal.aborted)
        opts.warn('ECB rate fetch failed', {
          error: err instanceof Error ? err.message : 'unknown',
        });
      return false;
    }
  };

  return {
    /** Null: no rate yet (show USD). */
    get: () => rate,
    refresh,
    /** Loads the cache, then fetches in the background and every 6 hours. Once only. */
    start() {
      if (started) return;
      started = true;
      try {
        const { usdPerEur, date } = Cache.parse(JSON.parse(readFileSync(path, 'utf8')));
        rate = { usdPerEur, date };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
          opts.warn('ECB rate cache unreadable', { error: String(err) });
      }
      if (opts.source === 'off') return;
      void refresh();
      timer = setInterval(() => void refresh(), EVERY_MS);
      timer.unref();
    },
    close: () => {
      clearInterval(timer);
      closing.abort();
    },
  };
}
