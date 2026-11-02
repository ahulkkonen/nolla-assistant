# Phase 32: README, media and threat model

Date: 2026-10-31. Follows phase 31 (`phase-31-publication.md`).

## Decisions

1. **Two READMEs.** `README.md` is the short form for a reader with thirty seconds: byline, two
   sentences, the masking pair, the streaming GIF, bullets with proof links, the diagram, the run
   commands. `docs/overview.md` is the long form with each claim and its proof, the tour and the
   test table. The operator content moved to `docs/development.md`.
2. **Media under `docs/media/`.** Twelve files at first (21 now), about 560 KB, cropped to the feature at native
   pixels, never upscaled. Synthetic names only; no identity code in any shot. The GIF comes from a
   screenshot loop and ffmpeg (palette, 12 fps), with a browser-side route that paces the fake
   model's deltas.
3. **Review.** The README went through a blind two-role review (recruiter and senior engineer, then
   a fact check of every number, path, command and claim) in two rounds; round 1 found five wrong
   facts and a broken badge, round 2 one rounding error. The short form was written after both.
4. **Threat model.** `docs/threat-model.md`, the note that plan §14 asked for. `docs/plan.md` got
   an "As built" section that lists where the built system differs from the plan text.
5. **Name: `nolla-assistant`.** Nolla is Finnish for zero: zero personal data reaches the model, zero
   data retention. The user chose it on 2026-10-31 from proposals by a Finnish-native designer agent,
   Gemini 4 Argon and Grok 4.7 (through the stack's own LiteLLM). The H1 is "Nolla Assistant"; the in-app
   agent keeps the name Avustaja. The CI badge points at `ahulkkonen/nolla-assistant`.

6. **Hero example and social preview (2026-11-01).** The hero pair shows a calendar event through
   the MCP approval gate (`masking-action.png`, `masking-action-model.png`): the reminder example of
   the first version showed no tool at work. The shot runs through the fake Workspace MCP server of
   `tests/mcp`, so the e2e fixture got an `mcp: true` option and `flows.spec.ts` a flow that checks
   the card and the calendar get the real names while no model request does. Tool rows and approval
   cards show an MCP tool without its `mcp__<server>__` prefix (`toolLabel` in `apps/web/src/thread.ts`).
   The social preview is variant C of three (Bricolage Grotesque wordmark, the three zeros, the tool
   row and reply at 1.7x). The tagline says "personal
   data", not "real names", because names are one of eight masked kinds; the recall numbers that
   qualify the word "zero" are in `docs/threat-model.md` section 5.

## Status

Done 2026-10-31. The README was rewritten later: banner first, no H1, plain English.

Follow-ups the threat model lists: a URL inside an attached file
counts as written by the user, so `fetch_url` skips the card (`bridge/turns.ts` joins attachment
text to the message); no `Origin` check on non-GET routes; the broker listens on all interfaces; no
size limit on the work dir; sessions have no absolute expiry; the full export has no MAC.

Phase 35 (`phase-35-security-fixes.md`) fixed items 1, 2, 5 and 6. Items 3 and 4 stay as they are:

- Item 3, the broker listens on all interfaces. The broker must listen on the container's
  interfaces, because `pa-server` reaches it over the compose network. The compose network and
  `BROKER_TOKEN` (at least 32 characters, constant-time compare) are the fence.
- Item 4, no size limit on the work dir. Every `bash` call needs the owner's approval card
  (`approval.always` in `agents/assistant.yaml`), the per-chat toggle is in memory only, and no
  skill is vendored. A runaway command fills the disk only after the owner approves it. The 10 GB
  quota covers uploads and Pi writes (`phase-11-files.md`, decision 7). A limit needs a
  size-limited volume or a `du` after each run. Closes it: a size-limited `/work` volume.
