# Phase 1 — Pi host, protocol, session persistence, contract tests

Gate (plan §13): contract tests pass against Pi 1.3.0; a scripted client can create a chat,
send a message, stream a reply, and reload it after a server restart.

Gate command: `pnpm typecheck && pnpm lint && pnpm test`

## Decisions for this phase

- Model traffic in tests goes to `@pa/fake-llm`, an in-process OpenAI-compatible SSE server with
  scripted turns. No real key is needed for any phase-1 test.
- Pi provider is named `zdr`. Model ids are `zdr/<alias>` so a Pi model ref reads `zdr/zdr/strong`
  but the wire `model` field that LiteLLM sees is `zdr/strong`, matching plan §5 and §8.
  `apps/server` writes `<agentDir>/models.json` at startup from `infra/models.json`.
- Per-user layout under `DATA_DIR`: `pi/<userId>/` (agentDir: models.json, settings), `sessions/<userId>/`
  (Pi JSONL), `work/<userId>/` (cwd for Pi tools), `files/<chatId>/` (attachments), `app.db`.
- Phase-1 tools: `read`, `write`, `edit` only, cwd `work/<userId>`. `bash` waits for the sandbox
  broker in phase 5.
- No auth in phase 1 (phase 2 adds it). `getUser(req)` returns the single configured user.
- Server runs TypeScript directly on Node ≥ 22.18 (type stripping), no build step. Imports use `.ts`.
- `PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1`, `PI_TELEMETRY=0` are set by the server process.

## Task cards

| # | Task | Owner | Files | Acceptance |
|---|---|---|---|---|
| 1 | `@pa/fake-llm` scripted OpenAI-compatible server | Sonnet | `tests/fake-llm/` | unit test: text turn and tool-call turn stream as SSE and are parsed by the `openai` wire format |
| 2 | `apps/server`: config, Pi host (`SessionRegistry`), bridge, HTTP+WS | Opus | `apps/server/`, `infra/models.json` | e2e test: WS client creates chat, sends message, receives `message.delta`+`message.final`, restarts server, `chat.open` returns the message |
| 3 | `tests/contract`: hook payload shapes against Pi 1.3.0 | Opus | `tests/contract/` | asserts field names from `docs/decisions/0001` §1–2, chaining, `structuredContent` drop, `agent_settled` fires |

Reviewer: cavecrew-reviewer on each task diff. UI reviewer: none (no `apps/web` in phase 1).
