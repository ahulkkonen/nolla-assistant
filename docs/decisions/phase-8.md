# Phase 8 — Memory

Gate (plan §13): `recall` finds a fact stated in a chat from the previous week; a memory write from
a tainted turn waits for approval; the weekly consolidation produces a reviewable diff.

Started early (2026-10-25) in parallel with phases 6–7 because it shares no files with them; the
gate is evaluated in order after phases 6 and 7.

## Decisions

1. **Files**: `DATA_DIR/memory/<userId>/USER.md` (≤ 1,500 chars) and `MEMORY.md` (≤ 2,500 chars),
   real values, hand-editable, git-tracked in that directory (`git init` once; one commit per write
   with the chat id in the message; `git` is installed in the server image). Masking happens at
   injection through `/mask`, byte-stable per turn (the masked text is cached by file mtime).
2. **Injection** (`pi-ext-memory`, `before_agent_start`): one `message` with `USER.md`, `MEMORY.md`
   and "Viimeisimmät keskustelut: <three titles>" in a fixed template, ~1.3K tokens, so prompt caching
   holds. Tool `recall(query, since?, topic?)` = hybrid search from `apps/server/src/search.ts`
   (FTS5 + vec over `chunks`, RRF) returning ≤ 5 snippets with chat ids and dates; the query arrives
   masked, `tool_call` restores it, results are masked again at `tool_result` (both already handled by
   `pi-ext-pseudo` order). Tool `memory(action: add | replace | remove, target: user | memory, text)`
   with the caps; an over-cap write returns an error telling the agent to consolidate.
3. **Taint**: a turn is tainted when any `tool_result` in it came from an untrusted tool (`bash`,
   `read` of a file under `files/`, `recall`, any `mcp__*`, `subagent`). The tainted flag resets at
   `agent_start`. A `memory` call in a tainted turn is parked in `memoryPending` and the tool returns
   "odottaa hyväksyntää"; `memory.approve` applies it. Writes from untainted turns apply at once and
   the bridge sends a `memory.state` so the PWA can show a diff chip.
   Taint is an allowlist: only `memory` and a `read` of a real path inside the workspace and not
   under `files/` keep a turn clean; a prompt with an inlined attachment (`[Liite: ...]`) starts
   tainted. Known ceiling: taint is per turn, so text that an earlier turn brought into the
   history can still steer a later untainted `memory` call. At most 5 pending writes per chat.
   The memory message is injected only when its content changed since the last injection in the
   session (always on the first turn). Without `PSEUDO_URL` memory is disabled (fail closed).
4. **Consolidation**: weekly (`0 4 * * 1` Europe/Helsinki, `node-cron`) and on demand: a
   `zdr/task-small` call over the **masked** files proposing a new USER.md/MEMORY.md; stored in
   `memoryConsolidations` as a unified diff (restored for display); accept / edit / reject in the
   memory screen.
5. **Summaries** already exist (phase 4) and are indexed; `recall` searches them and the transcript
   chunks. No per-turn extraction service.

## Task cards

| # | Task | Owner | Files | Acceptance |
|---|---|---|---|---|
| 1 | `pi-ext-memory` (injection, `recall`, `memory`, taint), server wiring, `memory.*` handlers, consolidation job | Opus | `packages/pi-ext-memory`, `apps/server/src/memory.ts`, `bridge.ts`, `registry.ts`, `packages/db` (`memoryConsolidations`) | tests: injected message is masked and byte-stable across two turns; `recall` finds a seeded fact from a chat dated 8 days ago; a `memory` write in a tainted turn lands in `memoryPending` and applies after `memory.approve`; an over-cap write errors; consolidation produces a diff |
| 2 | Memory screen (two editors with counters, pending writes, consolidation diff) | Opus + UI review, after 1 | `apps/web`, `tests/e2e` | UI review pass |

## Status (2026-10-25)

Tasks 1 and 2 are done. Commits: `f94d7b6` (server, `replace` field), `a222eb4` (web).

Gate checks in `packages/pi-ext-memory` and `apps/server/src/memory.test.ts`: the injected
memory message is masked and byte-stable across turns; `recall` finds a seeded fact from a chat
dated 8 days ago; a write in a tainted turn parks in `memoryPending` and applies after
`memory.approve`; an over-cap write is refused; consolidation produces a diff with `baseHash`.

Web: the memory screen shows two editors with counters, pending writes with a diff, the
consolidation proposal, and a chat chip for each memory change. Unsaved drafts block
navigation until confirmed. The UI review verdict is recorded in `phase-7.md`.
