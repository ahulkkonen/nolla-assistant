# Phase 13: Thread depth

The fixed decisions are in `phase-11-15-plan.md`, section "Phase 13". This record adds the decisions
that the plan left open, the data model, the egress rule, the UI, the task cards, the gate and the
risks. The record of phase 10 (`phase-10-models.md`) stays valid. The `user.retry` path in
`apps/server/src/bridge.ts` does not change.

## Goal

The user can go deeper in one thread without losing it:

1. "Muokkaa" on a user message starts a new chat from that point. The original chat does not change.
2. A reply of a thinking model shows a collapsed row "Ajatteli 12 s". The row opens to the thinking
   text, with the same masking as the reply.
3. Each reply, each chat and each month shows what the model calls cost, in euros.
4. Each message shows its time on hover. Ctrl+F or Cmd+F searches inside the open chat.

Constraints:

- The pseudonymization layer stays the only path for prompts. A fork copies masked entries and masks
  nothing again.
- No new dependency. The only new outbound call is the ECB exchange rate.
- LiteLLM, its guard and the OpenRouter routes do not change.
- Real values never reach the session JSONL, the LiteLLM request log or `app.db` (plan section 2,
  invariant 1). The new usage rows hold numbers and model ids only.

## Research findings

All facts come from the installed Pi 1.3.0 packages (`node_modules/.pnpm/@earendil-works+pi-ai@1.3.0_*`
and `@earendil-works+pi-coding-agent@1.3.0_*`), the repository code and one live ECB call on
2026-10-26. `pi-ai/dist` and `pi-coding-agent/dist` below mean the `dist` folder of each package.

### 1. Usage on Pi assistant messages

- `AssistantMessage` (`pi-ai/dist/types.d.ts:362-392`) has `content: (TextContent | ThinkingContent |
  ToolCall)[]`, `model`, `responseModel?`, `usage`, `stopReason`, `timestamp` (request start, epoch
  ms) and `durationMs?` (whole response).
- `Usage` (`types.d.ts:279-300`) has `input`, `output`, `cacheRead`, `cacheWrite`, `cacheWrite1h?`,
  `reasoning?`, `totalTokens` and `cost: { input, output, cacheRead, cacheWrite, total }`. `reasoning`
  is a part of `output`.
- The OpenAI-completions adapter fills `Usage` in `parseChunkUsage` (`pi-ai/dist/api/openai-completions.js:1165-1193`).
  It reads `prompt_tokens`, `prompt_tokens_details.cached_tokens`, `prompt_tokens_details.cache_write_tokens`,
  `completion_tokens` and `completion_tokens_details.reasoning_tokens`. Then `calculateCost`
  (`pi-ai/dist/models.js:659-678`) computes the cost from the `cost` rates of the model entry in
  `models.json`.
- **Pi drops LiteLLM's cost.** The adapter never reads `usage.cost` from the chunk. The cost in the
  session is Pi's estimate from our price table. For catalog models that table holds the OpenRouter
  list price (`piEntry` in `apps/server/src/pi/models.ts`). For the fixed aliases it holds the EU
  endpoint prices in `infra/models.json`.

### 2. Raw stream access and message replacement

- `StreamOptions.onProviderStreamEvent` (`pi-ai/dist/types.d.ts:101-112`) receives every parsed
  chunk before Pi normalizes it. The OpenAI-completions adapter calls it for each chunk
  (`openai-completions.js:353`).
- The coding agent passes each chunk to extensions as the event `provider_stream_event` with
  `provider`, `api`, `model` and `data` (`pi-coding-agent/dist/core/sdk.js:241-252`,
  `core/extensions/types.d.ts:713-719`). The event `after_provider_response` gives the HTTP status
  and the headers (`types.d.ts:708-712`).
- An extension handler of `message_end` can return `{ message }` (`MessageEndEventResult`,
  `types.d.ts:1121-1124`). `AgentSession` then changes the message object in place
  (`_replaceMessageInPlace`, `core/agent-session.js:868-881`). This happens before the public
  listeners run and before `sessionManager.appendMessage` stores the message
  (`agent-session.js:752-770` and `920-937`). So an extension can put LiteLLM's cost into the stored
  message, and the bridge sees the changed message at `message_end`.

### 3. LiteLLM cost

- LiteLLM adds `usage: { include: true }` to every OpenRouter request (decision 0004, research on
  `transform_request`). OpenRouter then sends `usage.cost` in USD.
- In the local run of decision 0004, LiteLLM sent the cost in the last stream chunk:
  `{"choices":[{"index":0,"delta":{}}],"usage":{...,"cost":0.00001}}`. The phase-10 live check got
  `reasoning_tokens` 397 and a cost of 0.0041 USD for one Argon call.
- LiteLLM runs without a database (decision 0004, decision 2). The `/spend` routes need one, so they
  are not available.
- The header `x-litellm-response-cost` comes from LiteLLM's own cost map. The map is local
  (`LITELLM_LOCAL_MODEL_COST_MAP=True`) and does not know the wildcard ids. A streaming response
  sends its headers before the usage chunk. The header is therefore not a source. UNVERIFIED: its
  value for a streamed wildcard call.
- The title, topic and summary job and the memory consolidation call LiteLLM without streaming
  (`taskSmall` in `apps/server/src/topics.ts:42-92`). The response body has the same `usage` object.

### 4. Thinking blocks

- `ThinkingContent` (`types.d.ts:251-259`) is `{ type: 'thinking', thinking, thinkingSignature?,
  redacted? }`.
- The adapter reads the delta fields `reasoning_content`, `reasoning` and `reasoning_text`, and
  `reasoning_details` (`openai-completions.js:386-430`). It collects them into one thinking block.
- It sends `thinking_start` at the first reasoning delta and `thinking_delta` for each chunk. It
  sends `thinking_end` only after the stream ended (`finishBlock` at `openai-completions.js:473`).
  So `thinking_end` does not mark the end of the thinking. The last `thinking_delta` does.
- Pi stores the thinking blocks in the session JSONL as part of the assistant message. `textOf` in
  `bridge.ts` reads only `text` blocks. Today the thread, the export and the search index do not show
  thinking.
- `/scan` already covers thinking. The `context_with_system` handler of `pi-ext-pseudo`
  (`packages/pi-ext-pseudo/src/index.ts:120-162`) sends each whole message as JSON. The sidecar walks
  every string value (`services/pseudo-svc/app/mask.py:52-80` and `386-400`). So the `thinking` text
  of an assistant message passes `/scan` on each later request, the same as its `text`.
- UNVERIFIED: whether LiteLLM 1.105.1 forwards the reasoning text of OpenRouter streams for each
  vendor. The gate checks one Claude and one Gemini model.

### 5. Session tree and fork

- `SessionManager.createBranchedSession(leafId)` (`core/session-manager.d.ts:360-365`,
  `session-manager.js:1205-1290`) writes a new JSONL file. The file holds the path from the root to
  `leafId`, a new uuidv7 session id and `parentSession` = the source file. The entries keep their
  ids, parents, timestamps and content.
- The call also switches the manager that runs it to the new file. It must therefore run on a second
  manager, never on the live manager of the source chat.
- When the path has no user or assistant message, the method does not write the file yet. The file
  then appears at the first append (`session-manager.js:1280-1288`).
- `SessionManager.forkFrom` copies the whole tree, dead branches included (`session-manager.js:1374-1410`).
- `SessionManager.open` migrates and rewrites a file only when its version is old
  (`_loadEntries`, `session-manager.js:717-731`). The live session opened the same file before, so the file is
  already at version 3.
- On open, the leaf is the last entry in file order (`_buildIndex`, `session-manager.js:732-752`).
- The registry finds a session file by chat id (`SessionManager.findById` in
  `apps/server/src/pi/registry.ts:144`). So the session id of a fork must be its chat id.
- The `input` hook of `pi-ext-pseudo` appends a `pseudo-spans` custom entry before Pi appends the
  user message (`packages/pi-ext-pseudo/src/index.ts:63`). The parent of a user entry is therefore
  often its own `pseudo-spans` entry.

### 6. The sidecar scope of a session

- The sidecar records spans per `session_id` (`services/pseudo-svc/app/vault.py:25-28`).
- `_surrogate_cover` (`mask.py:115-133`) treats a surrogate-shaped name as a surrogate only when its
  entity has a span in the same session (`last_seen`, `vault.py:182-187`). Elsewhere the name "may be
  a real person with the same name, so it is masked".
- A subagent session `<chat>/sub/<id>` shares the scope of its chat (`_scope`, `vault.py:177-180`).
  A fork has no such link.
- Consequence: a fork with a new session id and no spans would mask a copied surrogate again when it
  comes back in a tool result (`/mask` with all layers). The model would see a surrogate of a
  surrogate. The vault would also keep the surrogate as the real form of a new person, so `/scan`
  would then mask it in every other session. `/scan` alone uses only the vault and code layers, so it
  does not mask a surrogate that no entity holds as a real form (verified by the pytest of task
  card 1). Decision 3 closes this.

### 7. Repository facts

- There is no messages table. Messages live only in the Pi session JSONL. `chat.state` rebuilds them
  with `history()` in `bridge.ts`.
- `Message.createdAt` (`packages/protocol/src/index.ts:115`) already carries the Pi message
  timestamp (`toMessage` in `bridge.ts`). Timestamps need no server change.
- The FTS index (`apps/server/src/search.ts`) holds masked chunks of up to 1,600 characters per
  message. A query returns one hit per chat (`byChat`). The index runs at `agent_settled`.
- The client holds every message of an open chat, because the thread is not virtualized (brief 7.8).
  A search hit already opens its chat at `messageId` (`apps/web/src/components/SearchScreen.tsx:77`).
- Today "Muokkaa" sends the edited text as a new message in the same chat (`Thread.tsx:201`, the
  button "Lähetä muokattuna" in `MessageView.tsx`).
- A subagent child is a `pi --mode rpc` process (`packages/pi-ext-subagents/src/index.ts:107-145`).
  Its RPC `message_end` records carry Pi's usage. The child does not load pa-server's inline
  extensions, so its cost is Pi's estimate.
- pa-server has outbound internet (`infra/compose.yaml`, networks `internal` and `mcp`). It already
  calls `openrouter.ai` for the public catalog.

### 8. ECB reference rate

A live call on 2026-10-26 without a key returned HTTP 200 and two CSV lines:

```text
GET https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A?lastNObservations=1&format=csvdata&detail=dataonly

KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE
EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-10-23,1.1193
```

- The value is USD per 1 EUR. EUR = USD / value.
- The ECB publishes one value per TARGET working day in the afternoon (CET). On Monday morning the
  newest value is the one of Friday.
- The response has `cache-control: max-age=30` and `last-modified`. It sets no cookie.

## Decisions

### Fork

1. **Message and checks.** "Haarauta" in the edit box sends `chat.fork { chatId, messageId, text }`.
   The server answers `bad_message` when `messageId` is not a user message entry on the current
   branch of the chat. It answers `failed` while the source chat runs (`registry.running`), as a
   model change does. The UI shows "Muokkaa" only when no reply streams.
2. **Copy without re-masking.** The fork point is the parent of the edited user entry. When that
   parent is the entry's own `pseudo-spans` custom entry, the fork point is the parent of that entry.
   The server opens a second manager on the source file with
   `SessionManager.open(sourceFile, registry.sessionDir)` and calls `createBranchedSession(forkPoint)`.
   The new file holds the masked entries from the root to the fork point, unchanged. No entry passes
   the sidecar. The new chat id is the new session id (`getSessionId()`, a uuidv7). When the edited
   message is the first entry of the chat, there is no fork point. The new chat then starts empty,
   with a new id, through `registry.create`.
3. **Sidecar scope copy.** The fork must keep the sidecar's view of which surrogates the session
   knows (research 6). A new sidecar route `POST /session/fork { user_id, from_session_id,
   to_session_id, until }` copies one span row per entity of the source session with `created_at`
   up to `until`. `until` is the timestamp of the fork point entry. Both clocks write ISO 8601 UTC
   with milliseconds, so a string comparison works. The copied rows get `detector = 'fork'`, zero
   offsets and no `entry_id`. The vault list leaves them out of the seen count and the last-seen time. The new `PseudoClient.forkSession`
   method calls the route. Without a sidecar (development), the server skips the call. When the call
   fails, the server deletes the new file and answers `pseudo_down`.
4. **The new chat row.** The row copies `agentId`, `topicId`, `modelId` and `reasoning` from the
   source. `dataPolicy` is always `zdr`, because consent for `open` was for one chat (phase-10 proof
   claim 1). The title is `<old title> (haara)` and the masked title is `<old masked title> (haara)`.
   A titled fork gets `titleLocked: true`, so the title job keeps the title. An untitled source gives
   an untitled fork, which the title job names as usual. The row stores the link in three new columns:
   `forkedFromChatId`, `forkedFromMessageId` (the edited user entry) and `forkedAt` (the time of the
   edited message in the source: the copied messages are older, the fork's own messages are newer).
   The columns have no foreign key, so a fork keeps its link text after the source chat is deleted.
5. **Order of work.** The server holds the source chat, as `retry` does. It checks the request and
   restores the block part (decision 6). After that await it checks again that the source leaf did
   not move and that no run started. Then it writes the file and checks that the file exists, copies
   the sidecar scope and inserts the row, and builds the session with `registry.get`. Any failure
   from the copy on deletes the row, the file and the copied sidecar scope
   (`POST /session/fork/drop`), and answers `failed` or `pseudo_down`. A deleted fork also drops its
   copied scope. The server then sends `chat.created` and `chat.state` to the socket, in this order. `chat.state` carries `forkedFrom`. Last, the server joins the socket
   to the new room and prompts the edited text under `registry.hold`, as `user.message` does. The
   client sees the copied history before the first delta of the new reply.
6. **The fork's first turn.** The prompt text is the edited text plus the attachment blocks of the
   original message. The server restores the original message text with the sidecar, as `rerun` in
   `bridge.ts` does. It cuts the `[Liite: ...]` block part with `splitBlocks` and the file window of
   `history()`. It extracts that window rule from `history()` into one helper that both use. The
   images of the original entry go with the prompt, as in `rerun`. The input hook then masks the
   real text once. The file rows stay with the source chat, because `ingestAttachments` would move
   them.
7. **What the fork shows.** The copied messages keep their entry ids, times and texts. Their
   attachment chips come from the files of the source chats up to `forkedAt` (a fork of a fork walks
   the chain), while each source exists. The copied
   replies show no cost: `history()` drops `usage` of messages older than `forkedAt`. The fork's
   running totals start at zero, so no cost counts twice. The search index takes the copied messages
   at the first `agent_settled` of the fork, because `indexChat` indexes every unindexed message of
   the branch.

### Thinking

8. **Capture and storage.** Pi already stores the thinking blocks in the session (research 4). The
   phase stores nothing new except the thinking time. The usage extension (decision 11) records the
   time of the first `thinking_start` and of the last `thinking_delta` of each assistant message. At
   `message_end` it writes the difference as `pa.thinkingMs` into the message. Thinking text passes
   `/scan` on every later request, as assistant text does. A new server test proves this with a
   seeded real value in a thinking block. The search index and the export do not include thinking.
9. **Live state.** The bridge sends `message.thinking { chatId, messageId, active: true }` at the
   first `thinking_start` of a streamed message. It sends `active: false` at the first `text_delta`
   or `toolcall_start` after it, or at `message_end`. `messageId` is the stream id of the deltas. The
   bridge sends no thinking text while the reply streams.
10. **Text on demand.** `Message.thinking` is `{ ms }` when the message has a non-empty, non-redacted
    thinking block, and absent otherwise. The text loads only when the user opens the row:
    `thinking.get { chatId, messageId }`. The server finds the entry with
    `sessionManager.getEntry`, joins the text of its thinking blocks with a blank line, cuts the text
    at 50,000 characters, and then restores it with the same restorer as the reply text. The answer
    is `thinking.text` with the text and its annotations. So `chat.open` makes no extra sidecar calls
    for thinking. The setting "Näytä ajattelu" lives in `localStorage`, like the theme, and is on by
    default. When it is off, the client shows no thinking row and asks for no text.

### Usage and cost

11. **Usage extension.** A new inline extension, `usageExtension` in `apps/server/src/usage.ts`, loads
    in every chat session. The registry passes it the chat id and the agent id. It does these steps
    for each assistant message:
    1. At `message_start`, it clears the stored cost and thinking times.
    2. At `provider_stream_event`, it keeps `data.usage.cost` when that value is a finite number.
    3. At `message_update`, it records the thinking times of decision 8.
    4. At `message_end`, it returns the message with `pa: { costUsd?, thinkingMs? }` added. Pi stores
       the message with this key.
    5. At `message_end`, when `usage.totalTokens > 0`, it writes one `usage` row (decision 13).
12. **Cost source.** `pa.costUsd` holds the cost that OpenRouter billed and LiteLLM passed on. When
    the stream had no cost, the cost is Pi's estimate (`usage.cost.total`) and `estimated` is true.
    pa-server uses no `/spend` lookup and no response header (research 3).
13. **Where usage is stored.**
    - Per reply: in the session, as Pi's `usage` plus the `pa` key. `history()` and `message.final`
      read it from the message. A reply needs no database read.
    - Per call, for totals: a new table `usage`, one row per model call. A row holds numbers, the
      model id, the chat id and the agent id. It has no text. The chat id has no foreign key, so the
      rows outlive a deleted chat and the monthly totals stay true.
    - Per chat: two running totals on `chats`, `costUsd` and `tokens`. The same transaction that
      inserts a `usage` row with a chat id adds to them. `ChatSummary` carries them without a join.
    - A column on a messages table is not possible, because there is no such table.
14. **Other model calls.**
    - `taskSmall` gets an `onUsage` callback, and each call can name a chat id. The title job passes
      its chat. The consolidation passes none. These rows have `kind: 'task'`. The cost comes from
      the response body. Without it, the cost is the estimate from the alias price in
      `infra/models.json` with Pi's `calculateCost`.
    - `pi-ext-subagents` gets an `onUsage` callback for each assistant `message_end` record of a
      child. These rows have `kind: 'subagent'` and the parent chat id. Their cost is Pi's estimate.
    - Not counted in this phase: Pi compaction, transcription (`zdr/stt`) and remote embeddings.
      Phase 14 adds `kind: 'search'` for `web_search`.
15. **Totals that the user sees.**
    - Per reply: the action row meta of an assistant message shows the sum of that message and of
      the assistant messages before it in the same turn that have no action row (tool call rounds).
    - Per chat: the chat menu shows `ChatSummary.usage`.
    - Per month: `usage.get { month }` answers `usage.state`. The server groups the user's rows by
      model inside the month. Month limits are in Europe/Helsinki. The list of months runs from the
      month of the first row to the current month, newest first, at most 24.
    - Export: the header shows the chat total. Each assistant message shows its own usage. Costs are
      not personal data, so the masked form shows them too.
16. **EUR rate.** A new module `apps/server/src/fx.ts` keeps the ECB rate (see "Egress"). The server
    sends `fx.state` to each socket when it attaches, and to all sockets after a new value arrives.
    Every price stays in USD in storage. The client and the export convert a price when they show it,
    with the newest rate: EUR = USD / `usdPerEur`. Without a rate, they show USD.
17. **Formats.** One pair of formatters lives in `packages/protocol` (`formatCost`, `formatTokens`).
    The web and the Markdown export use them.
    - Chat and month: two decimals, for example "0,42 €". A value above zero and below 0,01 shows
      "< 0,01 €".
    - Reply: three decimals below 0,10 €, for example "0,004 €". Below 0,001 it shows "< 0,001 €".
    - An estimate gets the prefix "~". Without a rate the unit is "$".
    - Tokens: "640 tokenia", "3,4 k tokenia" below 10,000, "18 k tokenia" below 1,000,000,
      "1,2 M tokenia" above. One token is "1 tokeni".

### Timestamps and search

18. **Timestamps.** The server sends `createdAt` as today. The action row meta shows "klo 17.20" for
    today, "25.10. klo 17.20" for this year and "25.10.2025 klo 17.20" for older messages. The time
    zone is the browser's. Copied messages in a fork keep their original times.
19. **In-chat search runs in the client.** Ctrl+F or Cmd+F in an open chat opens a find bar. The
    client searches the visible text of the message bodies in the DOM. It does not use the FTS index,
    for three reasons:
    - The index holds masked text, so a real name in the query would need the sidecar, and the hit
      offsets would not match the restored text.
    - A query returns one hit per chat, not per message.
    - The index lags until `agent_settled`.

    The match is case-insensitive (`toLocaleLowerCase('fi')`) and stays inside one text node.
    Highlights use the CSS Custom Highlight API (`CSS.highlights`), so the DOM does not change.
    Collapsed tool rows and thinking rows are not searched. The link to the FTS index is this: a hit
    in the global search opens the chat at its message (as today) and opens the find bar with the
    query.

## Data model

### Protocol (`packages/protocol/src/index.ts`)

```ts
/** One model call (phase-13 decision 12). `costUsd` is what OpenRouter billed unless `estimated`. */
export const CallUsage = z.object({
  /** The model id LiteLLM got, e.g. 'zdr/google/gemini-4-argon' or 'zdr/strong'. */
  model: z.string().max(200),
  input: z.int().min(0),
  output: z.int().min(0),
  cacheRead: z.int().min(0),
  cacheWrite: z.int().min(0),
  /** A part of `output`. */
  reasoning: z.int().min(0),
  costUsd: z.number().min(0),
  /** True: Pi's price table, not the billed cost. */
  estimated: z.boolean(),
});
export type CallUsage = z.infer<typeof CallUsage>;

export const ChatUsage = z.object({ costUsd: z.number().min(0), tokens: z.int().min(0) });

/** ECB reference rate: USD per 1 EUR on `date`. */
export const FxRate = z.object({ usdPerEur: z.number().positive(), date: z.iso.date() });
export type FxRate = z.infer<typeof FxRate>;

export const ForkLink = z.object({
  chatId: id64,
  /** The edited user message in the source chat. */
  messageId: id64,
  /** Null when the source chat has no title or is deleted. */
  title: z.string().nullable(),
  deleted: z.boolean(),
});
```

Changes to existing schemas. All new fields are optional, so older fixtures stay valid:

- `Message` gets `usage: CallUsage.optional()` (assistant messages with tokens) and
  `thinking: z.object({ ms: z.int().min(0).nullable() }).optional()`.
- `ChatSummary` gets `usage: ChatUsage.optional()`. `summary()` always sets it.
- `chat.state` gets `forkedFrom: ForkLink.nullable().optional()`.
- `ChatExport` keeps `version: 1`. `chat` gets `usage: ChatUsage.optional()`, the root gets
  `fx: FxRate.nullable().optional()`, and each message gets `usage: CallUsage.optional()`.
- Phase 16 adds the optional `input`, `output`, `cacheRead` and `cacheWrite` to `ChatUsage`, still in
  `version: 1` (`phase-16-polish.md`, decision 12).

New client messages:

```ts
z.object({
  type: z.literal('chat.fork'),
  chatId: id64,
  /** A user message entry on the chat's current branch. */
  messageId: id64,
  text: z.string().min(1).max(100_000),
}),
z.object({ type: z.literal('thinking.get'), chatId: id64, messageId: id64 }),
z.object({ type: z.literal('usage.get'), month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }),
```

New server messages:

```ts
/** The streamed message `messageId` (stream id) thinks now, or stopped thinking. */
z.object({ type: z.literal('message.thinking'), chatId: id64, messageId: id64, active: z.boolean() }),
/** Answer to `thinking.get`: the restored thinking text of one assistant entry. */
z.object({
  type: z.literal('thinking.text'),
  chatId: id64,
  messageId: id64,
  text: z.string(),
  annotations: z.array(Annotation),
}),
/** At attach and after each new rate. Null: no rate yet, show USD. */
z.object({ type: z.literal('fx.state'), rate: FxRate.nullable() }),
/** Answer to `usage.get`. */
z.object({
  type: z.literal('usage.state'),
  month: z.string(),
  /** 'YYYY-MM', newest first, at most 24. */
  months: z.array(z.string()),
  rows: z.array(
    z.object({
      model: z.string(),
      /** Catalog name, alias name from infra/models.json, or the id. */
      name: z.string(),
      calls: z.int().min(0),
      tokens: z.int().min(0),
      reasoning: z.int().min(0),
      costUsd: z.number().min(0),
      /** True when any row of the group is an estimate. */
      estimated: z.boolean(),
    }),
  ),
}),
```

No new error code. `chat.fork` answers `bad_message`, `failed`, `not_found` or `pseudo_down`.
`thinking.get` answers `not_found` or `pseudo_down`.

The Pi message key `pa` is not part of the protocol. Its type lives in `apps/server/src/usage.ts`:
`{ costUsd?: number; thinkingMs?: number }`.

### Database (`packages/db/src/schema.ts`, the next drizzle migration, 0006 today)

```ts
// in `chats`
// Phase-13 running totals of the `usage` rows of this chat (decision 13).
costUsd: real().notNull().default(0),
tokens: integer().notNull().default(0),
// Phase-13 fork link (decision 4). No foreign key: the link stays after the source is deleted.
forkedFromChatId: text(),
forkedFromMessageId: text(),
forkedAt: text(),

/** One row per model call (phase-13 decision 13). Numbers and ids only, no text. */
export const usage = sqliteTable(
  'usage',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    userId: text().notNull(),
    // No foreign key: rows outlive a deleted chat, so monthly totals stay true.
    chatId: text(),
    agentId: text(),
    // chat: a reply in a chat. task: title job or consolidation. subagent: a child's reply.
    kind: text({ enum: ['chat', 'task', 'subagent'] }).notNull(),
    // The model id LiteLLM got, e.g. 'zdr/strong' or 'open/anthropic/claude-fable-5.1'.
    model: text().notNull(),
    input: integer().notNull(),
    output: integer().notNull(),
    cacheRead: integer().notNull(),
    cacheWrite: integer().notNull(),
    reasoning: integer().notNull(),
    costUsd: real().notNull(),
    estimated: integer({ mode: 'boolean' }).notNull(),
    createdAt: text().notNull(),
  },
  (t) => [index('usage_user_created_idx').on(t.userId, t.createdAt)],
);
```

- `drizzle-kit generate` writes the migration. Existing chats get zero totals and no fork link.
- Tokens of a row: `input + output + cacheRead + cacheWrite`, the same sum as Pi's `totalTokens`.
- The `agentId` column is for the phase-15 usage page ("per agent"). A deleted chat cannot give its
  agent later, so the row stores it now.

### Sidecar (`services/pseudo-svc`)

- `POST /session/fork` with body `{ user_id, from_session_id, to_session_id, until }` answers
  `{ ok: true, entities: <count> }`. Both session ids follow the session id rule of the other routes.
- For each entity with a span in `from_session_id` at or before `until`, the vault inserts one span
  row in `to_session_id` with `detector = 'fork'` and the first time the entity was seen. Times
  compare as parsed instants, so a span in the same millisecond as the fork point is copied. A time
  without a zone answers 422.
- `POST /session/fork/drop` with body `{ user_id, session_id }` deletes only the `fork` rows of that
  session (a failed fork, a deleted forked chat). No consumer reads `entry_id` or the offsets of a
  span row, so the copied rows with zero offsets break nothing.
- The vault list (`seen_count`, `last_seen`, `vault.py:222`) leaves out the rows with `detector = 'fork'`.

## Egress

The phase adds one outbound call. It goes from pa-server to the ECB.

| Item | Rule |
| --- | --- |
| URL | `${ECB_RATES}/service/data/EXR/D.USD.EUR.SP00.A?lastNObservations=1&format=csvdata&detail=dataonly`. The default base is `https://data-api.ecb.europa.eu`. |
| Request | `GET` with `Accept: text/csv` only. No key, no cookie, no user data. No part of the URL comes from user input. Timeout 10 s. The body is read up to 64 KB. |
| Parse | The second line. `TIME_PERIOD` must be a date and `OBS_VALUE` a number between 0.5 and 3. Anything else counts as a failure. |
| Cache | `DATA_DIR/fx/usd-eur.json` with `{ usdPerEur, date, fetchedAt }`, written atomically (`.tmp` and rename), as the catalog cache. |
| Schedule | At start (not awaited) and every 6 hours. A failure keeps the cached value and logs a warning without the body. |
| Off switch | `ECB_RATES=off` stops every request. The cache still loads. Tests set `off` or point the base at the fake server. |
| Without a rate | The client and the export show USD. |

Nothing else changes:

- LiteLLM, `zdr_guard.py` and the OpenRouter routes stay the same. The cost already arrives in the
  usage chunk.
- The fork reads and writes files inside `DATA_DIR` and calls the internal sidecar. No prompt text
  leaves the host through the fork.
- The usage rows and the `pa` key hold numbers and model ids. The masked-only suite keeps its rule
  that `app.db` and the session JSONL hold no real value.

## UI

The UI follows the design brief in `docs/decisions/phase-9-ui.md`, section 7. All copy is Finnish
(7.9). The reserved names of 7.9 stay as they are. Every new accessible name below is unique on its
screen.

### Edit and fork

- The edit box primary button changes from "Lähetä muokattuna" to "Haarauta" (`default`, 36 h).
  "Peruuta" stays.
- A meta line under the textarea says: "Muokattu viesti aloittaa uuden keskustelun. Tämä keskustelu
  ei muutu."
- While the server works, "Haarauta" is disabled. When `chat.state` arrives with a `forkedFrom` that
  matches the request, the client opens the new chat and adds the edited text as the optimistic user
  message. The original chat keeps its thread.
- A failure shows the toast "Haarautus epäonnistui. Yritä uudelleen." A `pseudo_down` answer shows
  the existing text for that code.
- ↑ in an empty composer still opens the last user message in the edit box. Its send now forks.

### Link row in a forked chat

- At the top of the thread, before the first message: a 32 h row (44 on touch) with `GitBranch` 16
  in `--muted-foreground` and the text in `--text-meta`.
- With a source: a `link` button "Haarautettu keskustelusta ”Verot 2026”". It opens the source chat
  and scrolls to `forkedFrom.messageId`. An untitled source gives "Haarautettu toisesta keskustelusta".
- A deleted source gives plain text: "Haarautettu keskustelusta, joka on poistettu."

### Thinking row

- Place: above the tool rows and the text of its assistant message. Shape: the tool row trigger of
  7.5 (32 h, 44 on touch, chevron 16 that turns 90°).
- Icon `Lightbulb` 16 in `--muted-foreground`. The text is in `--text-meta`, muted, tabular numbers.
- While `message.thinking` is active: `Loader2` turning and "Ajattelee… 8 s". The client counts the
  seconds. This state is a status line, not a button.
- After the message: the trigger "Ajatteli 12 s". At 60 s and more: "Ajatteli 1 min 5 s". The value
  is at least 1 s. Without `ms`: "Ajatteli".
- Open: the client sends `thinking.get` once and keeps the answer. The content box is the tool output
  box of 7.5, but with sans 14/22 text in `--muted-foreground`, `white-space: pre-wrap`, and max height
  320 with scroll. The box is a focusable region named "Mallin ajattelu". Masked spans use the same
  `annotate` as the reply, with the "Malli näki: …" tooltip.
- Loading after 300 ms: "Ladataan…". Error: "Ajattelua ei voitu näyttää." A close and a new open ask
  again.
- Reduced motion: no turning spinner, the text carries the state.
- Settings: a switch row "Näytä ajattelu" after the privacy switch. Helper text: "Näyttää mallin
  ajattelun vastauksen yläpuolella." Off hides every thinking row and the live status.

### Action row meta (time and cost)

- Assistant messages: after Kopioi, Yritä uudelleen and the eye toggle, 8 px gap, one meta text in
  `--text-meta`, muted, tabular: "klo 17.20 · 0,012 € · 3,4 k tokenia".
- User messages: the meta "klo 17.20" before Kopioi and Muokkaa.
- The time is a `<time dateTime>` element. Its desktop tooltip gives the full date:
  "maanantai 26.10.2026 klo 17.20".
- The cost part has a desktop tooltip with two or three lines:
  - "Malli: Claude Opus 5.5" (the catalog name, else the alias name, else the id).
  - "Syöte 3 100 · välimuisti 2 000 · tuloste 300 (ajattelu 120)".
  - For an estimate: "Arvio hinnaston mukaan".
- The meta follows the action row rules of 7.5. It shows on hover and focus, and always under the
  latest assistant turn.
- On touch, the long-press sheet gets the same meta line at its top, under the sr-only title.

### Chat menu

- The ⋯ menu of a chat row ("Lisää: …" on desktop, "Toiminnot: …" in the drawer) gets a separator
  and a non-interactive `DropdownMenuLabel` at the end. It holds "0,42 € · 18 k tokenia" in
  `--text-micro`, muted.
- A chat without tokens shows no label.

### Find bar

- Ctrl+F or Cmd+F in an open chat opens the bar, unless a dialog or the palette is open. A second
  press selects the query text. Esc closes the bar and moves focus back to where it was.
- Place: sticky at the top of the thread column, 8 px from the top, the thread width (672), 44 h,
  bg `--card`, border `--border`, radius 12, `--shadow-sm`. Phone: under the top bar, inset 8 on both
  sides.
- Content from left to right:
  - The input "Etsi keskustelusta" (placeholder and accessible name).
  - The count "3/12" in `--text-meta`. With no hit: "Ei osumia".
  - The icon buttons "Edellinen osuma" (`ChevronUp`), "Seuraava osuma" (`ChevronDown`) and
    "Sulje haku" (`X`). They are 32 px, and 44 px on a phone.
- Enter goes to the next hit and Shift+Enter to the previous one. The current hit scrolls to the
  center of the thread without smooth scrolling.
- Highlights: `::highlight(find)` with bg `--warning-subtle`. The current hit gets
  `::highlight(find-current)` with the stronger fill `--find` and
  `text-decoration: underline 2px var(--warning)`.
- The polite live region says "Osuma 3/12" after each move.
- Without `CSS.highlights`, the bar still counts and scrolls.
- The shortcuts dialog lists "Etsi keskustelusta" with Ctrl F.

### Settings › Käyttö

- The Hallinta group gets the row "Käyttö" (`ChartColumn` 16) after "Tiedostot". It opens the screen
  "Käyttö" (a `Page` at `--page-max`).
- Header: the title and a month `Select` (160 wide, accessible name "Kuukausi"). The items come from
  `months`, for example "lokakuu 2026".
- Summary: the month total in `--text-title`, for example "12,34 €". Under it a meta line:
  "1,2 M tokenia · 342 kutsua".
- Table (≥ 768): the columns "Malli", "Kutsut", "Tokenit" and "Kustannus". The numbers are right
  aligned and tabular. The rows sort by cost, highest first. An `open/` model gets the `Badge`
  (warning) "Ei ZDR" after its name. Under 768 each row is a `Card`, as in 7.5.
- Footer meta: "Kurssi: EKP 23.10.2026, 1 € = 1,1193 $." Without a rate: "Euromuunnos ei ole
  saatavilla. Summat ovat dollareina." When a row is an estimate: "~ = arvio hinnaston mukaan."
- Empty month: title "Ei käyttöä tässä kuussa", line "Kustannukset näkyvät, kun malli on vastannut.",
  no button.
- Phase 15 adds the columns per agent and the search count to this screen.

### New names in one list

"Haarauta", "Mallin ajattelu", "Näytä ajattelu", "Etsi keskustelusta", "Edellinen osuma",
"Seuraava osuma", "Sulje haku", "Käyttö", "Kuukausi". The text "Ajattelu" stays the label of the
thinking group in the model menu (phase 10).

## Task cards

| # | Task | Owner | Files | Acceptance |
| --- | --- | --- | --- | --- |
| 1 | Sidecar scope copy | Opus | `services/pseudo-svc/app/vault.py`, `main.py`, `api_models.py`, `tests/test_api.py`, `tests/test_vault.py`. `packages/pi-ext-pseudo/src/client.ts` (`forkSession`), `fake-sidecar.ts` | pytest: after `/session/fork`, `/scan` in the new session keeps a copied person surrogate. Without the copy, it masks the surrogate again. Spans after `until` are not copied. The seen count and the last-seen time do not change. The fake sidecar copies its seen set |
| 2 | Protocol, database, formatters | Opus | `packages/protocol/src/index.ts`, a new `packages/protocol/src/format.ts` and its test, `packages/db/src/schema.ts`, `packages/db/drizzle/0006_*.sql` | The schemas of "Data model" parse. Formatter tests cover every rule of decision 17 |
| 3 | Usage capture, FX rate, other calls | Opus, after 2 | New: `apps/server/src/usage.ts` (extension, row writer, month query) and `apps/server/src/fx.ts`, each with a test. Changed: `apps/server/src/pi/registry.ts` (extension wiring), `topics.ts`, `memory.ts`, `config.ts` (`ECB_RATES`) and `main.ts`. Also `packages/pi-ext-subagents/src/index.ts` and `tests/fake-llm/src/index.ts` (cost in the usage chunk, reasoning deltas) | Tests: a streamed cost becomes `pa.costUsd` and one `usage` row, and the chat totals grow by the same amount. Without a cost, the row is an estimate. Thinking times give `pa.thinkingMs`. A title job writes a `task` row. A child's reply writes a `subagent` row. The FX parser takes the probe CSV and refuses a bad one. `ECB_RATES=off` makes no request. A failed request keeps the cache |
| 4 | Bridge and export | Opus, after 1 to 3 and after the go-ahead for `bridge.ts` | `apps/server/src/bridge.ts` (`toMessage` usage and thinking, `message.thinking`, `thinking.get`, `chat.fork`, `usage.get`, `fx.state` at attach, `forkedFrom` in `chat.state`, the file window helper, `summary` usage), `apps/server/src/export.ts`, server tests, `tests/masked-only/src/masked-only.test.ts` | Tests: a fork copies the path up to the fork point and leaves the source file byte-equal. The new chat has the link, policy `zdr` and zero totals. Its first request carries the copied masked messages and the edited text, masked once. Copied replies show no cost. `thinking.get` restores the text. A seeded real value in a thinking block is masked in the next request. The masked-only suite passes with a fork and a thinking reply |
| 5 | Pi contract checks | Opus, with 3 | `tests/contract` | A real Pi session keeps the `pa` key after store and reopen. A `message_end` replacement from an extension reaches the JSONL. `provider_stream_event` carries the usage chunk. `createBranchedSession` on a second manager leaves the source file unchanged |
| 6 | Web | UI implementer, after 4 | `apps/web/src/components/MessageView.tsx`, `Thread.tsx` (link row, find bar, turn sums), `Sidebar.tsx` (menu label), `SettingsDialog.tsx` (switch, Hallinta row), a new `UsageScreen.tsx`, `ShortcutsDialog.tsx`, `store.ts`, `ws.ts`, `tests/e2e` | The e2e flows of "Gate" pass. The UI review passes at 390, 1024 and 1440 px in light and dark. Screenshots show the thinking row (closed, open, live), the action row meta with its tooltip and the link row. Other screenshots show the find bar with hits, the chat menu label and Käyttö (rows, empty). axe reports no violation |
| 7 | Documentation | Sonnet, after 4 | `docs/decisions/README.md` (index), `docs/plan.md` (thread section: fork, thinking, cost, find), `docs/deploy.md` (`ECB_RATES`) | The texts match decisions 2, 3, 12 and 16 and the egress table |

Out of scope: an in-thread branch switcher, a thinking text in the export or the search index, cost
of compaction and transcription, a budget alert, and historical exchange rates per day. Add them when
the user asks.

## Gate

1. `pnpm typecheck && pnpm lint && pnpm test` passes.
2. The pseudo-svc tests pass, with the new tests of task card 1.
3. The masked-only suite passes with a fork and a thinking reply.
4. The e2e flows pass:
   1. Open a chat with two turns. Open "Muokkaa" on the first user message, change the text and
      select "Haarauta". A new chat opens with the link row, and the old chat keeps both turns.
   2. With the fake LLM reasoning turn, the row "Ajattelee…" shows while it streams. After the reply
      the row "Ajatteli … s" opens to the thinking text. "Näytä ajattelu" off hides the row.
   3. The action row of the reply shows a time and a cost. The chat menu shows the chat total.
   4. Ctrl+F opens the find bar. Two hits show "1/2". Enter moves to "2/2". Esc closes the bar.
   5. Settings › Käyttö shows the fake model with its cost for the current month.
5. A one-time live check with the real keys, recorded in a "Verified on" line under this section:
   - One `zdr/google/gemini-4-argon` reply and one `zdr/anthropic/claude-sonnet-5.5` reply store
     `pa.costUsd`. The value matches the OpenRouter activity page to four decimals.
   - Record for each of the two models whether a thinking block with text reaches the session.
   - The ECB request works from the container and writes `DATA_DIR/fx/usd-eur.json`.

## Risks

1. **Pi internals.** The cost and the thinking time depend on `provider_stream_event`, on the
   `message_end` replacement and on Pi keeping an unknown key in the JSONL. The contract checks of
   task card 5 catch a change in a later Pi. If one of them breaks, the costs fall back to estimates
   and the row shows no time. Nothing else breaks.
2. **Missing usage chunk.** A stopped reply or a dropped stream may end without the usage chunk.
   OpenRouter still bills the tokens that it sent. Such calls count too low or not at all.
3. **Estimates.** Subagent children, task calls without a cost and streams without a cost use Pi's
   price table. Endpoint prices, cache discounts and the Argon price change of 2026-12-01 can make
   the estimate wrong. The UI marks every estimate with "~".
4. **Calls not counted.** Pi compaction, transcription and remote embeddings are not in the totals.
   The monthly total is lower than the OpenRouter invoice by that amount.
5. **One rate for all months.** The conversion uses the newest ECB rate for past months too. A past
   month in EUR can differ by a few percent from the rate of that month. The footer names the rate
   and its date.
6. **Thinking text per vendor.** Some models return no reasoning text, only summaries, or encrypted
   blocks. Such replies have no thinking row. LiteLLM may also drop the reasoning text of some
   vendors (research 4, UNVERIFIED).
7. **`/scan` and signatures.** `/scan` walks every string, `thinkingSignature` included. If a
   detector matched inside a signature, the provider would refuse the changed signature. The code
   patterns need checksums, so the chance is very small. The failure is a normal model error.
8. **Fork scope and clocks.** The scope copy compares the Pi entry time of pa-server with the span
   time of the sidecar. Both containers read the same host clock. If the clock stepped back between
   two turns, the copy could miss or add the spans of one turn. A missed span lets a tool result mask
   a copied surrogate again. Phase-12 rare pairs keep an added span harmless.
9. **Fork files.** The copied messages show their attachment chips only while the source chat
   exists. Deleting the source deletes the files. The fork's session still holds the masked document
   text and the image data, so the model context does not change.
10. **Fork size.** A fork copies the history, images included, into a second file. Many forks of a
    long chat with images use disk space. Backups grow by the same amount.
11. **Find bar limits.** A match that crosses a formatting boundary (for example bold text inside a
    word) is not found. The bar replaces the browser's own Ctrl+F only while a chat is open.
12. **New egress host.** pa-server calls `data-api.ecb.europa.eu`. The call carries no key and no
    user data. The reviewer checks that the request URL and headers stay fixed.
13. **Locked fork titles.** A titled fork keeps "<old title> (haara)" after the topic changes. The
    user can rename it.

## Status (2026-10-26)

All seven task cards are done. Commits: `7158c13` and `f6f0a20` (server), `9fc9969`, `5859515`
and `090710a` (web), `5517287` (`message.accepted`), `ea7abaf` (docs). Server review: no blocking
item, 15 should-fix items, all fixed. Web review: two blocking items in the fork path (the client
guessed the server id of a sent message by position), closed by the server message
`message.accepted` built on a per-session prompt queue that follows Pi's preflight outcome; a
second review of that path found two more blocking cases (overlapping and steered prompts),
closed in `5517287` with four timing tests and a Pi contract check. The scored UI review passed
after two rounds with every cell at 5. The gate run is recorded in the README status line.
