# Personal Assistant 2.0

## What this is

This repository holds a single-user, self-hosted personal assistant.
Pi is the agent runtime and a custom PWA is the interface.
All model traffic leaves the box pseudonymized and goes to OpenRouter with zero data retention.

The invariants (`docs/plan.md` section 2):

- Masked-only sessions: Pi sessions hold only pseudonymized text.
- One egress URL: every model call goes to the LiteLLM proxy, which alone holds the OpenRouter key.
- Own client protocol: the browser uses a typed zod WebSocket protocol, never raw Pi events.
- Pinned Pi: `@earendil-works/pi-coding-agent` has an exact version, and `tests/contract` guards it.
- TypeScript everywhere Pi touches; Python only inside `services/pseudo-svc`.
- `user_id` on every row and per-user Pi directories.
- Skills come only from this repository. There is no runtime install.
- No Docker socket in app containers, except `sandbox-broker`.
- Local-first data: SQLite, JSONL sessions, and markdown memory live under one `/data` volume, with backups.
- Minimal UI: each element on screen must have a user action.

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
  pi-ext-topics/    titles and topics after agent_settled
  pi-ext-notify/    Web Push
  pi-ext-subagents/ child Pi processes
  pi-ext-sandbox/   bash tool that runs in sibling containers
services/
  pseudo-svc/       Python FastAPI: /mask /unmask /scan and the vault
  sandbox-broker/   Node service that runs skill commands in containers
skills/             vendored skills
agents/             agent profiles (YAML) and prompts
automations/        cron automations
infra/              compose.yaml, Dockerfiles, LiteLLM, backup, MCP config
scripts/            password hash, restore, restore drill, model download
tests/              contract, e2e, egress, fake-llm, masked-only, mcp, pii, sandbox
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

Run the server. It reads `.env` from the environment:

```sh
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
| `pnpm test` | All workspace suites, including contract, masked-only, mcp, and Playwright e2e | No Docker |
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

Set `PSEUDO_URL` for the PII harness, for example `PSEUDO_URL=http://localhost:8000`.
Use `--dry-run` to check the corpus without a sidecar.
See `tests/pii/README.md`.

## Deploy

`docs/deploy.md` is the runbook for Coolify on a Hetzner VPS.
Follow its steps in order.
The runbook also covers backups, restore, the sandbox, and the Google integration.
Only you can do these steps:

- Create the Coolify resource and set its environment variables.
- Set the OpenRouter ZDR toggles and create the key with a ZDR guardrail.
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
- Check Python packages on PyPI in the same way.
- A version bump is its own change.
  The contract tests and the PII suite are the gate.
- Pi stays at 1.3.0 for now. Details are in `docs/decisions/0002-workflow-and-pins.md`.

## Decision records

`docs/decisions/` holds the decision records and the per-phase notes.
The index is in `docs/decisions/README.md`.

- `0001`: Pi 1.3.0 API contract.
- `0002`: workflow, git, and dependency pins.
- `0003`: Finnish PII stack for `pseudo-svc`.
- `0004`: LiteLLM, OpenRouter ZDR, and the Presidio backstop.
- `0005`: MCP integrations (phase 6).
- `phase-1.md` to `phase-5.md`, `phase-7.md`, `phase-8.md`: tasks, decisions, and gates per phase.

## Status

Status on 2026-10-25. The plan, section 13, defines each gate.

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
| 13 | Thread depth: fork, thinking, cost, find (`docs/decisions/phase-13-thread.md`) | in progress |
