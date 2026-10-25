# 0003 — Finnish PII stack for `pseudo-svc`

## Context

Plan section 6 defines the detection, surrogate and restoration pipeline of `services/pseudo-svc`. Plan section 15 lists items to verify before phase 3: the Presidio Finnish identity-code recognizer, Omorfi and Voikko coverage and licences, and the Posti postcode file. Plan sections 7 and 15 also ask for a local Finnish embedding model for phases 4 and 8.

Decision 0002 requires exact pins and a minimum release age of 7 days. On 2026-10-25 (05:26 UTC) the cut-off is 2026-10-18 05:26 UTC. Release dates come from `https://pypi.org/pypi/<name>/json`, field `releases[version][*].upload_time` (earliest file).

## Findings

### 1. Python version and pins

Source: PyPI JSON API for each package; GitHub API `repos/explosion/spacy-models/releases`; `https://raw.githubusercontent.com/explosion/spacy-models/master/meta/fi_core_news_lg-3.8.0.json`.

| Package | Pin | Uploaded | Notes |
| --- | --- | --- | --- |
| fastapi | 0.143.3 | 2026-10-16 | Newer releases (0.143.5 … 0.162.0) are all after the cut-off. 0.143.5 was uploaded 2026-10-18 09:12 UTC, 4 hours too late. |
| uvicorn | 0.54.0 | 2026-09-25 | |
| pydantic | 2.14.1 | 2026-10-11 | Presidio needs `>=2.12.5`; FastAPI needs `>=2.9.0`. |
| presidio-analyzer | 2.2.364 | 2026-07-22 | `requires_python <3.15,>=3.10`. Repository moved to `github.com/data-privacy-stack/presidio`. |
| presidio-anonymizer | 2.2.364 | 2026-07-22 | |
| spacy | 3.8.16 | 2026-08-24 | Wheels for cp310–cp314, manylinux x86_64. |
| fi_core_news_lg | 3.8.0 | 2024-09-30 | `https://github.com/explosion/spacy-models/releases/download/fi_core_news_lg-3.8.0/fi_core_news_lg-3.8.0-py3-none-any.whl`. Requires `spacy>=3.8.0,<3.9.0`. 220 MB. CC BY-SA 4.0. The plan says 3.7; 3.8.0 is the current model for spaCy 3.8. |
| libvoikko (Python) | 4.3 | 2019-11-22 | Pure-Python `ctypes` wrapper. It loads `libvoikko.so.1` from the system. |
| omorfi | 0.10.0 | 2026-05-25 | Pure-Python wheel. Depends on `pyhfst` only, not on `hfst`. |
| pyhfst | 1.4.0 | 2025-11-07 | Pure-Python reader for HFST optimized-lookup transducers. 1.4.1 (2026-10-22) is too young. Apache-2.0. |
| sqlcipher3 | 0.6.4 | 2026-10-13 | Self-contained manylinux_2_28 wheels for cp39–cp314 (bundled SQLCipher since 0.6.2). |
| phonenumbers | 9.0.41 | 2026-10-08 | Already a Presidio dependency (`>=9.0.28,<10`). |
| pytest | 9.1.1 | 2026-06-19 | |
| httpx | 0.28.1 | 2024-12-06 | |
| onnxruntime | 1.31.0 | 2026-10-09 | Only for the embedding option in question 10. |
| fastembed | 0.9.0 | 2026-10-07 | Only for the embedding option in question 10. 0.9.1 (2026-10-24) is too young. |
| `@huggingface/transformers` (npm) | 4.3.1 | 2026-10-06 | Only for the embedding option in question 10. |

Python version: every package above has wheels or pure-Python builds for both 3.12 and 3.13. The `hfst` C bindings (3.16.0.1, 2023-11-21, GPL-3) have manylinux x86_64 wheels only up to **cp312**; there are no cp313 wheels. Omorfi 0.10.0 does not need `hfst` because it uses `pyhfst`, but `hfst` is the fallback if `pyhfst` is too slow or cannot read a model. Python 3.12 keeps that fallback open.

Native Voikko in the container (Debian trixie, from `https://sources.debian.org/api/src/libvoikko/` and `.../voikko-fi/`): `apt-get install libvoikko1 voikko-fi`. Trixie ships libvoikko 4.3.2-1 and voikko-fi 2.5-2; bookworm ships 4.3.1-1 and 2.5-1. The Debian package `python3-libvoikko` targets the system Python, not the image's `/usr/local` Python, so use the PyPI `libvoikko==4.3` wrapper instead.

Omorfi models: the PyPI wheel contains no language models. The models come from the GitHub release `https://github.com/flammie/omorfi/releases/download/v0.9.12/omorfi-hfst-models-0.9.12.tar.xz` (26 MB, 2026-01-05). The archive holds `omorfi.analyse.hfst`, `omorfi.generate.hfst` (30 MB), `omorfi.describe.hfst`, `omorfi.accept.hfst` and two `omorfi_recased.*` files. Header bytes show type `HFST_OLW` (weighted optimized lookup), and the `pyhfst` source reads weighted transducers (`transducer_header.is_weighted()`).

### 2. Presidio Finnish identity-code recognizer

Source: `presidio_analyzer-2.2.364-py3-none-any.whl`, file `presidio_analyzer/predefined_recognizers/country_specific/finland/fi_personal_identity_code_recognizer.py`.

- Class: `FiPersonalIdentityCodeRecognizer(PatternRecognizer)`, entity `FI_PERSONAL_IDENTITY_CODE`, default language `fi`, context words `hetu`, `henkilötunnus`, `personbeteckningen`, `personal identity code`.
- Pattern (score 0.5): `\b(\d{6})([-+ABCDEFYXWVU])(\d{3})([0123456789ABCDEFHJKLMNPRSTUVWXY])\b`. A second pattern without `\b` scores 0.1.
- The 2023 separators are accepted. `validate_result` maps `+` to 1800, `- Y X W V U` to 1900, and `A B C D E F` to 2000. It checks the full date with the century, so 29 February 1800 fails. Note: the task brief swapped the groups. `Y X W V U` belong to the 1900s and `B C D E F` to the 2000s (decree 128/2010 §2, quoted in question 6).
- The mod-31 check is implemented: `valid_control_characters[int(date_part + individual_number) % 31] == control_character`.
- Gaps: (a) it does not reject individual numbers `000` and `001`; (b) the patterns run with `re.IGNORECASE`, but the century lookup is case-sensitive, so a lowercase separator falls back to 2000; (c) the class is **not** listed in `conf/default_recognizers.yaml`, so it must be added explicitly (`registry.add_recognizer(FiPersonalIdentityCodeRecognizer())`).
- Other Presidio defaults: the IBAN recognizer has an `FI` pattern (`(FI)` + check digits + 14 digits). `PhoneRecognizer.DEFAULT_SUPPORTED_REGIONS` is `("US","GB","DE","FR","IL","IN","CA","BR")` and does not include `FI`, so pass `supported_regions=("FI",)`.

spaCy `fi` engine configuration. `fi_core_news_lg` 3.8.0 NER labels (from its `meta.json`): `CARDINAL DATE EVENT FAC GPE LANGUAGE LAW LOC MONEY NORP ORDINAL ORG PERCENT PERSON PRODUCT QUANTITY TIME WORK_OF_ART`. It emits `PERSON`, not `PER`. Overall NER P/R/F = 0.825/0.814/0.820 (per-type scores in the meta file are all 0.0, a metadata error). Training data: UD Finnish TDT 2.8 and TurkuONE.

```yaml
nlp_engine_name: spacy
models:
  - lang_code: fi
    model_name: fi_core_news_lg
ner_model_configuration:
  model_to_presidio_entity_mapping:
    PERSON: PERSON
    GPE: LOCATION
    LOC: LOCATION
    FAC: LOCATION
    ORG: ORGANIZATION
    NORP: NRP
    DATE: DATE_TIME
    TIME: DATE_TIME
  low_confidence_score_multiplier: 0.4
  labels_to_ignore: [CARDINAL, EVENT, LANGUAGE, LAW, MONEY, ORDINAL, PERCENT, PRODUCT, QUANTITY, WORK_OF_ART]
```

Load it with `NlpEngineProvider(conf_file=...)` and `AnalyzerEngine(nlp_engine=..., supported_languages=["fi"])`. The mapping keys match the defaults in `nlp_engine/ner_model_configuration.py` (`MODEL_TO_PRESIDIO_ENTITY_MAPPING`).

### 3. Omorfi and Voikko: licences and surname coverage

Sources: `https://github.com/flammie/omorfi` (`COPYING`), omorfi 0.10.0 METADATA, libvoikko 4.3 PyPI classifiers, `https://metadata.ftp-master.debian.org/changelogs/main/v/voikko-fi/unstable_copyright`, `https://raw.githubusercontent.com/flammie/omorfi/main/src/lexemes.tsv`, DVV name files (question 4).

Licences:

- Omorfi lexicon and models: GNU GPL v3 (`COPYING`). omorfi-python: `GPL-3.0-only`.
- pyhfst: Apache-2.0. hfst (C bindings): GPL-3.
- libvoikko: tri-licence MPL 1.1 / GPL-2.0-or-later / LGPL-2.1-or-later (PyPI classifiers). Debian packages it as GPL-2+.
- voikko-fi (Finnish dictionary): GPL-2.0-or-later.

All four are GPL family (libvoikko can be used under LGPL or MPL). The GPL applies when software is distributed. `pseudo-svc` runs on our own server and is not distributed, so the GPL adds no obligation now. If the image is ever shipped to others, the `pseudo-svc` image with Omorfi and voikko-fi must ship with its source. The rest of the system talks to it over HTTP, so it stays a separate program. Keep all GPL code inside the `pseudo-svc` container and import none of it into Pi or the bridge.

Surname coverage (measured): `lexemes.tsv` has 571,946 lexemes, of which 351,090 are `PROPN`. Origins include `dvvfi` (DVV names), `finer` and `nimistö`. Each lexeme has a paradigm class named after a model word, for example `Virtanen` → `PROPN_AAKKOSTAMINEN`, `Kärkkäinen` → `PROPN_KYLKIÄINEN`, `Mäkelä` → `PROPN_HÄKKYRÄ`, `Koski` → `PROPN_ONNI`. Measured against the DVV 2026-08-04 files:

| List | Types | Types in Omorfi | Holders covered |
| --- | --- | --- | --- |
| Surnames (≥ 20 holders) | 23,265 | 97.5% | 99.7% |
| Male first names (≥ 5) | 11,018 | 90.5% | 99.9% |
| Female first names (≥ 5) | 14,332 | 91.2% | 99.9% |

Missing surnames are mostly multi-word noble names (`von Hertzen`, `af Hällström`). Missing first names are mostly recent foreign names (`Lilibet`, `Liudmyla`).

Generation of unknown names: `omorfi.generate.hfst` maps an omor analysis string (for example `[WORD_ID=Virtanen][UPOS=PROPN][NUM=SG][CASE=ALL]`) to surface forms. It only generates lemmas in the lexicon. The guesser (`guesser.py`) only analyses, it does not generate. So Omorfi does not generate case forms for an arbitrary unknown surname. UNVERIFIED: the exact tag string and the output of the compiled 0.9.12 generator. The source lexicon was measured, but no transducer was run, because downloaded code is not executed in this spike. Confirm in phase 3 with one test: generate the 15 singular cases of `Hulkkonen` and one name missing from the lexicon.

Voikko alone: `Voikko.analyze(word)` returns `BASEFORM`, `CLASS` (`etunimi`, `sukunimi`, `paikannimi`, …), `SIJAMUOTO`, `NUMBER` and `STRUCTURE`. That covers analysis and lemma lookup (`Virtaselle` → `Virtanen`). Voikko has no generation API.

Fallback for generation: suffix rules keyed on the Omorfi paradigm class. A name missing from the lexicon gets the class of the longest-matching known name ending (`-nen` → `AAKKOSTAMINEN` or `KYLKIÄINEN` by vowel harmony). The rules then apply the case endings with back/front vowel harmony and consonant gradation (`-kk-`/`-k-`, `-pp-`/`-p-`, `-tt-`/`-t-`, `-nt-`/`-nn-`, …). For surrogates, choose only DVV names that Omorfi already knows, so surrogates never need the fallback.

### 4. DVV name data

Source: CKAN API `https://avoindata.suomi.fi/data/api/3/action/package_show?id=57282ad6-3ab1-48fb-983a-8aba5ff8d29a`. `avoindata.fi` now redirects (301) to `avoindata.suomi.fi`.

- Dataset: "Väestötietojärjestelmän suomalaisten nimiaineistot" / "Finnish names". Publisher: Digi- ja väestötietovirasto. Licence: `cc-by-4.0` (Creative Commons Attribution 4.0). Dataset slug is literally `none`. Page: `https://avoindata.suomi.fi/data/fi/dataset/none`.
- Latest release 2026-08-04 (sheet `Saate`: extraction date 2026-08-04, register state 2026-08-03).
- `etunimitilasto-2026-08-04-dvv.xlsx` (910 kB). Sheets: `Miehet kaikki` (11,018 names), `Miehet ens` (7,395), `Miehet muut` (5,980), `Naiset kaikki` (14,332), `Naiset ens` (9,744), `Naiset muut` (7,341). Columns `Etunimi`, `Lukumäärä`. Names with fewer than 5 holders are left out.
- `sukunimitilasto-2026-08-04-dvv.xlsx` (448 kB). Sheet `Nimet` (23,265 names). Columns `Sukunimi`, `Yhteensä`. Names with fewer than 20 holders are left out.
- Counts include living Finnish citizens, resident in Finland or abroad.
- Direct URLs contain a resource UUID and a dated file name, so they change with each release. For automation, call `package_show` with the dataset id above and take `resources[].url` where `name` starts with `Etunimitilasto` or `Sukunimitilasto`. Format is XLSX only; parse it with `openpyxl` or convert it once at build time and commit the CSV with attribution.

### 5. Posti postcode file

Sources: `https://www.posti.fi/fi/yrityksille/asiakastuki/postinumerotiedostot`, terms PDF `https://assets.ctfassets.net/dvxpcmq06s7e/1eKbwM2WAEY5AuGi5TrSZ7/3550dd7d56837b39126cf8c1b15e9b0a/posti-postinumeropalvelut-palvelukuvaus-ja-kayttoehdot-20150101.pdf`, directory `https://www.posti.fi/webpcode/`.

- URL: `https://www.posti.fi/webpcode/` is still live. It holds daily `PCF_<yyyymmdd>.zip` (postcode file), `BAF_*` (basic address file) and monthly `POM_*` (changes). The latest unzipped files are in `https://www.posti.fi/webpcode/unzip/`, for example `PCF_20261024.dat` (837 kB, 3,786 rows).
- Licence: Posti's own terms, not CC. The files are free to download without a contract, and onward sharing is allowed if the recipient gets the service description and terms with the data.
- Format: fixed-width records, ISO Latin-1. Each record holds postcode, postal locality (FI/SV), municipality code and name, and region.
- Needed? Not for phase 3. The rule "5-digit postcode next to a capitalised locality" works with a regex (`\b\d{5}\s+[A-ZÅÄÖ][a-zåäö-]+`) and a municipality list. Postal localities (for example `PYHÄNKOSKI`) differ from municipality names, so add PCF only if address recall on `tests/pii/` is below target, as the plan says.

### 6. Finnish hetu rules

Sources: `https://dvv.fi/en/personal-identity-code`, decree 128/2010 §2 at `https://www.finlex.fi/fi/lainsaadanto/2010/128`, DVV presentation `https://api.hankeikkuna.fi/asiakirjat/e4e7c20c-ab47-480e-b3da-353452c53a1a/72035ce5-c506-4e29-9383-8a865171e39e/KIRJE_20210430093605.PDF`.

- Form `DDMMYY` + separator + `NNN` + check character.
- Separators (decree text): "Välimerkkinä on 1 päivänä tammikuuta 2000 tai sen jälkeen syntyneillä kirjain A, B, C, D, E tai F, 1900-luvulla syntyneillä yhdysmerkki (-) tai kirjain Y, X, W, V tai U, ja 1800-luvulla syntyneillä plusmerkki (+)."
- Individual number: odd for men, even for women. DVV: "all individual numbers issued are between 002 and 899". DVV presentation: "9-alkuiset eivät virallisia tunnuksia (testikäyttöön)". So `900–999` are not official codes; they are used for testing and as temporary codes in some systems (python-stdnum `stdnum.fi.hetu` has `allow_temporary` for 900–999). The detector must accept 002–999. Surrogates in 900–999 can never equal a real permanent code.
- Check character: `int(DDMMYYNNN) % 31` indexes `0123456789ABCDEFHJKLMNPRSTUVWXY` (no G, I, O, Q, Z).
- Validator: reject `000` and `001`, validate the date with the century from the separator, upper-case before the lookup.

### 7. Finnish IBAN

Source: Finance Finland, `https://www.finanssiala.fi/wp-content/uploads/2026/04/finnish-monetary-institution-codes-16032026.pdf` (list dated 16.3.2026), index page `https://www.finanssiala.fi/en/topics/finnish-monetary-financial-institution-identifiers-and-bics/`.

- Format `FIkk` + 14-digit BBAN, 18 characters total, ISO 13616 mod-97 check (`kk`).
- Institution code length depends on the first digit: codes that start with `3` have 2 digits; `4`, `71`, `79` have 3 digits; `72`–`78` have 4 digits (since 2024); other codes have 1 digit. So the "first 3 digits" rule in the brief is wrong for most banks.
- Assigned (16.3.2026): `1`, `2` Nordea; `5` OP; `6` Ålandsbanken; `8`, `34` Danske; `33` SEB; `36`, `39` S-Bank; `37` DNB; `400–464`, `483–496` (part), `715` Savings banks; `405`, `497` Aktia; `470–479` POP; `713`, `714`, `717`, `718`, `719`, `792`–`797`, `799`.
- Unassigned in this list: leading `9` and leading `0` (no 1-digit code `9` or `0` exists). Recommendation: generate surrogate BBANs that start with `9`, with a valid domestic check digit and a valid mod-97. They pass format checks and do not route to a real bank. Re-check the list when it changes (the PDF says "updated whenever there are changes"). UNVERIFIED: that Finance Finland reserves `9` permanently; no reserved range is published. Confirm by asking Finance Finland if surrogates ever leave the system.

### 8. Finnish phone numbers

Source: Traficom regulation 32 V/2025 M, appendix 1 "Kansallinen numerointisuunnitelma", `https://www.traficom.fi/sites/default/files/media/regulation/M_32_V_2025.pdf` (in force from 2025-06-02).

- Prefixes: `+358` (drop the leading 0) or national `0`.
- Mobile area codes: `040`, `041`, `042`, `0430`–`0434` (5-digit), `0435`–`0439`, `044`, `045x`, `046`, `0490`–`0494` (5-digit), `050`, `059xx`. Text: "Puhelu matkaviestinverkkoihin soitetaan valitsemalla 04-, 050- tai 059-alkuinen matkaviestinverkon suuntanumero".
- Landline area codes: `02` Turku–Pori, `03` Häme, `05` Kymi, `06` Vaasa, `08` Oulu, `09` and `019` Uusimaa, `013` North Karelia, `014` Central Finland, `015` Mikkeli, `016` Lapland, `017` Kuopio, `018` Åland. Nationwide subscriber numbers use `010`, `020`, `029`, `030`, `0600`, `0700` (service numbers).
- Reserved ranges: `047` and `048` are mobile area codes "Liikenne- ja viestintäviraston numeroreservissä" (in Traficom's reserve, not assigned to any operator). `0495`–`0499` are also in reserve.
- No range for drama or fiction exists in the regulation. `040 123 4567` is a known example number that operators do not assign (`https://www.mtvuutiset.fi/artikkeli/miksei-kenenkaan-puhelinnumero-ole-040-123-4567-tallainen-on-logiikka-kannykkanumeroiden-taustalla/8818278`), but that is a single number.
- Recommendation: surrogates `048 xxx xxxx` (mobile-shaped) and `+358 48 …`. Re-check the reserve status when Traficom publishes a new regulation 32.

### 9. Licence plates

Sources: `https://en.wikipedia.org/wiki/Vehicle_registration_plates_of_Finland`, `https://traficom.fi/en/drivers-and-vehicles/vehicle-registration/apply-special-registration-plate-your-vehicle`.

- Cars: 2–3 letters, a dash, 1–3 digits (`ABC-123`, personalised `AB-1`). The number never starts with 0. Letters A–Z and Å, Ä, Ö.
- Åland: `ÅL-` + up to 5 digits. Diplomatic: `CD-` + up to 4 digits, `C-` + up to 5 digits. Temporary: 2 letters + up to 4 digits. Export: 1 letter + up to 4 digits.
- 2025–2026: Traficom changed the shape of the letter Y on plates and added a T-class plate for tractor mopeds. No new character format was found. UNVERIFIED: a new series for 2026; Traficom's English page now redirects to the home page.
- Plan rule `[A-ZÅÄÖ]{2,3}-\d{1,3}` with context words covers cars and personalised plates. Tighten it to `\b[A-ZÅÄÖ]{2,3}-[1-9]\d{0,2}\b` and add `\bÅL-\d{1,5}\b`. Context words: `rekisterinumero`, `rekkari`, `kilpi`, `auto`, `ajoneuvo`.

### 10. Local embedding model for Finnish

Sources: Hugging Face model API and cards for `intfloat/multilingual-e5-small`, `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2`, `BAAI/bge-m3`, `Xenova/*`; fastembed 0.9.0 source (`text/pooled_embedding.py`, `text/text_embedding.py`).

| Model | Params | Dim | ONNX size (fp32 / int8) | Finnish evidence | No-PyTorch runtime |
| --- | --- | --- | --- | --- | --- |
| multilingual-e5-small | 118 M | 384 | 470 MB / 118 MB | Mr. TyDi fi MRR@10 57.7 (BM25: 28.8), model card | Node: `@huggingface/transformers` with `Xenova/multilingual-e5-small` (`model_quantized.onnx`). Python: fastembed `add_custom_model` (not built in). |
| paraphrase-multilingual-MiniLM-L12-v2 | 118 M | 384 | 470 MB / 118 MB | `fi` in card languages; trained for paraphrase similarity, no Finnish retrieval score on the card | fastembed built-in (0.22 GB); Node `Xenova/...` |
| bge-m3 | 568 M | 1024 | 2.2 GB / 568 MB | MIRACL includes fi (paper, arXiv 2402.03216) | Node `Xenova/bge-m3` int8. No official small variant exists. |

BGE-M3 is about 5 times larger and too slow for 4 vCPU per-chunk indexing. MiniLM is a symmetric paraphrase model, a weaker fit for query-to-passage recall. e5-small has a published Finnish retrieval score and needs the `query: ` / `passage: ` prefixes.

## Decision

Python 3.12 on `python:3.12-slim-trixie`, with `apt-get install libvoikko1 voikko-fi`. Pin the image by digest at build time.

| Package | Pin |
| --- | --- |
| fastapi | 0.143.3 |
| uvicorn | 0.54.0 |
| pydantic | 2.14.1 |
| presidio-analyzer | 2.2.364 |
| presidio-anonymizer | 2.2.364 |
| spacy | 3.8.16 |
| fi_core_news_lg | 3.8.0 (wheel URL in question 1) |
| libvoikko | 4.3 |
| omorfi | 0.10.0 |
| pyhfst | 1.4.0 |
| omorfi models | `omorfi-hfst-models-0.9.12.tar.xz` (GitHub release v0.9.12), checksum pinned in the Dockerfile |
| sqlcipher3 | 0.6.4 |
| phonenumbers | 9.0.41 |
| pytest | 9.1.1 |
| httpx | 0.28.1 |

Lock transitive dependencies (starlette, thinc, numpy, …) with a resolver cut-off of 2026-10-18 (for example `uv pip compile --exclude-newer 2026-10-18`).

Detection stack:

1. In-house validators for hetu (rules in question 6), FI IBAN, FI phone (via `phonenumbers`, region `FI`), postcode regex, street regex, plates (question 9). Do not depend on Presidio's hetu recognizer. Register it only in the LiteLLM backstop, where its gaps do not matter.
2. Vault recognizer over `entity_form`.
3. DVV gazetteers (2026-08-04 release, CC BY 4.0, attribution in the UI about page), looked up on Voikko `BASEFORM`.
4. Presidio + spaCy `fi_core_news_lg` 3.8.0 with the YAML in question 2.

Generation stack: Omorfi `omorfi.generate.hfst` through `pyhfst` precomputes all forms for known names (97.5% of DVV surname types). Suffix rules keyed on the Omorfi paradigm class handle names not in the lexicon. Surrogate names are drawn only from DVV names that Omorfi knows.

Surrogate ranges: hetu individual numbers 900–999; IBAN BBANs that start with `9`; phones in `048`.

Vault encryption: SQLCipher via `sqlcipher3==0.6.4`, key from `PSEUDO_VAULT_KEY` (`PRAGMA key`). One self-contained wheel, no system library, and the schema keeps its plain indexes (`PRIMARY KEY(side, form)`). AES-GCM per column with `cryptography` would need a separate keyed-hash index column for every lookup and rewrites of every query. That is more code for the same protection.

Embeddings (phases 4 and 8): `multilingual-e5-small`, int8 ONNX, run in Node with `@huggingface/transformers` 4.3.1 next to the sqlite-vec index. Phase 8 compares it with `paraphrase-multilingual-MiniLM-L12-v2` on 50 queries, as plan section 15 says.

## Consequences

- `pseudo-svc` contains GPL code (Omorfi GPL-3, voikko-fi GPL-2+). It stays a separate container behind HTTP. Its image must ship with source if it is ever distributed.
- spaCy model is 3.8.0, not the 3.7 named in plan section 6. Update the plan.
- The plan's IBAN wording "first 3 digits" is replaced by the variable-length code rule in question 7.
- Presidio's phone recognizer needs `supported_regions=("FI",)`; its hetu recognizer must be added explicitly.
- Posti PCF is deferred until address recall is measured.
- fastapi lags `latest` by 19 minor versions on purpose; bump after 2026-10-30 as its own task.
- The image grows by about 220 MB (spaCy model) + 150 MB (Omorfi models unpacked) + 118 MB (embedding model, Node side).

## Verified on

2026-10-25, 05:26 UTC. PyPI JSON API, npm registry, GitHub API, Hugging Face API, `avoindata.suomi.fi` CKAN API, Debian sources API and Finlex were queried with curl. The Presidio, omorfi, pyhfst, libvoikko and fastembed wheels and the Omorfi models were downloaded and read, not executed. Omorfi lexicon coverage was computed from `src/lexemes.tsv` (main branch) against the DVV 2026-08-04 files. UNVERIFIED items: Omorfi generator output for a test name (question 3), permanent status of IBAN leading `9` (question 7), a 2026 plate series (question 9).
