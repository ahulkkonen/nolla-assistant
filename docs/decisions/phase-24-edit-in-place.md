# Phase 24: Edit in place with versions

Date: 2026-10-29. Follows phase 23 (`phase-23-modes-router.md`). The harness tools and the link
fetch are a separate phase (`phase-25-harness-tools.md`): they share no code path with this phase.
The records of phase 13 (fork, thinking, usage), phase 17 (claims) and phase 20 (queue, panel) stay
valid, except where this record changes them.

## Goal

"Muokkaa" on a user message makes a new version of that message inside the same Pi session and
sends the edited text. The thread shows the newest version. The edited message shows a switcher
"‹ 1/2 ›" that moves between versions. `chat.state` carries the versions. Search, export, topics,
claims and usage each read a stated branch. "Haarauta" (a new chat) stays as a second action.

Constraints: no new dependency, no new table. Masked-only sessions (plan section 2, invariant 1):
no entry passes the sidecar again, except the restore that `user.retry` already does. Finnish UI.

## Findings

Repository lines were read on 2026-10-29 at `d3263f1`. Pi facts were read in 1.3.0 (`pi/` =
`node_modules/.pnpm/@earendil-works+pi-coding-agent@1.3.0_*/node_modules/@earendil-works/
pi-coding-agent/dist/core`) and compared with the 1.4.0 install of the `p25-pi` worktree:
`session-manager.js` is identical, the body of `navigateTree` is identical (1.4.0 line 3261), and
the agent loop changes only its request identity. Card S0 proves the facts in `tests/contract`.

| # | Fact | Where |
| --- | --- | --- |
| P1 | A session is an append-only tree in one JSONL file. The leaf is in memory only. When a file opens, the leaf is the last entry in file order. | `pi/session-manager.js:732-752` (`_buildIndex`) |
| P2 | `SessionManager.branch(id)` moves the leaf and nothing else; the agent's context does not change. `AgentSession.navigateTree(id)` moves the leaf, refreshes the context (`_refreshFinalizedContext`, `_restoreToolsFromTranscript`) and throws while a reply streams or a compaction runs. For a user message (or a `custom_message`) target, the new leaf is its parent, or no leaf at the root; for any other entry, the target itself. | `pi/session-manager.js:1161-1173`; `pi/agent-session.js:3232-3236`, `:3336-3365` (1.3.0) |
| P3 | `getChildren(id)` returns the children in file order. `getBranch(fromId)` returns the path from the root to `fromId`. A `custom` entry (`appendCustomEntry`) never enters the model context. | `pi/session-manager.js:1014-1022`; `session-manager.d.ts:71-85`, `:311` |
| R1 | `user.retry` already rewinds in place: `rerun` restores the text, picks the target (the parent when the user entry is the leaf), calls `navigateTree`, prompts, and puts the old leaf back when the input hook drops the text. | `apps/server/src/bridge.ts:730-767` |
| R2 | The fork restores the edited entry and cuts its document blocks and images (`resend`, `splitBlocks`, `filesOf`). | `bridge.ts:682-692`, `:833-859` |
| R3 | `pi-ext-pseudo` appends a `pseudo-spans` custom entry before each user message, so the parent of a user entry is often a custom entry. `pi-ext-memory` adds `custom_message` entries after it. | `packages/pi-ext-pseudo/src/index.ts:69`; `packages/pi-ext-memory/src/index.ts:140-197` |
| R4 | Every reader takes `getBranch()`: `history`, `transcript`, the export (`registry.reader`, which opens the file when the session is not open), the claims sweep (`main.ts:285-291`), the artifact save (`tree.ts:240-249`). | `bridge.ts:168-175`, `:1655-1697`; `registry.ts:314-323` |
| R5 | `indexChat` reindexes a chat whole when the branch no longer holds the last indexed message. | `apps/server/src/search.ts:48-52`, `:92-93` |
| R6 | The claims extraction marks a chat read, without extraction, when its marker is not on the branch. | `apps/server/src/claims.ts:529-535` |
| R7 | Web: "Muokkaa" opens `EditBox`, whose only send action is "Haarauta". The retry flow keeps its thread until `agent.status: running`, then rewinds (`retryIntent`). | `MessageView.tsx:519-568`; `Thread.tsx:337-348`; `apps/web/src/ws.ts:24`, `:174-190`, `:244-254` |
| R8 | The panel logic `adopt` treats artifact ids that a `chat.state` adds as new, and opens the panel for a new page. | `apps/web/src/store.ts:348-368` |

## Decisions

### What a version is

1. **Versions are sibling user entries.** The anchor of a user entry is its nearest ancestor that is
   not a `custom` entry (it skips `pseudo-spans` and `pa-leaf`, R3), or null at the root. The
   versions of a message are the user entries with the same anchor, in file order. Entries with the
   same masked text count as one version, at the place of the first one; a switch goes to the
   newest of them. *Pi's tree already holds every version; no new storage. A retry (R1) makes a
   sibling with the same text, so it does not show as a version.*
2. **The newest branch of a version** is found by following the last child (P3) from the version's
   entry down to an entry without children (`newestLeaf`).
3. **The shown branch is in the file.** A switch appends a custom entry `pa-leaf` (`data: {}`) at
   the new leaf. When the file opens again (eviction, restart, the export's reader), its last entry
   is on the shown branch (P1). An edit needs no marker: its new entries are the last ones. *Every
   reader (R4) then reads the same branch with no change; no column to keep in step.*
4. **Code.** New `apps/server/src/versions.ts`: `anchorOf(byId, entry)`, `versionsOf(sm)` (one pass
   over `getEntries()` with a children index; returns entry id → `{ index, count, ids }` for the
   user entries of the shown branch) and `newestLeaf(children, id)`. `history()` sets
   `Message.versions` from it.

### Edit

5. **Message and checks.** "Lähetä" in the edit box sends `chat.edit { chatId, messageId, text,
   localId }` (the shape of `chat.fork`). The server answers `held` while a message waits for the
   vault, `failed` while `registry.running(chatId)` is true (a run, a held prompt or a subagent
   child) and `bad_message` when `messageId` is not a user entry on the shown branch.
6. **Shared steps, extracted.** From `forkFrom`, `editedPrompt(src, branch, at, edited, text)`
   returns `{ text: text + blocks, images }` or `pseudo_down` (R2); the fork and the edit call it.
   From `rerun`, `rewindAndPrompt(chatId, session, entry, sent, localId)` holds lines 736–766: the
   leaf check after the await, the target rule, `navigateTree`, `approvals.cancel`, `join`,
   `promptOrFail` and the restore of the old leaf on a dropped prompt; `rerun` and the edit call it.
   The edit runs under `registry.hold`, as `retry` does.
7. **The old version stays.** Nothing is deleted or copied. The session id does not change, so the
   sidecar keeps its span scope: no `/session/fork` call (phase-13 decision 3 is for new files).
8. **The client.** `editMessage(chatId, messageId, text)` in `ws.ts` sets the intent that
   `retryIntent` already is, with `edit: { text, count }`. The edit box stays open and busy. On
   `agent.status: running` of that chat, the store rewinds to before the edited message and adds
   the local message with `versions: { index: count + 1, count: count + 1 }` (`count` is the old
   `versions.count`, else 1). On an `error` of that chat, the box stays open with the text and the
   toast shows. `message.accepted` gives the entry id.

### Switch

9. **Message and steps.** "‹" and "›" send `chat.version { chatId, messageId, index }`. Checks as
   in decision 5; `index` must be a version of `messageId`. The server finds `newestLeaf` of that
   version. A leaf that is a user entry (a version without a stored reply) answers `bad_message`,
   because `navigateTree` would land on its parent (P2). Else `navigateTree(leaf)`, then
   `appendCustomEntry('pa-leaf', {})`, then `chat.state` with `switched: true` to the room, so every
   open tab shows the same branch. Then `indexChat` runs in the background.
10. **The switcher.** In the action row of a user message with `versions`, first item: icon buttons
    `ChevronLeft` "Edellinen versio" and `ChevronRight` "Seuraava versio" (32 px, 44 under 768)
    around "1/2" (13/18 tabular, muted), group label "Versio 1/2". This action row stays visible
    without hover. The ends disable the buttons. During a run in that chat both buttons are
    disabled with the tooltip "Odota, että vastaus valmistuu". After a click the group is
    `aria-busy` until the `chat.state`; the thread keeps its scroll position on the edited message.
11. **The edit box.** Buttons: "Peruuta" (ghost), "Haarauta" (outline), "Lähetä" (primary).
    Cmd/Ctrl+Enter sends. Hint: "Lähetä tekee viestistä uuden version tähän keskusteluun. Haarauta
    aloittaa uuden keskustelun." Without an entry id both buttons wait, as today.

### A turn, the queue, artifacts and the panel

12. **Running turn.** Edit and switch need an idle chat. The UI hides "Muokkaa" while a reply
    streams (as today) and disables the switcher; the server check of decision 5 is the guard.
13. **Queue.** The queued message (phase-20 decision 17) exists only while the chat runs, so it
    cannot meet an edit or a switch. It goes at idle into the shown branch.
14. **Artifacts and the panel.** A `chat.state` with `switched` adopts its artifact list with no new
    ids (`adopt(st, chatId, list, true)`): the panel never opens on a switch; an open artifact that
    left gives way to its twin or the panel closes (R8). `rewind` (edit and retry) keeps only the
    chat's artifacts whose content is in a kept message and closes a panel whose artifact went.
    "Tallenna työkansioon" reads the shown branch (`findArtifact`).
15. **Model and modes.** The edited turn runs on the session that `registry.get` gives, so a model or
    mode change made before it applies (phase-20 decision 15, phase-23 decision 5).

### Which branch each reader reads

16. | Reader | Branch | Change |
    | --- | --- | --- |
    | `chat.state`, `history` | shown | `versions` on user messages |
    | Chat export (JSON, Markdown) | shown | JSON `version` per edited message; Markdown adds "(versio 2/3)" after the role line |
    | Search index, `recall` | shown | a switch calls `indexChat`; an edit reindexes at the next `agent_settled` (R5) |
    | Title and topic job | shown, at `agent_settled` | a switch does not retitle |
    | Claims sweep | shown, at the sweep | decision 17 |
    | Usage | per reply: shown; chat and month totals: every branch | none: money spent on an old version stays spent |
    | Fork ("Haarauta") | the shown path | none |
    | Thinking text | the entry, any branch | none |

17. **Claims from the branch point.** `extract` no longer marks a chat read when its marker left
    the branch (R6). The sweep's `messagesOf(chatId, through)` in `main.ts` returns `{ messages, at
    }`: `at` is the index of the last branch message on `sm.getBranch(through)`, so the extraction
    reads the messages after the branch point. Claims taken from an older version stay; the user
    reviews them in Muisti › Havainnot. *No duplicate claims after "edit, extract, switch back":*
    the switch back reads the old messages again from the branch point, but `duplicateOf` refuses
    every claim whose normalised text (or vector, within `SAME_DISTANCE`) equals a stored claim of
    the user, whatever its chat or status. An open match is confirmed instead (`timesSeen` + 1, one
    more evidence row); a rejected or superseded match writes nothing. The extraction also sends
    the similar stored claims to the model, which answers with confirms. ponytail: a re-read can
    count a confirm twice; a per-message evidence check when `timesSeen` starts to matter.

## Changes to earlier records

- Phase-13 decision 1: "Muokkaa" edits in place; "Haarauta" is the second button of the edit box.
  The hint text of `EditBox` changes (decision 11). Decisions 2–7 (the fork) do not change.
- Phase-17, the marker rule in `claims.ts:529-535`: replaced by decision 17.
- Phase-20 decision 13: a `chat.state` with `switched` adds no new artifact ids (decision 14).

## Protocol and data changes

```ts
// packages/protocol/src/index.ts
/** Phase 24: the place of a user message among its versions; set only when count > 1. */
export const Versions = z.object({ index: z.int().min(1), count: z.int().min(2) });
// Message: versions: Versions.optional()
// chat.state: switched: z.boolean().optional()   (true: the answer to `chat.version`)
// ChatExport.messages[]: version: Versions.optional()   (ChatExport stays version 1)
z.object({
  type: z.literal('chat.edit'),
  chatId: id64,
  /** A user message entry on the chat's shown branch. */
  messageId: id64,
  text: z.string().min(1).max(100_000),
  localId: z.string().max(64).optional(),
}),
z.object({ type: z.literal('chat.version'), chatId: id64, messageId: id64, index: z.int().min(1).max(1000) }),
```

No database change. New session entry: `{ type: 'custom', customType: 'pa-leaf', data: {} }`.

## Task cards

S0 lands first. Every card ends with `pnpm typecheck` and `pnpm lint`.

| ID | Title | Owner | Model | Files | Tests to write | Acceptance | Order |
| --- | --- | --- | --- | --- | --- | --- | --- |
| S0 | Pi tree contract | server | Opus medium | `tests/contract/src/` (new spec) | on the pinned Pi: leaf is the last file entry after `open`; `navigateTree` to a user entry leaves the leaf on its parent and refreshes `session.messages`; to an assistant entry, on it; it throws while streaming; `getChildren` keeps file order; a `custom` entry is not in `buildSessionContext()` | Contract suite passes | first |
| S1 | Protocol | server | Opus medium | `packages/protocol/src/index.ts` (+ test) | `chat.edit` and `chat.version` parse; `Versions` refuses count 1 | Tests pass | after S0 |
| S2 | Versions, edit, switch | server | Opus medium | new `apps/server/src/versions.ts` (+ test), `bridge.ts`, `bridge`/`thread` tests | `versions.test.ts`: anchor skips `pseudo-spans` and `pa-leaf`; root siblings; equal texts are one version at the first place; `newestLeaf`; bridge: an edit keeps the old branch in the same file and `chat.state` gives `{ index: 2, count: 2 }`; the edited turn carries the original images and document blocks; edit and switch answer `failed` during a run and `held` while held; a dropped prompt puts the old leaf back; a switch, an eviction and a new `registry.get` keep the shown branch; `switched` goes to every socket of the room; `rerun` tests pass unchanged | Tests pass; `rerun` and the fork use the extracted helpers | after S1 |
| S3 | Readers | server | Opus medium | `claims.ts`, `main.ts`, `export.ts`, their tests | claims: after an edit, the extraction reads the new messages from the branch point; export: the shown branch with `version` and "(versio 2/3)"; search: a switch reindexes to the shown branch | Tests pass | after S2 |
| W1 | Edit box and edit flow | web | Opus xhigh | `MessageView.tsx` (`EditBox`), `Thread.tsx`, `ws.ts`, `store.ts` (`rewind` prunes artifacts) | `store.test.ts`: rewind drops artifacts of removed messages and closes their panel; e2e: edit a message, the reply streams, the switcher shows 2/2; a refused edit keeps the box open with the text; "Haarauta" still opens a new chat | Flows pass | after S1 |
| W2 | Switcher | web | Opus xhigh | `MessageView.tsx`, `Thread.tsx`, `ws.ts`, `store.ts` (`switched`) | e2e: ‹ shows version 1 and its old reply; a reload keeps version 1; the buttons are disabled during a reply; a switch never opens the panel; an open panel closes when its artifact leaves | Flows pass | after W1, S2 |
| P1 | Pixel pass | separate Opus reviewer | Opus xhigh | web files of W1–W2 | none new | Checks below at 390, 1024 and 1440, light and dark | after W2 |
| U1 | Blind UI review | UI reviewer | Opus xhigh | screenshots | the screens below | Every cell 4 or 5 | after P1 |

P1 checks: the switcher buttons are 32 px (44 × 44 under 768) with 4 px gap (8 under 768); "1/2"
sits on the 32 px row baseline; the edit box buttons are 36 px (44 under 768) with 8 px gap and
right-aligned; the user turn keeps its 40 px gap (48 on phones) with the always-visible row.

## Test plan

- Unit and contract: the cards above.
- E2E flows: W1 and W2, plus the existing fork, retry and queue flows unchanged.
- Screens: `thread-versions` (an edited message at 2/2 with the switcher, desktop and 390 px) and
  `edit-box` (the open edit box with three buttons), light and dark.

## Gate

1. `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm test:contract` pass.
2. `pnpm --filter @pa/e2e exec playwright test --project screens` passes with strict axe.
3. The tests named in the task cards pass.
4. Docker image and compose smoke as phase-23 gate item 4.
5. P1 is done and U1 passes.

## Risks and ceilings

- Another open tab keeps its old thread after an edit until it opens the chat again, as it does
  today for any message sent from another tab. A switch updates every tab (decision 9).
- `versionsOf` walks every entry of the session for each `chat.state`. ponytail: one pass, O(n);
  cache per session when a long chat makes `chat.open` slow.
- A switch reindexes the whole chat (R5): seconds of CPU for a very long chat.
- A version whose newest entry is a user message (no reply stored) cannot be shown (decision 9).
  The same holds when the newest entry is a `custom` entry (a `pseudo-spans` entry of a failed
  reply) whose nearest conversation ancestor is a user message.
- Claims from an older version stay active until the user reviews them (decision 17).
- A later Pi version that changes P1–P3 fails S0 first; then this record needs an update.
