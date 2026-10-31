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
   The backup service now snapshots `app.db` and `vault.db` hourly (tags `app`, `vault`) and all
   of `/data` nightly, WAL files included. `scripts/restore.sh` restores the nightly snapshot,
   then the newest hourly snapshot of each database.

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

Open. Batch A started 2026-10-31 on the worktree `/tmp/pa-p30-sec`.
