# Phase 6 — Integrations via MCP

Gate (plan §13): creating a calendar event requires approval and sends real values; a fetched
event with a new attendee creates a vault entity and the session stays masked.

**Status 2026-10-25:** gate met against a fake Google Workspace MCP server (`tests/mcp`, 14 tests:
approval with real values, denial, new attendee masked and vaulted, masked-only, tool allowlist,
error path, OAuth proxy routes). User steps open: Google OAuth client, consent flow, first real
calendar call (manual drill in `0005-mcp-integrations.md`).

## Decisions

See `0005-mcp-integrations.md` Decision section. Summary: `taylorwilsdon/google_workspace_mcp`
2.1.0 pinned by digest, streamable HTTP, single-user mode, `--tool-tier core --permissions
calendar:full drive:readonly gmail:readonly`, on its own `mcp` Docker network with `pa-server` only;
tokens in the `mcp-workspace-data` volume (restic nightly, restore with `restore.sh mcp`);
`infra/mcp.yaml` allowlists 8 tools with `manage_event` as the only write; Pi
`createMcpExtension` with `exposure: 'hidden'` and per-tool `direct`, codemode off; write tools are
added to the chat's `approval.always` and cannot be removed by `approval.never`; the user's own
address is allowlisted in the vault from `SELF_EMAIL`; `mcp-files` stays out until a server is
chosen.
