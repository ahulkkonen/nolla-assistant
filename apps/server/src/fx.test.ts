import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FAKE_ECB_CSV } from '@pa/fake-llm';
import type { FxRate } from '@pa/protocol';
import { afterEach, expect, test } from 'vitest';
import { ECB_PATH, fxRates, parseEcbCsv } from './fx.ts';
import { runCleanups, tempDir } from './test-utils.ts';

afterEach(runCleanups);
const tmp = () => tempDir('pa-fx-');

type Call = { url: string; init: RequestInit | undefined };
function fakeFetch(answer: () => Response) {
  const calls: Call[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return answer();
  }) as typeof fetch;
  return { f, calls };
}

test('parseEcbCsv takes the probe CSV and refuses a bad one', () => {
  expect(parseEcbCsv(FAKE_ECB_CSV)).toEqual({ usdPerEur: 1.1193, date: '2026-10-23' });
  const head = 'KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE';
  expect(() => parseEcbCsv(head)).toThrow('no date');
  expect(() => parseEcbCsv(`${head}\nX,D,USD,EUR,SP00,A,2026-10-23,9.5`)).toThrow('out of range');
  expect(() => parseEcbCsv(`${head}\nX,D,USD,EUR,SP00,A,23.10.2026,1.1`)).toThrow('no date');
  expect(() => parseEcbCsv('<html>error</html>')).toThrow();
});

test('refresh sends one fixed GET with Accept only, caches the rate and reports a new value', async () => {
  const dataDir = tmp();
  const seen: FxRate[] = [];
  const { f, calls } = fakeFetch(() => new Response(FAKE_ECB_CSV));
  const fx = fxRates({
    dataDir,
    source: 'https://ecb.test',
    fetch: f,
    onChange: (r) => void seen.push(r),
    warn: () => {},
  });
  expect(fx.get()).toBeNull();
  expect(await fx.refresh()).toBe(true);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.url).toBe(`https://ecb.test${ECB_PATH}`);
  expect(calls[0]?.init?.headers).toEqual({ accept: 'text/csv' });
  expect(calls[0]?.init?.method).toBeUndefined();
  expect(fx.get()).toEqual({ usdPerEur: 1.1193, date: '2026-10-23' });
  expect(seen).toHaveLength(1);
  const cache = JSON.parse(readFileSync(join(dataDir, 'fx', 'usd-eur.json'), 'utf8'));
  expect(cache).toMatchObject({ usdPerEur: 1.1193, date: '2026-10-23' });
  // The same value again is no change.
  await fx.refresh();
  expect(seen).toHaveLength(1);
});

test('a failed request keeps the cached rate; start loads the cache', async () => {
  const dataDir = tmp();
  const ok = fakeFetch(() => new Response(FAKE_ECB_CSV));
  await fxRates({
    dataDir,
    source: 'https://ecb.test',
    fetch: ok.f,
    onChange: () => {},
    warn: () => {},
  }).refresh();

  const warnings: string[] = [];
  const bad = fakeFetch(() => new Response('nope', { status: 503 }));
  const fx = fxRates({
    dataDir,
    source: 'https://ecb.test',
    fetch: bad.f,
    onChange: () => {},
    warn: (m) => void warnings.push(m),
  });
  fx.start();
  expect(fx.get()).toEqual({ usdPerEur: 1.1193, date: '2026-10-23' });
  expect(await fx.refresh()).toBe(false);
  expect(fx.get()).toEqual({ usdPerEur: 1.1193, date: '2026-10-23' });
  expect(warnings).toContain('ECB rate fetch failed');
  fx.close();
});

test('a body over 64 KB is refused', async () => {
  const big = fakeFetch(() => new Response(`${FAKE_ECB_CSV}${'x'.repeat(70_000)}`));
  const fx = fxRates({
    dataDir: tmp(),
    source: 'https://ecb.test',
    fetch: big.f,
    onChange: () => {},
    warn: () => {},
  });
  expect(await fx.refresh()).toBe(false);
  expect(fx.get()).toBeNull();
});

test('ECB_RATES=off makes no request', async () => {
  const { f, calls } = fakeFetch(() => new Response(FAKE_ECB_CSV));
  const fx = fxRates({
    dataDir: tmp(),
    source: 'off',
    fetch: f,
    onChange: () => {},
    warn: () => {},
  });
  fx.start();
  expect(await fx.refresh()).toBe(false);
  expect(calls).toHaveLength(0);
  fx.close();
});
