# Personal Assistant 2.0 — Build Plan for Claude Code

Oct 25, 2026 · @Aleksi

## 1. Purpose and operating model

Build a single-user, self-hosted personal assistant: Pi 1.x is the agent runtime, a custom PWA is the interface, and all model traffic leaves the box pseudonymized and routed to OpenRouter with zero data retention. Nothing off the shelf fits, so this is a thin custom build on a Hetzner CX33 (4 vCPU, 8 GB) under Coolify.

**How Claude Code runs this plan**

- **Orchestrator (Fable):** holds this whole document, owns the task graph, assigns work, enforces the quality gates in section 14, and merges. Fable never writes feature code itself beyond scaffolding and glue.
- **Implementers (Opus 5.5 for architecture-bearing work, Sonnet for well-specified leaf tasks):** each task is one PR against one phase milestone. A task card states: inputs, files touched, acceptance test, and which section of this plan it serves.
- **Code reviewer (Opus 5.5):** every PR gets one review pass before merge. The reviewer checks the acceptance test, the invariants in section 2, and security (secrets, egress, masked-only sessions). A failed review goes back to the implementer, not to Fable.
- **UI reviewer (Opus 5.5, separate role):** every PR touching `apps/web` gets a second review against section 11 before merge. The UI reviewer renders the screens (Playwright screenshots at 390 px, 1024 px and 1440 px, light and dark) and rejects anything that fails the checklist. The goal is to land UI right the first time rather than iterate in production.
- **Spikes before commitments:** any task marked *verify* in section 15 starts with a 30-minute spike whose output is a note in `docs/decisions/`, then the task proceeds or the plan is amended.

**Scope now:** chat with artifacts, attachments and voice input; Finnish PII pseudonymization; memory; topics and search; personal agents and subagents; calendar and drive via MCP; backups. **Out of scope now:** TTS, multi-user, OpenShell, mobile native apps.

## 2. Decisions locked before coding

These are invariants. A PR that violates one is rejected regardless of what it adds.

1. **Masked-only sessions.** Pi's session (JSONL, context, compaction, titles, subagents) only ever contains pseudonymized text. Real values exist in the vault, in memory files on disk, in tool arguments at execution time, and on the user's screen. Nowhere else.
2. **One egress URL.** Every model call from every process (Pi host, subagent children, title generator, embeddings when remote) goes to the LiteLLM proxy. Only LiteLLM holds the OpenRouter keys. ZDR is the default. A guardrailed API key, `provider.zdr` on every `zdr/` request and the LiteLLM guard enforce it. A chat can opt out after a ZDR refusal (decision phase-10). An opted-out chat uses a separate key and stays pseudonymized. (amended 2026-10-26, phase 10)
3. **Own client protocol.** The browser talks to `pa-server` over a typed WebSocket protocol defined in `packages/protocol` with zod schemas. Raw Pi RPC or SDK events never reach the browser.
4. **Pinned Pi.** Exact `@earendil-works/pi-coding-agent` 1.x version in `package.json`, no ranges. `tests/contract/` runs against the pinned version and must pass before any version bump. Hook payload field names are taken from `extensions/types.ts` of that version, not from memory.
5. **TypeScript everywhere Pi touches.** Server, PWA, protocol, Pi extensions: TypeScript on Node 22.19+. Python only inside `pseudo-svc` (Presidio, spaCy, Voikko, Omorfi). No other languages.
6. **`user_id` on every row** from day one, and per-user Pi directories (`PI_CODING_AGENT_DIR`). Single user now; multi-user is a schema no-op later.
7. **Skills only from this repo.** No public skill marketplaces, no `pi install` from npm or git at runtime. Every skill and extension is vendored under `skills/` and `packages/pi-ext-*` and reviewed like code.
8. **No Docker socket in app containers.** Sandboxing is plain Docker now: non-root, read-only root filesystem where possible, egress allowlist. Risky CLI skills run in throwaway sibling containers started by a small broker, not by Pi directly.
9. **Local-first data.** SQLite in WAL mode, Pi JSONL sessions, markdown memory files, all under one `/data` volume. Litestream replicates SQLite continuously; restic snapshots `/data` nightly to S3-compatible storage. A restore drill is part of phase 4's done criteria.
10. **Minimal UI.** Every element on screen must answer "what does the user do with this". Section 11 is the spec; the UI reviewer enforces it.

## 3. Architecture and repository layout

Eight containers on one Coolify Compose stack. `pa-server` is the only public service; everything else lives on the internal Docker network.

&#91;embedded content: runtime architecture · 8 services on one Compose stack\]

The PWA never talks to Pi directly, Pi never talks to OpenRouter directly, and only `pseudo-svc` and the bridge ever hold real values alongside their surrogates.

**Monorepo (pnpm workspaces, Node 22.19+)**

```
apps/
  web/            React + Vite + assistant-ui PWA (section 11)
  server/         Pi host, auth, WebSocket bridge, push, API (section 5)
packages/
  protocol/       zod schemas for every client↔server message; shared types
  pi-ext-pseudo/  Pi extension: mask at ingest, unmask at tool_call, leak scan
  pi-ext-memory/  Pi extension: USER.md/MEMORY.md injection, memory + recall tools
  pi-ext-topics/  Pi extension: agent_settled → title/topic job
  pi-ext-notify/  Pi extension: agent_settled / approval → Web Push
  pi-ext-subagents/ Pi extension: spawn child pi processes with same config
  db/             SQLite schema, migrations (drizzle), FTS5 + sqlite-vec setup
services/
  pseudo-svc/     Python FastAPI: /mask /unmask /scan, vault, detectors
  sandbox-broker/ tiny Node service that runs skill commands in sibling containers
skills/           your SKILL.md files and CLI tools (vendored, reviewed)
agents/           personal agent profiles (YAML: prompt, skills, tools, model)
infra/
  compose.yaml    Coolify stack
  litellm.yaml    model aliases, ZDR flags, Presidio backstop
  Dockerfile.*    one per service
tests/
  contract/       Pi hook and RPC contract tests against the pinned version
  pii/            Finnish test set and recall/precision harness
  e2e/            Playwright flows + UI screenshot baselines
docs/decisions/   ADRs, one file per locked or verified decision
```

**Data flow for one user turn**

1. PWA sends `user.message` (text, attachments) over WebSocket.
2. `pa-server` passes it to the Pi session; `pi-ext-pseudo` masks it at `input`, records spans.
3. Pi builds context (masked memory, masked history) and calls the model via LiteLLM, which adds ZDR flags and runs the backstop.
4. Tool calls are unmasked at `tool_call`; tool results are masked at `tool_result`.
5. `pa-server` streams `message_update` events to the PWA, restoring surrogates to originals and attaching span annotations.
6. On `agent_settled`, the topics extension titles and tags the chat and the notify extension pushes if the tab is in the background.

## 4. Infrastructure

One Hetzner CX33 in Helsinki (4 shared vCPU, 8 GB, 80 GB NVMe, about €9/month as of 23 Oct 2026) runs Coolify and the whole stack. Add a 50–100 GB volume for `/data` when attachments grow, and one S3-compatible bucket for backups.

**Compose services (`infra/compose.yaml`)**

| Service | Image | Exposed | Memory budget | Notes |
| --- | --- | --- | --- | --- |
| `pa-server` | `Dockerfile.server` (serves the built PWA too) | Yes, via Coolify proxy with TLS | \~400 MB | Non-root, read-only rootfs, `/data` volume, no Docker socket |
| `pseudo-svc` | `Dockerfile.pseudo` (Python 3.12, Presidio, spaCy `fi_core_news_lg`, libvoikko, Omorfi) | No | \~1.5 GB | Models baked into the image; `/data/vault.db` mounted |
| `litellm` | `ghcr.io/berriai/litellm` pinned | No | \~500 MB | Holds `OPENROUTER_API_KEY`; config from `infra/litellm.yaml` |
| `presidio-analyzer` + `presidio-anonymizer` | pinned Presidio images | No | \~800 MB | Backstop only; `fi` + `en` models |
| `mcp-workspace` | `taylorwilsdon/google_workspace_mcp` pinned | No | \~200 MB | Streamable HTTP, single-user OAuth mode |
| `mcp-files` | `cbcoutinho/nextcloud-mcp-server` or `Softeria/ms-365-mcp-server` | No | \~200 MB | Only the one you use |
| `sandbox-broker` | `Dockerfile.broker` | No | \~100 MB | The one container with the Docker socket; runs skill commands in throwaway `skill-runner` containers with no network by default |
| `backup` | `litestream/litestream` + restic sidecar | No | \~100 MB | Litestream replicates every SQLite file; restic snapshots `/data` nightly |

Total steady state is about 4 GB, leaving headroom for Pi subagent processes and Node build steps.

**Network:** one internal Docker network. Only `pa-server` is attached to Coolify's proxy network. Outbound traffic from `pa-server` is limited by iptables rules in the broker-managed sandbox and by the LiteLLM allowlist; the `skill-runner` containers get `network: none` unless the skill declares an allowlist.

**Secrets (Coolify environment, never in the repo):** `OPENROUTER_API_KEY` (LiteLLM only), `LITELLM_MASTER_KEY` (pa-server and subagents), `PSEUDO_VAULT_KEY` (encrypts surrogate↔real mapping at rest), `GOOGLE_OAUTH_CLIENT_*`, `VAPID_PUBLIC/PRIVATE`, `RESTIC_PASSWORD`, `S3_*`, `AUTH_PASSKEY_RP_ID`. Pi receives only the LiteLLM key and a base URL.

**Backups:** Litestream to the bucket with 24-hour retention of WAL segments; restic nightly at 03:00 Europe/Helsinki with `keep-daily 14, keep-weekly 8, keep-monthly 6`. `scripts/restore.sh` rebuilds `/data` from the bucket on a fresh VPS; running it successfully is a done criterion in phase 4.

**Deploy flow:** push to `main` → Coolify builds from the repo's Dockerfiles → health checks on `/healthz` for every service → rolling restart of `pa-server`. Pi sessions survive restarts because state is in `/data`, not in process memory.

## 5. Pi host service and the client↔server protocol

`pa-server` runs Pi in-process through the SDK (`createAgentSession`), one session object per open chat, and exposes a typed WebSocket protocol. RPC mode is reserved for subagent children.

**Pi host (`apps/server/src/pi/`)**

- `SessionRegistry`: maps chat id → `AgentSession`; lazy-loads from `/data/sessions/<user>/<chat>.jsonl`; evicts idle sessions after 30 minutes (state is on disk, so eviction is safe).
- `createAgentSession` options: `DefaultResourceLoader` pointed at `skills/` and the per-agent profile; `extensionFactories` = pseudo, memory, topics, notify, subagents, plus `createMcpExtension()` (MCP is not loaded by default in SDK sessions). Call `session.bindExtensions()` after construction.
- Provider config: a custom OpenAI-compatible provider in `models.json` named `zdr` with `baseUrl = LITELLM_URL`. Every agent profile and every subagent uses model ids of the form `zdr/<alias>`. No other provider is configured, so there is no path around the proxy.
- Wildcard deployments (amended 2026-10-26, phase 10): LiteLLM has two wildcard deployments, `zdr/*` and `open/*`. Both map to `openrouter/*`. The model name carries the data policy: `zdr/<openrouter id>` or `open/<openrouter id>`. The `zdr/*` deployment uses the ZDR key (`OPENROUTER_API_KEY`) and sets `provider: { zdr: true, data_collection: "deny" }`. The `open/*` deployment uses the open key (`OPENROUTER_OPEN_API_KEY`) and sets only `data_collection: "deny"`. Only a chat that the user opted out of ZDR uses `open/*`. The fixed aliases keep their own deployments. `pa-server` reads the public OpenRouter model catalog (`GET /api/v1/models`, no key, no user data) at start and every 24 hours. It writes the catalog models into `models.json` for both providers. See `docs/decisions/phase-10-models.md`, decisions 1, 2, 3 and 8.
- ECB rate (amended 2026-10-26, phase 13): `pa-server` also calls the public ECB exchange-rate API (`data-api.ecb.europa.eu`) at start and every 6 hours to show costs in EUR, and this call carries no key and no user data. See `docs/decisions/phase-13-thread.md`, decision 16 and the Egress table.
- Events: subscribe once per session; forward `message_update`, `message_end`, `tool_execution_*`, `agent_settled`, approval requests (from `ctx.ui.confirm`) and errors to the bridge. `agent_settled`, not `agent_end`, is the signal that Pi will not continue on its own.
- Steering and queueing: the bridge maps `user.message` to `session.prompt()` when idle and to the steering queue when the agent is running; `user.stop` calls `session.abort()`.

**Protocol (`packages/protocol`)**

All messages are discriminated unions validated with zod on both sides. Client → server: `auth.login`, `chat.create`, `chat.open`, `chat.list`, `chat.archive`, `user.message` {text, attachments\[\], agentId}, `user.stop`, `approval.respond` {requestId, approve}, `vault.list/merge/split/pin/allowlist`, `memory.list/edit/approve`, `topic.list/accept/reject`, `search.query`, `push.subscribe`. Server → client: `chat.state`, `message.delta` {chatId, messageId, text, annotations\[\]}, `message.final`, `tool.start/update/end`, `approval.request` {requestId, tool, args, reason}, `artifact.upsert`, `chat.titled`, `error`.

`annotations[]` carries `{start, end, entityId, modelSaw}` ranges in the restored text; the PWA uses them for highlights. The bridge holds back the trailing 24 characters of each delta until the next delta or `message_end`, so a surrogate split across chunks is never rendered half-restored.

**Attachments:** images go to Pi as native `images` on the prompt (resized to ≤ 1.5 MP server-side). Documents (PDF, DOCX, TXT, CSV) are text-extracted in `pa-server` and attached as masked text blocks; the original file is stored under `/data/files/<chat>/` for the artifact viewer.

**Auth:** passkey (WebAuthn) with a password fallback, session cookie `SameSite=Strict`, 30-day rolling expiry. The auth module exposes `getUser(req)` and nothing else depends on how it works, so OIDC can replace it later.

**Push:** VAPID Web Push. Triggered on `agent_settled` and on `approval.request` when no client has the chat focused. Payload is the chat title only, never message content.

**Subagent children** are spawned with `pi --mode rpc -e <same extensions>` and the same `PSEUDO_URL`, `LITELLM_URL` and `/data` paths, so masking and routing are identical. Their stdout is parsed as strict LF-delimited JSONL (split on `\n` only).

## 6. Finnish PII pseudonymization

Mask once at ingest, inside Pi, backed by a stateful vault; restore only for tools and for display. The LiteLLM Presidio guardrail is a stateless backstop, never the system of record, because its placeholder counter resets per request and it has open restore bugs (#41600, #48029, #46087).

**Where each operation lives (Pi 1.x hooks)**

| Boundary | Hook | Action |
| --- | --- | --- |
| User text in | `input` (chained) | `mask(text)` → masked text + spans; `pi.appendEntry({type:'pseudo-spans'})` persists spans outside context |
| Memory and system additions | `before_agent_start` | Inject USER.md/MEMORY.md already passed through `mask()` |
| Tool output in | `tool_result` (chained) | Mask `content` and `structuredContent` (replacing only `content` drops the structured part) |
| Tool arguments out | `tool_call` (mutable, blockable) | `unmaskDeep(input)`; also the approval gate |
| Last-chance scan | `context_with_system` | Detector over the whole outgoing transcript; anything found is masked through the vault and logged as a leak alert |
| Display | bridge, on `message_update`/`message_end` | Restore surrogates → originals with span annotations |
| Network backstop | LiteLLM Presidio `pre_call` | BLOCK on `FI_PERSONAL_IDENTITY_CODE`, IBAN, credit card; `logging_only` for the rest; PERSON disabled (realistic surrogates would trip it) |

Two documented Pi gaps make ingest masking mandatory rather than optional: `before_provider_request` does not fire for compaction and branch-summary requests (issue #10653), and later handlers can change the payload after ours (#10355). With masked-only sessions, neither matters.

**Detection stack (`services/pseudo-svc`)**, run in this order; first match wins per span:

1. **Deterministic with checksum:** hetu (`DDMMYY` + separator `+ - Y X W V U A B C D E F` + `NNN` 002–999 + mod-31 check character; the 900–999 range is temporary codes), FI IBAN (mod-97), FI phone (`+358`/`0` prefixes), 5-digit postcode next to a capitalised locality, street `<Name>(katu|tie|kuja|polku|väylä|kaari|rinne|raitti|ranta|tori|aukio) <number>` including inflected forms (`-kadulla`, `-tiellä`), plates `[A-ZÅÄÖ]{2,3}-\d{1,3}` only with context words.
2. **Vault recognizer:** every known entity compiled into an inflection-aware matcher over all stored surface forms. Highest precision and recall for people already met.
3. **DVV gazetteers:** first names and surnames from the Digi- ja väestötietovirasto open data (CC BY 4.0, release 2026-08-04) with occurrence counts as priors; lookups on Voikko lemmas so `Virtaselle` → `Virtanen`. A capitalised common noun (`Koski`, `Mäki`) counts as a name only with context: adjacent first name, title, or verb agreement.
4. **NER:** Presidio with spaCy `fi_core_news_lg` 3.7 as the NLP engine (CC BY-SA 4.0). Add the TurkuNLP FinBERT NER as a second recognizer only if the test set shows recall below target.
5. **Optional recall booster:** a GLiNER PII model with a high threshold, proposing candidates to the pending lane only. Finnish F1 for GLiNER models is about 0.37–0.47, so it never decides on its own.

Expected ceiling: no published Finnish benchmark covers this pipeline. The phase-3 done criterion is measured on `tests/pii/` (200–500 sentences drawn from your own writing with synthetic names): ≥ 99% recall on codes, ≥ 95% on vault-known names, ≥ 85% on unseen names, and every miss visible in the UI as unmasked text.

**Surrogates**

- People: realistic Finnish names by default, sampled from the DVV lists weighted by frequency, constrained to the same inflection class and vowel harmony as the real name (`-nen` ↔ `-nen`, back vowel ↔ back vowel, no consonant gradation unless the real name grades the same way). The user is always `[sinä]` / your configured label, so the model knows who the user is.
- Codes: format-shaped fakes. Hetu surrogates are checksum-valid codes in the 900–999 individual-number range so they can never collide with a real permanent code. IBAN surrogates are valid mod-97 with a fake bank code. Phone surrogates use a reserved range.
- Addresses: a real-looking street of the same suffix class plus a fake number; postcode kept at district level only if allowlisted, otherwise replaced.
- Per-entity override: placeholder mode (`[henkilö 3]`) or allowlist (send as-is), set in the vault UI.

**Restoration** is a lookup, not NLP. For each person, precompute both paradigms (15 cases × singular/plural plus possessive and clitic forms) with Omorfi's HFST generator and store them in `entity_form`; fall back to suffix rules for names Omorfi does not know. The bridge and `tool_call` do longest-match-first replacement over the surrogate forms. A surrogate form that is not in the table stays visible and is highlighted as "unrestored surrogate" rather than guessed.

**Vault schema (`/data/vault.db`, SQLite, encrypted at rest with `PSEUDO_VAULT_KEY`)**

```sql
CREATE TABLE entity (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL,
  canonical TEXT NOT NULL, surrogate TEXT NOT NULL,
  surrogate_mode TEXT CHECK(surrogate_mode IN ('realistic','placeholder')),
  infl_class TEXT, pinned INTEGER DEFAULT 0, allowlisted INTEGER DEFAULT 0,
  created_at TEXT, updated_at TEXT);
CREATE TABLE entity_form (entity_id INTEGER REFERENCES entity(id) ON DELETE CASCADE,
  side TEXT CHECK(side IN ('real','surrogate')), form TEXT NOT NULL, analysis TEXT, part TEXT,
  PRIMARY KEY(side, form));            -- a surrogate form can never map to two real values
CREATE TABLE alias (entity_id INTEGER REFERENCES entity(id), alias TEXT, kind TEXT);
CREATE TABLE span (session_id TEXT, entry_id TEXT, start INTEGER, end INTEGER,
  entity_id INTEGER REFERENCES entity(id), surrogate_form TEXT, detector TEXT, score REAL);
CREATE TABLE merge_log (from_id INTEGER, into_id INTEGER, at TEXT);
```

Merge repoints `span` and `entity_form` rows and writes `merge_log`; split creates a new entity and reassigns selected spans; regenerate-surrogate affects future turns only (old forms stay in `entity_form` history so past transcripts still render).

**Sidecar API (`pseudo-svc`, FastAPI on the internal network):** `POST /mask` {text|json, session\_id} → {masked, spans}; `POST /unmask` {text|json} → {restored, unresolved\[\]}; `POST /scan` {messages\[\]} → {messages, leaked\[\]}; `GET/POST /vault/...` for the management UI. Latency budget: ≤ 150 ms for a 1,000-character message on the CX33.

**UI (section 11 covers layout):** originals rendered in place with a subtle highlight and a tooltip "model saw: Laaksoselle"; a global toggle "show what the model saw"; the vault manager with merge, split, pin, regenerate, allowlist, never-detect; a pending lane for low-confidence detections (masked by default until confirmed or allowlisted).

**Known limits to state in the UI:** recall is not 100%; the leak scan and highlights exist so misses are visible. Nicknames are manual aliases. Two vault people sharing a first name get distinct surrogate first names, and first-name-only mentions resolve to the most recent referent in the session, flagged when ambiguous.

## 7. Memory

A bounded, user-reviewable profile injected every session, plus on-demand hybrid recall. No per-turn extraction service, no graph database: Mem0, Graphiti/Zep and Letta are skipped for a single user.

**Always injected** (`before_agent_start`, through `mask()`):

- `USER.md` ≤ 1,500 characters: who you are, preferences, standing instructions.
- `MEMORY.md` ≤ 2,500 characters: durable facts the agent has learned and you have kept.
- One line of recent context: titles of the last three chats.

Total about 1.3K tokens, byte-stable between turns so prompt caching holds.

**On demand:** a `recall(query, since?, topic?)` tool. Hybrid search = FTS5 BM25 + sqlite-vec cosine, fused with reciprocal rank fusion, over per-session summaries (written at `agent_settled`) and transcript chunks of about 400 tokens. Returns ≤ 5 snippets with chat ids and dates. The query arrives with surrogates; `tool_call` unmasks it before hitting the real-text index; results are masked again at `tool_result`. Embeddings are computed locally on CPU with a multilingual model that handles Finnish (multilingual-e5-small class; verify on your data in phase 8). Nothing from recall is auto-injected per turn.

**Writes:** a `memory(action: add|replace|remove, target: user|memory, text)` tool with hard caps; an over-cap write returns an error that tells the agent to consolidate first. Rules:

- Writes based on your own messages apply immediately and show as a diff chip in the chat.
- If the current turn contains untrusted tool output (web fetch, email, files from others, MCP results), the turn is marked tainted and any `memory` call is parked in a pending queue. `tool_call` blocks `memory` during a tainted turn unless the user has approved that specific write.
- Memory files are git-tracked under `/data/memory/<user>/` with real values; they are local and you edit them by hand. Masking happens at injection, so vault merges never corrupt memory.

**Review:** a weekly `consolidate` job (cheap ZDR model over the masked files) proposes a diff to USER.md/MEMORY.md; you accept, edit or reject it in the memory screen. Session summaries are also written here: 3–5 sentences per chat at `agent_settled`, masked, embedded, indexed.

**Reuse from the Pi catalog (vendored, not installed at runtime):** `@josephakern/pi-memory` for the capped injection pattern, `pi-memory-stone` for the FTS5-over-JSONL indexer. Do not use `@vtstech/pi-long-term-memory` as-is: it injects in `before_provider_request`, which bypasses ingest masking.

## 8. Chat titles, topics, tags, search, related chats

Titles and topics come from a cheap, non-reasoning model over the already-masked transcript, triggered from `agent_settled`; folders are topics you own.

**Trigger (`pi-ext-topics`):** after the first settled exchange when the chat has no title; again when more than \~3K tokens have been added since the last run and the new summary's embedding drifts from the title's; never when the title is user-locked.

**Call:** nested `streamSimple` to the LiteLLM alias `zdr/task-small` (a small non-reasoning model, ZDR). Input: last \~2K tokens of masked transcript plus your topic list `{id, name, one-line description}`. Prompt returns only JSON:

```
{"title": str, "topics": [topic_id], "proposed_topic": {"name": str, "why": str} | null, "summary": str}
```

Rules in the prompt: title 3–6 words in the conversation's language (usually Finnish), no emoji, no personal names; topics 0–3 ids from the list only; `proposed_topic` only when nothing fits and the chat is substantial; `summary` 3–5 sentences for the recall index.

**Post-processing:** validate against the zod schema; store the masked title and the restored title (titles may contain the user's own name only); write topics and tags; put `proposed_topic` into the topic inbox (accept, rename, merge into existing). Related chats: sqlite-vec kNN over session summaries, top 3 above a similarity threshold, no model call.

**Organization model:** Topic (exactly one or none) → Chat; Tags (many, free text, user-editable); Agent (which profile ran the chat); Archived flag. Pinned chats stay at the top of the sidebar. Full-text search (FTS5) spans titles, summaries and transcripts; results show the matching snippet with highlights and open at the matching message.

## 9. Personal agents, subagents, skills, automations

An agent is a profile, not a process: a YAML file in `agents/` that sets the system prompt, model alias, skills, allowed tools, and approval policy. The user picks the agent per chat; "Assistant" is the default.

**Agent profile (`agents/<id>.yaml`)**

```yaml
id: research
name: Tutkija
model: zdr/strong          # LiteLLM alias
prompt: prompts/research.md
skills: [web-digest, cite]  # from skills/
tools:
  allow: [read, write, bash, web_fetch, recall, memory]
  mcp: [workspace]          # MCP servers this agent may see
approval:
  always: [calendar.create_event, mail.send, bash]
  never:  [read, recall]
subagents: true
```

**Subagents (`pi-ext-subagents`):** adapted from Pi's official `subagent/` example. Modes: single, parallel (cap 4 concurrent, 8 queued), chain. Each child is a separate `pi --mode rpc` process with the same extensions, `PSEUDO_URL`, `LITELLM_URL` and `/data` paths, and its own JSONL under the parent's chat folder. The parent sees child progress as tool updates; the PWA shows a compact "3 subagents running" row that expands to live status. Child tool approvals bubble to the parent's chat.

**Skills (`skills/<name>/SKILL.md` + optional `bin/`):** Agent Skills format, loaded by `DefaultResourceLoader`. Any skill with executables declares `sandbox: {network: none | allowlist[], mounts: [...]}`; `sandbox-broker` runs the command in a throwaway `skill-runner` container with that policy and streams stdout back. Skills are reviewed like code; no runtime install from registries.

**Automations:** `automations/<name>.yaml` with a cron expression, an agent id, a prompt, and a delivery target (chat thread, push notification, or both). `pa-server` runs them with `node-cron`; each run is a normal chat under the "Automations" topic, so it is masked, titled and searchable like any other. Failures push a notification.

**Approval policy:** `tool_call` consults the agent's policy; anything in `always` sends `approval.request` to the PWA and blocks until answered or 10 minutes pass (then it is denied and the agent is told why). Approvals show the real, unmasked arguments to the user, since the user is the one person allowed to see them.

## 10. Integrations via MCP

Calendar and drive access comes from self-hosted MCP servers over streamable HTTP, registered through Pi's `createMcpExtension()`, with results masked at `tool_result` and arguments unmasked at `tool_call`.

| Need | Server (pinned) | Auth | Notes |
| --- | --- | --- | --- |
| Google Calendar, Drive, Gmail | `taylorwilsdon/google_workspace_mcp` v2.x (MIT) | OAuth 2.1, single-user mode | \~119 tools; expose only calendar, drive, gmail-read by default |
| Nextcloud Calendar/Contacts/Files (CalDAV) | `cbcoutinho/nextcloud-mcp-server` (AGPL-3.0) | App password or Login Flow v2 | Use only if you run Nextcloud; releases near-daily, pin carefully |
| Microsoft 365 / OneDrive | `Softeria/ms-365-mcp-server` | Device code or OAuth | Verify licence before use |
| Generic CalDAV | `gelse/caldav-mcp` | Basic auth | Lighter alternative for iCloud, Radicale, Baikal |

**Tool exposure:** each agent profile lists which MCP servers it sees; within a server, a tool allowlist in `infra/mcp.yaml` trims the surface (for example `calendar.list_events`, `calendar.create_event`, `drive.search`, `drive.read_file`). Writes (`create_event`, `send_mail`, `upload`) are in every agent's `approval.always` by default.

**OAuth flow:** the MCP container handles Google's consent flow; `pa-server` proxies the redirect so the only public origin is the PWA's. Tokens live in the MCP container's volume under `/data/mcp/<server>/`, included in backups and encrypted at rest.

**Masking note:** calendar and mail results are the main source of third-party names entering the session, so `tool_result` masking is on the critical path; the phase-6 done criterion includes a test that a fetched event with a new attendee name produces a new vault entity and a masked session.

## 11. PWA and UI specification

The UI mirrors the 2026 ChatGPT and Claude apps: a collapsible left sidebar of chats, a centered conversation column, a composer pinned to the bottom, and a right panel that appears only for artifacts. Web and desktop are first-class from the start; mobile is the same layout with the sidebar as a drawer. Every element must answer "what does the user do with this"; if nothing, it is removed.

**Stack:** React 19, Vite, assistant-ui primitives for thread, composer, attachments and tool UIs; Tailwind with a small token file; Radix for menus and dialogs; Lucide icons at 16/20 px; `vite-plugin-pwa` for manifest, service worker, offline shell and Web Push. One font: Inter (fallback system-ui); monospace JetBrains Mono for code. Dark and light follow the system by default with a manual override. No marketing pages, no onboarding carousel.

**Design rules the UI reviewer enforces**

1. One accent colour, used only for primary actions and the active state. Everything else is neutral greys with 4.5:1 contrast minimum.
2. Icon-only buttons everywhere a label is not needed; every icon button has a tooltip and an `aria-label`. Labels appear on primary actions and destructive confirmations only.
3. Spacing on a 4 px grid; conversation column max width 768 px; type 15 px body, 13 px secondary, 1.5 line height.
4. No element that only decorates: no avatars for the assistant, no logos in the thread, no empty-state illustrations. An empty chat shows the composer and the agent picker, nothing else.
5. Streaming text renders progressively without layout shift; code blocks have copy and (for HTML/React) "open as artifact".
6. Keyboard: `Cmd/Ctrl+K` command palette (new chat, search, switch agent, open vault, open memory), `Cmd/Ctrl+Enter` send, `Esc` stop, `[` toggles the sidebar. Every action in the palette is also reachable by mouse in at most two clicks.
7. Responsive breakpoints: < 768 px sidebar is a drawer and the artifact panel is a full-screen sheet; 768–1200 px sidebar collapses to icons; > 1200 px sidebar and artifact panel coexist.
8. Safe areas (`viewport-fit=cover`, `env(safe-area-inset-*)`) on all fixed bars; the composer never hides behind the iOS keyboard.
9. Motion: 120–180 ms ease-out for panels, none for text; honour `prefers-reduced-motion`.
10. Performance: first paint under 1 s on a mid-range phone over 4G; the thread virtualizes above 200 messages.

**Screens and their elements**

| Screen | Elements (each with a purpose) |
| --- | --- |
| Sidebar | New chat (icon + label), search field, pinned chats, topics as collapsible groups, chats listed newest first with title only, archived link at the bottom, settings gear. Hover reveals pin/archive/rename. No chat previews, no timestamps in the list. |
| Thread | User and assistant messages in a single column; user messages right-aligned with a soft background, assistant messages plain. Inline tool rows (collapsed, one line: icon, tool name, status) that expand on click. Subagent group row. Approval card with real arguments, Approve / Deny. Highlighted PII spans with tooltip. Per-message hover actions: copy, edit (user), retry (assistant), "what the model saw". |
| Composer | Textarea that grows to 8 lines; left: attach (paperclip) and mic (hold to record, release to send); right: agent picker chip and send/stop button. The composer row also has a model picker chip (amended 2026-10-26, phase 10). The model picker lists "Auto" first, then the favourite models of the user, and opens a searchable list of all catalog models. The thinking level is a section of the model menu (amended 2026-10-26, phase 10). It shows only for a model that has an effort list, and "Automaattinen" is the default. A ZDR badge "Ei ZDR" (amended 2026-10-26, phase 10) shows on the model chip when the chat runs without ZDR. Attachment chips above the textarea with remove. Drag-and-drop and paste for files and images. |
| Artifact panel | Right panel with tabs for each artifact in the chat; HTML/React in a sandboxed iframe, code with Monaco read-only, Mermaid rendered; actions: copy, download, open in new tab, close. |
| Command palette | Fuzzy search over commands, chats, topics and agents. |
| Vault | Table: kind, original, surrogate, mode, seen count, last seen. Row actions: merge (multi-select), split, pin, regenerate, allowlist, never-detect. Pending lane at the top with confirm / dismiss. Global toggle "show what the model saw". |
| Memory | Two editable markdown panes (USER.md, MEMORY.md) with character counters; pending writes list with approve / reject; consolidation diff viewer. |
| Topics | List with counts; inbox of proposed topics with accept / rename / merge. |
| Settings | Agents (list, edit YAML in a code editor), integrations (connect / disconnect MCP servers), automations (list with last run), models (LiteLLM aliases, read-only), backups (last snapshot time, "run now"), account (passkeys, push). |

**Thread depth**

- **Fork into a new chat (amended 2026-10-26, phase 13):** "Muokkaa" on a user message opens an edit box. "Haarauta" starts a new chat from that point. The server copies the masked entries up to the edit and masks nothing again. The original chat does not change. The new chat shows a link to its source.
- **Thinking row (amended 2026-10-26, phase 13):** A reply of a thinking model shows a collapsed row "Ajatteli 12 s". The row opens to the thinking text. The server restores the text only when the user opens the row, with the same masking as the reply. The setting "Näytä ajattelu" turns the row off.
- **Cost and usage in EUR (amended 2026-10-26, phase 13):** Each reply shows its cost in the action row, each chat shows its total in the chat menu, and Settings shows each month. Prices are stored in USD and shown in EUR with the newest ECB rate. Without a rate, the UI shows USD.
- **Find bar (amended 2026-10-26, phase 13):** Ctrl+F or Cmd+F in an open chat opens a find bar. The bar searches the visible text of the open chat in the browser. It does not use the search index.

**UI reviewer checklist (per PR touching `apps/web`)**

- [ ] Screenshots at 390 px, 1024 px, 1440 px in light and dark attached; no horizontal scroll, no clipped text, no overlap with safe areas.
- [ ] Every new element names its user action in the PR description; decorative elements rejected.
- [ ] Icon buttons have tooltip + `aria-label`; focus rings visible; tab order sensible.
- [ ] Matches the token file: no ad-hoc colours, sizes or shadows.
- [ ] Streaming, loading and error states shown, not just the happy path.
- [ ] Keyboard shortcuts from rule 6 still work; Playwright e2e for the touched flow passes.
- [ ] Looks like a 2026 ChatGPT/Claude screen, not a dashboard: if the reviewer would not mistake it for one at a glance, it goes back.

## 12. Voice input (STT only)

Voice is input only: hold the mic, release, the transcript lands in the composer for editing before send. No TTS in this scope.

- **Capture:** `MediaRecorder` with `audio/webm;codecs=opus`, fallback `audio/mp4` (Safari 18.4+ supports both). Never the Web Speech API: it is unavailable in iOS Home Screen web apps and weak for Finnish.
- **Transcription, default:** OpenRouter `/api/v1/audio/transcriptions` through LiteLLM with `provider: { zdr: true }`, chunks under 60 s (provider timeout) and 25 MB, language hint `fi` unless the user set another. Audio is sent before masking exists, so the transcript is masked at `input` like typed text; the audio file itself is discarded after transcription and never stored.
- **Transcription, self-hosted option (phase 7 spike):** `faster-whisper` large-v3 int8 in its own container (about 3 GB RAM, roughly real-time on the CX33). Enable only if OpenRouter STT latency or terms are unacceptable; it would push the VPS to the 16 GB tier for comfort.
- **UI:** the mic button shows a level meter while recording and a "transcribing" state; the transcript is editable and sent with `Cmd/Ctrl+Enter`. A setting allows auto-send after transcription.

## 13. Phases and done criteria

Eight phases in strict order; each gate is a test or drill Fable runs, not a judgement call. Phases 1–3 are the foundation and must be complete before any real calendar or mail data is connected.

&#91;embedded content: build roadmap · 8 phases, 8 gates\]

Phase 3 is the only phase that blocks on a measured threshold; every other gate is a pass/fail test.

| Phase | Delivers | Done when |
| --- | --- | --- |
| 1 | `apps/server` Pi host, `packages/protocol`, session persistence, `tests/contract` | Contract tests pass against the pinned Pi version; a scripted client can create a chat, send a message, stream a reply and reload it after restart |
| 2 | `apps/web` shell: sidebar, thread, composer, attachments, auth, PWA manifest and service worker, Coolify deploy with TLS | Installs on an iPhone and on desktop Chrome; UI reviewer signs off the three base screens; Lighthouse PWA checks pass |
| 3 | `services/pseudo-svc`, vault, `pi-ext-pseudo`, LiteLLM + Presidio backstop, ZDR enforcement, vault UI, highlights | `tests/pii` meets the recall targets in section 6; a test proves an unmasked hetu is blocked at LiteLLM; a test proves a non-ZDR model alias is refused; the leak scan reports zero on the test corpus |
| 4 | `pi-ext-topics`, topic taxonomy and inbox, FTS5 search, related chats, Litestream + restic, `scripts/restore.sh` | A fresh VPS restored from the bucket serves yesterday's chats; titles appear within 5 s of `agent_settled`; search returns the right chat for 20 scripted queries |
| 5 | Agent profiles, agent picker, `pi-ext-subagents`, skills loader, `sandbox-broker`, automations | A skill with `network: none` cannot reach the internet from its runner; a parallel subagent run shows live status and its tool calls are masked; a cron automation posts to its topic |
| 6 | Google Workspace MCP (and the file server you use), OAuth proxy, tool allowlists, approval cards | Creating a calendar event requires approval and sends real values; a fetched event with a new attendee creates a vault entity and the session stays masked |
| 7 | Artifact panel, voice input, Web Push, command palette, polish pass | UI reviewer passes all screens at all breakpoints; push arrives on a locked iPhone; a recorded Finnish sentence transcribes correctly |
| 8 | `pi-ext-memory`, USER.md/MEMORY.md, `recall` and `memory` tools, pending-write queue, consolidation, memory screen | `recall` finds a fact stated in a chat from the previous week; a memory write from a tainted turn waits for approval; the weekly consolidation produces a reviewable diff |

**Task sizing for subagents:** a task is at most one PR, one day of work, one service or screen. Fable splits anything larger. Each phase begins with a `docs/decisions/phase-N.md` listing the tasks, owners (Opus or Sonnet), and the gate command.

## 14. Quality gates

Every PR passes four automated gates and one or two reviews before merge; Fable runs the gates, the reviewers read the diff.

**Automated (CI on every PR)**

1. `pnpm typecheck && pnpm lint && pnpm test` across the monorepo; `pytest` in `services/pseudo-svc`.
2. `tests/contract`: boots the pinned Pi, binds all extensions, asserts the hook payload shapes used by `pi-ext-pseudo` and `pi-ext-memory` (field names, chaining behaviour, `tool_result.structuredContent` handling). Fails loudly on any Pi version change.
3. `tests/pii`: runs the Finnish test set through `/mask` and reports recall and precision per detector layer and per entity kind; fails below the section-6 thresholds. Also runs a masked-only invariant test: after a scripted 10-turn conversation with tool calls, grep the session JSONL and the LiteLLM request log for every real value in the test set; any hit fails the build.
4. `tests/e2e` (Playwright): new chat, send, stream, attach image, approve a tool, open artifact, search, vault merge. Screenshots at 390/1024/1440 px light and dark are stored as baselines and diffed.

**Reviews**

- Code reviewer (Opus 5.5): checks the acceptance test in the task card, the section-2 invariants, secrets handling, and that any new egress goes through LiteLLM. One pass; a rejection returns the PR to the implementer with a numbered list.
- UI reviewer (Opus 5.5, `apps/web` only): applies the section-11 checklist against the screenshots and a local run. Rejects decorative elements, off-token styling, missing states, broken keyboard paths, and anything that would not pass as a 2026 ChatGPT/Claude screen.
- Security review (code reviewer, phases 3, 5, 6): threat-model note in `docs/decisions/` covering prompt injection via tool results, memory poisoning, sandbox escape, token storage.

**Task card template** (Fable writes one per task; implementers do not start without it): goal, plan section served, files expected to change, acceptance test command, out of scope, reviewer(s).

**Version bumps** of Pi, LiteLLM, Presidio, spaCy models or MCP servers are their own PRs, with the contract and PII suites as the gate and a `docs/decisions/` note on what changed.

## 15. Known pitfalls and open items

These are the places where the plan rests on assumptions; each *verify* item starts with a 30-minute spike that ends in a `docs/decisions/` note.

**Pitfalls to design around**

- Subagent children do not inherit the parent's extensions or provider config; pass them explicitly every time.
- MCP is not loaded in SDK sessions unless `createMcpExtension()` is added and `bindExtensions()` is called.
- `before_provider_request` skips compaction and summary requests (#10653) and can be overridden by later handlers (#10355); that is why masking happens at ingest.
- Replacing only `content` in `tool_result` drops `structuredContent`.
- Web Push needs HTTPS and, on iOS, a Home Screen install; `webkitSpeechRecognition` is unavailable there.
- OpenRouter may drop images silently on some routes; the vision path must be tested through the exact LiteLLM alias.
- Masking breaks tool arguments unless `tool_call` restores them; placeholder-mode entities inflect badly in Finnish, so realistic surrogates are the default.
- Pi packages run with full process rights; vendor and review, never `pi install` at runtime.
- If you use RPC anywhere, split stdout on `\n` only; `readline` splits on U+2028.

**Verify before the phase that needs it**

| Item | Needed by | What to check |
| --- | --- | --- |
| Exact Pi 1.x version and hook payload field names (`extensions/types.ts`) | Phase 1 | Pin the version; record names used by the extensions |
| Whether a stable `AgentConnection` or Pi Durable seam exists worth adopting | Phase 1 | If not, stay on `createAgentSession`; Durable is experimental |
| Presidio `FiPersonalIdentityCodeRecognizer` handles the 2023 separators | Phase 3 | Else use the in-house validator only |
| Omorfi coverage of surnames and licence terms of Voikko/Omorfi (GPL family) | Phase 3 | Keep them inside `pseudo-svc`; fall back to suffix rules |
| Posti postcode file: URL, licence, format | Phase 3, only if address recall is below target | Otherwise skip |
| Local multilingual embedding model quality on Finnish | Phase 4 and 8 | Compare two small models on 50 queries from the test set |
| OpenRouter STT: Finnish quality, ZDR coverage of the chosen STT provider | Phase 7 | Else run faster-whisper locally |
| iOS standalone PWA: mic permission scope, camera picker, wake lock | Phase 7 | Test on a device before building around it |
| Licence of the MS 365 MCP server, if used | Phase 6 | Read the repo licence |
| Hetzner volume and object-storage prices for `/data` growth | Phase 4 | Current console prices; they changed three times in 2026 |

**Deferred, not forgotten:** TTS, OpenShell or micro-VM sandboxing, multi-user auth (OIDC), native mobile shells, Graphiti-style temporal memory, self-hosted Whisper.
