# Phase 10 — Model picker, thinking level, and per-chat ZDR override

## Goal

The user asked for two changes on 2026-10-26:

1. ZDR must not be a workspace-wide setting, because some models have no ZDR endpoint. ZDR stays enforced, and OpenRouter refuses a request that no ZDR endpoint can serve. After such a refusal, the user can allow that one chat to run without ZDR.
2. The composer gets a model picker with favourite models and "Auto". "Auto" routes to Gemini 4 Argon. The composer also gets a thinking-level control whose default follows the recommended level of each model.

Constraints:

- Every new chat starts ZDR-only.
- "open" is a per-chat choice that the user makes after a refusal. The chat shows it as a badge.
- Automations never use "open".
- The title, topic and summary job, the consolidation job, transcription and embeddings keep their fixed aliases.
- No new dependency.
- The pseudonymization layer does not change. Every call still goes through `pi-ext-pseudo` and the sidecar, whatever the data policy is.

## Research findings

All pages were read on 2026-10-26. Live API data comes from unauthenticated calls on the same day.

### 1. The per-request `provider` object

Source: https://openrouter.ai/docs/guides/routing/provider-selection.md

| Field | Default | Effect |
| --- | --- | --- |
| `zdr` | unset | `true` routes only to ZDR endpoints. "When `zdr` is `false` or not provided, it has no effect on routing." |
| `data_collection` | `"allow"` | `"deny"` uses "only providers which do not collect user data". It filters providers that may train. It does not filter retention. |
| `allow_fallbacks` | `true` | `false` stops the request at the end of `order` instead of trying other providers. |
| `require_parameters` | `false` | `true` routes only to providers that support every parameter in the request. Without it, `tools`, `response_format` and `verbosity` are a soft preference. |
| `only`, `ignore` | unset | Allow or skip provider slugs. A base slug such as `google-vertex` matches every region. |

- Provider retention is not a routing rule: "OpenRouter does not have routing rules that change based on data retention policies of providers" (https://openrouter.ai/docs/guides/privacy/provider-logging.md). ZDR is the only retention filter.
- In `order`, `only` and `ignore`, a base slug does not select a tier endpoint such as `google-vertex/global/priority`. The `service_tier` parameter selects a tier.

### 2. Account, workspace, key and request levels

Sources: https://openrouter.ai/docs/guides/features/zdr.md, https://openrouter.ai/docs/guides/features/guardrails.md, https://openrouter.ai/docs/guides/features/workspaces.md

- The request-level `zdr` "operates as an 'OR' with your account-wide and guardrail ZDR settings". It "can only be used to ensure ZDR is enabled for a specific request, not to override or disable account-wide or guardrail enforcement".
- "Account-wide privacy and provider settings are always enforced as a default guardrail." Account-level data policies "apply to all workspaces".
- Each workspace has a default guardrail that "applies to all traffic in that workspace".
- A per-key privacy setting exists. It is a guardrail assigned to one API key, with the fields `enforce_zdr_anthropic`, `enforce_zdr_openai`, `enforce_zdr_google`, `enforce_zdr_xai` and `enforce_zdr_other`. "A guardrail enforces nothing until it is assigned."
- Guardrails combine with "OR logic per model group" for ZDR. A guardrail can also hold a budget, a model allowlist and a provider allowlist.

Consequence: decision 0004 turned on all five account-level ZDR toggles. While they are on, no request from any key can reach a non-ZDR endpoint. The per-chat override is impossible until the account-level toggles are off.

### 3. The refusal when no endpoint satisfies `zdr: true`

- The error page lists "**503**: There is no available model provider that meets your routing requirements". It also lists "**403**: Forbidden (insufficient permissions, guardrail block, or moderation flag)". Source: https://openrouter.ai/docs/api_reference/errors-and-debugging.md
- The provider-selection page says that a request whose `only` list does not meet the account allowlist "fails with a 404".
- No OpenRouter page gives the exact status and message for a ZDR refusal.
- Third-party reports show the data-policy filter as HTTP 404 with the message "No endpoints found matching your data policy. Enable prompt training here: https://openrouter.ai/settings/privacy" (https://github.com/egoist/chatwise-releases/issues/488, 2025-04-09, training filter). A help page lists 404 "No endpoints found matching your data policy." (https://help.janitorai.com/en/article/openrouter-error-guide-10ear52/).
- A search summary said that a ZDR refusal adds "(Zero data retention)" to that message. The cited GitHub issue (nbonamy/witsy#458) returned 404, so that wording is UNVERIFIED.
- Errors before the stream starts keep their HTTP status. Errors after the first byte arrive inside a 200 response. The ZDR filter acts before routing, so a ZDR refusal is a pre-stream error.

The design must therefore not depend on the message text. Decision 10 classifies the refusal by status and by the catalog.

### 4. The models API

Sources: https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties.md, https://openrouter.ai/docs/api/api-reference/endpoints/list-all-endpoints-for-a-model.md, https://openrouter.ai/docs/api/api-reference/endpoints/preview-the-impact-of-zdr-on-the-available-endpoints.md, https://openrouter.ai/docs/guides/best-practices/reasoning-tokens.md

- `GET https://openrouter.ai/api/v1/models` works without a key. Each model has `id`, `name`, `context_length`, `pricing` (USD per token as strings: `prompt`, `completion`, `input_cache_read`, `input_cache_write`), `architecture.input_modalities`, `supported_parameters`, `top_provider.max_completion_tokens` and `reasoning`.
- Query filters: `zdr=true` ("return only models with zero data retention endpoints"), `supported_parameters=tools`, `output_modalities`, `region`, `q`.
- `supported_parameters` values for reasoning are `include_reasoning`, `reasoning` and `reasoning_effort`.
- The per-model endpoint list (`/api/v1/models/{id}/endpoints`) has no ZDR field. The schema `PublicEndpoint` shows the same. The ZDR list is `GET /api/v1/endpoints/zdr`. It held 1,078 endpoints on 2026-10-26.
- Snapshot on 2026-10-26: 467 models. 286 are text models with `tools`, without a `:variant` suffix, without a `~` alias, and outside `openrouter/`. 218 of these 286 have a ZDR endpoint.

**Recommended effort.** The model object has a `reasoning` object:

```json
{ "default_effort": "medium", "default_enabled": true, "mandatory": false,
  "supported_efforts": ["high", "medium", "low", "minimal"], "supports_max_tokens": true }
```

- `default_effort` is the "Default reasoning effort when the client enables reasoning without specifying effort".
- `supported_efforts` lists the accepted values, highest first. When the field is missing, the model "does not expose effort selection".
- `mandatory: true` means "reasoning cannot be disabled and effort "none" is rejected".
- 219 of the 286 models have a `reasoning` object. 123 of them have an effort list.

So OpenRouter publishes a default effort per model. It is OpenRouter's default, and it is not always the vendor's recommendation. Claude Opus 5.5 is the example the user gave:

| Model id | OpenRouter `default_effort` | OpenRouter efforts | Vendor guidance | Auto resolves to |
| --- | --- | --- | --- | --- |
| `anthropic/claude-opus-5.5` | high | max, xhigh, high, medium, low (mandatory) | "`medium` is the default" (Anthropic, [1]) | **medium** (override) |
| `anthropic/claude-sonnet-5.5` | high | max, xhigh, high, medium, low (mandatory) | API default high. "For chat and other latency-sensitive work, start with `medium` or `low`" (Anthropic, [1]) | **medium** (override) |
| `anthropic/claude-haiku-5.5` | medium | max … low, none | "**Start with `medium`** for most work" (Anthropic, [1]) | medium |
| `openai/gpt-5.5` | medium | xhigh … low, none | "Treat `medium` as the recommended balanced starting point" (OpenAI, [2]) | medium |
| `openai/gpt-5.5-pro` | medium | xhigh, high, medium (mandatory) | No vendor page read. No ZDR endpoint | medium |
| `google/gemini-4-argon` | medium | high, medium, low (mandatory) | "medium (default) … Recommended for most tasks" (Google, [3]) | medium |
| `google/gemini-3.8-flash` | medium | high, medium, low (mandatory) | No vendor page read | medium |
| `openai/gpt-6.1-sol`, `openai/gpt-6-sol`, `openai/gpt-6-luna`, `openai/gpt-6-astra` | medium | max … low (some also none) | No vendor page read | medium |

[1] https://platform.claude.com/docs/en/build-with-claude/effort  
[2] https://developers.openai.com/api/docs/guides/latest-model/gpt-5.5  
[3] https://ai.google.dev/gemini-api/docs/latest-model

The OpenAI family that OpenRouter lists as current is `gpt-6*`. The GPT-5.5 family has two ids: `openai/gpt-5.5` (ZDR on Azure) and `openai/gpt-5.5-pro` (no ZDR endpoint). The only "Gemini 4" id is `google/gemini-4-argon`. The other current Gemini ids are 3.x (`gemini-3.8-flash`, `gemini-3.7-flash`, `gemini-3.6-flash`, `gemini-3.5-flash-lite`).

### 5. Gemini 4 Argon

- OpenRouter id: `google/gemini-4-argon`, name "Google: Gemini 4 Argon", created 2026-10-13. Context 1,048,576 tokens. List price 2.00 / 10.00 USD per 1M input / output tokens.
- Reasoning is mandatory. The efforts are high, medium and low. The default is medium.
- ZDR endpoints: `google-vertex/global` (2.0 / 10), `google-vertex/us` (2.2 / 11, max output 65,536) and `google-vertex/global/priority` (3.6 / 18).
- Non-ZDR endpoints: `google-ai-studio`, `google-ai-studio/flex` and `google-ai-studio/priority`.
- No endpoint is in the EU. Both standard Vertex endpoints reported `status: -2` during the check. The schema does not document the status codes.
- Google: the default thinking level is medium. The introductory Gemini API price runs "through Nov 30, 2026", then 4 / 20 USD (https://ai.google.dev/gemini-api/docs/latest-model). The default synchronous max output is 65,536 (https://ai.google.dev/gemini-api/docs/models/gemini-4-argon).

### 6. The unified `reasoning` parameter and its path through LiteLLM and Pi

OpenRouter (https://openrouter.ai/docs/guides/best-practices/reasoning-tokens.md, https://openrouter.ai/docs/api_reference/parameters.md):

- `reasoning: { effort | max_tokens, exclude, enabled }`. The effort values are `max`, `xhigh`, `high`, `medium`, `low`, `minimal` and `none`. `exclude: true` hides the reasoning text, but OpenRouter still bills it.
- The top-level `reasoning_effort` enum is `xhigh`, `high`, `medium`, `low`, `minimal` and `none`. It has no `max`.
- For Gemini 3 and later, OpenRouter maps `effort` to Google's `thinkingLevel`. It maps a level that a model does not support to the nearest supported level.
- A change of the request-level effort "changes the request prefix and invalidates the prompt cache".
- The `:thinking` model variant is deprecated (https://openrouter.ai/docs/guides/routing/model-variants/thinking.md).

LiteLLM 1.105.1 source (https://github.com/BerriAI/litellm/blob/v1.105.1/litellm/llms/openrouter/chat/transformation.py):

- `OpenrouterConfig.get_supported_openai_params` adds `reasoning_effort` and `thinking`. `map_openai_params` rewrites `reasoning_effort: "max"` to `"xhigh"`.
- `transform_request` merges the deployment `extra_body` last (`response.update(extra_body)`). A configured `extra_body` key therefore wins over a client key with the same name.
- A non-OpenAI client field such as `reasoning` passes through as a provider-specific parameter (decision 0004, finding 2).
- The LiteLLM OpenRouter page names only `transforms`, `models` and `route` (https://docs.litellm.ai/docs/providers/openrouter).

Pi 1.3.0 (`@earendil-works/pi-ai/dist/api/openai-completions.js`, `dist/models.js`):

- `detectCompat` picks `thinkingFormat: "openrouter"` only when the base URL contains `openrouter.ai`. Our base URL is LiteLLM, so Pi uses `"openai"` and sends a top-level `reasoning_effort`.
- A model entry with `compat: { thinkingFormat: "openrouter" }` makes Pi send `reasoning: { effort }`. At thinking level `off`, Pi sends `reasoning: { effort: thinkingLevelMap.off ?? "none" }`, unless `thinkingLevelMap.off` is `null`.
- In `thinkingLevelMap`, `null` marks a level as unsupported. Pi offers `xhigh` and `max` only when they are mapped. `clampThinkingLevel` moves a request to the nearest supported level.
- If a model entry sets `compat.openRouterRouting`, Pi sends a `provider` object (line 734). The ZDR guard refuses that field.
- `ModelRuntime.registerProvider` exists (`pi-coding-agent/dist/core/model-runtime.d.ts:117`). Subagent children read `models.json` from disk.

### 7. Many OpenRouter models in LiteLLM without one alias per model

- A `model_name` with `*` is a pattern route. `PatternMatchRouter` turns `*` into `(.*)` and puts the captured text into the `*` of `litellm_params.model`. So `zdr/*` with `model: openrouter/*` maps `zdr/anthropic/claude-opus-5.5` to `openrouter/anthropic/claude-opus-5.5` (https://docs.litellm.ai/docs/wildcard_routing, https://github.com/BerriAI/litellm/blob/v1.105.1/litellm/router_utils/pattern_match_deployments.py).
- Exact names win. The router tries pattern routes only when the requested name is not in `model_names` (`_try_early_resolve_deployments_for_model_not_in_names` in `router.py` at v1.105.1). `zdr/strong` and the other aliases keep their own deployments.
- `router_settings.model_group_alias` maps one name to one model group, so it still needs one entry per model. It does not help here.
- A `pre_call` custom guardrail receives the requested `data["model"]` and the `call_type` before routing (https://docs.litellm.ai/docs/proxy/guardrails/custom_guardrail). It can refuse with `HTTPException`.

### 8. Facts that are still UNVERIFIED

1. The exact HTTP status and message of a ZDR refusal, and the status that LiteLLM passes on to Pi.
2. Whether a key guardrail with `enforce_zdr_*` refuses with 403 or with the data-policy 404.
3. Whether LiteLLM 1.105.1 passes a client `reasoning` object through unchanged to OpenRouter, next to the deployment `extra_body.provider`.
4. Whether LiteLLM accepts a wildcard model id that its cost map does not know, with `tools` and streaming.
5. The meaning of endpoint `status: -2`.
6. Whether default routing can select `google-vertex/global/priority` for Argon without `service_tier`.
7. Whether OpenRouter's Argon price follows Google's increase on 2026-12-01.
8. Whether a personal OpenRouter account can create two keys with different guardrails. Decision 0004 already assumed key guardrails.
9. The exact `call_type` string that LiteLLM 1.105.1 passes to `async_pre_call_hook` for chat completions. The guard sketch assumes `completion` or `acompletion`.
10. Whether Pi's `errorMessage` starts with the HTTP status for every LiteLLM error. `formatProviderError` puts the status first when it adds the body, and the `openai` SDK message usually starts with the status.

The gate resolves these items. A live check covers items 1 to 3. Egress probes cover items 3, 4 and 9. A server test covers item 10.

## Decisions

1. **ZDR moves from the account level to the key level.** Turn off the five account-level ZDR toggles in https://openrouter.ai/settings/privacy. Keep the account-level setting that blocks providers that train on prompts. Do not put ZDR into the workspace default guardrail. Use two API keys in the default workspace:
   - The **ZDR key** (`OPENROUTER_API_KEY`) has a guardrail with all five `enforce_zdr_*` fields true and a monthly budget. Every `zdr/` deployment uses it, including `zdr/stt`.
   - The **open key** (`OPENROUTER_OPEN_API_KEY`) has a guardrail without ZDR and with its own monthly budget. Only the `open/*` deployment uses it.
2. **The data policy travels in the model name.** pa-server sends `zdr/<openrouter id>` or `open/<openrouter id>`. It sets no new header. The model id is part of the Pi model, so compaction, retries and subagent children carry it too. A header from `before_provider_request` would miss compaction requests (Pi issue #10653), and children would need it plumbed separately.
3. **LiteLLM gets two wildcard deployments.** The exact aliases stay as they are:

   ```yaml
   # Any OpenRouter chat model under ZDR (phase-10). Exact aliases above win over this pattern.
   - model_name: zdr/*
     litellm_params:
       model: openrouter/*
       api_key: os.environ/OPENROUTER_API_KEY
       api_base: os.environ/OPENROUTER_API_BASE
       extra_body:
         provider: { zdr: true, data_collection: deny }

   # Per-chat override after a ZDR refusal (phase-10). Separate key, no ZDR guardrail.
   - model_name: open/*
     litellm_params:
       model: openrouter/*
       api_key: os.environ/OPENROUTER_OPEN_API_KEY
       api_base: os.environ/OPENROUTER_API_BASE
       extra_body:
         provider: { data_collection: deny }
   ```

   The wildcard routes set no `order` and allow fallbacks. With `zdr: true`, every fallback is also a ZDR endpoint. The fixed aliases keep their EU `order` and `allow_fallbacks: false`.
4. **The guard checks the prefix.** `zdr_guard.ZdrGuard` keeps its current rules for client routing fields and for exact aliases. It adds the wildcard rules in "Egress rules" below.
5. **Each chat has a `modelPolicy`.** A new interactive chat starts with `{ modelId: 'auto', reasoning: 'auto', dataPolicy: 'zdr' }`. A null `modelId` means "the agent profile's fixed alias". Older chats and automation chats have a null `modelId`, so their behaviour does not change.
6. **"Auto" is `google/gemini-4-argon`.** The constant `AUTO_MODEL` lives in `apps/server/src/pi/models.ts`. A chat stores `'auto'`, not the id, so a later change of the constant moves every Auto chat.
7. **"Automaattinen" thinking resolves on the server.** The order is:
   1. A two-entry override table in `apps/server/src/pi/models.ts`: `anthropic/claude-opus-5.5` and `anthropic/claude-sonnet-5.5` resolve to `medium` (vendor sources in research finding 4).
   2. Else the catalog `reasoning.default_effort`.
   3. Else `low`, as the user suggested.

   The server clamps the result to `supported_efforts` and sends it as an explicit effort, so the UI can show the resolved level. A model without an effort list gets no thinking control, and Pi sends no reasoning field for it.
8. **pa-server reads the public catalog.** It calls `GET https://openrouter.ai/api/v1/models?supported_parameters=tools` and the same URL with `&zdr=true`, without a key and without user data.
   - It does this at start and every 24 hours.
   - It caches the result in `DATA_DIR/openrouter/catalog.json` and uses the cache when a fetch fails.
   - It keeps text models with `tools` whose id has no `:` suffix, no `~` prefix, and no `openrouter/` vendor.
   - From the catalog it writes `models.json` entries for both Pi providers and resets the shared `ModelRuntime`. New sessions and subagent children see the new list. Open sessions keep their model object.
   - LiteLLM stays the only holder of OpenRouter keys and the only path for prompts.
9. **"open" needs a refusal first.** The server accepts `chat.setDataPolicy` with `open` only when all of these are true:
   - The chat has a non-null `modelId`.
   - The server recorded a ZDR refusal for this chat and this `modelId` since the last model change. The record is an in-memory map, so a restart clears it.
   - No run is active in the chat.

   A model change sets the policy back to `zdr`, because the user gave consent for one model. "Palauta ZDR" sets `zdr` at any time.
10. **The server classifies a ZDR refusal.** A failed model call is a ZDR refusal when all of these are true:
    - The chat policy is `zdr`.
    - Pi's `errorMessage` starts with status 403, 404 or 503. Pi's `formatProviderError` puts the status first.
    - The catalog says that the model has no ZDR endpoint, or the message matches `/data policy|zero data retention/i`.

    A model that has ZDR endpoints and fails with 503 is an outage. It gets the normal "Mallin kutsu epäonnistui" alert, not the override.
11. **Subagents follow the parent.** `pi-ext-subagents` gets the parent's provider (`zdr` or `open`) and passes it as `--provider`. It refuses a task-level `model` whose prefix is not the parent's prefix. Today the model can choose any child model id, so without this check a prompt-injected `open/` child could leave a ZDR chat.
12. **Background jobs do not change.** Titles, topics and summaries use `zdr/task-small` (`apps/server/src/topics.ts`). Consolidation uses `zdr/task-small`. Transcription uses `zdr/stt`. Embeddings run locally (`Xenova/multilingual-e5-small`), and `zdr/embed` stays the remote fallback. None of these reads `modelPolicy`. The guard allows wildcard names only on chat completions.
13. **Favourites live in the database.** A new table `modelFavorites` holds them, so phone and desktop share them. "Auto" is always the first entry and the user cannot remove it. No models are seeded.
14. **A model or policy change rebuilds the session.** The server stores the change and evicts the idle session. The next message rebuilds it with the new model, thinking level and subagent provider. The server refuses the change while a run is active.
15. **Plan amendment.** Section 2, invariant 2 changes to: "ZDR is the default. A guardrailed API key, `provider.zdr` on every `zdr/` request and the LiteLLM guard enforce it. A chat can opt out after a ZDR refusal (decision phase-10). An opted-out chat uses a separate key and stays pseudonymized." This changes a locked invariant. The user asked for the change on 2026-10-26.

## Data model

### Protocol (`packages/protocol/src/index.ts`)

```ts
export const ReasoningEffort = z.enum(['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none']);
export type ReasoningEffort = z.infer<typeof ReasoningEffort>;

/** An OpenRouter model id: vendor/model, lowercase, no `~alias`, no `:variant`. */
export const ModelId = z
  .string()
  .max(100)
  .regex(/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/);

export const DataPolicy = z.enum(['zdr', 'open']);

export const ModelPolicy = z.object({
  /** 'auto', an OpenRouter id, or null for the agent profile's fixed alias (older and automation chats). */
  modelId: z.union([z.literal('auto'), ModelId]).nullable(),
  /** 'auto' resolves on the server (decision 7). */
  reasoning: z.union([z.literal('auto'), ReasoningEffort]),
  dataPolicy: DataPolicy,
});
export type ModelPolicy = z.infer<typeof ModelPolicy>;

/** The part of a policy that the client chooses. `dataPolicy` has its own message. */
export const ModelChoice = z.object({
  modelId: z.union([z.literal('auto'), ModelId]),
  reasoning: z.union([z.literal('auto'), ReasoningEffort]),
});

export const CatalogModel = z.object({
  id: ModelId,
  /** OpenRouter name without the "Vendor: " prefix, e.g. "Claude Opus 5.5". */
  name: z.string().max(120),
  zdr: z.boolean(),
  vision: z.boolean(),
  contextLength: z.int().min(0),
  /** USD per 1M tokens. */
  price: z.object({ input: z.number().min(0), output: z.number().min(0) }),
  /** Null when the model exposes no effort selection. */
  reasoning: z
    .object({
      efforts: z.array(ReasoningEffort).min(1), // highest first, as OpenRouter lists them
      recommended: ReasoningEffort, // what 'auto' resolves to (decision 7)
      mandatory: z.boolean(),
    })
    .nullable(),
});
export type CatalogModel = z.infer<typeof CatalogModel>;
```

Changes to existing schemas:

- `ChatSummary` gets `modelPolicy: ModelPolicy`.
- `chat.create` gets `model: ModelChoice.optional()`. Without `model`, the server stores `modelId: 'auto'` and `reasoning: 'auto'`.
- `chat.create` has no `dataPolicy` field. Zod strips unknown keys, so a client cannot create an `open` chat.

New client messages:

```ts
z.object({ type: z.literal('chat.setModel'), chatId: id64, ...ModelChoice.shape }),
z.object({ type: z.literal('chat.setDataPolicy'), chatId: id64, dataPolicy: DataPolicy }),
z.object({ type: z.literal('models.list') }),
z.object({ type: z.literal('models.favorite'), modelId: ModelId, favorite: z.boolean() }),
```

New server message. The server answers `chat.setModel` and `chat.setDataPolicy` with the existing `chat.updated`.

```ts
z.object({
  type: z.literal('models.state'),
  auto: ModelId, // 'google/gemini-4-argon'
  favorites: z.array(ModelId),
  catalog: z.array(CatalogModel), // about 290 entries, about 55 KB
  fetchedAt: z.iso.datetime().nullable(), // null: no catalog yet
}),
```

New error code: `zdr_unavailable`, with server text "No zero-data-retention endpoint for this model". The bridge `ERRORS` map and the web `ERROR_TEXT` map get the new key.

Server validation:

- A `modelId` other than `'auto'` must be in the catalog.
- A `reasoning` other than `'auto'` must be in the model's `efforts`.
- Anything else answers `bad_message`.

### Database (`packages/db/src/schema.ts`, drizzle migration 0004)

```ts
// in `chats`
modelId: text(), // 'auto' | OpenRouter id | null (agent profile alias)
reasoning: text().notNull().default('auto'),
dataPolicy: text({ enum: ['zdr', 'open'] }).notNull().default('zdr'),

export const modelFavorites = sqliteTable(
  'modelFavorites',
  { userId: text().notNull(), modelId: text().notNull(), createdAt: text().notNull() },
  (t) => [primaryKey({ columns: [t.userId, t.modelId] })],
);
```

- `drizzle-kit generate` writes the `ALTER TABLE ... ADD` statements. Existing rows get `modelId` null, `reasoning` `'auto'` and `dataPolicy` `'zdr'`.
- The enum follows the existing pattern (`text({ enum })`) and has no SQL `CHECK`. The server and zod enforce it.
- Favourites sort by `createdAt`.

### Pi model entries (`apps/server/src/pi/models.ts`)

`writeModelsJson` keeps the fixed aliases from `infra/models.json` in provider `zdr`. It adds one entry per catalog model to provider `zdr` (id `zdr/<id>`) and to a new provider `open` (id `open/<id>`). Both providers use the same `baseUrl` and the LiteLLM master key. An example entry:

```json
{
  "id": "zdr/anthropic/claude-opus-5.5",
  "name": "Claude Opus 5.5",
  "reasoning": true,
  "compat": { "thinkingFormat": "openrouter" },
  "thinkingLevelMap": { "off": null, "minimal": null, "low": "low", "medium": "medium",
                        "high": "high", "xhigh": "xhigh", "max": "max" },
  "input": ["text", "image"],
  "contextWindow": 200000,
  "maxTokens": 64000,
  "cost": { "input": 4, "output": 20, "cacheRead": 0.2, "cacheWrite": 5 }
}
```

- `thinkingLevelMap` maps each effort in `supported_efforts` to itself and every other level to `null`. `off` maps to `"none"` only when `none` is supported.
- A model without an effort list gets `"reasoning": false`. Pi then sends no reasoning field, and the provider default applies.
- `contextWindow` is `min(context_length, 200000)`, the cost cap from decision 0004. `maxTokens` is `min(top_provider.max_completion_tokens, 64000)`. Google keeps 65,536 as the standard Argon output, and Anthropic suggests starting at 64k at high effort.
- The generator never writes `compat.openRouterRouting`.
- Effort to Pi thinking level: `none` becomes `off`. The other values keep their names.

## Egress rules

### What the LiteLLM guard allows

| Requested `model` | Call types | Deployment | Upstream `provider` | OpenRouter key | Extra checks |
| --- | --- | --- | --- | --- | --- |
| Exact alias (`zdr/strong`, `zdr/fast`, `zdr/task-small`, `zdr/stt`, `zdr/embed`) | all | its own entry | `zdr: true`, `data_collection: deny`, `allow_fallbacks: false`, EU `order` | ZDR key | unchanged rules from 0004 |
| `zdr/<vendor>/<model>` | chat completions only | `zdr/*` | `zdr: true`, `data_collection: deny` | ZDR key | id matches `ModelId`. The `zdr/*` entry has `zdr: true` and `deny` |
| `open/<vendor>/<model>` | chat completions only | `open/*` | `data_collection: deny` | open key | id matches `ModelId`. The `open/*` entry has `deny` and no `zdr: true` |
| Anything else | — | — | — | — | 400 `zdr_guard: ...` |

The guard always refuses client `extra_body`, `provider`, `models`, `route` and `transforms`, as it does today. The new guard logic, as a sketch:

```python
OPENROUTER_ID = re.compile(r"^[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*$")
CHAT_CALL_TYPES = ("completion", "acompletion")

def route_ok(prefix: str, litellm_params: dict) -> bool:
    p = (litellm_params.get("extra_body") or {}).get("provider") or {}
    if p.get("data_collection") != "deny":
        return False
    return p.get("zdr") is True if prefix == "zdr/" else p.get("zdr") is not True

# inside async_pre_call_hook, after the client-field check:
if model in exact_names:                      # aliases: unchanged 0004 rules
    ...
prefix = next((p for p in ("zdr/", "open/") if model.startswith(p)), None)
if prefix is None:
    refuse(f"model must be a zdr/ or open/ name, got {model!r}")
if call_type not in CHAT_CALL_TYPES:
    refuse("wildcard models are allowed on chat completions only")
if not OPENROUTER_ID.match(model[len(prefix):]):
    refuse(f"{model!r} is not an OpenRouter model id")
pattern = [d for d in model_list if d["model_name"] == prefix + "*"]
if not pattern or not all(route_ok(prefix, d["litellm_params"]) for d in pattern):
    refuse(f"route {prefix}* is missing or not pinned")
```

### What pa-server sends

One function, `piModelId(chat, profile)` in `apps/server/src/pi/models.ts`, builds the model id:

- If `chat.modelId` is null, the result is `profile.model` (for example `zdr/strong`) in provider `zdr`.
- Else the prefix is `open` when `chat.dataPolicy === 'open'`, and `zdr` otherwise. The id is `AUTO_MODEL` for `'auto'`, else `chat.modelId`.
- The result is `<prefix>/<id>` in Pi provider `<prefix>`.

No other code builds an `open/` string. The request body carries `reasoning: { effort }` from Pi. The server sets no extra header and no LiteLLM metadata.

### Proof that the default stays ZDR-only

Each claim names the test that proves it.

1. **New chats are ZDR.** The column default is `'zdr'`, and `chat.create` has no policy field. Test: a `chat.create` that carries `dataPolicy: 'open'` gives a row with `zdr`, and the session model id starts with `zdr/`.
2. **Only one function picks the prefix.** `piModelId` returns `open/` only for `dataPolicy === 'open'`. Test: a unit test over all combinations of `modelId` and `dataPolicy`. A static test asserts that `'open/'` appears in no other server or extension source file.
3. **"open" needs a recorded refusal.** Test: `chat.setDataPolicy('open')` without a refusal answers `bad_message` and leaves the row on `zdr`. After a classified refusal for the same model, the same message succeeds.
4. **Consent ends with the model.** Test: after `open`, a `chat.setModel` sets the row back to `zdr`, and the rebuilt session model id starts with `zdr/`.
5. **Automations stay on aliases.** An automation run creates a new chat with a null `modelId` and policy `zdr`. The automation YAML schema is strict and has no model or policy field. Test: a run's session model id is `zdr/strong`. The run code asserts `dataPolicy === 'zdr'` before `prompt`.
6. **Background jobs stay on fixed aliases.** Test: in a chat with policy `open`, the title job still calls `zdr/task-small`, as the fake LiteLLM records it.
7. **Children cannot switch to `open/`.** Test: in a `zdr` chat, a subagent task with `model: 'open/x/y'` fails, and no child process starts.
8. **LiteLLM pins every `zdr/` route.** Egress test: `zdr/acme/model-1` reaches the mock with `provider: { zdr: true, data_collection: 'deny' }` and `Authorization: Bearer <ZDR key>`. A static test parses `infra/litellm.yaml` and asserts that every `zdr` entry has `zdr: true`, `deny` and `OPENROUTER_API_KEY`. It also asserts that only `open/*` uses `OPENROUTER_OPEN_API_KEY`.
9. **OpenRouter is a second, independent layer.** The ZDR key's guardrail enforces ZDR for all five model groups. If claims 1 to 8 failed and a `zdr/` request lost its provider block, OpenRouter would still refuse non-ZDR endpoints. The live check in the gate proves this with `zdr/anthropic/claude-fable-5.1`.

## UI

The UI follows the design brief in `docs/decisions/phase-9-ui.md`, section 7. All copy is Finnish (7.9).

### Composer toolbar

| Width | Left | Right |
| --- | --- | --- |
| ≥ 768 | Liitä, agent chip, model chip | mic, send |
| < 768, empty chat | Liitä, agent chip (name and chevron), model chip without chevron | mic, send |
| < 768, started chat | Liitä, agent chip as a 44 px icon button (`Bot` 16) with the name kept as sr-only text, model chip without chevron | mic, send |

- Space check at 390 px: the toolbar has 340 px inside. In a started chat, the other controls and gaps take 200 px. The sum is 44 + 4 + 44 + 4 + 8 + 44 + 8 + 44. That leaves 140 px for the model chip. In an empty chat, the agent chip takes 104 px, which leaves 80 px. "Auto" fits in 80 px.
- The model chip copies the agent chip: ghost, 32 h (44 on phones), radius full, `--text-ui`. It truncates with an ellipsis at 200 px (desktop) or at the space that is left (phone). The accessible name is "Malli: Auto", from sr-only "Malli: " plus the visible name.
- The visible name is the catalog name without the vendor prefix ("Claude Opus 5.5", "Gemini 4 Argon"). A chat with a null `modelId` shows the alias name from `infra/models.json`, for example "Strong (ZDR)".
- While a run is active, the chip is `aria-disabled` with the tooltip "Malli vaihdetaan, kun vastaus on valmis".

### The open-policy badge

- When `dataPolicy === 'open'`, the chip shows a `Badge` (warning variant, 22 h, `--text-micro`) with the text "Ei ZDR" after the model name.
- Under 768 px the badge is a 16 px `ShieldOff` icon in `--warning` before the name.
- The accessible name becomes "Malli: Claude Fable 5.1, ilman ZDR:ää".
- The badge stays visible for the whole time that the chat is open, because the composer is always on screen in the thread.

### Model menu

The menu is a `DropdownMenu` with `modal={false}`, `side="top"`, `align="start"` and width 300 (phone: `min(300px, 100vw - 32px)`). It has these sections from top to bottom:

1. **Malli** (group label, micro muted). It holds radio items:
   - "Auto", with the meta line "Gemini 4 Argon".
   - The favourites in `createdAt` order. A favourite without a ZDR endpoint has the meta line "Ei ZDR-reittiä".
   - The chat's current model when it is not Auto and not a favourite.
   - "Agentin oletus" with the alias name as meta, only for a chat with a null `modelId`.
   - After the radio items, the item "Kaikki mallit…" (`Search` 16), which opens the catalog dialog.
2. **Ajattelu** (only when the selected model has an effort list). It holds radio items:
   - "Automaattinen", with the resolved level as meta, for example "Keskitaso".
   - Then each supported effort, highest first. "Pois" appears only when `none` is supported. Mandatory models never show it.
3. **Open policy** (only when `dataPolicy === 'open'`). It holds the meta line "Tämä keskustelu sallii reitit ilman ZDR:ää." and the item "Palauta ZDR" (`ShieldCheck` 16). The item sends `chat.setDataPolicy` with `zdr`, and the toast says "ZDR palautettu".

In an empty chat, the menu sets `pendingModel` in the store, next to `pendingAgentId`. `createChat` sends it in `chat.create`. In a started chat, a selection sends `chat.setModel`.

Effort labels:

| Effort | Label |
| --- | --- |
| `auto` | Automaattinen |
| `max` | Maksimi |
| `xhigh` | Erittäin korkea |
| `high` | Korkea |
| `medium` | Keskitaso |
| `low` | Matala |
| `minimal` | Minimaalinen |
| `none` | Pois |

### Catalog dialog ("Kaikki mallit")

- The dialog reuses the command palette pattern: `cmdk` in the kit `Dialog`, width 560, top at 15vh, radius 12, `--shadow-md`.
- The input is 48 h with the placeholder and accessible name "Hae malleja".
- Two groups: "Suosikit" and "Kaikki mallit".
- Rows are 44 h. A row shows the name (`--text-ui`) and a meta line. The meta line holds the id in mono 13, the context ("1 M") and the price ("4,00 / 20,00 $").
- At the right of a row: the `Badge` "Ei ZDR" when the model has no ZDR endpoint, and a 28 px star button. The star button is "Lisää suosikkeihin" or "Poista suosikeista", with `Star` filled for a favourite.
- Enter or a click selects the model for the chat and closes the dialog.
- No hits: "Ei tuloksia haulle ”…”". No catalog: "Mallilista ei ole saatavilla. Yritä myöhemmin."
- The desktop footer is "↑↓ liiku · ↵ valitse · Esc sulje". On a phone, the dialog follows the palette rules (inset 8, list max-height 50dvh).
- The client sends `models.list` once after authentication and keeps the answer in the store.

### The ZDR refusal in the thread

The refusal uses the place and shape of the existing failed-reply alert in `Thread.tsx`, with warning colours, because it asks for a decision:

- Container: `role="alert"`, radius 8, bg `--warning-subtle`, padding 12 16, `ShieldAlert` 16 in `--warning`.
- Text (`--text-body`): "Mallilla Claude Fable 5.1 ei ole ZDR-reittiä, joten OpenRouter hylkäsi pyynnön."
- Meta line: "Ilman ZDR:ää palveluntarjoaja voi säilyttää viestit omien ehtojensa mukaan. Nimet ja tunnisteet korvataan silti peitenimillä."
- Buttons: `outline` "Salli ilman ZDR:ää tässä keskustelussa" and `ghost` "Vaihda malli". "Vaihda malli" opens the model menu.
- Under 768 px both buttons are full width and 44 h, stacked under the text.
- The assertive live region announces "Malli ei tue ZDR:ää".

### Deviations from the brief

1. The allow button has 37 characters. Brief 7.9 caps buttons at 16 characters. The user chose this label.
2. In a started chat under 768 px, the agent chip shows an icon and keeps its name as sr-only text. Its accessible name "Agentti: Avustaja" does not change.
3. The model chip has no chevron under 768 px.

## Failure handling

| Failure | What the user sees | Server action |
| --- | --- | --- |
| ZDR refusal (decision 10) | The refusal alert with "Salli ilman ZDR:ää tässä keskustelussa" | Emits `zdr_unavailable` and records the refusal for this chat and model |
| User clicks the allow button | The alert closes, the badge appears, and the last message runs again | Checks decision 9, stores `open`, evicts the session and broadcasts `chat.updated`. The client keeps a pending retry and calls `retryLast` when `chat.updated` shows `open` |
| Model call fails in an `open` chat (for example 404, when only training providers serve the model) | "Mallin kutsu epäonnistui." with "Yritä uudelleen" | `llm_failed`. The account-level training block stays, so there is no second override |
| A ZDR model fails with 503 (outage) | "Mallin kutsu epäonnistui." with "Yritä uudelleen" | `llm_failed`, because the catalog shows ZDR endpoints |
| Error after the stream starts | The existing failed-reply alert | `llm_failed`. Such an error cannot be a ZDR refusal |
| Automation run hits any model error | Nothing in the thread. The existing failure push and `lastStatus: error` | The automation never offers or sets `open` |
| Catalog fetch fails, cache exists | Normal picker. `fetchedAt` is old | Uses the cache and tries again in 24 hours |
| Catalog fetch fails, no cache | Picker shows only Auto and favourites by id. The dialog says "Mallilista ei ole saatavilla. Yritä myöhemmin." | Alias chats work. Without Auto in the catalog, `chat.create` stores `modelId: null` (the agent profile's alias). A chat with a catalog model fails to build and answers `failed`. The server tries again after 1 minute, then after 5 minutes, then every 24 hours |
| The chosen model left the catalog | Toast "Toiminto epäonnistui." | Session build fails. The user picks another model |
| `chat.setModel` or `chat.setDataPolicy` during a run | The control is disabled in the UI | The server answers `failed` if a message arrives |
| User clicks "Palauta ZDR" | The badge disappears | Stores `zdr` and evicts the session. The refusal record stays: until the next model change or a server restart, the user can allow `open` again for the same model without a new refusal (decision 9) |

## Task cards

| # | Task | Owner | Files | Acceptance |
| --- | --- | --- | --- | --- |
| 1 | LiteLLM wildcard routes, guard, second key, account steps | Opus | `infra/litellm.yaml`, `infra/litellm/zdr_guard.py`, `infra/compose.yaml` (`OPENROUTER_OPEN_API_KEY`), `tests/egress/src/egress.test.ts`, `tests/egress/src/mock-openrouter.ts`, `docs/deploy.md` | `pnpm test:egress` passes with the new probes in "Gate". The existing probes still pass. Update the `zdr/unknown` message expectation. `docs/deploy.md` lists the OpenRouter steps of decision 1 |
| 2 | Protocol, database, catalog and Pi entries | Opus | `packages/protocol/src/index.ts` and its test, `packages/db/src/schema.ts`, `packages/db/drizzle/0004_*.sql`, `apps/server/src/pi/models.ts`, a new `apps/server/src/pi/models.test.ts`, `apps/server/src/main.ts` | Unit tests: the catalog filter drops `:batch`, `~` and `openrouter/` ids. An entry for a mandatory model has `off: null`. A model without efforts gets `reasoning: false`. No entry has `compat.openRouterRouting`. Auto effort is medium for Opus 5.5 and Sonnet 5.5, and medium for Argon. A failed fetch uses the cache. `piModelId` covers all policy combinations |
| 3 | Server policy wiring | Opus, after 2 | `apps/server/src/pi/registry.ts` (`getChat`, thinking level, `evict`), `apps/server/src/bridge.ts` (`chat.create` model, `chat.setModel`, `chat.setDataPolicy`, `models.list`, `models.favorite`, refusal classification), `apps/server/src/automations.ts`, `packages/pi-ext-subagents/src/index.ts`, server and subagent tests | Proof claims 1 to 7 each have a passing test. A fake LiteLLM 404 for a non-ZDR model gives `zdr_unavailable`. A 503 for a ZDR model gives `llm_failed` |
| 4 | Model picker, catalog dialog, badge, refusal alert | Opus, UI review, after 3 | a new `apps/web/src/components/ModelPicker.tsx` (chip, menu, dialog), `Composer.tsx`, `AgentPicker.tsx` (phone icon variant), `Thread.tsx`, `store.ts`, `ws.ts`, `tests/e2e`, `tests/fake-llm` (refusal scenario) | UI review passes at 390, 1024 and 1440 px in light and dark. Screenshots: menu, thinking section, dialog, refusal alert, open badge. The e2e flow in "Gate" passes. axe reports no violation |
| 5 | Documentation | Sonnet, after 1 | `docs/plan.md` (section 2 invariant 2, section 5 provider config, section 11 composer row), `docs/decisions/0004-litellm-openrouter-zdr.md` (a note that phase-10 replaces decision 3), `docs/decisions/README.md` (index) | The texts match decisions 1, 2 and 15 |

Out of scope: a palette command "Vaihda malli", per-message policy marks in the thread, a last-used model for new chats, `require_parameters`, and a price cap. Add them when the user asks.

## Gate

1. `pnpm typecheck && pnpm lint && pnpm test` passes.
2. `pnpm test:egress` passes with these new probes against the mock OpenRouter:
   - `zdr/acme/model-1` reaches the mock as `openrouter` model `acme/model-1` with `provider: { zdr: true, data_collection: 'deny' }` and the ZDR key. The id is not in the LiteLLM cost map.
   - `open/acme/model-1` reaches the mock with `provider: { data_collection: 'deny' }`, no `zdr`, and the open key.
   - A client `reasoning: { effort: 'max' }` and `tools` reach the mock body unchanged, next to the configured `provider`.
   - `zdr/strong` still goes to its own deployment with the EU `order`.
   - Refusals, each with HTTP 400 and no upstream request: `zdr/~openai/gpt-sol-latest`, `zdr/acme/model-1:free`, `open/strong`, `zdr/unknown`, and `zdr/openai/text-embedding-3-small` on `/v1/embeddings`.
   - When the mock answers 404 `{"error":{"code":404,"message":"No endpoints found matching your data policy"}}`, LiteLLM passes a 404 to the client.
3. The e2e flow passes:
   1. Pick a favourite without ZDR. The refusal alert appears.
   2. Click the allow button. The reply and the "Ei ZDR" badge appear.
   3. Click "Palauta ZDR". The badge disappears.
4. A one-time live check with the real keys, recorded in a "Verified on" line under this section:
   - `zdr/anthropic/claude-fable-5.1` is refused. Record the exact status and message that pa-server logs.
   - `open/anthropic/claude-fable-5.1` answers.
   - `zdr/google/gemini-4-argon` with `reasoning: { effort: 'low' }` answers. `usage.completion_tokens_details.reasoning_tokens` is lower than at `high` for the same prompt.

## Risks

1. **Region.** Wildcard routes have no `order`, so they can use US or global ZDR endpoints. Auto (Argon) has no EU endpoint at all. The fixed aliases keep the EU order. The text that leaves is pseudonymized.
2. **"open" retains data.** In an `open` chat, the provider can keep prompts under its own terms. Pseudonymization recall is below 100 % (plan section 6), so a missed name can stay with that provider. The refusal alert says this before the user agrees.
3. **Status classification.** Decision 10 depends on the status that LiteLLM passes on. The egress probe and the live check prove it. If LiteLLM maps 404 to another status, add that status to the classifier.
4. **Pi auto-retry.** Pi can retry a 503 before it reports the error. A refusal then shows after a short delay. Pi 1.3.0 `isIdle` is false during the retry delay and during compaction, so the server never evicts a session that is about to retry. `isIdle` is true while a prompt runs its input hooks, so the bridge marks each prompt as active from the call (`registry.hold`).
5. **Cost.** A change of effort or model mid-chat invalidates the prompt cache. A model switch sends the whole masked history to the new model, and Pi can drop reasoning blocks from another vendor. `zdr/*` allows any catalog model, including `openai/gpt-6-astra` at 10 / 50 USD. The key budgets are the cap.
6. **Argon price.** Google's introductory price ends on 2026-11-30. If OpenRouter follows, Auto costs 4 / 20 USD per 1M tokens from 2026-12-01.
7. **Two keys.** A leaked open key allows non-ZDR spend up to its budget. The key lives only in the LiteLLM container, like the ZDR key.
8. **Weaker STT path.** Decision 0004 based ZDR for `zdr/stt` on the account toggle and the key guardrail. After decision 1, only the key guardrail remains, because OpenRouter may ignore `provider[zdr]` in multipart.
9. **Effort table upkeep.** OpenRouter's `default_effort` can differ from the vendor's advice, as it does for Opus 5.5. The override table needs an update when a new model ships with the same mismatch.
10. **Catalog egress.** pa-server makes a new outbound call to `openrouter.ai`. The call carries no key and no user data. The reviewer checks that no prompt text ever uses this path.
11. **Endpoint status.** During the check, both standard Vertex endpoints of Argon reported `status: -2`, which the schema does not explain. If it means "down", Auto can fail with 503 until Google recovers.

## Verified on

2026-10-26, by these methods:

- Reading the OpenRouter documentation pages cited above as `.md` files from `https://openrouter.ai/docs/llms.txt`.
- Calling the public `/api/v1/models`, `/api/v1/models?zdr=true`, `/api/v1/models?supported_parameters=tools&zdr=true`, `/api/v1/endpoints/zdr` and `/api/v1/models/{id}/endpoints` for `google/gemini-4-argon`, `anthropic/claude-opus-5.5`, `anthropic/claude-fable-5.1` and `openai/gpt-5.5-pro`, without a key.
- Reading the vendor pages from Anthropic, OpenAI and Google cited in research finding 4.
- Reading LiteLLM source at tag `v1.105.1` (`router.py`, `router_utils/pattern_match_deployments.py`, `llms/openrouter/chat/transformation.py`) and the LiteLLM docs pages cited above.
- Reading the installed Pi 1.3.0 packages (`pi-ai` and `pi-coding-agent` in `node_modules/.pnpm`).

No live inference call was made, because no OpenRouter key was available. Gate item 4 closes that gap.
