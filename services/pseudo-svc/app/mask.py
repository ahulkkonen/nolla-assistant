"""mask / unmask / scan pipelines. Offsets here are Python code points; the API converts to UTF-16."""

import logging
import re
from dataclasses import dataclass

from . import forms
from .detect import codes, gazetteer, ner, trie_pattern, vault_rec
from .detect.codes import SUFFIX_CASE, STREET_RE
from .detect.resolve import PENDING_BELOW, resolve
from .surrogate import ensure_self, get_or_create_entity, part_kind, surrogate_form

log = logging.getLogger("pseudo")
FULL = (codes, vault_rec, gazetteer, ner)
FAST = (codes, vault_rec)


MAX_DEPTH, MAX_NODES, MAX_TEXT = 32, 20000, 200_000


class TooLarge(ValueError):
    """JSON body deeper or bigger than the limits (HTTP 413)."""


def u16(text: str, spans: list[dict]) -> list[dict]:
    """Rewrite start/end from code points to UTF-16 code units (the contract's unit) in place.
    One O(n) pass over the text, only when it has characters outside the BMP."""
    if text.isascii() or all(ord(ch) < 0x10000 for ch in text):
        return spans
    cum, n = [0], 0
    for ch in text:
        n += 2 if ord(ch) > 0xFFFF else 1
        cum.append(n)
    for s in spans:
        s["start"], s["end"] = cum[s["start"]], cum[s["end"]]
    return spans


@dataclass
class Ctx:
    vault: object
    user_id: str
    session_id: str | None = None


def walk(value, fn, path=()):
    """Apply fn(str, path) -> (str, spans) to every string in a JSON value; keys stay as they are.
    Raises TooLarge past MAX_DEPTH levels or MAX_NODES values."""
    nodes = 0

    def go(v, path):
        nonlocal nodes
        nodes += 1
        if nodes > MAX_NODES or len(path) > MAX_DEPTH:
            raise TooLarge("json too large")
        if isinstance(v, str):
            if len(v) > MAX_TEXT:
                raise TooLarge("string too long")
            return fn(v, list(path))
        spans = []
        if isinstance(v, list):
            out = []
            for i, x in enumerate(v):
                o, sp = go(x, (*path, i))
                out.append(o)
                spans += sp
            return out, spans
        if isinstance(v, dict):
            out = {}
            for k, x in v.items():
                out[k], sp = go(x, (*path, k))
                spans += sp
            return out, spans
        return v, []

    return go(value, tuple(path))


def _case(c, part: dict) -> str | None:
    if part.get("case"):
        return part["case"]
    surface = c.surface[part["start"] - c.start:part["end"] - c.start]
    return forms.case_of(surface, part["lemma"], part_kind(part["part"]))


def _pieces(vault, user_id: str, c, e) -> list[tuple[int, int, str]]:
    """(start, end, replacement) regions inside candidate c."""
    if e["kind"] == "SELF" or e["surrogate_mode"] == "placeholder":
        return [(c.start, c.end, e["surrogate"])]
    if e["kind"] == "PERSON" and c.parts:
        out = []
        for p in c.parts:
            case = _case(c, p)
            surface = c.surface[p["start"] - c.start:p["end"] - c.start]
            if case is None:  # unknown inflection: learn the real form, send the nominative
                vault.add_forms(user_id, e["id"], "real", [(surface, "NOM", p["part"])])
            out.append((p["start"], p["end"], surrogate_form(e, p["part"], case)))
        return out
    if e["kind"] == "ADDRESS":
        m = STREET_RE.match(c.surface)
        case = f"S{SUFFIX_CASE[m.group(2)][1]}" if m else None
        return [(c.start, c.end, surrogate_form(e, "", case) + (c.surface[m.end(3):] if m else ""))]
    return [(c.start, c.end, e["surrogate"])]


def _surrogate_cover(vault, user_id: str, session_id: str | None, text: str) -> list[tuple[int, int]]:
    """Regions of text that are surrogates: code surrogates, and name or address forms of entities with
    a span in this session, unless the form is also someone's real form. A surrogate-shaped name from elsewhere may be
    a real person with the same name, so it is masked."""
    rx, table, _, _ = _surrogates(vault, user_id)
    if not rx or not session_id:
        return []
    _, real = vault_rec.matcher(vault, user_id)
    hits = [(m, *table[m.group(0)][0][::3]) for m in rx.finditer(text) if m.group(0) not in real]
    seen = vault.last_seen(session_id, list({eid for _, eid, _ in hits})) if hits else {}
    # code surrogates come from ranges no real code uses (hetu 900-999, IBAN 9..., phone 048): always skip
    return [(m.start(), m.end()) for m, eid, kind in hits if eid in seen or kind not in ("PERSON", "ADDRESS")]


def _covered(c, cover: list[tuple[int, int]], text: str) -> bool:
    """Every non-space character of c lies in a surrogate region: "Juha Laaksonen" from an earlier
    mask stays as it is, but "Olavi Mäkinen" with only "Olavi" a surrogate is masked."""
    inside = [(max(s, c.start), min(e, c.end)) for s, e in cover if s < c.end and c.start < e]
    if not inside:
        return False
    pos = c.start
    for s, e in sorted(inside):
        if text[pos:s].strip():
            return False
        pos = max(pos, e)
    return not text[pos:c.end].strip()


def mask_text(vault, user_id: str, session_id: str, text: str, path=None, layers=FULL):
    ctx = Ctx(vault, user_id, session_id)

    def detect():
        cover = _surrogate_cover(vault, user_id, session_id, text)  # per pass: new real forms count
        cands = [c for layer in layers for c in layer.detect(text, ctx)]
        cands = resolve([c for c in cands if not _covered(c, cover, text)], vault.never_detect(user_id))
        return cands, [vault.entity(user_id, c.entity_id) if c.entity_id else
                       get_or_create_entity(vault, user_id, c.kind, c.canonical, c.surface) for c in cands]

    ver = vault.version.get(user_id)
    cands, ents = detect()
    if vault.version.get(user_id) != ver and vault_rec in layers:
        # new people: let the vault find their later mentions (Marja Saari ... Marjan); first-pass spans stay
        extra = [(c, e) for c, e in zip(*detect()) if not any(c.start < d.end and d.start < c.end for d in cands)]
        pairs = sorted([*zip(cands, ents), *extra], key=lambda ce: ce[0].start)
        cands, ents = [c for c, _ in pairs], [e for _, e in pairs]
    out, spans, pos, n = [], [], 0, 0  # n: running length of the masked output
    for c, e in zip(cands, ents):
        if e is None or e["allowlisted"]:
            continue
        out.append(text[pos:c.start])
        n += c.start - pos
        cur, piece = c.start, []
        for s, t, rep in _pieces(vault, user_id, c, e):
            piece += [text[cur:s], rep]
            cur = t
        piece.append(text[cur:c.end])
        surrogate = "".join(piece)
        out.append(surrogate)
        pos = c.end
        pending = c.score < PENDING_BELOW and not e["confirmed"]
        span = dict(start=n, end=n + len(surrogate), entity_id=e["id"], kind=e["kind"], surrogate=surrogate,
                    real_form=c.surface, detector=c.detector, score=round(c.score, 3), pending=pending)
        n += len(surrogate)
        if path is not None:
            span["path"] = path
        spans.append(span)
        if pending:
            vault.pending_add(user_id, session_id, c, e["id"])
    out.append(text[pos:])
    if spans and session_id:
        vault.record_spans(user_id, session_id, None, spans)
    masked = "".join(out)
    return masked, u16(masked, spans)


def mask(vault, user_id: str, session_id: str, text=None, json=None):
    ensure_self(vault, user_id)
    if text is not None:
        return mask_text(vault, user_id, session_id, text)
    return walk(json, lambda s, p: mask_text(vault, user_id, session_id, s, p))


def _surrogates(vault, user_id: str):
    """Surrogate matcher plus the unresolved-stem regex and the proper-prefix set, cached per vault version."""
    rx, table = vault_rec.matcher(vault, user_id, "surrogate")
    cache = vault.__dict__.setdefault("matchers", {})
    ver = vault.version.get(user_id, 0)
    hit = cache.get((user_id, "extra"))
    if hit and hit[0] == ver:
        return rx, table, hit[1], hit[2]
    stems = set()
    for form, opts in table.items():
        if any(o[3] == "PERSON" and o[2] == "NOM" for o in opts) and form[:1].isupper():
            stem = form[:-3] if form.endswith("nen") else form[:-1]
            if len(stem) >= 3:
                stems.add(stem)
    stem_rx = re.compile(r"(?<![\w-])(?:" + trie_pattern(stems) + r")\w+") if stems else None
    prefixes = {f[:i] for f in table for i in range(1, len(f))}
    cache[(user_id, "extra")] = (ver, stem_rx, prefixes)
    return rx, table, stem_rx, prefixes


def unmask_text(vault, user_id: str, text: str, path=None):
    rx, table, stem_rx, _ = _surrogates(vault, user_id)
    out, spans, pos, ents = [], [], 0, {}
    n = 0  # running length of the restored output
    for m in rx.finditer(text) if rx else ():
        eid, part, analysis, kind = table[m.group(0)][0]
        e = ents.get(eid) or ents.setdefault(eid, vault.entity(user_id, eid))
        if e is None:
            continue
        real = vault.real_form(eid, part, analysis) if part not in ("all", "self") else None
        real = real or (e["canonical"] if not (kind == "SELF" and e["canonical"] == "self") else m.group(0))
        gap = text[pos:m.start()]
        out += [gap, real]
        start = n + len(gap)
        n = start + len(real)
        pos = m.end()
        prev = spans[-1] if spans else None
        if prev and prev["entity_id"] == eid and gap == " " and prev["end"] == start - 1:
            prev["end"], prev["surrogate_form"] = n, f'{prev["surrogate_form"]} {m.group(0)}'
            continue  # "Juha Laaksoselle" is one span
        span = dict(start=start, end=n, entity_id=eid, surrogate_form=m.group(0))
        if path is not None:
            span["path"] = path
        spans.append(span)
    out.append(text[pos:])
    restored = "".join(out)
    unresolved = []
    if stem_rx:
        covered = [(s["start"], s["end"]) for s in spans]
        for m in stem_rx.finditer(restored):
            if m.group(0) not in table and not any(m.start() < e and s < m.end() for s, e in covered):
                u = dict(start=m.start(), end=m.end(), form=m.group(0))
                if path is not None:
                    u["path"] = path
                unresolved.append(u)
    return restored, u16(restored, spans), u16(restored, unresolved)


def unmask(vault, user_id: str, text=None, json=None):
    if text is not None:
        restored, spans, unresolved = unmask_text(vault, user_id, text)
        return restored, spans, unresolved, hold(vault, user_id, text)
    unresolved = []

    def fn(s, p):
        r, sp, un = unmask_text(vault, user_id, s, p)
        unresolved.extend(un)
        return r, sp

    restored, spans = walk(json, fn)
    return restored, spans, unresolved, 0


def hold(vault, user_id: str, text: str) -> int:
    """Length (UTF-16 units) of the longest suffix of text that is a proper prefix of a surrogate form."""
    _, _, _, prefixes = _surrogates(vault, user_id)
    if not prefixes:
        return 0
    longest = max(map(len, prefixes))
    for n in range(min(longest, len(text)), 0, -1):
        if text[-n:] in prefixes:
            return len(text[-n:].encode("utf-16-le")) // 2
    return 0


def scan(vault, user_id: str, session_id: str, messages: list[dict]):
    """Mask real values left in outgoing messages (vault + codes only) and report them as leaks.
    Surrogates are skipped by mask_text itself."""
    out, leaked = [], []
    for i, msg in enumerate(messages):
        content, spans = walk(msg.get("content"), lambda s, p: mask_text(vault, user_id, session_id, s, p, FAST))
        for s in spans:
            leak = dict(message_index=i, start=s["start"], end=s["end"], kind=s["kind"], entity_id=s["entity_id"])
            if s.get("path"):
                leak["path"] = s["path"]
            leaked.append(leak)
        out.append({**msg, "content": content})
    if leaked:
        log.warning("scan leaked=%d kinds=%s", len(leaked), sorted({x["kind"] for x in leaked}))
    return out, leaked
