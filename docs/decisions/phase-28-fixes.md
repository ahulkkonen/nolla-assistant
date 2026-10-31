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
2. The row is in the chip's menu (a `DropdownMenuItem` under a separator) and in the phone sheet
   (the last row of the "Tila" group: 44 px, a divider above it, a 16 px muted pencil, the label
   indented as "Kaikki mallit…"). `useOpenModes` (`ModesEditor.tsx`) gives both the same pair:
   `mark` on the row and `onCloseAutoFocus` on the menu or sheet content. The screen changes in
   `onCloseAutoFocus`, after the menu or sheet closed. Before that, the closing menu took the
   focus back from the heading. `openModes` sets the store screen `agents`; the router pushes
   `/agents`. Then it adds the hash `#tilat` to that history entry. `ModesSection` scrolls to the
   "Tilat" heading, focuses it and clears the hash. The router compares only the path and the
   query, so the hash is no new route.
3. A sentence with N of 6 or less gets the class `conf-low`: a dashed 2 px underline in the muted
   colour, and its N always shows. The dashes differ from the dotted mark of a protected name. A
   sentence with N of 7 or more is plain, and nothing shows after it. Every N has one style: a
   12 px micro number, inline 4 px after the full stop, on the prose baseline. Round 2 of the UI
   review chose the 4 px gap over a superscript, so the N cannot read as a digit of the sentence
   ("2031. 3", not "2031.3"). The N of a high
   sentence shows only on hover, on a tap or with "Näytä luvut", in the same style. The N element
   is a `span`, not a `sup`, and a hidden N is `display: none`. A hover or a tap now moves the
   text after the N; the UI review chose one number style over no movement. The anchor `conf-a`
   is an inline-block, so the underline stops before the N. Every sentence keeps the title
   "Luottamus N/9". The legend reads "1 arvaus – 9 varma · alleviivattu ≤ 6". The word
   "alleviivattu" is a sample of the underline. The word "Luottamus" went, because with it the
   legend took two rows at 390 px. The "Näytä luvut" pill is 32 px (`sm`) at every width, with a
   44 px target (`::after`), and the legend is one 32 px row at 390 px too. On phones the legend
   has 6 px more below it (14 px to the action row), so the 44 px targets of the pill and the
   action row keep 8 px apart. The
   prompt example changed from 9 to 8, because 9 is now only for what the model verified in the
   chat. The e2e reply `CONFIDENCE_REPLY` uses the levels 9, 7 and 3, so that the hover tests
   keep two hidden N and one sentence shows the underline.
4. The store key is `pa.pseudonyms`. `loadOn` and `saveOn` in `store.ts` now hold the
   localStorage read and write for this switch and for "Näytä luvut". With the marks off, the real
   value is a plain span with the hint as its `title` attribute: no tab stop and no tooltip
   component. A touch screen has no hover, so on a phone the user turns the marks on to check a
   value. "Näytä mitä malli näki" (the setting or the eye button of a message) still shows the
   marks, because the surrogates must stay distinct from the real text. The switch is named
   "Merkitse suojatut nimet" (the dialog calls the feature "Nimisuoja"), with the helper
   "Viesteissä suojatut nimet saavat värillisen merkin." While "Näytä mitä malli näki" is on, the
   switch is on and disabled, with the helper "Päällä, kun mallin näkemä teksti näytetään." Both
   helpers say "suojatut nimet", as the switch label does. The new helper starts with
   "Viesteissä", so it differs from the helper above from the first word. The screen
   `chat-annotated` shows the default state with plain values. The screen `chat-annotated-marks`
   shows the marks after the switch is on.

## Review findings left as they are

- The `chat-confidence` screen shows the hover reveal of the second sentence (its N "7"). The
  screen test makes this reveal on purpose.
- The focus ring around an inline mark covers the "!" after the name. This is from before phase
  28, and this phase does not change it.
