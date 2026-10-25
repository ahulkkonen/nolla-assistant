"""Merge candidates from all layers into non-overlapping spans (plan section 6 order)."""

from . import Candidate
from .gazetteer import lemmas, names

LAYER = {"codes": 0, "vault": 1, "gazetteer": 2, "ner": 3}
PENDING_BELOW = 0.6


def person_parts(c: Candidate) -> list[dict]:
    """Split a full name into first and last names with gazetteer lemmas (NER spans have no parts)."""
    import re

    toks = list(re.finditer(r"\S+", c.surface))
    db = names()
    parts = []
    for i, m in enumerate(toks):
        w = m.group(0).strip(".,:;!?()\"'")
        lem = lemmas(w)
        if len(toks) > 1:
            part = "last" if i == len(toks) - 1 else "first"
        else:
            part = "first" if any(k == "first" for _, k in lem) and w not in db["last"] else "last"
        lemma = next((l for l, k in lem if k == part), lem[0][0] if lem else w)
        parts.append(dict(start=c.start + m.start(), end=c.start + m.start() + len(w), part=part, lemma=lemma))
    return parts


def resolve(cands: list[Candidate], never: set[tuple[str, str]]) -> list[Candidate]:
    for c in cands:
        if c.kind == "PERSON" and not c.parts:
            c.parts = person_parts(c)
            c.canonical = " ".join(p["lemma"] for p in c.parts)
    cands = [c for c in cands if (c.kind, c.canonical) not in never]
    # codes first, then longer spans, then layer order: first match wins per span, longer wins on overlap
    cands.sort(key=lambda c: (LAYER[c.detector] != 0, -(c.end - c.start), LAYER[c.detector], c.start))
    taken: list[Candidate] = []
    for c in cands:
        if not any(c.start < t.end and t.start < c.end for t in taken):
            taken.append(c)
    return sorted(taken, key=lambda c: c.start)
