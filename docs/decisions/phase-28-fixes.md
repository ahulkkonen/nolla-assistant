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

Done 2026-10-31 on branch `p28`.

1. `extract` in `apps/server/src/claims.ts` calls the hook once after its windows when at least one
   claim activated. This covers the sweep. The tool writes, the review, the update and the import
   already called it. `stale` changes only the confidence of a claim and does not call the hook.
   The weekly job covers it.
2. The row is a `DropdownMenuItem` under a separator. It navigates in `onCloseAutoFocus`, after the
   menu closed. Before that, the closing menu took the focus back from the heading. `openModes`
   (`ModesEditor.tsx`) sets the store screen `agents`; the router pushes `/agents`. Then it adds
   the hash `#tilat` to that history entry. `ModesSection` scrolls to the "Tilat" heading and
   focuses it when the hash is `#tilat`. The router compares only the path and the query, so the
   hash is no new route. The phone model sheet gets no row: the record names only the chip.
3. A sentence with N of 6 or less gets the class `conf-low`. Its anchor `conf-a` is an inline-block
   with its width, so the underline stops before the N. The legend lost the nine swatches. It
   shows "1 arvaus – 9 varma" in words, and at 390 px it now fits one 28 px row. The prompt
   example changed from 9 to 8, because 9 is now only for what the model verified in the chat. The
   e2e reply `CONFIDENCE_REPLY` uses the levels 9, 7 and 3, so that the hover tests keep two
   hidden N and one sentence shows the underline.
4. The store key is `pa.pseudonyms`. `loadOn` and `saveOn` in `store.ts` now hold the
   localStorage read and write for this switch and for "Näytä luvut". With the marks off, the real
   value is a plain span with the hint as its `title` attribute: no tab stop and no tooltip
   component. A touch screen has no hover, so on a phone the user turns the marks on to check a
   value. "Näytä mitä malli näki" (the setting or the eye button of a message) still shows the
   marks, because the surrogates must stay distinct from the real text. The `chat-annotated`
   screen first checks that no mark shows by default, then turns the setting on in Asetukset.
