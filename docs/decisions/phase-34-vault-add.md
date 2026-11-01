# Phase 34: Vault add and frequent lone surnames

Date: 2026-11-01. Follows phase 33 (`phase-33-recall.md`). Changes `services/pseudo-svc`, the client
protocol, the server bridge, the vault screen and the corpus.

## Goal

Close the "first sight" gap of phase 33 in a way that the owner controls. Phase 33 left four name
misses: two lone lower-case surnames that are also ordinary words (`hämäläistä`, `lahtiseksi`) and
two nicknames (`Late`, `Pirkkis`). This phase masks the first class and asks the owner about each
hit. For the second class, the owner adds the nickname on the vault screen.

## Decisions

1. **A lone lower-case frequent surname goes to the pending lane.** A lower-case word is a PERSON
   candidate with the score 0.5 when all of these are true:
   - Voikko or Omorfi reads the word as an ordinary word (`common_word`). Words that are no ordinary
     word keep the rules of phase-12 decision 15.
   - The word is an inflected form, not the nominative, of a DVV surname that ends in `-nen` and has
     at least 5,000 holders (`FREQUENT_SURNAME_MIN`, `surname_shaped(word, minimum)`). The DVV list
     has 81 such surnames.
   - The word before it is no first name in any case: `lemmas()` of the word before gives no
     first-name lemma. Phase-33 decision 2 and the pair rules decide `Mika hämäläistä` and
     `Liisan hämäläistä`. The check reads at most 40 characters before the word, and only after the
     cheap surname check, because it runs on every ordinary lower-case word.
   - The word has no place reading.

   The score is below `PENDING_BELOW` (0.6). Thus the sidecar masks the word and parks it as
   pending: the owner confirms, sends it as it is, or dismisses it on the vault screen. A dismissed
   word is not asked again (decision 7). Adjectives that are no frequent surname stay
   unmasked: `punaista`, `iloiseksi` (no DVV surname) and `suomalaista` (Suomalainen has 3,114
   holders). The check is `gazetteer.frequent_surname`.
2. **Only `-nen` surnames.** The frequent surnames without `-nen` are mostly nature words: `koski`,
   `mäki`, `laine`, `saari`, `kangas`, `nurmi`, `aalto`. Their inflected forms are frequent in chat
   text, and every hit asks the owner. See "Rejected variants" for the numbers.
3. **`vault.add { kind, text }`.** One client message adds an entity. `kind` is one of the kinds
   that `POST /vault/seed` takes (`VaultAddKind`: PERSON, HETU, IBAN, PHONE, EMAIL, ADDRESS,
   POSTCODE_CITY, PLATE). `text` is trimmed and has 1 to 80 characters. The server calls
   `pseudo.vaultSeed` and answers the asking socket with a fresh `vault.state`. A sidecar 422 (a
   value that is not valid for its kind, for example a lower-case name or a bad hetu) answers the
   error `invalid`, and the client shows "Virheellinen arvo.". The server never logs the text. The
   sidecar route did not change.
4. **The add form on the vault screen.** The form leads the "Tunnistetut" section, under any
   pending card, so an open question keeps the first position. The section shows also when the
   vault is empty; the empty state then stands under the form. The form has the lead-in "Lisää
   suojattava" in the meta style, a kind select (the Finnish kind names of the screen, "henkilö"
   first), a text field and the button "Lisää". The placeholder is "Esim. lempinimi" for a person
   and the capitalised kind name for the other kinds. On a phone the lead-in is above one 44 px
   row; the button is a 44 px icon button with `aria-label="Lisää"`. On a wider screen everything
   is in one row and the field is at most 360 px wide. A disabled button keeps its full border;
   only the label and the icon fade. The text stays until the next `vault.state` arrives. An error
   toast (`invalid`, `pseudo_down`) ends the wait and leaves the text for a fix. The button is
   disabled while the add waits. The footnote "Lempinimet tunnistetaan vain, jos lisäät ne käsin
   aliaksiksi." moved under the form as its helper text and lost the word "aliaksiksi": the add
   makes an entity of its own, not an alias. The empty-state line is now "Ne näkyvät täällä, kun
   viestissä on nimi tai tunnus tai kun lisäät sen itse."
5. **The fake sidecar learns a seeded value.** `startFakeSidecar` now masks a seeded value that is
   not in its dictionary from the next `/mask` on, as `pseudo-svc` does, and answers 422 for a
   seeded PERSON that does not start with a capital letter (`PERSON_RE` in short). The fake does
   not validate the code kinds (HETU, IBAN, PHONE and the others): it accepts every such value.
6. **Three corpus decoys (c560 to c562).** `punaista`, `suomalaista` and `iloiseksi` in lower-case
   phone text, tag `adjective-vs-surname`. A hit counts in `decoy_hits`, not as a false positive.
7. **A dismissed lower-case hit keys `never_detect` on the lower-case canonical.** The pending
   route (`POST /vault/pending/{id}`, action `dismiss`) stores `(PERSON, "hämäläinen")` in place of
   `(PERSON, "Hämäläinen")` when the pending text is all lower case. `resolve()` drops a candidate
   on that key only when its surface is lower case. Thus "Hylkää" on `ruotsalaista kahvia` stops
   every lower-case form of the word (`ruotsalaista`, `ruotsalaisia`), and a real Ruotsalainen,
   written with a capital letter, still masks. The old key, the canonical itself, would have
   stopped the masking of the person in every form for good. The same key applies to a lower-case
   pair from `lower_names` (`liisa savolaiselle`). A capitalised pending hit keeps the canonical
   key. `test_dismissed_lower_case_hit_keeps_the_surname` covers it.
8. **Voikko absent, Omorfi present.** The rule then runs on Omorfi alone: `lower_names` treats
   Omorfi as the lexicon, and `common_word` and `known_name` read Omorfi's analyses.
   `test_frequent_surname_rule_with_omorfi_alone` stubs `_voikko` and checks `hämäläistä` and
   `punaista`. With neither lexicon, nothing tells an ordinary word, and the rule does not run.

## Measured numbers

Docker image `pa-local-pseudo-svc` with all layers (Omorfi, Voikko, spaCy NER). Before: 559 lines,
phase-33 code. After: 562 lines, phase-34 code. The three new lines hold no gold spans, so the
recall counts compare directly.

| Kind | Recall before | Recall after | Precision before | Precision after |
|---|---|---|---|---|
| PERSON | 423/427 0.991 | 425/427 0.995 | 423/427 0.991 | 425/429 0.991 |
| vault-known names | 149/149 1.0 | 149/149 1.0 | | |
| first-sight names | 274/278 0.986 | 276/278 0.993 | | |
| ADDRESS | 86/86 1.0 | 86/86 1.0 | 86/86 1.0 | 86/86 1.0 |
| EMAIL | 45/45 1.0 | 45/45 1.0 | 45/45 1.0 | 45/45 1.0 |
| POSTCODE_CITY | 38/38 1.0 | 38/38 1.0 | 38/38 1.0 | 38/38 1.0 |
| HETU, IBAN, PHONE | 106/106 1.0 | 106/106 1.0 | 1.0 | 1.0 |
| PLATE (no gate) | 10/14 0.714 | 10/14 0.714 | 10/10 1.0 | 10/10 1.0 |

Misses: 8 before, 6 after: four plates, `Late` and `Pirkkis`. The nicknames stay misses in the
corpus, because the harness seeds only `vault-seed.json`. False positives: the same four before and
after (`Saaressa`, `Niemen`, `Sinistä`, `aino`). Decoy hits: 3 before, 3 after (`Saaressa`,
`Niemen`, `Mika rannalla`). No new decoy is hit.

The gate thresholds stay at the phase-33 values. PERSON precision (425 of 429) is still one count
above 0.99.

## Rejected variants

- **Any frequent surname, not only `-nen`.** The first version took all 126 DVV surnames with at
  least 5,000 holders. On the 562 lines the numbers were the same as the kept rule: PERSON recall
  425/427 0.995, PERSON precision 425/429 0.991, decoy hits 3. The corpus has no lone lower-case
  nature word that is an inflected surname, so it cannot see the cost. A probe of 12 synthetic
  phone sentences with such words (`mäellä`, `koskella`, `kankaalla`, `saaressa`, `kalliolla`,
  `niemellä`, `harjulla`, `laaksossa`, `lehdossa`, `aallot`, `lahdessa`, `nurmella`) masked 10 of
  12 and asked the owner about each one. The kept `-nen` rule masks 0 of 12. Decision 2 records
  the choice. The probe is not in the corpus: these words are not names, and a decoy line for each
  would only repeat the probe.

## Left as they are

- A demonym that is also a frequent `-nen` surname asks the owner: `ruotsalaista kahvia`
  (Ruotsalainen), `karjalaiset tulee` (Karjalainen, plural), `lappalaista` (Lappalainen). The word
  is masked until the owner answers. "Hylkää" stops its lower-case forms for good (decision 7).
  This is the trade of phase-12
  decision 19: a leaked surname costs more than a masked word. No corpus line holds such a word.
- A nickname leaks until the owner adds it. The add form does not suggest names.
- `test_old_one_word_surrogate_still_collides_after_the_upgrade` fails in some runs (3 of 6 runs
  on `main`). The vault secret is random per test, so the one-word surrogate changes. Some drawn
  first names (`Torsti`, `Jaani`) are not detected after "Hei", so `Hei Torsti!` raises no
  collision. That is a detection gap in the collision check of phase-12 decision 6, not a change of
  this phase. The sibling test `test_first_name_and_inflected_surname_with_a_place_reading` failed
  in the same way when a surrogate held the real form (`Lehtorannalle`). It now matches whole
  words.
- A value added with the wrong kind (a nickname as a phone number) is refused by the sidecar with
  `invalid`. The form does not say which check failed.

## Review

- **Code review.** Eight findings, all fixed: the bounded previous-word read after the cheap surname
  check (decision 1), the lower-case dismiss key (decision 7), a first name in any case before the
  word (decision 1), the Omorfi-only path (decision 8), the text that stays until `vault.state`
  and the button that waits (decision 4), the placeholder per kind (decision 4), the fake's comment
  width and its PERSON-only check (decision 5), and the e2e case for a refused value.
- **Blind scored screenshot review** of the vault screenshots at 390 and 1440 px, light and dark.
  No blocking finding. Several criteria scored 3 and were fixed: the form pushed the pending card
  down, the select had no lead-in, the disabled button read as an empty slab in dark mode, the
  empty-state line ignored the add, the field was too wide at 1440 px, and the nickname footnote
  belonged to the form (decision 4). Nice-to-have left as it is: no screenshot shows the focus
  state of the field and the select.

## Status

Done 2026-11-01. The corpus gate passes at the phase-33 thresholds (562 lines); the numbers above
are the same after the review fixes. The pseudo-svc pytest suite passes in the image (157 tests;
`test_old_one_word_surrogate_still_collides_after_the_upgrade` is flaky, see "Left as they are").
Typecheck, lint, the protocol, server and web vitest suites, `pnpm test:contract`, the Playwright
`chromium` flows (661 passed) and `tests/masked-only` pass. The `screens` project rewrote the
`vault`, `vault-merge`, `vault-collision` and `vault-empty` baselines at 390 and 1440 px.
