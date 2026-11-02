# Glossary

The terms that the documents and the code use, with their plain meaning. The README avoids most of
them. The other documents use them, because they are the names in the code.

| Term | Meaning |
|---|---|
| Pseudonymization | Personal data in a text is replaced with realistic fake values before the text leaves the box. The real values stay in the vault. |
| Surrogate | The fake value that stands in for a real one. A surrogate name gets the same Finnish word endings as the real name. |
| Vault | The encrypted store in `pseudo-svc` that maps each real value to its surrogate. The model never sees it. |
| Pending lane | A detection that the system is not sure about. It is masked at once and waits on the vault screen until you confirm it as a name or dismiss it. |
| Collision | A surrogate that looks like a real value, or a real value that looks like a surrogate. The turn stops until the system has resolved it. |
| Masked-only | The invariant that Pi sessions, titles, memory and subagents see only pseudonymized text. |
| ZDR | Zero data retention. An OpenRouter endpoint that keeps no prompt and no reply after the call. |
| Egress | The one path that model calls take out of the box: the LiteLLM proxy. Nothing else holds a model key or talks to a model provider. |
| LiteLLM | The proxy container that holds the OpenRouter keys and pins each route to a ZDR provider. |
| Pi | The agent runtime (`@earendil-works/pi-coding-agent`). It runs the loop of model call, tool call, model call. |
| Harness | The code around Pi: the server, the bridge, the hooks and the extensions. Harness tools are the tools that let the assistant edit its own prompt and automations. |
| Subagent | A second Pi session that the assistant starts for a side task. In the build process, a Claude Code agent that the main session started. |
| Claim | One fact in memory, with the quote that supports it. A proposed claim waits for your review. |
| Output mode | A short instruction set that shapes how the assistant answers, such as "Luottamus". The UI calls it "Tila". |
| Topic | A group of chats that the assistant files together. |
| Automation | A scheduled task in YAML that runs a prompt at a set time. |
| Skill | A vendored instruction set with its commands. Commands run in a throwaway container through the sandbox broker. |
| Sandbox broker | The one container with the Docker socket. It starts and stops the throwaway containers. |
| MCP | Model Context Protocol. The way the assistant reaches Google Workspace through a separate container. |
| Approval card | A card in the chat that waits for your answer before a tool runs. Code enforces the wait, not the prompt. |
| Gate | The set of checks that must pass before a commit: typecheck, lint, the unit suites, the contract tests and the Playwright flows. |
| Baseline | A screenshot that the `screens` project saved, one per screen, width and theme. |
| Decision record | A document under `docs/decisions/` that lists the decisions of one phase, the status and the review findings that were left as they are. |
| Phase | One unit of the build plan. Each phase has a decision record and ends with a review pass. |
| Blind screenshot review | A reviewer who has not seen the code scores every screenshot against the design brief. |
| Corpus | The 562 labelled Finnish texts in `tests/pii` that measure recall and precision. |
