# Finnish PII test corpus

This directory holds the test set for `services/pseudo-svc` (plan §6, "Expected ceiling", and plan §14, gate 3).
All names are synthetic combinations of common Finnish first names and surnames. All codes are generated.

## Files

| File | Purpose |
|---|---|
| `corpus.jsonl` | 554 labelled texts: c001–c312 from phase 3, c313–c516 from phase 12, c517–c550 from the mixed-case fix, c551–c554 from the memory eval false positives. Do not edit by hand. |
| `generate.py` | Hand-written source of the corpus with inline markup. Edit this file, then run it to rebuild `corpus.jsonl`. |
| `validate.py` | Checks the corpus and prints the counts per kind and per tag. |
| `vault-seed.json` | The 15 people that the harness registers in the vault before a run. |
| `harness.py` | Sends each text to `POST /mask` and computes recall and precision. Writes `last-run.json`. |
| `last-run.json` | The result of the last full run (2026-10-27, all 554 lines). The root `README.md` links to it. |

Commands:

```sh
python3 -I tests/pii/generate.py                       # rebuild corpus.jsonl
python3 -I tests/pii/validate.py                       # check the corpus
python3 -I tests/pii/harness.py --dry-run              # check the corpus, no sidecar
PSEUDO_URL=http://pseudo-svc:8000 python3 -I tests/pii/harness.py
```

## Line format

```json
{ "id": "c001", "text": "...", "tags": ["genitive"],
  "spans":  [{ "start": 10, "end": 25, "kind": "PERSON", "canonical": "Mikko Virtanen", "ref": "Mikko Virtanen", "note": "genetiivi" }],
  "decoys": [{ "start": 30, "end": 41, "kind": "HETU", "note": "väärä tarkistemerkki" }] }
```

- `start` and `end` are UTF-16 code unit offsets into `text`. In JavaScript, `text.slice(start, end)` gives the surface form.
- `canonical` is the base form: nominative singular for names (`Virtaselle` gives `Virtanen`), the compact code for codes (`FI1912389078666617`, `+358405562190`, `210165-976L`), and the nominative street form for addresses (`Mannerheimintie 12`).
- `ref` (PERSON only) is the full name of the person that the mention refers to. The harness uses `ref` to put a mention in the vault-known group or in the unseen group.
- `note` tells the case, the consonant gradation, or the referent of a first name or a nickname.
- `decoys` (optional) are strings that look like PII but are not PII: invalid hetu codes, order numbers, product codes, and place names that are also surnames. Decoys are not gold spans. The harness reports each decoy that a prediction overlaps.
- `tags` name the phenomenon in the line. `validate.py` prints the full list.

## Kinds

`PERSON`, `HETU`, `IBAN`, `PHONE`, `ADDRESS`, `POSTCODE_CITY`, `PLATE`, `EMAIL`, `ORG`.
`ORG` spans are not recall targets. They make false positives on brand names measurable.
A `POSTCODE_CITY` span holds the postcode and the city, but only the postcode is masked: the city stays.

## Scoring

1. The harness registers the people in `vault-seed.json` through `seed_vault()`. The phase-3 contract has no create endpoint. Thus the function tries `POST /vault/seed` first. If the sidecar returns 404 or 405, the function sends one short sentence per person to `POST /mask`. Change only this function when the sidecar adds a seed endpoint. Each run uses a new vault user (`pii-harness-<random>`), because the entities of an earlier run would turn unseen names into vault hits.
2. The harness sends each `text` to `POST /mask` with its own `session_id`. The response spans have offsets in the masked text. The harness maps them back to the original text with `real_form`.
3. A gold span is found when predicted spans cover all of its characters (spaces do not count). The predicted kind does not have to match, because the requirement is that the value is masked. A gold span that predictions only overlap is a miss, marked `partial` in `last-run.json`: a partly masked name leaks the rest. For `POSTCODE_CITY` only the five digits must be covered.
4. A predicted span is a true positive when it overlaps a gold span that is not `ORG`. All other predictions are false positives.
5. Recall is computed per gold kind and per group. Precision is computed per predicted kind and per `detector` value in the response. For each detector, the report also gives the share of gold spans that it found first.

Thresholds (phase-12 gate, `docs/decisions/phase-12-pseudo.md`). A run fails (exit code 1) if one threshold is not met:

| Gate | Spans | Minimum |
|---|---|---|
| `codes` | recall of `HETU`, `IBAN`, `PHONE` | 100 % |
| `PERSON` | recall of all `PERSON` spans | 98 % |
| `EMAIL` | recall of `EMAIL` spans | 95 % |
| `ADDRESS` | recall of `ADDRESS` spans (street name and number) | 95 % |
| `POSTCODE_CITY` | recall of `POSTCODE_CITY` spans (the postcode) | 100 % |
| `precision <kind>` | precision of each predicted kind `PERSON`, `EMAIL`, `ADDRESS`, `POSTCODE_CITY`, `HETU`, `IBAN`, `PHONE` | 97 % |

The report also gives recall for `vault_known_names` (`PERSON` spans whose `ref` is in `vault-seed.json`) and `unseen_names` (all other `PERSON` spans), and recall and precision for `PLATE`, without a threshold. Plates without a context word are expected misses (plan §6, layer 1).
