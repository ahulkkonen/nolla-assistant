# 0005 — MCP integrations (phase 6)

## Context

Phase 6 connects calendar, drive and mail through MCP. The plan sets these requirements:

- Section 4: `mcp-workspace` runs `taylorwilsdon/google_workspace_mcp`, pinned, about 200 MB, streamable HTTP, single-user OAuth mode, not exposed. `mcp-files` runs either `cbcoutinho/nextcloud-mcp-server` or `Softeria/ms-365-mcp-server`, only the one the user uses.
- Section 6: `tool_result` masks `content` and `structuredContent`. `tool_call` unmasks the arguments and is the approval gate.
- Section 10: servers register through Pi's `createMcpExtension()`. A per-server tool allowlist in `infra/mcp.yaml` trims the surface. Writes are in every agent's `approval.always`. `pa-server` proxies Google's OAuth redirect, so the PWA origin is the only public origin. Tokens live under `/data/mcp/<server>/`, in backups, encrypted at rest. Calendar and mail results are the main source of third-party names, so `tool_result` masking is on the critical path.
- Section 13, phase 6 gate: creating a calendar event requires approval and sends real values. A fetched event with a new attendee creates a vault entity, and the session stays masked.
- Section 15: read the licence of the MS 365 MCP server before use.
- Decision 0001 section 10: the Pi 1.3.0 MCP config shape, tool names `mcp__<server>__<tool>`, default exposure `codemode`.
- Decision 0002: every pinned image, release and package must be at least 7 days old. On 2026-10-25 that means published on or before 2026-10-18.

## Findings

### 1. `taylorwilsdon/google_workspace_mcp`

**Version, licence, pin.** The licence is MIT (GitHub API `license.spdx_id: "MIT"`, `LICENSE` "Copyright (c) 2025 Taylor Wilsdon", image label `org.opencontainers.image.licenses: MIT`). Releases from `https://api.github.com/repos/taylorwilsdon/google_workspace_mcp/releases`:

| Tag | Published | Age on 2026-10-25 | Status |
| --- | --- | --- | --- |
| `v2.2.0` | 2026-10-23 | 2 days | Too young |
| `v2.1.2` | 2026-10-21 | 4 days | Too young. Eligible after 2026-10-28. Adds a Host allowlist for HTTP deployments |
| `v2.1.1` | 2026-10-20 | 5 days | Too young. Eligible after 2026-10-27. Fixes duplicate Gmail sends (not relevant with `gmail:readonly`) |
| `v2.1.0` | 2026-10-09 | 16 days | **Chosen** |

- The project publishes images on GHCR. Tags include `2.1.0`, `2.1`, `2.1.1`, `2.1.2`, `2.2.0`, `latest` (registry `tags/list`).
- `ghcr.io/taylorwilsdon/google_workspace_mcp:2.1.0` = `sha256:866733722037ce39de0b4fa6db15c88578876f00eda448799a489d463f334aa3`. This is the multi-arch OCI index (amd64 and arm64), read from `Docker-Content-Digest`. The image config says `created: 2026-10-09T13:08:17Z`, `org.opencontainers.image.version: 2.1.0`, revision `789730452b9c5452b2c8d348cf005d196c12ba4e`, `User: app` (uid 1000).
- `pyproject.toml` at the tag says `version = "2.1.0"`, `fastmcp>=4.0.10`, `mcp>=2.2.0`. The server reports `serverInfo.version: "4.0.10"` (the FastMCP version).
- Building from source is not needed. The repo `Dockerfile` is `python:3.11-slim` plus `uv sync --frozen --no-dev --extra disk --extra otel --extra valkey`.

**Streamable HTTP.** `main.py` has `--transport {stdio,streamable-http}` (env `WORKSPACE_MCP_TRANSPORT`). The port comes from `PORT` or `WORKSPACE_MCP_PORT` (default 8000). The host comes from `WORKSPACE_MCP_HOST`. Without OAuth 2.1 the server binds `127.0.0.1` unless `WORKSPACE_MCP_HOST` is set: "Legacy streamable-http mode has no MCP-level auth provider; binding to 127.0.0.1 by default. Set WORKSPACE_MCP_HOST explicitly only for trusted networks". The MCP endpoint is `/mcp`. Health is `GET /health` (`{"status":"healthy","service":"workspace-mcp","version":"2.1.0","transport":"streamable-http"}`).

**Single-user mode.** The flag is `--single-user` ("bypass session mapping and use any credentials from the credentials directory"). It sets `MCP_SINGLE_USER_MODE=1`. Single-user mode and OAuth 2.1 exclude each other: `main.py` exits with "Single-user mode is incompatible with OAuth 2.1 mode ... Choose one: --single-user OR MCP_ENABLE_OAUTH21=true". The plan's "OAuth 2.1, single-user mode" is therefore not possible. Single-user mode has no MCP-level auth. Network isolation must protect the endpoint (see Decision).

- Credentials: `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` (or `GOOGLE_CLIENT_SECRET_PATH`).
- `USER_GOOGLE_EMAIL` gives the default account. With it, the server drops `user_google_email` from `required` and injects it as `default` in every tool schema (observed: `{"type":"string","description":"The user's Google email address. Required.","default":"test@example.com"}`). The server instructions also start with `Connected Google account: <email>`.
- Redirect URI: `GOOGLE_OAUTH_REDIRECT_URI`, else `<WORKSPACE_MCP_BASE_URI>:<port>/oauth2callback` (`auth/oauth_config.py:_get_redirect_uri`). In streamable HTTP mode the callback route `GET /oauth2callback` is on the same port as `/mcp` (`core/server.py:533`).
- Token storage: `WORKSPACE_MCP_CREDENTIALS_DIR`, else `GOOGLE_MCP_CREDENTIALS_DIR`, else `~/.google_workspace_mcp/credentials`. `LocalDirectoryCredentialStore.store_credential` writes plain JSON with mode `0o600`. The file holds `token`, `refresh_token`, `client_id` and `client_secret`. There is no app-level encryption.
- Consent flow: any Google tool call without stored credentials returns `isError: true` with the text `**ACTION REQUIRED: Google Authentication Needed ...** ... Authorization URL: https://accounts.google.com/o/oauth2/auth?...`. The tool `start_google_auth` exists but only in the `complete` tier. The server opens a browser only in stdio mode. So a headless flow is: get the URL, open it in the user's browser, let Google redirect to the configured redirect URI.

**Observed auth URL** (dummy client, `--permissions calendar:full drive:readonly gmail:readonly`): `redirect_uri=https://pa.example.fi/api/oauth/google/callback` exactly as configured, `state=468333f6488065102b1bc1fd8e85cdce`, `code_challenge_method=S256`, `access_type=offline`, `prompt=consent`, `login_hint=<USER_GOOGLE_EMAIL>`. Scopes: `calendar`, `calendar.events`, `calendar.readonly`, `drive.readonly`, `gmail.readonly`, `userinfo.email`, `userinfo.profile`, `openid`.

**Tool groups.** `SERVICE_MODULES` in `main.py`: `gmail`, `drive`, `calendar`, `docs`, `sheets`, `chat`, `forms`, `slides`, `tasks`, `contacts`, `search`, `appscript`. Filters: `--tools <service>...`, `--tool-tier {core,extended,complete}`, `--read-only`, `--permissions service:level...`, `--disabled-tools <name>...`. `--permissions` and `--tools` exclude each other. `--permissions` selects the services. Gmail levels are `readonly, organize, drafts, send, full`. Other services have `readonly, full`.

**Read-only Gmail.** Yes. `gmail:readonly` requests only `gmail.readonly` (`auth/permissions.py`) and drops `send_gmail_message`.

**Observed tool list** (image 2.1.0, `--single-user --tool-tier core --permissions calendar:full drive:readonly gmail:readonly --disabled-tools get_drive_file_download_url get_drive_shareable_link`):

| Tool | Annotations | Use |
| --- | --- | --- |
| `list_calendars` | readOnly | List calendars |
| `get_events` | readOnly | List events, read one event (`event_id`), search (`query`), `detailed` adds description, location, organizer, attendees |
| `manage_event` | destructive | `action`: `create`, `update`, `delete`, `rsvp`. There is no separate `create_event` |
| `search_drive_files` | readOnly | Search Drive (`query` required) |
| `get_drive_file_content` | readOnly | Read a file (`file_id`) |
| `search_gmail_messages` | readOnly | Search mail (`query`, `include_headers` adds Subject, From, Date) |
| `get_gmail_message_content` | readOnly | Read one message |
| `get_gmail_messages_content_batch` | readOnly | Read several messages |

The plan's example names (`calendar.list_events`, `calendar.create_event`, `drive.search`, `drive.read_file`) do not exist. The real names are above.

**Outbound network.** README: "By default, this server sends no data anywhere except Google's APIs ... There is no usage reporting, analytics, license server, or SaaS dependency outside optional OTel support". The hostnames in the non-test Python code are Google hosts (`www.googleapis.com`, `oauth2.googleapis.com`, `accounts.google.com`, `openidconnect.googleapis.com`, …), schema namespaces and documentation links. OTel stays off unless an `OTEL_*` endpoint is set. Docker has no per-container egress allowlist, so the container gets general egress (the same limit as phase-5 decision 4).

**Runtime check.** The image runs with `--read-only` root, `--tmpfs /tmp`, `--tmpfs /home/app:uid=1000,gid=1000` and a credentials volume owned by uid 1000. Without the `/home/app` tmpfs it logs "CRITICAL: Failed to set up file logging ... Read-only file system". With a root-owned volume it exits: "Credentials directory permission check failed".

### 2. Pi 1.3.0 MCP client side

Sources: `pi-src/package/docs/mcp.md`, `@earendil-works/pi-coding-agent@1.3.0` `dist/extensions/mcp/{index,tools,config,runtime}.js`, `dist/core/agent-session.js`, `@earendil-works/pi-agent-core@1.3.0` `dist/agent-loop.js`, `@earendil-works/pi-mcp@1.3.0` (MIT, "does not depend on the official MCP SDK").

**Config location and shape.** Defaults are `<agentDir>/mcp.json` and the trusted `<cwd>/.pi/mcp.json`, root key `mcpServers` (`docs/mcp.md:32`). `createMcpExtension({ loadConfig })` replaces file loading with a function that returns `{ servers: McpServerEntry[], autoEnableCodemode?, errors }` (decision 0001 section 10). The registry already sets `noExtensions: true`, so MCP loads only if `createMcpExtension()` is in `extensionFactories` (`docs/mcp.md:272`).

**Exposure.** `docs/mcp.md:193-198`:

- `codemode` (default): "Callable from codemode scripts, but neither declared to the model nor listed in the codemode description."
- `deferred`: "Not declared until `tool_search` loads a match."
- `direct`: "Declared to the model like a built-in tool and also callable from codemode."
- `hidden`: "Registered but unreachable."

`toolExposure` overrides single tools: "Exact names win over patterns" (`docs/mcp.md:206`). With `codemode`, the model writes scripts that receive "the complete MCP `CallToolResult`" (`docs/mcp.md:234`). That adds one more layer to mask and review. `direct` keeps one model tool call per MCP call, and the approval card shows plain arguments.

**Per-server allowlist.** Two mechanisms exist, and both work:

1. `toolExposure` with server `exposure: "hidden"` and `"direct"` for each allowed tool. The runtime refuses hidden tools at call time: `MCP tool "<server>/<tool>" is no longer available.` (`index.js:327`).
2. The host `tools` option of `createAgentSession`. `agent-session.js:193-197`: the allowlist filters MCP tools when "it is empty (`--no-tools`) or names an MCP tool (`mcp__*`)". A named MCP tool is also activated: "Naming or matching a tool activates it even when it is not active by default" (`agent-session.js:2900`). This matches decision 0001 section 16: every extension tool must be in `tools`.

**Headers and shared secret.** `headers: Record<string,string>`, values may use `${NAME}` or a whole-value `!command` (`docs/mcp.md:81`). OAuth applies only "to HTTP servers without an `Authorization` header" (`docs/mcp.md:133`). The workspace server in single-user mode does not check any header (finding 1), so a secret header gives no protection there.

**Long-running calls.** `timeout` is per request in seconds, default 60, and "Progress notifications reset it" (`docs/mcp.md:68`). Progress becomes `onUpdate({ content: [{ type: "text", text }] })` (`tools.js:260-264`), which Pi emits as `tool_execution_update`. That text goes to the UI, not to the model, and the pseudo extension does not mask it. "Tool calls are not retried because the server may already have performed them" (`docs/mcp.md:248`).

**Errors.**

- MCP `isError: true` becomes a Pi error result. If the result has no text, Pi adds `MCP tool <server>/<tool> returned an error` (`tools.js:206-208`).
- A thrown error (timeout, disconnect, `MCP server "x" is still starting.`) is caught in `executePreparedToolCall` and becomes `createErrorToolResult(message)` with `isError: true` (`agent-loop.js:583-592`). `tool_result` still fires for it.
- If a `tool_result` handler throws, the result becomes an error result with the handler's message (`agent-loop.js:625-628`). The pseudo extension already returns `PSEUDO_DOWN` with `isError: true` on sidecar failure.

**`structuredContent`.** Yes, always. `convertMcpResult` sets `structuredContent` to the whole `CallToolResult` without `_meta`: `{ content: [...as sent by the server], structuredContent?: <server structured content>, isError? }` (`tools.js:210-216`). `details` is `{ server, tool, fullOutputPath? }`. Text over 20 KB reaches the model truncated in the middle, and Pi writes the full text to a temp file (`tools.js:135-155`). That temp file holds real values.

**Verified with Pi's own code.** A spike script ran `McpClient` + `StreamableHttpTransport` from `pi-mcp@1.3.0` and `convertMcpResult` from `pi-coding-agent@1.3.0` against the fake server (question 7). One `get_events` result reached the `tool_result` shape with the same event text three times: `content[0].text`, `structuredContent.content[0].text` and `structuredContent.structuredContent.result`.

### 3. OAuth redirect proxy

- Callback format: `GET <GOOGLE_OAUTH_REDIRECT_URI>?state=<32 hex>&code=<code>&scope=...`. The internal target is `http://mcp-workspace:8000/oauth2callback`.
- `state` is validated. `start_auth_flow` stores `os.urandom(16).hex()` with the PKCE `code_verifier` for 600 s (`oauth21_session_store.py:465-507`). `validate_and_consume_oauth_state` pops it (single use) and raises "Invalid or expired OAuth state parameter" for an unknown state. Observed: `GET /oauth2callback?state=deadbeef&code=fake` returns 500 with that message, and the log says "SECURITY: OAuth callback received unknown or expired state". The state store is in memory, so a container restart during consent breaks that flow.
- PKCE: the server holds the verifier. The proxy only forwards the query string.
- Token exchange: `handle_auth_callback` uses `str(request.url)` only to parse `code` and `state`. It uses the configured redirect URI for the exchange (`google_auth.py:822-834`). The internal hop is plain HTTP, so set `OAUTHLIB_INSECURE_TRANSPORT=1` (the code sets it by itself if unset). UNVERIFIED: a full exchange with a real Google client. Confirm with the manual drill in the test plan.
- Host header: version 2.1.0 has no Host allowlist. A request with `Host: mcp-workspace:8000` to `/mcp` returned 200. Version 2.1.2 adds a Host allowlist. Re-check this when the pin moves.
- Error pages escape input: `?error=<script>…` renders `&lt;script&gt;` (`oauth_responses.py` uses `html.escape`). The success page shows the account email.
- Cookies: the pa-server session cookie is `sameSite: 'strict'` (`apps/server/src/auth/session.ts:14`). The browser does not send it on the redirect from `accounts.google.com`. The callback route therefore cannot use `requireUser`. The single-use state with PKCE is the CSRF protection.

### 4. Masking on the critical path: event shapes

All workspace tools return a `str`. FastMCP declares `outputSchema: {"properties":{"result":{"type":"string"}},"required":["result"],"type":"object","x-fastmcp-wrap-result":true}` for all 8 tools (observed). So each successful result is text in `content[0].text` and the same text in `structuredContent.result`. UNVERIFIED on a successful real call (no Google credentials). The schema flag `x-fastmcp-wrap-result` says the wrap happens. Error results have no `structuredContent` (observed).

`get_events` text (`gcalendar/calendar_tools.py:426-660`, `gcalendar/calendar_helpers.py:205-385`):

- Basic line: `- "<summary>" (Starts: <start>, Ends: <end>) Meeting: <link> ID: <id> | Link: <htmlLink>`. Header: `Successfully retrieved N events from calendar '<id>' for <user email>:`.
- `detailed=true` adds one line per field: `Description: <free text>`, `Location: <free text>`, `Color ID`, `Recurrence`, `Event Type`, `Status`, `Creator: <displayName> <<email>>`, `Organizer: <displayName> <<email>>`, `Meeting Link`, `Attendees: <email>, <email>`, `Attendee Details: <email>: <responseStatus> (organizer) (optional) (note: "<RSVP comment>")`, and optional `Attachments: <title>, File URL, File ID`.
- Attendee display names are not in the output. Attendees appear only as email addresses. A Finnish address such as `aino.hakkinen@example.fi` carries the name in its local part.
- `htmlLink` has an `eid` parameter. In Google Calendar the value is base64 of the event id and the calendar id (often an email). UNVERIFIED for this server. Detectors do not decode base64.

Fields for `pseudo-svc` detectors: `summary`, `Description`, `Location`, `Creator`, `Organizer` (name and email), `Attendees` and `Attendee Details` (emails), RSVP `note`, attachment `title`, and the user's own email in the header line. `pseudo-svc` already has an `EMAIL` detector (`detect/codes.py:18`), so a new attendee address becomes an `EMAIL` entity. It is not linked to a `PERSON` entity.

`manage_event` create returns `Successfully created event '<summary>' for <user email>. Link: <htmlLink>` plus the saved times. Its `attendees` argument takes strings or objects (`{"email": ..., "displayName": ...}` passes through). `send_updates` defaults to `"all"`, so Google emails invitations to the attendees.

### 5. `mcp-files`

| Server | Licence | Auth | Cadence |
| --- | --- | --- | --- |
| `Softeria/ms-365-mcp-server` | MIT (GitHub API `spdx_id: "MIT"`) | README "three authentication methods": 1. Device Code Flow (default), 2. OAuth Authorization Code Flow (HTTP mode only, "**Requires** `Authorization: Bearer <token>` for all MCP requests"), 3. Bring Your Own Token (`MS365_MCP_OAUTH_TOKEN`, no refresh) | 33 releases from 2026-09-25 to 2026-10-25, latest `v0.171.0` 2026-10-22 |
| `cbcoutinho/nextcloud-mcp-server` | AGPL-3.0 (GitHub API `spdx_id: "AGPL-3.0"`) | App password or Login Flow v2 (plan section 10, not re-checked) | 25 releases from 2026-09-25 to 2026-10-25, latest `v0.201.2` 2026-10-24 |

Both release several times per week. A 7-day-old pin is always several releases behind. The section-15 item is closed: the MS 365 server is MIT.

### 6. `infra/mcp.yaml`

See the draft in Decision. `manage_event` is the only write. It covers create, update, delete and RSVP, so every action needs approval.

### 7. Test strategy without Google credentials

- `@modelcontextprotocol/sdk` is not in `pnpm-lock.yaml` as a package. It appears only as an optional peer of `@google/genai@2.21.0`.
- Registry (`https://registry.npmjs.org/@modelcontextprotocol%2Fsdk`): `latest` is `1.32.2` (2026-10-23, too young). `1.32.1` was published 2026-10-05T11:47:50Z (20 days). Licence MIT. Integrity `sha512-2DdE+SJDtzLEEWzY1ZjY7Q+VcPhcV1KisD3zI4u0XZyktsjHum1mwbMI+JaulUBi2OZk+KJAi2uPXzxichPkdw==`. It brings 17 runtime dependencies (`express`, `hono`, `@hono/node-server`, `ajv`, `jose`, …).
- A scratch install with the global `minimum-release-age=10080` resolved `@modelcontextprotocol/sdk@1.32.1` and `zod@4.1.12`.
- The fake server (about 70 lines) uses `McpServer` and `StreamableHTTPServerTransport`. It exposes `get_events` and `manage_event` with the same names, the same text format and the same `{ result }` structured wrap as the real server. Probed with Pi's client: `tools/list` returned both tools with `outputSchema`, `get_events` returned `content` and `structuredContent`, `manage_event` stored the arguments, and a request without the secret header returned 401.

## Decision

### Pin and run

- Image: `ghcr.io/taylorwilsdon/google_workspace_mcp:2.1.0@sha256:866733722037ce39de0b4fa6db15c88578876f00eda448799a489d463f334aa3`.
- Mode: single-user, legacy streamable HTTP, no OAuth 2.1. Section 10 of the plan changes from "OAuth 2.1, single-user mode" to "single-user mode (Google OAuth 2.0 with PKCE), no MCP-level auth, isolated network".
- `mcp-files` stays out of phase 6. Google Drive already comes from the workspace server. Add one file server only when the user names Nextcloud or Microsoft 365. Then pin a release at least 7 days old and write a new decision note.

The shipped code is in [`infra/compose.yaml`](../../infra/compose.yaml) (service `mcp-workspace`, network `mcp`, volume `mcp-workspace`), [`infra/mcp.yaml`](../../infra/mcp.yaml) (tool allowlist) and [`apps/server/src/integrations.ts`](../../apps/server/src/integrations.ts) (OAuth routes). The drafts in this record differed from that code and are removed.

The `mcp` network is the only access control for `/mcp`. Do not attach `sandbox-broker`, `skill-runner`, `litellm` or `pseudo-svc` to it. Do not mount `pa-data` into `mcp-workspace`.

New Coolify variables: `GOOGLE_ACCOUNT_EMAIL`, `PWA_HOST`. Register `https://<PWA_HOST>/api/oauth/google/callback` as an authorized redirect URI of a "Web application" OAuth client in Google Cloud. Enable the Calendar, Drive and Gmail APIs.

### `infra/mcp.yaml`

`pa-server` reads this file at startup and validates it with zod, as `agents.ts` does. For an agent with `tools.mcp: [workspace]`, the registry:

1. adds `mcp__workspace__<tool>` for each listed tool to the host `tools` option,
2. adds each `write: true` tool to `approval.always`,
3. passes the server to `createMcpExtension`.

### Pi MCP config

Place `createMcpExtension` in `extensionFactories` after `pathGuard`. Its position does not change the order of the pseudo and approval handlers, because they run on `tool_call` and `tool_result` for every tool. No header is set. A shared secret would not protect the single-user server (finding 2).

### OAuth routes in `pa-server`

- Do not forward cookies or the `Host` header. `fetch` sends `Host: mcp-workspace:8000`, which 2.1.0 accepts.
- Do not return the MCP server's HTML. It shows the account email and is not built for the PWA CSP. The 302 lands on the SPA. The SPA then calls the API with its own cookie.
- Do not log the query string. It holds the authorization code.
- `workspaceClient` uses `@earendil-works/pi-mcp@1.3.0`, which is already in the lockfile as a Pi dependency. Add it as a direct, exact dependency of `apps/server`.

### Approval and masking rules

- `mcp__workspace__manage_event` is in `approval.always` of every agent that sees `workspace`. The approval card shows the restored `action`, `summary`, `start_time`, `end_time`, `attendees`, `description`, `location` and `send_updates`.
- The pseudo `tool_result` handler stays as it is. It already masks `content`, `structuredContent` and `details` in one `/mask` call. The contract suite gets one new assertion: an MCP `tool_result` event carries `structuredContent.content` and `structuredContent.structuredContent`.
- The user's own Google address appears in every tool schema (`default`) and in every result header. Tool schemas do not pass through `/mask` or `/scan`. Add the address to the vault as an allowlisted `EMAIL` entity, so results and schemas show the same value. The other choice is to leave `USER_GOOGLE_EMAIL` unset and inject the address in `tool_call`. The user decides. The default is the allowlist.

### Test plan for the phase-6 gate

Pin `@modelcontextprotocol/sdk` `1.32.1` and `zod` `4.6.7` (already in the lockfile) as exact devDependencies of a new `tests/mcp` package. Put the fake server into the `tests/mcp` package. It already returns the real server's text format, the `{ result }` wrap and Finnish names (`Aino Häkkinen`, `aino.hakkinen@example.fi`, `Pekka Laaksonen`, `juha-pekka.nieminen@example.fi`, `Hämeenkatu 12, 33100 Tampere`). Its `GET /_created` returns the arguments of each `manage_event` call.

The test boots `pa-server` with the real `pseudo-svc` (as `tests/masked-only` does), `@nolla/fake-llm` and the fake server, with `infra/mcp.yaml` pointing at the fake.

1. **Write needs approval and sends real values.** The fake LLM calls `mcp__workspace__manage_event` with `action: create` and the surrogate of a known vault person as attendee. Assert that `approval.request` arrives and its `args` hold the real name and address. Assert that `/_created` is empty before `approval.respond`. Approve. Assert that `/_created` holds the real values and no surrogate. Repeat with a denial and assert that `/_created` stays empty.
2. **A new attendee becomes a vault entity.** Read the vault entity count. The fake LLM calls `mcp__workspace__get_events` with `detailed: true`. Assert that the vault holds a new `EMAIL` entity for `juha-pekka.nieminen@example.fi` and a `PERSON` entity for `Aino Häkkinen` (from the description).
3. **The session stays masked.** Run the masked-only grep over the session JSONL and the fake-LLM request log for every real value of the fake event. Check all three copies of the text in the `tool_result`. Assert zero hits.
4. **Allowlist.** Assert that the model request declares exactly the 8 `mcp__workspace__*` tools of the agent and no `codemode` tool.
5. **Errors.** Stop the fake server. Assert that a call returns `isError: true` and that the session continues.

Manual drill with real credentials (once, before phase 6 closes): connect Google through `/api/integrations/google/connect`, complete consent on a phone through the public origin, list today's events, and create one event without attendees after approval. This confirms the token exchange behind the proxy and the `structuredContent.result` wrap on a successful call.

## Consequences

- The plan's "OAuth 2.1, single-user mode" is not possible with this server. The `/mcp` endpoint has no authentication. Only the `mcp` Docker network protects it.
- The credentials file is plaintext JSON (mode 600) with the refresh token and client secret. Encryption at rest comes only from restic in backups. The live volume is not encrypted at app level. Section 10 of the plan overstates this.
- The volume must be owned by uid 1000 before the first start. Do it with a one-shot `chown` container in the deploy steps or in `scripts/restore.sh`.
- Calendar results identify attendees by email only. Masking depends on the `EMAIL` detector, and a masked address is not linked to the person's `PERSON` entity.
- MCP progress text (`tool_execution_update`) and `mcp.log` are not masked. They do not reach the model. Results over 20 KB leave a plaintext temp file in the pa-server `/tmp`.
- `manage_event` sends invitations by default (`send_updates: "all"`). The approval card must show it.
- Pin bumps: `v2.1.1` after 2026-10-27, `v2.1.2` (Host allowlist) after 2026-10-28. Each bump is its own PR with the contract suite and this test plan as the gate.
  Still on 2.1.0. Outcome not recorded.
- `mcp-files` stays out of phase 6. Both candidate servers release several times per week.

## Verified on

2026-10-25.

- GitHub REST API with curl: repository licences, release lists and dates for the three servers.
- GHCR registry API with curl: tag list, index digest and image config of `google_workspace_mcp:2.1.0`.
- Source of `google_workspace_mcp` at tag `v2.1.0` (codeload tarball), read with `awk` and `sed`.
- The pinned image ran in Docker 29.1.3 with a dummy OAuth client. Probed: `initialize`, `tools/list`, a `get_events` call without credentials, `/oauth2callback` with a bad state and an `error` parameter, and `Host: mcp-workspace:8000`. Re-run with `--read-only`, tmpfs and `--disabled-tools`.
- Pi 1.3.0 and pi-mcp 1.3.0 in the project `node_modules` and the unpacked Pi tarball, read with `sed` and `awk`.
- npm registry with curl for `@modelcontextprotocol/sdk`. The fake server ran on `@modelcontextprotocol/sdk@1.32.1` in the scratch directory and was probed with Pi's `McpClient` and `convertMcpResult`.
- UNVERIFIED: the token exchange with a real Google client behind the proxy, the `structuredContent.result` wrap on a successful real call, and the `eid` content. The manual drill confirms all three.
