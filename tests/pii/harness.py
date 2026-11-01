"""Score pseudo-svc `POST /mask` against tests/pii/corpus.jsonl (plan section 6 and section 14 gate 3).

Usage:
  PSEUDO_URL=http://pseudo-svc:8000 python3 -I tests/pii/harness.py
  python3 -I tests/pii/harness.py --dry-run     # validate the corpus, print counts, run the self-test

Writes tests/pii/last-run.json. Exit code 1 when a threshold fails or the corpus is invalid.
"""

import argparse
import importlib.util
import json
import os
import sys
import uuid
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
CODE_KINDS = {"HETU", "IBAN", "PHONE"}
# Gate (docs/decisions/phase-12-pseudo.md, raised in phase-33-recall.md to the measured floor, rounded down to a
# whole percent): recall per group, precision per predicted kind.
THRESHOLDS = {"codes": 1.0, "PERSON": 0.99, "EMAIL": 1.0, "ADDRESS": 1.0, "POSTCODE_CITY": 1.0}
PRECISION_MIN = {"PERSON": 0.99, "EMAIL": 1.0, "ADDRESS": 1.0, "POSTCODE_CITY": 1.0, "HETU": 1.0, "IBAN": 1.0,
                 "PHONE": 1.0}
# Not recall targets: brand names. A prediction that overlaps only these is a false positive.
NOT_TARGETS = {"ORG"}


def _validate_module():
    # -I does not put the script directory on sys.path, so load validate.py by path.
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location("pii_validate", HERE / "validate.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def u16len(s: str) -> int:
    return len(s.encode("utf-16-le")) // 2


def post(url: str, path: str, body: dict) -> dict:
    req = urllib.request.Request(url.rstrip("/") + path, data=json.dumps(body).encode(),
                                 headers={"content-type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def seed_vault(url: str, user_id: str, seed: list[dict]) -> str:
    """Register the vault-known people. The only place that knows the seed call.

    The phase-3 contract has no create-entity endpoint yet (`POST /vault/entity/{id}` only updates).
    Try `POST /vault/seed`; if the sidecar does not have it, fall back to ingesting one short
    sentence per person through `POST /mask`, which creates the entity the normal way.
    """
    try:
        post(url, "/vault/seed", {"user_id": user_id, "entities": seed})
        return "vault/seed"
    except urllib.error.HTTPError as e:
        if e.code not in (404, 405):
            raise
    for ent in seed:
        post(url, "/mask", {"user_id": user_id, "session_id": "pii-seed", "text": f"Muistiinpano: {ent['canonical']}."})
    return "mask-fallback"


def to_original(text: str, spans: list[dict]) -> list[dict]:
    """Map /mask spans (offsets in masked text) to offsets in the original text, in UTF-16 units."""
    out, shift = [], 0
    for s in sorted(spans, key=lambda s: s["start"]):
        real = s.get("real_form") or ""
        start = s["start"] - shift
        end = start + u16len(real)
        shift += (s["end"] - s["start"]) - u16len(real)
        out.append({"start": start, "end": end, "kind": s.get("kind", "?"),
                    "detector": s.get("detector", "?"), "pending": bool(s.get("pending")), "real_form": real,
                    "aligned": text.encode("utf-16-le")[start * 2:end * 2].decode("utf-16-le", "replace") == real})
    return out


def overlaps(a: dict, b: dict) -> bool:
    return a["start"] < b["end"] and b["start"] < a["end"]


def covered(text: str, gold: dict, preds: list[dict]) -> bool:
    """Every non-space character of the gold span lies inside a prediction. A partly masked value is a
    miss: "Carl von Hertzenin" with only "Carl" masked leaks the surname. For POSTCODE_CITY only the five
    digits count: the city stays by design (phase 3)."""
    if gold["kind"] == "POSTCODE_CITY":
        gold = {**gold, "end": gold["start"] + 5}
    inside = [(p["start"], p["end"]) for p in preds if overlaps(p, gold)]
    i = gold["start"]  # UTF-16 offset of ch
    for ch in surface(text, gold):
        if not ch.isspace() and not any(s <= i and i + u16len(ch) <= e for s, e in inside):
            return False
        i += u16len(ch)
    return True


def score(recs: list[dict], preds: dict[str, list[dict]], known: set[str]) -> dict:
    """Recall per gold kind and group; precision per predicted kind and per detector.

    A gold span counts as found when predicted spans cover all of it (the kind does not have to match:
    what matters is that the value is masked); one that predictions only overlap is a partial miss. ORG
    gold spans are not recall targets; a prediction that only overlaps them or nothing is a false positive.
    """
    gold_tot, gold_hit = Counter(), Counter()
    pred_tot, pred_tp = Counter(), Counter()
    det_tot, det_tp, det_first = Counter(), Counter(), Counter()
    misses, false_pos, decoy_hits = [], [], []
    for r in recs:
        ps = preds.get(r["id"], [])
        targets = [s for s in r["spans"] if s["kind"] not in NOT_TARGETS]
        for g in targets:
            groups = [g["kind"]]
            if g["kind"] in CODE_KINDS:
                groups.append("codes")
            if g["kind"] == "PERSON":
                groups.append("vault_known_names" if g["ref"] in known else "unseen_names")
            hits = [p for p in ps if overlaps(p, g)]
            found = bool(hits) and covered(r["text"], g, hits)
            for k in groups:
                gold_tot[k] += 1
                gold_hit[k] += found
            if found:
                det_first[hits[0]["detector"]] += 1
            else:
                misses.append({"id": r["id"], "kind": g["kind"], "surface": surface(r["text"], g), "groups": groups,
                               "partial": bool(hits)})
        for p in ps:
            tp = any(overlaps(p, g) for g in targets)
            pred_tot[p["kind"]] += 1
            pred_tp[p["kind"]] += tp
            det_tot[p["detector"]] += 1
            det_tp[p["detector"]] += tp
            if not tp:
                false_pos.append({"id": r["id"], "kind": p["kind"], "detector": p["detector"],
                                  "surface": surface(r["text"], p),
                                  "non_target": any(overlaps(p, g) for g in r["spans"] if g["kind"] in NOT_TARGETS)})
            for d in r.get("decoys", []):
                if overlaps(p, d):
                    decoy_hits.append({"id": r["id"], "decoy_kind": d["kind"], "surface": surface(r["text"], d)})
    ratio = lambda a, b: round(a / b, 4) if b else None  # noqa: E731
    total_targets = sum(1 for r in recs for s in r["spans"] if s["kind"] not in NOT_TARGETS)
    gates = {k: (v, ratio(gold_hit[k], gold_tot[k])) for k, v in THRESHOLDS.items()}
    gates.update({f"precision {k}": (v, ratio(pred_tp[k], pred_tot[k])) for k, v in PRECISION_MIN.items()})
    return {
        "recall": {k: {"found": gold_hit[k], "total": gold_tot[k], "recall": ratio(gold_hit[k], gold_tot[k])} for k in sorted(gold_tot)},
        "precision_by_kind": {k: {"tp": pred_tp[k], "predicted": pred_tot[k], "precision": ratio(pred_tp[k], pred_tot[k])} for k in sorted(pred_tot)},
        "by_detector": {d: {"predicted": det_tot[d], "tp": det_tp[d], "precision": ratio(det_tp[d], det_tot[d]),
                            "gold_found_first": det_first[d], "recall_share": ratio(det_first[d], total_targets)} for d in sorted(det_tot)},
        "thresholds": {k: {"min": v, "value": got, "pass": got is not None and got >= v} for k, (v, got) in gates.items()},
        "misses": misses, "false_positives": false_pos, "decoy_hits": decoy_hits,
    }


def surface(text: str, span: dict) -> str:
    return text.encode("utf-16-le")[span["start"] * 2:span["end"] * 2].decode("utf-16-le", "replace")


def report(res: dict) -> None:
    print("recall (gold kind / group):")
    for k, v in res["recall"].items():
        print(f"  {k:18} {v['found']:4}/{v['total']:<4} {v['recall']}")
    print("precision (predicted kind):")
    for k, v in res["precision_by_kind"].items():
        print(f"  {k:18} {v['tp']:4}/{v['predicted']:<4} {v['precision']}")
    print("by detector:")
    for k, v in res["by_detector"].items():
        print(f"  {k:18} predicted {v['predicted']:4} precision {v['precision']}  recall share {v['recall_share']}")
    partial = sum(m["partial"] for m in res["misses"])
    print(f"false positives: {len(res['false_positives'])}  decoy hits: {len(res['decoy_hits'])}  "
          f"misses: {len(res['misses'])} (partly masked: {partial})")
    for k, v in res["thresholds"].items():
        print(f"  {'PASS' if v['pass'] else 'FAIL'} {k}: {v['value']} (min {v['min']})")


def self_test() -> None:
    text = "Soita Virtaselle numeroon 040-5562190."
    masked = "Soita Laaksoselle numeroon 050-0000000."
    spans = [{"start": 6, "end": 17, "real_form": "Virtaselle", "kind": "PERSON", "detector": "vault"},
             {"start": 27, "end": 38, "real_form": "040-5562190", "kind": "PHONE", "detector": "regex"}]
    assert masked[6:17] == "Laaksoselle" and masked[27:38] == "050-0000000"
    got = to_original(text, spans)
    assert [(p["start"], p["end"], p["aligned"]) for p in got] == [(6, 16, True), (26, 37, True)], got
    rec = {"id": "t1", "text": text, "tags": [], "spans": [
        {"start": 6, "end": 16, "kind": "PERSON", "canonical": "Virtanen", "ref": "Mikko Virtanen", "note": ""},
        {"start": 26, "end": 37, "kind": "PHONE", "canonical": "+358405562190", "note": ""}]}
    res = score([rec], {"t1": got}, {"Mikko Virtanen"})
    assert res["thresholds"]["codes"]["pass"] and res["thresholds"]["PERSON"]["pass"]
    assert res["recall"]["vault_known_names"]["recall"] == 1.0 and res["thresholds"]["precision PERSON"]["pass"]
    assert res["thresholds"]["EMAIL"]["value"] is None and not res["thresholds"]["EMAIL"]["pass"]
    assert score([rec], {"t1": got[:1]}, set())["recall"]["PHONE"]["recall"] == 0.0
    half = [{**got[0], "end": got[0]["end"] - 4}]  # "Virtas" of "Virtaselle": a partial mask is a miss
    res = score([rec], {"t1": half}, set())
    assert res["recall"]["PERSON"]["recall"] == 0.0 and res["misses"][0]["partial"]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dry-run", action="store_true", help="validate the corpus and print counts; no HTTP")
    ap.add_argument("--url", default=os.environ.get("PSEUDO_URL"))
    # A fresh vault user per run: entities from an earlier run would turn unseen names into vault hits.
    ap.add_argument("--user-id", default=f"pii-harness-{uuid.uuid4().hex[:8]}")
    args = ap.parse_args()

    val = _validate_module()
    recs, errors = val.load()
    errors += val.composition(recs)
    seed = json.loads((HERE / "vault-seed.json").read_text(encoding="utf-8"))
    known = {e["canonical"] for e in seed if e["kind"] == "PERSON"}
    people = Counter("vault_known" if s["ref"] in known else "unseen"
                     for r in recs for s in r["spans"] if s["kind"] == "PERSON")
    for e in errors:
        print("ERROR", e, file=sys.stderr)
    if errors:
        return 1

    if args.dry_run:
        self_test()
        kinds, dec, tags = val.counts(recs)
        print(f"corpus OK: {len(recs)} lines, {sum(kinds.values())} spans, {sum(dec.values())} decoys")
        print("spans per kind:", dict(sorted(kinds.items())))
        print("decoys per kind:", dict(sorted(dec.items())))
        print(f"PERSON mentions: vault-known {people['vault_known']}, unseen {people['unseen']}")
        print("self-test OK")
        return 0
    if not args.url:
        print("PSEUDO_URL is not set (or pass --url); use --dry-run to check the corpus only", file=sys.stderr)
        return 1

    seeded_via = seed_vault(args.url, args.user_id, seed)
    preds, unaligned = {}, []
    for r in recs:
        resp = post(args.url, "/mask", {"user_id": args.user_id, "session_id": f"pii-{r['id']}", "text": r["text"]})
        preds[r["id"]] = to_original(r["text"], resp.get("spans", []))
        unaligned += [{"id": r["id"], **p} for p in preds[r["id"]] if not p["aligned"]]
    res = score(recs, preds, known)
    report(res)
    if unaligned:
        print(f"WARNING: {len(unaligned)} returned spans do not align with real_form; check offsets", file=sys.stderr)
    (HERE / "last-run.json").write_text(json.dumps(
        {"url": args.url, "seeded_via": seeded_via, "lines": len(recs), "person_mentions": dict(people),
         "unaligned": unaligned, **res}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0 if all(v["pass"] for v in res["thresholds"].values()) else 1


if __name__ == "__main__":
    sys.exit(main())
