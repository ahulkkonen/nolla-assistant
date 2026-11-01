# Threat model

Date: 2026-10-31, on `main` at `986042b`. This note is the threat-model note of plan section 14
(`docs/plan.md`, "Security review"). It covers prompt injection through tool results, memory
poisoning, sandbox escape and token storage. It states what the system protects, against whom, how,
and what it does not protect. Each claim cites a file. The main sources are the security audit
(`docs/audits/2026-10-31-security.md`) and its fixes (`docs/decisions/phase-30-audits.md`).

Scope: one owner, one host. This note trusts the owner, the host, its Docker daemon and the Coolify
proxy.

## 1. Assets

- **Real personal values.** Names, identity codes (hetu), IBANs, phone numbers, addresses and emails
  of the owner and of third parties in the owner's chats, files, mail and calendar. They live in the
  vault (`/data/vault.db`), in `app.db` (claims, evidence quotes, topic names), in the memory files,
  in the work dir (`/data/work/<user>`) and on the owner's screen. Pi sessions hold only surrogates
  (plan §2, invariant 1).
- **The vault key** (`PSEUDO_VAULT_KEY`). It encrypts the vault (SQLCipher). The vault maps each
  surrogate to its real value. `pseudo-svc` and `backup` hold it (`infra/compose.yaml:52`, `:240`).
- **The OpenRouter keys** (`OPENROUTER_API_KEY`, `OPENROUTER_OPEN_API_KEY`). Only `litellm` holds
  them (`infra/compose.yaml:107-108`). `pa-server` holds `LITELLM_MASTER_KEY` only.
- **The Google token.** A refresh token for Calendar (full), Drive (read) and Gmail (read). It is a
  plain JSON file (mode 600) in the volume `mcp-workspace-data` (`docs/deploy.md:205`).
- **The session cookie and the passkeys.** A session token gives full access to the app. The
  password hash and the passkey credentials gate new sessions (`apps/server/src/auth/`).
- **The data volume and its backups.** `/data` holds every database, the sessions, the memory files
  and the work dir. Restic snapshots of `/data` and of the token volume go to an S3 bucket.

Every secret lives in the Coolify environment, never in the repository (plan §4). The security
audit found no secret in the tracked files or in the history.

## 2. Trust boundaries

- **Browser ↔ `pa-server`.** Public internet, HTTPS to the Coolify proxy, then port 3000 on
  Coolify's proxy network. `compose.yaml` publishes no port. The WebSocket and the data routes
  need the session cookie.
- **`pa-server` ↔ `pseudo-svc`.** Network `pseudo` (`internal: true`, no egress, these two only).
  Plain HTTP with no authentication. Real text goes in, surrogates come out.
- **`pa-server` ↔ LiteLLM ↔ OpenRouter.** Network `internal` with the master key. LiteLLM reaches
  Presidio on `presidio` (`internal: true`) and OpenRouter over HTTPS through `internal`.
- **`pa-server` ↔ `sandbox-broker` ↔ runner containers.** Network `internal` with `BROKER_TOKEN`.
  The broker holds the Docker socket. Runners get network `none`, `pa-skill-proxy-only` or
  `pa-skill-egress` (`services/sandbox-broker/src/index.ts:148`).
- **`pa-server` ↔ `mcp-workspace` ↔ Google.** Network `mcp` (these two only, with egress). Plain
  HTTP with no MCP-level authentication. `mcp-workspace` calls Google APIs over HTTPS.
- **`backup` ↔ S3.** Network `internal`. Restic encrypts each snapshot before upload.
- **Model output ↔ everything that renders or runs it.** No network. The reply text, the artifacts,
  the charts and the tool calls come from the model. The thread renders them, the artifact frame
  runs them, and Pi executes the tool calls after the guards.

## 3. Attackers

- **An attacker on the internet.** Reaches only `pa-server` through the proxy. The login endpoints
  are open: `POST /api/auth/password` and the passkey routes. The WebSocket refuses an upgrade
  without a session cookie or with a foreign `Origin` (`apps/server/src/http.ts:204-206`). Push
  subscribe needs a session. The CSP report route and the OAuth callback have no session but have
  a rate limit. A login flood locks password login for the owner too. The passkey has its own
  limits.
- **A prompt injection.** It arrives in a page that `fetch_url` reads, a web search result, a Gmail
  message, a Drive file, an attachment or any tool result. It reaches the model masked. Results of
  `web_search`, `fetch_url` and `chat_read` sit inside an untrusted block with a warning line
  (`untrusted` in `apps/server/src/search-tool.ts`). It can ask for tool calls, a profile change, a
  memory write, an artifact or a link. Section 4 lists what stops each one.
- **A compromised model provider or proxy** (OpenRouter, an upstream endpoint, or `litellm`). It
  sees the masked transcript, the system prompt, masked memory, images, voice audio (STT), dates
  and the context around each surrogate. It does not see the vault. It controls the reply, so it can
  do all that a prompt injection can do, also in an untainted chat. A compromised `litellm` also
  holds the OpenRouter keys. It cannot reach `pseudo-svc` (phase-30 item 6, compose smoke).
- **A malicious skill command in the sandbox.** It runs as uid 10001 in a throwaway container with
  the user's work dir mounted read-write. The work dir holds real values. With network `none` it
  has no channel out except its output, which `pi-ext-pseudo` masks.
- **A compromised dependency.** An npm package in `pa-server` runs with the rights of the process.
  It sees real values, the cookie secret, the master key and the broker token, and it has internet
  egress. A compromised `litellm`, Presidio or `mcp-workspace` image holds what its container holds.
- **A stolen backup.** Without `RESTIC_PASSWORD` the snapshots are ciphertext. With it, the thief
  gets `app.db`, the memory files, the work dir and the Google token in clear text. The vault copy
  stays SQLCipher and needs the vault key.
- **A person with the owner's device.** An open session gives full access: real values, the vault
  screen, the export and the approval cards. Section 5 accepts this.

## 4. Controls

- **Masked-only sessions, fail closed.** `packages/pi-ext-pseudo/src/index.ts` masks `input`,
  unmasks tool arguments in place at `tool_call`, masks `tool_result` (content, blocks,
  `structuredContent`, `details`) and scans the whole context at `context_with_system`. A sidecar
  failure drops the input, blocks the call, replaces the result or aborts the turn (`:72-75`,
  `:83-86`, `:120-123`, `:161-167`). Titles, topic names and claims extraction go through the mask
  (`apps/server/src/topics.ts`, `claims.ts`). In production `pa-server` refuses to start without
  `PSEUDO_URL` (`apps/server/src/config.ts:66`). Tests: `packages/pi-ext-pseudo/src/index.test.ts`
  ("sidecar down", "fails closed"), `tests/masked-only/src/masked-only.test.ts`,
  `apps/server/src/config.test.ts`, `apps/server/src/topics.test.ts`.
- **One egress URL with the ZDR guard.** Pi knows two providers, and both point at LiteLLM
  (`apps/server/src/pi/models.ts:238-246`). `infra/litellm/zdr_guard.py` allows listed aliases only
  and refuses unknown keys, `extra_body`, client plugins and `open/` without its key. Every `zdr/`
  alias carries `provider.zdr` and `data_collection: deny` (`infra/litellm.yaml`). The account key
  sits under an OpenRouter ZDR guardrail (`docs/deploy.md:28-34`). The Presidio backstop blocks a
  hetu, an IBAN or a card number and fails closed (`infra/litellm.yaml:122-136`). Test:
  `tests/egress/src/egress.test.ts` (Docker).
- **The approval gate.** `apps/server/src/approval.ts:69-120` holds a gated call until the owner
  answers a card with the real arguments, for at most 10 minutes. The profile gates `write`,
  `edit`, `bash` and the harness tools (`agents/assistant.yaml`). MCP writes always ask
  (`apps/server/src/pi/registry.ts:490-494`). The harness tools ask whatever the profile, the
  automation or the toggle says (`approval.ts:96-104`). A scheduled run denies every gated tool
  that its automation does not list. The per-chat toggle never covers MCP writes, `web_search`,
  `fetch_url` or the harness tools (`registry.ts:367-376`). It lives in memory, so a restart turns
  it off (`approval.ts:155-159`). The gate keys its records by tool and call id (`approval.ts:12`).
  `maskedArgs` refuses every call of a message whose call ids repeat or are empty
  (`search-tool.ts:85`). Card arguments go to the chat's room, never to the log.
  Tests: `apps/server/src/approval.test.ts`, `fetch-tool.test.ts` ("same id").
- **The harness cards.** `apps/server/src/harness.ts` shows a diff or the YAML. `profile_edit`
  writes only the prompt and mode files, so it cannot add a tool or remove a card. It refuses
  content with a vault entity or a sidecar span, and refuses when the sidecar is down.
  `automation_edit` cannot set `autoApprove`. A sha256 stamp refuses a file that changed after the
  card. Each write is a git commit, and the change takes effect at the next turn. Test:
  `apps/server/src/harness.test.ts`.
- **The taint flag.** `turnTaint` in `packages/pi-ext-memory/src/index.ts` taints a turn at its
  first tool outside `cleanTool` (only `memory` and a `read` inside the work dir, outside
  `files/`) or when the prompt has an attachment. The first tainted turn sets `chats.tainted`,
  which never resets (`registry.ts:194-195`, `phase-17-memory.md` status 12). It changes four
  things:
  - A harness card of a tainted turn carries a warning line (`approval.ts:113`).
  - A `memory` write of a tainted turn waits for the owner's review (phase-17 decision 30).
  - Claims extraction never activates a claim from a tainted chat. Evidence must quote a user
    message verbatim, and tool results and attachments are not in its input (phase-17 decisions 13,
    16, 21 and risk 3).
  - A page or a component of a tainted chat runs on masked text. "Näytä oikeat arvot" opens a
    confirmation first (phase-30 decision 14, `apps/server/src/artifacts.ts`).
  Tests: `packages/pi-ext-memory/src/index.test.ts`, `apps/server/src/claims.test.ts`,
  `apps/server/src/pi/registry.test.ts`, `tests/e2e/src/flows.spec.ts` ("tainted").
- **`fetch_url`.** `apps/server/src/fetch-tool.ts` sends one GET with no body, cookie or auth
  header. Only http and https, ports 80 and 443, no user info, at most 2,048 characters. The tool
  checks an IP literal against the private list. A name resolves through `publicLookup`, so the
  checked address is the connected one (`services/sandbox-broker/src/net.ts`). The private list
  holds private, loopback, link-local, multicast, reserved and the IPv6 ranges that embed IPv4.
  The tool checks each of at most 3 redirects again. It reads at most 2 MB, text types only. The
  guard asks when the restored URL differs from the masked one, or when no user message of the
  branch holds the URL as a whole token. An unattended chat blocks both. Test:
  `apps/server/src/fetch-tool.test.ts`.
- **The sandbox.** `containerConfig` (`services/sandbox-broker/src/index.ts:115-161`): uid 10001,
  read-only root, `CapDrop: ALL`, `no-new-privileges`, Docker's default seccomp profile without
  `symlink` and `symlinkat` (`seccomp.json`), 512 MiB with no swap, 2 CPUs, 256 pids, a 120 s cap,
  1 MiB of output. The network is `none` unless a skill declares one, and the registry never names a
  skill (`registry.ts:585-593`). Only the broker holds the Docker socket, behind a token of at
  least 32 characters with a constant-time compare. Test: `tests/sandbox/src/sandbox.test.ts`
  (Docker).
- **The path guard.** `apps/server/src/pi/guard.ts` and `realInside` in
  `packages/pi-ext-subagents/src/workspace.ts` resolve every existing part of a path, refuse a
  dangling symlink and hide `.trash`. Runners cannot create symlinks, so the guard has no race.
  Test: `packages/pi-ext-subagents/src/workspace.test.ts`.
- **Login.** Password: scrypt, 5 attempts per minute per IP and 10 per minute for all clients,
  counted before the verify, one verify at a time (`apps/server/src/auth/routes.ts:55-60`,
  `:184-189`). Passkey: user verification, 30 option requests per minute per IP, at most 10,000
  open challenges, 5 failed verifies per minute. The passkey is the recovery path, and
  `docs/deploy.md` (section 3) says to remove `AUTH_PASSWORD_HASH` after it works. Tests:
  `apps/server/src/server.test.ts` ("auth: ...").
- **Cookie, CSP and the artifact frame.** On https the cookie is `__Host-pa_session`, `HttpOnly`,
  `Secure` and `SameSite=Strict`. The database keeps only its sha256 (`auth/session.ts`).
  The app CSP has `script-src 'self'`, `img-src 'self' data: blob:` and `frame-ancestors 'none'`
  (`apps/server/src/http.ts:23-36`), so a Markdown image cannot send data out. Artifacts run in a
  frame with `sandbox="allow-scripts"` on an opaque origin under `SANDBOX_CSP`, which starts with
  `default-src 'none'` (`packages/protocol/src/index.ts`). Tests: `apps/server/src/csp.test.ts`,
  `server.test.ts` ("__Host-").
- **Backups.** `infra/backup/db-copy.sh` writes consistent copies of `app.db` and `vault.db`, and
  restic snapshots them hourly and all of `/data` nightly, encrypted with `RESTIC_PASSWORD`.
  `scripts/restore.sh` refuses a database that fails `PRAGMA integrity_check`. The backup service
  holds the vault key for the vault copy. Phase 30 records this as a trust decision ("Left as they
  are in batch A"). Test: `scripts/restore-drill.sh`.
- **Supply chain.** Exact pins (`.npmrc`, `savePrefix: ''`), `minimumReleaseAge: 10080` with
  `minimumReleaseAgeStrict`, and `strictDepBuilds` with an `allowBuilds` list
  (`pnpm-workspace.yaml`). CI installs with `--frozen-lockfile`. Python packages are hash-locked
  (`services/pseudo-svc/requirements.lock`). Every base image and compose image has a digest pin.
  `PI_OFFLINE` stops Pi's install ping. Record: `docs/audits/2026-10-31-dependencies.md` (verdict
  clean, no malicious package).

## 5. Residual risks

- **Images and voice audio reach the model unmasked.** The vault has no image masking
  (`docs/decisions/phase-3.md`, known gaps), and STT needs the audio. Both go to ZDR endpoints, and
  ZDR for STT rests on the account guardrail only (`infra/litellm.yaml:66-68`). Closes it: local
  redaction of images and a local Whisper (plan §15, deferred).
- **A web search query reaches Exa unmasked when it names no vault entity.** A real value that the
  vault does not know gets no card. An approved entity query sends real values. Exa is outside ZDR
  (`phase-14-search.md`, risks 1 and 4). Closes it: a direct search backend with ZDR terms.
- **Artifact code can send real values out.** No CSP directive stops a frame that navigates
  itself. In a tainted chat this needs the owner's "Näytä oikeat arvot" and its confirmation
  (phase-30 decision 14). In an untainted chat an opened page runs on restored text, so it trusts
  the model and the provider. Closes it: masked artifacts in every chat.
- **Markdown links can carry real values.** The thread restores a reply before it renders links,
  so a click sends the restored URL (phase-30, "Left as they are in decision 14"). Closes it: links
  from the masked text, or the full URL shown before the navigation.
- **Inference from context.** A surrogate keeps the gender, inflection class and vowel harmony of
  the real name (`phase-12-pseudo.md` decision 3). Dates, places outside addresses, ages, jobs and
  events pass as written. A rare combination can point to one person. This is pseudonymization,
  not anonymization. The owner controls what the chat holds.
- **`pseudo-svc` has no authentication.** Code that runs in `pa-server` can call `/unmask` or list
  the vault. Accepted: the network `pseudo` admits `pa-server` only, and `pa-server` sees real
  values anyway. Closes it: a per-request token and a narrower API.
- **The backup container holds the vault key**, with `RESTIC_PASSWORD` and the S3 keys. A
  compromise of it reveals every snapshot and the vault. Accepted for consistent vault copies
  (phase 30). Closes it: a vault copy that `pseudo-svc` writes itself, so the key stays there.
- **The owner's device is trusted.** A session lasts 30 days and each use extends it, with no
  absolute limit (`apps/server/src/auth/session.ts:13-14`). Revoke-all on another device ends it.
  Closes it: an absolute session age and a fresh login for the export and the vault screen.
- **Detection recall is below 1** (`tests/pii/last-run.json`, 559 texts). Names 0.991 (423 of 427):
  - Vault-known names: 1.0 (149 of 149).
  - First-sight names: 0.986 (274 of 278). The misses are two lone lower-case surnames that are
    also ordinary words (`hämäläistä`, `lahtiseksi`) and two nicknames (`Late`, `Pirkkis`).

  Addresses 1.0 (86 of 86), plates 0.714 (no gate; plates without a context word). Codes, emails,
  phones and postcodes 1.0. A missed name reaches the model as written. The backstop checks only
  hetu, IBAN and card numbers. A name or a nickname in the vault is masked in every later message
  (`POST /vault/seed`), but the vault screen has no action to add one yet. Closes it: an add
  action on the vault screen.
- **Transitive advisories.** `undici` 8.10.2 inside Pi 1.4.0 (4 high) and `body-parser` 2.3.0
  through the MCP SDK (1 high). Pi's `undici` talks only to LiteLLM and `mcp-workspace`, and the
  SDK's express server never runs. Closes it: overrides or the next Pi bump, once the fixed releases
  are 7 days old (phase 30, "Left as they are").
- **Other open items** from the security audit, nice-to-have list, still in the code:
  - Attachment text joins the user message (`apps/server/src/bridge/turns.ts:414`), so a URL in an
    untrusted PDF runs `fetch_url` with no card. Only an exact URL matches: a beacon, not a channel.
  - A page on a sibling subdomain is same-site, so `SameSite=Strict` does not stop its POST to
    `/api/`, and no `Origin` check runs. Deploy on a domain with no untrusted sibling hosts.
  - The broker API and proxy listen on `0.0.0.0`, and `pa-skill-egress` has no filter. No skill
    uses them today. `bash` has no size limit on the work dir.
  - The owner's Google address reaches the model in the MCP tool schemas (decision 0005).
  - The full export uses AES-256-CBC with no MAC (`apps/server/src/zip.ts`, `phase-15-admin.md`).
- **Limits of the design.** Runners share the host kernel, and the broker's Docker socket gives
  root on the host (micro-VMs deferred, plan §15). `pa-server` can reach any public host
  (`fetch_url`, phase-25 risks). The stack encrypts only `vault.db` at rest. Disk encryption of the
  host is the owner's choice.

## 6. What a reader can verify

- Audits: `docs/audits/2026-10-31-security.md`, `docs/audits/2026-10-31-architecture.md`,
  `docs/audits/2026-10-31-dependencies.md`. Fixes and accepted items:
  `docs/decisions/phase-30-audits.md`.
- Masking: `packages/pi-ext-pseudo/src/index.test.ts`, `tests/masked-only/src/masked-only.test.ts`
  (in CI), `tests/pii/` (`last-run.json`, local), `tests/contract/src/hooks.test.ts`.
- Egress: `tests/egress/src/egress.test.ts` (Docker).
- Gate, harness and guards: `apps/server/src/approval.test.ts`, `harness.test.ts`,
  `search-tool.test.ts`, `fetch-tool.test.ts`, `policy.test.ts`, `mcp.test.ts`, `tests/mcp/`.
- Taint and memory: `packages/pi-ext-memory/src/index.test.ts`, `apps/server/src/claims.test.ts`,
  `apps/server/src/artifacts.test.ts`, `tests/e2e/src/flows.spec.ts`.
- Sandbox and files: `tests/sandbox/src/sandbox.test.ts` (Docker),
  `packages/pi-ext-subagents/src/workspace.test.ts`, `apps/server/src/tree.test.ts`,
  `apps/server/src/files.test.ts`.
- Auth and headers: `apps/server/src/server.test.ts`, `csp.test.ts`, `config.test.ts`,
  `push.test.ts`.
- Backups: `scripts/restore-drill.sh` (local).
