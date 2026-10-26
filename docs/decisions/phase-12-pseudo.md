# Phase 12: Pseudonymization hardening

The fixed decisions are in `phase-11-15-plan.md`, section "Phase 12". This record adds the decisions
that the plan left open, the data model, the task cards, the gate and the risks. The sidecar contract
in `phase-3.md` stays valid. This record lists only the additions to it.

## Goal

A surrogate name must not collide with a real person that the user knows. When the user types a name,
an email address or a street address that is equal to an issued surrogate, the model must not see it
as the person behind that surrogate. Email addresses and street addresses get natural surrogates with
Finnish case forms. Lone surnames typed in lower case on a phone are masked. The corpus grows by 200
lines and the harness enforces the plan's thresholds.

## Decisions

1. **Rare-pair pool.** The pool holds DVV first names with at least 300 holders and DVV surnames with
   at least 200 holders. Each name is alphabetic and known to Omorfi. `scripts/precompute_forms.py`
   now generates the case forms of every pool name at image build, in addition to the top 3,000 names.
   The image tables hold 2,761 first names and 3,775 surnames.
2. **Pair estimate.** The estimated number of real holders of a pair is
   `count(first) × count(last) / P`, with the names taken as independent. A surrogate pair must stay
   below 5. `P` is the sum of the DVV surname counts, 4,917,684. The surname file leaves out names
   with fewer than 20 holders, so `P` is a lower bound and the estimate errs high. The first-name
   counts include every given name, not only the first one, which also errs high.
3. **How a pair is drawn.** The first name is drawn as in phase 3: weighted by count, and matched to
   the real name's gender, inflection class, vowel harmony and gradation, with the same widening steps.
   The surname is drawn the same way, but only from surnames with fewer holders than
   `5 × P / count(first)`. Each pool bucket is sorted by count, so these surnames are a prefix of the
   bucket. A first name whose limit is 200 or less cannot pair with any pool surname. These names
   (for example Juhani and Maria) are not in the pool. Middle names have no limit.
4. **Pool size.** The rule allows 6,424,811 first name and surname pairs in the image (6,426,366 from
   the CSV files alone). The sidecar logs the number at startup. Example: "Mikko Virtanen" became
   "Voitto Paananen", with 3,445 × 5,625 / 4,917,684 = 3.9 estimated holders. A one-word surrogate
   (a lone first name or a lone surname) comes from names with fewer than 1,000 holders.
5. **Collision check: where.** Only text that the user typed is checked: the extension's `input` hook
   sends `user_input: true`. The check runs only where a user can answer: the server gives the
   extension an `awaitCollision` function. A subagent child process has no such function, and its
   input is masked task text, so it is not checked. A message that another extension sends (Pi input
   source `extension`) is not checked either. Model text, tool results, titles, memory and `/scan`
   keep the phase-3 echo rule.
6. **Collision check: what.** Issued surrogates are reserved for the user in all sessions and in all
   generations, because old surrogate forms stay in `entity_form`. A collision is a new mention that
   no vault real form matched and that no entity has as its canonical form. For a person, every name
   part of the mention must be equal to a base surrogate name of one entity, part for part, and the
   mention must have as many parts as that entity. For an email address or a street address, the
   mention must be equal to the base surrogate form. A lone first name that is part of a two-part
   surrogate is not a collision, because it is a common first name. In user input, the session echo
   rule no longer covers names, email addresses and street addresses, because the user sees real
   values. Code surrogates (hetu, IBAN, phone) stay covered.
7. **Pending lane and fail closed.** The sidecar parks each collision as a pending row with the
   reason `collision`. The row holds the mention, its base form and the entity whose surrogate it is
   equal to. `/mask` then returns an empty `masked`, no spans and the list `collisions`, and it
   records no spans. The same mention sent again gets the same open row. The extension logs
   `pseudo_collision` with the pending ids and kinds, and the input waits. The server sends the error
   code `pseudo_collision` to the chat and a fresh `vault.state` to every screen. The vault screen
   shows the row as "Onko tämä uusi henkilö?" with the name of the entity and the note that the
   message waits. The buttons are "Uusi henkilö" (accept) and "Sama henkilö" (reject). Nothing goes
   to the model or to the session file before the answer.
8. **Resume.** `vault.pending.resolve` applies the answer in the sidecar. Then the bridge tells the
   waiting input hook. The hook masks the text again and the turn starts. A later answer can raise a
   new collision, so the hook allows three rounds. The hook drops the input (`handled`) on
   `user.stop`, on `chat.delete`, after 30 minutes and on a server restart. The client still has the
   text, so the user can send it again.
9. **Accept and reject.** Accept creates a new entity for the mention. The old entity gets a fresh
   surrogate from the next turn on, unless it is pinned. Its old surrogate forms stay, so earlier
   chats still restore. Reject says that the mention is the old entity. The text stays as it is,
   because it is that entity's surrogate. Later input with the same text passes without a question.
   Another inflection of the name asks again.
10. **Email surrogates.** A webmail or ISP domain stays (38 domains, for example `gmail.com`,
    `outlook.com`, `kolumbus.fi`, `elisanet.fi`). Any other domain becomes `example-N.fi`. `N` is
    fixed per user and real domain, so colleagues still share a domain, and `N` is never reused. The
    local part is a pool first name and surname without diacritics, plus two digits
    (`kaarina.jurvanen90@example-1.fi`). The digits lower the chance that a webmail surrogate is a
    real address.
11. **Email case forms.** Finnish writes a case ending after a colon (`x@firma.fi:hin`). Each email
    entity has 11 real forms and 11 surrogate forms: NOM GEN PAR ESS TRA INE ELA ILL ADE ABL ALL.
    The ending follows the last label of the domain. A label that ends in a vowel takes
    `:n :tä :nä :ksi :ssä :stä :hin :llä :ltä :lle`. A label that ends in a consonant takes
    `:in :ia :ina :iksi :issa :ista :iin :illa :ilta :ille`. Vowel harmony follows a, o and u in the
    label. Detection puts a known ending into the span, and the surrogate gets the same case in its
    own class: `firma.com:iin` becomes `example-1.fi:hin`. An unknown ending stays as typed.
12. **Email detection.** An address whose last label is a file extension (png, jpg, webp, pdf and
    others) is a file name, not an email address (`logo@2x.png`). An email surrogate that comes back
    keeps its surrogate only in a session that saw it, as names do, because a webmail surrogate can
    be a real address. Surrogates from before phase 12 (`@example.invalid`) stay covered everywhere.
13. **STREET_ADDRESS.** The plan's STREET_ADDRESS is the existing kind `ADDRESS`. The kind is not
    renamed, so no vault migration is necessary. The span is the street name and the number, with
    the staircase and the apartment. The postcode and the city stay as they are: the sidecar no
    longer detects `POSTCODE_CITY`. Old `POSTCODE_CITY` entities are no longer matched, but their
    surrogates still restore in old chats.
14. **Street rules.** New suffix classes: `kaarre`, `piha` and `portti` with nine case forms each,
    and the Swedish names `vägen`, `gatan`, `gränden`, `stigen`, `backen` and `torget`, which stay
    uninflected. Plain text (user input) also finds streets in lower case (`koivukuja 7 b 12`). Road
    numbers are not addresses: `valtatie`, `kantatie`, `seututie`, `yhdystie` and `moottoritie` with
    a number. The surrogate is a fake street of the same suffix class (a Swedish street for a Swedish
    class), a random number and the same staircase shape. It takes the case of the real mention.
15. **Lone lower-case surnames.** The DVV surname file already has the counts (`surnames.csv`, names
    with at least 20 holders), so no new data is necessary. A lower-case word that Voikko and Omorfi
    do not know as a name now counts as a surname when all of these are true:
    - It is an inflected form, not the nominative, of a DVV surname with at least 200 holders. The
      nominative is no evidence, because `from` and `said` are DVV surnames.
    - Voikko does not know it as an ordinary word.

    Example: `haliselle` becomes Halinen (822 holders). Voikko-known lone surnames keep the phase-3
    rule. A word that Voikko knows as an ordinary word stays ordinary, also when it has a surname
    reading (`hämäläistä`, and `lahtiseksi`, which Voikko reads as the adjective "lahtinen").
16. **Fixes that the corpus found.** A new person's later mentions in lower case are found
    (`veikko hakala ... veke`): the per-request matcher now has lower-case variants, as the vault
    matcher does. A surname with a particle (`Carl von Hertzenin`) is masked whole. The particle stays
    in the text and the surname after it is masked. Before, only the first name was masked.

## Data model

Vault (`services/pseudo-svc/app/vault.py`):

- `pending` gets two columns: `reason TEXT DEFAULT 'uncertain'` (`uncertain` or `collision`) and
  `canonical TEXT` (the base form of the mention, for the entity that accept creates). A vault made
  before phase 12 gets the columns by `ALTER TABLE` at startup.
- `counter` holds `email_domain` (the sequence) and `email_domain:<domain>` (the `N` of each real
  domain).
- `entity_form` holds the 11 case forms of each new email entity (analysis = case key) and the forms
  of the new street classes.

Sidecar API (additions to the `phase-3.md` contract):

| Method, path | Change |
|---|---|
| `POST /mask` | Request field `user_input: bool` (text only). With it, the response has `collisions: [{ pending_id, entity_id, kind }]`. When the list is not empty, `masked` is `""` and `spans` is `[]`. |
| `GET /vault/entities` | Each pending row has `reason` and `entity_id`. |
| `POST /vault/pending/{id}` | `action` also takes `accept` and `reject`. Accept and reject fit only a collision row, and the other actions only an uncertain row. A wrong action answers 422. |

Extension (`packages/pi-ext-pseudo`): `client.mask(sessionId, value, { userInput })`, the type
`Collision`, `VaultPendingRow.reason` and `entity_id`, the type `PendingAction`, the constant
`PSEUDO_COLLISION`, and the option `awaitCollision(pendingIds) => Promise<boolean>`. The fake sidecar
takes `collide: string[]`. These texts collide in user input until their row is answered.

Protocol (`packages/protocol`): `VaultPending.reason` (`uncertain` or `collision`) and
`VaultPending.entityId` (nullable). `vault.pending.resolve.action` also takes `accept` and `reject`.
The server error code `pseudo_collision` is new.

Server (`apps/server`): `collisions.ts` holds the waits (`wait`, `answered`, `cancel`, 30-minute
timeout). `BridgeDeps.collisions` carries them. `bridge.ts` exports `vaultState()`.

## Task cards

| # | Task | Owner | Status |
|---|---|---|---|
| 1 | This record | Opus | done |
| 2 | Rare-pair pool, precomputed pool forms | Opus | done |
| 3 | Collision check, pending reason, accept and reject in the sidecar | Opus | done |
| 4 | Extension input hold, fake sidecar `collide` | Opus | done |
| 5 | Server waits, vault handling, protocol | Opus | done |
| 6 | Vault screen: collision row label and buttons | Opus | done (UI review open) |
| 7 | EMAIL and STREET_ADDRESS surrogates and forms | Opus | done |
| 8 | Lone lower-case surname rule | Opus | done |
| 9 | Corpus c313–c512, harness gate | Opus | done |
| 10 | Web: Finnish text for the error `pseudo_collision` | UI implementer | open |

## Gate

`tests/pii/harness.py` in the Docker image, all layers on (Omorfi, Voikko, spaCy NER):

| Gate | Minimum |
|---|---|
| PERSON recall | 0.98 |
| EMAIL recall | 0.95 |
| ADDRESS (street name and number) recall | 0.95 |
| codes (HETU, IBAN, PHONE) recall | 1.0 |
| Precision of each predicted kind PERSON, EMAIL, ADDRESS, HETU, IBAN, PHONE | 0.97 |

`POSTCODE_CITY` and `ORG` spans are not recall targets. A prediction on them is a false positive.
Each run uses a new vault user, because entities from an earlier run would turn unseen names into
vault hits.

Also: `services/pseudo-svc/.venv/bin/pytest` (and in the image), `pnpm typecheck`, `pnpm lint`,
`pnpm --filter @pa/pi-ext-pseudo test`, `pnpm --filter @pa/server test`.

## Status 2026-10-26

Corpus: 512 lines. The phase-3 lines c001–c312 are unchanged. Before = the phase-11 image, after =
the phase-12 image. Both runs use the new corpus and the new harness.

| Kind | Recall before | Recall after | Precision before | Precision after |
|---|---|---|---|---|
| PERSON | 383/388 0.987 | 384/388 0.990 | 383/388 0.987 | 384/389 0.987 |
| EMAIL | 45/45 1.0 | 45/45 1.0 | 45/47 0.957 | 45/45 1.0 |
| ADDRESS | 70/86 0.814 | 86/86 1.0 | 70/73 0.959 | 86/86 1.0 |
| HETU, IBAN, PHONE | 106/106 1.0 | 106/106 1.0 | 1.0 | 1.0 |
| PLATE (no threshold) | 10/14 0.714 | 10/14 0.714 | 1.0 | 1.0 |
| POSTCODE_CITY (not a target) | masked | kept | 0/37 | none predicted |

All gates pass. The four PERSON misses are `hämäläistä` and `lahtiseksi` (ordinary words to Voikko)
and `Late` and `Pirkkis` (nicknames that are not in `nicknames.tsv`). The nickname table is unchanged
on purpose: the misses show the honest rate. The five false positives are the phase-3 ones.

## Risks

- The pair estimate takes names as independent. Swedish first names go with Swedish surnames, and
  names cluster by age and region, so a correlated pair can have more holders than estimated. The
  lower-bound `P` and the given-name counts make the estimate high. The collision check catches what
  remains.
- The postcode and the city now reach the model. Phase 3 masked the postcode. The plan text says
  "postcode and city stay as they are", and this record reads it as "not masked". If the intent was
  to keep the phase-3 postcode masking, `codes.detect` and `vault_rec.matcher` must get it back.
- A held message is lost on a server restart or after 30 minutes. The client keeps the text, and the
  user sends it again. An automation whose prompt collides waits 30 minutes and then fails.
- After an accept, the model can still echo the old surrogate in an old chat. That form is now the
  new person's real name, so the scan masks it as the new person. This keeps the real name away
  from the model, at the cost of a wrong name in that reply.
- A surrogate that a model echoes in a session that never saw it creates an entity with the
  surrogate as its real name (phase-3 behaviour). The collision check then finds that entity and does
  not ask.
- Reject is remembered per exact text. Another inflection of the same name asks again.
- The server sends the error text of `pseudo_collision` in English until the web maps the code.
- Plural locative cases of surnames (`laaksosille`) are not in the forms tables. The name is masked,
  but the surrogate is in the nominative.
- The harness counts a gold span as found when any prediction overlaps it, so a partial mask counts
  as a hit. The particle surnames (decision 16) were such a case.
