# Phase 4 — Titles, topics, search, related chats, backups

Gate (plan §13): a fresh VPS restored from the bucket serves yesterday's chats (drill run locally
against a MinIO or local restic repository until the VPS exists); titles appear within 5 s of
`agent_settled`; search returns the right chat for 20 scripted queries.

Gate command: `pnpm typecheck && pnpm lint && pnpm test && scripts/restore-drill.sh`

## Decisions

1. **Titles and topics** (plan §8): `pi-ext-topics` listens to `agent_settled` and posts a job to the
   server's in-process queue; the job calls the LiteLLM alias `zdr/task-small` through Pi's
   `streamSimple`-equivalent **or**, simpler, through a direct `fetch` to `LITELLM_URL` from the
   server process (same egress URL, same key; invariant 2 holds). Decision: direct `fetch` from
   `apps/server/src/topics.ts`; no second Pi session per title. Input is the masked transcript tail
   (≤ 2K tokens) read from the session JSONL plus the topic list. Output validated with zod. Title is
   stored masked and restored (`chats.titleMasked`, `chats.title` via `/unmask`).
2. **Summaries** (plan §7/§8): the same call returns `summary` (3–5 sentences, masked). Stored in
   `chats.summary` (masked) and indexed in `chat_fts` (`kind = summary`) and in the vector table.
3. **Search** (plan §8): FTS5 trigram over titles, summaries and transcript chunks (~400 tokens,
   masked text; the search query is masked through `/mask` before `MATCH`, results are restored
   through `/unmask` for display). `search.query` returns `{ chatId, messageId, title, snippet, score }`.
4. **Related chats and recall vectors**: `sqlite-vec` 0.1.9 loaded into the same `app.db`;
   embeddings from `Xenova/multilingual-e5-small` (int8 ONNX) through `@huggingface/transformers`
   4.3.1 in the server process, computed on masked text. Model files are downloaded at image build
   time into `/app/models` (no runtime network). Related = top 3 kNN over summaries above cosine 0.6.
5. **Backups** (plan §4): `litestream/litestream:0.5.17` replicating `app.db` and `vault.db` to the
   S3 bucket, `restic/restic:0.19.1` nightly snapshot of `/data` at 03:00 Europe/Helsinki with
   `keep-daily 14, keep-weekly 8, keep-monthly 6`. `scripts/restore.sh` restores both from the bucket
   onto an empty `/data`. The local drill uses a MinIO container (or a local restic repo when MinIO
   is unavailable) and proves a chat created before the drill opens after it.
6. **Topic taxonomy**: user-owned topics in `topics`; proposals in `topicProposals`; inbox actions
   accept / rename / merge. "Automations" topic is created on demand in phase 5.

## Task cards

| # | Task | Owner | Files | Acceptance |
|---|---|---|---|---|
| 1 | Titles, topics, summaries job + `topic.*` handlers + `chat.titled` | Opus | `packages/pi-ext-topics`, `apps/server/src/topics.ts`, `bridge.ts`, `packages/db` | test: after a scripted turn the client gets `chat.titled` within 5 s; title masked in db, restored on the wire; proposal lands in inbox; accept creates the topic |
| 2 | Search (FTS5 indexing + query) and related chats (sqlite-vec + e5-small) | Opus, after 1 | `apps/server/src/search.ts`, `embeddings.ts`, `packages/db` | 20 scripted queries over 25 seeded chats return the right chat at rank 1 for ≥ 18; related chats for a seeded chat lists its two neighbours |
| 3 | Backups: Litestream, restic, `scripts/restore.sh`, `scripts/restore-drill.sh`, compose services | Sonnet | `infra/`, `scripts/` | drill passes locally against MinIO |
| 4 | Web: topics groups in sidebar, topic inbox screen, search results, related chats row, title rename lock | Opus + UI review, after 2 | `apps/web`, `tests/e2e` | UI review pass; e2e flows for search and inbox |
