import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CatalogModel, type DataPolicy, ModelId, ModelPolicy, ReasoningEffort } from '@pa/protocol';
import { z } from 'zod';

/** What "Auto" routes to (phase-10 decision 6). Chats store 'auto', so a change moves them all. */
export const AUTO_MODEL = 'google/gemini-4-argon';

/** Vendor guidance that differs from OpenRouter's `default_effort` (decision 7, finding 4). */
const EFFORT_OVERRIDES: Record<string, ReasoningEffort> = {
  'anthropic/claude-opus-5.5': 'medium',
  'anthropic/claude-sonnet-5.5': 'medium',
};

/** The cost caps of decision 0004 and phase-10 "Pi model entries". */
const MAX_CONTEXT = 200_000;
const MAX_OUTPUT = 64_000;
const DAY_MS = 24 * 60 * 60_000;

/** A catalog model plus the fields that only its Pi entry needs. */
export const Model = CatalogModel.extend({
  maxTokens: z.int().min(1),
  cacheRead: z.number().min(0),
  cacheWrite: z.number().min(0),
});
export type Model = z.infer<typeof Model>;
const Cache = z.object({ fetchedAt: z.iso.datetime(), models: z.array(Model) });
type Cache = z.infer<typeof Cache>;

/** Pi thinking level: OpenRouter effort `none` is Pi's `off`. */
export type ThinkingLevel = Exclude<ReasoningEffort, 'none'> | 'off';
const PI_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const RANK = ReasoningEffort.options;

/**
 * Decision 7: the override table, else OpenRouter's `default_effort`, else `low`; then the nearest
 * supported effort (a tie goes to the lower one).
 */
export function recommendedEffort(
  id: string,
  defaultEffort: unknown,
  efforts: ReasoningEffort[],
): ReasoningEffort {
  const want = EFFORT_OVERRIDES[id] ?? ReasoningEffort.safeParse(defaultEffort).data ?? 'low';
  const dist = (e: ReasoningEffort) => Math.abs(RANK.indexOf(e) - RANK.indexOf(want));
  return efforts.reduce((best, e) => (dist(e) <= dist(best) ? e : best));
}

/** One `/api/v1/models` entry, only the fields we read. Unknown fields are ignored. */
const Raw = z.object({
  id: z.string(),
  name: z.string(),
  context_length: z.number().positive(),
  pricing: z.object({
    prompt: z.coerce.number(),
    completion: z.coerce.number(),
    input_cache_read: z.coerce.number().nullish(),
    input_cache_write: z.coerce.number().nullish(),
  }),
  architecture: z.object({
    input_modalities: z.array(z.string()),
    output_modalities: z.array(z.string()),
  }),
  supported_parameters: z.array(z.string()),
  top_provider: z.object({ max_completion_tokens: z.number().positive().nullish() }).nullish(),
  reasoning: z
    .object({
      default_effort: z.unknown(),
      mandatory: z.boolean().nullish(),
      supported_efforts: z.array(z.string()).nullish(),
    })
    .nullish(),
});

/** USD per token (OpenRouter) to USD per 1M tokens, without float noise. */
const perMillion = (usd: number | null | undefined) => Math.round((usd ?? 0) * 1e12) / 1e6;

/**
 * Decision 8 filter: a text model with `tools`, a plain `vendor/model` id (no `:variant`, no `~`)
 * outside `openrouter/`. Anything that does not parse is dropped.
 */
export function toModel(raw: unknown, zdrIds: Set<string>): Model | undefined {
  const r = Raw.safeParse(raw);
  if (!r.success) return undefined;
  const m = r.data;
  const { input_modalities: input, output_modalities: output } = m.architecture;
  if (
    !ModelId.safeParse(m.id).success ||
    m.id.startsWith('openrouter/') ||
    !input.includes('text') ||
    !output.includes('text') ||
    !m.supported_parameters.includes('tools')
  )
    return undefined;
  const mandatory = m.reasoning?.mandatory === true;
  const efforts = (m.reasoning?.supported_efforts ?? []).flatMap((e) => {
    const effort = ReasoningEffort.safeParse(e).data;
    return effort && !(mandatory && effort === 'none') ? [effort] : [];
  });
  const model = Model.safeParse({
    id: m.id,
    name: m.name.replace(/^[^:]*:\s*/, '').slice(0, 120),
    zdr: zdrIds.has(m.id),
    vision: input.includes('image'),
    contextLength: Math.floor(m.context_length),
    price: { input: perMillion(m.pricing.prompt), output: perMillion(m.pricing.completion) },
    reasoning: efforts.length
      ? {
          efforts,
          recommended: recommendedEffort(m.id, m.reasoning?.default_effort, efforts),
          mandatory,
        }
      : null,
    maxTokens: Math.floor(m.top_provider?.max_completion_tokens ?? MAX_OUTPUT),
    cacheRead: perMillion(m.pricing.input_cache_read),
    cacheWrite: perMillion(m.pricing.input_cache_write),
  });
  return model.success ? model.data : undefined;
}

/**
 * Decision 8: the public catalog, twice (all tool models, then the ZDR subset). No key, no user
 * data: only these two fixed GETs.
 */
export async function fetchCatalog(base: string, fetchFn: typeof fetch = fetch): Promise<Model[]> {
  const get = async (query: string) => {
    const res = await fetchFn(`${base}/models?supported_parameters=tools${query}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`catalog HTTP ${res.status}`);
    const data = ((await res.json()) as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) throw new Error('catalog without data');
    return data as unknown[];
  };
  const [all, zdr] = await Promise.all([get(''), get('&zdr=true')]);
  const zdrIds = new Set(zdr.map((m) => String((m as { id?: unknown } | null)?.id)));
  const models = new Map<string, Model>();
  for (const raw of all) {
    const m = toModel(raw, zdrIds);
    if (m && !models.has(m.id)) models.set(m.id, m);
  }
  if (!models.size) throw new Error('catalog has no usable model');
  return [...models.values()];
}

/** One Pi model entry (phase-10 "Pi model entries"). Never sets `compat.openRouterRouting`. */
export function piEntry(provider: DataPolicy, m: Model) {
  const efforts = m.reasoning?.efforts;
  return {
    id: `${provider}/${m.id}`,
    name: m.name,
    reasoning: !!efforts,
    ...(efforts
      ? {
          compat: { thinkingFormat: 'openrouter' },
          thinkingLevelMap: {
            off: efforts.includes('none') ? 'none' : null,
            ...Object.fromEntries(PI_LEVELS.map((l) => [l, efforts.includes(l) ? l : null])),
          },
        }
      : {}),
    input: m.vision ? ['text', 'image'] : ['text'],
    contextWindow: Math.min(m.contextLength, MAX_CONTEXT),
    maxTokens: Math.min(m.maxTokens, MAX_OUTPUT),
    cost: {
      input: m.price.input,
      output: m.price.output,
      cacheRead: m.cacheRead,
      cacheWrite: m.cacheWrite,
    },
  };
}

/** The fixed aliases of `infra/models.json` in `zdr`, plus every catalog model in `zdr` and `open`. */
export function writeModelsJson(
  agentDir: string,
  litellmUrl: string,
  catalog: Model[] = [],
  modelsPath: string | URL = new URL('../../../../infra/models.json', import.meta.url),
) {
  const { models } = JSON.parse(readFileSync(modelsPath, 'utf8'));
  // Both providers reach LiteLLM with its master key; LiteLLM holds the OpenRouter keys.
  const provider = (entries: unknown[]) => ({
    baseUrl: litellmUrl,
    api: 'openai-completions',
    apiKey: '$LITELLM_MASTER_KEY',
    models: entries,
  });
  const config = {
    providers: {
      zdr: provider([...models, ...catalog.map((m) => piEntry('zdr', m))]),
      open: provider(catalog.map((m) => piEntry('open', m))),
    },
  };
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify(config, null, 2));
}

/** A chat row's policy columns as a `ModelPolicy`; a value that does not parse falls back to the alias under ZDR. */
export const policyOf = (r: {
  modelId: string | null;
  reasoning: string;
  dataPolicy: string;
}): ModelPolicy => ({
  modelId: ModelPolicy.shape.modelId.catch(null).parse(r.modelId),
  reasoning: ModelPolicy.shape.reasoning.catch('auto').parse(r.reasoning),
  dataPolicy: r.dataPolicy === 'open' ? 'open' : 'zdr',
});

/**
 * Decision 10: a failed call in a `zdr` chat with a catalog model, with status 403, 404 or 503
 * first (Pi's `formatProviderError`), and either a catalog without ZDR endpoints for the model or
 * a data-policy message. A ZDR model failing with 503 is an outage, not a refusal.
 */
export function isZdrRefusal(
  chat: Pick<ModelPolicy, 'modelId' | 'dataPolicy'>,
  errorMessage: string | undefined,
  catalog: Pick<Catalog, 'get'>,
): boolean {
  if (chat.dataPolicy !== 'zdr' || chat.modelId === null || !errorMessage) return false;
  if (!/^(403|404|503)\b/.test(errorMessage)) return false;
  return (
    catalog.get(resolveModelId(chat.modelId))?.zdr === false ||
    /data policy|zero data retention/i.test(errorMessage)
  );
}

/** The OpenRouter id behind a stored `modelId`. */
export const resolveModelId = (modelId: string) => (modelId === 'auto' ? AUTO_MODEL : modelId);

/**
 * The only place that picks the data-policy prefix (phase-10 "What pa-server sends"). A null
 * `modelId` is the profile's alias in `zdr`; else `open` only for `dataPolicy === 'open'`.
 */
export function piModelId(
  chat: Pick<ModelPolicy, 'modelId' | 'dataPolicy'>,
  profile: { model: string },
): { provider: DataPolicy; id: string } {
  if (chat.modelId === null) return { provider: 'zdr', id: profile.model };
  const provider = chat.dataPolicy === 'open' ? 'open' : 'zdr';
  return { provider, id: `${provider}/${resolveModelId(chat.modelId)}` };
}

/** Decision 7 at session build. Undefined (Pi's own default) for aliases and models without efforts. */
export function thinkingLevel(
  chat: Pick<ModelPolicy, 'modelId' | 'reasoning'>,
  model: CatalogModel | undefined,
): ThinkingLevel | undefined {
  if (chat.modelId === null || !model?.reasoning) return undefined;
  const effort = chat.reasoning === 'auto' ? model.reasoning.recommended : chat.reasoning;
  return effort === 'none' ? 'off' : effort;
}

export type Catalog = ReturnType<typeof modelCatalog>;

/**
 * Decision 8: the catalog from `DATA_DIR/openrouter/catalog.json`, refreshed at `start` and every
 * 24 h. A failed fetch keeps the previous list. `source` is the API base or `off` (no network;
 * the cache still loads). `onChange` gets every new list, and the cached one at `start`. Empty
 * until `start`.
 */
export function modelCatalog(opts: {
  dataDir: string;
  source: string;
  fetch?: typeof fetch;
  onChange: (models: Model[]) => void;
  warn: (msg: string, data?: object) => void;
}) {
  const path = join(opts.dataDir, 'openrouter', 'catalog.json');
  let state: Cache | undefined;
  let byId = new Map<string, Model>();
  let timer: NodeJS.Timeout | undefined;
  const set = (next: Cache) => {
    state = next;
    byId = new Map(next.models.map((m) => [m.id, m]));
    opts.onChange(next.models);
  };

  const refresh = async () => {
    if (opts.source === 'off') return;
    try {
      const next: Cache = {
        fetchedAt: new Date().toISOString(),
        models: await fetchCatalog(opts.source, opts.fetch),
      };
      mkdirSync(join(opts.dataDir, 'openrouter'), { recursive: true });
      writeFileSync(`${path}.tmp`, JSON.stringify(next));
      renameSync(`${path}.tmp`, path);
      set(next);
    } catch (err) {
      opts.warn('model catalog fetch failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return {
    get: (id: string) => byId.get(id),
    list: () => state?.models ?? [],
    fetchedAt: () => state?.fetchedAt ?? null,
    refresh,
    /** Applies the cache, then fetches: awaited only without a cache, so a first boot has models. */
    async start() {
      try {
        set(Cache.parse(JSON.parse(readFileSync(path, 'utf8'))));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
          opts.warn('model catalog cache unreadable', { error: String(err) });
        opts.onChange([]);
      }
      if (opts.source === 'off') return;
      timer = setInterval(() => void refresh(), DAY_MS);
      timer.unref();
      if (state) void refresh();
      else await refresh();
    },
    close: () => clearInterval(timer),
  };
}
