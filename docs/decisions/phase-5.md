# Phase 5 — Agent profiles, subagents, skills, sandbox broker, automations

Gate (plan §13): a skill with `network: none` cannot reach the internet from its runner; a parallel
subagent run shows live status and its tool calls are masked; a cron automation posts to its topic.

Gate command: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:sandbox` (Docker)

## Decisions

1. **Agent profile** = `agents/<id>.yaml` as in plan §9, loaded at startup and on file change
   (`fs.watch`, debounce 1 s). Fields: `id, name, model (zdr/<alias>), prompt (path under
   `agents/prompts/`), skills[], tools.allow[], tools.mcp[], approval.always[], approval.never[],
   subagents (bool)`. Validated with zod; a bad file is logged and skipped; `assistant` is required.
   The profile is chosen per chat (`chats.agentId`); `user.message.agentId` switches the profile for a
   new chat only (an existing chat keeps its agent).
2. **Approval gate**: an inline extension `approvalGate(policy)` on `tool_call`: tools in
   `approval.always` send `approval.request { requestId, tool, args (restored, real values), reason,
   expiresAt }` to the chat room and await `approval.respond`; 10-minute timeout → `{ block: true,
   reason: 'approval timed out' }`. Tools in `approval.never` skip the gate. The gate runs after
   `pseudoExtension` (args are already restored) and before `pathGuard`. Pending approvals survive a
   socket reconnect (kept in a server `Map` keyed by `requestId`), not a server restart.
3. **Bash** is never Pi's built-in `bash` (plan §2 invariant 8). A custom tool `bash` registered by
   `pi-ext-sandbox` sends the command to `sandbox-broker`, which runs it in a throwaway
   `skill-runner` container: non-root, `--network none` unless the active skill declares an allowlist,
   `/data/work/<userId>` mounted read-write at `/work`, 512 MB memory, 2 CPUs, 120 s timeout,
   `--read-only` root with `/tmp` tmpfs. Output streams back as `tool_execution_update`. The broker is
   the only container with the Docker socket (read-write; it is the trust boundary and has no other
   inbound path than the internal network and a shared secret header).
4. **Skills** live in `skills/<name>/SKILL.md` (+ `bin/`), loaded through `additionalSkillPaths`; the
   skill frontmatter may carry `sandbox: { network: none | [hosts], mounts: [] }`. The broker receives
   the skill name and applies its policy; unknown skill → `network: none`.
   **Implemented (task 2):** `network: none` (default) and `network: internet` (full egress on the
   bridge network `pa-skill-egress`, created by the broker on first use). Docker has no
   per-container egress allowlist, so `network: [hosts]` goes through an allowlisting proxy.
   **Updated (phase 7):** allowlists are enforced through the broker's HTTP CONNECT and HTTP forward
   proxy (port 3128) on an `internal: true` network, `pa-skill-proxy-only`. The runner has no route
   out of that network, so unsetting `HTTP_PROXY` does not help: the only reachable peer is the
   proxy. Each run gets a random token in the proxy URL userinfo; the proxy checks the target host
   against that run's list, answers 403 otherwise, and forgets the token when the run ends. An
   invalid or empty list still fails closed to `none`.
   Bind sources are host paths: compose passes `HOST_DATA_DIR` and `HOST_SKILLS_DIR` (docs/deploy.md).
5. **Subagents** (`pi-ext-subagents`): adapted from Pi's example (contract note §12). Children are
   `node <pi cli> --mode rpc --no-session`? No: children need their own JSONL under the parent's chat
   folder (plan §9), so children run `--mode rpc --session-dir /data/sessions/<userId>/<chatId>/sub/`
   with `PI_CODING_AGENT_DIR=/data/pi/<userId>`, `PSEUDO_URL`, `USER_ID`, `LITELLM_*` in env, and the
   pseudo and sandbox extensions loaded from their package paths (`-e packages/pi-ext-pseudo/src/cli.ts`
   style entry that reads config from env). Modes single, parallel (cap 4 concurrent, 8 queued),
   chain. stdout split on `\n` only. Child progress → `subagent.state`; child approvals bubble through
   the parent's gate (the child's `tool_call` approval is an `extension_ui_request` over RPC that the
   parent answers after asking the user).
6. **Automations**: `automations/<name>.yaml` `{ cron, agentId, prompt, deliver: chat | push | both }`,
   scheduled with `node-cron` 4.6.0 in `pa-server`; each run is a new chat under the "Automaatiot"
   topic (created on demand), titled normally. Push is phase 7; until then `deliver: push` logs.

## Task cards

| # | Task | Owner | Files | Acceptance |
|---|---|---|---|---|
| 1 | Agent profiles, loader, per-chat agent, approval gate, `approval.*` protocol handlers | Opus | `agents/`, `apps/server/src/agents.ts`, `approval.ts`, `registry.ts`, `bridge.ts` | tests: a `write` under `approval.always` blocks until `approval.respond`; denial reaches the model; timeout denies; args shown real; chat keeps its agent |
| 2 | `sandbox-broker` + `skill-runner` image + `pi-ext-sandbox` custom `bash` tool + skills loader | Opus | `services/sandbox-broker`, `infra/Dockerfile.broker`, `infra/Dockerfile.skill-runner`, `packages/pi-ext-sandbox`, `skills/` | Docker test: `curl https://example.com` from a `network: none` skill fails; a skill with allowlist reaches only its host; output streams |
| 3 | `pi-ext-subagents` with RPC children sharing masking | Opus, after 1 | `packages/pi-ext-subagents`, `packages/pi-ext-pseudo/src/cli.ts` | test: parallel run of 3 children shows live `subagent.state`; the children's JSONL and model requests hold no real value |
| 4 | Automations runner | Sonnet, after 1 | `automations/`, `apps/server/src/automations.ts` | test: a cron firing creates a chat under "Automaatiot" and the title job runs |
| 5 | Web: agent picker, approval card, subagent row, automations and agents in settings | Opus + UI review, after 1–4 | `apps/web`, `tests/e2e` | UI review pass; e2e approval flow |
