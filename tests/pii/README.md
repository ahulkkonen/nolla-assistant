# Finnish PII test corpus

This directory holds the test set for `services/pseudo-svc` (plan §6, "Expected ceiling", and plan §14, gate 3).
All names are synthetic combinations of common Finnish first names and surnames. All codes are generated.

## Files

| File | Purpose |
|---|---|
| `corpus.jsonl` | 300 labelled texts. Do not edit by hand. |
| `generate.py` | Hand-written source of the corpus with inline markup. Edit this file, then run it to rebuild `corpus.jsonl`. |
| `validate.py` | Checks the corpus and prints the counts per kind and per tag. |
| `vault-seed.json` | The 15 people that the harness registers in the vault before a run. |
| `harness.py` | Sends each text to `POST /mask` and computes recall and precision. Writes `last-run.json`. |

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
- `canonical` is the base form: nominative singular for names (`Virtaselle` gives `Virtanen`), the compact code for codes (`FI1912389078666617`, `+358405562190`, `210165-076K`), and the nominative street form for addresses (`Mannerheimintie 12`).
- `ref` (PERSON only) is the full name of the person that the mention refers to. The harness uses `ref` to put a mention in the vault-known group or in the unseen group.
- `note` tells the case, the consonant gradation, or the referent of a first name or a nickname.
- `decoys` (optional) are strings that look like PII but are not PII: invalid hetu codes, order numbers, product codes, and place names that are also surnames. Decoys are not gold spans. The harness reports each decoy that a prediction overlaps.
- `tags` name the phenomenon in the line. `validate.py` prints the full list.

## Kinds

`PERSON`, `HETU`, `IBAN`, `PHONE`, `ADDRESS`, `POSTCODE_CITY`, `PLATE`, `EMAIL`, `ORG`.
`ORG` spans are not recall targets. They make false positives on brand names measurable.

## Scoring

1. The harness registers the people in `vault-seed.json` through `seed_vault()`. The phase-3 contract has no create endpoint. Thus the function tries `POST /vault/seed` first. If the sidecar returns 404 or 405, the function sends one short sentence per person to `POST /mask`. Change only this function when the sidecar adds a seed endpoint.
2. The harness sends each `text` to `POST /mask` with its own `session_id`. The response spans have offsets in the masked text. The harness maps them back to the original text with `real_form`.
3. A gold span is found when a predicted span overlaps it. The predicted kind does not have to match, because the requirement is that the value is masked.
4. A predicted span is a true positive when it overlaps a gold span that is not `ORG`. All other predictions are false positives.
5. Recall is computed per gold kind and per group. Precision is computed per predicted kind and per `detector` value in the response. For each detector, the report also gives the share of gold spans that it found first.

Groups and thresholds (plan §6). A run fails (exit code 1) if one threshold is not met:

| Group | Gold spans | Minimum recall |
|---|---|---|
| `codes` | `HETU`, `IBAN`, `PHONE`, `EMAIL` | 99 % |
| `vault_known_names` | `PERSON` spans whose `ref` is in `vault-seed.json` | 95 % |
| `unseen_names` | all other `PERSON` spans | 85 % |

`ADDRESS`, `POSTCODE_CITY` and `PLATE` have recall and precision in the report but no threshold. Plates without a context word are expected misses (plan §6, layer 1).
