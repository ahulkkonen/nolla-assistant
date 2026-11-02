# Phase 2 — PWA shell, auth, attachments, deploy

**Status 2026-10-25:** code complete; UI reviewer passed after two rounds; e2e 46 tests green;
Docker image builds. Open user steps: Coolify deploy, iPhone install (`docs/deploy.md`).
Lighthouse no longer has a PWA category (removed in Lighthouse 12); the e2e suite checks the
manifest, icons, service worker registration and `apple-touch-icon` instead.

Gate (plan §13): installs on an iPhone and on desktop Chrome; UI reviewer signs off sidebar,
thread, composer; Lighthouse PWA checks pass.

Gate command: `pnpm typecheck && pnpm lint && pnpm test && pnpm --filter @nolla/e2e test`

## Decisions for this phase

1. **No assistant-ui.** The protocol is custom and the §11 spec is specific (annotations, tool rows,
   approval cards). Plain React 19 components with Tailwind 4 tokens and Radix primitives are less
   code than adapting an external runtime. Plan §11 "Stack" is amended accordingly.
2. **Auth over HTTP, not over the WebSocket.** Cookies need HTTP responses. `auth.login` stays in
   the protocol, unused. The WebSocket upgrade requires the cookie.
3. **Session cookie** `pa_session`: 32 random bytes base64url, stored hashed (sha256) in table
   `authSessions` with `expiresAt`; `HttpOnly; SameSite=Strict; Secure` (Secure off when
   `AUTH_ORIGIN` is http); 30-day rolling expiry, refreshed when < 15 days remain.
4. **Password fallback**: `AUTH_PASSWORD_HASH` env in the form `scrypt$N$r$p$<saltB64>$<hashB64>`
   (N=131072, r=8, p=1). Verification reads the parameters from the string and uses async
   `node:crypto` `scrypt` and `timingSafeEqual`. `scripts/hash-password.mjs` produces it; it reads
   the password from stdin only (prompt with echo off on a terminal).
5. **Passkeys**: `@simplewebauthn/server` 14.0.3 / `@simplewebauthn/browser` 14.0.0. Registration
   requires an authenticated session created less than 10 minutes ago (else 403 `reauth`). Table `passkeys` (`id`, `userId`, `publicKey`,
   `counter`, `transports`, `createdAt`, `lastUsedAt`).
6. **Attachments**: `POST /api/files` (multipart, ≤ 25 MB per file, ≤ 10 files) stores to
   `DATA_DIR/files/<userId>/<fileId>` and inserts `files` (`chatId` nullable until a message uses
   it). On `user.message`: images are resized to ≤ 1.5 MP with `sharp` and passed to Pi as `images`;
   PDF (`unpdf`), DOCX (`mammoth`), TXT/CSV/MD (utf-8) are extracted and appended to the prompt as
   `\n\n[Liite: <name>]\n<text>` blocks (each cut to 60k characters).
7. **Static serving**: `pa-server` serves `apps/web/dist` (`WEB_DIST` env) with SPA fallback for
   non-`/api`, non-`/ws` paths. `sw.js` and `index.html` are `Cache-Control: no-cache`.
8. **Deploy**: `infra/compose.yaml` holds only `pa-server` in this phase; later phases add services.
   Node image tag is pinned to a version ≥ 7 days old. Deploy to Coolify and the iPhone install are
   user-run steps; this phase ends with the image building locally and Lighthouse PWA passing on
   the local server.

## HTTP API (shared contract between tasks 1 and 2)

| Method, path | Auth | Body → response |
|---|---|---|
| `POST /api/auth/password` | no | `{ password }` → 200 `{ userId }` sets cookie; 401 `{ error: 'invalid' }`; rate limit 5/min per IP |
| `GET /api/auth/me` | cookie | 200 `{ userId, passkeys: { id, createdAt, lastUsedAt }[] }`; 401 |
| `POST /api/auth/logout` | cookie | 204, clears cookie |
| `POST /api/auth/passkey/register/options` | cookie, session < 10 min old | → `PublicKeyCredentialCreationOptionsJSON`; 403 `{ error: 'reauth' }` |
| `POST /api/auth/passkey/register/verify` | cookie, session < 10 min old | `{ response }` → 200 `{ ok: true }`; 403 `{ error: 'reauth' }`; 409 duplicate credential |
| `DELETE /api/auth/passkey/:id` | cookie | 204; 404 when not owned |
| `POST /api/auth/passkey/login/options` | no | → `PublicKeyCredentialRequestOptionsJSON`; challenge in a short-lived `pa_challenge` cookie |
| `POST /api/auth/passkey/login/verify` | no | `{ response }` → 200 `{ userId }` sets cookie; 401 |
| `POST /api/files` | cookie | multipart `files[]`, optional `chatId` field → 200 `{ files: AttachmentRef[] }` |
| `GET /api/files/:id` | cookie | file bytes with original mime; 404 when not owned |
| `GET /ws` | cookie | WebSocket; first server frame is `auth.state` |
| `GET /healthz` | no | `{ ok: true }` |

## Task cards

| # | Task | Owner | Files | Acceptance |
|---|---|---|---|---|
| 1 | Server: auth, cookies, passkeys, static, uploads, attachment ingest | Opus | `apps/server/src/auth/`, `apps/server/src/files.ts`, `apps/server/src/http.ts`, `packages/db` (2 tables), `scripts/hash-password.mjs` | tests: password login sets cookie and `/ws` without cookie is 401; upload + `user.message` with an image reaches fake-llm as an image part; a txt attachment text appears in the prompt |
| 2 | Web: PWA shell (login, sidebar, thread, composer, attachments, theme, shortcuts, manifest, SW) | Opus | `apps/web/` | `pnpm --filter @nolla/web build` passes; vitest unit tests for the WS client and the reducer |
| 3 | Infra: `Dockerfile.server`, `compose.yaml`, `.dockerignore` | Sonnet | `infra/` | `docker build -f infra/Dockerfile.server .` succeeds locally and `/healthz` answers in the container |
| 4 | e2e: Playwright harness with fake-llm, flows + screenshots 390/1024/1440 light/dark | Sonnet, after 1–2 | `tests/e2e/` | flows: login, new chat, send, stream, attach image; screenshots stored as baselines |
| 5 | UI review against §11 checklist, using task-4 screenshots | Opus (UI reviewer) | — | sign-off or numbered rejection list |
