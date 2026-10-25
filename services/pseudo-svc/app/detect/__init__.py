from dataclasses import dataclass, field


@dataclass
class Candidate:
    start: int
    end: int
    kind: str  # HETU IBAN PHONE EMAIL POSTCODE ADDRESS PLATE PERSON
    canonical: str
    detector: str
    score: float
    surface: str
    parts: list = field(default_factory=list)  # PERSON: [(start, end, 'first'|'last', lemma)]
    entity_id: int | None = None  # set by the vault recognizer


def trie_pattern(words) -> str:
    """Regex alternation of literal words as a trie, so the longest match wins and matching stays fast."""
    import re

    trie: dict = {}
    for w in words:
        node = trie
        for ch in w:
            node = node.setdefault(ch, {})
        node[""] = {}

    def emit(node) -> str:
        end = "" in node
        alts = [re.escape(ch) + emit(sub) for ch, sub in sorted(node.items()) if ch]
        if not alts:
            return ""
        body = alts[0] if len(alts) == 1 and len(alts[0]) == 1 else "(?:" + "|".join(alts) + ")"
        if len(alts) == 1 and not end:
            return alts[0]
        return body + ("?" if end else "")

    return emit(trie)
