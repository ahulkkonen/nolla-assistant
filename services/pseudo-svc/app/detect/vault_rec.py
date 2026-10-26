"""Layer 2: every real form stored in the vault, longest match first, case-sensitive (plus lower-case name variants)."""

import re
from collections import defaultdict

from . import Candidate, trie_pattern
from .gazetteer import _sentence_start, common_word, place, plain_word

NAMES = ("PERSON", "SELF")
MAX_FORM = 256  # longer stored forms are never matched (bounds the trie)
compiles = 0  # full-vault matcher compiles (tests assert how many a request costs)


def _compile(table):
    return re.compile(r"(?<![\w-])(?:" + trie_pattern(table) + r")(?![\w])") if table else None


def matcher(vault, user_id: str, side: str = "real"):
    """(compiled regex, form -> [(entity_id, part, analysis, kind)]) for one side of the vault, cached per version.
    The real side also holds the lower-case variant of every name form (laura, aholan); detect() uses
    the variants only for plain text. Stored name forms are always capitalised, so a lower-case
    name key is always a variant."""
    ver = vault.version.get(user_id, 0)
    cache = vault.__dict__.setdefault("matchers", {})
    hit = cache.get((user_id, side))
    if hit and hit[0] == ver:
        return hit[1], hit[2]
    global compiles
    table = defaultdict(list)
    for form, eid, part, analysis, kind in vault.all_forms(user_id, side):
        if len(form) <= MAX_FORM:
            table[form].append((eid, part, analysis, kind))
            if side == "real" and kind in NAMES and form.lower() != form:
                table[form.lower()].append((eid, part, analysis, kind))
    compiles += 1
    rx = _compile(table)
    cache[(user_id, side)] = (ver, rx, table)
    return rx, table


class _Hit:
    def __init__(self, text: str, start: int, end: int):
        self.text, self.s, self.e = text, start, end

    def group(self, _=0) -> str:
        return self.text

    def start(self) -> int:
        return self.s

    def end(self) -> int:
        return self.e


class _Finder:
    """finditer() over a few entities' forms: a token scan for single-word forms (no regex compile, which
    dominates when a request brings many new people), a small regex for forms with spaces."""

    TOKEN = re.compile(r"(?<![\w-])\w[\w-]*")

    def __init__(self, table):
        self.words = {f for f in table if not re.search(r"\s", f)}
        self.multi = _compile({f: v for f, v in table.items() if f not in self.words})

    def finditer(self, text: str):
        hits = []
        for m in self.TOKEN.finditer(text):
            tok = m.group(0)
            while tok:
                if tok in self.words:
                    hits.append(_Hit(tok, m.start(), m.start() + len(tok)))
                    break
                tok = tok.rpartition("-")[0]  # "Virtanen-niminen": the form may end at a hyphen
        if self.multi:
            hits += [_Hit(m.group(0), m.start(), m.end()) for m in self.multi.finditer(text)]
        return sorted(hits, key=_Hit.start)


def scoped(vault, user_id: str, entity_ids) -> tuple:
    """Ad-hoc (finder, table) over the real forms of a few entities: finds the later mentions of
    people created in this request without recompiling the whole vault."""
    table = defaultdict(list)
    kinds = {i: vault.entity(user_id, i)["kind"] for i in entity_ids}
    for eid in entity_ids:
        for r in vault.forms_for(eid):
            if r["side"] == "real" and len(r["form"]) <= MAX_FORM:
                table[r["form"]].append((eid, r["part"], r["analysis"], kinds[eid]))
    return _Finder(table), table


def detect(text: str, ctx) -> list[Candidate]:
    rx, table = scoped(ctx.vault, ctx.user_id, ctx.only) if ctx.only else matcher(ctx.vault, ctx.user_id)
    if not rx:
        return []
    hits = []
    for m in rx.finditer(text):
        opts = table[m.group(0)]
        if m.group(0).islower() and opts[0][3] in NAMES and not (ctx.lower and plain_word(text, m.start(), m.end())):
            continue  # a lower-case variant: plain text only, never in a path or identifier
        recent = {}
        if len({o[0] for o in opts}) > 1 and ctx.session_id:
            recent = ctx.vault.last_seen(ctx.session_id, [o[0] for o in opts])
        # most recent referent in the session, else the newest entity
        opts = sorted(opts, key=lambda o: (recent.get(o[0], 0), o[0]), reverse=True)
        eid, part, analysis, kind = opts[0]
        hits.append((m, eid, part, analysis, kind))
    out: list[Candidate] = []
    for m, eid, part, analysis, kind in hits:
        prev = out[-1] if out else None
        # "Matti Virtaselle": adjacent parts of the same person become one candidate
        if prev and prev.entity_id == eid and kind in ("PERSON", "SELF") and text[prev.end:m.start()] == " ":
            prev.parts.append(dict(start=m.start(), end=m.end(), part=part, case=analysis))
            prev.end, prev.surface = m.end(), text[prev.start:m.end()]
            continue
        parts = [dict(start=m.start(), end=m.end(), part=part, case=analysis)]
        out.append(Candidate(m.start(), m.end(), kind, "", "vault", 1.0, m.group(0), parts, eid))
    # a lone surname that is also a place or, at sentence start, an ordinary word: Lahden kautta, Koski kuohui.
    # -nen surnames stay: their common-noun twin (virtanen, a small stream) is rare in running text.
    def ordinary(c) -> bool:
        lemma = ctx.vault.entity(ctx.user_id, c.entity_id)["canonical"].split()[-1]
        return not lemma.endswith("nen") and _sentence_start(text, c.start) and common_word(c.surface)

    def lone_lower(c) -> bool:  # "laine", "koski": a lower-case lone part that is an ordinary word
        return c.surface.islower() and len(c.parts) == 1 and common_word(c.surface)

    return [c for c in out if not (lone_lower(c) or c.kind == "PERSON" and len(c.parts) == 1 and c.parts[0]["part"] == "last"
                                   and (place(c.surface) or ordinary(c)))]
