# 0004 — LiteLLM, OpenRouter ZDR, and the Presidio backstop

## Context

Phase 3 builds the model-egress layer. The plan sets these requirements:

- Section 2, invariant 2: every model call goes to the LiteLLM proxy. Only LiteLLM holds the OpenRouter key. ZDR is enforced at three levels: the OpenRouter account setting, a guardrailed API key, and `provider: { zdr: true, data_collection: "deny" }` on every request.
- Section 4: `litellm` (`ghcr.io/berriai/litellm`, pinned, config `infra/litellm.yaml`) and `presidio-analyzer` + `presidio-anonymizer` (pinned, backstop only).
- Section 6, "Network backstop": a LiteLLM Presidio `pre_call` guardrail that blocks hetu, IBAN and credit card numbers, uses `logging_only` for other entities, and has PERSON disabled.
- Section 8: the alias `zdr/task-small` for titles and summaries.
- Section 13, phase 3 gate: a test proves that an unmasked hetu is blocked at LiteLLM, and a test proves that a non-ZDR model alias is refused.
- Section 15: "OpenRouter may drop images silently on some routes".
- Decision 0002: every pinned image must be at least 7 days old on 2026-10-25, so published on or before 2026-10-18.
- `infra/models.json`: the server already expects the aliases `zdr/strong`, `zdr/fast` and `zdr/task-small`.

This note records what was checked on 2026-10-25. It also records a local run of LiteLLM 1.105.1 against a mock OpenRouter server and a local Presidio analyzer 2.2.362 (see "Verified on").

## Findings

### 1. LiteLLM image, Postgres, environment

**Tags and dates.** These come from the GitHub releases API (`https://api.github.com/repos/BerriAI/litellm/releases`) and from the image config `created` field on GHCR:

| Tag | Published | Age on 2026-10-25 | Status |
| --- | --- | --- | --- |
| `v1.106.3`, `v1.105.4` | 2026-10-24 | 1 day | Too young |
| `v1.105.3` | 2026-10-21 | 4 days | Too young. Eligible after 2026-10-28 |
| `v1.106.0` | 2026-10-18 05:53Z | exactly 7 days | Allowed, but not chosen: it is the first release of a new minor and already has 3 patch releases |
| `v1.105.1` | 2026-10-14 04:33Z (image built 2026-10-13T23:39Z) | 11 days | **Chosen** |

- The `v1.105.1` notes contain only one entry: "fix(proxy): backport #44243 and #44508 to stable/1.105.x for v1.105.1" (https://github.com/BerriAI/litellm/releases/tag/v1.105.1).
- Digest: `ghcr.io/berriai/litellm:v1.105.1` = `sha256:b7b9e2c306343721802253d0dd9436b9634a2eb4e14da7c7cf06c5c7b7530802`. This is the multi-arch index, read from the `Docker-Content-Digest` header.
- The image is cosign-signed. The release notes give `cosign verify --key https://raw.githubusercontent.com/BerriAI/litellm/0112e53046018d726492c814b3644b7d376029d0/cosign.pub ghcr.io/berriai/litellm:v1.105.1`.
- PyPI `litellm==1.105.1` was uploaded 2026-10-14T04:27:50.
- Tag naming changed. GHCR has `v1.105.1` and `litellm-database:v1.105.1`. It has no `main-v1.105.1` or `-stable` tags. The old `main-vX-stable` scheme ends at `v1.66`.

**Postgres.** Postgres is not needed with `master_key` only. The deploy docs (https://docs.litellm.ai/docs/proxy/deploy) say Postgres is "Required for the proxy's auth and tracking features" and that without a database "authentication falls back to the master key alone". The docs recommend the plain `ghcr.io/berriai/litellm` image, because it "bundles the Prisma toolchain". The docs do not mention `litellm-database`. The `v1.106.0` notes add "fix(proxy): exit when DATABASE_URL is set but the Prisma toolchain is missing". So `DATABASE_URL` must stay unset.

The local run started `litellm --config ... --port 14000` with no `DATABASE_URL` and served every probe below. A request with a wrong bearer key got `400 {"type":"no_db_connection","message":"No connected db."}`. That is a rejection, but with status 400, not 401.

**Environment.**

| Variable | Why |
| --- | --- |
| `OPENROUTER_API_KEY` | Referenced as `os.environ/OPENROUTER_API_KEY` in the config |
| `LITELLM_MASTER_KEY` | Referenced from `general_settings.master_key`. The local run used an `sk-` prefixed value. A value without the prefix was not tested |
| `OR_SITE_URL`, `OR_APP_NAME` | Sent as `HTTP-Referer` and `X-Title`. The source has `get_secret("OR_SITE_URL") or "https://litellm.ai"` in `main.py` and in `llms/openrouter/embedding/transformation.py`. Without them, every call is attributed to "liteLLM" |
| `LITELLM_LOCAL_MODEL_COST_MAP=True` | Stops the startup fetch of the cost map from GitHub (`litellm_core_utils/get_model_cost_map.py`). Without it, LiteLLM makes one more outbound call. Cost data comes from OpenRouter's `usage.cost` anyway |
| `PRESIDIO_ANALYZER_API_BASE`, `PRESIDIO_ANONYMIZER_API_BASE` | Optional. The guardrail YAML can set them instead (`validate_environment` in `guardrail_hooks/presidio.py`) |

- Port: 4000.
- Health checks: `/health/liveliness` and `/health/readiness`.

### 2. `config.yaml` for OpenRouter aliases with ZDR flags

**The docs say little.** The LiteLLM OpenRouter page (https://docs.litellm.ai/docs/providers/openrouter) shows only `model: openrouter/<id>` and `api_key: os.environ/OPENROUTER_API_KEY`. It names `transforms`, `models` and `route` as OpenRouter parameters. It does not mention `provider`, `extra_body`, `zdr` or `allow_fallbacks`. The docs sources are no longer in the repository tree at `v1.105.1`. So the source code and a local test are the evidence for this question.

**Source (`v1.105.1`).**

- `litellm/llms/openrouter/chat/transformation.py`, `transform_request`: `extra_body = optional_params.pop("extra_body", {})`, then `response.update(extra_body)`. It also always adds `"usage": {"include": True}`.
- `openrouter` is not in `openai_compatible_providers`. So `add_provider_specific_params_to_optional_params` in `utils.py` copies every non-OpenAI kwarg as-is, through the `else:` branch with `optional_params[k] = passed_params[k]`.

**Local test (mock upstream).** This deployment:

```yaml
litellm_params:
  model: openrouter/anthropic/claude-sonnet-5.5
  extra_body:
    provider: { zdr: true, data_collection: deny, order: [google-vertex/europe, amazon-bedrock/eu-west-1], allow_fallbacks: false }
```

reached the upstream as this body:

```json
{"model": "anthropic/claude-sonnet-5.5", "messages": [...], "stream": false, "tools": [...], "usage": {"include": true},
 "provider": {"zdr": true, "data_collection": "deny", "order": ["google-vertex/europe", "amazon-bedrock/eu-west-1"], "allow_fallbacks": false}}
```

- A top-level `litellm_params.provider: {zdr: true, data_collection: deny}` also reached the body as `"provider": {...}`. Both forms work.
- **Client override risk:** if a client sends `extra_body`, it replaces the configured `extra_body` completely. A client body of `"extra_body":{"provider":{"zdr":false}}` produced upstream `"provider": {"zdr": false}`, and the configured order and `data_collection` were gone. A top-level client `provider` did not win over the config. Finding 6 adds a guardrail that refuses client routing fields. OpenRouter's account-level and key-level ZDR still apply in this case, because the request-level flag "can only ensure ZDR is enabled, not override" (see finding 3).

**Deterministic routing.** The provider-routing docs are at https://openrouter.ai/docs/guides/routing/provider-selection.md:

- `order`: "List of provider slugs to try in order".
- `allow_fallbacks` (default `true`): "Whether to allow backup providers when the primary is unavailable".
- `only`, `ignore`, `require_parameters`.
- Slugs can name a region, for example `"google-vertex/us-east5"`. A base slug such as `"google-vertex"` matches every region.
- "If you have `sort` or `order` set in your provider preferences, load balancing will be disabled."

**Attribution headers.** The docs are at https://openrouter.ai/docs/app-attribution.md: "`HTTP-Referer` (required)" for app attribution, and "`X-OpenRouter-Title` ... `X-Title` is still supported for backwards compatibility". LiteLLM sends `X-Title` from `OR_APP_NAME`. The local run confirmed `http-referer: https://pa.example` and `x-title: pa-app` on chat and embedding calls. `litellm_params.extra_headers` worked for chat but not for embeddings, so use the environment variables.

### 3. OpenRouter ZDR levels and model choice

**Three enforcement levels.** All are documented at https://openrouter.ai/docs/guides/features/zdr.md:

1. **Account:** https://openrouter.ai/settings/privacy. "In your privacy settings, each model group has its own toggle. Enabling a scope restricts all your requests to ZDR endpoints for that model group." The five groups are Anthropic, OpenAI, Google, SpaceXAI and "All other models". The Anthropic toggle "Removes first-party Anthropic endpoints (Bedrock and Vertex remain available)". Turn on all five.
2. **Guardrail on the API key:** https://openrouter.ai/docs/guides/features/guardrails.md. The guardrail fields are `enforce_zdr_anthropic`, `enforce_zdr_openai`, `enforce_zdr_google`, `enforce_zdr_xai` and `enforce_zdr_other`. "The legacy `enforce_zdr` field is deprecated." "A guardrail enforces nothing until it is assigned." Assign it under the guardrail's **API Keys** section. Multiple guardrails combine with "OR logic per model group". A model allowlist on the same guardrail can also limit the key to the chosen model ids.
3. **Request:** `provider.zdr: true`. The request-level `zdr` parameter "operates as an 'OR' with your account-wide and guardrail ZDR settings ... can only be used to ensure ZDR is enabled for a specific request, not to override or disable account-wide or guardrail enforcement". `data_collection: "deny"` is documented in the same provider-selection table.

The live list of ZDR endpoints is `https://openrouter.ai/api/v1/endpoints/zdr`. It returned 1075 endpoints on 2026-10-25. The per-model endpoints API (`/api/v1/models/<id>/endpoints`) has no ZDR field, so the ZDR list is the evidence below. First-party `anthropic` and `openai` endpoints are not in the ZDR list. Only Vertex, Bedrock and Azure deployments are.

**Recommendation per alias.** Prices are USD per 1M tokens: input / output / cache read / cache write. They come from the ZDR endpoint records.

| Alias | Model id | ZDR endpoints (tag) | Price on chosen endpoint | Why |
| --- | --- | --- | --- | --- |
| `zdr/strong` | `anthropic/claude-sonnet-5.5` (vision, tools, reasoning mandatory, 1M context) | `google-vertex/europe`, `google-vertex/global`, `google-vertex/us`, `amazon-bedrock` | `google-vertex/europe`: 2.2 / 11 / 0.11 / 2.75. Global: 2.0 / 10 / 0.10 / 2.5 | Matches the existing models.json budget class (3 / 15). Alternative: `anthropic/claude-opus-5.5` at 4.4 / 22 (EU), same providers. `openai/gpt-6.1-sol` (Azure, 2.2 / 11 EU) and `google/gemini-4-argon` (Vertex, 2.0 / 10 global) also have ZDR endpoints |
| `zdr/fast` | `anthropic/claude-haiku-5.5` (vision, tools, reasoning optional, effort `none` supported) | `google-vertex/europe`, `amazon-bedrock/eu-west-1`, plus global and US | EU: 0.11 / 0.55 / 0.011 / 0.138 | Cheapest ZDR vision model with tools from a first-tier vendor. Alternative: `google/gemini-3.8-flash` (Vertex, 0.75 / 3.75) |
| `zdr/task-small` | `anthropic/claude-haiku-5.5` with reasoning off | same | same | Same price as the "small" class (`openai/gpt-6-luna` Azure 0.11 / 0.55, `openai/gpt-4.1-nano` Azure 0.11 / 0.44, non-reasoning). Finnish quality is the deciding factor. One model family means one provider order |
| `zdr/stt` | `openai/whisper-large-v3` | `groq`, `deepinfra/us`, `together` | Per second of audio: Groq 0.0000308 (0.111 USD/h), DeepInfra 0.0000075, Together 0.000025 | Whisper covers 99+ languages, including Finnish. Alternatives with ZDR endpoints: `elevenlabs/scribe-v2` ("90+ languages", 0.0000611 USD/s), `microsoft/mai-transcribe-2` (Azure, "60 languages"), `google/chirp-3` (Vertex) |
| `zdr/embed` (optional) | `qwen/qwen3-embedding-8b` | `nebius`, `deepinfra/us`, `siliconflow/fp8` | 0.01 input | Multilingual and cheap. Other ZDR options: `openai/text-embedding-3-small` (Azure 0.02), `google/gemini-embedding-2` (Vertex 0.20). Section 15 compares local models in phase 4. This alias is the remote fallback |

**STT routing limits.** These are from https://openrouter.ai/docs/guides/overview/multimodal/stt.md:

- The `provider` field takes "(`zdr`, `data_collection`) ... Other routing preferences (`order`, `only`, `ignore`) are not applied to transcription requests."
- "upstream providers time out after 60 seconds per request".
- Multipart uploads are limited to 25 MB.
- STT models are listed at `https://openrouter.ai/api/v1/models?output_modalities=transcription`.
- None of the ZDR whisper endpoints is in the EU.

UNVERIFIED: Finnish transcription quality. Phase 7 records a Finnish sentence and compares `openai/whisper-large-v3` and `elevenlabs/scribe-v2`. This is already a gate in section 13.

UNVERIFIED: whether `reasoning: {effort: none}` really turns off thinking for Haiku 5.5 on Vertex and Bedrock. To confirm, make one live call and check that `usage.completion_tokens_details.reasoning_tokens` is 0.

### 4. Presidio guardrail

**Config keys.** These are from the source (`litellm/proxy/guardrails/guardrail_hooks/presidio.py` and `litellm/types/guardrails.py`, `v1.105.1`):

- `guardrail: presidio` and `mode` (one of `pre_call`, `during_call`, `post_call`, `logging_only`).
- `default_on`, `presidio_analyzer_api_base`, `presidio_anonymizer_api_base` and `output_parse_pii`.
- `presidio_language` (default `"en"`).
- `pii_entities_config: {ENTITY: BLOCK|MASK}`. `PiiAction` has only `BLOCK` and `MASK`.
- `presidio_entities_deny_list`, `presidio_score_thresholds`, `presidio_ad_hoc_recognizers`, and the newer `presidio_filter_scope` (`input` / `output` / `both`).

**Behaviour that matters:**

- With `pii_entities_config`, the analyzer is asked only for those entities: `analyze_payload["entities"] = list(self.pii_entities_config.keys())`. So a BLOCK-only config never masks or changes text. It either passes or raises `BlockedPiiEntityError`. PERSON is disabled because it is not listed.
- Fail-closed: `_fail_on_invalid_response` raises when `pii_entities_config` is set. In the local test, with the analyzer stopped, a clean request got `500 "Presidio PII analysis failed: ClientConnectorError"`.
- The anonymizer is always called after analyze (`check_pii` calls `anonymize_text` even with no findings). So the anonymizer container is required.
- `logging_only` is a separate mode on a separate guardrail instance (`if logging_only is True: kwargs["event_hook"] = GuardrailEventHooks.logging_only`). It "Masks the input and output before logging to langfuse, datadog, etc." It does not change the live request. One instance cannot block some entities and log-mask others, so the plan's row needs two guardrails.

**Finnish recognizer name.** `FI_PERSONAL_IDENTITY_CODE` is in LiteLLM's `PiiEntityType` and in Presidio's `FiPersonalIdentityCodeRecognizer`. The Presidio source is at https://github.com/microsoft/presidio/blob/2.2.362/presidio-analyzer/presidio_analyzer/predefined_recognizers/country_specific/finland/fi_personal_identity_code_recognizer.py. Two problems were found:

1. That recognizer defaults to `supported_language: str = "fi"`. It is **not** in the stock `default_recognizers.yaml` (`supported_languages: [en]`). `IbanRecognizer` and `CreditCardRecognizer` load for `en` only. A single guardrail with `presidio_language: fi` would therefore miss IBAN and card numbers, and the stock image does not detect hetu at all.
2. The separator class `[+-ABCDEFYXWVU]` contains the range `+-A` (0x2B–0x41). So it accepts all 2023 separators (`+ - A B C D E F Y X W V U`) and also digits and punctuation. The mod-31 check (`valid_control_characters[number_to_check % 31]`) and a `strptime("%d%m%y")` date check stop most false positives. This answers the section-15 item "handles the 2023 separators": yes, and it is too lenient. It is acceptable for a backstop.

The fix needs no Finnish spaCy model. Mount a recognizer registry that registers `FiPersonalIdentityCodeRecognizer` for `en`, and keep `presidio_language: en`. The stock image reads `RECOGNIZER_REGISTRY_CONF_FILE` at runtime (`app.py`, lines 46–54: `os.environ.get("RECOGNIZER_REGISTRY_CONF_FILE")` passed to `AnalyzerEngineProvider`). Local result with that registry (presidio-analyzer 2.2.362, entities limited to the three):

```
hetu 131052-308T ok              -> [('FI_PERSONAL_IDENTITY_CODE', 1.0)]
uusi erotin 010594Y9032 tässä    -> [('FI_PERSONAL_IDENTITY_CODE', 1.0)]
virheellinen 131052-308X         -> []
IBAN FI21 1234 5600 0007 85      -> [('IBAN_CODE', 1.0)]
kortti 4111 1111 1111 1111       -> [('CREDIT_CARD', 1.0)]
Matti Meikäläinen asuu Helsingissä -> []
```

The plan's `fi` + `en` NLP models are therefore not needed for the backstop. A `fi` spaCy model would matter only for NER entities, and the backstop does not use NER.

**End to end through the proxy** (LiteLLM 1.105.1, guardrail `pii-block`, local analyzer):

- `"hetuni on 131052-308T"` gave `400 "Blocked entity detected: FI_PERSONAL_IDENTITY_CODE by Guardrail: pii-block."`. The same happened with `stream: true`.
- IBAN inside a `role: tool` message gave `400 ... IBAN_CODE`.
- **Gap:** a hetu inside an assistant `tool_calls[].function.arguments` string was **not** scanned and got `200`. Pi's `context_with_system` leak scan (section 6) must cover tool-call arguments.
- A clean Finnish sentence with a name got `200`. PERSON is not active.

**Cited issues.** All three are still open on 2026-10-25:

- #41600 (opened 2026-09-17) "Presidio output_parse_pii — derive placeholders from the value so tokens stay stable across requests": https://github.com/BerriAI/litellm/issues/41600
- #48029 (opened 2026-10-23) "Presidio output_parse_pii restores a placeholder that was already in the request to an unrelated value": https://github.com/BerriAI/litellm/issues/48029
- #46087 (opened 2026-10-12) "Presidio output_parse_pii never restores streamed /v1/messages responses": https://github.com/BerriAI/litellm/issues/46087

All three concern `output_parse_pii`. The BLOCK-only config does not use it, so they do not affect this design. They still justify section 6's "never the system of record".

**Presidio images.** The MCR tag list (`https://mcr.microsoft.com/v2/presidio-analyzer/tags/list`) ends at `2.2.362`, and `latest` has the same digest.

| Image | Tag | Built | Digest |
| --- | --- | --- | --- |
| `mcr.microsoft.com/presidio-analyzer` | `2.2.362` | 2026-03-15 | `sha256:286e3fa7f3a7426e775e8564fe1870f1ba8f999d3ab8bbb8cc46a44355d9d6e9` |
| `mcr.microsoft.com/presidio-anonymizer` | `2.2.362` | 2026-03-15 | `sha256:a10a12a2a613d13cf29d3ad3641e3258444dd8c90403dd644a0a114c472c2483` |

- The analyzer Dockerfile at 2.2.362 has `ENV PORT=3000`, runs as uid 1001, has a health check on `/health`, and installs the models named in `NLP_CONF_FILE` at build time (`en_core_web_lg` by default).
- UNVERIFIED: whether a newer Presidio release exists on GitHub. The GitHub API rate limit was reached. MCR has nothing newer.

### 5. Streaming, tool calls and images through LiteLLM to OpenRouter

**Streaming usage.** This is from https://openrouter.ai/docs/api_reference/streaming.md:

- "every stream ends with an extra chunk that carries the `usage` object".
- OpenRouter "intentionally deviates: the usage chunk contains one choice with a content-free `delta` that repeats the `finish_reason`". "the terminal `finish_reason` appears twice".
- In the local run, LiteLLM forwarded `stream_options.include_usage` and emitted a final chunk `{"choices":[{"index":0,"delta":{}}],"usage":{...,"cost":0.00001}}`. The repeated `finish_reason` was removed.
- The pa-server stream parser must accept a usage chunk that has one empty choice.

**Tool calls.**

- `tools` and `image_url` parts reached the upstream body unchanged in the local run.
- The ZDR endpoints of Sonnet 5.5 and Haiku 5.5 report `supports_tool_choice: {"none": true, "auto": true, "required": false, "function": false}`. A forced `tool_choice` is therefore not available on these routes. Use `auto`.
- OpenRouter docs (https://openrouter.ai/docs/guides/features/tool-calling.md): "The `tools` parameter must be included in every request ... so the router can validate the tool schema on each call."
- Open LiteLLM issue #48145 (2026-10-24, "JSON-defined openai-like providers lose tools by default if model is not in catalog") does not apply, because `openrouter` is a native provider and not JSON-defined.

**Image drop claim.** No primary source (OpenRouter docs, OpenRouter status, or a LiteLLM issue) was found for "OpenRouter may drop images silently". The closest source is a third-party write-up dated 2026-09-12 (https://umesh-malik.com/blog/openrouter-production-provider-bugs): "both Venice and Together returned "no image provided" for a different vision model even though the request included one", and DeepInfra's hosted vision model misread content. In all cases "every one of these providers still returned a 200-status response". These are open-weight hosts. The chosen aliases are pinned to Vertex and Bedrock. OpenRouter's own docs (https://openrouter.ai/docs/guides/overview/multimodal/image-understanding.md) recommend "sending the text prompt first, then the images". UNVERIFIED for our routes: the phase-3 vision test will confirm it (see Consequences).

### 6. Test strategy: refuse a non-ZDR alias

**The default does not refuse.** With `master_key` and no database, a request for `openrouter/openai/gpt-4o` (not in `model_list`) got **200**. The proxy routed it with the environment `OPENROUTER_API_KEY`. The cause is `route_llm_request.py`, which sends any name for which `llm_router.is_recognized_model(data["model"])` is true to the router. A request for the deployment's own name (`openrouter/anthropic/claude-sonnet-5.5`) is also accepted through `llm_router.deployment_names`.

**Custom guardrail.** A custom guardrail closes the gap.

- The example class in the source is `litellm/proxy/example_config_yaml/custom_guardrail.py` (`class myCustomGuardrail(CustomGuardrail)`). Its `async_pre_call_hook(self, user_api_key_dict, cache, data, call_type)` is documented as "Runs before the LLM API call ... Use this if you want to MODIFY the input".
- It is loaded with `guardrail: <module>.<Class>`, resolved next to the config file, plus `mode: pre_call` and `default_on: true`.
- Raising `fastapi.HTTPException(400)` returns a 400 to the client.

The guardrail in the Decision section was run against the mock:

| Probe | Result |
| --- | --- |
| `zdr/strong` (plain and `stream: true`) | 200 |
| `openrouter/openai/gpt-4o` (unknown) | 400 `unknown model alias` |
| `openrouter/anthropic/claude-sonnet-5.5` (deployment name) | 400 |
| `leaky` alias without `provider.zdr` | 400 `not ZDR-pinned` |
| client `extra_body: {"foo":1}` | 400 (a client `extra_body` would replace the configured one) |
| client `models: [...]` | 400 |
| `leaky-embed` on `/v1/embeddings`, `leaky-stt` on `/v1/audio/transcriptions` | 400. The hook runs on these routes too |
| `zdr/embed`, `zdr/stt` | 200 |

The phase-3 test is the same probe set run against the real compose stack with a mock upstream: a `leaky` alias in a test-only config must return 400. A static test also parses `infra/litellm.yaml` and asserts that every `model_list` entry has `extra_body.provider.zdr == true` and `data_collection == "deny"`.

### 7. Embeddings and STT through LiteLLM

- **Embeddings:** `openrouter/<id>` is supported (`litellm/llms/openrouter/embedding/transformation.py`). Locally, `/v1/embeddings` with alias `zdr/embed` sent `{"model": "openai/text-embedding-3-small", "input": ["hei"], "provider": {"zdr": true, "data_collection": "deny"}}` to `/embeddings` upstream. ZDR embedding endpoints exist (finding 3).
- **STT:** LiteLLM has no `openrouter` transcription provider. `litellm/llms/openrouter/` has `chat`, `embedding`, `image_edit`, `image_generation`, `responses` and `decisions`, and no `audio_transcription`. The thinnest alternative that keeps invariant 2 is the `openai/` provider with `api_base` set to OpenRouter. OpenRouter documents the OpenAI-compatible multipart form: "clients built for OpenAI's `/v1/audio/transcriptions` (including the official OpenAI SDKs) work by pointing their base URL at `https://openrouter.ai/api/v1`".
  - Locally, alias `zdr/stt` (`model: openai/openai/whisper-large-v3`, `model_info.mode: audio_transcription`) sent multipart fields `model=openai/whisper-large-v3`, `language=fi`, `response_format=json`, `provider[zdr]=true`, `provider[data_collection]=deny` and `file` upstream.
  - UNVERIFIED: whether OpenRouter reads `provider[zdr]` from multipart. Its multipart section lists only `file`, `model`, `language`, `temperature`, `response_format` and `timestamp_granularities`. For STT, ZDR therefore relies on levels 1 and 2 (account and key guardrail). One live call with a non-ZDR-only STT model and `provider[zdr]=true` would confirm it: a refusal means the field is read.
  - Without `response_format`, LiteLLM sends `verbose_json`. OpenRouter says "Providers that do not return structured output reject `verbose_json` with a 400". So pa-server sends `response_format=json`.
  - `general_settings.pass_through_endpoints` exists (`litellm/types/passthrough_endpoints/pass_through_endpoints.py`, `EndpointType.GENERIC`). It is not needed, because the `openai/` route works. It stays as a fallback if the route breaks.

## Decision

1. **Image pins** (all at least 7 days old on 2026-10-25):
   - `ghcr.io/berriai/litellm:v1.105.1@sha256:b7b9e2c306343721802253d0dd9436b9634a2eb4e14da7c7cf06c5c7b7530802`
   - `mcr.microsoft.com/presidio-analyzer:2.2.362@sha256:286e3fa7f3a7426e775e8564fe1870f1ba8f999d3ab8bbb8cc46a44355d9d6e9`
   - `mcr.microsoft.com/presidio-anonymizer:2.2.362@sha256:a10a12a2a613d13cf29d3ad3641e3258444dd8c90403dd644a0a114c472c2483`
2. **No Postgres.** `master_key` only, and `DATABASE_URL` stays unset. The `litellm` environment is `OPENROUTER_API_KEY`, `LITELLM_MASTER_KEY` (`sk-` prefix), `OR_SITE_URL`, `OR_APP_NAME` and `LITELLM_LOCAL_MODEL_COST_MAP=True`. Mount `infra/litellm.yaml`, `infra/zdr_guard.py` and `infra/presidio-recognizers.yaml` read-only. Run with `--config /app/config/litellm.yaml --port 4000`.
3. **OpenRouter account (manual, once):**
   - **Note (2026-10-26):** Phase 10 replaces this decision. The five account-level ZDR toggles go off. ZDR moves to key guardrails. The `zdr/*` and `open/*` wildcard routes carry the data policy. See [phase-10-models.md](phase-10-models.md), decisions 1 to 3.
   - Turn on the ZDR toggle for all five model groups in https://openrouter.ai/settings/privacy.
   - Create a guardrail with all `enforce_zdr_*` true and a model allowlist of the five model ids below. Assign the guardrail to the LiteLLM key.
4. **Presidio backstop:** one BLOCK-only `pre_call` guardrail with `presidio_language: en`, plus a mounted recognizer registry that adds `FiPersonalIdentityCodeRecognizer` for `en`. The analyzer gets `RECOGNIZER_REGISTRY_CONF_FILE=/app/conf/presidio-recognizers.yaml`. No `fi` spaCy model and no custom image.
5. **No `logging_only` guardrail for now.** It masks only the copy sent to logging integrations, and this stack has none. If one is added later, it would also hide real values from the section-14 leak test, which greps the LiteLLM request log. That test must then read the upstream body instead. This deviates from the section-6 row.
6. **`infra/models.json` follow-up:** update the costs to the EU endpoint prices. `zdr/strong`: input 2.2, output 11, cacheRead 0.11, cacheWrite 2.75. `zdr/fast` and `zdr/task-small`: 0.11 / 0.55 / 0.011 / 0.138. `contextWindow` can stay at 200000 as a cost cap. Both models accept 1M.

Draft `infra/litellm.yaml`:

```yaml
# Every alias must carry extra_body.provider {zdr: true, data_collection: deny}.
# zdr_guard refuses any request that resolves to an alias without it.
model_list:
  - model_name: zdr/strong
    litellm_params:
      model: openrouter/anthropic/claude-sonnet-5.5
      api_key: os.environ/OPENROUTER_API_KEY
      extra_body:
        provider:
          zdr: true
          data_collection: deny
          order: [google-vertex/europe, amazon-bedrock]
          allow_fallbacks: false

  - model_name: zdr/fast
    litellm_params:
      model: openrouter/anthropic/claude-haiku-5.5
      api_key: os.environ/OPENROUTER_API_KEY
      extra_body:
        reasoning: { effort: none }
        provider:
          zdr: true
          data_collection: deny
          order: [google-vertex/europe, amazon-bedrock/eu-west-1]
          allow_fallbacks: false

  - model_name: zdr/task-small
    litellm_params:
      model: openrouter/anthropic/claude-haiku-5.5
      api_key: os.environ/OPENROUTER_API_KEY
      extra_body:
        reasoning: { effort: none }
        provider:
          zdr: true
          data_collection: deny
          order: [google-vertex/europe, amazon-bedrock/eu-west-1]
          allow_fallbacks: false

  # OpenRouter ignores order/only for STT; ZDR here relies on account + key guardrail.
  - model_name: zdr/stt
    litellm_params:
      model: openai/openai/whisper-large-v3
      api_key: os.environ/OPENROUTER_API_KEY
      api_base: https://openrouter.ai/api/v1
      extra_body:
        provider: { zdr: true, data_collection: deny }
    model_info: { mode: audio_transcription }

  # Remote fallback only; phase 4 decides between this and a local model.
  - model_name: zdr/embed
    litellm_params:
      model: openrouter/qwen/qwen3-embedding-8b
      api_key: os.environ/OPENROUTER_API_KEY
      extra_body:
        provider: { zdr: true, data_collection: deny }

guardrails:
  - guardrail_name: zdr-guard
    litellm_params:
      guardrail: zdr_guard.ZdrGuard
      mode: pre_call
      default_on: true

  - guardrail_name: pii-block
    litellm_params:
      guardrail: presidio
      mode: pre_call
      default_on: true
      presidio_analyzer_api_base: http://presidio-analyzer:3000
      presidio_anonymizer_api_base: http://presidio-anonymizer:3000
      presidio_language: en
      pii_entities_config:
        FI_PERSONAL_IDENTITY_CODE: BLOCK
        IBAN_CODE: BLOCK
        CREDIT_CARD: BLOCK

general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
```

Draft `infra/zdr_guard.py` (the version that passed the probe table in finding 6):

```python
"""LiteLLM pre_call guardrail: every request must resolve to a ZDR-pinned deployment.

Refuses (HTTP 400):
- a model name that is not a model_list alias;
- an alias whose deployments lack extra_body.provider {zdr: true, data_collection: deny};
- client-sent routing fields, because a client `extra_body` replaces the configured one.
"""
from fastapi import HTTPException
from litellm.integrations.custom_guardrail import CustomGuardrail

CLIENT_ROUTING_FIELDS = ("extra_body", "provider", "models", "route")


class ZdrGuard(CustomGuardrail):
    async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):
        from litellm.proxy.proxy_server import llm_router

        sent = [f for f in CLIENT_ROUTING_FIELDS if f in data]
        if sent:
            raise HTTPException(status_code=400, detail=f"zdr_guard: client routing fields not allowed: {sent}")
        model = data.get("model")
        deployments = [d for d in (llm_router.model_list if llm_router else []) if d["model_name"] == model]
        if not deployments:
            raise HTTPException(status_code=400, detail=f"zdr_guard: unknown model alias {model!r}")
        for d in deployments:
            p = (d["litellm_params"].get("extra_body") or {}).get("provider") or {}
            if p.get("zdr") is not True or p.get("data_collection") != "deny":
                raise HTTPException(status_code=400, detail=f"zdr_guard: alias {model!r} is not ZDR-pinned")
        return data
```

Draft `infra/presidio-recognizers.yaml`:

```yaml
supported_languages:
  - en
global_regex_flags: 26
recognizers:
  - name: FiPersonalIdentityCodeRecognizer
    type: predefined
    supported_languages:
      - language: en
        context: [hetu, henkilötunnus, personbeteckning, personal identity code]
  - name: IbanRecognizer
    type: predefined
  - name: CreditCardRecognizer
    type: predefined
```

## Consequences

- **Phase-3 gate tests:**
  - (a) A hetu in a user message returns 400 `Blocked entity detected: FI_PERSONAL_IDENTITY_CODE`.
  - (b) A `leaky` alias in a test-only config, and an unknown model name, both return 400 from `zdr_guard`.
  - (c) The static check on `infra/litellm.yaml` from finding 6 passes.
  - (d) An image with a known printed word is sent through `zdr/strong` and `zdr/fast`, and the reply must contain the word. This covers the section-15 image risk on our exact routes.
- The Presidio guardrail does not scan assistant `tool_calls` arguments. The Pi-side leak scan must cover them.
- If the Presidio analyzer is down, every chat request fails with 500 (fail-closed). This is intended. The compose file needs a health-check dependency (`depends_on: condition: service_healthy`).
- `allow_fallbacks: false` with two EU-first endpoints means a double outage fails the request instead of leaving the region. `amazon-bedrock` for Sonnet 5.5 has no EU-only ZDR slug, so its fallback is the Bedrock global endpoint.
- `tool_choice` must stay `auto` or `none` on these routes.
- The pa-server stream parser must accept OpenRouter's usage chunk, which has one empty choice.
- pa-server STT calls send `response_format=json`, keep chunks under 60 s, and go to LiteLLM `/v1/audio/transcriptions` with `model: zdr/stt`.
- Version bumps follow section 14. `v1.105.3` becomes eligible on 2026-10-28.
- UNVERIFIED items: Finnish STT quality, `reasoning.effort: none` on Haiku 5.5, `provider[zdr]` in STT multipart, and a newer Presidio release on GitHub.

## Verified on

2026-10-25, by these methods:

- Querying the GitHub releases API, GHCR and MCR registry manifests (tag existence, digests, image `created` dates), and PyPI JSON.
- Reading LiteLLM source at tag `v1.105.1` (`raw.githubusercontent.com`) and Presidio source at tag `2.2.362`.
- Reading OpenRouter docs (`.md` pages from `https://openrouter.ai/docs/llms.txt`) and the public `/api/v1/models`, `/api/v1/models/<id>/endpoints`, `/api/v1/models?output_modalities=transcription` and `/api/v1/endpoints/zdr` APIs.
- Checking the GitHub issues API for #41600, #48029 and #46087.
- Running a local test in a scratch virtualenv outside the repo: `litellm[proxy]==1.105.1` against a mock OpenRouter server that logs request bodies, and `presidio-analyzer==2.2.362` with `en_core_web_sm` behind a minimal `/analyze` server.

No live OpenRouter call was made, because no key was available. Each UNVERIFIED item above names the live check that confirms it.
