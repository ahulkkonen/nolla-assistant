# Phase 11 — Files

## Goal

The user can reach every file that the agent writes and every file that the user uploaded. The
decisions in `phase-11-15-plan.md` section "Phase 11" are fixed. This record adds the decisions
that the plan left open, the data model, the routes, the UI brief, the task cards and the gate.

Constraints:

- One screen, "Tiedostot", with two roots: **Työkansio** (`DATA_DIR/work/<user>`) and **Liitteet**
  (the chat uploads in `DATA_DIR/files/<user>`).
- No in-browser editing. Edits go through the agent.
- Files on disk hold real values. Masking stays where it is today: in the attachment path and in the
  model context.
- No new dependency.

## Research findings

These facts come from reading the code on 2026-10-26.

1. **The path guard had four holes.** `apps/server/src/pi/guard.ts` checked
   `resolve(cwd, path)`, but Pi 1.3.0 resolves a tool path differently (`resolveToCwd` in
   `pi-coding-agent/dist/utils/paths.js`). Pi removes one leading `@`, expands `~` and `~/` to the
   home directory, and decodes `file://` URLs. So `@../app.db`, `~/models.json` and
   `file:///data/app.db` passed the guard and reached files outside the work dir. In a subagent
   child, `HOME` is the Pi agent dir, which holds `models.json` with the LiteLLM master key. Also,
   the guard did not follow symlinks, and `bash` (phase 5) can create symlinks in the work dir.
   Pi does not export `resolveToCwd`, so the new guard copies its rules (decision 4).
2. **The subagent child has its own guard** (`packages/pi-ext-subagents/src/child.ts`) with the same
   lexical check. A child cannot import the server app.
3. **Backups did not cover the work dir.** `infra/backup/backup-now.sh` ran restic with
   `--exclude /data/work`. The plan said that backups cover both roots. That was not true
   (decision 13).
4. **Uploads are flat.** `/api/files` stores each upload as `files/<user>/<uuid>` with a `files`
   row (name, mime, size, chat). The disk names are ids, so the Liitteet tree must come from the
   database. `history()` in `bridge.ts` puts a file on the user message whose time window holds the
   file's `createdAt`.
5. **Artifacts have no stored row.** `extractArtifacts(messageId, text)` derives them from the
   assistant text. The id is `sha1("<messageId>:<index>")`, so the server can find an artifact by id
   in the masked session text without unmasking every message.
6. **Pi tool events.** `tool_call` can block a call and sees the restored (real) input after
   `pi-ext-pseudo`. `tool_result` gives `toolCallId`, `input` and `isError`, and
   `ctx.sessionManager` holds the assistant entry with the tool call, because Pi appends the
   assistant message before it runs the tools.
7. **The sandbox runner mounts the work dir at `/work`.** Docker can mount a tmpfs on a folder
   inside that bind mount.
8. **The global `onSend` hook set `X-Frame-Options: DENY` on every response,** so no route could be
   framed, not even by the app itself.

## Decisions

1. **Two roots.** Työkansio is the work dir on disk. The agent reads and writes it, and the user
   reads and writes it through the routes. Liitteet is the list of `files` rows, newest first,
   without folders. Liitteet is read-only: no delete, rename or move. Deleting a chat deletes its
   uploads, as today.
2. **Routes.** REST under `/api/files/tree`, with the same `requireUser` pre-handler as
   `/api/files/:id`. Bodies and queries are zod schemas from `@pa/protocol`. Errors are
   `{ error: FileError }`. The table in "Routes" lists them.
3. **Listing and pagination.** A listing shows folders first, then names in
   `Intl.Collator('fi', { numeric: true, sensitivity: 'base' })` order, with a code-point
   tie-break so the order is total. The page size is 200 by default and 500 at most. The cursor is
   `d:<name>` or `f:<name>` of the last entry, and the next page starts after it, so a deletion
   between pages does not skip entries. The server reads all names of the folder, but it calls
   `stat` only for the entries of the page. `.trash` is never listed. Liitteet uses a keyset cursor
   `<createdAt>|<id>`.
4. **Path safety.** One module, `packages/pi-ext-subagents/src/workspace.ts`, holds the rules. The
   server guard, the subagent child guard and the file routes use it.
   - A tool path is resolved the way Pi resolves it (`piPath`): Unicode spaces, one `@`, `~`,
     `~/`, `file://`. For `read`, the guard also checks the four other names that Pi tries when the
     path does not exist (AM/PM narrow space, NFD, curly apostrophe).
   - `realInside` accepts a path only when it stays in the root lexically and also after
     `realpath` of its longest existing part. Missing trailing parts are allowed, because a write
     creates them. A dangling symlink is refused, because a write would follow it.
   - The first path segment must not be `.trash`, compared in lowercase. A symlink into the trash
     is refused too.
   - The guard covers `read`, `write`, `edit`, `ls`, `find` and `grep`. The agent profiles allow
     only the first three today. `ls`, `find` and `grep` without a path, or on the root (also
     through `.` or a link to it), are blocked, because the root holds `.trash` and `find` and
     `grep` search below it.
   - Route paths are plain relative paths. `..`, an absolute path, NUL, `.trash` and every symlink
     that leads out are refused with 400 `bad_path`. A double-encoded `..` is a literal folder name
     inside the root.
   - Routes act on the resolved path, never on the input. A route that reads a file (`raw`,
     `attach`) opens it with `O_NOFOLLOW | O_NONBLOCK`, checks it with `fstat`, and streams from
     that file handle. On Linux it also checks the path of the open file in `/proc/self/fd`, so a
     folder swapped for a symlink after the check is refused.
   - Delete and move resolve only the parent folder (`entryPath`) and act on the entry itself. A
     symlink that leads out or nowhere can still be deleted or moved from the screen; its target
     does not change.
   - No new root-level entry can be named `.trash` in any case: upload, "Tallenna tiedostoksi" and
     restore rename it to `_.trash`; mkdir and move refuse it.
   - The listing hides every symlink that leads out of the root or into the trash.
5. **Trash.** Delete moves the entry to `<work>/.trash/<epoch ms>-<name>`. A `fileTrash` row keeps
   the original path. "Palauta" moves the entry back to that path. When the folder is gone,
   restore creates it again. When the path cannot be used, restore puts the entry into the root.
   When the name is taken, restore adds " (2)" and up. "Poista pysyvästi" deletes one entry, and
   "Tyhjennä roskakori" deletes all. A daily job, at start and every 24 hours, deletes entries
   older than 30 days by the time in the entry name. The job also deletes rows whose entry is gone.
   The trash counts toward the quota until it is emptied. Every trash route and the job first check
   that `.trash` is a real folder (`lstat`). A file or a symlink there gives 409 `bad_path`, and the
   job touches nothing. A read error other than "missing" makes the job fail; it never drops rows on
   an empty list that came from an error. Moves into and out of the trash, and every move of a file,
   use `link` and `unlink`, so an existing target is never replaced. Folders and symlinks use a
   check and `rename` (Node has no `RENAME_NOREPLACE`).
6. **Origins.** A `fileOrigins` row records the chat and the assistant message (`Message.id`) that
   last wrote a work-dir file. The server guard records it on each successful `write` or `edit`
   (`tool_result`). The path is the entry as the routes list it: the parent folder resolved, the
   last part kept, so a write through a symlink records the link. "Tallenna tiedostoksi" records it
   too. A move or a trash and restore moves the rows of the entry and of everything under it.
   Permanent deletion drops them. The foreign key to `chats` cascades, so a deleted chat leaves no
   origin. A Liitteet entry has the upload's chat as its origin. Files that `bash` writes and files
   that the user uploads have no origin. The brief named the table `files_origin`. It is
   `fileOrigins`, because every other table name is camelCase.
7. **Quota accounting.** The quota is 10 GB per user for both roots together: the work dir with
   its trash, plus the sum of `files.size`. The server caches the work-dir size per user. The cache
   is cleared after each write, upload, permanent delete and purge, and it expires after 60 seconds,
   because `bash` writes through the broker past every hook. A miss walks the work dir with `lstat`
   and does not follow symlinks. The upload sum comes from SQL. An upload counts its bytes in flight
   per user while it streams. Each chunk checks the cached size, the upload sum and all bytes in
   flight, and stops the stream past the quota, with no `await` between the check and the count.
   So two parallel uploads cannot both take the rest, and an agent write sees the bytes in flight.
   The upload limit of chat attachments
   stays 25 MB per file (the model reads them). The old 2 GiB upload quota is replaced by the
   shared 10 GB.
8. **Limits on the agent.** The guard checks `write` and `edit` before they run. For `write`, the
   new size is the content size. For `edit`, it is the old size plus the growth of each
   `newText` over its `oldText`. More than 200 MB per file, or a total over 10 GB after the old
   size is subtracted, blocks the call with a Finnish error for the model:
   - "Kirjoitus estetty: tiedostosta tulisi 250 Mt, mutta yhden tiedoston raja on 200 Mt. Jaa
     sisältö pienempiin tiedostoihin."
   - "Kirjoitus estetty: tallennustila on täynnä (käytössä 9,9 Gt / 10 Gt). Pyydä käyttäjää
     vapauttamaan tilaa Tiedostot-näkymässä, esimerkiksi tyhjentämällä roskakori."
   The tool row shows status `error` with that text. A subagent child checks the same limits, but it
   counts only the work dir, because it has no database. `bash` is not blocked; its writes count at
   the next walk.
9. **Preview types and caps.** The server sets `preview` on each entry from the extension (work dir)
   or the mime (Liitteet), and sets it to null over the cap. The caps are in
   `PREVIEW_MAX` in `@pa/protocol`.

   | Kind | Extensions | Cap | How the screen shows it |
   | --- | --- | --- | --- |
   | `text` | txt, log, csv, tsv | 1 MB | `<pre>`, wrap off, mono |
   | `markdown` | md, markdown | 1 MB | the thread's Markdown renderer |
   | `code` | json and 32 code extensions (js, ts, py, sh, sql, yaml, …) | 1 MB | the thread's code block with highlighting |
   | `html` | html, htm | 2 MB | the artifact sandbox: `srcdoc` iframe, `sandbox="allow-scripts"`, the artifact CSP meta |
   | `image` | png, jpg, jpeg, webp, gif, svg | 20 MB | `<img>` |
   | `pdf` | pdf | 50 MB | an iframe on the raw URL (decision 10) |

   Every other type, and every file over its cap, is download only. docx is download only.
10. **Serving.** `GET /api/files/tree/raw` streams the file with
    `Content-Disposition: inline` or `attachment` and `filename*=UTF-8''…`, and
    `Cache-Control: private, no-cache`. Text, Markdown, code and HTML go as
    `text/plain; charset=utf-8`; the client renders them. The route never sends `text/html`.
    Images and PDF keep their mime. `download=1` and every type without a preview go as
    `application/octet-stream` attachments. Every response gets
    `Content-Security-Policy: sandbox; default-src 'none'` and `X-Frame-Options: DENY`, except an
    inline PDF. An inline PDF gets `frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN`,
    because a browser PDF viewer does not run in a CSP sandbox. The global hook now keeps an
    `X-Frame-Options` value that a route set.
11. **Attach from the work dir.** `POST /api/files/tree/attach` copies the file into the uploads
    (`files/<user>/<uuid>` and a `files` row) and returns an `AttachmentRef`. The composer then sends
    it in `user.message.attachments` like an upload, so `ingestAttachments` and the existing
    masking path handle it. The copy is a snapshot: a later edit of the work file does not change
    the message. Types: the upload mimes (png, jpeg, webp, gif, pdf, docx, txt, csv, md), and any
    other text kind (code, HTML) as `text/plain`. The first 8 KB must pass the same sniff as an
    upload. The size limit is the attachment limit of 25 MB, checked before the quota and counted
    again while the copy runs (`bash` can grow the file); a copy past it is removed. A failed copy
    leaves no partial file. The copy counts toward the quota. The
    client sends no `chatId` from the composer picker or the file row: the message binds the copy,
    so an attachment that the user removes before sending does not show on a later message.
12. **"Tallenna tiedostoksi".** `POST /api/files/tree/artifact { chatId, artifactId, dir }` finds
    the newest assistant message of the chat's branch with that artifact id, in the masked text.
    The server unmasks only that message and extracts the artifact again, so the file holds real
    values. The name is `<title>.<ext>`: `html`, `jsx` or `tsx`, `mmd` for Mermaid, and the code
    language or `txt`. A taken name gets " (2)". The origin is the chat and that message. When
    the sidecar is down, the route answers 503 `pseudo_down` and writes nothing.
13. **Backups.** restic now includes the work dirs and excludes `/data/work/*/.trash`. The work dir
    holds user files since this phase. `scripts/restore.sh` restores it with the rest of the
    snapshot. After a restore, the purge job drops `fileTrash` rows that have no entry.
14. **`bash` cannot see the trash.** The broker mounts an empty read-only tmpfs on `/work/.trash`
    in each runner. The broker creates and chowns `.trash` first, so Docker does not create the
    folder as root.
15. **Names.** Upload names and new names are NFC, lose control and format characters (bidi
    overrides), `/` and `\`, are trimmed, and are at most 200 UTF-8 bytes. `.` and `..` are refused. An upload with a taken name gets
    " (2)" and up. A new folder or a move onto a taken name answers 409 `exists`. Move and rename are
    one route: `to` is the full new path.
16. **Masking (plan decision 7, unchanged).** Files on disk, previews and downloads show real values.
    The agent's tool arguments are unmasked before the tools run. A work file attached to a message
    goes through `ingestAttachments` and the input hook masks it. A saved artifact is unmasked
    before the write.

## Data model

### Protocol (`packages/protocol/src/index.ts`)

```ts
export const FileRoot = z.enum(['work', 'files']);
export const TreePath = z.string().max(4096).refine((p) => !p.includes('\0'), 'NUL in path');
export const PreviewKind = z.enum(['text', 'markdown', 'code', 'image', 'pdf', 'html']);
export const PREVIEW_MAX: Record<PreviewKind, number> = {
  text: 1024 ** 2, markdown: 1024 ** 2, code: 1024 ** 2,
  html: 2 * 1024 ** 2, image: 20 * 1024 ** 2, pdf: 50 * 1024 ** 2,
};

export const TreeEntry = z.object({
  name: z.string(),
  path: z.string(), // relative to the root, '/'-separated; in `files` the upload id
  type: z.enum(['dir', 'file']),
  size: z.int().min(0), // 0 for a folder
  mime: z.string(), // 'inode/directory' for a folder
  modifiedAt: z.iso.datetime(),
  preview: PreviewKind.nullable(),
  origin: z
    .object({ chatId: id64, messageId: id64.nullable(), chatTitle: z.string().nullable() })
    .nullable(),
});

export const TreeQuery = z.object({
  root: FileRoot.default('work'),
  path: TreePath.default(''),
  cursor: z.string().max(4096).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export const TreeListing = z.object({
  root: FileRoot, path: z.string(), entries: z.array(TreeEntry), nextCursor: z.string().nullable(),
});
export const TreeRawQuery = z.object({
  root: FileRoot.default('work'), path: TreePath, download: z.enum(['0', '1']).default('0'),
});

export const TrashEntry = z.object({
  id: z.string(), // `<epoch ms>-<name>`
  name: z.string(),
  originalPath: z.string(),
  type: z.enum(['dir', 'file']),
  size: z.int().min(0),
  deletedAt: z.iso.datetime(),
});
export const TrashListing = z.object({ entries: z.array(TrashEntry), nextCursor: z.string().nullable() });

export const FileUsage = z.object({
  used: z.int().min(0), // work + trash + files
  quota: z.int().min(0),
  work: z.int().min(0),
  trash: z.int().min(0),
  files: z.int().min(0),
  maxFileSize: z.int().min(0), // 200 MB
  maxAttachSize: z.int().min(0), // 25 MB
});

export const TreeMkdir = z.object({ path: TreePath });
export const TreeMove = z.object({ from: TreePath, to: TreePath });
export const TreeRestore = z.object({ id: z.string().min(1).max(512) });
export const TreeAttach = z.object({ path: TreePath, chatId: id64.optional() });
export const TreeSaveArtifact = z.object({
  chatId: id64, artifactId: z.string().min(1).max(64), dir: TreePath.default(''),
});

export const FileError = z.enum([
  'bad_message', 'bad_path', 'bad_name', 'not_found', 'exists', 'empty',
  'too_large', 'quota', 'unsupported', 'pseudo_down',
]);
```

No WebSocket message changes. The screen uses HTTP only.

### Database (`packages/db/src/schema.ts`, drizzle migration 0005)

```ts
export const fileOrigins = sqliteTable(
  'fileOrigins',
  {
    userId: text().notNull(),
    path: text().notNull(), // relative to the work dir; `.trash/<entry>/…` while in the trash
    chatId: chatRef(), // cascades on chat delete
    messageId: text(), // assistant entry id; null when not found
    updatedAt: text().notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.path] })],
);

export const fileTrash = sqliteTable(
  'fileTrash',
  {
    userId: text().notNull(),
    id: text().notNull(), // entry name in `.trash`
    originalPath: text().notNull(),
    deletedAt: text().notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.id] })],
);
```

`drizzle-kit generate` wrote `packages/db/drizzle/0005_fluffy_warpath.sql` (two `CREATE TABLE`
statements). Path prefix updates use SQL `length()` and `substr()`, because SQLite counts
characters and JavaScript counts UTF-16 units.

## Routes

All routes need the session cookie (401 without it). "Work" means the route acts on Työkansio only.

| Method and path | Input | Answer | Errors |
| --- | --- | --- | --- |
| `GET /api/files/tree` | `TreeQuery` | `TreeListing` | 400 `bad_path`, 404 `not_found` |
| `GET /api/files/tree/raw` | `TreeRawQuery` | the file stream (decision 10) | 400, 404 |
| `POST /api/files/tree/upload?path=` | multipart `files` (work, at most 10, 200 MB each) | 201 `{ entries: TreeEntry[] }` | 400 `empty`, 413 `too_large` or `quota` |
| `POST /api/files/tree/mkdir` | `TreeMkdir` (work) | 201 `{ entry }` | 400 `bad_name`, 404, 409 `exists` |
| `POST /api/files/tree/move` | `TreeMove` (work; rename and move) | `{ entry }` | 400 (also a folder into itself), 404, 409 |
| `DELETE /api/files/tree?path=` | (work) | `{ entry: TrashEntry }` | 400 (also the root), 404 |
| `GET /api/files/tree/trash` | `cursor`, `limit` | `TrashListing`, newest first | — |
| `POST /api/files/tree/restore` | `TreeRestore` | `{ entry: TreeEntry }` | 400, 404 |
| `DELETE /api/files/tree/trash[?id=]` | one entry or all | 204 | 400, 404 |
| `GET /api/files/tree/usage` | — | `FileUsage` | — |
| `POST /api/files/tree/attach` | `TreeAttach` | `{ file: AttachmentRef }` | 404, 413 `too_large` or `quota`, 415 `unsupported` |
| `POST /api/files/tree/artifact` | `TreeSaveArtifact` | 201 `{ entry }` | 404, 413, 503 `pseudo_down` |

## UI

One screen, "Tiedostot", built to the design brief (phase-9-ui.md section 7). All labels are Finnish
and unique on the screen. The names in brief 7.9 keep their single owner. The screen adds no element
named "Lisää", "Toiminnot", "Hyväksy", "Hylkää" or "Valikko".

**Entry points.** A rail and sidebar item "Tiedostot" (`FolderOpen` 20), a palette command
"Avaa tiedostot" in the group "Komennot", and a row "Tiedostot" in Settings › Hallinta after
"Automaatiot". The store gets `screen: 'files'` with `FILES_TITLE = 'Tiedostot'`.

**Layout.** `--page-max`, page title "Tiedostot" (h1) and the usage meter at the right of the header.
Under the title, a segmented control (as Teema in Settings) switches "Työkansio", "Liitteet" and
"Roskakori". Below it, the breadcrumb, then the toolbar, then the table.

- **Breadcrumb** (Työkansio only): `nav` with `aria-label` "Kansiopolku", segments as `link`
  buttons, the last segment as plain text with `aria-current="page"`. Long paths collapse the
  middle into "…".
- **Toolbar** (Työkansio only): `outline` "Lataa tiedostoja" (`Upload`), `ghost` "Uusi kansio"
  (`FolderPlus`). A drop on the table area shows the overlay "Pudota tiedostot tähän" as in the
  composer.
- **Table** (brief 7.5 Tables). Columns: Nimi (icon 16 by type + name, a folder name is a button
  that opens it), Koko (right, tabular, "12,4 Mt", empty for folders), Muokattu ("25.10.2026 klo
  17.20"), Lähde (a `link` with the chat title, or "Keskustelu" when the title is null, to the chat
  and message; empty when there is no origin). Row hover `--accent` 50 %. At most two 28 px icon
  actions on hover or focus: "Esikatsele" (`Eye`, only with a preview) and "Lataa"
  (`Download`). The ⋯ `DropdownMenu` ("Tiedoston toiminnot") holds "Liitä keskusteluun",
  "Nimeä uudelleen", "Siirrä", "Poista". Liitteet rows have only "Esikatsele", "Lataa" and
  "Avaa keskustelu". Under 768 px each row is a card: name 500, meta line "12,4 Mt · 25.10.2026",
  ⋯ at the right.
- **Pagination.** At the end of the table an `outline` "Näytä lisää" loads `nextCursor`. No
  virtualization.
- **Preview.** At ≥ 1024 px a right pane like the artifact panel (header 48: name, "Lataa",
  "Sulje esikatselu"); below 1024 px a full-screen `Sheet`. Content per decision 9. Every preview
  shows real values. The PDF iframe has `title` set. If the browser shows no PDF viewer in the
  frame, the pane shows "Esikatselu ei onnistunut." and "Lataa".
- **Upload with progress.** `XMLHttpRequest` with `upload.onprogress`. A row per file above the
  table with name, a 2 px progress bar and "Peruuta lataus". Errors per file: `too_large` "Tiedosto
  on yli 200 Mt.", `quota` "Tallennustila on täynnä. Tyhjennä roskakori tai poista tiedostoja.".
- **Usage meter.** "3,2 Gt / 10 Gt" in meta, a 120 × 4 bar, `--warning` at ≥ 90 %,
  `--destructive` at 100 %. Its tooltip (desktop) splits Työkansio, Roskakori and Liitteet.
- **Rename and new folder.** A small `Dialog` with one `Input` ("Nimi") and `default` "Tallenna".
  409 shows "Nimi on jo käytössä." under the input.
- **Move.** A `Dialog` "Siirrä kohteeseen" with a folder list (the same listing route, folders
  only), a breadcrumb, and `default` "Siirrä tähän".
- **Delete.** No confirm: the entry goes to the trash and a toast "Siirretty roskakoriin" with the
  action "Kumoa" (restore) appears.
- **Trash view.** Columns Nimi, Alkuperäinen sijainti, Poistettu, Koko. Row actions "Palauta"
  (`RotateCcw`) and "Poista pysyvästi" (`Trash2`, opens an `AlertDialog` "Poistetaanko ”nimi”
  pysyvästi?"). A header `outline` "Tyhjennä roskakori" with the `AlertDialog` "Tyhjennetäänkö
  roskakori?". A meta line "Roskakorin tiedostot poistetaan 30 päivän kuluttua.".
- **Empty states** (brief 7.5): Työkansio "Kansio on tyhjä" + "Tiedostot, jotka avustaja kirjoittaa,
  näkyvät täällä."; Liitteet "Ei liitteitä"; Roskakori "Roskakori on tyhjä".
- **"Liitä keskusteluun"** (file row) attaches through `/api/files/tree/attach` without `chatId`,
  adds the chip to the composer of the active chat (a new chat when none is open) and opens the chat.
  The composer "Liitä" button becomes a `DropdownMenu`: "Lataa laitteelta" (today's file picker) and
  "Valitse työkansiosta" (a `Dialog` with the tree, files only selectable, `default` "Liitä").
  `unsupported` shows "Tätä tiedostotyyppiä ei voi liittää.", `too_large` "Liite on yli 25 Mt.".
- **Artifact panel.** A new icon button "Tallenna tiedostoksi" (`Save`) next to "Lataa". Success
  toast "Tallennettu Työkansioon" with the action "Näytä" (opens Tiedostot at the file).
  `pseudo_down` shows "Nimisuoja ei vastaa. Yritä uudelleen.".

## Task cards

| # | Task | Owner | Files | Acceptance |
| --- | --- | --- | --- | --- |
| 1 | Server: routes, guard, origins, trash and purge, quota, attach, save artifact, protocol, DB, broker, backups | Opus (architect, done) | `apps/server/src/tree.ts` and `tree.test.ts` (new), `apps/server/src/files.ts`, `http.ts`, `main.ts`, `pi/guard.ts`, `pi/registry.ts`, `packages/pi-ext-subagents/src/workspace.ts` and `workspace.test.ts` (new), `child.ts`, `package.json`, `packages/protocol/src/index.ts` and its test, `packages/db/src/schema.ts`, its test, `drizzle/0005_*`, `services/sandbox-broker/src/index.ts`, `tests/sandbox/src/sandbox.test.ts`, `infra/backup/backup-now.sh`, `scripts/restore.sh`, `docs/deploy.md`, `docs/decisions/README.md` | The tests in "Gate" item 2 pass; every existing test passes |
| 2 | Web: the Tiedostot screen, preview pane, trash view, upload with progress, usage meter, composer picker, "Liitä keskusteluun", "Tallenna tiedostoksi" | UI implementer, after 1 | a new `apps/web/src/components/FilesScreen.tsx` (and a `FilePreview.tsx` if it grows), `App.tsx`, `Sidebar.tsx`, `CommandPalette.tsx`, `SettingsDialog.tsx`, `Composer.tsx`, `ArtifactPanel.tsx`, `store.ts`, `api.ts`, `tests/e2e` (fake server routes and screenshots) | The UI review passes at 390, 1024 and 1440 px in light and dark. Screenshots: tree, folder, preview of each kind, trash, upload progress, quota error, composer picker, move dialog. axe reports no violation. The e2e flow in "Gate" item 3 passes |
| 3 | Review | cavecrew-reviewer on each commit; the scored UI review on the new screen | the diffs of 1 and 2 | Every blocking and should-fix item is fixed or answered in one line |

The HTML preview reuses the artifact sandbox code. The UI implementer moves `docFor`, the CSP meta
and the iframe from `ArtifactPanel.tsx` into a shared component and does not copy them.

## Gate

1. `pnpm typecheck && pnpm lint && pnpm test` passes.
2. Server tests (vitest), all passing:
   - `apps/server/src/tree.test.ts`: auth on every route; list, mkdir, upload, move with natural
     order, pages and conflicts; raw preview types and headers; path safety (`..`, `%2e%2e%2f`,
     `..%2F`, absolute, `.trash`, `.TRASH`, symlinks out, a symlink into the trash, a dangling
     symlink, double encoding); trash with restore into a removed folder, delete for good and the
     30-day purge; quota on upload, attach, chat upload and the agent `write`; origin through
     move, folder move, trash and restore; the guard on `.trash`, a symlink out and `@../`; attach
     through `ingestAttachments` as a snapshot, with the Liitteet listing and its cursor; "Tallenna
     tiedostoksi" with real values, the origin, " (2)" and `pseudo_down`; a FIFO, a link inside, and
     delete of links that lead out or nowhere; a 30 MB upload past the 25 MB plugin default and a
     root `.trash` name; the quota stopping one request mid-way and letting exactly one of two
     parallel uploads through; a symlink or a file in place of `.trash` and a purge on an
     unreadable trash; the guard after `pi-ext-pseudo` (path, size check and origin with real
     values).
   - `packages/pi-ext-subagents/src/workspace.test.ts`: `piPath`, `realInside`, `checkFileTool`
     (escapes, trash, size limits for `write` and `edit`, `ls`/`find`/`grep` on the root),
     `entryPath`, `dirBytes`.
   - `tests/sandbox` (Docker): `bash` cannot see or write `/work/.trash`.
3. E2e (task 2): upload two files with progress, open a folder, preview a Markdown file, rename,
   delete and restore from the trash, attach a work file from the composer picker and send it,
   save an artifact and find it in Tiedostot.

## Risks

1. **PDF in a frame.** Browsers differ on PDF viewers in frames. The inline PDF response has no CSP
   sandbox (decision 10), and the client iframe needs `sandbox="allow-scripts allow-same-origin"`
   at most. The UI implementer checks Chrome, Safari (iOS too) and Firefox, and falls back to
   "Lataa" when no viewer shows.
2. **Symlink races.** The checks run before the tool or route acts. Reads are closed on Linux
   (`O_NOFOLLOW` and the `/proc/self/fd` check). Writes create with `O_EXCL`, which never follows
   a final symlink, but `bash` can still swap a parent folder for a symlink between the check and a
   write, and Pi's own tools have the same window. The sandbox has no network unless a skill asks
   for it. A complete fix needs `openat2` with `RESOLVE_BENEATH`, which Node does not expose.
3. **Walk cost.** Each miss of the size cache walks the whole work dir. With tens of thousands of
   files, a write by the agent waits for the walk. A running total per write is the upgrade.
4. **`bash` and the quota.** `bash` writes are not blocked; they count at the next walk (at most 60
   seconds later). A skill can pass the quota by one command's output.
5. **Children count less.** A subagent child counts only the work dir. With large uploads, a child
   can pass the total quota by at most the upload total.
6. **Backup size.** The work dirs are now in restic. At the 10 GB quota, the bucket can grow by up
   to 10 GB per user plus the retained snapshots.
7. **Orphan copies.** An attached copy that is never sent stays in Liitteet without a chat, as an
   upload that is never sent does today. It counts toward the quota. A cleanup of unbound uploads
   older than a day is the fix if it matters.
8. **Upload body size.** One upload request can be 2 GB (10 × 200 MB). A proxy in front of
   pa-server (Coolify's Traefik) must allow that body size. The web client sends one request per
   file to keep each request at 200 MB.

## Status (2026-10-26)

Task card 1 is committed as `9055c37`. The review found no blocking item and 13 should-fix items;
all 13 are fixed (not committed yet). Server 104 tests, subagents 12, protocol 17, db 1, sandbox
(Docker) 17 pass. The per-request multipart `limits.fileSize` replaces the plugin's 25 MB default:
a 30 MB work upload succeeds. Task cards 2 and 3 are open.
