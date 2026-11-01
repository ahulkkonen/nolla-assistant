# AGENTS.md

Read this file first. It gives the facts that every agent needs and an index of the documents that
hold the details. Do not copy content from the other documents into this file.

## What this repository is

A single-user, self-hosted personal assistant. Pi (`@earendil-works/pi-coding-agent`, exact
version in `apps/server/package.json`) is the agent runtime. A React PWA is the interface. All model
traffic leaves the box pseudonymized and goes through one LiteLLM proxy to OpenRouter with zero
data retention (ZDR). The user interface is in Finnish.

The build plan is `docs/plan.md`. Decision records cite its section numbers (`§N`) where they apply.

## Invariants

A change that breaks one of these is rejected, whatever it adds. The full text is `docs/plan.md`
section 2.

1. **Masked-only sessions.** Pi sessions, titles, topics, subagents and memory extraction see only
   pseudonymized text. Real values exist in the vault (`services/pseudo-svc`), in memory files on
   disk, in tool arguments at execution time and on the user's screen.
2. **One egress URL.** Every model call goes to LiteLLM. Only LiteLLM holds the OpenRouter keys.
3. **Own client protocol.** The browser speaks the zod protocol in `packages/protocol`. Raw Pi
   events never reach the browser.
4. **Pinned Pi.** Exact version, guarded by `tests/contract`. Hook payload field names come from the
   contract notes (`docs/decisions/0001-*.md`, `0009-*.md`), not from memory.
5. **TypeScript everywhere Pi touches.** Python only in `services/pseudo-svc`, the LiteLLM guard
   (`infra/litellm/zdr_guard.py`) and the PII harness (`tests/pii`).
6. **`user_id` on every row** and per-user Pi directories.
7. **Skills only from this repository.** No runtime install.
8. **No Docker socket in app containers**, except `services/sandbox-broker`.
9. **Local-first data** under one `/data` volume: SQLite, JSONL sessions, markdown memory.
10. **Minimal UI.** Every element on screen must have a user action.

## Rules for agents

- **Never log or print real values.** Not user text, not search queries, not passphrases, not
  surrogate-to-real pairs. Tests use synthetic names only.
- **Dependencies.** Exact pins. Never pin a release younger than 7 days. `pnpm-workspace.yaml`
  enforces this with `minimumReleaseAge: 10080`. Check the publish date on the registry before you
  pin (command in `docs/development.md`, "Dependency policy"). A version bump is its own change.
- **Pi version bump** is its own task: diff the `.d.ts` files that the contract note cites, run
  `pnpm test:contract`, the server suite and the e2e flows, write a new `docs/decisions/00NN-*.md`.
- **Finnish strings in the UI.** New user-facing text follows the existing wording. Keep the
  typographic conventions of the thread: numbers through the `fi` formatter `count` in
  `apps/web/src/thread.ts`, the separator " ·" with a no-break space after it.
- **Decision records.** Each phase has a record under `docs/decisions/` (`phase-N.md` for phases 1
  to 8, `phase-N-<slug>.md` after that; phase 18 was deferred and has none). Newer records list the
  decisions, a status and the review findings that were left as they are, on purpose. Read the
  record of the area you touch before you change it. Add to it when you decide something a reader
  cannot derive from the code.
- **Documentation prose** follows ASD-STE100 (Simplified Technical English): short sentences, one
  instruction per sentence, active voice.
- **Code style.** Biome formats and lints (`pnpm lint`, `pnpm lint:fix`); line width 100, two
  spaces. Prefer the smallest change that works. Reuse an existing helper before you write one.
- **Worktrees** go under `/tmp/pa-*`, not under `.claude/worktrees` (Biome ignores that path, so a
  worktree there is never linted).
- **Commits** use Conventional Commits (`feat(web): …`, `fix(server): …`, `docs: …`). Review happens
  before the commit, so `git log` is the review log. The remote is `origin`
  (`github.com/ahulkkonen/nolla-assistant`); push `main` only after the gate below is green, because
  CI runs on every push to `main`.

## Layout

```
apps/web            React 19 + Vite + Tailwind 4 + shadcn/ui PWA; zustand store (store.ts), ws.ts, router.ts
apps/server         Fastify host (export .env before `dev`): auth/, bridge.ts (WebSocket dispatch), bridge/ (handlers per concern),
                    socket.ts, history.ts, session-text.ts, restore.ts, llm.ts (module map: phase-30 record, item 10), pi/ (registry,
                    models, guard), approval.ts, harness.ts, fetch-tool.ts, modes.ts, versions.ts, claims.ts, export.ts, topics.ts
packages/protocol   zod schemas for every client-server message; the single source of truth for types
packages/db         drizzle SQLite schema and migrations (drizzle/NNNN_*.sql)
packages/pi-ext-*   Pi extensions: pseudo, memory, topics, subagents, sandbox (push lives in apps/server/src/push.ts)
services/pseudo-svc Python FastAPI: /mask /unmask /scan and the vault
services/sandbox-broker  runs skill commands in throwaway containers; net.ts holds the private-address rule
agents/             assistant.yaml (profile), prompts/assistant.md, modes/*.md (output modes)
automations/        cron automations as YAML; see automations/README.md
skills/             vendored skills; see skills/README.md
infra/              compose.yaml, compose.local.yaml, Dockerfiles, LiteLLM config, backup
scripts/            hash-password, decrypt-export, restore, restore-drill, download-models, build-skill-runner
tests/              contract, e2e (Playwright), egress, fake-llm, masked-only, mcp, memory-eval, pii, sandbox
docs/               plan.md, deploy.md, development.md, overview.md, threat-model.md, roadmap.md, decisions/, audits/, media/ (README images)
```

## Commands

```sh
pnpm install
set -a; source .env; set +a; pnpm --filter @pa/server dev
pnpm --filter @pa/web dev
pnpm typecheck                          # add --workspace-concurrency=1 if the machine is loaded
pnpm lint
pnpm test                               # workspace vitest suites and Playwright chromium; egress and sandbox (Docker) excluded
pnpm test:contract                      # Pi contract tests
pnpm --filter @pa/e2e exec playwright test --project screens   # screenshots at 390/1024/1440, light and dark, axe strict
pnpm test:webkit
pnpm test:egress                        # Docker
pnpm test:sandbox                       # Docker
docker compose -p pa-local --env-file .env -f infra/compose.yaml -f infra/compose.local.yaml up -d --build
```

Notes:

- The `screens` project rewrites every baseline under `tests/e2e/screenshots` and never compares
  pixels. "Passed" means the axe checks passed. Look at the PNG files, then run
  `git checkout -- tests/e2e/screenshots` after a run that you do not want to keep.
- No test needs a model key. `tests/fake-llm` is an in-process OpenAI-compatible server.
- The `pa-skill-runner` image is never built by compose. Run `scripts/build-skill-runner.sh` on each
  Docker host. The error `No such image: pa-skill-runner:latest` means the image is missing.
- Run the compose stack after any Dockerfile or compose change. It has caught bugs that the unit
  suites missed. Prune images and build cache when Docker has under 10 GB free.

## Gate before a merge

Every one of these is green on a clean worktree: typecheck, `pnpm lint`, the protocol, server and web
vitest suites, `pnpm test:contract`, the Playwright `chromium` flows and the `screens` project with
axe strict. `pnpm test:sandbox` when the broker or the sandbox extension changed. A change under
`apps/web` also gets a scored screenshot review against the design brief (see UI below).

## UI work

The design brief is `docs/decisions/phase-9-ui.md` section 7. The bar is "as polished as Claude Web
and ChatGPT", not "clean shadcn defaults" (`docs/decisions/0006-ui-reference.md` is the reference
research). The process: build to the brief, run the `screens` project, then a reviewer who has not
seen the diff scores every screenshot on six criteria 1 to 5; fix every blocking and should-fix
finding; act on each nice-to-have or record in the phase record why it stays. Keep the 390 px screenshots under touch
emulation.

## Document index

Start here for a topic. Each entry says what the document answers.

| Document | Answers |
|---|---|
| `README.md` | The short form: what the project is, the masking screenshots, the architecture diagram, how to run it |
| `docs/overview.md` | The long form of the README: each claim with its proof, the architecture, the tour, how it was built, the test table |
| `docs/development.md` | How to develop and test, the test commands, the dependency policy, the status table per phase |
| `docs/plan.md` | The full build plan: architecture (§3), protocol (§5), PII (§6), memory (§7), agents (§9), MCP (§10), UI spec (§11), phases (§13), quality gates (§14), pitfalls (§15) |
| `docs/deploy.md` | Runbook for Coolify on a VPS, the local Docker run, the phone on the wifi, backups and restore, Google OAuth |
| `docs/threat-model.md` | What the system protects, against whom, the controls with their files and tests, the residual risks (plan §14) |
| `docs/roadmap.md` | Planned work that is not built, what each item closes and what it costs |
| `docs/decisions/README.md` | Index of every decision record and phase record |
| `docs/decisions/0001-pi-1.3.0-contract.md`, `0009-pi-1.4.0.md` | The Pi API surface the code depends on; what changed in 1.4.0 |
| `docs/decisions/0002-workflow-and-pins.md` | Git workflow without a remote, the 7-day pin rule, TypeScript version choice |
| `docs/decisions/0003-finnish-pii-stack.md`, `phase-12-pseudo.md`, `phase-33-recall.md` | How Finnish names, addresses and emails are recognised and replaced; surrogates, collisions, the corpus gate |
| `docs/decisions/phase-34-vault-add.md` | Frequent lone surnames in the pending lane; how the owner adds a nickname or a value to the vault (`vault.add`) |
| `docs/decisions/0004-litellm-openrouter-zdr.md`, `phase-10-models.md`, `phase-22-quick-wins.md` | LiteLLM config, ZDR enforcement, the per-chat ZDR override, model error reporting, the ZDR refusal classifier |
| `docs/decisions/0005-mcp-integrations.md` | Google Workspace through MCP |
| `docs/decisions/phase-9-ui.md`, `0006-ui-reference.md` | Design brief with exact values, review protocol, UI reference research |
| `docs/decisions/phase-11-files.md` | Files screen, path guard, trash, quota |
| `docs/decisions/phase-13-thread.md`, `phase-20-thread.md`, `phase-27-streaming.md` | Fork, thinking rows, cost, find bar; inline figures, artifact panel, message queue; streaming render and caret |
| `docs/decisions/phase-14-search.md` | `web_search` through OpenRouter Exa, the entity approval card |
| `docs/decisions/phase-15-admin.md` | Agent and automation editors, devices, encrypted full export |
| `docs/decisions/phase-17-memory.md`, `0007-memory-and-search-research.md` | Claims and evidence, the extraction call, MEMORY.md, the memory eval |
| `docs/decisions/phase-19-viz.md`, `phase-21-polish.md`, `0008-viz-research.md` | Vega-Lite theme, Mermaid "Sarake" look, design kit for HTML artifacts, export |
| `docs/decisions/phase-23-modes-router.md` | Output modes (`agents/modes/*.md`), the mechanics-only assistant prompt, the path router |
| `docs/decisions/phase-24-edit-in-place.md` | Message versions as sibling entries in the Pi session tree, `pa-leaf`, what readers see |
| `docs/decisions/phase-25-harness-tools.md` | `profile_edit`, `automation_edit`, `chat_read`, `fetch_url`; the mandatory approval card; the audit trail |
| `docs/decisions/phase-26-waiting-keyboard.md` | The waiting line "Vaiheet", the receipt, Android keyboard behaviour |
| `agents/assistant.yaml`, `agents/prompts/assistant.md`, `agents/modes/*.md` | The live agent profile, tool allow and approval lists, the user's voice (`suora`) |
| `automations/README.md` | Automation YAML fields and run semantics |
| `skills/README.md` | How to vendor a skill, the `sandbox.network` block |
| `tests/pii/README.md` | The Finnish PII harness and corpus |
| `packages/protocol/src/index.ts` | Every message type; read it before you touch the bridge or the store |
