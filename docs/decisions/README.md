# Decision records

One file per locked or verified decision. File name: `NNNN-short-title.md`.
Each record has these sections: Context, Decision, Consequences, Verified on (date and how).
The build plan is `docs/plan.md`. Section numbers in records refer to it.

## Index

- `0001-pi-1.3.0-contract.md`: Pi 1.3.0 API contract.
- `0009-pi-1.4.0.md`: Pi 1.4.0 differences from the 1.3.0 contract.
- `0002-workflow-and-pins.md`: workflow, git, and dependency pins.
- `0003-finnish-pii-stack.md`: Finnish PII stack for `pseudo-svc`.
- `0004-litellm-openrouter-zdr.md`: LiteLLM, OpenRouter ZDR, and the Presidio backstop.
- `0005-mcp-integrations.md`: MCP integrations (phase 6).
- `phase-1.md` to `phase-8.md`: tasks, decisions, and gates per phase. Phase 6 also has 0005.
- `phase-9-ui.md`: production UI on shadcn/ui, design brief, review protocol and status.
- `0006-ui-reference.md`: deep research on Claude Web and ChatGPT UI (October 2026).
- `phase-10-models.md`: model picker, thinking level, per-chat ZDR override; OpenRouter research.
- `phase-11-15-plan.md`: decisions for files, pseudo hardening, thread depth, web search, admin (2026-10-26).
- `phase-11-files.md`: the Files screen: routes, path guard, trash, origins, quota, attach and save artifact.
- `phase-12-pseudo.md`: rare surrogate pairs, the surrogate collision check, email and street address surrogates, lone lower-case surnames, corpus gate.
- `phase-13-thread.md`: fork into a new chat, thinking row, usage and cost in EUR, timestamps, find bar.
- `phase-14-search.md`: the `web_search` tool through the `zdr/search` alias (OpenRouter web plugin, Exa), the entity approval card, guard rules, search rows and usage.
- `phase-15-admin.md`: agent and automation editors, signed-in devices, the encrypted full export (OpenSSL `enc` AES-256 over a stdlib zip), usage per agent and search count.
- `phase-16-polish.md`: one deep agent (Tutkija merged into Avustaja), the CSP report endpoint, prompt cache counts, local OCR for scanned PDFs.
- `phase-17-memory.md`: memory 2: claims and evidence in SQLite, one masked extraction call per chat, per-turn claims block after the cached prefix, MEMORY.md from claims, review tab, Finnish memory eval.
- `0007-memory-and-search-research.md`, `0008-viz-research.md`: deep research on memory and search, and on charts and diagrams.
- `phase-19-viz.md`: the `vega-lite` chart block, the Mermaid theme, the design kit for HTML artifacts, SVG and PNG export, the sandbox page.
- `phase-20-thread.md`: inline chart and diagram figures with light PNG export, one artifact whitelist, the streaming card, the panel per chat, the message queue and model change during a run, figure fonts and colour roles.
- `phase-21-polish.md`: the "Sarake" flowchart look and wrapped export text, the "Uusimmat" catalog section from OpenRouter `~latest` aliases, the confidence-marker trial, tool-row icons, the per-chat auto-approve toggle and the skill-runner image note.
- `phase-22-quick-wins.md`: model error status and detail, the ZDR refusal classifier, fork without title lock, topic dedupe and links, idle PWA auto-update, the Escape audit, auto-approve for subagent children, plain http on the wifi, Pi 1.4.0, the WebKit screens project.
- `phase-23-modes-router.md`: per-chat output modes (`agents/modes/*.md`, `suora` and `perusteellinen` on by default, confidence as a mode), the mechanics-only assistant prompt, the mode editor and writers, the path router.
- `phase-24-edit-in-place.md`: edit a user message in place as a version (sibling user entries in the Pi session tree, `pa-leaf`), the version switcher, what readers see.
- `phase-25-harness-tools.md`: `profile_edit`, `automation_edit` and `chat_read` behind a mandatory card with a diff or YAML view, the audit trail, and `fetch_url` in place of the `web-digest` skill.
- `phase-26-waiting-keyboard.md`: the waiting line "Vaiheet" (`message.phase` sent and headers, the receipt with stored times), the thread that keeps its bottom when an Android keyboard opens, and send that keeps the keyboard open.
- `phase-27-streaming.md`: the streaming reply: one article from the live reply to the final message, deltas batched per frame, the caret on the last character and its breathing, a thread that does not render per delta, held-back tables and emphasis, and any upward scroll that stops the follow.
