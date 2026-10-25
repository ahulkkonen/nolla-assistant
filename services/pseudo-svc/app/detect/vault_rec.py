"""Layer 2: every real form stored in the vault, longest match first, case-sensitive."""

import re
from collections import defaultdict

from . import Candidate, trie_pattern
from .gazetteer import _sentence_start, common_word, place


def matcher(vault, user_id: str, side: str = "real"):
    """(compiled regex, form -> [(entity_id, part, analysis, kind)]) for one side of the vault, cached per version."""
    ver = vault.version.get(user_id, 0)
    cache = vault.__dict__.setdefault("matchers", {})
    hit = cache.get((user_id, side))
    if hit and hit[0] == ver:
        return hit[1], hit[2]
    table = defaultdict(list)
    for form, eid, part, analysis, kind in vault.all_forms(user_id, side):
        table[form].append((eid, part, analysis, kind))
    rx = re.compile(r"(?<![\w-])(?:" + trie_pattern(table) + r")(?![\w])") if table else None
    cache[(user_id, side)] = (ver, rx, table)
    return rx, table


def detect(text: str, ctx) -> list[Candidate]:
    rx, table = matcher(ctx.vault, ctx.user_id)
    if not rx:
        return []
    hits = []
    for m in rx.finditer(text):
        opts = table[m.group(0)]
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

    return [c for c in out if not (c.kind == "PERSON" and len(c.parts) == 1 and c.parts[0]["part"] == "last"
                                   and (place(c.surface) or ordinary(c)))]
