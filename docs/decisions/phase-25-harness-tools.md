# Phase 25: Harness tools and the link fetch

Date: 2026-10-29. Follows phase 24 (`phase-24-edit-in-place.md`). This is its own phase, not a
part of phase 24: it changes the approval gate, the admin writers and the egress of `pa-server`,
and none of these are in phase 24. It needs phase 23 (the writers `adminWriters` and the mode
files). The records of phase 14 (web search guard), phase 15 (editors) and phase 21 (auto-approve)
stay valid, except where this record changes them.

## Goals

1. Three Pi tools that the model may call: `profile_edit` (the system prompt file and the mode
   files; the card shows a unified diff), `automation_edit` (create or change an automation; the
   card shows the YAML) and `chat_read` (one earlier chat by id or by title, masked like `recall`,
   capped in size). Each one is in `approval.always`, is refused in automation runs and reuses the
   phase-15 validation and writers. `skills_edit` only if the same writer covers it cheaply.
2. The approval card variants, the audit trail (a git commit per accepted change) and the defence
   against a tool result that asks the model to change its own prompt.
3. Fetching a link: widen `web-digest` to `internet` behind the bash card, or add `fetch_url`.
   Prefer the smaller change.

Constraints: no new third-party package (decision 11 reuses one that is already installed).
Masked-only sessions (plan section 2, invariant 1). Skills only from this repository (invariant 7).

## Findings

Lines were read on 2026-10-29 at `d3263f1`.

| # | Fact | Where |
| --- | --- | --- |
| H1 | The gate lets an automation run every tool of its `autoApprove` list (`auto.includes(tool)`). The chat toggle runs `approval.always` minus MCP writes and `web_search`. Subagent children get the profile tools minus `memory`, `recall`, `web_search`. | `apps/server/src/approval.ts:67-69`; `apps/server/src/pi/registry.ts:303-308`, `:507-509` |
| H2 | The registry already forces MCP write tools into `always` and out of `never`. | `registry.ts:416-421` |
| H3 | A blocked tool call skips `afterToolCall`, so `pi-ext-pseudo` never masks a block reason; the reason goes into the session as written. Same code in Pi 1.4.0. | `pi-agent-core/dist/agent-loop.js:386-392`, `:507-516` (1.3.0) |
| H4 | The profile prompt goes into the system prompt unmasked; only the `context_with_system` scan masks a vault name there, and it logs a leak. Mode bodies join it in phase 23. | `registry.ts:439`; `packages/pi-ext-pseudo/src/index.ts:129-164` |
| H5 | `recall` restores its snippets; `tool_result` then masks them in the calling session. Masked text from another session would be masked a second time (phase-13 research 6). | `apps/server/src/search.ts:255`; `apps/server/src/memory.ts:212-233` |
| H6 | The turn taint is in the closure of `memoryExtension`; `cleanTool` is exported. | `packages/pi-ext-memory/src/index.ts:60-77`, `:115-138`, `:199-210` |
| H7 | The web search guard records the masked query before `pi-ext-pseudo` and compares the restored one after it. | `apps/server/src/search-tool.ts:202-268` |
| H8 | `gitCommitter` commits a folder under `DATA_DIR`; in development `agents/` is the repository's own. | `apps/server/src/git.ts:16-41`; `admin.ts:162-166` |
| H9 | `diff` 8.0.4 is in the lockfile as a Pi dependency (`createTwoFilesPatch`). | `pi-coding-agent/package.json` |
| H10 | `web-digest` does not run in chats: `assistant.yaml` has no `skills` key, so the session loads no skill (`noSkills`), and the registry never passes `skill` to `sandboxExtension`, so the broker always uses `network: none`. Phase-22 decision 9 (`internet`, commit `fed47d9`, merged) changed only the frontmatter. | `registry.ts:442`, `:486-491`; `packages/pi-ext-sandbox/src/index.ts:19`, `:52`; `services/sandbox-broker/src/index.ts:81-83` |
| H11 | A runner mounts the work dir, which holds real values (phase-11 decision 7). `bash` is in the auto-approve list. | `services/sandbox-broker/src/index.ts:104-106`; H1 |
| H12 | The broker's `PRIVATE` block list and `publicLookup` refuse private answers. IPv4-mapped IPv6 (`::ffff:10.0.0.1`) is not in the list. | `services/sandbox-broker/src/proxy.ts:10-38` |
| H13 | `skills/` is the image's read-only folder; there is no editable copy and no writer. | `apps/server/src/config.ts:60` |

## Decisions

### Rules for all three tools

1. **One list.** `packages/protocol` exports `HARNESS_TOOLS = ['profile_edit', 'automation_edit',
   'chat_read']`. `PROFILE_TOOLS` adds them; `assistant.yaml` allows them.
2. **The card is mandatory, in code.** A profile cannot turn it off:
   - The registry adds `HARNESS_TOOLS` to `policy.always` and removes them from `never`, as for MCP
     writes (H2).
   - `approvalGate` blocks them in an unattended chat with `UNATTENDED_REASON`, whatever the
     automation's `autoApprove` holds (H1). `AutomationFile.autoApprove` refuses them.
   - `autoApproveTools` leaves them out, so "Hyväksy automaattisesti" never covers them, and
     `childAsk` (phase-22 decision 7) never sees them.
   - The subagent tool filter (`registry.ts:507-509`) leaves them out.
3. **The card carries a view.** `approvalGate` gets `views?: Record<string, View>`, where `View`
   is `(input) => Promise<{ view: ApprovalView } | { error: string }>`. The gate awaits the view
   before it asks. An `error` blocks the call without a card. `approval.request` gets `view` and
   `tainted`.
4. **A block reason holds no real value** (H3). It is a fixed Finnish text and, at most, a field
   path (`Muutos ei kelpaa: cron`). Library messages (zod, yaml) never go into a reason.
5. **The taint warning.** `turnTaint()` moves out of `memoryExtension` into an export of
   `pi-ext-memory`: `{ extension, tainted() }`, with the same rules (`cleanTool`, an attachment in
   the prompt, reset at `agent_start`). The registry builds one per session and passes it to
   `memoryExtension` (new option `taint`) and to the gate. A harness card of a tainted turn has
   `tainted: true`. *One taint rule for memory parking and the card.*
6. **Stale check.** The view stores the sha256 of the current file per call id. `execute` refuses
   when the file changed after the card: "Tiedosto muuttui hyväksynnän jälkeen. Lue se ja yritä
   uudelleen."
7. **Audit trail.** An accepted write goes through the phase-23 writers, which reload and commit
   with `gitCommitter` (H8). The commit note is `<tool> <file> (chat <first 8 of chatId>)`; it holds
   no text of the change. The server logs `harness write` with the chat id, tool and file. The tool
   row stays in the thread. In development the repository's git shows the change (phase-15
   decision 4). Revert: the editor, or `git revert` in `DATA_DIR/agents`.
8. **Effect.** A prompt or mode change reaches the chat at its next turn: the registry rebuilds the
   session after it settles (phase-23 decision 5). The tool answer says so: "Tallennettu. Muutos
   tulee voimaan seuraavassa vastauksessa."
9. **Code.** New `apps/server/src/harness.ts` exports `harness(deps)`, which returns `{ tools,
   views }`: one `ExtensionFactory` with the three tools and the view map for the gate. `deps` are
   `adminWriters` (phase 23), `db`, `userId`, `registry.reader`, `pseudo`, `agents` and the chat id.
   It reuses `transcript`, `restorer` and `cutText` from `bridge.ts`, `nextRuns` from
   `automations.ts` and `untrusted` (decision 21).

### Defence against a prompt change asked by a tool result

10. The card (decision 2) is the main defence. In addition:
    - **Scope.** `profile_edit` writes only the prompt Markdown and mode files. It cannot change
      the YAML (`tools`, `approval`, `model`, `mcp`, `subagents`), so an approved prompt change
      cannot add a tool or remove a card. `automation_edit` cannot set `autoApprove` (decision 15).
    - **No real values in the prompt.** `profile_edit` content is compared before and after
      `pi-ext-pseudo` (the recorder of decision 22). A difference means it names a vault entity:
      block with "Profiiliin ei kirjoiteta henkilötietoja; ne kuuluvat muistiin (USER.md)." The
      view also probes the content with the sidecar (`pseudo.mask`): a span means an entity, with
      the same block. When the sidecar does not answer, the view blocks with a fixed "sidecar down"
      reason; it does not skip the check. *The prompt and modes are not masked at injection (H4).*
    - **Taint warning** on the card (decision 5).
    - **Next turn only** (decision 8): a change cannot steer the rest of the turn that made it.
    - **Diff, not prose.** The card shows the exact change and a stale check guards it (decision 6).

### profile_edit

11. **Arguments and write.** `{ file: 'prompt' | 'mode', id?: string, content: string }`. `prompt`:
    the prompt file of the chat's agent, through `saveAgent(agentId, { profile: {}, prompt })`
    (the merge keeps every YAML key). `mode`: `saveMode(id, { raw: content })`; a new id makes a
    new mode. Content: 1–100,000 characters for a prompt, the `ModeSave` limits for a mode. No
    delete. The view runs the writer with `dry` and builds the diff with `createTwoFilesPatch` from
    `diff` 8.0.4, already in the lockfile through Pi (H9); `apps/server/package.json` pins the same
    version. Three context lines, header lines removed, at most 200 KB.

### automation_edit

12. **Arguments.** `{ id?, name?, cron?, prompt?, deliver?, enabled?, agentId? }`. No id creates an
    automation (id from the name, `freeId`). The write is `saveAutomation` (merge, `editorCron`,
    agent check). No delete.
13. **View.** The YAML of the resulting file, `created`, and the next five runs (`nextRuns`). Real
    values may stay in the automation prompt: the run sends it through the `input` hook, which
    masks it.
14. **Errors.** The dry run's `Bad.path` goes into the block reason (decision 4).
15. **No `autoApprove`.** The tool strips the key. A new automation gets `[]`. An update keeps the
    file's list unchanged (the merge never sees the key). *An approved automation must not run
    gated tools on a schedule without the user's editor action.* An update cannot change
    `agentId`: "Agenttia ei voi vaihtaa työkalulla." When an update changes `enabled`, the YAML view
    carries the old and the new value (`enabled: { from, to }`).

### chat_read

16. **Arguments.** `{ chatId?: string, title?: string }`, exactly one. By id: a chat of the user,
    not the current chat. By title: a case-insensitive substring (`toLocaleLowerCase('fi')`) over
    the real titles, archived chats too, newest first. ponytail: a full scan of the titles; an index
    when there are many thousands of chats. One hit is read. Several hits: `execute` returns up to
    five lines (id, title, date) and asks for an id. No hit: "Ei osumia." *The list leaves through
    `execute`, so `tool_result` masks it; a block reason would not be masked (H3).*
17. **Content.** `transcript(registry.reader(id))`: the shown branch (phase-24 decision 16),
    restored with `restorer`, so `tool_result` masks it once in this session (H5). The newest
    messages that fit in 20,000 characters, in time order; `cutText` cuts one long message. The
    first line is `Keskustelu "<title>" (<date>), N viestiä, M jätetty pois.` The text is inside
    the untrusted block (decision 21). The tool is not in `cleanTool`, so it taints the turn.
18. **View.** By id: title, date and message count. By title: the query.

### skills_edit

19. **Not built.** Invariant 7 asks that every skill is vendored and reviewed like code. The skills
    folder is the image's read-only copy with no editable copy and no writer (H13). The phase-15
    writers do not cover it.

### The link fetch

20. **`fetch_url`, and `web-digest` goes.** The widening alone does nothing in chats (H10). To make
    it work, the profile must load the skill and the server must tell the broker which skill runs a
    command, and no Pi hook says that. A runner on `internet` also mounts the work dir with real
    values, and `bash` can run without a card (H11): a page that injects a `curl -T` command could
    send a file out. `fetch_url` sends one GET with no body, reads no file and runs no shell. So the
    smaller change that works and stays safe is `fetch_url` (about 150 lines with its guard).
    Phase-22 decision 9 is superseded: `skills/web-digest/` is deleted, and the host-list case of
    `tests/sandbox/src/sandbox.test.ts` writes its skill into a temporary folder, as the test at
    line 321 does.
21. **The tool.** New `apps/server/src/fetch-tool.ts`. Argument `{ url }` (http or https, at most
    2,048 characters, ports 80 and 443 only). `node:http`/`node:https` with `lookup: publicLookup`,
    so the checked address is the connected one. An IP-literal host is checked against the same
    list. At most 3 redirects, each checked again. Timeout 15 s. Body at most 2 MB (`capped` from
    `fx.ts` over `Readable.toWeb`). Types `text/*`, `application/json`, `application/xhtml+xml`;
    others: "Sivu ei ole tekstiä." No cookie, no auth header. HTML becomes text (scripts, styles
    and tags removed by a one-pass scanner, entities decoded, white space collapsed; the input is
    cut to 2 MB first; ponytail: no article extraction).
    The answer is at most 20,000 characters inside `untrusted('sivu', text)`: `resultsText` of
    `search-tool.ts` moves its block into `untrusted(tag, body)`, which `web_search`, `fetch_url`
    and `chat_read` share. Errors are fixed texts. Not in `cleanTool`: it taints the turn.
22. **The guards.** The masked-argument recorder leaves `webSearchExtensions` as
    `maskedArgs({ web_search: 'query', fetch_url: 'url', profile_edit: 'content' })`, loaded before
    `pi-ext-pseudo`. The `fetch_url` guard, after it, asks with `confirm` when the restored URL
    differs ("Osoite sisältää henkilötiedon") or when no user message of the branch holds the
    masked URL as a whole white-space token, trailing `.,;:)]` cut ("Osoite ei ole viestissäsi").
    An unattended chat blocks both. The chat toggle covers neither case, as for the `web_search`
    entity card, and `autoApproveTools` leaves `fetch_url` out. *The skill text "fetch only the URL the user gave" becomes a check: a URL
    that a page or a search result suggests waits for the user.*
23. **Shared network rule.** `PRIVATE` and `publicLookup` move to
    `services/sandbox-broker/src/net.ts` (export `@nolla/sandbox-broker/net`); `proxy.ts` and
    `fetch-tool.ts` import them. The list gains multicast and reserved ranges, the IPv6 transition
    ranges that embed an IPv4 address (NAT64 `64:ff9b::/96`, Teredo `2001::/32`, 6to4 `2002::/16`,
    the 6to4 relay `192.88.99.0/24`), and an IPv4-mapped IPv6 address is checked as IPv4 (H12). `apps/server` adds the workspace dependency;
    `infra/Dockerfile.server` copies `services/sandbox-broker/src/net.ts` with its manifest.
24. **Profile and prompt.** `assistant.yaml`: `fetch_url` in `tools.allow` and `approval.never`
    (its guard asks, like `web_search`). `assistant.md` gets one mechanics line: "Kun käyttäjä
    antaa osoitteen, hae sivu työkalulla `fetch_url`. Hae vain käyttäjän antama osoite." Plan
    section 5 gets an amendment line, as for the ECB rate: `pa-server` sends user-directed GETs to
    public hosts.

### Approval card variants (web)

25. `ApprovalCard.tsx` picks the variant from `view.kind`; without a view it keeps today's list.
    The tainted line (`ShieldAlert`, warning colour, 13/18) sits under the title: "Tämä vuoro luki
    ulkopuolista sisältöä. Hyväksy vain, jos pyysit muutosta itse." Edit cards end with the meta
    line "Muutos tulee voimaan seuraavassa vastauksessa ja tallentuu versiohistoriaan."

    | Tool, case | Title | Body |
    | --- | --- | --- |
    | `profile_edit`, prompt | Muutetaanko avustajan ohjetta? | file path (mono, muted), the diff |
    | `profile_edit`, mode | Muutetaanko tilaa "<name>"? / Lisätäänkö tila "<name>"? | the diff |
    | `automation_edit` | Luodaanko automaatio "<name>"? / Muutetaanko automaatiota "<name>"? | the YAML, then "Seuraavat ajot: ma 3.11. klo 7.30, …" |
    | `chat_read`, id | Luetaanko keskustelu "<title>"? | "<date> · N viestiä. Malli saa tekstin pseudonymisoituna." |
    | `chat_read`, title | Haetaanko keskustelu otsikolla "<query>"? | "Avustaja lukee osuman tai saa listan osumista." |
    | `fetch_url` guard | the reason | "Osoite:" and the URL (the search variant, keyed by tool) |

    The diff uses `DiffLine` from `MemoryScreen.tsx`; hunk lines (`@@`) are muted. The diff and
    the YAML clamp at 16 lines with "Näytä lisää", as `Value` does. Tool row icons (phase-21
    decision 5): `fetch_url` `Globe`, `profile_edit` `SlidersHorizontal`, `automation_edit`
    `CalendarClock`, `chat_read` `MessageSquareText` (final: the lines in the bubble say "text
    of a chat"). The row word of a finished call comes from its answer: "tallennettu" only for
    `SAVED`, "haettu" only for a page (the `UNTRUSTED_NOTE` block), `chat_read` "luettu", "N
    osumaa" or "ei osumia"; any other answer and a row from history say "valmis".

## Changes to earlier records

- Phase-22 decision 9: superseded by decisions 20–24.
- Phase-21 decision 7: the auto-approve list also leaves out `HARNESS_TOOLS`.
- Phase-14 decisions 7 and 10: the recorder and the untrusted block become shared helpers; the
  search behaviour does not change.

## Protocol changes

```ts
// packages/protocol/src/index.ts
export const HARNESS_TOOLS = ['profile_edit', 'automation_edit', 'chat_read'] as const;
export const FETCH_URL_TOOL = 'fetch_url';
export const ApprovalView = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('diff'), file: z.string().max(200), created: z.boolean(), diff: z.string().max(200_000) }),
  z.object({
    kind: z.literal('yaml'),
    file: z.string().max(200),
    created: z.boolean(),
    yaml: z.string().max(200_000),
    nextRuns: z.array(z.iso.datetime()).max(5),
  }),
  z.object({
    kind: z.literal('chat'),
    chatId: id64.nullable(),
    title: z.string().nullable(),
    createdAt: z.iso.datetime().nullable(),
    messages: z.int().min(0).nullable(),
    query: z.string().max(200).nullable(),
  }),
]);
export type ApprovalView = z.infer<typeof ApprovalView>;
// approval.request: view: ApprovalView.optional(), tainted: z.boolean().optional()
// approval.ts AskInput picks 'view' | 'tainted' too.
```

No database change. `AutomationFile.autoApprove` (`automations.ts:38`) refuses `HARNESS_TOOLS`.

## Task cards

S1 lands first. Every card ends with `pnpm typecheck` and `pnpm lint`.

| ID | Title | Owner | Model | Files | Tests to write | Acceptance | Order |
| --- | --- | --- | --- | --- | --- | --- | --- |
| S1 | Protocol | server | Opus medium | `packages/protocol/src/index.ts` (+ test) | `ApprovalView` variants; a request without `view` still parses | Tests pass | first |
| S2 | Gate, taint, registry | server | Opus medium | `approval.ts`, `pi/registry.ts`, `automations.ts`, `packages/pi-ext-memory/src/index.ts` | gate: a harness tool asks even when the profile lists it in `never`; unattended blocks it even when `autoApprove` lists it; the toggle does not cover it; a `views` error blocks without a card; children never get it; memory: the existing taint tests pass through `turnTaint` | Tests pass | after S1 |
| S3 | Harness tools | server | Opus medium | new `harness.ts` (+ test), `admin.ts` (dry results), `search-tool.ts` (`maskedArgs`, `untrusted`), `apps/server/package.json` (`diff`) | `profile_edit`: diff view, write, commit note, stale refusal, a vault name in the content blocks with the fixed reason, the YAML stays byte-equal; `automation_edit`: YAML view and next runs, `autoApprove` stripped, a bad cron blocks with `Muutos ei kelpaa: cron`; `chat_read`: restored and capped, title with several hits lists five, the current chat is refused; no block reason holds a seeded real value | Tests pass; search tests pass unchanged | after S2 |
| S4 | `fetch_url` | server | Opus medium | new `fetch-tool.ts` (+ test), `services/sandbox-broker/src/net.ts`, `proxy.ts`, `infra/Dockerfile.server`, `agents/assistant.yaml`, `agents/prompts/assistant.md`, delete `skills/web-digest/`, `tests/sandbox/src/sandbox.test.ts`, `docs/plan.md` section 5 | refused: `localhost`, `127.0.0.1`, `10.0.0.1`, `169.254.169.254`, `[::1]`, `[::ffff:10.0.0.1]`, port 8080, a redirect to a private host, a fourth redirect, a 3 MB body, `image/png`; HTML becomes text inside the block; guard: a URL from the user passes, another URL asks, a vault name asks, unattended blocks | Tests pass; `pnpm test:sandbox` passes | after S3 |
| W1 | Cards and rows | web | Opus xhigh | `ApprovalCard.tsx`, `ToolRow.tsx` | e2e with fake-llm tool calls: the `profile_edit` card shows the diff and Hyväksy changes the file; Hylkää leaves it; the `automation_edit` card shows the YAML and next runs; the `chat_read` card; the tainted line after a `web_search`; the `fetch_url` guard card | Flows pass; axe passes | after S1 |
| P1 | Pixel pass | separate Opus reviewer | Opus xhigh | W1 files | none new | Checks below at 390, 1024 and 1440, light and dark | after W1 |
| U1 | Blind UI review | UI reviewer | Opus xhigh | screenshots | the screens below | Every cell 4 or 5 | after P1 |

P1 checks: diff lines 13/20 mono with the `DiffLine` colours and a 4 px sign column; the clamp
fade starts at line 13; the tainted line has 8 px above and below; buttons keep the phase-9 card
layout (two columns under 768); a 200-line diff does not widen the card past the prose column.

## Test plan

- Unit: the cards above.
- E2E flows: W1, plus the existing approval, auto-approve, web search and memory flows unchanged.
- Screens: `approval-profile-diff`, `approval-automation-yaml`, `approval-chat-read`,
  `approval-tainted`, `approval-fetch`, at 390 and 1440, light and dark.

## Gate

1. `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm test:contract` pass.
2. `pnpm test:sandbox` passes (Docker), because S4 changes the broker and the sandbox test.
3. `pnpm --filter @nolla/e2e exec playwright test --project screens` passes with strict axe.
4. Docker image and compose smoke as phase-23 gate item 4. In the running stack, a one-off
   `node -e` in the `pa-server` container calls the fetch function on `http://pseudo-svc:8000/`
   and gets the refusal (Docker DNS gives a private address).
5. P1 is done and U1 passes.

## Risks and ceilings

- `pa-server` can now reach any public host on the user's or the model's request. The private
  address check (decision 23) is the only barrier to the internal network; its tests guard it.
- The HTML-to-text step is crude; pages that build their text in scripts give little text.
- A diff of a long prompt can be long; the card clamps it, the full diff stays one click away.
- A user who approves every card defeats decision 10; the tainted line is the last signal.
- A title search can read a chat that the user did not mean; the card names the chat by id only
  when the model gave the id (decision 18).

## UI review 5

Blind review of `approval-*`, `edit-box` and `version-switcher` (2026-10-29). The `edit-box` and
`version-switcher` items are in [phase-24-edit-in-place.md](phase-24-edit-in-place.md#ui-review-from-phase-25).
Measured in `screens.spec.ts` at 390, 1024 and 1440, light and dark.

- Diff and YAML lines wrap (`white-space: pre-wrap`, `overflow-wrap: anywhere`); the block never
  scrolls sideways, so it is no tab stop. A diff row keeps the 4 px bar and the sign as a hanging
  gutter: the text starts at x + 24 (measured 24 px, horizontal overflow 0). A YAML row hangs its
  continuation under the value (indent, list dash and `key: `, in `ch`).
- The clamp is 16 rows of 20 px (16 lines, or fewer that wrap past 320 px): the fade runs over
  rows 13 to 16, the link says "Näytä lisää" / "Näytä vähemmän" with `aria-expanded`, 8 px from
  the box to the link's line box (measured 8 px; on phones the 44 px target overlaps the box).
- The tainted line sits straight under the title row, before the file line: measured 8 px above
  and 8 px below.
- Tool rows stack 4 px apart also across the messages of one turn (a tool-only message, then one
  that starts with its tool rows).
- `approval-chat`: the pointer leaves the sidebar before the shot.

Amendment to decision 25 and the P1 checks: diff and YAML lines wrap with a hanging gutter. This
replaces the block that scrolled sideways; a long line still never widens the card.

## Status

Security review fixes (2026-10-29):

- `htmlText` cuts its input to 2 MB and strips tags with a linear scanner; the entity regex has
  bounded quantifiers. A 2 MB page of `<` or of unterminated `<script ` takes under 200 ms.
- The `fetch_url` guard matches whole URL tokens, and the auto-approve toggle never covers its
  card (decision 22).
- The private list has the IPv6 transition ranges (decision 23).
- The registry registers a harness tool only when `tools.allow` lists it.
- `automation_edit` keeps the agent and the `autoApprove` list of an update (decision 15).
- `profile_edit` probes its content with the sidecar (decision 10).
- `chat_read` answers fixed text when a read fails, and applies the 20,000-character cap after the
  restore. A call that ends without `execute` (denied, expired, failed) drops its stale-check stamp.
- Web review fixes (2026-10-29): the fetch card bolds only `URL.host` and shows
  userinfo muted (`https://www.hs.fi@evil.com` names `evil.com`); text that does not parse stays
  plain. A mode card takes its name from the frontmatter or the file id, never from a `name:` in
  the body. The row words follow the answer (decision 25).
- Accepted for now: the manifests stage of `infra/Dockerfile.server` copies the broker's
  `package.json`, so the server image installs the broker's dependencies (`undici`, `fastify`,
  `yaml`, `zod`) although the server imports only `net.ts`, which needs none of them.
