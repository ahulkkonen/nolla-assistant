# Phase 3 — Finnish PII pseudonymization, vault, ZDR egress

Gate (plan §13): `tests/pii` meets the §6 recall targets; a test proves an unmasked hetu is blocked
at LiteLLM; a test proves a non-ZDR model alias is refused; the leak scan reports zero on the test
corpus; masked-only invariant test (plan §14 gate 3) passes.

Gate command: `pnpm typecheck && pnpm lint && pnpm test && (cd services/pseudo-svc && pytest)`

Research notes: `0003-finnish-pii-stack.md` (detection stack, pins), `0004-litellm-openrouter-zdr.md`
(egress). Decisions that depend on them are filled in when they land.

## Sidecar API contract (`pseudo-svc`, internal network, no auth beyond the network)

All bodies are JSON. `user_id` is required on every call (invariant 6). `session_id` is the Pi chat id.

| Method, path | Request | Response |
|---|---|---|
| `POST /mask` | `{ user_id, session_id, text }` or `{ user_id, session_id, json: <any JSON> }` | `{ masked: string \| json, spans: [{ start, end, entity_id, kind, surrogate, real_form, detector, score, pending: bool }] }`. Spans are offsets in **masked** text. Pending (low-confidence) spans are masked but also queued in the pending lane. |
| `POST /unmask` | `{ user_id, text }` or `{ user_id, json }` | `{ restored: string \| json, spans: [{ start, end, entity_id, surrogate_form }], unresolved: [{ start, end, form }] }`. Offsets in **restored** text. Longest-match-first over surrogate forms. |
| `POST /scan` | `{ user_id, session_id, messages: [{ role, content }] }` | `{ messages, leaked: [{ message_index, start, end, kind, entity_id }] }`: every found real value is masked through the vault and reported. |
| `GET /vault/entities?user_id=` | | `{ entities: [{ id, kind, canonical, surrogate, mode, pinned, allowlisted, seen_count, last_seen }], pending: [{ id, kind, text, detector, score, session_id }] }` |
| `POST /vault/merge` | `{ user_id, from_ids: [], into_id }` | `{ ok: true }` |
| `POST /vault/split` | `{ user_id, entity_id, span_ids: [] }` | `{ ok: true, new_entity_id }` |
| `POST /vault/entity/{id}` | `{ user_id, pinned?, allowlisted?, mode?, regenerate?: true, never_detect?: true }` | `{ entity }` |
| `POST /vault/pending/{id}` | `{ user_id, action: 'confirm' \| 'dismiss' \| 'allowlist' }` | `{ ok: true }` |
| `GET /healthz` | | `{ ok: true }` |

The user's own name: the vault holds a `self` entity whose surrogate is the configured label
(default `[sinä]`); its forms are never restored as a third-party name.

## Pi extension `pi-ext-pseudo` (plan §6 table)

| Hook | Action |
|---|---|
| `input` | `POST /mask` on `text`; return `{ action: 'transform', text: masked }`; `pi.appendEntry('pseudo-spans', { spans })` |
| `before_agent_start` | (phase 8: memory injection passes through `/mask`) |
| `tool_call` | `POST /unmask` with `json: event.input`; mutate `event.input` in place with `restored` |
| `tool_result` | `POST /mask` with `json: { content, structuredContent }`; return both fields masked (never only `content`) |
| `context_with_system` | `POST /scan` on all messages; return the scanned messages; log every `leaked` item at `warn` with kind and entity id only |
| display (bridge) | `POST /unmask` per delta with a 24-character hold-back; attach `annotations` `{ start, end, entityId, modelSaw }` |

Fail closed: if `pseudo-svc` is unreachable, `input` returns `{ action: 'handled' }` and the bridge
sends `error` code `pseudo_down`; `tool_call` blocks with reason `pseudo_down`.

## Task cards (filled as research lands)

| # | Task | Owner | Status |
|---|---|---|---|
| 1 | `packages/pi-ext-pseudo` + bridge restoration, tested against a fake sidecar | Opus | dispatched |
| 2 | `tests/pii` corpus: 300 Finnish sentences with labelled spans, synthetic names | Opus | dispatched |
| 3 | `services/pseudo-svc`: detectors, vault, surrogates, inflection, API | Opus (after 0003) | |
| 4 | `infra/litellm.yaml`, Presidio backstop, ZDR tests, compose services | Opus (after 0004) | |
| 5 | Vault UI + highlights + "show what the model saw" | Opus, UI review | |
| 6 | Masked-only invariant test (plan §14 gate 3) | Sonnet | |
