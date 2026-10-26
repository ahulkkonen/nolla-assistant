# Phase 16: Polish

This record holds the decisions, the research, the data model, the task cards and the gate of
phase 16. The user made the decisions in "Decisions" before the work started. They are final. The
records of phase 13 (usage and cost), phase 15 (agent files and seeding) and phase 10 (model policy)
stay valid, except where this record changes them.

## Goal

1. One agent. The assistant always works in depth, like a coding agent. There is no "deep mode".
2. The browser reports Content-Security-Policy violations to the server, and the server logs them.
3. The user can see how much of each reply, each chat and each month came from the prompt cache.
4. A scanned PDF gives text to the model. The server reads it with local OCR.
5. The desktop chat header can show the cost of the open chat.

Constraints:

- No new npm dependency.
- No remote OCR service. Images are not OCR'd: they go to the model as native images, as today.
- The server never logs the OCR text, a CSP report body or a query string.
- The pseudonymization layer stays the only path for prompts. The OCR text goes into the prompt at
  the same place as the text of a text PDF, so the pseudo extension masks it like any other prompt
  text.

## Research findings

All pages were read on 2026-10-26.

### 1. Reporting API

Source: https://www.w3.org/TR/reporting-1/ (sections 3.2, 3.3 and 3.5.2).

- Each `Reporting-Endpoints` member value is "interpreted as a URI-reference", and the parser runs
  "with base URL set to response's url". So a relative value such as `/api/csp-report` is valid.
- The endpoint "MUST be potentially trustworthy". "Non-secure endpoints will be ignored." So a
  browser sends `report-to` reports only over HTTPS or to `localhost`.
- Reports are POSTed with the media type `application/reports+json` (a JSON array). The request
  uses the credentials mode `same-origin`.

### 2. CSP reporting directives

Sources: https://www.w3.org/TR/CSP3/ (sections 1.3, 3.1, 5),
https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/report-uri

- `report-uri` "is deprecated in favor of the new `report-to` directive".
- MDN: "in browsers that support `report-to`, the `report-uri` directive is ignored". MDN shows
  both directives in one policy until `report-to` has broad support.
- `report-uri` POSTs with `Content-Type: application/csp-report`. The body has one key,
  `csp-report`, with `document-uri`, `violated-directive`, `effective-directive`, `blocked-uri`,
  `original-policy`, `referrer`, `script-sample`, `status-code` and `disposition`.
- A `report-to` report has `type: "csp-violation"` and a `body` with `documentURL`, `blockedURL`
  and `effectiveDirective` (the `CSPViolationReportBody` dictionary).
- MDN: "Violation reports should be considered attacker-controlled data."

### 3. Tesseract and Poppler on the base image

Sources: https://packages.debian.org/bookworm/tesseract-ocr,
https://tesseract-ocr.github.io/tessdoc/Command-Line-Usage.html, `pdftoppm -h` (Poppler 24 local).

- The server image is `node:22.23.2-bookworm-slim` (Debian 12, `apt-get`). Bookworm has
  `tesseract-ocr` 5.3.0-2. It depends on `tesseract-ocr-eng` and `tesseract-ocr-osd`. The packages
  `tesseract-ocr-fin` and `tesseract-ocr-swe` hold the Finnish and Swedish models.
  `poppler-utils` holds `pdftoppm`.
- "Add `-l LANG[+LANG]` to the command line to use multiple languages together". The output base
  `-` writes the text to stdout (`tesseract images/eurotext.png - -l eng`).
- `--psm 3` is "Fully automatic page segmentation, but no OSD. (Default)."
- `pdftoppm -r 200 -png -f N -l N <pdf> <prefix>` writes page N as one PNG file.

### 4. Repository facts

- `CallUsage` already has `input`, `output`, `cacheRead`, `cacheWrite`, `reasoning`, `costUsd` and
  `estimated`. Each assistant `Message.usage` in `chat.state` and each message of the chat export
  carries it. So the per-reply hit rate needs no protocol change.
- `ChatUsage` has only `costUsd` and `tokens`. The `chats` row holds the running totals of the same
  two values (phase-13 decision 13). `ChatSummary.usage` (in `chat.list`, `chat.created`,
  `chat.state` and `chat.updated`) and `ChatExport.chat.usage` carry it.
- `usage.state` rows have `calls`, `tokens`, `reasoning`, `costUsd` and `estimated`, but no split
  of the tokens.
- `auth/routes.ts` exports `limiter(app, max, windowMs)`, a sliding-window counter per key.
- `infra/compose.yaml` runs `pa-server` with `read_only: true`, a `/tmp` tmpfs and
  `mem_limit: 400m`. The uploads live in `DATA_DIR/files/<user>`.
- The registry threw "Agent profile X not found" when a chat's stored agent id had no profile.

## Decisions

### One agent

1. **Avustaja is deep.** `agents/assistant.yaml` gets `bash` in `tools.allow`, `subagents: true`,
   `approval.always: [write, edit, bash]` and `approval.never: [read, subagent, recall, memory,
   web_search]`. The prompt gets the researcher's paragraph as its second paragraph: thorough
   answers, compare sources, say what stays uncertain. The web search paragraph does not change.
2. **Tutkija goes.** `agents/research.yaml` and `agents/prompts/research.md` are deleted. The tests
   that used `research` for `bash` or subagents now use `assistant`. The tests that need a second
   profile (agent picker, per-chat agent, editor) write a test-only profile `kirjoittaja`
   ("Kirjoittaja") into their own agents folder.
3. **A missing profile falls back.** When a chat's stored agent id has no profile, the registry
   builds the session with the profile of `DEFAULT_AGENT_ID`. The chat row keeps its id. The usage
   rows of such a chat get the default agent's id, because that agent ran.
4. **No migration in code.** An existing install keeps its copy of `research.yaml` in
   `DATA_DIR/agents` (phase-15 decision 4). `docs/deploy.md` tells the user to delete "Tutkija" in
   Settings › Agentit after this upgrade. That delete moves the chats of Tutkija to Avustaja.
5. **The composer agent picker stays.** It lists the profiles that the user has.

### CSP reports

6. **Policy.** The HTML policy gets `report-uri /api/csp-report` and `report-to csp`. Each HTML
   response also gets `Reporting-Endpoints: csp="/api/csp-report"`. The sandbox policy of
   `/api/files/:id` and the artifact frame get no reporting directive: a sandboxed document has an
   opaque origin and cannot post.
7. **Route.** `POST /api/csp-report` needs no session. It accepts `application/csp-report` and
   `application/reports+json`. Fastify's default parsers also accept `application/json` and
   `text/plain`; such a body holds no report and gives no log line. Another type answers 415. The
   body limit is 16 KB (413 above it).
8. **Rate limit.** The route uses `limiter(app, 30)` with one global key: at most 30 reports per
   minute, then 429 with `{ error: 'rate_limited' }`. A global key keeps the log bounded when many
   addresses send.
9. **Log.** One warn line per violation, at most 10 per request: `csp violation` with `directive`
   (the effective or violated directive), `blocked` (the origin of the blocked URL, or its scheme,
   or a keyword such as `inline` or `eval`) and `path` (the path of the document URL, without query
   or fragment). The body, the sample and the query string are never logged. The answer is 204.

### Cache visibility

10. **Raw counts, not a rate.** The server sends the raw token counts. The client computes the hit
    rate as `cacheRead / (input + cacheRead + cacheWrite)`, and shows nothing when the divisor is 0.
11. **Per reply.** `Message.usage` (a `CallUsage`) already has the counts. No change.
12. **Per chat.** `ChatUsage` gets the optional fields `input`, `output`, `cacheRead` and
    `cacheWrite`. The `chats` row gets four running-total columns. Migration 0008 adds them and
    fills them from the chat's `usage` rows. `usageRecorder` adds to them in the same transaction as
    `costUsd` and `tokens`. The chat export JSON (`chat.usage`) carries them too.
13. **Per month.** Each `usage.state` row (per model) gets the optional fields `input`, `output`,
    `cacheRead` and `cacheWrite`, the sums of the month.

### OCR

14. **When.** A PDF whose extracted text has fewer than 50 non-space characters per page on average
    is OCR'd. A PDF whose extraction failed is not.
15. **How.** Per page, `pdftoppm -r 200 -png -f N -l N` writes one PNG to a temp dir under
    `DATA_DIR/files/.ocr-*`, and `tesseract <png> - -l fin+swe+eng --psm 3` reads it. The PNG is
    deleted after its page, and the temp dir after the file. Pages are joined with the line
    `--- sivu N ---`. Both binaries run with `execFile` (no shell), a timeout, a 16 MB `maxBuffer`
    and `OMP_THREAD_LIMIT=1`.
16. **Caps.** At most 30 pages and 90 seconds per file. Past a cap, the text ends with the note
    `(OCR katkaistu: N/M sivua)`. The text is cut at 60,000 characters like other documents.
17. **Label.** The block header is `[Liite: <name> (OCR)]`. `splitBlocks` reads the name without the
    suffix, so the document name in `chat.state` stays exact.
18. **Fallback.** When `pdftoppm` or `tesseract` is missing (ENOENT), the server keeps the
    extracted text as today and logs one warn line `ocr unavailable` once per process. Any other
    failure keeps the extracted text and logs `ocr failed` with the error code only. The OCR text
    is never logged.
19. **Image.** `infra/Dockerfile.server` installs `tesseract-ocr`, `tesseract-ocr-fin`,
    `tesseract-ocr-swe`, `tesseract-ocr-eng` and `poppler-utils` in a shared `os` stage. A
    `server-test` stage (built only on request) adds the dev dependencies and the sources, so the
    OCR test runs on the same packages as production.

### Chat cost in the header

20. **No server change.** `ChatSummary.usage` of the open chat (`chat.state.chat.usage`, updated by
    `chat.updated`) already carries `costUsd` and `tokens`, and now the four token counts.

## Data model

### Protocol (`packages/protocol/src/index.ts`)

```ts
/** A chat's running totals (phase-13 decision 13; the token split is phase-16 decision 12). */
export const ChatUsage = z.object({
  costUsd: z.number().min(0),
  tokens: z.int().min(0),
  input: z.int().min(0).optional(),
  output: z.int().min(0).optional(),
  cacheRead: z.int().min(0).optional(),
  cacheWrite: z.int().min(0).optional(),
});
// usage.state rows: + input, output, cacheRead, cacheWrite (z.int().min(0).optional())
```

### Database (`packages/db/src/schema.ts`, migration `0008_fuzzy_hydra`)

```ts
// in `chats`, after `tokens`
input: integer().notNull().default(0),
output: integer().notNull().default(0),
cacheRead: integer().notNull().default(0),
cacheWrite: integer().notNull().default(0),
```

The migration fills the new columns with the sums of the chat's `usage` rows.

### Fields for the web

| Place | Message and path | Fields |
| --- | --- | --- |
| Reply meta tooltip | `chat.state.messages[].usage` (`CallUsage`) | `input`, `cacheRead`, `cacheWrite`, `output`, `reasoning`, `costUsd`, `estimated` |
| Chat menu line, desktop header | `ChatSummary.usage` in `chat.list.chats[]`, `chat.state.chat`, `chat.updated.chat`, `chat.created.chat` | `costUsd`, `tokens`, `input?`, `output?`, `cacheRead?`, `cacheWrite?` |
| Usage screen, per model | `usage.state.rows[]` | `input?`, `output?`, `cacheRead?`, `cacheWrite?` (plus the existing fields) |
| Chat export JSON | `chat.usage`, `messages[].usage` | as above |

Hit rate: `cacheRead / (input + cacheRead + cacheWrite)`. The fields are optional in zod, so an
older fixture stays valid. The server always sets them.

## Routes

| Method and path | Body | Answer |
| --- | --- | --- |
| `POST /api/csp-report` | `application/csp-report` or `application/reports+json`, at most 16 KB | 204; 400 for a bad body, 413, 415, 429 |

## Task cards

| # | Task | Owner | Files | Acceptance |
| --- | --- | --- | --- | --- |
| 1 | One agent | server | `agents/assistant.yaml`, `agents/prompts/assistant.md`, deleted `agents/research.*`, `apps/server/src/pi/registry.ts`, server tests, `tests/e2e/src/*`, `docs/deploy.md`, `docs/plan.md` | No reference to `research`; a stale agent id opens with the default agent (unit test) |
| 2 | CSP report endpoint | server | `apps/server/src/http.ts`, `apps/server/src/csp.ts`, `apps/server/src/csp.test.ts` | A report is logged and answered 204; a flood gets 429 |
| 3 | Cache visibility | server | `packages/protocol`, `packages/db` (migration 0008), `apps/server/src/usage.ts`, `bridge.ts`, `export.ts`, tests | Aggregation tests pass |
| 4 | OCR for scanned PDFs | server | `apps/server/src/files.ts`, `apps/server/src/ocr.ts`, `apps/server/src/ocr.test.ts`, `infra/Dockerfile.server` | The OCR test passes in the `server-test` image; the compose smoke passes |
| 5 | Chat cost in the header | web, later | `apps/web` | Uses `chat.state.chat.usage` |
| 6 | Cache hit rate in the reply tooltip, chat menu and Usage screen | web, later | `apps/web` | Uses the fields in "Fields for the web" |

## Gate

1. `pnpm typecheck`, `pnpm lint` and `pnpm test` pass for `apps/server`, `packages/protocol`,
   `packages/db` and the e2e sources.
2. Server tests: "registry: a chat whose agent profile is gone opens with the default agent";
   "csp report: logged and 204; a flood gets 429"; "usage: chat totals and month rows carry the
   token split"; "ocr: a scanned PDF gives its text" (skipped without `tesseract`).
3. The OCR test passes in the image:

   ```sh
   docker build -f infra/Dockerfile.server --target server-test -t pa-server:test .
   docker run --rm -v "$PWD/apps/server/src:/app/apps/server/src:ro" pa-server:test \
     pnpm --filter @pa/server exec vitest run src/ocr.test.ts
   ```

   `.dockerignore` drops `*.test.ts`, so the command mounts the server sources.

4. The compose smoke: `docker compose -f infra/compose.yaml up --wait` with placeholder values in
   the environment answers `/healthz`.

## Risks

1. **Memory.** Tesseract with `fin+swe+eng` peaked at 123 MB (VmHWM) on a full A4 page at 200 dpi
   in the smoke container, while the idle server used 184 MB of its `mem_limit: 400m`. The server
   reads one page at a time and one file at a time per message, with `OMP_THREAD_LIMIT=1`. If the
   container hits the limit, raise `mem_limit`.
2. **Time.** A 30-page scan can take up to 90 seconds before the prompt goes to the model. The chat
   shows the normal working state during that time.
3. **OCR quality.** OCR text can have wrong characters. A wrong character in a name can make the
   pseudo layer miss the name. This is the same risk as a name that the user types with a typo.
4. **Stale temp dirs.** A crash during OCR leaves a `DATA_DIR/files/.ocr-*` folder. It holds at most
   one page image.
5. **Image size.** The runtime image grows from 257.8 MB to 303.9 MB (content size, +46 MB), and
   from 1.10 GB to 1.25 GB on disk.
6. **Report noise.** Browser extensions cause CSP reports. The log has the directive and the origin
   only, so the noise is short.

## Status (2026-10-26)

Server task cards 1 to 4 are done. Commits: `6e1e64f` (record), `755e49b` (one agent), `f7de9fb`
(CSP reports), `7d499e9` (token split), `078017d` (OCR). Gate: `pnpm typecheck` and `pnpm lint`
pass; server 168 tests pass and 1 is skipped locally (the OCR test, no `tesseract` on the Mac);
protocol 40 and db 1 pass; the OCR test passes in the `server-test` image; the compose smoke has
every service healthy. The e2e tests of the agent picker, the agent editor and the subagent row
pass. Task cards 5 and 6 (web) are open.
