# Phase 33: Detection recall

Date: 2026-11-01. Follows phase 32 (`phase-32-readme.md`). Changes `services/pseudo-svc` and the
corpus gate of `phase-12-pseudo.md`.

## Goal

Raise the recall of `pseudo-svc` on the Finnish corpus without a loss of precision. Make the
published numbers honest: a gate that a regression fails, and decoys that can see the new rules
fail.

The phase-12 run had 14 misses on 554 lines:

- Four lower-case streets with a bare number in the middle of a phrase (`kauppakadulta 14 ennen
  kuutta`, `koulutiellä 3 odottamassa`, `puistokatu 12 ovikoodi on 1234`, `myllypiha 2 sisäpihan`).
- Four surnames that are also ordinary words: two lone lower-case surnames (`hämäläistä`,
  `lahtiseksi`) and two partial misses where the first name was masked and the surname leaked
  (`Anu rannalle`, `Mika salmelle`).
- Two nicknames (`Late`, `Pirkkis`).
- Four plates without a context word. These misses are deliberate (plan §6, layer 1). This phase
  does not change them.

## Decisions

1. **A lower-case street with a bare number in the middle of a phrase.** With Voikko, the number is
   a house number unless the next word is a partitive or a translative noun, adjective or numeral.
   These are the cases that a number counts: `2 kertaa`, `3 lasta`, `2 kojua`, `2 tunniksi`. A
   nominative, a genitive, an adverb or a verb after the number keeps the address (`puistokatu 12
   ovikoodi`, `myllypiha 2 sisäpihan`, `kauppakadulta 14 ennen`, `koulutiellä 3 odottamassa`). The
   unit list of phase-12 decision 14 stays and runs first. Without Voikko the phase-12 rule stays:
   the number must be at a phrase end or before a postcode. The check is `codes._counted` and
   `gazetteer.counted`.
2. **A first name and an inflected surname with a place reading.** Phase-12 decision 19 refused
   every lower-case word with a place reading after a first name. `rannalle` and `salmelle` have
   one, because `locality()` reads them as forms of Ranua and Salo. The word is now a surname when
   all of these are true:
   - The first name is in the nominative: its surface is a DVV first name. A Finnish full name
     inflects only the surname, so `Liisan rannalle` is no full name.
   - Voikko or Omorfi knows the word as an ordinary word (`ranta`, `salmi`).
   - The word is an inflected form, not the nominative, of a DVV surname with at least 200 holders
     (`surname_shaped`, the rule of phase-12 decision 15).

   The score is 0.75, as for every pair whose surname is an ordinary word (decision 19). Such a pair
   never upgrades an existing entity.
3. **Nicknames stay in the vault.** The detector does not guess nicknames. A nickname that is in
   the vault is masked in the next message. The test `test_nickname_in_the_vault_is_masked` covers
   it: `Late` is not masked before the entry exists and is masked and restored after it. The entry
   comes from `POST /vault/seed` today. The vault screen and the client protocol have no action that
   adds an entity, so the owner cannot add a nickname from the app yet (see "Left as they are").
4. **Gate thresholds at the measured floor.** `tests/pii/harness.py` now has the measured value of
   each gate, rounded down to a whole percent. A kind with a miss never gets 100 %. Precision has
   one minimum per kind.

   | Gate | Phase 12 | Phase 33 |
   |---|---|---|
   | PERSON recall | 0.98 | 0.99 |
   | EMAIL recall | 0.95 | 1.0 |
   | ADDRESS recall | 0.95 | 1.0 |
   | POSTCODE_CITY recall | 1.0 | 1.0 |
   | codes (HETU, IBAN, PHONE) recall | 1.0 | 1.0 |
   | PERSON precision | 0.97 | 0.99 |
   | EMAIL, ADDRESS, POSTCODE_CITY, HETU, IBAN, PHONE precision | 0.97 | 1.0 |

5. **Five new corpus lines (c555 to c559).** The phase-12 street decoys (c514 to c516) stop at the
   unit list, so no decoy reached the check of decision 1. The new lines are three lower-case street
   decoys with a counted number (`takapihalla 3 lasta`, `kauppatorilla 2 kojua`, `uimarannalle 2
   tunniksi`) and two place words after a first name (`vein Liisan rannalle`, `Mika rannalla`).
   Harness rule 4 counts a prediction that overlaps a gold span as a true positive. Thus a surname
   that is masked together with a true first name is not a false positive. Only `decoy_hits` in
   `last-run.json` shows it.
6. **Lone lower-case surnames stay unmasked.** `hämäläistä` and `lahtiseksi` have no first name
   before them, so decision 2 does not apply. Voikko reads both as ordinary words (phase-12
   decision 15). No rule was tried for them.

## Measured numbers

Docker image `pa-local-pseudo-svc` with all layers (Omorfi, Voikko, spaCy NER), the phase-33 code
mounted. Before: 554 lines, phase-12 code. After: 559 lines, phase-33 code. On the 554 old lines
the after values are PERSON recall 421/425 and ADDRESS recall 86/86.

| Kind | Recall before | Recall after | Precision before | Precision after |
|---|---|---|---|---|
| PERSON | 419/425 0.986 | 423/427 0.991 | 421/425 0.991 | 423/427 0.991 |
| vault-known names | 149/149 1.0 | 149/149 1.0 | | |
| first-sight names | 270/276 0.978 | 274/278 0.986 | | |
| ADDRESS | 82/86 0.953 | 86/86 1.0 | 82/82 1.0 | 86/86 1.0 |
| EMAIL | 45/45 1.0 | 45/45 1.0 | 45/45 1.0 | 45/45 1.0 |
| POSTCODE_CITY | 38/38 1.0 | 38/38 1.0 | 38/38 1.0 | 38/38 1.0 |
| HETU, IBAN, PHONE | 106/106 1.0 | 106/106 1.0 | 1.0 | 1.0 |
| PLATE (no gate) | 10/14 0.714 | 10/14 0.714 | 10/10 1.0 | 10/10 1.0 |

Misses: 14 before (2 partly masked), 8 after (none partly masked): four plates, `hämäläistä`,
`lahtiseksi`, `Late` and `Pirkkis`. False positives: the same four before and after (`Saaressa`,
`Niemen`, `Sinistä`, `aino`). Decoy hits: 2 before, 3 after. The new hit is `Mika rannalla`
(c559), see "Left as they are".

## Rejected variants

- **Street, partitive only.** The first version of decision 1 accepted every next word except a
  partitive. On 559 lines, ADDRESS precision fell to 86/87 0.989: `uimarannalle 2 tunniksi` (c557)
  became an address. The translative was added.
- **Surname, any surname with a place reading.** The first version of decision 2 took a DVV
  surname with at least 40 holders (the rule of decision 19) in place of the inflected form of a
  surname with at least 200 holders. On the 554 old lines PERSON recall was 421/425 0.991 and PERSON
  precision 421/425 0.991, but a new decoy hit appeared: `onko Riikka kotona jo` (c549) became the
  person Riikka Koto (67 holders). The 200-holder rule removed the hit.

## Left as they are

- A first name before a place word that is also a common surname is masked with it: `Mika
  rannalla, tulee kuudelta` masks `Mika rannalla` as Mika Ranta (decoy hit c559). This is the same
  trade as `Pekka koski minua` in phase-12 decision 19: a leaked surname costs more than a masked
  word.
- A partitive or translative after a real house number hides the address:
  `asun puistokadulla 12 kolmatta vuotta` is not masked.
- Another case that a number counts is still an address: `uimarannalle 2 päivässä` (inessive) is
  masked. The inessive also follows house numbers (`12 kolmannessa kerroksessa`), so it stays out of
  the check.
- Lone lower-case surnames that are ordinary words (decision 6) and nicknames before a vault entry
  (decision 3) leak.
- The vault screen has no add action. Only `POST /vault/seed` on the sidecar creates an entity
  without a detection, and only the server's self-email setup calls it. Closes it: an add message
  in the protocol and an add form on the vault screen.

## Status

Done 2026-11-01. The corpus gate passes at the new thresholds. The pseudo-svc pytest suite passes
in the image (154 tests) and locally without a lexicon (146 passed, 8 skipped). `tests/masked-only`
passes.
