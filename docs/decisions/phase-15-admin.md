# Phase 15: Admin

The fixed decisions are in `phase-11-15-plan.md`, section "Phase 15". This record adds the research,
the decisions that the plan left open, the data model, the routes, the UI, the task cards, the gate
and the risks. The records of phase 5 (profiles and automations), phase 8 (memory files), phase 11
(work dir), phase 13 (usage rows) and phase 14 (`kind: 'search'`) stay valid.

Two plan items change after the research:

- Plan item 4 says "AES-256 encrypted ... (zip AES per the standard, or an age-encrypted archive if
  the zip library cannot)". The export is a plain zip inside an OpenSSL `enc` file (AES-256-CBC, key
  from PBKDF2-HMAC-SHA256). It needs no new dependency, and the stock `openssl` of macOS and Linux
  decrypts it with one command (decision 13). Zip AES needs a new package and a tool that macOS does
  not ship. `age` does not use AES.
- Plan item 1 says the agent editor writes `agents/<id>.yaml` "git-tracked". In production the image
  is read-only, so the editable profiles live in `DATA_DIR/agents` and `DATA_DIR/automations`, and
  the server commits each change to a git repository in that folder (decision 4).

## Goal

The user manages the assistant from Settings without a code change:

1. Agentit: a form per agent, with a YAML tab. New agent, duplicate, delete.
2. Automaatiot: a form per automation, with schedule presets, a raw cron field, a next-runs
   preview, enable and disable, and "Aja nyt".
3. Laitteet: the signed-in devices, with "Kirjaa ulos" per device and "Kirjaa ulos kaikkialta".
4. "Vie kaikki tiedot": one encrypted file with every chat, the vault, the memory files, the work
   dir and the uploads.
5. Käyttö: the monthly cost per agent and the number of web searches.

Constraints:

- No new third-party dependency.
- The pseudonymization layer stays the only path for prompts. The export restores real values only
  through the same sidecar path as the chat export.
- A profile or automation that the server writes passes the same zod schema as the loader.
- `apps/server/src/bridge.ts` changes only in two parameter types (decision 15).

## Research findings

All pages were read on 2026-10-26.

### 1. Zip AES (WinZip AE-1 and AE-2)

Sources: https://www.winzip.com/en/support/aes-encryption/,
https://pkwaredownloads.blob.core.windows.net/pem/APPNOTE.txt

- The format supports "only 128-, 192-, and 256-bit encryption keys". AES-256 has the mode value
  0x03 and a 16-byte salt. AE-2 stores 0 in the CRC field and relies on the authentication code.
- An AES entry has the compression method 99. Zip tools "typically do not attempt to extract files
  compressed with unknown methods".

### 2. Which tools open an AES zip

Sources: https://access.redhat.com/solutions/59700,
https://sunsite.icm.edu.pl/packages/info-zip/crypt/readme_aes_wg.txt, the local `unzip -v`.

- Red Hat: the error "unsupported compression method 99" means AES encryption, which the stock
  `unzip` does not support. The workaround is 7-Zip.
- Info-ZIP: AES support is in "UnZip (version 6.1 and later)". This Mac has "UnZip 6.00 of 20 April
  2009, by Info-ZIP, with modifications by Apple Inc.". So the stock command line cannot open an AES
  zip. The user would need 7-Zip, Keka or a similar tool.

### 3. A maintained npm package for zip AES

Sources: https://gildas-lormeau.github.io/zip.js/, https://registry.npmjs.org/@zip.js/zip.js

- `@zip.js/zip.js` lists "Support of WinZIP AES and PKWare ZipCrypto encryption". AES entries are
  written in the AE-2 format. It has no third-party dependency and works in Node.js 18 and later.
  AES runs in its own JavaScript code; Web Crypto only speeds up the key derivation.
- The latest version is 2.24.0, published 2026-10-16T17:00:51Z (10 days before 2026-10-26, so it
  meets the 7-day rule). License BSD-3-Clause.
- Rejected: it is a new dependency for a format that the user cannot open with stock tools
  (finding 2).

### 4. age

Source: https://github.com/C2SP/C2SP/blob/main/age.md (the target of https://age-encryption.org/v1)

- The payload is split into 64 KiB chunks, and "each of them is encrypted with ChaCha20-Poly1305".
  The scrypt recipient uses N = 2^(work factor), r = 8, p = 1.
- AES is not used anywhere in the format. The user would also need to install `age`.
- Rejected: the plan asks for AES-256, and the decrypt tool is not preinstalled.

### 5. OpenSSL `enc`

Sources: https://docs.openssl.org/3.0/man1/openssl-enc/, local runs.

- `-pbkdf2`: "Use PBKDF2 algorithm with a default iteration count of 10000 unless otherwise specified
  by the -iter command line option". The default `-md` "is sha-256".
- With a random salt, "the first bytes of the encrypted data are reserved to store the salt". The
  file starts with the 8 bytes `Salted__` and the 8-byte salt (local `xxd` of an `openssl enc`
  output).
- `enc` "does not support authenticated encryption modes like CCM and GCM". So the format has no
  authentication tag. The padding gives only "a rudimentary integrity or password check".
- Local check on 2026-10-26: a file from Homebrew OpenSSL 4.0.3 with
  `-aes-256-cbc -pbkdf2 -iter 600000 -md sha256` decrypts with the macOS system `/usr/bin/openssl`
  (LibreSSL 3.3.6) with the same flags. The gate test also decrypts the server's own output with
  `openssl` (decision 13).

### 6. Key derivation cost

Source: https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html

- "PBKDF2-HMAC-SHA256: 600,000 iterations (recommended)."

### 7. A zip without a library

Sources: https://nodejs.org/api/zlib.html, the APPNOTE above.

- `zlib.crc32(data[, value])` was "Added in: v22.2.0, v20.15.0". The server runs Node 22.23.2
  (`infra/Dockerfile.server`), so CRC-32 and raw deflate are in the standard library.
- General purpose bit 3 puts the CRC and the sizes in a data descriptor after the data, so an entry
  can stream. The signature 0x08074b50 "has commonly been adopted". Bit 11 marks UTF-8 names.
- Sizes and offsets above 0xFFFFFFFF need ZIP64. A cap below 4 GiB avoids ZIP64.
- `jszip` 3.10.2 and `adm-zip` 0.6.1 are in `node_modules` only as transitive packages, and both
  build archives in memory. They are not used.

### 8. Cron preview

Source: `node_modules/node-cron` 4.6.0 (`dist/node-cron.d.ts`) and a local run.

- `createTask(expression, fn, { timezone })` returns a stopped task with `getNextRuns(count)`. The
  task is listed in `getTasks()` until `destroy()`. A local run of `30 7 * * 1-5` in
  `Europe/Helsinki` gave 05:30 UTC on the next five weekdays.
- `validateDetailed` names the bad field ("61 is a invalid expression for minute").

### 9. Repository facts

- `authSessions` already has `createdAt` and `lastSeenAt`. `lastSeenAt` moves at most once per
  minute (`getUser` in `apps/server/src/auth/session.ts`). The row id is the sha256 of the cookie
  token. A live WebSocket is checked only at the upgrade, so a deleted row does not close it.
- `infra/compose.yaml` runs `pa-server` with `read_only: true` and one volume, `/data`. The image
  copies `agents/` and `automations/` to `/app`, and `AGENTS_DIR` and `AUTOMATIONS_DIR` default to
  those folders.
- The registry reads the profile at every session build. An open session keeps the profile that it
  was built with until it is evicted.
- `chatExport` (`apps/server/src/export.ts`) builds a full `AgentSession` with `registry.get`, but
  `history` and `transcript` read only `session.sessionManager.getBranch()`.
- The memory files hold real values (phase-8 decision 1), and so do the work dir files (phase-11
  decision 7).
- The sidecar route `GET /vault/entities` (`PseudoClient.vaultList`) returns every entity with its
  real form and surrogate, and the pending items. There is no other vault export route.

## Decisions

### Transport

1. **HTTP for writes, WebSocket for state.** The editors save with HTTP JSON routes, because a form
   needs a request and a response with the field that failed. The export start and the download are
   HTTP routes too. The state that other screens show goes to every socket: `agents.state` (as
   today), `automations.state` and the new `export.state`. The bridge gets no new message handler.
2. **Errors.** A failed check answers HTTP 400 with `{ error: 'bad_message', path, message }`.
   `path` is the dotted field path of the first zod issue or check (for example `tools.allow.0`,
   `model`, `cron`), or `''` for a YAML syntax error. `message` is an English diagnostic; the UI
   shows its own Finnish text per field and shows `message` only in the YAML tab. The other codes
   are `not_found` (404), `exists`, `default_agent`, `in_use`, `busy` (409), `gone` (410),
   `too_large` (413) and `pseudo_down` (503).

### Agents

3. **Form fields and validation.** The loader's schema moves to `packages/protocol` as `AgentFile`,
   and `loadAgents` imports it from there, so the editor and the loader use one schema. The form has
   these fields: name, model, prompt (Markdown text), `tools.allow`, `tools.mcp`, `approval.always`,
   `approval.never` and `subagents`. `skills` is kept on a round trip and shown in the YAML tab. The
   id is shown read-only. After the schema, the server checks, in this order:
   - The model is an alias of `infra/models.json` or a catalog model with ZDR, written as
     `zdr/<vendor>/<model>`. The schema's model pattern now also allows that form (plan item 1:
     "model alias or catalog model").
   - `tools.mcp` is not checked against `infra/mcp.yaml`: the loader only warns about an unknown
     server, and the form offers only the servers of `options.mcp`. A check would block a save
     while a server is missing from the file for a while.
   - Each of `write`, `edit`, `bash` and `subagent` (when allowed) is in `approval.always` or
     `approval.never`. The loader only warns about this; the editor refuses it, because a new agent
     would otherwise run such a tool without asking.
   - The prompt text has 1 to 100,000 characters.
4. **Save.** The prompt path is fixed by the server: `prompts/<id>.md` for a new agent, and the
   current path for an existing one (another path answers `bad_message` with path `prompt`). The
   server writes the prompt file, then the YAML file, each to a temp file that it renames. Then it
   reloads the profiles with the same function as the file watcher and sends `agents.state` to every
   socket. The watcher's own reload 1 s later finds no change. The reload keeps the old object of
   every profile that did not change, and the registry rebuilds a session at its next `get` when the
   session's profile object is not the current one. An idle chat therefore gets the new profile at
   its next message; a running chat finishes its turn with the old one.
   - Git: when the folder is under `DATA_DIR`, the server commits each save and delete to a git
     repository in that folder, with the helper that versions the memory files (moved from
     `memory.ts` to `git.ts`). In development the folder is the repository's `agents/`, which the
     repository's own git tracks, so the server does not commit there.
   - Production: `infra/compose.yaml` sets `AGENTS_DIR=/data/agents` and
     `AUTOMATIONS_DIR=/data/automations`. At start, a missing folder is seeded with a copy of the
     image's folder. After that, an image update does not change the user's profiles (risk 3).
5. **New, duplicate and delete.**
   - New: `POST /api/agents`. Without an id, the server makes one from the name (ASCII, lower case,
     `-` between words, at most 56 characters, then `-2`, `-3` … when taken). An id that exists
     answers `exists`.
   - Duplicate is a client action: the UI posts a copy of the agent with the name "<name> (kopio)"
     and the same prompt text. The copy gets its own prompt file.
   - Delete: `DELETE /api/agents/:id`. The server refuses the default agent `assistant`
     (`default_agent`), an agent that a running chat uses (`in_use` with `chats`), and an agent that
     an automation names (`in_use` with `automations`, the ids). Otherwise it deletes the YAML file
     and the prompt file (when no other profile uses it), moves the agent's chats to `assistant` in
     one update, reloads and commits. The usage rows keep the old agent id.
6. **The YAML tab round trip.** `GET /api/agents` returns, per file, the raw YAML text, the parsed
   profile and the prompt text. A file that fails the schema is listed with `profile: null` and its
   error, so the user can repair it in the YAML tab.
   - A save from the form sends `{ profile, prompt }`. The server merges the fields into the existing
     YAML document key by key, so the comments on unchanged keys stay, and lists stay in flow style.
   - A save from the YAML tab sends `{ yaml, prompt }`. The server writes the text as sent (with
     the fixed id and prompt path).
   - A tab switch calls the same route with `?dry=1`. The server runs every check and returns the
     document (parsed profile and YAML text) without a write, or the error with its path.

### Automations

7. **The form.** Fields: name, agent, prompt, delivery (chat, push, both), schedule, enabled, and
   the existing `autoApprove` (shown as the agent's `approval.always` tools with checkboxes). The
   automation file gets an optional `name` (1 to 80 characters); without it the UI shows the id.
   The time zone stays `Europe/Helsinki` and is kept on a round trip. A new automation gets its id
   from the name like an agent. The server checks the schema, then that the agent exists.
8. **Schedule presets.** `packages/protocol` exports `scheduleToCron` and `cronToSchedule`:
   - "Päivittäin klo HH.MM" is `M H * * *`.
   - "Arkisin klo HH.MM" is `M H * * 1-5`.
   - "Viikoittain <päivä> klo HH.MM" is `M H * * D`, with D 1 (maanantai) to 6 and 0 (sunnuntai).
   - Any other expression is "Oma", and the raw cron field shows it.
9. **Next runs.** `POST /api/automations/preview { cron, timezone }` returns the next five run times
   (ISO 8601 UTC) from node-cron's own `createTask(...).getNextRuns(5)`, so the preview and the
   scheduler cannot disagree. A bad expression answers `bad_message` with path `cron`.
   `automations.state` gets `nextRunAt` per enabled automation.
10. **Save, enable, run.** Save writes `automations/<id>.yaml` like a profile (temp file, rename,
    merge into the existing document), reschedules at once, sends `automations.state` to every
    socket and commits. Enable and disable is a save with `enabled` changed. "Aja nyt" uses the
    existing `automations.run` message and `runNow`, which also runs a disabled automation. Delete
    removes the file and its `automationRuns` row. A file that fails to load stays out of the list
    and is logged, as today.

### Devices

11. **Columns and list.** `authSessions` gets `deviceLabel` (text, nullable), set at login from the
    `User-Agent` header: browser and system, for example "Safari · iPhone" or "Chrome · macOS". The
    raw header is not stored. Older rows have no label, and the UI shows "Tuntematon laite".
    `createdAt` and `lastSeenAt` exist. `GET /api/auth/sessions` lists the user's sessions, newest
    `lastSeenAt` first, with `current` true for the session of the request.
12. **Revoke.**
    - `DELETE /api/auth/sessions/:id` deletes one session. When it is the current one, the
      response also clears the cookie.
    - `POST /api/auth/sessions/revoke-all` deletes every session of the user and gives the current
      device a new token: a new row with the old `createdAt` and label, and a new cookie. This is
      the secret rotation: a copy of this device's old cookie stops working too. The old
      `createdAt` keeps the 10-minute fresh-login rule for passkey registration unchanged.
    - Every open WebSocket of a deleted session closes with code 4401. The current device's
      sockets move to the new session. Logout closes the sockets of its session too.
    - Revoke needs no fresh login, so the protective action is one click. A stolen cookie could
      sign the owner out, and the owner then signs in and revokes the thief (risk 6).

### Full export

13. **Encryption.** The file is the OpenSSL `enc` format: `Salted__`, an 8-byte random salt, then
    AES-256-CBC with PKCS#7 padding. PBKDF2-HMAC-SHA256 with 600,000 iterations derives 48 bytes from
    the passphrase and the salt: the first 32 are the key, the last 16 the IV. The user decrypts with
    this command, which asks for the passphrase:

    ```sh
    openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 -in pa-vienti-2026-10-26-avoin.zip.enc -out pa-vienti-2026-10-26-avoin.zip
    ```

    The dialog shows the command from `decryptCommand(fileName)`. The passphrase has 12 to 1,024 characters. The server keeps it in
    memory only until the key is derived and never logs or stores it. The zip is streamed through the
    cipher into the file, so no unencrypted copy is written to disk. The zip writer
    (`apps/server/src/zip.ts`) is about 100 lines on `node:zlib`: deflate, data descriptors, UTF-8
    names, no ZIP64.
14. **Contents.** The archive has these entries:
    - `keskustelut/<name>-<id8>.md` and `.json` for every chat, archived ones too, from
      `chatExport` and `toMarkdown`. `<name>` is the chat export's file name without its extension,
      and `<id8>` the first 8 characters of the chat id. There is no message cap.
    - `vault.json`: the sidecar's entity list and pending items (`GET /vault/entities`).
    - `muisti/USER.md` and `muisti/MEMORY.md`.
    - `tyokansio/<path>`: every regular file of the work dir, without `.trash`. Symlinks are skipped
      and listed in the manifest. A file is opened with `O_NOFOLLOW` after a check that its folder is
      inside the work dir.
    - `liitteet/<id>-<name>`: the chat uploads.
    - `manifest.json`: version 1, the time, `masked`, the chat count, every entry with its size, the
      skipped entries with a reason, and the left-out parts.
15. **Masked or open.** The dialog asks "Nimet" like the chat export, with "Niin kuin malli näki ne"
    as the default.
    - Open: the chats with real values (the sidecar restores them, as in the chat export) and all
      other parts. Without a sidecar, the start answers `pseudo_down`.
    - Masked: only the chats, as the model saw them, and the manifest. The vault, the memory files,
      the work dir and the uploads hold real values and have no masked form, so the manifest lists
      them under `omitted`.
    - `chatExport` reads the session entries through a new `registry.reader(chatId)`: the open
      session's manager, or the JSONL file opened once. No agent session is built for an export.
      `history` and `transcript` in `bridge.ts` take `Pick<AgentSession, 'sessionManager'>`.
16. **The job.** `POST /api/export { passphrase, unmask }` starts a background job and answers 202
    with the job. One job at a time: a running job answers `busy`, and a new start replaces a ready
    or failed one. When open, the start first checks the work dir and the uploads against the cap.
    - The job writes `DATA_DIR/exports/<job>/<file>.part` (mode 0600) and renames it when complete.
    - Progress: `done` and `total` count chats, files and the other parts. `export.state` goes to
      every socket at most every 250 ms and on each status change. `GET /api/export` returns the job
      for a screen that opens later.
    - `DELETE /api/export/:id` cancels a running job or deletes a ready file.
    - A failure (`pseudo_down`, `too_large`, `failed`) deletes the file and keeps the failed job, so
      the dialog can say why. The log has the error code and the error class name, never a message
      (a message can hold a file name).
17. **Download once, then gone.** `GET /api/export/:id/download` needs only the session cookie. It
    streams the file as `application/octet-stream` with `Content-Disposition: attachment` and
    `Cache-Control: no-store`. When the response completes, the server deletes the file and the job
    (`export.state` with `job: null`). An interrupted download keeps the file for another try. A
    ready file is deleted one hour after it is ready. At start, the server deletes everything under
    `DATA_DIR/exports`, because jobs live in memory.
18. **Size cap.** At most 2 GiB of input (the sum of the entry sizes before compression) and 65,000
    entries. The cap keeps the zip below the ZIP64 limits (finding 7) and the disk use bounded. A job
    that passes the cap while it runs fails with `too_large`.

### Usage

19. **Per agent and searches.** `usage.state` gets `agents` (per agent id of the month's rows:
    calls, tokens, cost, estimated, highest cost first; a null id is a task without a chat) and
    `searches` (the number of `kind: 'search'` rows in the month). The client maps an agent id to
    its name with `agents.state` and shows the id of a deleted agent.

## Data model

### Protocol (`packages/protocol/src/index.ts`)

```ts
export const DEFAULT_AGENT_ID = 'assistant';
const names = z.array(z.string().min(1).max(64));
/** `agents/<id>.yaml` (phase-5 decision 1); the loader and the editor use it. `prompt` is a path. */
export const AgentFile = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,64}$/),
  name: z.string().min(1).max(80),
  /** An alias (`zdr/strong`) or a ZDR catalog model (`zdr/google/gemini-4-argon`). */
  model: z.string().regex(/^zdr\/(?:[A-Za-z0-9._-]+|[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)$/),
  prompt: z.string().min(1),
  skills: names.default([]),
  tools: z.object({ allow: names, mcp: names.optional() }).strict(),
  approval: z.object({ always: names.default([]), never: names.default([]) }).strict()
    .default({ always: [], never: [] }),
  subagents: z.boolean().default(false),
}).strict();

export const AgentDoc = z.object({
  id: z.string(),
  /** Null when the file fails the schema; `error` says why. */
  profile: AgentFile.nullable(),
  yaml: z.string(),
  prompt: z.string(),
  error: z.string().nullable(),
});
export const AgentPrompt = z.string().min(1).max(100_000);
export const AgentSave = z.union([
  z.object({ yaml: z.string().min(1).max(100_000), prompt: AgentPrompt }),
  z.object({ profile: z.record(z.string(), z.unknown()), prompt: AgentPrompt }),
]);
/** `GET /api/agents`. */
export const AgentList = z.object({
  defaultId: z.string(),
  agents: z.array(AgentDoc),
  options: z.object({
    tools: z.array(z.string()),     // the known tool names
    mcp: z.array(z.string()),       // servers of infra/mcp.yaml
    skills: z.array(z.string()),    // folders of skills/
    aliases: z.array(z.object({ id: z.string(), name: z.string() })),
  }),
});

/** Body of `POST /api/automations` and `PUT /api/automations/:id`; the server's schema checks it. */
export const AutomationSave = z.record(z.string(), z.unknown());
export const CronPreview = z.object({ cron: z.string().max(200), timezone: z.string().max(64).default('Europe/Helsinki') });
export type Schedule =
  | { kind: 'daily' | 'weekdays'; hour: number; minute: number }
  | { kind: 'weekly'; day: number; hour: number; minute: number }
  | { kind: 'custom'; cron: string };
export function scheduleToCron(s: Schedule): string;
export function cronToSchedule(cron: string): Schedule;

/** `GET /api/auth/sessions`. */
export const DeviceSession = z.object({
  id: z.string(),
  label: z.string().nullable(),
  createdAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  current: z.boolean(),
});

export const ExportStart = z.object({
  passphrase: z.string().min(12).max(1024),
  unmask: z.boolean().default(false),
});
export const ExportJob = z.object({
  id: z.string(),
  status: z.enum(['building', 'ready', 'failed']),
  masked: z.boolean(),
  done: z.int().min(0),
  total: z.int().min(0),
  error: z.enum(['pseudo_down', 'too_large', 'failed']).nullable(),
  /** Bytes of the encrypted file, when ready. */
  size: z.int().min(0).nullable(),
  fileName: z.string().nullable(),
  createdAt: z.iso.datetime(),
  /** When a ready file is deleted. */
  expiresAt: z.iso.datetime().nullable(),
});
/** PBKDF2 rounds of the export file, and the command that decrypts it (decision 13). */
export const EXPORT_PBKDF2_ITER = 600_000;
export const decryptCommand = (fileName: string) =>
  `openssl enc -d -aes-256-cbc -pbkdf2 -iter ${EXPORT_PBKDF2_ITER} -md sha256 -in ${fileName} -out ${fileName.replace(/\.enc$/, '')}`;
export const AdminError = z.enum(['bad_message', 'not_found', 'exists', 'default_agent', 'in_use',
  'busy', 'gone', 'too_large', 'pseudo_down']);
```

Changes to existing server messages. All new fields are optional, so older fixtures stay valid:

- `automations.state` items get `name`, `timezone`, `prompt`, `autoApprove` and `nextRunAt`.
- `usage.state` gets `agents: { agentId: string | null, calls, tokens, costUsd, estimated }[]` and
  `searches: int`.
- New: `{ type: 'export.state', job: ExportJob.nullable() }`.

### Database (`packages/db/src/schema.ts`, migration 0007)

```ts
// in `authSessions`
// Phase-15 device name from the User-Agent at login, e.g. "Safari · iPhone"; null for older rows.
deviceLabel: text(),
```

## Routes

All routes need the session cookie (`requireUser`).

| Method and path | Body or query | Answer |
| --- | --- | --- |
| `GET /api/agents` | | `AgentList` |
| `POST /api/agents` | `AgentSave`, `?dry=1` | 201 `AgentDoc` (200 when dry); 400, 409 `exists` |
| `PUT /api/agents/:id` | `AgentSave`, `?dry=1` | 200 `AgentDoc`; 400, 404 |
| `DELETE /api/agents/:id` | | 204; 404, 409 `default_agent` or `in_use` |
| `POST /api/automations` | `AutomationSave` | 201 `{ id }`, then `automations.state`; 400, 409 |
| `PUT /api/automations/:id` | `AutomationSave` | 200 `{ id }`, then `automations.state`; 400, 404 |
| `DELETE /api/automations/:id` | | 204, then `automations.state`; 404 |
| `POST /api/automations/preview` | `CronPreview` | `{ runs: string[] }`; 400 |
| `GET /api/auth/sessions` | | `{ sessions: DeviceSession[] }` |
| `DELETE /api/auth/sessions/:id` | | 204; 404 |
| `POST /api/auth/sessions/revoke-all` | | 204 with a new cookie |
| `POST /api/export` | `ExportStart` | 202 `{ job }`; 400, 409 `busy`, 413, 503 |
| `GET /api/export` | | `{ job: ExportJob \| null }` |
| `DELETE /api/export/:id` | | 204; 404 |
| `GET /api/export/:id/download` | | the file; 404, 409 (not ready), 410 `gone` |

## UI

The UI follows `phase-9-ui.md` section 7. All copy is Finnish. The names in brief 7.9 stay unique:
"Agentit" and "Automaatiot" are the screens, and no other element on them gets those names.

### Agentit

- The list: one row per agent with its name, the model in mono and the id in mono. Actions per row
  in a "Toiminnot" menu: "Muokkaa", "Monista", "Poista" ("Poista" is absent for the default agent).
  A button "Uusi agentti" above the list.
- The editor (a page in the settings dialog) has two tabs, "Lomake" and "YAML".
  - Lomake: "Nimi", "Malli" (the aliases first, then the ZDR catalog models of `models.state`),
    "Ohje" (a Markdown text area), "Työkalut" (checkboxes from `options.tools`), "MCP-palvelimet"
    (checkboxes from `options.mcp`), "Hyväksyntä" (per allowed tool: "Kysy aina", "Älä kysy", "Oletus"),
    "Aliagentit" (switch).
  - YAML: a monospace text area with the file text. The prompt stays in "Ohje".
  - Buttons: "Tallenna" and "Peruuta". A field error shows under its field with the text "Tarkista
    kenttä." and focuses the field. A YAML error shows the server's message under the text area.
  - Status toast: "Tallennettu".
- Delete confirmation: title "Poistetaanko agentti ”<nimi>”?", body "Agentin keskustelut siirtyvät
  Avustajalle.", buttons "Poista" and "Peruuta". `in_use` shows "Agentti on käytössä. Odota, että
  keskustelu päättyy, tai poista ensin automaatiot: <ids>."

### Automaatiot

- The list (existing screen) gets the name, the schedule in words ("Arkisin klo 7.30"), "Seuraava:
  ma 27.10. klo 7.30", a switch "Käytössä" per row, and the existing "Aja nyt". A button "Uusi
  automaatio".
- The editor: "Nimi", "Agentti", "Ohje", "Toimitus" (Keskusteluun, Ilmoituksena, Molemmat),
  "Aikataulu" (Päivittäin, Arkisin, Viikoittain, Oma) with "Kellonaika" and, for Viikoittain,
  "Viikonpäivä", or the field "Cron-lauseke" for Oma. Below it "Seuraavat ajot" with the five times
  from the preview route (debounced 300 ms). "Saa ajaa kysymättä" lists the agent's
  `approval.always` tools. Buttons "Tallenna", "Peruuta" and, for an existing automation, "Poista".

### Laitteet

- A new screen in Settings › Hallinta, after "Käyttö", with the icon `MonitorSmartphone`.
- One row per session: the label (or "Tuntematon laite"), "Kirjautunut 25.10.2026", "Viimeksi
  klo 17.20" (or the date), and the badge "Tämä laite" on the current one.
- "Kirjaa ulos" per row. On the current device it signs out after a confirmation.
- "Kirjaa ulos kaikkialta" below the list, with the confirmation "Kirjataanko kaikki muut laitteet
  ulos?" and the body "Tämä laite pysyy kirjautuneena.".

### Vie kaikki tiedot

- Settings gets a section "Tiedot" with the row "Vie kaikki tiedot" and the button "Vie kaikki".
- The dialog "Vie kaikki tiedot":
  - "Nimet": "Niin kuin malli näki ne" (default) or "Oikeat nimet". For the masked choice, the help
    line says "Mukana vain keskustelut. Nimisuoja, muisti ja tiedostot sisältävät oikeita nimiä."
  - "Salasana" and "Salasana uudelleen" (type password, at least 12 characters). The second field
    must match before "Aloita" is active.
  - While the job runs: a progress bar with "<done> / <total>" and "Peruuta".
  - When ready: "Lataa" (the download route), the size, the expiry time, and the decrypt command in
    a code block with a copy button. The help line: "Tiedosto poistuu latauksen jälkeen tai tunnin
    kuluttua."
  - Errors: `pseudo_down` "Nimisuoja ei vastaa. Yritä myöhemmin uudelleen.", `too_large` "Tiedot
    ovat yli 2 Gt. Siivoa työkansiota ja yritä uudelleen.", `failed` "Vienti epäonnistui. Yritä
    uudelleen.".

### Käyttö

- Below the model table, the table "Agenteittain" (agent name, calls, tokens, cost) and the line
  "Verkkohaut: 12" for the month.

## Task cards

| # | Task | Owner | Files | Acceptance |
| --- | --- | --- | --- | --- |
| 1 | Server: agents CRUD, automations CRUD and preview, sessions, export job, usage, protocol, migration | Opus (server architect, done) | new `apps/server/src/admin.ts`, `admin.test.ts`, `export-all.ts`, `export-all.test.ts`, `zip.ts`, `git.ts`; `apps/server/src/agents.ts`, `automations.ts`, `export.ts`, `export.test.ts` (the 413 spy moves to `reader`), `memory.ts`, `usage.ts`, `usage.test.ts`, `main.ts`, `http.ts`, `config.ts`, `pi/registry.ts`, `auth/session.ts`, `auth/routes.ts`, `bridge.ts` (two types); `packages/protocol/src/index.ts` and its test; `packages/db/src/schema.ts`, `packages/db/drizzle/0007_perpetual_sasquatch.sql` and its snapshot | The server, protocol and db tests in "Gate" pass; every earlier test passes |
| 2 | Infra and docs | Opus (done) | `infra/compose.yaml` (`AGENTS_DIR`, `AUTOMATIONS_DIR`), `automations/README.md` (`name`), `docs/decisions/README.md` (index) | The index lists this record |
| 3 | Agentit editor, Automaatiot editor, Laitteet, "Vie kaikki tiedot", Käyttö additions | UI implementer, after 1 | `apps/web/src/components/AgentsScreen.tsx`, `AutomationsScreen.tsx`, `UsageScreen.tsx`, `SettingsDialog.tsx`, new `DevicesScreen.tsx`, new `ExportAllDialog.tsx`, `apps/web/src/store.ts`, `apps/web/src/ws.ts`, `tests/e2e/src/*` | The e2e flows and screenshots in "Gate" pass; UI review at 390, 1024 and 1440 px in light and dark; axe reports no violation |
| 4 | Review | cavecrew-reviewer | the diff of 1 to 3 | Every red and yellow finding fixed |

## Gate

1. `pnpm typecheck`, `pnpm lint` and `pnpm test` pass.
2. Server tests:
   - `admin.test.ts`: "agents: create, update from the form keeps comments, YAML tab, dry run, delete
     rules, reload"; "agents: validation errors name the field"; "automations: create, preview,
     update, disable, delete, run now"; "sessions: list, revoke one, revoke all rotates the current
     token and closes the other sockets".
   - `export-all.test.ts`: "zip: entries round-trip, UTF-8 names, cap" (also `unzip -t` when the
     command exists); "encrypt: openssl decrypts the file" (with the `openssl` command when it
     exists); "export job: open export has chats, vault, memory, work dir and uploads; download
     once" (also busy and the symlink skip); "export job: masked export has only chats; bad
     passphrase, cancel, pseudo down"; "export job: real names need a sidecar (503)".
   - `usage.test.ts`: "usage.state: per agent and search count".
3. Protocol tests: "schedule presets map to cron and back"; "AgentFile accepts an alias and a
   catalog model"; "export state, job and decrypt command".
4. The e2e flows (task card 3): edit an agent's name in the form and see it in the agent picker;
   switch to YAML and back; create an automation with "Arkisin klo 7.30" and see five next runs;
   revoke all on a second browser context and see it signed out; build a masked export and download
   it; screenshots `agents-editor`, `automation-editor`, `devices`, `export-all-ready` at 390, 1024
   and 1440 px, light and dark.

## Risks

1. **No authentication tag.** OpenSSL `enc` with CBC has no MAC (finding 5). Someone who can change
   the file can garble blocks without the passphrase. The zip's CRC-32 per entry then fails, so the
   damage shows on unpack. The threat this export answers is reading, not tampering: the file sits in
   the Downloads folder or a cloud drive.
2. **Passphrase strength.** The file can be attacked offline. 600,000 PBKDF2 rounds slow a guess,
   and the minimum is 12 characters. A weak passphrase is still weak.
3. **Profiles leave the image.** After the first start, `DATA_DIR/agents` is the user's copy. A
   later release that changes `agents/` (for example a prompt paragraph) does not reach it. Such a
   release must say so, and the user merges the change in the editor.
4. **Masked export is partial.** It has only the chats. The dialog says so, and the manifest lists
   the left-out parts.
5. **A running chat keeps the old profile.** A save reaches a running chat only after its turn ends.
6. **Revoke without a fresh login.** A stolen cookie can sign the owner out. The owner signs in again
   and uses "Kirjaa ulos kaikkialta", which rotates the token and ends the thief's session.
7. **Disk.** A ready export uses up to about 2 GiB in `DATA_DIR` for at most one hour.
8. **Symlinks and races.** The agent's `bash` can create symlinks in the work dir. The export skips
   them, opens files with `O_NOFOLLOW` and checks the folder first. A folder swapped between the check
   and the open could still point outside; the result goes only to the user's own file.
9. **Deleted agent.** Its chats move to `assistant` without a per-chat message; an open screen shows
   the old agent until its next `chat.list`.

## Status (2026-10-26)

Task cards 1 and 2 are done (not committed). Task card 3 is open for the UI implementer, then task
card 4.

Gate: `pnpm typecheck` passes. `pnpm --filter @pa/server test` passes 160 tests (10 new), `pnpm
--filter @pa/protocol test` 40 (3 new), `pnpm --filter @pa/db test` 1. Biome passes on the changed
files. The e2e flows wait for task card 3.

Verified on 2026-10-26: a file from the server's `zip` and `opensslEncrypt` decrypts with Homebrew
OpenSSL 4.0.3 (gate test) and with the macOS `/usr/bin/openssl` (LibreSSL 3.3.6, manual run with
the decision-13 flags), and the inner zip passes `unzip -t` and `unzip -p` (UnZip 6.00).
