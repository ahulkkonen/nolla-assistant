# Phase 35: Security fixes

Date: 2026-11-01. Follows phase 33 (`phase-33-recall.md`). Closes four follow-ups of the security
audit (`docs/audits/2026-10-31-security.md`, nice-to-have list) that the phase-32 status and the
threat model list. Changes `apps/server`, `scripts` and one line of `packages/protocol`.

## Goal

Close four small gaps, one commit each:

1. A URL inside an attached file counts as typed by the user, so `fetch_url` skips the card.
2. No `Origin` check on non-GET routes. A page on a sibling subdomain is same-site, so
   `SameSite=Strict` lets its POST through.
3. A session slides for 30 days at each use and has no absolute limit.
4. The full export uses AES-256-CBC with no MAC. A person who can change the file at rest can make
   changes that nobody detects.

## Decisions

1. **Only the typed part of a message counts for `fetch_url`.** `ingestAttachments` appends each
   document as a `\n\n[Liite: <name>]\n` block after the user's text, and the session keeps the
   joined text. The guard now cuts each user message at its first block (`ownText` in
   `apps/server/src/files.ts`, next to the `BLOCK` pattern that `splitBlocks` uses) before it
   looks for the URL. A URL in an attached file therefore gets the card "Osoite ei ole viestissäsi",
   and an unattended chat blocks it. The typed URL path has no card, as before.
   - The cut fails safe. A marker that the user types moves the cut earlier, so a URL after it
     asks. Masking keeps the marker text and the order, so the masked session text cuts at the same
     place.
   - Rejected: a set of typed URLs per turn. It needs state between the bridge and the extension,
     and it must follow steer messages, edits, versions and branch moves. The session already holds
     the text in order.
2. **An `onRequest` hook checks the `Origin` of every request that is not GET, HEAD or OPTIONS**
   (`apps/server/src/http.ts`). A present `Origin` outside `config.wsOrigins` gets 403 with
   `{ error: 'forbidden_origin' }`. A missing `Origin` passes: non-browser clients, the automation
   runner and `curl` in the compose smoke send none. The WebSocket check and the hook share one
   function (`foreign`), so the list of origins is the same, also on the wifi
   (`AUTH_INSECURE_LAN`, phase-22 decision 8).
   - The CSP report route (`POST /api/csp-report`) is exempt. It has no session, it changes
     nothing, and it has its own rate limit.
   - The OAuth callback needs no exemption. Google redirects to it with a GET
     (`0005-mcp-integrations.md`, "Callback format").
3. **A session ends 90 days after its login** (`MAX_AGE` in `apps/server/src/auth/session.ts`).
   The sessions table already has `createdAt`, so no migration. The sliding expiry is capped at
   `createdAt + 90 days` when a session refreshes and at revoke-all. Revoke-all keeps `createdAt`
   (phase-15 decision 12), so a new token does not reset the cap. `getUser` also refuses a row
   whose age passes the cap, for rows whose expiry was set before this phase. A refresh happens
   only when the expiry moves, so a session near its cap does not write on each request. The
   cookie `maxAge` stays 30 days; the server row decides.
4. **The export file is AES-256-GCM with a version byte** (`exportEncrypt` and `exportDecrypt` in
   `apps/server/src/zip.ts`). The layout: `PAEXPORT` (8 bytes), version `2` (1 byte), salt (16
   bytes), nonce (12 bytes), the ciphertext, the tag (16 bytes). The key is PBKDF2-HMAC-SHA256 of
   the passphrase and the salt, 600,000 rounds (`EXPORT_PBKDF2_ITER`). The 37-byte header is the
   additional data, so a changed header also fails the tag. The 2 GiB input cap is far below the
   GCM limit for one nonce (about 64 GiB).
   - `openssl enc` refuses AEAD ciphers, so this changes phase-15 decision 13 ("the stock
     `openssl` decrypts it with one command"). `scripts/decrypt-export.mjs` decrypts in the
     repository with Node and no new dependency. It writes `<zip>.part` (mode 600), checks the tag
     at the end of the stream, and only then renames the file to the zip. A wrong passphrase or a
     changed byte removes the part file and writes nothing. The passphrase comes from stdin only;
     the prompt is shared with `hash-password.mjs` (`scripts/read-secret.mjs`).
   - A version-1 file starts with `Salted__`. The script refuses it with a message that names the
     `openssl` command for it, not a garbage restore. An unknown version byte fails by name.
   - `decryptCommand` in `packages/protocol` now gives `node scripts/decrypt-export.mjs <file>`.
     The export dialog shows it as before.
   - Rejected: an HMAC sidecar next to the CBC file. It keeps `openssl` for the decrypt, but the
     check needs a second tool all the same, and the download becomes two files.

## Left as they are

- The broker API and proxy listen on all interfaces (phase-32 status, item 3). The broker must
  listen on the container's interfaces, and the compose network and `BROKER_TOKEN` are the fence.
- No size limit on the work dir (phase-32 status, item 4). Every `bash` call needs the owner's
  card.
- A non-browser client with a stolen cookie sends no `Origin`, so the hook does not stop it. The
  90-day cap limits how long the cookie works.
- The decrypt needs Node and a checkout of this repository on the machine that opens the file.
- A killed decrypt leaves `<zip>.part` with plain bytes (mode 600) on the owner's machine.

## Status

Done 2026-11-01. Typecheck, lint, the protocol (57), db (4), web (182) and server (263, 1 skipped)
vitest suites and `pnpm test:contract` (28) pass. The Playwright `chromium` project passes (659 of
669, 10 skipped); the fork double-click flow failed once and passed on the rerun. The compose smoke
(project `pa-sec`, port 3100) answered 200 on the root, 403 to a POST with a foreign `Origin` and
401 to the same POST with no `Origin` or the own one.

The e2e global setup rebuilds the web app only when a file in `apps/web/src` is newer than `dist`.
A change in `packages/protocol` alone (here `decryptCommand`) needs `pnpm --filter @pa/web build`
before the flows.
