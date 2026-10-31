# Phase 32: README, media and threat model

Date: 2026-10-31. Follows phase 31 (`phase-31-publication.md`).

## Decisions

1. **Two READMEs.** `README.md` is the short form for a reader with thirty seconds: byline, two
   sentences, the masking pair, the streaming GIF, bullets with proof links, the diagram, the run
   commands. `docs/overview.md` is the long form with each claim and its proof, the tour and the
   test table. The operator content moved to `docs/development.md`.
2. **Media under `docs/media/`.** Twelve files, about 560 KB, cropped to the feature at native
   pixels, never upscaled. Synthetic names only; no identity code in any shot. The GIF comes from a
   screenshot loop and ffmpeg (palette, 12 fps), with a browser-side route that paces the fake
   model's deltas.
3. **Review.** The README went through a blind two-role review (recruiter and senior engineer, then
   a fact check of every number, path, command and claim) in two rounds; round 1 found five wrong
   facts and a broken badge, round 2 one rounding error. The short form was written after both.
4. **Threat model.** `docs/threat-model.md`, the note that plan §14 asked for. `docs/plan.md` got
   an "As built" section that lists where the built system differs from the plan text.
5. **Name: `nolla-assistant`.** Nolla is Finnish for zero: zero real names reach the model, zero data
   retention. The user chose it on 2026-10-31 from proposals by a Finnish-native designer agent,
   Gemini 4 Argon and Grok 4.7 (through the stack's own LiteLLM). The H1 is "Nolla Assistant"; the in-app
   agent keeps the name Avustaja. The CI badge points at `ahulkkonen/nolla-assistant`.
   the CI badge line follows the name.

## Status

Done 2026-10-31. Follow-ups the threat model lists: a URL inside an attached file
counts as written by the user, so `fetch_url` skips the card (`bridge/turns.ts` joins attachment
text to the message); no `Origin` check on non-GET routes; the broker listens on all interfaces; no
size limit on the work dir; sessions have no absolute expiry; the full export has no MAC.
