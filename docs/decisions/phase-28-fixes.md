# Phase 28: fixes before publication

Date: 2026-10-31. Follows phase 27. The user chose these in a written discussion. Phases 29 to 32
(evals, audits, publication, README) follow.

## Decisions

1. **MEMORY.md regenerates when a claim becomes active.** Today the file is regenerated only by the
   weekly job, after a review action and by the "Koosta" button. A claim that the extraction
   activates (`activatedBy: 'auto'`) or that a tool activates does not regenerate the file, so the
   file stayed empty with three active claims. Every path that sets a claim to `active` or closes
   one calls the same `onProfileChange` hook that the review already calls.
2. **The Tila chip links to the mode editor.** The mode editor exists (Settings › Agentit › Tilat,
   phase 23) but the chip does not point to it. The chip's popover gets a last row "Muokkaa
   tiloja…" that opens the editor through the router.
3. **Luottamus asks for a relative scale.** The prompt in `agents/modes/confidence.md` tells the
   model to use the whole scale: most sentences of ordinary prose sit between 5 and 7, at most one
   sentence in three gets 8 or 9, and 9 is only for what the model could verify in this chat. The
   renderer changes with it: a sentence with N at most 6 gets a dotted underline in the muted colour
   and its number is visible; a sentence with N of 7 or more is plain. The colour shading goes. The
   legend and "Näytä luvut" stay for the plain sentences.
4. **Pseudonymization marks off by default.** The blue marks on restored real values get a setting
   "Näytä pseudonymoinnit" in Settings, stored per browser (`localStorage`), default off. The
   hover title stays on the restored value when marks are off, so the user can still check one.

## Status

Open.
