# Decision records

One file per locked or verified decision. File name: `NNNN-short-title.md`.
Each record has these sections: Context, Decision, Consequences, Verified on (date and how).
The build plan is `docs/plan.md`. Section numbers in records refer to it.

## Index

- `0001-pi-1.3.0-contract.md`: Pi 1.3.0 API contract.
- `0002-workflow-and-pins.md`: workflow, git, and dependency pins.
- `0003-finnish-pii-stack.md`: Finnish PII stack for `pseudo-svc`.
- `0004-litellm-openrouter-zdr.md`: LiteLLM, OpenRouter ZDR, and the Presidio backstop.
- `0005-mcp-integrations.md`: MCP integrations (phase 6).
- `phase-1.md` to `phase-5.md`, `phase-7.md`, `phase-8.md`: tasks, decisions, and gates per phase. Phase 6 has no phase file; see 0005.
- `phase-9-ui.md`: production UI on shadcn/ui, design brief, review protocol and status.
- `0006-ui-reference.md`: deep research on Claude Web and ChatGPT UI (October 2026).
- `phase-10-models.md`: model picker, thinking level, per-chat ZDR override; OpenRouter research.
- `phase-11-15-plan.md`: decisions for files, pseudo hardening, thread depth, web search, admin (2026-10-26).
- `phase-11-files.md`: the Files screen: routes, path guard, trash, origins, quota, attach and save artifact.
- `phase-12-pseudo.md`: rare surrogate pairs, the surrogate collision check, email and street address surrogates, lone lower-case surnames, corpus gate.
- `phase-13-thread.md`: fork into a new chat, thinking row, usage and cost in EUR, timestamps, find bar.
- `phase-14-search.md`: the `web_search` tool through the `zdr/search` alias (OpenRouter web plugin, Exa), the entity approval card, guard rules, search rows and usage.
- `phase-15-admin.md`: agent and automation editors, signed-in devices, the encrypted full export (OpenSSL `enc` AES-256 over a stdlib zip), usage per agent and search count.
