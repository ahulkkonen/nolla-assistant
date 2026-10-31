# Phase 3 — Finnish PII pseudonymization, vault, ZDR egress

Gate (plan §13): `tests/pii` meets the §6 recall targets; a test proves an unmasked hetu is blocked
at LiteLLM; a test proves a non-ZDR model alias is refused; the leak scan reports zero on the test
corpus; masked-only invariant test (plan §14 gate 3) passes.

Gate command: `pnpm typecheck && pnpm lint && pnpm test && (cd services/pseudo-svc && pytest)`

Research notes: `0003-finnish-pii-stack.md` (detection stack, pins), `0004-litellm-openrouter-zdr.md`
(egress). Decisions that depend on them are filled in when they land.

## Sidecar API contract (`pseudo-svc`, internal network, no auth beyond the network)

All bodies are JSON. `user_id` is required on every call (invariant 6). `session_id` is the Pi chat id.
**All offsets are UTF-16 code units** (JavaScript string indexing). The Python side converts with
`len(s[:i].encode('utf-16-le')) // 2`.

| Method, path | Request | Response |
|---|---|---|
| `POST /mask` | `{ user_id, session_id, text }` or `{ user_id, session_id, json: <any JSON> }` | `{ masked: string \| json, spans: [{ start, end, entity_id, kind, surrogate, real_form, detector, score, pending: bool }] }`. Spans are offsets in **masked** text. Pending (low-confidence) spans are masked but also queued in the pending lane. |
| `POST /unmask` | `{ user_id, text }` or `{ user_id, json }` | `{ restored: string \| json, spans: [{ start, end, entity_id, surrogate_form }], unresolved: [{ start, end, form }], hold: int }`. Offsets in **restored** text. Longest-match-first over surrogate forms. `hold` = length of the longest suffix of the input text that is a proper prefix of some surrogate form of this user (0 when none); the bridge holds back that many characters of a streaming delta. For `json` input `hold` is 0. |
| `POST /scan` | `{ user_id, session_id, messages: [{ role, content }] }` | `{ messages, leaked: [{ message_index, start, end, kind, entity_id }] }`: every found real value is masked through the vault and reported. `content` is any JSON (the extension sends the whole Pi message); only string values change, so keys and numbers stay valid. |
| `GET /vault/entities?user_id=` | | `{ entities: [{ id, kind, canonical, surrogate, mode, pinned, allowlisted, seen_count, last_seen }], pending: [{ id, kind, text, detector, score, session_id }] }` |
| `POST /vault/merge` | `{ user_id, from_ids: [], into_id }` | `{ ok: true }` |
| `POST /vault/split` | `{ user_id, entity_id, span_ids: [] }` | `{ ok: true, new_entity_id }` |
| `POST /vault/entity/{id}` | `{ user_id, pinned?, allowlisted?, mode?, regenerate?: true, never_detect?: true }` | `{ entity }` |
| `POST /vault/seed` | `{ user_id, entities: [{ canonical, kind }] }` | `{ ok: true, ids: [] }`: creates entities (and surrogates) without a text; used by `tests/pii/harness.py` and the vault UI's manual add |
| `POST /vault/pending/{id}` | `{ user_id, action: 'confirm' \| 'dismiss' \| 'allowlist' }` | `{ ok: true }` |
| `GET /healthz` | | `{ ok: true }` |

The user's own name: the vault holds a `self` entity whose surrogate is the configured label
(default `[sinä]`); its forms are never restored as a third-party name.

### pseudo-svc security notes

- Surrogate seed: `HMAC-SHA256(secret, user_id + "\0" + canonical [+ generation, attempt])`. The secret
  is 32 random bytes made when the vault is created and kept in the `meta` table inside the encrypted
  vault. Without the vault, nobody can recompute which real value a surrogate stands for, and nobody
  can rebuild the mapping either: losing `vault.db` loses every mapping. `vault.db` is therefore backed
  up hourly by restic (see `docs/deploy.md`, "Backups").
- Phone surrogates stay in `048`. Traficom regulation 32 V/2025 M appendix 1 lists `047` and `048` as
  mobile area codes held in Traficom's number reserve, not assigned to any operator (0003 question 8).
  The regulation has no range for fiction. `010` is in use for nationwide corporate numbers, and
  `099 999 xxxx` falls in the Uusimaa area code `09`, so both could reach real subscribers. Re-check
  `048` when Traficom publishes a new regulation 32.
- Placeholders (`[henkilö 3]`) take N from a per-user counter in the vault; numbers are never reused,
  also after merges. Surrogate forms are unique per user; when a name pool has no free name, the pool
  widens (no gradation match, then no harmony match, then any class) and finally falls back to
  placeholder mode.
- Limits: `text` ≤ 200,000 characters (422); `json` ≤ 32 levels and ≤ 20,000 values, each string
  ≤ 200,000 characters (413); `messages`, seeded `entities`, `from_ids`, `span_ids` ≤ 500 (422).
  Validation errors return only `loc` and `msg`, never the input.
- `/healthz` returns 503 with `missing` when a layer named in `PSEUDO_REQUIRE_LAYERS` failed to load
  (the image requires `omorfi,voikko,ner`).
- Code surrogates (hetu 900–999, IBAN `9…`, phone `048`) are never masked again. A name or address
  made only of surrogate forms that this session already sent is not masked again either. The
  same name forms in another session are masked, because a real person can have the same name. Known gap:
  in one session, a new real name identical to a surrogate already sent there is not masked.
- Surrogate idempotency (2026-10-26). A surrogate that comes back (the model echoes it, a tool
  returns it) keeps its surrogate and never gets a second one, through every hook: `input`,
  `tool_result`, `/scan`. The check is in the sidecar, not in the extension, because only the
  vault knows which surrogates the user has, in which session, and in which inflected forms. The
  extension would need a second copy of that state. Two checks run in `mask_text`: (1) the exact
  surrogate forms of the session's entities (all cases, clitics, possessives) cover a candidate;
  (2) a new person whose every name part has a surrogate base form of the session (lemma match)
  is an echo, so lower-case echoes and inflections outside the form table also keep their
  surrogate. A subagent session `<chat>/sub/<id>` shares the spans of its chat, because its task
  comes from the chat. A lone first name or surname of a full name in the same text maps to that
  person (`Liisa Kallion … Liisalle`).
- Lower-case names (2026-10-26). Users type names in lower case on phones; "tiina heinon kanssa"
  reached the model unmasked because every name layer required a capital letter. Plain-text
  requests (`text`: user input, titles, memory, search queries) and `user` messages in `/scan` now
  also find lower-case names: a DVV first name followed by a surname that Voikko or Omorfi knows,
  a lone word that Voikko knows as a name and not as an ordinary word (`tiinalle`, `virtasen`), and
  the lower-case variants of the vault's real name forms. JSON requests (tool results) keep the
  capital-letter rule, because they carry code, paths and English. Tokens in a path, file name,
  address or identifier are skipped. Known gap: a lone lower-case word that Voikko knows only as a
  name is masked (`aino kerta`, "only once").

## Pi extension `pi-ext-pseudo` (plan §6 table)

| Hook | Action |
|---|---|
| `input` | `POST /mask` on `text`; return `{ action: 'transform', text: masked }`; `pi.appendEntry('pseudo-spans', { spans })` |
| `before_agent_start` | (phase 8: memory injection passes through `/mask`) |
| `tool_call` | `POST /unmask` with `json: event.input`; mutate `event.input` in place with `restored` |
| `tool_result` | `POST /mask` with `json: { content, structuredContent }`; return both fields masked (never only `content`) |
| `context_with_system` | `POST /scan` on new or changed messages, each as JSON; return the scanned messages; log every `leaked` item at `warn` with kind and entity id only. A failed scan aborts the turn (fail closed). |
| display (bridge) | `POST /unmask` per delta with a 24-character hold-back; attach `annotations` `{ start, end, entityId, modelSaw }` |

Known gaps (accepted for phase 3): images (user attachments and tool-result image blocks) are not
pseudonymized; the vault has no OCR.

Fail closed: if `pseudo-svc` is unreachable, `input` returns `{ action: 'handled' }` and the bridge
sends `error` code `pseudo_down`; `tool_call` blocks with reason `pseudo_down`. A failed `/scan`
aborts the turn: Pi ignores a throw from `context_with_system`, so the handler calls `ctx.abort()`
and returns only the system messages. No transcript goes to the model, the bridge sends `error` code
`pseudo_down`, and the next turn scans again (a bad result is never cached). Until 2026-10-26 the
scan failed open on the assumption that ingest masking always holds. The 2026-10-25 incident showed
it does not: a lower-case name passed `input`, and the scan was the only check left. In the same
incident the extension sent each message as a JSON string, the sidecar replaced `0107338` in
`"total":0.0107338` with a phone surrogate, and the broken JSON disabled the scan for the rest of the
chat. Messages now go as JSON, and the phone detector skips the tail of a decimal number.

## Task cards (filled as research lands)

| # | Task | Owner | Status |
|---|---|---|---|
| 1 | `packages/pi-ext-pseudo` + bridge restoration, tested against a fake sidecar | Opus | dispatched |
| 2 | `tests/pii` corpus: 300 Finnish sentences with labelled spans, synthetic names | Opus | dispatched |
| 3 | `services/pseudo-svc`: detectors, vault, surrogates, inflection, API | Opus (after 0003) | |
| 4 | `infra/litellm.yaml`, Presidio backstop, ZDR tests, compose services | Opus (after 0004) | done |
| 5 | Vault UI + highlights + "show what the model saw" | Opus, UI review | |
| 6 | Masked-only invariant test (plan §14 gate 3) | Sonnet | |

## Phase-3 egress decisions

Source: `0004-litellm-openrouter-zdr.md`. Files: `infra/litellm.yaml`, `infra/litellm/zdr_guard.py`,
`infra/litellm/presidio-recognizers.yaml`, `infra/compose.yaml`. Gate: `pnpm test:egress` (needs
Docker; not part of `pnpm test`).

**Pins** (all at least 7 days old on 2026-10-25):

| Service | Image | Published | mem_limit |
|---|---|---|---|
| `litellm` | `ghcr.io/berriai/litellm:v1.105.1@sha256:b7b9e2c306343721802253d0dd9436b9634a2eb4e14da7c7cf06c5c7b7530802` | 2026-10-14 | 768m (measured ~510 MB idle, ~590 MB after 10 requests; 512m hit the cgroup limit) |
| `presidio-analyzer` | `mcr.microsoft.com/presidio-analyzer:2.2.362@sha256:286e3fa7f3a7426e775e8564fe1870f1ba8f999d3ab8bbb8cc46a44355d9d6e9` | 2026-03-15 | 700m (~585 MB measured) |
| `presidio-anonymizer` | `mcr.microsoft.com/presidio-anonymizer:2.2.362@sha256:a10a12a2a613d13cf29d3ad3641e3258444dd8c90403dd644a0a114c472c2483` | 2026-03-15 | 100m (~45 MB measured) |

**Aliases** (`infra/litellm.yaml`; every entry has `extra_body.provider { zdr: true,
data_collection: deny, allow_fallbacks: false }`):

| Alias | Upstream model | Provider `order` | USD / 1M in / out |
|---|---|---|---|
| `zdr/strong` | `anthropic/claude-sonnet-5.5` | `google-vertex/europe`, `amazon-bedrock` | 2.2 / 11 |
| `zdr/fast` | `anthropic/claude-haiku-5.5`, `reasoning.effort: none` | `google-vertex/europe`, `amazon-bedrock/eu-west-1` | 0.11 / 0.55 |
| `zdr/task-small` | `anthropic/claude-haiku-5.5`, `reasoning.effort: none` | `google-vertex/europe`, `amazon-bedrock/eu-west-1` | 0.11 / 0.55 |
| `zdr/stt` | `openai/whisper-large-v3` via LiteLLM `openai/` provider (OpenRouter multipart) | not applied by OpenRouter for STT | 0.111 USD / audio hour (Groq) |
| `zdr/embed` | `qwen/qwen3-embedding-8b` (remote fallback; phase 4 decides) | `nebius`, `deepinfra` | 0.01 / – |

No `zdr/vision` alias: `zdr/strong` and `zdr/fast` both take images. No `drop_params`: LiteLLM
accepted Pi's request shape (`developer` role, `store`, `max_completion_tokens`,
`reasoning_effort`) against the mock; whether Vertex/Bedrock reject any of them is UNVERIFIED until
a live call.

**ZDR at three levels** (invariant 2):

| Level | Where enforced | How |
|---|---|---|
| Account | OpenRouter, https://openrouter.ai/settings/privacy | ZDR toggle on for all five model groups (Anthropic, OpenAI, Google, SpaceXAI, other). Manual, once. |
| Key | OpenRouter guardrail assigned to the LiteLLM key | `enforce_zdr_anthropic/openai/google/xai/other: true` plus a model allowlist of the five upstream ids. Manual, once. |
| Request | LiteLLM `infra/litellm.yaml` + `zdr_guard.ZdrGuard` | Every alias sends `provider.zdr: true`, `data_collection: deny`. The guard refuses (400) any model without the `zdr/` prefix, any alias not ZDR-pinned in the config, and any client `extra_body`/`provider`/`models`/`route`/`transforms` (a client `extra_body` would replace the configured one). Runs on chat, embeddings and transcription. For STT, OpenRouter does not document reading `provider[...]` multipart fields, so STT relies on the first two levels. |

**Presidio backstop:** one `pre_call` guardrail, BLOCK only for `FI_PERSONAL_IDENTITY_CODE`,
`IBAN_CODE`, `CREDIT_CARD`; nothing else is analyzed (PERSON off); fails closed when the analyzer
is down. The analyzer loads `FiPersonalIdentityCodeRecognizer` for `en` from the mounted registry,
so no Finnish spaCy model is needed. Presidio validates the hetu check character: `010190-923A` is
not a hetu (the correct check character is `E`) and passes; the gate test uses `010190-923E`.
Known gap: hetu inside assistant `tool_calls` arguments is not scanned (the Pi leak scan covers it).
No `logging_only` guardrail (no log sink exists; it would also hide leaks from the §14 log grep).

## Status 2026-10-25

Gate results (Docker, all layers on: Omorfi, Voikko, spaCy NER; `tests/pii/harness.py`):

| Group | Recall | Threshold |
|---|---|---|
| codes (HETU, IBAN, PHONE, EMAIL) | 100 % | ≥ 99 % |
| vault-known names | 100 % (98.5 % with an empty nickname table) | ≥ 95 % |
| unseen names | 100 % (96.6 % with an empty nickname table) | ≥ 85 % |
| PERSON precision | 98.2 % | ≥ 90 % |

Hetu blocked at LiteLLM, non-ZDR alias refused, image parts intact, ZDR flags on every call:
`tests/egress` (11 tests, Docker). Masked-only invariant: `tests/masked-only` (10 turns with tool
calls; session JSONL, model requests, logs, app.db clean). Leak scan on the corpus: zero (`/scan`
over corpus texts after masking; covered by `test_mask.py`).

Open items carried forward:

- `/mask` latency is 21 ms median for known people but 200–400 ms when a message brings 10+ new
  people (Omorfi generation in pure-Python `pyhfst`). Measured on an M4 Pro, not the CX33. Fix
  candidates: precompute the surrogate pool's forms at image build, or the `hfst` C bindings.
- Remove `PSEUDO_VAULT_KEY` from `pa-server`'s environment in `infra/compose.yaml` (least privilege;
  only `pseudo-svc` needs it).
- Nickname table was written after seeing corpus misses; the numbers without it are the honest ones.
- Lone place-like surnames (`Saari`, `Niemi`) remain possible false positives; they land in the vault
  and can be marked never-detect.
- Phase-4 and 8 follow-ups: titles and memory injection pass through `/mask`.
