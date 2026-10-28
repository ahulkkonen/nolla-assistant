import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAKE_CATALOG } from '@pa/fake-llm';
import type { DataPolicy, ModelPolicy } from '@pa/protocol';
import { afterEach, expect, test, vi } from 'vitest';
import {
  AUTO_MODEL,
  fetchCatalog,
  isZdrRefusal,
  labOf,
  latestOf,
  type Model,
  modelCatalog,
  piEntry,
  piModelId,
  policyOf,
  recommendedEffort,
  thinkingLevel,
  toModel,
  writeModelsJson,
} from './models.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'pa-models-'));
  dirs.push(d);
  return d;
};

/** An OpenRouter `/api/v1/models` entry; `over` replaces fields. */
const raw = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: `Vendor: ${id}`,
  context_length: 1_000_000,
  pricing: { prompt: '0.000004', completion: '0.00002', input_cache_read: '0.0000002' },
  architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
  supported_parameters: ['tools', 'reasoning'],
  top_provider: { max_completion_tokens: 128_000 },
  reasoning: {
    default_effort: 'high',
    mandatory: true,
    supported_efforts: ['max', 'xhigh', 'high', 'medium', 'low'],
  },
  ...over,
});

/** A `fetch` that serves `all`, and `zdrIds` for `zdr=true`, and records every call. */
function fakeFetch(all: unknown[], zdrIds: string[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const zdrOnly = url.includes('zdr=true');
    const byId = (id: string) => all.find((m) => (m as { id: string }).id === id) ?? { id };
    const data = zdrOnly ? zdrIds.map(byId) : all;
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as typeof fetch;
  return { fn, calls };
}

const model = (id: string, over: Record<string, unknown> = {}) =>
  toModel(raw(id, over), new Set([id])) as Model;

test('the catalog filter drops :variant, ~alias, openrouter/, non-text and tool-less ids', async () => {
  const { fn, calls } = fakeFetch(
    [
      raw('anthropic/claude-opus-5.5'),
      raw('anthropic/claude-fable-5.1'),
      raw('acme/model-1:batch'),
      raw('acme/model-1:free'),
      raw('~openai/gpt-sol-latest'),
      raw('openrouter/auto'),
      raw('acme/image-only', {
        architecture: { input_modalities: ['text'], output_modalities: ['image'] },
      }),
      raw('acme/no-tools', { supported_parameters: ['reasoning'] }),
      raw('Acme/Upper'),
      { id: 'acme/broken' },
    ],
    ['anthropic/claude-opus-5.5'],
  );
  const { models } = await fetchCatalog('https://or.test/api/v1', fn);
  expect(models.map((m) => [m.id, m.zdr])).toEqual([
    ['anthropic/claude-opus-5.5', true],
    ['anthropic/claude-fable-5.1', false],
  ]);
  expect(models[0]).toMatchObject({
    name: 'anthropic/claude-opus-5.5',
    vision: true,
    contextLength: 1_000_000,
    price: { input: 4, output: 20 },
    cacheRead: 0.2,
    cacheWrite: 0,
    maxTokens: 128_000,
  });
  // Decision 8: the two fixed GETs, without a key or anything else.
  expect(calls.map((c) => c.url)).toEqual([
    'https://or.test/api/v1/models?supported_parameters=tools',
    'https://or.test/api/v1/models?supported_parameters=tools&zdr=true',
  ]);
  for (const c of calls) {
    expect(c.init?.method ?? 'GET').toBe('GET');
    expect(c.init?.body).toBeUndefined();
    expect(Object.keys(c.init?.headers ?? {})).toEqual(['accept']);
  }
});

test('a ZDR list that is empty or not a subset of the full list fails the fetch', async () => {
  const opus = raw('anthropic/claude-opus-5.5');
  await expect(fetchCatalog('https://or.test', fakeFetch([opus], []).fn)).rejects.toThrow(
    'not a subset',
  );
  await expect(
    fetchCatalog('https://or.test', fakeFetch([opus], [opus.id, 'acme/elsewhere']).fn),
  ).rejects.toThrow('not a subset');
  await expect(
    fetchCatalog('https://or.test', fakeFetch([opus], [opus.id]).fn),
  ).resolves.toMatchObject({ models: [{ id: opus.id, zdr: true }] });
});

test('latest: per lab the newest alias target in the list, else the newest model by created', async () => {
  const alias = (id: string, slug: string) => raw(id, { alias_target: { slug, name: slug } });
  const all = [
    raw('anthropic/claude-opus-5.5', { created: 300 }),
    raw('anthropic/claude-sonnet-5.5', { created: 200 }),
    // Newer, but no alias points to it: aliases win over `created`.
    raw('anthropic/claude-opus-5.5-preview', { created: 900 }),
    alias('~anthropic/claude-sonnet-latest', 'anthropic/claude-sonnet-5.5'),
    alias('~anthropic/claude-opus-latest', 'anthropic/claude-opus-5.5'),
    // A target outside the list (here a `:variant`) does not count; `created` decides.
    raw('openai/gpt-6', { created: 100 }),
    raw('openai/gpt-6-mini', { created: 150 }),
    raw('openai/gpt-6-mini:free', { created: 999 }),
    alias('~openai/gpt-latest', 'openai/gpt-6-mini:free'),
    // Before `deepseek` in the lab order, though listed after it.
    raw('deepseek/deepseek-v5', { created: 50 }),
    raw('google/gemini-4-argon', { created: 10 }),
    // Not a lab of the section.
    raw('acme/model-9', { created: 5000 }),
    alias('~acme/model-latest', 'acme/model-9'),
  ];
  const { models, latest } = await fetchCatalog(
    'https://or.test',
    fakeFetch(all, ['google/gemini-4-argon']).fn,
  );
  expect(models.map((m) => m.id)).not.toContain('~anthropic/claude-opus-latest');
  expect(latest).toEqual([
    { lab: 'anthropic', modelId: 'anthropic/claude-opus-5.5' },
    { lab: 'openai', modelId: 'openai/gpt-6-mini' },
    { lab: 'google', modelId: 'google/gemini-4-argon' },
    { lab: 'deepseek', modelId: 'deepseek/deepseek-v5' },
  ]);
  // A lab with neither an alias nor a model is left out; an empty catalog has no list.
  expect(latestOf([alias('~x-ai/grok-latest', 'x-ai/grok-9')], new Map())).toEqual([]);
  expect(labOf('~meta-llama/llama-latest')).toBe('meta-llama');
  expect(labOf('mistralai/mistral-large')).toBe('mistralai');
});

test('a mandatory model maps off to null; efforts map to themselves', () => {
  const e = piEntry('zdr', model('anthropic/claude-opus-5.5'));
  expect(e).toMatchObject({
    id: 'zdr/anthropic/claude-opus-5.5',
    reasoning: true,
    compat: { thinkingFormat: 'openrouter' },
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: 'max',
    },
    input: ['text', 'image'],
    contextWindow: 200_000,
    maxTokens: 64_000,
    cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 },
  });
  // `none` supported and not mandatory: off becomes "none".
  const optional = model('openai/gpt-5.5', {
    reasoning: {
      default_effort: 'medium',
      mandatory: false,
      supported_efforts: ['high', 'medium', 'low', 'none'],
    },
  });
  expect(piEntry('open', optional).thinkingLevelMap).toMatchObject({ off: 'none', max: null });
  // A mandatory model never offers `none`, even when OpenRouter lists it.
  const forced = model('acme/forced', {
    reasoning: { default_effort: 'low', mandatory: true, supported_efforts: ['low', 'none'] },
  });
  expect(forced.reasoning?.efforts).toEqual(['low']);
  expect(piEntry('zdr', forced).thinkingLevelMap?.off).toBeNull();
});

test('a model without an effort list gets reasoning: false and no thinking fields', () => {
  for (const reasoning of [undefined, null, { default_effort: 'medium' }]) {
    const m = model('acme/plain', { reasoning });
    expect(m.reasoning).toBeNull();
    const e = piEntry('zdr', m);
    expect(e.reasoning).toBe(false);
    expect(e).not.toHaveProperty('thinkingLevelMap');
    expect(e).not.toHaveProperty('compat');
    expect(thinkingLevel({ modelId: 'acme/plain', reasoning: 'auto' }, m)).toBeUndefined();
  }
});

test('models.json: aliases in zdr, every catalog model in zdr and open, never openRouterRouting', () => {
  const dir = tmp();
  const catalog = [model('anthropic/claude-opus-5.5'), model('acme/plain', { reasoning: null })];
  writeModelsJson(dir, 'http://litellm:4000/v1', catalog);
  const json = JSON.parse(readFileSync(join(dir, 'models.json'), 'utf8'));
  const ids = (p: string) => json.providers[p].models.map((m: { id: string }) => m.id);
  expect(ids('zdr')).toEqual([
    'zdr/strong',
    'zdr/fast',
    'zdr/task-small',
    'zdr/anthropic/claude-opus-5.5',
    'zdr/acme/plain',
  ]);
  expect(ids('open')).toEqual(['open/anthropic/claude-opus-5.5', 'open/acme/plain']);
  for (const p of ['zdr', 'open'])
    expect(json.providers[p]).toMatchObject({
      baseUrl: 'http://litellm:4000/v1',
      api: 'openai-completions',
      apiKey: '$LITELLM_MASTER_KEY',
    });
  expect(JSON.stringify(json)).not.toContain('openRouterRouting');
  // Written through a temp file and a rename: no half-written file for a reader.
  expect(readdirSync(dir)).toEqual(['models.json']);
  // Without a catalog only the aliases remain, and `open` is empty.
  writeModelsJson(dir, 'http://litellm:4000/v1');
  const bare = JSON.parse(readFileSync(join(dir, 'models.json'), 'utf8'));
  expect(bare.providers.open.models).toEqual([]);
  expect(bare.providers.zdr.models).toHaveLength(3);
});

test('auto effort: medium for Opus 5.5, Sonnet 5.5 and Argon; else default, else low', () => {
  const all = ['max', 'xhigh', 'high', 'medium', 'low'] as const;
  expect(recommendedEffort('anthropic/claude-opus-5.5', 'high', [...all])).toBe('medium');
  expect(recommendedEffort('anthropic/claude-sonnet-5.5', 'high', [...all])).toBe('medium');
  expect(recommendedEffort('openai/gpt-6-sol', 'high', [...all])).toBe('high');
  expect(recommendedEffort('acme/x', undefined, [...all])).toBe('low');
  expect(recommendedEffort('acme/x', 'bogus', [...all])).toBe('low');
  // Clamped to the nearest supported effort; a tie goes to the lower one.
  expect(recommendedEffort('acme/x', 'low', ['high', 'medium'])).toBe('medium');
  expect(recommendedEffort('acme/x', 'medium', ['high', 'low'])).toBe('low');
  const argon = toModel(FAKE_CATALOG[0], new Set([AUTO_MODEL]));
  expect(argon).toMatchObject({
    id: AUTO_MODEL,
    name: 'Gemini 4 Argon',
    zdr: true,
    reasoning: { efforts: ['high', 'medium', 'low'], recommended: 'medium', mandatory: true },
  });
  expect(thinkingLevel({ modelId: 'auto', reasoning: 'auto' }, argon)).toBe('medium');
  expect(thinkingLevel({ modelId: 'auto', reasoning: 'low' }, argon)).toBe('low');
  expect(thinkingLevel({ modelId: 'openai/gpt-5.5', reasoning: 'none' }, argon)).toBe('off');
  // Alias chats keep Pi's own level.
  expect(thinkingLevel({ modelId: null, reasoning: 'high' }, argon)).toBeUndefined();
});

test('a failed fetch uses the cache; off never fetches; a good fetch rewrites the cache', async () => {
  const dataDir = tmp();
  const warnings: string[] = [];
  const seen: string[][] = [];
  const opus = raw('anthropic/claude-opus-5.5');
  const ok = fakeFetch([opus], [opus.id]);
  const make = (source: string, fn: typeof fetch) =>
    modelCatalog({
      dataDir,
      source,
      fetch: fn,
      onChange: (models) => void seen.push(models.map((m) => m.id)),
      warn: (msg) => void warnings.push(msg),
    });

  // No cache yet: `start` waits for the fetch and writes the cache.
  const first = make('https://or.test/api/v1', ok.fn);
  await first.start();
  first.close();
  expect(first.get(opus.id)?.zdr).toBe(true);
  expect(first.fetchedAt()).not.toBeNull();
  const cachePath = join(dataDir, 'openrouter', 'catalog.json');
  const cached = readFileSync(cachePath, 'utf8');
  expect(seen).toEqual([[], [opus.id]]);
  // "Uusimmat" lives in the cache file next to the models.
  const latest = [{ lab: 'anthropic', modelId: opus.id }];
  expect(first.latest()).toEqual(latest);
  expect(JSON.parse(cached).latest).toEqual(latest);

  // The network fails: the cache serves, the cache file stays, the failure is logged.
  const down = (async () => {
    throw new Error('getaddrinfo ENOTFOUND openrouter.ai');
  }) as typeof fetch;
  const second = make('https://or.test/api/v1', down);
  await second.start();
  await second.refresh();
  second.close();
  expect(second.list().map((m) => m.id)).toEqual([opus.id]);
  expect(second.fetchedAt()).toBe(first.fetchedAt());
  expect(readFileSync(cachePath, 'utf8')).toBe(cached);
  expect(warnings).toContain('model catalog fetch failed');

  // `off`: the cache loads, nothing is fetched.
  const off = fakeFetch([], []);
  const third = make('off', off.fn);
  await third.start();
  await third.refresh();
  expect(off.calls).toEqual([]);
  expect(third.get(opus.id)).toBeDefined();
  expect(third.latest()).toEqual(latest);

  // A cache from before phase 21 (no `latest`) still loads.
  const { latest: _, ...old } = JSON.parse(cached);
  writeFileSync(cachePath, JSON.stringify(old));
  const older = make('off', off.fn);
  await older.start();
  expect(older.get(opus.id)).toBeDefined();
  expect(older.latest()).toEqual([]);

  // A corrupt cache is ignored with a warning.
  writeFileSync(cachePath, '{"nope":');
  const fourth = make('off', off.fn);
  await fourth.start();
  expect(fourth.list()).toEqual([]);
  expect(fourth.fetchedAt()).toBeNull();
  expect(warnings).toContain('model catalog cache unreadable');

  // An empty answer is a failure, not a new (empty) catalog.
  mkdirSync(join(dataDir, 'openrouter'), { recursive: true });
  writeFileSync(cachePath, cached);
  const empty = make('https://or.test/api/v1', fakeFetch([raw('openrouter/auto')], []).fn);
  await empty.start();
  await empty.refresh();
  empty.close();
  expect(empty.list().map((m) => m.id)).toEqual([opus.id]);

  // Single flight: two callers share one fetch (two GETs).
  const once = fakeFetch([opus], [opus.id]);
  const shared = make('https://or.test/api/v1', once.fn);
  await Promise.all([shared.refresh(), shared.refresh()]);
  expect(once.calls).toHaveLength(2);
});

test('without a catalog, failed fetches retry after 1 min and 5 min, then daily', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const opus = raw('anthropic/claude-opus-5.5');
    let up = false;
    let calls = 0;
    const fn = (async (url: string) => {
      calls++;
      if (!up) throw new Error('offline');
      return fakeFetch([opus], [opus.id]).fn(url);
    }) as typeof fetch;
    const catalog = modelCatalog({
      dataDir: tmp(),
      source: 'https://or.test',
      fetch: fn,
      onChange: () => {},
      warn: () => {},
    });
    await catalog.start();
    expect(calls).toBe(2); // the two GETs of the first attempt
    await vi.advanceTimersByTimeAsync(59_000);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(4);
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(calls).toBe(4);
    up = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBe(6);
    expect(catalog.get(opus.id)).toBeDefined();
    // A catalog exists: the next fetch is a day later.
    await vi.advanceTimersByTimeAsync(23 * 60 * 60_000);
    expect(calls).toBe(6);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(calls).toBe(8);
    catalog.close();
  } finally {
    vi.useRealTimers();
  }
});

test('proof 2: piModelId returns open/ only for dataPolicy open', () => {
  const profile = { model: 'zdr/strong' };
  const ids: (ModelPolicy['modelId'] | string)[] = [null, 'auto', 'anthropic/claude-fable-5.1'];
  const policies: (DataPolicy | string)[] = ['zdr', 'open', 'bogus'];
  const got = ids.flatMap((modelId) =>
    policies.map((dataPolicy) => [
      modelId,
      dataPolicy,
      piModelId(policyOf({ modelId, reasoning: 'auto', dataPolicy }), profile),
    ]),
  );
  expect(got).toEqual([
    [null, 'zdr', { provider: 'zdr', id: 'zdr/strong' }],
    [null, 'open', { provider: 'zdr', id: 'zdr/strong' }],
    [null, 'bogus', { provider: 'zdr', id: 'zdr/strong' }],
    ['auto', 'zdr', { provider: 'zdr', id: `zdr/${AUTO_MODEL}` }],
    ['auto', 'open', { provider: 'open', id: `open/${AUTO_MODEL}` }],
    ['auto', 'bogus', { provider: 'zdr', id: `zdr/${AUTO_MODEL}` }],
    [
      'anthropic/claude-fable-5.1',
      'zdr',
      { provider: 'zdr', id: 'zdr/anthropic/claude-fable-5.1' },
    ],
    [
      'anthropic/claude-fable-5.1',
      'open',
      { provider: 'open', id: 'open/anthropic/claude-fable-5.1' },
    ],
    [
      'anthropic/claude-fable-5.1',
      'bogus',
      { provider: 'zdr', id: 'zdr/anthropic/claude-fable-5.1' },
    ],
  ]);
  // A stored id that does not parse is the alias under ZDR, never a raw string.
  expect(
    piModelId(policyOf({ modelId: 'x/y:free', reasoning: 'auto', dataPolicy: 'open' }), profile),
  ).toEqual({ provider: 'zdr', id: 'zdr/strong' });
  // The prefix comes from the policy alone, whatever the vendor name is.
  expect(
    piModelId(policyOf({ modelId: 'open/x', reasoning: 'auto', dataPolicy: 'zdr' }), profile),
  ).toEqual({ provider: 'zdr', id: 'zdr/open/x' });
});

test("proof 2: 'open/' appears in no other server or extension source file", () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const dirs = [
    'apps/server/src',
    ...readdirSync(join(root, 'packages'))
      .filter((p) => p.startsWith('pi-ext-'))
      .map((p) => `packages/${p}/src`)
      .filter((d) => existsSync(join(root, d))),
  ];
  const files = dirs.flatMap((d) =>
    readdirSync(join(root, d), { recursive: true })
      .map(String)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map((f) => join(d, f)),
  );
  expect(files).toContain('apps/server/src/bridge.ts');
  expect(files).toContain('packages/pi-ext-subagents/src/index.ts');
  const offenders = files.filter(
    (f) =>
      f !== 'apps/server/src/pi/models.ts' && readFileSync(join(root, f), 'utf8').includes('open/'),
  );
  expect(offenders).toEqual([]);
});

test('decision 10: 403 needs a ZDR text; 404 and 503 a ZDR text or a catalog without ZDR', () => {
  const catalog = {
    get: (id: string) =>
      ({ 'acme/no-zdr': { zdr: false }, 'acme/zdr': { zdr: true } })[id] as Model | undefined,
  };
  const zdr = (modelId: string | null) => ({ modelId, dataPolicy: 'zdr' as const });
  const notFound = '404: {"code":404,"message":"No endpoints found matching your data policy"}';
  expect(isZdrRefusal(zdr('acme/no-zdr'), '404 Not Found', catalog)).toBe(true);
  expect(isZdrRefusal(zdr('acme/no-zdr'), '503 No provider available', catalog)).toBe(true);
  expect(isZdrRefusal(zdr('acme/zdr'), notFound, catalog)).toBe(true);
  expect(isZdrRefusal(zdr('acme/unknown'), '503 zero data retention', catalog)).toBe(true);
  expect(isZdrRefusal(zdr('acme/no-zdr'), '403: zero data retention required', catalog)).toBe(true);
  // A short prefix before the status (LiteLLM's exception name).
  expect(isZdrRefusal(zdr('acme/zdr'), `litellm.NotFoundError: ${notFound}`, catalog)).toBe(true);
  // 403 is also budget, guardrail and moderation: never from the catalog alone.
  expect(isZdrRefusal(zdr('acme/no-zdr'), '403: Key limit exceeded', catalog)).toBe(false);
  expect(isZdrRefusal(zdr('acme/no-zdr'), '403 guardrail block', catalog)).toBe(false);
  // A model that is gone is a 404 too.
  expect(isZdrRefusal(zdr('acme/zdr'), '404: Model acme/zdr not found', catalog)).toBe(false);
  expect(isZdrRefusal(zdr('acme/unknown'), '404: model not found', catalog)).toBe(false);
  // The training filter (account-level block): no override fixes it.
  const training =
    '404: No endpoints found matching your data policy. Enable prompt training here: https://openrouter.ai/settings/privacy';
  expect(isZdrRefusal(zdr('acme/zdr'), training, catalog)).toBe(false);
  // An outage of a ZDR model, a non-matching status, a status too far in.
  expect(isZdrRefusal(zdr('acme/zdr'), '503 no provider available', catalog)).toBe(false);
  expect(isZdrRefusal(zdr('acme/no-zdr'), '500 internal error', catalog)).toBe(false);
  expect(isZdrRefusal(zdr('acme/no-zdr'), `${'x'.repeat(41)} 404`, catalog)).toBe(false);
  expect(isZdrRefusal({ modelId: 'acme/no-zdr', dataPolicy: 'open' }, notFound, catalog)).toBe(
    false,
  );
  expect(isZdrRefusal(zdr(null), notFound, catalog)).toBe(false);
  expect(isZdrRefusal(zdr('acme/no-zdr'), undefined, catalog)).toBe(false);
});
