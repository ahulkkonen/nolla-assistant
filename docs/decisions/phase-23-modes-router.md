# Phase 23: Output modes, prompt placement and the router

Date: 2026-10-29. Follows phase 22 (`phase-22-quick-wins.md`, open). Phase 23 starts after phase 22
merges, because both change `packages/protocol/src/index.ts` and `apps/server/src/bridge.ts`. The
records of phase 15 (editors), phase 20 (queue, panel) and phase 21 (confidence trial) stay valid,
except where this record changes them (section "Changes to earlier records").

## Goals

The user decided these on 2026-10-29:

1. **Output modes ("Tila").** The confidence trial becomes one of several per-chat modes. A mode is
   the file `agents/modes/<id>.md`: frontmatter (`name`, `description`, optional `renderer`) and one
   prompt paragraph. The registry appends the paragraphs of the chat's modes to the system prompt.
   The profile names the default modes (`modes.default`). The mode `suora` holds the user's voice
   and is on by default. Its text, verbatim: "high signal, low noise, low verbosity, direct, honest,
   unfiltered, unhedged, uncensored, match the user's deadpan humor". Luottamus (`confidence`)
   keeps its renderer, gets a legend under the reply and shows N on hover or tap. One "Tila" chip
   with checkboxes replaces the Luottamus chip. The phone sheet gets the same rows. The column
   `confidence` goes; a migration moves `true` to the profile defaults plus `confidence`
   (decision 4).
2. **Placement.** `agents/prompts/assistant.md` keeps only mechanics (tools, masking, figures,
   search, language). Behaviour lives in modes. Facts about the user live in `USER.md`. Skills stay
   in `skills/`. The phase-15 editors edit modes too.
3. **Router.** Paths for every screen of the store. `pushState` on navigation, `popstate` for back
   and forward, the path read on load. `?chat=` keeps working (redirect to `/c/<id>`). Push
   notification links use the path.

Constraints: no new dependency. Pi stays at 1.4.0 (phase-22 decision 10, record 0009). Nothing unmasked reaches the model.
Finnish UI text. Every new control has an accessible name and keyboard access.

## Findings

Lines were read on 2026-10-29 at `d3263f1` (phase 22 server part and Pi 1.4.0 merged). Serena has no language server in this project
(`.serena/project.yml`), so the research used direct reads.

| # | Fact | Where |
| --- | --- | --- |
| F1 | The trial is one boolean column with default false. | `packages/db/src/schema.ts:47`, `packages/db/drizzle/0011_swift_stryfe.sql` |
| F2 | `ChatModel.confidence`, `CONFIDENCE_PROMPT`, the prompt join, `samePolicy` and the default chat. | `apps/server/src/pi/registry.ts:56-67`, `:130-135`, `:180-187`, `:439` |
| F3 | `summary()` sends `confidence`; `chat.setConfidence` evicts during a run; `chat.create` and the fork set it. | `apps/server/src/bridge.ts:159`, `:1052-1056`, `:944-949`, `:893` |
| F4 | `ChatSummary.confidence` and `chat.setConfidence`. | `packages/protocol/src/index.ts:144`, `:782` |
| F5 | Web: `useConfidence`, the phone `ChatSwitches`, the desktop `ConfidenceToggle`, `rehypeConfidence`. | `ModelPicker.tsx:89-94`, `:409-441`; `Composer.tsx:60-78`; `MessageView.tsx:325-358` |
| F6 | `loadAgents` keeps the object of an unchanged profile; the registry rebuilds a session when its profile object changed. `watchAgents` is recursive, so a change under `agents/modes/` reloads. `seedDir` copies sub-folders. | `apps/server/src/agents.ts:25-53`, `:66`; `registry.ts:285-287`; `apps/server/src/seed.ts:23-26` |
| F7 | Pi 1.3.0 exports `parseFrontmatter(content) → { frontmatter, body }`. | `pi-coding-agent/dist/index.d.ts:40` |
| F8 | `assistant.md`: line 1 role, line 3 behaviour ("Selvitä kysymykset perusteellisesti…"), lines 5 and 9 masking, 7 language, 11–15 figures, 17 search, 19 model. It holds no fact about the user. | `agents/prompts/assistant.md` |
| F9 | The editors' writers are inside the route closure and answer through `FastifyReply`. Phase 25 needs them without HTTP. | `apps/server/src/admin.ts:268-327`, `:388-405` |
| F10 | The store has ten screens; Asetukset is a dialog (`settingsOpen`). 21 calls of `setScreen` and `setActive`, plus `openChat` and `runSearch` (`ws.ts:101-111`), change the screen or the chat. | `apps/web/src/store.ts:97-108`, `:218` |
| F11 | Deep links: `?chat=` in `App.tsx`, `push-sw.js` and the file origin link. | `App.tsx:155-172`, `apps/web/public/push-sw.js:27`, `FilesScreen.tsx:366` |
| F12 | The server sends `index.html` for an unknown GET with `Accept: text/html` outside `/api` and `/ws`. The service worker falls back to `index.html` except `/api`, `/ws`, `/healthz`. The asset base is `/`. | `apps/server/src/http.ts:226-235`, `apps/web/vite.config.ts:39` |
| F13 | An edited copy in `DATA_DIR/agents` does not take a new image file. | `seed.ts:73` (phase-16 decision 21) |

## Decisions

### Modes

1. **The mode file.** `agents/modes/<id>.md`. The id matches `^[a-z0-9-]{1,32}$`. The frontmatter
   is `ModeFile` (below): `name` (1–40), `description` (0–200), optional `renderer` (`confidence`
   only). The body is the prompt paragraph (1–4,000 characters). A new `apps/server/src/modes.ts`
   has `loadModes(dir, onError, prev)`: it parses each file with Pi's `parseFrontmatter` (F7) and
   `ModeFile`, keeps the object of an unchanged mode, and keeps the previous version of a bad file,
   as `loadAgents` does. *One loader shape for profiles and modes; no new parser.*
2. **Shipped modes.** Three files. `CONFIDENCE_PROMPT` leaves `registry.ts`; its text moves into
   `confidence.md` unchanged. Line 3 of `assistant.md` moves into `perusteellinen.md` unchanged.

   | id | name | description | renderer | body |
   | --- | --- | --- | --- | --- |
   | `suora` | Suora | Tiivis ja suora, ilman varauksia | – | the user's text above, verbatim |
   | `perusteellinen` | Perusteellinen | Vertailee lähteitä ja kertoo epävarmuudet | – | `assistant.md` line 3, verbatim |
   | `confidence` | Luottamus | Merkitsee jokaisen virkkeen varmuuden 1–9 | `confidence` | `CONFIDENCE_PROMPT`, verbatim |

3. **Profile defaults.** `AgentFile` gets `modes: { default: ModeId[] }` (default empty).
   `agents/assistant.yaml` gets `modes: { default: [suora, perusteellinen] }`. *`perusteellinen`
   keeps today's behaviour; the user can turn it off.* The loader warns about an unknown id; the
   editor refuses it with path `modes.default.<n>`.
4. **What a chat stores.** `chats.modes` is a nullable JSON list. Null means "the profile default"
   at each session build. A list (also an empty one) is the user's choice. *A change of the
   profile default reaches every chat that the user did not change, and the migration needs no
   profile.* The migration sets `["suora", "perusteellinen", "confidence"]` (the profile defaults
   plus confidence) where `confidence` was true and null elsewhere. *Changed on 2026-10-29 from
   `["confidence"]` alone: the migrated chat keeps today's behaviour (`perusteellinen`) and gets
   `suora` like every other chat.* The list is fixed in the SQL, so a later change of the profile
   default does not reach a migrated chat.
5. **The system prompt.** `systemPrompt(profile, ids, modes)` in `modes.ts` returns the profile
   prompt, a blank line, and the bodies of the active modes in id order (not toggle order), joined
   by blank lines. An unknown id (a deleted mode) is skipped. *Id order keeps the prompt bytes
   stable for the provider cache.* In `registry.ts`, `ChatModel.modes: string[] | null` replaces
   `confidence`; `RegistryOptions` gets `modes: () => Modes`; `Entry` stores the built prompt;
   `fresh()` is `samePolicy` (without `confidence`) and the same profile object and the same
   prompt text. So a mode toggle, a mode file edit and a profile edit rebuild an idle session at
   its next `get`, and a running chat keeps its prompt until it settles (phase-15 decision 4).
6. **Changes from the client.** `chat.setModes { chatId, modes }` replaces `chat.setConfidence`.
   The server answers `bad_message` for an id that `modes()` does not hold, writes the row and
   calls `registry.evict`, also during a run, as phase-21 decision 4 did. `chat.create` takes an
   optional `modes`. The fork copies `modes` (`bridge.ts:893`). An automation chat has null, so
   it runs the profile defaults.
7. **What the client knows.** `agents.state` gets `modes: ModeInfo[]` (no bodies) and, per agent,
   its `modes` default. The effective list is `chat.modes ?? agent.modes`. `reloadAgents` in
   `main.ts` loads the modes in the same call and sends `agents.state` when profiles or modes
   changed (the `same` check covers both maps).
8. **The Tila chip.** On screens ≥ 768 px, a chip "Tila" replaces `ConfidenceToggle`. It opens a
   `DropdownMenu` with one `DropdownMenuCheckboxItem` per mode: name (14/20) and description (13/18
   muted). A toggle keeps the menu open. The chip label has one rule at every width and in every
   state: the active names ("Perusteellinen, Suora") when they fit the free width (up to 200 px);
   otherwise exactly one fallback, "Tila · N" (N = the count of modes on). A name is never cut and
   there is no "+N" form. "Tila" when none is on. `aria-label` is "Tila: <names>", or "Tila · N"
   with the names as its description. A short toolbar first turns the off auto-approve chip into
   its shield, then the label into "Tila · N" (UI review 2). During a run `NextTurnTip` wraps it. On phones `ChatSwitches` gets a group
   "Tila" with one `SwitchRow` per mode (description as helper). The chip and the rows work on an
   empty new chat too: the store keeps `pendingModes` and `chat.create` sends it.
   `useModes(chatId)` replaces `useConfidence`; the chip and the sheet share it.
9. **The confidence renderer.** *(Superseded by phase-28 decision 3: the shading and the swatches are gone.)* `rehypeConfidence` stays. It runs when a reply holds markers,
   whatever the chat's modes are now: older replies keep their shading. `renderer` in a mode file
   says that the mode needs a client renderer; the web map is `RENDERERS = { confidence }` and the
   editor refuses any other name. New parts:
   - Each marked span gets a child `<sup class="conf-n">N</sup>`, hidden by default.
   - Hover (hover devices): the N of that sentence shows above its end, absolutely placed (no
     reflow), 11 px tabular, muted. The N sits in a zero-width inline-block anchor `span.conf-a`
     (`position: relative`) right after the full stop, so an absolute child does not follow the
     line breaks of an inline box. Its right edge is 1 px before the full stop's end and its box
     starts at the prose's cap height: a hidden N reserves no width, and with the word space it is
     at least 4 px clear of the next glyph (UI review 2).
   - Tap (touch): a tap on a marked sentence toggles its N (`data-show`), through one click
     handler on the Markdown root. A sentence is not a tab stop.
   - Legend: under a reply with markers, after the text and before the action row (8 px gap):
     "Luottamus" (micro 12/16, muted), nine swatches 12×8 px in the `--conf` colours with "1
     arvaus" and "9 varma" at the ends, and a button "Näytä luvut" (`aria-pressed`): a 28 px pill
     with a 44 px target, as wide on as off (an invisible checked copy reserves the check's width).
     On, every N shows inline as text after its full stop, so a screen reader reads it. The setting is `pa.confN` in
     `localStorage`, like `pa.thinking`.

### Prompt and skills placement

10. **`assistant.md` keeps mechanics.** Line 3 leaves (decision 2). Lines 1, 5, 7, 9, 11–17 and 19
    stay. No fact about the user is in the file, so `USER.md` does not change. Skills stay in
    `skills/`; nothing moves.
11. **Seeding.** `seedDir` copies the new mode files to `DATA_DIR/agents/modes`. A copy of
    `assistant.md` that the user edited keeps line 3 (F13); the server logs "agent file edited by
    user, not updated". The Status section of this record says whether the production copy needs a
    hand edit in Asetukset › Agentit.

### Editors

12. **One set of writers.** `adminWriters(deps)` in `admin.ts` holds `saveAgent(id, body, dry)`,
    `saveAutomation(id, body)`, `saveMode(id, body, dry)` and `deleteMode(id)`. Each returns
    `{ status, body }` or throws `Bad`. The routes call them through `checked` and keep their HTTP
    shape. Mode files are under `agentsDir`, so `commitAgents` versions them. *Phase 25 calls the
    same functions; nothing is written twice.*
13. **Mode routes.** `POST /api/modes`, `PUT /api/modes/:id` (`?dry=1` as for agents) and
    `DELETE /api/modes/:id`. The body is `ModeSave`: the form's fields and the body, or the raw
    file. A new mode without an id gets one from its name with `freeId`. Delete answers `in_use`
    with `agents` when a profile names the mode in `modes.default`. `GET /api/agents` returns
    `modes: ModeDoc[]` and `options.modes`.
14. **The editor UI.** `AgentsScreen` gets a section "Tilat" from a new `ModesEditor.tsx`: one row
    per mode (name, description, badge "Oletus" when a profile names it), "Uusi tila", and a form
    with Nimi, Kuvaus and Ohje (textarea) and, when set, the renderer as read-only text. Delete
    uses `ConfirmDialog`. The agent form gets a checkbox group "Oletustilat". It reuses `Field.tsx`
    and the save and dry-run helpers of the agent form.

### Router

15. **Paths.**

    | Path | State |
    | --- | --- |
    | `/` | `screen: 'chat'`, no chat (a new chat) |
    | `/c/<chatId>` | `screen: 'chat'`, `openChat(chatId)` |
    | `/search?q=<q>` | `runSearch(q)`; without `q`, the search screen |
    | `/topics`, `/memory`, `/files`, `/vault`, `/agents`, `/automations`, `/usage`, `/devices` | that screen |
    | `/settings` | `settingsOpen: true` over the current screen (`/` on load) |

    An unknown path is replaced with `/`. *One path per store screen, as the user asked; the Files
    folder, the memory tab and the panel stay state (no need yet).*
16. **The store is the source.** New `apps/web/src/router.ts` exports `pathOf(state)`,
    `applyPath(url)` and `startRouter()`. A store subscription compares `pathOf` with the location:
    a new pathname gives `pushState`, a new query only gives `replaceState`. `applyPath` sets a flag
    while it changes the store, so a back step never pushes. *No call site and no line of
    `shortcuts.ts` changes.*
17. **Load and back.** Shell's deep-link effect (`App.tsx:155-172`) calls `startRouter()`.
    `?chat=<id>` is replaced with `/c/<id>`. `?integrations=` gives its toast as today, then the
    query goes with `replaceState`. Then `applyPath(location)`. `popstate` calls `applyPath`. A
    `not_found` answer to the `chat.open` of the path replaces it with `/`. When `chat.deleted`
    clears the open chat, the router replaces the path with `/` (no push).
18. **Settings.** Opening the dialog pushes `/settings`. Closing it calls `history.back()` when the
    router pushed that entry, else replaces the path with `pathOf`. Back on `/settings` closes it.
19. **Links.** `push-sw.js` opens `/c/<id>`; an open window still gets `open-chat`. The file
    origin link is `/c/<id>`. Shell sets `document.title` to "<title> · Avustaja", so the history
    menu names each entry. The server and Vite need no change (F12); a server test checks that
    `GET /c/<id>` with `Accept: text/html` answers `index.html`.

## Changes to earlier records

- Phase-21 decision 4: the column, the chip, `chat.setConfidence` and `CONFIDENCE_PROMPT` go
  (decisions 2, 4, 6, 8). The renderer, the floor and `stripConfidence` stay. With "Näytä luvut"
  on, the level is text, which closes the limit "not read by screen readers".
- Phase-15 decisions 3 and 4: `AgentFile` gets `modes`; the writers leave the route closure; the
  editor covers mode files with the same reload and commit.
- `App.tsx:155` (deep links): `?chat=` becomes a redirect to `/c/<id>`.

## Protocol and data changes

```ts
// packages/protocol/src/index.ts
export const ModeId = z.string().regex(/^[a-z0-9-]{1,32}$/);
export const ModeRenderer = z.enum(['confidence']);
/** Frontmatter of agents/modes/<id>.md (phase-23 decision 1). */
export const ModeFile = z
  .object({
    name: z.string().min(1).max(40),
    description: z.string().max(200).default(''),
    renderer: ModeRenderer.optional(),
  })
  .strict();
export const ModeInfo = ModeFile.extend({ id: ModeId });
export type ModeInfo = z.infer<typeof ModeInfo>;
export const ModeBody = z.string().min(1).max(4000);
/** One mode file as the editor gets it; `file` is null when the frontmatter fails. */
export const ModeDoc = z.object({
  id: ModeId,
  file: ModeFile.nullable(),
  body: z.string(),
  raw: z.string(),
  error: z.string().nullable(),
});
export const ModeSave = z.union([
  z.object({ raw: z.string().min(1).max(8000) }),
  z.object({ file: z.record(z.string(), z.unknown()), body: ModeBody }),
]);
// AgentFile: modes: z.object({ default: z.array(ModeId).max(8).default([]) }).strict()
//   .default({ default: [] })
// ChatSummary: `confidence` goes; modes: z.array(ModeId).max(16).nullable()  (null: agent default)
// agents.state: agents[].modes: z.array(ModeId); top level modes: z.array(ModeInfo)
// AgentList: modes: z.array(ModeDoc); options.modes: z.array(ModeId)
// ClientMessage: `chat.setConfidence` goes;
//   z.object({ type: z.literal('chat.setModes'), chatId: id64, modes: z.array(ModeId).max(16) })
//   chat.create: modes: z.array(ModeId).max(16).optional()
```

```ts
// packages/db/src/schema.ts, table chats: `confidence` goes.
// Phase-23 decision 4: the chat's modes; null means the profile's `modes.default`.
modes: text({ mode: 'json' }).$type<string[]>(),
```

Migration `0012_*.sql`: generate it with `drizzle-kit generate`, then put the `UPDATE` between the
two statements by hand:

```sql
ALTER TABLE `chats` ADD `modes` text;
UPDATE `chats` SET `modes` = '["suora","perusteellinen","confidence"]' WHERE `confidence` = 1;
ALTER TABLE `chats` DROP COLUMN `confidence`;
```

## Task cards

One server implementer (S) and one web implementer (W) work in parallel after S1. Every card ends
with `pnpm typecheck` and `pnpm lint`.

| ID | Title | Owner | Model | Files | Tests to write | Acceptance | Order |
| --- | --- | --- | --- | --- | --- | --- | --- |
| S1 | Protocol and column | server | Opus medium | `packages/protocol/src/index.ts`, `packages/db/src/schema.ts`, migration `0012` | protocol: `ModeFile` refuses an unknown key and renderer; `AgentFile` without `modes` parses to `{ default: [] }`; db: a row with `confidence` 1 has `modes` `["confidence"]` after the migration, a row with 0 has null | `tsc` finds every `confidence` user | first |
| S2 | Loader, prompt, registry, bridge | server | Opus medium | new `apps/server/src/modes.ts`, `pi/registry.ts`, `bridge.ts`, `main.ts`, `agents/modes/*.md`, `agents/assistant.yaml`, `agents/prompts/assistant.md` | `modes.test.ts`: frontmatter parse, bad file keeps the previous one, `systemPrompt` order and skip; registry: null uses the profile default, a list overrides it, a mode file edit rebuilds an idle session, a running one keeps its prompt; bridge: `chat.setModes` with an unknown id answers `bad_message`, during a run it writes the row; the fork copies `modes`; `agents.state` lists modes | Tests pass; no `CONFIDENCE_PROMPT` in `registry.ts` | after S1 |
| S3 | Writers and mode routes | server | Opus medium | `admin.ts`, `http.ts`, `admin.test.ts` | the existing admin tests pass unchanged; mode create, update, dry run, delete; delete of a default mode answers `in_use`; unknown renderer answers `bad_message` with path `renderer`; unknown id in `modes.default` answers path `modes.default.0` | Routes call `adminWriters` only | after S1 |
| W1 | Tila chip and sheet | web | Opus xhigh | `store.ts`, `ModelPicker.tsx` (`useModes`, `ChatSwitches`), `Composer.tsx`, `ws.ts` (`createChat` sends `pendingModes`) | `store.test.ts`: effective modes from `agents.state`; e2e: toggle Luottamus in the chip, the menu stays open, the label changes, the next reply has markers; phone sheet rows toggle the same state; a new chat sends `modes` | No `useConfidence`, no `ConfidenceToggle` | after S1 |
| W2 | Legend and N | web | Opus xhigh | `MessageView.tsx` (`rehypeConfidence`, legend), `index.css` or `tokens.css` | unit (`MessageView.test.ts`): spans carry `sup.conf-n`; e2e: hover shows the N without a layout shift; a tap shows it at 390 px; "Näytä luvut" shows all N and axe passes | Copy still strips markers | after W1 |
| W3 | Router | web | Opus xhigh | new `router.ts` (+ test), `App.tsx`, `SettingsDialog.tsx`, `public/push-sw.js`, `FilesScreen.tsx` | unit: `pathOf` and `applyPath` for every row of decision 15; e2e: reload on `/c/<id>` opens the chat; back from Tiedostot returns to the chat; `/?chat=<id>` ends on `/c/<id>`; `/nope` ends on `/`; Esc closes `/settings` and back returns | Server test of decision 19 passes | any time |
| W4 | Mode editor | web | Opus xhigh | new `ModesEditor.tsx`, `AgentsScreen.tsx`, `api.ts` | e2e: create a mode, it shows in the chip; edit its text; delete is refused for a default mode with a Finnish message; "Oletustilat" saves | Flows pass | after S3 |
| P1 | Pixel pass | separate Opus reviewer | Opus xhigh | web files of W1–W4 | none new | Every check below holds at 390, 1024 and 1440, light and dark | after W1–W4 |
| U1 | Blind UI review | UI reviewer | Opus xhigh | screenshots | the screens of the brief | Every cell 4 or 5 | after P1 |

P1 checks: the chip is 32 px high with 12 px side padding and the same type as the model chip; menu
rows are at least 40 px (44 under 768) with 8 px padding; the legend row is 28 px high (UI review 2;
16 px before) with 4 px between swatches; the hover N does not move any glyph (measure the bounding boxes before and after
hover); the phone "Tila" group uses the 44 px `SwitchRow`.

## Test plan

- Unit: the cards above. Also `pnpm --filter @pa/db test` for the migration.
- E2E flows: W1–W4 flows plus the existing confidence and composer flows, rewritten for the chip.
- Screens (`--project screens`): `composer-modes` (desktop, menu open), `sheet-modes` (390 px),
  `confidence-legend` (a reply with markers, "Näytä luvut" off and on), `agents-modes` (the
  editor section), each light and dark.

## UI review brief

The blind reviewer scores `composer-modes`, `sheet-modes`, `confidence-legend` and `agents-modes`
at 390, 1024 and 1440 px, light and dark, against brief section 7 and decisions 8, 9 and 14.

## Gate

1. `pnpm typecheck`, `pnpm lint` and `pnpm test` pass (unit suites and e2e `chromium` flows).
2. `pnpm --filter @pa/e2e exec playwright test --project screens` passes with strict axe.
3. The tests named in the task cards pass.
4. Docker: run `docker system df` first and prune when the Docker disk has less than 10 GB free
   (phase-20 gate item 4). Then build `infra/Dockerfile.server` and run the compose smoke.
5. P1 is done and U1 passes.

## Risks and ceilings

- A chat migrated from the trial has a fixed list, so a later change of the profile default does
  not reach it (decision 4).
- Every mode toggle changes the system prompt, so the next turn misses the provider's prompt cache.
- A user-edited production `assistant.md` keeps line 3 (decision 11).
- The queue (phase 20) lives in one tab; the router adds no cross-tab sync.
- `/settings` on load opens the dialog over an empty chat.

## Status

- **Delete of a mode.** `deleteMode` checks only the `modes.default` lists of the loaded profiles.
  It does not look at the `modes` lists of chats. A chat that still lists the deleted id keeps
  working, because the registry skips an unknown id (decision 5).
- **The migration list.** Migration `0012` writes the same fixed list
  `["suora", "perusteellinen", "confidence"]` to every migrated chat. It does not read the agent of
  the chat, so a chat of another profile gets this list too.
- **The `renderer` field.** Mode files keep the `renderer` field, and the mode editor shows it. The
  web does not use the field to choose a renderer: it shows confidence shading when the reply text
  holds the markers (decision 9).

## UI review 2

The second blind UI review, 2026-10-29. Measured with Playwright Chromium at 390 and 1440 px.

1. **Tila chip.** One label rule (decision 8). Three modes on at 1440 px give "Tila · 3" (a 92 px
   chip); two modes at 1024 px give "Perusteellinen, Suora". The "+N" form is gone.
2. **"Hyväksy automaattisesti".** Off: a ghost 32 px chip with the 16 px `Shield` and the label, or
   the shield alone (32 × 32 px) when the toolbar has no room. The desktop tooltip states the state
   ("Hyväksy automaattisesti: pois" or "päällä"), then what the switch does. On: the warning-tint
   pill with `ShieldAlert`. Phones keep the switch in the model sheet; while it is on, the closed
   row shows the shield in a 28 px `--warning-subtle` circle. An empty new chat has no chip,
   because the setting belongs to a chat that exists.
3. **Waiting line.** See phase-26 decision 4.
4. **"Näytä luvut".** See decision 9: 28 × 103 px on and off, a 44 px target.
5. **Hidden N.** See decision 9: the anchor is 0 px wide. The N is 4.78 px (390) and 5.02 px (1440)
   clear of the next glyph.
6. Badges in the agents list: "Aliagentit käytössä", "Ei aliagentteja", "Virheellinen".
7. The agents list has the 1 px top rule at 390 px, as the modes list.
8. A no-break space joins "välimuisti" and its rate (`withRate`), also in the receipt sheet.
9. Under 768 px the action-row meta has no cache item (the sheet shows it). No item is cut.
10. The cost tooltip writes every label with a colon ("Syöte: 1 234").
11. The tool names in the auto-approve helper and tooltip are mono.
12. "Aihe-ehdotukset" is in the sidebar's nav block under "Tiedostot".
13. The phone top bar of an empty chat has a visually hidden h1, so no visible text repeats the
    name of the ✎ button.
14. Phone action rows: 44 px targets 8 px apart (a 52 px pitch).
15. See item 2.
16. The mode editor's "Esitystapa" label is 14/500, as the field labels.
17. New screen `error-toast-background` (390 and 1440): a model error in a chat that is not open
    gives the toast with "Näytä tiedot".
18. `waiting-queue`, `streaming` and `composer-queue` hold the client's clock. `streaming` and
    `composer-queue` show the active step without the highlight.

## UI review 3

The third blind UI review, 2026-10-29. Measured with Playwright Chromium at 390, 1024 and 1440 px.

1. **Turn spacing on touch.** Each turn except the latest keeps the room of its action row, also
   an older reply (40 px, 48 px under 768 px). Touch shows the row only under the latest turns. In
   `fork-link` at 390 px, the gap from a user bubble to the next reply text is 55 px, and the gap
   from an older reply to the next bubble is 51 px (before: 55 px and 27 px). `chat` has no older
   reply, so its gaps do not change.
2. **Legend at 390 px.** "Luottamus" and the scale are on line 1, "Näytä luvut" is on line 2.
3. **Segmented control.** The kit `TabsTrigger` shows the selected item in `--card` with
   `--shadow-sm` in light, and in `--card` in dark. The agent editor (Lomake/YAML), the mode
   editor (Lomake/Markdown), Muisti and the artifact panel use this one component.
4. **Row pitch.** The agents list and the modes list have 56 px rows. A mode description has one
   line with an ellipsis. An error keeps two lines.
5. **Agents list at 390 px.** The badge is under the meta line, so `zdr/strong` shows in full. The
   row is 80 px high.
6. **`waiting-queue`.** The test holds each server frame after the `sent` phase until after the
   shot. All four shots show "jonossa 12 s".
7. **Receipt sheet.** `SEP` (" ·" and a no-break space) joins the meta items, also in `withRate`.
   No line ends in "·".
8. **`message-meta`.** The 1024 px shot also hovers the cost, so the tooltip shows.
9. **Cost tooltip.** Under the latest reply, the tooltip opens below the action row
   (`side="bottom"`, `sideOffset` 8).
10. **Toast.** A no-break space joins "epäonnistui" and the status, so "(400)" stays on the line of
    its word. The close button is a 28 px ghost icon button 16 px from the right edge, inside the
    toast (a 44 px target on phones). The error icon is `CircleAlert` 16 in `--destructive`, as in
    the inline alert. In the 360 px toast the title now has two lines, because the close button
    takes room inside the toast.
11. **Drawer row.** The fork and lock marks follow the title (6 px from the text) at 14 px, muted.
    Only ⋯ is at the row end, and the marks stay 8 px or more from it. The button's `::after`
    keeps the full row as the target, and the focus ring goes around the row. The docked sidebar
    does not change.
12. **Model sheet.** The header has the 44 px "Sulje" × of the receipt sheet (`SheetCloseButton`,
    also the kit sheet's own close button).

Not changed, decided before:

- Tool rows keep the type icon next to the status icon (phase-21 decision 5, the user's ask).
- The phone error alert keeps two equal outline buttons (decision of UI review round 1).

## UI review 4

The fourth blind UI review, 2026-10-29. Measured with Playwright Chromium at 390 and 1440 px.

1. **Background error.** The toast of a failed reply in a chat that is not open has a
   description line (meta 13/18, muted): "Keskustelu ”Hei”", from the sidebar label of the chat
   (its title, else its first user line), else "Keskustelu". The title stays 14/20 500. The
   chat's sidebar row shows `CircleAlert` 14 px in `--destructive` (tooltip "Mallikutsu
   epäonnistui") until the chat opens (`chat.state`) or a new turn starts. The mark is client
   state only (`failedAway`); the server does not change.
2. **Phone action rows.** The outer 44 px target moves out by its 14 px inset: the first glyph
   of a reply's row starts at x 16, and the last glyph of a user turn's row ends at x 374 (390 px).
   The pitch stays 52 px.
3. **Agents YAML.** Under 768 px the field has 24 px lines (16 px text) and `pre-wrap`, so a long
   line wraps and keeps its indentation. At 768 px and up it stays 13/20 with no soft wrap.
4. **`waiting-queue`.** The screens fixture turns the `.sweep` highlight off for every shot, so
   both schemes show the active step flat.
5. **Receipt sheet.** The meta runs up to the edge of the × button (no gap), so the 390 px meta
   has one line. Each item carries its "·" in a 12 px box, and the row starts 12 px left of the
   clipped line, so a wrapped line starts with an item and no line starts or ends with "·".
6. **Model sheet, empty chat.** The header row has the label "Malli ja ajattelu" (14/20 500)
   next to the ×.
7. **Auto-approve helper.** The sheet's switch helpers use `text-wrap: pretty`; "bash" is not
   alone on the last line.
8. **Toast.** "Tätä tiedostotyyppiä ei voi liittää. Liitä PDF tai kuva." (56 characters). No-break
   spaces keep the advice on one line.
9. **Counters.** One fi-FI formatter (`count` in `thread.ts`) for the memory counters
   ("61 / 1 500", a no-break space), the message meta and Käyttö.

Not changed:

- The dark mono weight. It is a change to the brief's table; a later typography pass decides it.
- Tool rows keep the type icon (phase-21 decision 5), and the phone error alert keeps its two
  buttons (UI review 1).
