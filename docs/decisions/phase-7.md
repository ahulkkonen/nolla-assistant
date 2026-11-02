# Phase 7 — Artifacts, voice input, Web Push, command palette, polish

Gate (plan §13): UI reviewer passes all screens at all breakpoints; push arrives on a locked
iPhone (user step); a recorded Finnish sentence transcribes correctly (user step with a real key;
the automated test proves the pipeline with a fake transcription endpoint).

## Decisions

1. **STT** (plan §12, 0004 §7): browser `MediaRecorder` (`audio/webm;codecs=opus`, fallback
   `audio/mp4`), hold-to-record, chunks ≤ 55 s and ≤ 25 MB; `POST /api/transcribe` (multipart, cookie
   auth) in `pa-server` forwards to `LITELLM_URL/v1/audio/transcriptions` with `model: zdr/stt`,
   `language: fi` (or the user's setting), `response_format: json`; the audio buffer is never written
   to disk; the transcript lands in the composer. Setting "lähetä heti" auto-sends. Self-hosted Whisper
   stays deferred.
2. **Web Push** (plan §5): `web-push` 3.6.7, VAPID keys from env; subscriptions in
   `pushSubscriptions`; `POST /api/push/subscribe` and `DELETE /api/push/subscribe` (HTTP, cookie
   auth; the WS `push.subscribe` message is kept for compatibility but the client uses HTTP). Triggers:
   `agent_settled` and `approval.request` when no socket has that chat focused (the client reports
   focus with a `chat.focus { chatId | null }` message, additive). Payload: `{ title, chatId, kind }`
   with the chat title only. The service worker shows the notification and focuses or opens the chat
   on click. Push-service hosts allowlisted to the Apple, Google and Mozilla endpoints.
3. **Artifacts** (plan §11): `artifact.upsert` is emitted by the bridge when an assistant message
   contains a fenced block tagged `html`, `jsx`/`tsx` (React single file), `mermaid`, or a code block
   longer than 30 lines; artifacts live in memory per chat and in `chat.state` (derived on open).
   Right panel with tabs; HTML in a sandboxed `iframe` (`sandbox="allow-scripts"`, `srcdoc`, CSP via
   meta `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:`),
   React via a bundled `esm.sh`-free approach: the panel ships React UMD from the app's own assets and
   transpiles the JSX with `sucrase` (pin ≥ 7 days) in a worker; Mermaid rendered with `mermaid` (pin)
   lazily; code with a read-only `<pre>` and copy (Monaco is skipped: 2 MB for read-only display is
   not justified). Actions: copy, download, open in new tab (blob URL), close.
4. **Command palette**: `cmdk` 1.1.1; `Cmd/Ctrl+K`; commands: new chat, search, switch agent, open
   vault, memory, topics, settings, toggle theme; plus chats and topics by fuzzy title.
5. **Polish list**: message edit (user) and retry (assistant) actions; thread virtualization above
   200 messages (`@tanstack/react-virtual`, pin); `tool.update` live output; per-message "what the
   model saw"; delete chat (protocol `chat.delete`, cascades); `chats.titleLocked` on the wire; image
   size reduction for `pa-server` (prune dev deps, drop the web build toolchain from runtime; target
   < 700 MB); `/mask` latency: precompute surrogate pool forms at image build; egress allowlist proxy
   for skills (`network: [hosts]`) with a tiny HTTP CONNECT proxy in the broker network.
6. **iOS checks** (plan §15): mic permission in standalone PWA, keyboard and safe areas, push after
   Home Screen install: user-run checklist in `docs/deploy.md`.

## Task cards

| # | Task | Owner | Files | Acceptance |
|---|---|---|---|---|
| 1 | Server: `/api/transcribe`, push routes + triggers, `chat.focus`, `artifact.upsert`, `chat.delete`, `titleLocked` on the wire | Opus | `apps/server`, `packages/protocol`, `packages/db` | tests with a fake transcription endpoint and a fake push service |
| 2 | Web: mic button + recording states, artifact panel, command palette, edit/retry, virtualization, delete, push opt-in in settings, SW notification click | Opus + UI review | `apps/web`, `tests/e2e` | UI review pass on every screen at 390/1024/1440 light and dark |
| 3 | Infra: image shrink, surrogate pool precompute, egress proxy for skill allowlists | Sonnet | `infra/`, `services/` | image < 700 MB; `/mask` p95 < 150 ms on a new-people message in Docker; allowlist test in `tests/sandbox` |

## Status (2026-10-25)

Tasks 1, 2 and 3 are done. Commits: `31ccf7b` (server), `a222eb4` (web), `4f591c8` (image).

Deviations from the task cards:

- Image size is 1.09 GB, not < 700 MB. The floor is about 800 MB with git, the SDKs and the
  local embedding model in the image. Accepted.
- `/mask` p95 stays near 150 ms on a message with 25 new people (M4 Pro). Accepted.
- React 19 has no UMD build. The artifact runtime is bundled by Vite (`src/artifact-runtime.ts`)
  and inlined into the sandboxed `srcdoc`. Nothing loads from another origin.
- "Open in new tab" opens a script-free wrapper page around the sandboxed iframe. A blob URL
  would run the artifact with the app origin.
- The voice e2e test mocks the microphone with an oscillator stream. Chromium's fake media
  device does not resolve `getUserMedia` in the macOS headless shell.
- Edit on a user message sends a new message ("Lähetä muokattuna"). A true edit-and-fork needs
  server support and is not in scope.

Later changes: phase 13 added fork into a new chat ([phase-13-thread.md](phase-13-thread.md)),
phase 24 added edit in place ([phase-24-edit-in-place.md](phase-24-edit-in-place.md)), and phase 15
added the agent editor, so the agents screen is no longer read-only ([phase-15-admin.md](phase-15-admin.md)).

Known flake: `screens.spec.ts › subagents-row` fails about once per full run when the fake LLM
gets one call more than scripted under load. It passes 12 of 12 runs in isolation.

Not covered by tests: the virtualized thread above 200 messages, the React and Mermaid
artifact kinds (HTML is tested end to end).

Gate checks run on 2026-10-25 after the review rounds: `pnpm typecheck`, `pnpm lint`, `pnpm test`
(e2e 195), `pnpm test:egress` (11), `pnpm test:sandbox` (16), `scripts/restore-drill.sh`, and a
full `docker compose up --wait` of every service except `backup` with placeholder credentials
(all health checks pass). The compose smoke found two production bugs that the unit suites did
not: the runtime image lacked `infra/mcp.yaml` and `skills/` (`ce348a7`), and the full restore
failed on the read-only `/backup-extra` mount (`44b6a4e`).

Review rounds: the code review of `a222eb4` found 3 blocking and 20 should-fix items, all fixed
in `8519fbf`. The UI review took three rounds (`8519fbf`, `fda8bff`). One UI finding is declined:
an agent YAML editor in the PWA. The plan, section 9, defines an agent as a file in `agents/`,
which is edited as code and tracked in git. The agents screen stays read-only.
UI review verdict after round three: PASS. One open 🟠 note is accepted: at 1440 the vault
table is wider than the page column, so its left edge does not line up with the heading. The
table needs the width; the rest of the screen does not.

User-only gate items (see `docs/deploy.md`): push on a locked iPhone, real Finnish speech to
text.
