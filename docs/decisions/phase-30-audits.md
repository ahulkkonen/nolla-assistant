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

Open. Batch A is done on the branch `p30-sec` (2026-10-31). Batch B is not started.

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

Batch B, per item (branch `p30-b2` holds 8, 11, 12, 13 and the dependency follow-ups):

8. Done. A refused `chat.create` or a close before `chat.created` rejects the wait in `ws.ts`.
   `sendUserMessage` then gives the text and the files back as a `draft` with `chatId: null`
   (the new-chat composer). A refusal shows the toast of its code; a close shows "Viestin
   lähetys epäonnistui.". The server does not echo a request id for `chat.create`, and the fix
   must not touch `bridge.ts` while the split runs. So the next error without a `chatId`
   answers the oldest wait, the same send order that `chat.created` already uses. A refused
   create never names a chat. Follow-up after the split: a `localId` on `chat.create`, echoed in
   `chat.created` and in the error.

Left as they are in batch A, on purpose:

- The backup service holds `PSEUDO_VAULT_KEY`, because a consistent copy of the SQLCipher vault
  needs the key. It already holds `app.db` and the memory files with real values.
- `docs/plan.md` still describes Litestream. This record supersedes it.
