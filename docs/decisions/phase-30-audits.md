# Phase 30: audits before publication

Date: 2026-10-31. Two read-only audits ran on `main` at `6ec0950`: `docs/audits/2026-10-31-security.md`
and `docs/audits/2026-10-31-architecture.md`. This record lists what is fixed, in which batch, and
what stays as it is.

## Batch A: security fixes (no user decision needed)

1. **Password login.** The attempt is counted before the scrypt verify, a global key limits all
   clients together, and one verify runs at a time (`auth/routes.ts`).
2. **Topic names are masked** before the title job sends the topic list to the model
   (`topics.ts`); fail closed without `pseudo`, as the claims extraction does.
3. **Approval memory keyed by tool and call id**; a message whose tool calls repeat or lack an id is
   refused (`approval.ts`, `search-tool.ts`).
4. **Symlinks blocked in the runner** with a seccomp profile that denies `symlink` and `symlinkat`;
   the child's path check moves after the card (`sandbox-broker`, `pi-ext-subagents/child.ts`).
5. **Request log without query strings** (`http.ts` serializer).
6. **`pseudo-svc` on its own `internal: true` network** with `pa-server` only; Presidio and LiteLLM
   on a second internal network (`infra/compose.yaml`). Verified with the compose smoke.
7. Nice-to-haves done in the same batch: passkey challenge map capped, the missing IPv6 ranges in
   `net.ts`, YAML error logs without the source line, `__Host-` cookie prefix when the origin is
   https, config checks fail closed.
8. **Litestream removed; `app.db` hourly with restic** (decided by the user). Litestream wrote
   `app.db` to the bucket as plain SQLite pages, and the file holds real values (claims, evidence,
   restored titles). Litestream 0.5 has no replica encryption. Restic encrypts every snapshot.
   The backup service snapshots consistent copies of `app.db` (SQLite online backup) and
   `vault.db` (`sqlcipher_export`, so the service gets `PSEUDO_VAULT_KEY`) hourly (tags `app`,
   `vault`) and nightly with the rest of `/data`. `scripts/restore.sh` takes each database from
   the newer snapshot and stops unless `PRAGMA integrity_check` returns `ok`.

## Batch B: architecture fixes

8. The `chat.create` wait in `ws.ts` ends on refusal or socket close and the composer keeps its
   text; the client waits for the pong and shows Login on a 401 reconnect.
9. Biome rules on (`recommended`), the findings fixed, import cycles broken.
10. `bridge.ts` split by concern; no module imports helpers from it.
11. Indexes for `chunks` and the `chatId` child tables in one migration; a test that the migrated
    schema matches `schema.ts`.
12. Error codes typed once in the protocol; tests that need the embedding model fail loud when it is
    missing instead of skipping.
13. The committed model under `tests/masked-only/models/` leaves the tree and the history
    (phase 31 rewrites the history anyway).

## Left as they are, with the reason

- **Artifacts show real values.** An HTML or React artifact is built from the restored text, so a
  prompt-injected artifact can carry real values in a navigation. Decision pending with the user:
  masked artifacts, or restored with a warning on a tainted chat.
- **`pnpm audit`:** 19 transitive advisories; the two highs sit inside the pinned Pi and the MCP
  SDK. Overrides when the patched versions are 7 days old.

## Status

Open. Batch A is done on the branch `p30-sec` (2026-10-31). Batch B item 10 is done on the branch
`p30-b1` and items 8, 11, 12, 13 and the dependency follow-ups on the branch `p30-b2` (2026-10-31).
Item 9 is open.

Batch A, per item:

1. Done. The handler counts the attempt (IP key and the key `global`, 10 per minute) before the
   verify. A module-level promise chain runs one scrypt verify at a time. A successful login now
   counts too. Test: 30 parallel wrong passwords give at most 5 verifications, the rest 429.
   Review: a flood locks the owner out of password login too (global key; behind a CDN also the
   IP key). Kept on purpose: `docs/deploy.md` names the passkey as the recovery path and says to
   remove `AUTH_PASSWORD_HASH` after the passkey works.
2. Done. The topic list goes through `pseudo.mask` before the call. Without `pseudo` the job
   sends an empty topic list, but it still runs: the title job also runs in the dev and test
   setup without the sidecar, and production cannot start without `PSEUDO_URL` (item 7).
   Review fix: only names and descriptions go through the mask, so the ids stay exact. The
   proposed topic (`name`, `why`) is unmasked before it is stored and compared with real names.
3. Done. `callKey(tool, id)` keys the approved set, the masked arguments and the harness stamps.
   The `maskedArgs` extension (first in the chain) reads each assistant message on `message_end`
   and blocks every call of a message whose tool call ids repeat or are empty. This depends on
   Pi awaiting `message_end` before the `tool_call` hooks (recorded in `0009-pi-1.4.0.md`).
4. Done. `services/sandbox-broker/src/seccomp.json` is Docker's default profile
   (moby/profiles `seccomp/v0.1.0`, the one Docker 29.1 uses) without `symlink` and `symlinkat`.
   `Dockerfile.broker` already copies the whole broker folder, so it did not change. The child
   checks paths after the card. `pnpm test:sandbox` ran with Docker, with a new symlink test.
   `ln -s` fails inside runners on purpose (`docs/deploy.md`, Sandbox).
5. Done. The `req` serializer logs the method and the path without the query string.
6. Done. Networks `pseudo` (pa-server, pseudo-svc) and `presidio` (litellm, presidio-*), both
   `internal: true`. `pseudo-svc` is not on `presidio`: it runs Presidio in process and calls no
   other service. The compose smoke (project `pa-p30`) came up healthy. Every service URL resolved.
   pseudo-svc and Presidio had no internet access. litellm and the broker could not reach
   pseudo-svc.
7. Done. Passkey options have their own limiter (30 per minute per IP, still bounded by
   `MAX_CHALLENGES`); failed verifies keep the strict one (5 per minute). Added `::/96`, `::ffff:0:0:0/96` and
   `64:ff9b:1::/48` to `net.ts`. YAML errors log the error name, the line and the Zod field paths.
   The cookie is `__Host-pa_session` on https; sessions with the old name end once after the
   deploy. In the image (`NODE_ENV=production`) pa-server refuses to start without `PSEUDO_URL`
   or with a LiteLLM key under 32 characters, and the broker refuses to start without
   `HOST_DATA_DIR`. `compose.local.yaml` fixes the project name `pa-local` and sets
   `HOST_DATA_DIR` to `/var/lib/docker/volumes/pa-local_pa-data/_data` (default data-root).
8. Done. Review fix: no live database file is copied. `infra/backup/db-copy.sh` writes a
   consistent copy first (`sqlite3 .backup`, `sqlcipher_export` for the vault). `restore.sh`
   stops on a failed snapshot listing, takes each database from the newer snapshot (restic
   `latest` over both tags) and stops unless `PRAGMA integrity_check` returns `ok`. The restore
   drill passed. It covers an hourly snapshot newer than the nightly one and the reverse, and a
   SQLCipher vault.

Left as they are in batch A, on purpose:

- The backup service holds `PSEUDO_VAULT_KEY`, because a consistent copy of the SQLCipher vault
  needs the key. It already holds `app.db` and the memory files with real values.
- `docs/plan.md` still describes Litestream. This record supersedes it.

Batch B, item 10:

10. Done. `bridge.ts` had 1828 lines; it now has 196 and only dispatches. No module imports
    helpers from it: `http.ts` imports `attachBridge`, and nothing else imports the file. The
    handlers take the socket context `Conn` instead of the closure. Message handling order and the
    protocol did not change. `npx madge@8.0.0 --circular` on `apps/server/src` found 6 cycles
    before and 0 after (type imports included). The server suite has 255 passed and 1 skipped
    before and after; the tests of moved code sit next to their module. Module map (lines):
    - `bridge.ts` (196): parses a client frame, dispatches it by type, maps handler errors to codes.
    - `bridge/connection.ts` (129): `BridgeDeps`, the socket context `Conn`, attach and close,
      `owned`, `update`, `notify`, `toAll`, `agentsState`.
    - `bridge/stream.ts` (263): `join` and `forward` (Pi session events to frames), `reindex`.
    - `bridge/accept.ts` (133): `message.accepted`, the stored entry of each prompt.
    - `bridge/turns.ts` (477): `user.message`, `user.stop`, `user.retry`, `chat.edit`,
      `chat.version`, `chat.fork`.
    - `bridge/chats.ts` (276): chat create, list, open (`chat.state`), related, thinking text,
      archive, rename, pin, model, modes, data policy, delete.
    - `bridge/approvals.ts` (48): `approval.respond`, `chat.setAutoApprove`, `autoApproveOf`.
    - `bridge/models.ts` (51): `models.state`, `models.favorite`, `validChoice`.
    - `bridge/memory.ts` (58): `memory.*` and `claims.*` changes.
    - `bridge/topics.ts` (68): `topic.accept`, `topic.reject`, `ownTopic`.
    - `bridge/vault.ts` (92): `vault.*` frames, `vaultState`.
    - `session-text.ts` (56): `textOf`, `thinkingOf`, `cutText`, `transcript`.
    - `chats.ts` (76): `chatRow`, `summary`, `threadFiles`, `ownUsage`, `forkLink`.
    - `restore.ts` (68): `restorer`, `release`.
    - `history.ts` (164): a Pi branch as protocol messages (`history`, `toMessage`, tool rows).
    - `socket.ts` (61): `Socket`, `send`, `broadcast`, the error codes, `NotFound`, `RunActive`.
    - `llm.ts` (87): `taskSmall`, out of `topics.ts`. This closed the last cycle
      (`claims` to `topics` to `pi/registry`).

Left as they are in item 10, on purpose:

- `bridge.ts` still answers `ping`, `usage.get`, `search.query`, `models.list`, `topic.list`,
  `memory.list`, `chat.focus`, `push.subscribe` and `automations.*` itself. Each is one service
  call or one guard.
- `AGENTS.md` (layout) still names only `bridge.ts`. This branch changed only `apps/server/src`
  and this record.

Batch B, per item (branch `p30-b2` holds 8, 11, 12, 13 and the dependency follow-ups):

8. Done. A refused `chat.create` or a close before `chat.created` rejects the wait in `ws.ts`.
   `sendUserMessage` then gives the text and the files back as a `draft` with `chatId: null`
   (the new-chat composer). A refusal shows the toast of its code; a close shows "Viestin
   lähetys epäonnistui.". The server does not echo a request id for `chat.create`, and the fix
   must not touch `bridge.ts` while the split runs. So the next error without a `chatId` and
   with a code that a refused create sends (`bad_message`, `not_found`, `failed`,
   `pseudo_down`; from the agent and topic lookup, the model and modes check and the session
   build) answers the oldest wait. This is the same send order that `chat.created` already
   uses. A refused create never names a chat. Kept on purpose until the follow-up: an error of
   another request with one of these codes can still end a create wait. Follow-up after the
   split: a `localId` on `chat.create`, echoed in `chat.created` and in the error.
   Review fixes: a sign-out drops the text of a pending create, so the next user never sees it.
   A `chat.create` that is still in the queue when its wait fails is removed from the queue.
   Frames from a socket that is no longer current (lost to a missing pong) are ignored, so the
   late `chat.created` of a create sent on it cannot answer the next create. A `chat.created`
   without a wait still opens its chat: a fork's new chat arrives that way.
   Liveness: each ping (every 25 s) arms a 10 s timer, and any frame clears it. When no frame
   comes, the socket counts as closed at once and the client reconnects. The server refuses an
   unauthenticated upgrade with HTTP 401 and sends no 4401 then; the browser reports 1006 only.
   So a close before `onopen` asks `/api/auth/me`. A 401 there signs out and shows Login, with
   no more retries. Any other answer, or no answer, keeps the backoff. When
   `navigator.onLine` is false, the check does not run. This differs from the
   report (three closes, then `me()`): one check per failed open is simpler, and the backoff
   already caps it at one call per 10 s.
11. Done. Migration `0013_curvy_mimic.sql` adds `chunks(chatId, kind, seq)`, `files(chatId)`,
    `fileOrigins(chatId)`, `memoryPending(chatId)` and `topicProposals(chatId)`. `drizzle-kit
    generate` wrote it from `schema.ts`. `packages/db/src/schema.test.ts` migrates an empty
    database and runs drizzle-kit's `pushSQLiteSchema` against it: the test expects no
    statement. This compares columns, defaults, keys, foreign keys and indexes in one call, so
    the test does not compare `PRAGMA table_info` by hand. The raw FTS5 and vec0 tables stay out
    of the check, because the test runs drizzle's `migrate` and not `openDb`.
12. Error codes: done. `ErrorCode` in `packages/protocol` is a `z.enum` of the 13 codes, and
    `error.code` uses it. The wire format does not change. The web keeps
    `ERROR_TEXT: Record<ErrorCode, string>` and gained Finnish texts for `memory_generated` and
    `invalid`, which had none. The server's `errorMsg` returns a `ServerMessage`, so the compiler
    already refuses a server code outside the enum. The server text map `ERRORS` is in
    `bridge.ts`, which this batch must not edit during the split. Follow-up for the split:
    `ERRORS satisfies Record<ErrorCode, string>`. The web key `pseudo_collision` was never an
    error code: it is the toast text of the `chat.held` frame. It is now the constant
    `COLLISION_TEXT` in `store.ts`, not an enum member. The schema is
    `ErrorCode.catch('failed')`: a cached PWA that is older than the server reads a code it does
    not know as `failed`. It shows the generic toast, and a pending create wait ends.
    Model tests: done. `modelReady()` in `apps/server/src/test-utils.ts` loads the model for
    `search.test.ts`, `claims.test.ts` and `memory.test.ts`. When the model does not load, the
    file fails with the cause and the name of the skip variable. Only `PA_SKIP_MODEL_TESTS=1`
    turns the 14 tests into skips with a warning. CI must not set it. The report proposed the
    reverse (`REQUIRE_MODEL=1` makes a skip fail). With a loud default, a machine without the
    variable can never pass the gate silently.
13. Done in the tree; phase 31 rewrites the history. `tests/masked-only/models` is removed, and
    `.gitignore` has `**/models/`. Cause fixed: `embeddings.ts` no longer reads `process.env`.
    `Config.modelsDir` is `MODELS_DIR`, else `DEFAULT_MODELS_DIR` (`$TMPDIR/pa-models`), and
    `start` passes it to `setModelsDir`. Code that never starts a server (the direct search and
    claims tests, the memory eval) keeps the same default. The server harness, the e2e fixtures,
    the demo and masked-only pass `MODELS_DIR` through to `loadConfig`, so all of them share one
    download. `scripts/download-models.mjs` calls `setModelsDir`. Changed on purpose: dev without
    `MODELS_DIR` now keeps the model in `$TMPDIR/pa-models`, not in `DATA_DIR/models`. One default
    for every run is simpler than one per `DATA_DIR`, and it is never inside the repository.
    Review fixes: with `NODE_ENV=production`, `loadConfig` requires `MODELS_DIR`, because a shared
    `/tmp` would let another local user plant the model. The image sets `/app/models`.
    `tests/masked-only` passed offline without the model: an embed failure during indexing only
    logs a warning, and the test does not check the log levels. But `app.db` then holds no
    chunks, so the scan for real values covers less. The test now calls `modelReady()` and
    fails without the model, as the server suite does (`PA_SKIP_MODEL_TESTS=1` skips).

Missing test 2 of the architecture report: done. `chats.test.ts` deletes a chat while its reply
streams and a subagent child runs. It expects no chat row, no `chunks`, `chat_fts` or `chunk_vec`
row, no session file or folder, no unhandled rejection and no error log line. The test found a
bug: `registry.remove` deleted the chat's JSONL but kept `sessions/<user>/<chatId>/sub/` with
the children's masked JSONL. `remove` now deletes that folder too. Review question: can a
child write during its SIGTERM grace time after the folder is gone? No. `drop` awaits Pi's
`abort`, which waits until the run is idle. The run waits for the subagent tool, and the tool
ends only on the child's `close` event. So the child has exited before `rmSync` runs. The test
now checks with `ps` that the child runs before the delete and that no child runs when
`chat.deleted` arrives. No code change was needed. Not covered: the vault scope
(only a fork has its own scope, and `chat.delete` already drops it) and push (off in the test
setup).

Dependency follow-ups (`docs/audits/2026-10-31-dependencies.md`, "Recommended actions"):

- Done. `Dockerfile.server` and `Dockerfile.broker` pin `node:22.23.2-bookworm-slim` by the
  digest of its multi-arch index (`sha256:48e4b67d…`, read with `docker buildx imagetools
  inspect`, no pull). `corepack` is pinned to 0.36.0 (published 2026-08-28), the version that
  `latest` already gave. The line stays: the corepack that Node 22 bundles was not checked
  against pnpm 12 here, and a pin keeps the build as it is.
- Done. `PI_OFFLINE: "1"` for `pa-server` in `infra/compose.yaml`. `config.ts` already sets it in
  the process, and the subagent children get it in their env. The compose value also covers
  code that runs before `config.ts` loads.
- Done. No script or Makefile builds `requirements.lock`; the command lives in the lock header.
  The README ("Dependency policy") now gives the command with a full UTC timestamp
  (`--exclude-newer 2026-10-24T00:00:00Z` as the example). The lock is not rebuilt in this batch:
  a rebuild with the stricter cut-off changes versions, and a version bump is its own change.
- Checked with `docker compose config` and a placeholder env. The images were not built and the
  stack did not run in this batch (no pull). Run the compose smoke before the merge.
- Not done, on purpose: `undici` and `cryptography`. The fixed releases are younger than 7 days.
- Not in scope: `pnpm install` to drop the orphan Pi 1.3.0 folders (local `node_modules` only).
