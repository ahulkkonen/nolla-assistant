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
   not justified; plan amended). Actions: copy, download, open in new tab (blob URL), close.
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
