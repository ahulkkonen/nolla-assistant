# Development

This file holds the notes for developers: the layout, the commands, the tests, the dependency
policy and the status of each phase. `README.md` tells what the project is.
Agents and contributors: read `AGENTS.md` first. It holds the rules and the document index.

## Repository layout

```
apps/
  web/              React + Vite PWA
  server/           Pi host, auth, WebSocket bridge, push, API
packages/
  protocol/         zod schemas for client-server messages
  db/               SQLite schema and migrations
  pi-ext-pseudo/    masks at ingest, unmasks at tool calls, leak scan
  pi-ext-memory/    USER.md and MEMORY.md injection, memory tools
  pi-ext-topics/    reports agent_settled; the title and topic jobs live in the server
  pi-ext-subagents/ child Pi processes
  pi-ext-sandbox/   bash tool that runs in sibling containers
services/
  pseudo-svc/       Python FastAPI: /mask /unmask /scan and the vault
  sandbox-broker/   Node service that runs skill commands in containers
skills/             vendored skills (none yet; see skills/README.md)
agents/             agent profiles (YAML) and prompts
automations/        cron automations
infra/              compose.yaml, Dockerfiles, LiteLLM, backup, MCP config
scripts/            password hash, restore, restore drill, model download, skill-runner image
tests/              contract, e2e, egress, fake-llm, masked-only, mcp, memory-eval, pii, sandbox
docs/               plan.md, deploy.md, decisions/
```

## Prerequisites

- Node 22.19 or newer.
- pnpm 12, installed with corepack: `corepack enable`.
- Docker, for the container suites (`test:egress`, `test:sandbox`, restore drill, sidecar).
- Python 3.12, only for local tests of `services/pseudo-svc`.

## Develop

Install the dependencies:

```sh
pnpm install
```

Copy `.env.example` to `.env` and fill in the values.
The file explains each variable. Production secrets live in Coolify, never in the repository.

Run the server. Nothing loads `.env` for you, so export its variables first.
`AUTH_PASSWORD_HASH` in `.env` has `$$` for compose; the shell needs a single `$`, so set that one by hand:

```sh
set -a; source .env; set +a
pnpm --filter @pa/server dev
```

Run the web dev server in a second terminal:

```sh
pnpm --filter @pa/web dev
```

No test needs a model key.
`tests/fake-llm` is an in-process OpenAI-compatible server with scripted turns.
It is a library (`startFakeLlm`), not a command.
Import it in a script or test to work offline, and point `LITELLM_URL` at the address it returns.

Other root commands: `pnpm typecheck`, `pnpm lint`, `pnpm lint:fix`, `pnpm build`.

## Test

| Command | What it runs | Needs |
|---|---|---|
| `pnpm test` | Workspace vitest suites, contract, masked-only, mcp, and the Playwright `chromium` flows; egress and sandbox excluded | No Docker |
| `pnpm test:contract` | Pi contract tests only | No Docker |
| `pnpm test:egress` | LiteLLM and Presidio against a mock OpenRouter | Docker |
| `pnpm test:sandbox` | Broker and skill-runner containers | Docker |
| `scripts/restore-drill.sh` | Backup and restore on a local S3 stand-in | Docker, Node |
| `python3 -I tests/pii/harness.py` | Recall and precision on the Finnish corpus | A running `pseudo-svc` |
| `pytest` in `services/pseudo-svc` | Sidecar unit tests | Python 3.12 |

Playwright needs Chromium. Install it once:

```sh
pnpm --filter @pa/e2e exec playwright install chromium
```

The first server test run downloads the embedding model once (`Xenova/multilingual-e5-small`,
about 130 MB) to `MODELS_DIR`, by default `$TMPDIR/pa-models`. Without the model, the search,
claims and memory tests fail. Set `PA_SKIP_MODEL_TESTS=1` to skip them when you work offline.
CI must not set it.

Set `PSEUDO_URL` for the PII harness, for example `PSEUDO_URL=http://localhost:8000`.
Use `--dry-run` to check the corpus without a sidecar.
See `tests/pii/README.md`.

## Deploy

`docs/deploy.md` is the runbook for Coolify on a Hetzner VPS.
Follow its steps in order.
The runbook also covers backups, restore, the sandbox, and the Google integration.
Only you can do these steps:

- Create the Coolify resource and set its environment variables.
- Turn the OpenRouter account ZDR toggles off and create the key under a ZDR guardrail.
- Create the S3 bucket and set the `S3_*` and `RESTIC_PASSWORD` variables.
- Build the `pa-skill-runner` image on the Docker host (`scripts/build-skill-runner.sh`).
- Create the Google OAuth client and connect your account.
- Install the app on the iPhone from Safari.
- Register a passkey after the first password login.

## Dependency policy

- Every dependency has an exact pin. `.npmrc` sets `save-exact=true`.
- `pnpm-workspace.yaml` sets `minimumReleaseAge: 10080`. pnpm refuses a release younger than 7 days.
- Check the age of a version before you pin it:

  ```sh
  curl -s https://registry.npmjs.org/<package> | node -e \
    'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).time[process.argv[1]]))' <version>
  ```

  The command prints the publish date. Pin only if it is at least 7 days old.
- Check Python packages on PyPI in the same way. Build `services/pseudo-svc/requirements.lock`
  with a cut-off that is a full UTC timestamp at least 7 days ago. uv reads a bare date as the
  end of that day.

  ```sh
  cd services/pseudo-svc
  uv pip compile pyproject.toml --universal --python-version 3.12 \
    --exclude-newer 2026-10-24T00:00:00Z --generate-hashes -o requirements.lock
  ```
- A version bump is its own change.
  The contract tests and the PII suite are the gate.
- Pi is pinned exactly; a bump is its own task (`docs/decisions/0002-workflow-and-pins.md`, `0009-pi-1.4.0.md`).

## Decision records

`docs/decisions/` holds the decision records and the per-phase notes.
The index is in `docs/decisions/README.md`.

## Status

Status on 2026-10-31. The plan, section 13, defines each gate.

| Phase | Scope | Status |
|---|---|---|
| 1 | Pi host, protocol, contract tests | done |
| 2 | PWA shell, auth, attachments, deploy | done, user steps open |
| 3 | Finnish PII, vault, ZDR egress | done |
| 4 | Titles, topics, search, backups | done |
| 5 | Agents, subagents, sandbox, automations | done |
| 6 | Google Workspace MCP | done, user steps open |
| 7 | Artifacts, voice, push, palette | done, user steps open |
| 8 | Memory | done |
| 9 | Production UI on shadcn/ui (`docs/decisions/phase-9-ui.md`) | done, on-device checks open |
| 10 | Model picker, thinking level, per-chat ZDR override (`docs/decisions/phase-10-models.md`) | done, open key is a user step |
| 11 | Files screen, trash, quota, work-dir attachments (`docs/decisions/phase-11-files.md`) | done |
| 12 | Pseudonymization hardening: rare surrogates, collisions, email and street (`docs/decisions/phase-12-pseudo.md`) | done |
| 13 | Thread depth: fork, thinking, cost, find (`docs/decisions/phase-13-thread.md`) | done |
| 14 | Web search tool with entity guard (`docs/decisions/phase-14-search.md`) | done, plugin defaults are a user step |
| 15 | Admin: agent and automation editors, devices, encrypted full export (`docs/decisions/phase-15-admin.md`) | done |
| 16 | Polish: one deep agent, CSP reports, prompt cache counts, OCR for scanned PDFs, streaming Markdown, jump pill, chat cost header (`docs/decisions/phase-16-polish.md`) | done |
| 17 | Memory 2: claims and evidence, one masked extraction per chat, per-turn claims block, Havainnot review tab, memory eval (`docs/decisions/phase-17-memory.md`) | done |
| 18 | Search backend (Brave direct, Exa deep): researched in `docs/decisions/0007-memory-and-search-research.md`, deferred by the user; OpenRouter Exa stays | deferred |
| 19 | Viz: `vega-lite` block with the injected theme, Mermaid retheme, design kit for HTML artifacts with Plot and D3, SVG/PNG export, sandbox page (`docs/decisions/phase-19-viz.md`) | done |
| 20 | Thread figures: charts and diagrams inline with light PNG export, one artifact whitelist, streaming card, panel per chat, message queue and model change during a run, figure fonts and colour roles, Mermaid header strips (`docs/decisions/phase-20-thread.md`) | done |
| 21 | Polish: "Sarake" diagram look, export typography, "Uusimmat" models per lab, confidence trial (`⟦N⟧` markers), tool-row icons, per-chat auto-approve (`docs/decisions/phase-21-polish.md`) | done |
| 22 | Quick wins: model error status and detail, ZDR refusal classifier, fork without title lock, topic dedupe and links, idle PWA auto-update, Escape audit, subagent auto-approve, plain http on the wifi, Pi 1.4.0, WebKit screens (`docs/decisions/phase-22-quick-wins.md`) | done |
| 23 | Output modes (`agents/modes/*.md`, Tila chip, legend, mode editor) and the path router (`docs/decisions/phase-23-modes-router.md`) | done |
| 24 | Edit in place with versions: sibling user entries in the Pi session tree, `pa-leaf`, the ‹ 1/2 › switcher, readers follow the shown branch (`docs/decisions/phase-24-edit-in-place.md`) | done |
| 25 | Harness tools `profile_edit`, `automation_edit`, `chat_read` behind mandatory cards with diff and YAML views; `fetch_url` replaces `web-digest` (`docs/decisions/phase-25-harness-tools.md`) | done |
| 26 | Waiting line "Vaiheet" with a receipt, Android keyboard follow and focus (`docs/decisions/phase-26-waiting-keyboard.md`) | done |
| 27 | Streaming: per-frame deltas, in-place final, caret on the last character that breathes, table and emphasis hold-back (`docs/decisions/phase-27-streaming.md`) | done |
| 28 | Fixes: MEMORY.md regenerates on activation, Tila chip links to the mode editor, Luottamus on a relative scale with underlined low sentences, pseudonym marks behind a setting (`docs/decisions/phase-28-fixes.md`) | done |
| 29 | Evals: topics and memory with a judge, reserved for a guided session; `tests/memory-eval` and `tests/pii` exist today | reserved |
| 30 | Audits before publication: security, architecture and dependency audits in `docs/audits/`, fixes in two batches (`docs/decisions/phase-30-audits.md`) | done |
| 31 | Publication preparation: MIT license, GitHub Actions gate, history rewrite (model blob, screenshot churn, session trailers, author email), synthetic names (`docs/decisions/phase-31-publication.md`) | done |
| 32 | README for readers (short form plus `docs/overview.md`), curated media, the threat model (`docs/decisions/phase-32-readme.md`) | done |
