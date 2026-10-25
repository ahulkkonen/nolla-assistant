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
    """Regex alternation of literal words as a trie, so the longest match wins and matching stays fast.
    Built without recursion: a post-order walk with an explicit stack."""
    import re

    trie: dict = {}
    for w in words:
        node = trie
        for ch in w:
            node = node.setdefault(ch, {})
        node[""] = {}
    done: dict[int, str] = {}
    stack = [(trie, False)]
    while stack:
        node, expanded = stack.pop()
        kids = [(ch, sub) for ch, sub in sorted(node.items()) if ch]
        if not expanded:
            stack.append((node, True))
            stack.extend((sub, False) for _, sub in kids)
            continue
        alts = [re.escape(ch) + done.pop(id(sub)) for ch, sub in kids]
        end = "" in node
        if not alts:
            done[id(node)] = ""
        elif len(alts) == 1 and not end:
            done[id(node)] = alts[0]
        else:
            body = alts[0] if len(alts) == 1 and len(alts[0]) == 1 else "(?:" + "|".join(alts) + ")"
            done[id(node)] = body + ("?" if end else "")
    return done[id(trie)]
