# Architecture and code-quality audit: assistant-2

Status: snapshot of 2026-10-31. Later work fixed or accepted the findings, see
[phase 30](../decisions/phase-30-audits.md) and [phase 35](../decisions/phase-35-security-fixes.md).
The cited paths and line numbers are as of the audit date.

Branch `main` at `6ec0950`, audited 2026-10-31. Read only. Nothing in the repository was changed.

## Method

- Read `AGENTS.md`, `docs/plan.md` sections 3, 5 and 14, `docs/decisions/README.md`, then the code. Every finding below was checked against the file and line it cites.
- `pnpm --workspace-concurrency=1 -r typecheck`: exit 0.
- Unit suites, all green: protocol 56, db 3, web 173, pi-ext-pseudo 18, pi-ext-memory 12, pi-ext-sandbox 5, pi-ext-subagents 14, fake-llm 7, server 248 (1 skipped: OCR, no `tesseract` on this machine). The server suite takes 40 s.
- `knip@5.62.0` (installed outside the repository, with TypeScript 5.9.3). Its false positives were checked and are listed as such.
- `biome lint --only=<rule>` for a few correctness and suspicious rules (read only, no `--write`).
- `EXPLAIN QUERY PLAN` on a scratch database built by `openDb` (`packages/db/src/index.ts`) outside the repository.
- Docker was not started. The code search tool did not start, so text searches used `awk`/`sed` over `git ls-files`.

Severity: **blocking** = fix before the first public push. **should-fix** = a senior reviewer will notice; fix soon. **nice-to-have** = polish.

Counts: blocking 1, should-fix 14, nice-to-have 29.

---

## 1. Structure and boundaries

The layout matches `AGENTS.md` exactly. The boundaries hold: `apps/web` imports only `@nolla/protocol` (no server code); no `packages/pi-ext-*` imports the server; every inbound frame is validated (`bridge.ts:1420-1428` server, `ws.ts:451-452` client). The problems are file size and one module that became a helper library.

Largest non-test source files, judged:

| File | Lines | Verdict |
|---|---|---|
| `apps/server/src/bridge.ts` | 1828 | Grab bag (see below) |
| `packages/protocol/src/index.ts` | 1360 | Cohesive purpose, too big for one file |
| `apps/web/src/store.ts` | 1353 | One 570-line `apply` switch |
| `apps/server/src/claims.ts` | 1219 | One 1000-line closure |
| `apps/web/src/components/MessageView.tsx` | 1014 | Markdown pipeline plus four unrelated components |
| `apps/server/src/tree.ts` | 916 | Files routes, trash, quota: one concern, acceptable |
| `apps/web/src/viz.ts` | 890 | Theming plus the Vega spec sanitizer |
| `apps/web/src/components/ModelPicker.tsx` | 868 | Picker plus mode and auto-approve hooks |
| `apps/web/src/render.ts` | 811 | Artifact documents plus a 256-line SVG post-processor |
| `apps/server/src/pi/registry.ts` | 675 | Cohesive; `build` is 200 lines but ordered and commented |

- **should-fix** `apps/server/src/bridge.ts:508-1471`: `attachBridge` is a 965-line closure, and the file is also the shared helper library, which creates runtime import cycles.
  Evidence: the closure holds the WebSocket dispatch (`handle`, 1035-1418), the fork/edit/retry/version logic (690-1032), the vault operations and chat CRUD. Eight modules import helpers from it (`topics.ts:7`, `versions.ts:2`, `fetch-tool.ts:11`, `tree.ts`, `export.ts`, `harness.ts`, `automations.ts`, `export-all.ts`). Biome `noImportCycles` reports bridge to topics to bridge, bridge to versions to bridge, and `pi/registry.ts:32` to `fetch-tool.ts` to `bridge.ts` to `pi/registry.ts`.
  Fix (step 1, no behaviour change): move `textOf`, `thinkingOf`, `cutText` and `transcript` to `session-text.ts`; move `chatRow`, `summary`, `threadFiles`, `ownUsage` and `forkLink` to `chats.ts` (a `chats.test.ts` already exists without a `chats.ts`); move `restorer` and `release` to `restore.ts`; move `history`, `toMessage`, `toolRows` and `filesOf` to `history.ts`. That breaks every cycle. Step 2: move fork/edit/retry/version (they share `holding` and `rewindAndPrompt`) to `turns.ts`.
- **should-fix** `docs/plan.md:44-75` (§3) and `:113` (§5): the plan's layout is stale, and `AGENTS.md` sends readers to §3 for the architecture.
  Evidence: §3 lists `assistant-ui` (the code uses shadcn/ui), `pi-ext-notify` (it does not exist; push is `apps/server/src/push.ts`), and has no `pi-ext-sandbox`. §5 names `createMcpExtension()` and a notify extension (the code has `mcp.ts` `mcpExtension`). `AGENTS.md` and the README layout are correct.
  Fix: add one "As built (2026-10)" line under §3 and §5 that points to the `AGENTS.md` layout, as the other amendments in §5 do.
- **nice-to-have** `apps/server/src/topics.ts:60-121`: `taskSmall`, the generic LiteLLM JSON helper, lives in the topics module. `claims.ts` imports `topics.ts` for it, which adds claims to topics to bridge to memory to claims to the cycle graph. `search-tool.ts:167` and `stt.ts:75` each build their own LiteLLM `fetch` with their own headers and timeout. Fix: create `llm.ts` with `taskSmall` and one `litellmFetch(path, body, signal)`.
- **nice-to-have** `apps/server/src/claims.ts:192-1219`: `claimStore` is one closure that holds the extraction prompt and zod schemas (102-160), persistence, the sweep scheduler, review, MEMORY.md rendering and recall. Fix: move the prompt, schemas and `Extraction` parsing to `claims-extract.ts`, and move recall (650-725) next to `search.ts`.
- **nice-to-have** `apps/web/src/store.ts:645-1217`: `apply` is one switch over every `ServerMessage`, and the `error` branch alone is 1089-1214. Fix: one reducer function per area (chat list, thread and stream, approvals, vault and memory, models), called from `apply`.
- **nice-to-have** `packages/protocol/src/index.ts`: 1360 lines that mix WebSocket messages, HTTP schemas (files, admin, export), helpers (`artifactTitle`:424, `mermaidMeta`:437, `scheduleToCron`:784, `decryptCommand`:838) and Finnish UI text (`TOOL_STATUS_WORD`:201, `SEARCH_ENTITY_REASON`:211). Fix: split into `messages.ts`, `http.ts`, `artifacts.ts` and `admin.ts`, and re-export them from `index.ts`. It stays the single source.
- **nice-to-have** `packages/pi-ext-topics/src/index.ts:1-12`: a whole package (package.json, tsconfig, no tests) for one `agent_settled` listener. Its only caller ignores `aborted` (`main.ts`, `onSettled: ({ sessionId }) => ...`). Fix: make it an inline factory in `registry.ts`, like `usageExtension`, or keep it and say in the README why it is a package.
- **nice-to-have** Web grab bags. `render.ts:343-599` (`columns`, the "Sarake" Mermaid geometry) belongs in `sarake.ts`. `ModelPicker.tsx:99-252` (`useModes`, `useAutoApprove`, `ModesChip`) belongs in `useChat.ts`. `MessageView.tsx:267-445` (four rehype plugins) belongs in `markdown.tsx`. `thread.ts:280-480` (the streaming Markdown splitter) belongs apart from the date and number formatting. The `viz.ts:387-560` spec sanitizer is security-relevant and should not sit between colour maths.
- **nice-to-have** `apps/server/src/main.ts:69,117,281`: callbacks refer to `app` before `const app = await buildServer(...)` runs. Evidence: `watchAgents` starts at line 117, and its reload logs through `agentLog` to `app.log`. A profile edit during the `await buildServer` at 281 throws a `ReferenceError` inside the `catch` of `reloadAgents`, and that error escapes the watcher callback. Fix: create the pino logger first and pass it to `buildServer`, or keep a `let log = console` that is reassigned after 281.

## 2. Duplication and dead code

- **blocking** `tests/masked-only/models/Xenova/multilingual-e5-small/` (135 MB; `onnx/model_quantized.onnx` is 112.8 MiB): the files are committed, nothing references them, and GitHub refuses any push that holds a blob over 100 MiB.
  Evidence: added in `61bd271` ("feat(agents): YAML agent profiles…"). Root cause: `apps/server/src/embeddings.ts:11-12` reads `process.env.MODELS_DIR || join(process.env.DATA_DIR ?? '.', 'models')`. `tests/masked-only/src/masked-only.test.ts:218` passes `DATA_DIR` only through `loadConfig({...})`, so the model downloaded into the package directory. `.gitignore` covers `tests/memory-eval/models/` only.
  Fix: `git rm -r --cached tests/masked-only/models`. Add `**/models/` to `.gitignore`. Set `MODELS_DIR` in masked-only, or pass the directory from `Config` (see 4). Remove the blob from history before the push (`git filter-repo --path tests/masked-only/models --invert-paths`).
- **should-fix** History size: `.git` is 353 MB. It holds 6,591 screenshot blobs (287 MB) because the `screens` project rewrites every baseline on each run (`AGENTS.md:101`). Fix: in the same history rewrite, keep only the current screenshots, or keep a curated set under `docs/screenshots/` and ignore the rest.
- **should-fix** `apps/server/src/bridge.ts:110-124` and `apps/web/src/store.ts:465-480`: the error codes exist twice with no shared type, and the protocol has `code: z.string()` (`packages/protocol/src/index.ts:1332`).
  Evidence: the server has 13 codes and the web has 12 Finnish texts. `memory_generated` and `invalid` have no Finnish text, so `store.ts:1211` would show the English server text. Today both codes arrive only on paths that handle them (ClaimsTab's `claimError`, and MemoryScreen never edits MEMORY.md), so the gap is latent, but the compiler does not stop the next code from falling through.
  Fix: `export const ErrorCode = z.enum([...])` in protocol, then `Record<ErrorCode, string>` on both sides.
- **nice-to-have** Three code-fence scanners with different rules: `apps/server/src/artifacts.ts:11-36` accepts `^ {0,3}` only, while `apps/web/src/thread.ts:280` also accepts a fence after a list or quote marker, and `thread.ts:451` has a third one. A ```` ```mermaid ```` block inside a list item renders inline on the web, but the server sends no `artifact.upsert`, so the panel list does not have it. Fix: one `fences()` in protocol.
- **nice-to-have** `apps/server/src/bridge.ts:531-536` `toAll` repeats `sendAll` (`main.ts:59-66`), the same loop over `sockets`. Fix: put `sendAll` in `BridgeDeps`.
- **nice-to-have** Unused code that a linter would catch: `bridge.ts:3` imports `join as joinPath` and never uses it; `policy.test.ts:367` destructures `refuseThenOpen` and never uses it. knip false positives that were checked and are in use: `apps/web/src/transpile.worker.ts` (`render.ts:78`), `packages/pi-ext-subagents/src/child.ts` (`index.ts:99`), `apps/web/public/push-sw.js` (workbox `importScripts`), `scripts/*.mjs`, `sucrase`, `tailwindcss`, `tw-animate-css`, and `@nolla/pi-ext-sandbox` in subagents (`require.resolve`, `index.ts:100`). `tests/e2e/src/demo.ts` has no reference anywhere, but it is worth keeping (see 6).
- **nice-to-have** Stale comments: `bridge.ts:380` and `packages/pi-ext-subagents/src/workspace.ts:23` describe "Pi 1.3.0" behaviour, while 1.4.0 is pinned. Fix: write "Pi 1.4.0 (unchanged from 1.3.0, decision 0009)".

## 3. Error handling and resilience

Sound: every outbound server `fetch` has `AbortSignal.timeout` (pseudo client 5 s plus a per-batch allowance, `client.ts:117-122,186`; LiteLLM calls; push; ECB; catalog; MCP probe; sandbox 130 s). Approvals end on a timeout or on abort (`approval.ts:131-137`), and the "resolved" map is bounded at 200 entries (`approval.ts:142,166`). Collision holds time out after 30 min (`collisions.ts:28`). Subagent children have a timeout, SIGTERM then SIGKILL, and LF-only framing (`pi-ext-subagents/src/index.ts:166-171,233-246`). `forward` puts every chat event on one promise chain that has a `catch` (`bridge.ts:1659-1665`). The empty `catch` blocks are commented best-effort cleanups.

- **should-fix** `apps/web/src/ws.ts:149-162,175,463-466`: `createChat` waiters never reject. A refused `chat.create`, or a socket that closes before `chat.created`, loses the user's text or sends it to a different chat.
  Evidence: `Composer.tsx:303` clears the text, then `:307` awaits `sendUserMessage`, which awaits `createChat`. The server answers a bad model or mode with `errorMsg('bad_message')` and an unknown agent with `not_found`, and neither carries a `chatId` (`bridge.ts:1037-1043`). `onclose` (`ws.ts:481-497`) and `disconnect` (80-94) leave `createWaiters` as they are, so the next `chat.created` resolves the stale waiter (FIFO `shift`) and the old text goes into the new chat. A model removed from the catalog by the daily refresh is enough to trigger it.
  Fix: send a `localId` with `chat.create` and echo it in `chat.created` and in the error. Reject pending waiters on that error and on close, and give the text back to the draft (the `giveBack` pattern).
- **should-fix** `apps/web/src/ws.ts:437-497`: the reconnect has no liveness check and no way out of a 401 loop.
  Evidence: a `ping` goes every 25 s (`:442`), but nothing waits for the `pong`: `store.apply` has no `pong` case. After a network switch, a half-open socket stays `OPEN`, `send` writes into it, and those frames are lost when it finally closes. A device that was offline while it was revoked in "Laitteet" reconnects into the `/ws` `preValidation` 401 (`http.ts:197-202`). The browser reports close code 1006, not 4401, so `ws.ts:484` never signs out, and the client retries every 10 s without end and never shows Login.
  Fix: record the time of the last frame and close the socket when 60 s pass without one. After 3 closes without an `onopen`, call `me()`, and call `signedOut()` on a 401.
- **nice-to-have** `apps/server/src/http.ts:129`: `app.register(websocket)` keeps the `ws` default `maxPayload` of 100 MiB, so one frame is read into memory before zod sees it. Attachments go over HTTP, so 1 MiB is ample: `register(websocket, { options: { maxPayload: 1 << 20 } })`.
- **nice-to-have** `apps/server/src/main.ts:430-454`: no `unhandledRejection` handler. Node then exits on any stray rejection. Compose restarts the container, but the in-memory approvals, holds, auto-approve set and refusals are gone, and the app logs nothing about why. A candidate: `main.ts:372` `void registry.evictIdle()`, which can throw from `session?.dispose()` (`registry.ts:301`). Fix: `process.on('unhandledRejection', …)` that writes through the existing `say` and calls `shutdown`.
- **nice-to-have** HTTP status read from error text: `bridge.ts:671` `err.message.endsWith('status 409')` and `main.ts:422` `/status 4\d\d/.test(String(err))` parse the message that `PseudoDownError` gets at `client.ts:189`. Fix: give `PseudoDownError` a `status?: number`.
- **nice-to-have** `apps/server/src/main.ts:135-146`: log messages act as an event bus. The host branches on `msg === PSEUDO_DOWN`, `PSEUDO_COLLISION` and `PSEUDO_COLLISION_DROPPED`, and reads `data.pendingIds` from a log payload (`pi-ext-pseudo/src/index.ts:9-13`). A changed log text then breaks the vault refresh and the release of held messages without any error. Fix: add an `onEvent` option next to `log`.
- **nice-to-have** `apps/server/src/topics.ts:67,85-86`: after any HTTP 400 (for example a context-length error), `jsonMode` stays false until the process restarts. Fix: turn it off only for that call, or only when the error body names `response_format`.
- **nice-to-have** `apps/server/src/bridge.ts:1025-1026`: the cleanup after a failed fork swallows errors from `registry.remove` and `pseudo.dropFork` and logs nothing. A failed `dropFork` leaves a copied vault scope that belongs to no chat. Fix: log at `warn`, as `chat.delete` does (1259-1266).
- **nice-to-have** `apps/web/src/store.ts:1091`: `console.error('model call failed', msg)` prints `detail`, the restored provider text, so real values can appear in devtools. Phase-22 decision 1 chose this, but it conflicts with the `AGENTS.md` rule "Never log or print real values". Fix: log `code` and `status` only, or record the exception in the phase record.

## 4. Data layer

Sound: WAL, `busy_timeout`, `foreign_keys = ON` (`packages/db/src/index.ts:16-19`). Transactions are where several writes must land together: usage row and chat totals (`usage.ts`, `record`), the files and chat rows on delete (`bridge.ts:1238-1247`), chunks plus FTS plus vector rows (`search.ts:109-129`), and seven claim transactions. The data migrations carry comments (0008, 0010, 0012), and 0010 and 0012 have tests (`packages/db/src/index.test.ts:111,141`).

- **should-fix** Missing indexes for queries that run on every turn and for foreign-key cascades. `EXPLAIN QUERY PLAN` on a migrated database:
  - `chunks WHERE chatId=? AND kind=?` (`search.ts:66-70`) gives `SCAN chunks`. The latest-transcript query (`:86-91`) gives `SCAN chunks | USE TEMP B-TREE`, and the delete (`:111`) also scans. `indexNow` runs after every `agent_settled` (`bridge.ts:189,1653`), and `chunks` is the largest table. The index `chunks_user_chat_idx (userId, chatId)` cannot serve a query without `userId`.
  - `files WHERE userId=? AND chatId=?` (`chatFiles`, read on every `chat.open` through `threadFiles`) gives `SCAN files`.
  - `memoryPending`, `fileOrigins` and `topicProposals` by `chatId` scan, so each chat delete scans every child table in the cascade.
  Fix: one migration: `chunks(chatId, kind, seq)`, `files(chatId)`, `fileOrigins(chatId)`, `memoryPending(chatId)`, `topicProposals(chatId)`.
- **should-fix** `apps/server/src/embeddings.ts:11-12`: this is the only server module that reads `process.env` for a path instead of `Config` (the other one, `ocr.ts:62-63`, passes PATH and HOME to a child process). That is how the 135 MB model got into the repository (see 2). Fix: add `modelsDir` to `Config` and pass it in.
- **nice-to-have** `packages/db/src/index.ts:21-38`: the FTS5 and vec0 tables are raw DDL outside the drizzle journal, with a drop-and-rebuild check for the phase-4 table (26-28). `chunks_ad` cleans `chat_fts` and `chunk_vec`. `claims_fts` and `claims_vec` have no trigger, which is correct today only because claims are never deleted (`schema.ts:281`). Fix: move the DDL into a custom drizzle migration (`drizzle-kit generate --custom`) so all schema history is in one journal. Add a `claims_ad` trigger.
- **nice-to-have** `apps/server/src/bridge.ts:1347-1366` (`topic.accept`): three writes (proposal status, topic insert, chat update at 1363) run without a transaction. A failure in `update` leaves an accepted proposal and an orphan topic. Fix: wrap them in `db.transaction` (synchronous in better-sqlite3).

## 5. Tests

Coverage: the server suite (35 files, 248 tests) boots the real server with the in-process fake LLM and the fake sidecar and drives it over the socket: fork, edit and versions, policy, approvals, search, claims, export, files, push. Web: 173 tests (store, ws, thread, viz, router). Extensions: 49 tests. Contract: 28 Pi hook and session tests. e2e: about 122 flows and about 138 screen shots with axe strict. Docker suites: egress 23, sandbox 17. Masked-only: a 10-turn tool conversation plus a restart. pseudo-svc: 84 pytest tests. `tests/pii`: recall and precision gate. `pi-ext-topics` has no tests (trivial).

- **should-fix** Silent skips: 14 tests that use embeddings run only when the model loads: `search.test.ts:250-358` (6), `claims.test.ts:207-736` (6), `memory.test.ts:67,194` (2), all `test.skipIf(!modelOk)`. The model downloads from Hugging Face on the first run (`test-utils.ts:17`, `embeddings.ts:20`). On a fresh or offline CI runner the gate is green while search and claims recall are not tested. Fix: with `REQUIRE_MODEL=1` a skip becomes a failure; cache `MODELS_DIR` in CI.
- **nice-to-have** Sleeps and timing:
  - `tests/e2e/src/flows.spec.ts:2545` `waitForTimeout(31_000)` in the default `chromium` run.
  - `apps/server/src/topics.test.ts:12` `settle = sleep(2500)`, twice.
  - `tests/mcp/src/integrations.test.ts:47` sleeps 10.1 s to get past the probe cache.
  - `apps/server/src/policy.test.ts:223,281,351,544` sleep 100-200 ms to order a race against a 500 ms proxy delay, which fails on a loaded machine.
  Fix: make the debounce and `CACHE_MS` options, and wait on the fake sidecar's request count or a log line instead.
- **nice-to-have** Duplicated test helpers. `freePort` (with a port race) exists 4 times: `test-utils.ts:32`, `tests/e2e/src/fixtures.ts:318`, `masked-only.test.ts:135`, `sandbox.test.ts:26`. "Start the server with fakes" exists 4 times: `test-utils.ts:40`, `fixtures.ts:447`, `masked-only.test.ts:205`, `demo.ts`. The socket client exists twice (`masked-only.test.ts:143` and `test-utils.ts:95`); `tests/mcp` already reuses `test-utils`. Fix: export `startTestServer` and `connect` from `test-utils`, and let `start()` take port 0 and return the bound port.
- **nice-to-have** Production packages export test fakes: `@nolla/pi-ext-pseudo` `./fake-sidecar` (364 lines) and `@nolla/pi-ext-sandbox` `./fake-broker`. This is harmless in a private monorepo. Fix: move them to `tests/fakes` if a package is ever published.

The three most valuable missing tests:

1. `apps/web/src/ws.test.ts`: `chat.create` answered with an error, and a socket that closes before `chat.created`. Expect the text back in the composer, an empty waiter list, and a next `chat.created` that resolves only its own call. This test fails today (see 3).
2. Server: `chat.delete` while a reply streams and a subagent child runs. Expect no chat row, no JSONL, no `chunks`/`chat_fts`/`chunk_vec` rows (the reindex after settle hits the foreign key), no vault scope, no push and no unhandled rejection. Today delete is tested only on an idle chat (`chats.test.ts:39`).
3. `packages/db`: schema parity. Build a fresh database from the migrations and compare `PRAGMA table_info` and `index_list` with drizzle `getTableConfig` for every table in `schema.ts`. An edit to `schema.ts` without `drizzle-kit generate` then fails. Today only two data migrations are tested.

## 6. Readability for a newcomer

The comment style is consistent and mostly states the rule first and the source second ("A fork's copied replies cost in the source chat, not here (phase-13 decision 7)", `bridge.ts:250`). That form is useful. The problems are references that a newcomer cannot resolve, and the files that have no overview.

- **should-fix** The files a newcomer opens first have no overview comment: `apps/server/src/bridge.ts`, `apps/server/src/pi/registry.ts`, `apps/server/src/main.ts`, and the pair `apps/web/src/ws.ts` / `store.ts`. One 10-line header each would save an hour:
  - bridge: inbound frame, `handle`, registry, then `forward()` (hold-back restore, broadcast); the accept-tracking WeakMaps (373-494); fork, edit, retry and version share `holding` and `rewindAndPrompt`.
  - registry: session lifecycle (`get`, `track`, `build`, `evict`, `fresh`) and why the extension order matters (masked args, search tool, pseudo, guards, approval gate, taint, harness, sandbox, subagents, path guard, usage, memory, topics, MCP).
  - main: the composition root and the late binding of `app`.
  - ws and store: `ws.ts` owns the intents (`policyIntent`, `retryIntent`, `editRefresh`, `createWaiters`); `store.apply` reduces frames.
- **should-fix** Decision references that cannot be resolved. 732 comment lines cite a phase or a decision. 90 of them cite a bare "decision N" without naming the record (for example `admin.ts:38,61,132,156`; `bridge.ts:1268` "decision 1"). Some use private shorthand: "(P2)" `bridge.ts:749`, "(P3)" `versions.ts:52`, "(risk 3)" `bridge.ts:1579`, "(decision 28 amended)" `bridge.ts:1388`, and "brief 7.x" (which means `phase-9-ui.md` §7) in `App.tsx:117-385` and elsewhere. Fix: name the record in a header for each file ("Decisions: docs/decisions/phase-15-admin.md"), and add a 3-line legend to `AGENTS.md` for "brief 7.x", "P-n" and "UI review n".
- **should-fix** Public-repository basics:
  - There is no `LICENSE` file, so the code is "all rights reserved" by default.
  - `AGENTS.md:60` says "There is no remote; do not push", which becomes false.
  - The README has no screenshot and no architecture diagram near the top, although 578 screenshots exist and plan §3 has a diagram.
  - `tests/e2e/src/demo.ts` (the full UI with fakes, no Docker, no keys) is not in the README or in a package script.
  Fix: add a licence, update `AGENTS.md`, add a `pnpm demo` script, and add a "Try it" section with two screenshots.
- **nice-to-have** `apps/web/src/components/FilesScreen.tsx:14,203`: the lucide `Upload` icon and a local `type Upload` share one name.
- **nice-to-have** `apps/server/src/main.ts:163-169`: `usageRecorder(db, userId, warn, undefined, agentOf)` passes a positional `undefined`. Fix: an options object.

## 7. Dependencies

Sound: exact pins everywhere, `minimumReleaseAge: 10080` (`pnpm-workspace.yaml:6`), `allowBuilds` limits install scripts, every compose image is digest-pinned, and the Python lock is `requirements.lock`. The two schema libraries both earn their place: Pi `registerTool` takes TypeBox, and the protocol uses zod. Vega-Lite plus Observable Plot/D3 plus Mermaid is a recorded choice (phase-19 decision 11), and the runtimes are lazy chunks (`vite.config.ts` `globIgnores`). `web-push` is used only to sign and encrypt, and the request goes through `fetch` with a timeout (`push.ts:128-136`), which is fine.

- **should-fix** `biome.json:31` `"preset": "none"` turns every lint rule off, so `pnpm lint` checks only the format and the import order, while `AGENTS.md:55` says "Biome formats and lints". Evidence: the correctness and suspicious rules, run by hand, find the unused imports and variable in 2 and seven import cycles. Fix: `"preset": "recommended"` with the noisy rules turned off by name, and the findings fixed in one commit.
- **should-fix** There is no CI configuration (no `.github/`), but plan §14 says "Automated (CI on every PR)", and a public repository is judged by its checks. Fix: one GitHub Actions workflow with `pnpm install --frozen-lockfile`, typecheck, lint, the vitest suites, `test:contract` and `pytest` (Playwright is optional), with the model cache from 5.
- **nice-to-have** Unused devDependencies (knip, checked): `tests/mcp/package.json` has `@nolla/pi-ext-pseudo`, `@nolla/protocol`, `@types/ws` and `ws` (it imports only `@nolla/server/src/test-utils.ts`); `packages/pi-ext-sandbox/package.json` has `@nolla/fake-llm`.
- **nice-to-have** `infra/Dockerfile.server:4` and `infra/Dockerfile.broker:4` use `node:22.23.2-bookworm-slim` without `@sha256`, while every other image is digest-pinned.
- **nice-to-have** `package.json:7` `engines.pnpm ">=10.16"` disagrees with `packageManager: pnpm@12.15.0` and the README ("pnpm 12").
- **nice-to-have** About 60 exports are used only inside their own file (knip): for example `store.ts` `errorText`, `sortChats`, `DEFAULT_MODEL`; `claims.ts` `EXTRACT_PROMPT`, `Extraction`; `ws.ts` `createChat`. Removing `export` makes each module's surface visible. The unused exports in the vendored shadcn `ui/` components are fine.
- Not a finding: `undici` in the broker (`services/sandbox-broker/src/index.ts:9`) serves only a Unix-socket dispatcher with streamed logs. `node:http` with `socketPath` could replace it, but the gain is small.

---

## Sound, and worth showing in the README

1. **Fail-closed pseudonymization in the agent loop.** `packages/pi-ext-pseudo/src/index.ts` masks at `input`, unmasks at `tool_call`, masks `tool_result` and scans for leaks, and fails closed when the sidecar is down. The streaming restore never splits a surrogate or a UTF-16 pair (`apps/server/src/bridge.ts:346-391` `release`, tested in `server.test.ts:313`).
2. **The masked-only invariant as a test.** `tests/masked-only/src/masked-only.test.ts` runs a 10-turn tool conversation and a restart, then searches every session JSONL and every model request for each real value. `tests/pii` gates recall and precision per detector.
3. **A pinned runtime with contract tests.** `tests/contract/src/hooks.test.ts` asserts the Pi hook payload shapes the extensions depend on, and `docs/decisions/0001-*.md` and `0009-*.md` record that surface.
4. **One typed protocol, validated at both edges.** A zod discriminated union in `packages/protocol`, `safeParse` at `bridge.ts:1420` and `ws.ts:451`. The web imports nothing from the server.
5. **The whole stack testable without keys or Docker.** `tests/fake-llm` (an in-process OpenAI-compatible server), the fake sidecar and the fake broker. Around 250 server tests drive the real server over the socket, and `tests/e2e/src/demo.ts` runs the full UI.
6. **Hybrid search in SQLite only.** FTS5 trigram plus sqlite-vec plus reciprocal rank fusion (`apps/server/src/search.ts:133-141,187-250`), reused for claims recall (`claims.ts:650-721`), with local multilingual-e5 embeddings.
7. **SSRF-safe `fetch_url`.** A DNS-pinned lookup against one shared private-range `BlockList` that covers the IPv6 transition ranges (`services/sandbox-broker/src/net.ts`, used by `apps/server/src/fetch-tool.ts:8` and the broker proxy).
8. **A hardened sandbox.** Only the broker holds the Docker socket. Skill containers run with `network: none` by default, a read-only rootfs, `CapDrop: ALL`, `no-new-privileges` and pid, memory and CPU limits (`services/sandbox-broker/src/index.ts:135-148`), plus an allowlist proxy for declared hosts.
9. **Supply-chain and infrastructure discipline.** The 7-day release-age gate, exact pins, digest-pinned images, read-only containers, and measured, commented memory limits (`infra/compose.yaml`).
10. **Process isolation for subagents.** A minimal environment (only the LiteLLM key), LF-only JSONL framing, a timeout and a SIGKILL grace period (`packages/pi-ext-subagents/src/index.ts:112-258`).
11. **Small, robust details.** An approval gate with timeout and abort combined (`apps/server/src/approval.ts:122-138`). A catalog refresh with cache, atomic write and backoff (`apps/server/src/pi/models.ts:376-436`). Cost accounting in one transaction (`apps/server/src/usage.ts`).
12. **A decision log.** 38 records indexed from `AGENTS.md`, one per phase, each with the review findings that were left as they are, on purpose.
