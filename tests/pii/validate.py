"""Validate tests/pii/corpus.jsonl and print per-kind and per-tag counts.

Run: python3 -I tests/pii/validate.py  (exit code 1 on any error)
"""

import datetime
import json
import re
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
KINDS = {"PERSON", "HETU", "IBAN", "PHONE", "ADDRESS", "POSTCODE_CITY", "PLATE", "EMAIL", "ORG"}
HETU_CHARS = "0123456789ABCDEFHJKLMNPRSTUVWXY"
CENTURY = {"+": 1800, "-": 1900, "Y": 1900, "X": 1900, "W": 1900, "V": 1900, "U": 1900,
           "A": 2000, "B": 2000, "C": 2000, "D": 2000, "E": 2000, "F": 2000}
HETU_RE = re.compile(r"^(\d{2})(\d{2})(\d{2})([-+A-FU-Y])(\d{3})([0-9A-Y])$")
CASES = ["nominative", "genitive", "accusative", "partitive", "essive", "translative", "inessive",
         "elative", "illative", "adessive", "ablative", "allative", "abessive", "comitative", "instructive"]
SUFFIXES = ["katu", "tie", "kuja", "polku", "väylä", "kaari", "rinne", "raitti", "ranta", "tori", "aukio"]


def hetu_valid(code: str) -> bool:
    m = HETU_RE.match(code)
    if not m:
        return False
    dd, mm, yy, sep, nnn, chk = m.groups()
    try:
        datetime.date(CENTURY[sep] + int(yy), int(mm), int(dd))
    except ValueError:
        return False
    return 2 <= int(nnn) <= 999 and HETU_CHARS[int(dd + mm + yy + nnn) % 31] == chk


def iban_valid(iban: str) -> bool:
    if not re.fullmatch(r"[A-Z]{2}\d{2}[A-Z0-9]{8,30}", iban) or (iban[:2] == "FI" and len(iban) != 18):
        return False
    s = iban[4:] + iban[:4]
    return int("".join(str(int(c, 36)) for c in s)) % 97 == 1


def u16_slice(text: str, start: int, end: int) -> str:
    return text.encode("utf-16-le")[start * 2:end * 2].decode("utf-16-le")


def load(path: Path = HERE / "corpus.jsonl") -> tuple[list[dict], list[str]]:
    recs, errors, ids = [], [], set()
    for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        try:
            r = json.loads(line)
        except json.JSONDecodeError as e:
            errors.append(f"line {n}: bad JSON: {e}")
            continue
        rid = r.get("id", f"line {n}")
        if not isinstance(r.get("text"), str) or not isinstance(r.get("spans"), list) or not isinstance(r.get("tags"), list):
            errors.append(f"{rid}: missing text/spans/tags")
            continue
        if rid in ids:
            errors.append(f"{rid}: duplicate id")
        ids.add(rid)
        tlen = len(r["text"].encode("utf-16-le")) // 2
        marks = []
        for s in r["spans"] + r.get("decoys", []):
            if s.get("kind") not in KINDS:
                errors.append(f"{rid}: bad kind {s.get('kind')}")
            if not (0 <= s["start"] < s["end"] <= tlen):
                errors.append(f"{rid}: offsets {s['start']}-{s['end']} out of range")
                continue
            s["_surface"] = u16_slice(r["text"], s["start"], s["end"])
            if s["_surface"] != s["_surface"].strip():
                errors.append(f"{rid}: span has outer whitespace: {s['_surface']!r}")
            marks.append((s["start"], s["end"], s["_surface"]))
        marks.sort()
        for a, b in zip(marks, marks[1:]):
            if b[0] < a[1]:
                errors.append(f"{rid}: overlap {a[2]!r} / {b[2]!r}")
        for s in r["spans"]:
            if not s.get("canonical") or "note" not in s:
                errors.append(f"{rid}: span {s.get('_surface')!r} lacks canonical or note")
            if s["kind"] == "PERSON" and not s.get("ref"):
                errors.append(f"{rid}: PERSON span {s['_surface']!r} lacks ref")
            if s["kind"] == "HETU" and not (hetu_valid(s["canonical"]) and s["canonical"] == s["_surface"].upper()):
                errors.append(f"{rid}: invalid hetu span {s['_surface']}")
            if s["kind"] == "IBAN":
                compact = re.sub(r"[\s-]", "", s["_surface"]).upper()
                if not iban_valid(s["canonical"]) or not s["canonical"].endswith(compact):
                    errors.append(f"{rid}: invalid IBAN span {s['_surface']} -> {s['canonical']}")
        for d in r.get("decoys", []):
            if d["kind"] == "HETU" and hetu_valid(d["_surface"].upper()):
                errors.append(f"{rid}: hetu decoy {d['_surface']} is valid")
            if d["kind"] == "IBAN" and iban_valid(re.sub(r"\s", "", d["_surface"]).upper()):
                errors.append(f"{rid}: IBAN decoy {d['_surface']} is valid")
        if "no-pii" in r["tags"] and any(s["kind"] != "ORG" for s in r["spans"]):
            errors.append(f"{rid}: tagged no-pii but has PII spans")
        recs.append(r)
    return recs, errors


def composition(recs: list[dict]) -> list[str]:
    tags = Counter(t for r in recs for t in r["tags"])
    spans = [s for r in recs for s in r["spans"]]
    decoys = Counter(d["kind"] for r in recs for d in r.get("decoys", []))
    hetus = [s["canonical"] for s in spans if s["kind"] == "HETU"]
    fi = [s for s in spans if s["kind"] == "IBAN" and s["canonical"].startswith("FI")]
    need = {
        "lines == 562": len(recs) == 562,
        "oblique-name lines >= 60": sum(1 for r in recs if "inflected" in r["tags"] and any(s["kind"] == "PERSON" for s in r["spans"])) >= 60,
        "first-name-only >= 30": tags["first-name-only"] >= 30,
        "nickname >= 10": tags["nickname"] >= 10,
        "possessive and clitic present": tags["possessive"] >= 2 and tags["clitic"] >= 2,
        "HETU spans >= 30": len(hetus) >= 30,
        "temporary hetu >= 5": sum(900 <= int(h[7:10]) for h in hetus) >= 5,
        "every hetu separator": set("-AYXWVUBCDEF") <= {h[6] for h in hetus},
        "hetu decoys >= 5": decoys["HETU"] >= 5,
        "FI IBAN >= 20": len(fi) >= 20,
        "FI IBAN spaced >= 8": sum(" " in s["_surface"] for s in fi) >= 8,
        "FI IBAN as BBAN >= 4": sum(not s["_surface"].upper().startswith("FI") for s in fi) >= 4,
        "foreign IBAN >= 3": tags["iban-foreign"] >= 3,
        "PHONE >= 25": sum(s["kind"] == "PHONE" for s in spans) >= 25,
        "phone decoys >= 3": decoys["PHONE"] >= 3,
        "ADDRESS >= 30": sum(s["kind"] == "ADDRESS" for s in spans) >= 30,
        "POSTCODE_CITY >= 15": sum(s["kind"] == "POSTCODE_CITY" for s in spans) >= 15,
        "postcode decoys >= 5": decoys["POSTCODE_CITY"] >= 5,
        "PLATE >= 12": sum(s["kind"] == "PLATE" for s in spans) >= 12,
        "plate-with-context >= 8": tags["plate-with-context"] >= 8,
        "plate-no-context >= 4": tags["plate-no-context"] >= 4,
        "plate decoys >= 3": decoys["PLATE"] >= 3,
        "place-vs-surname >= 25": tags["place-vs-surname"] >= 25,
        "no-pii >= 20": tags["no-pii"] >= 20,
        "multi-entity >= 15": tags["multi-entity"] >= 15,
        "english-mixed >= 10": tags["english-mixed"] >= 10,
        "code-snippet >= 5": tags["code-snippet"] >= 5,
        "double-surname present": tags["double-surname"] > 0,
        "compound-name present": tags["compound-name"] > 0,
        "swedish-finnish present": tags["swedish-finnish"] > 0,
    }
    for suf in SUFFIXES:
        need[f"street-suffix-{suf}"] = tags[f"street-suffix-{suf}"] >= 2
    case_count = Counter(c for r in recs for c in CASES if c in r["tags"])
    case_count["nominative"] += sum(1 for s in spans if s["kind"] == "PERSON" and s["canonical"] == s["_surface"])
    for c in CASES:
        need[f"case {c} >= 2"] = case_count[c] >= 2
    return [f"composition: {k}" for k, ok in need.items() if not ok]


def counts(recs: list[dict]) -> tuple[Counter, Counter, Counter]:
    kinds = Counter(s["kind"] for r in recs for s in r["spans"])
    dec = Counter(d["kind"] for r in recs for d in r.get("decoys", []))
    tags = Counter(t for r in recs for t in r["tags"])
    return kinds, dec, tags


def main() -> int:
    recs, errors = load()
    errors += composition(recs)
    kinds, dec, tags = counts(recs)
    print(f"lines: {len(recs)}  spans: {sum(kinds.values())}  decoys: {sum(dec.values())}")
    print("spans per kind:")
    for k, v in sorted(kinds.items()):
        print(f"  {k:14} {v}")
    print("decoys per kind:")
    for k, v in sorted(dec.items()):
        print(f"  {k:14} {v}")
    print("lines per tag:")
    for k, v in sorted(tags.items()):
        print(f"  {k:28} {v}")
    for e in errors:
        print("ERROR", e, file=sys.stderr)
    print("OK" if not errors else f"FAILED: {len(errors)} errors")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
