"""mask / unmask / scan pipelines. Offsets here are Python code points; the API converts to UTF-16."""

import logging
import re
from dataclasses import dataclass

from . import forms
from .detect import codes, gazetteer, ner, trie_pattern, vault_rec
from .detect.codes import SUFFIX_CASE, STREET_RE, email_case
from .detect.gazetteer import cap
from .detect.resolve import PENDING_BELOW, resolve
from .surrogate import ensure_self, get_or_create_entity, part_kind, person_parts, surrogate_form, upgrade_first

log = logging.getLogger("pseudo")
FULL = (codes, vault_rec, gazetteer, ner)
FAST = (codes, vault_rec)
# kinds whose surrogates look like real values (a real person can have the name, the address, the gmail
# address); code surrogates come from ranges no real code uses (hetu 900-999, IBAN 9..., phone 048)
REALISH = ("PERSON", "ADDRESS", "EMAIL")


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
    only: tuple[int, ...] | None = None  # vault layer: match only these entities (ad-hoc matcher)
    lower: bool = False  # plain text: also lower-case names (users type them on phones)


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
    return forms.case_of(cap(surface), part["lemma"], part_kind(part["part"]))


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
                vault.add_forms(user_id, e["id"], "real", [(cap(surface), "NOM", p["part"])])
            out.append((p["start"], p["end"], surrogate_form(e, p["part"], case)))
        return out
    if e["kind"] == "ADDRESS":
        m = STREET_RE.match(c.surface[:1].upper() + c.surface[1:])
        case = f"S{SUFFIX_CASE[m.group(2)][1]}" if m else None
        return [(c.start, c.end, surrogate_form(e, "", case) + (c.surface[m.end(3):] if m else ""))]
    if e["kind"] == "EMAIL":  # x@firma.fi:hin -> y@example-3.invalid:iin; an unknown ending stays as typed
        base, case = email_case(c.surface)
        return [(c.start, c.end, surrogate_form(e, "", case) if case else e["surrogate"] + c.surface[len(base):])]
    return [(c.start, c.end, e["surrogate"])]


def _surrogate_cover(vault, user_id: str, session_id: str | None, text: str,
                     user_input: bool = False) -> list[tuple[int, int]]:
    """Regions of text that are surrogates: code surrogates, and name, address or email forms of entities with
    a span in this session, unless the form is also someone's real form. A surrogate-shaped name from elsewhere may be
    a real person with the same name, so it is masked. User input covers code surrogates only: the user
    sees real values, so a name there is never an echo (phase-12 decision 6)."""
    rx, table = vault_rec.matcher(vault, user_id, "surrogate")
    if not rx or not session_id:
        return []
    _, real = vault_rec.matcher(vault, user_id)
    hits = [(m, *table[m.group(0)][0][::3]) for m in rx.finditer(text) if m.group(0) not in real]
    # an address at an .invalid domain (RFC 2606) can never be real: covered like a code surrogate
    codes_only = [(m.start(), m.end()) for m, _, kind in hits if kind not in REALISH or ".invalid" in m.group(0)]
    if user_input:
        return codes_only
    seen = vault.last_seen(session_id, list({eid for _, eid, _ in hits})) if hits else {}
    return codes_only + [(m.start(), m.end()) for m, eid, kind in hits if eid in seen and kind in REALISH]


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


def _echo(vault, user_id: str, session_id: str | None, cands: list) -> list:
    """New people whose every name part is a surrogate name this session has seen: the model echoing a
    surrogate in a form the surrogate table lacks (lower case, an unlisted inflection). They keep the
    surrogate; masking them would issue a second one."""
    new = [c for c in cands if c.kind == "PERSON" and not c.entity_id and c.parts]
    names = vault.session_surrogate_names(user_id, session_id) if new and session_id else set()
    return [c for c in new if names and all(p.get("lemma") in names for p in c.parts)]


def _surrogate_index(vault, user_id: str):
    """(kind, part, base form) -> entity ids over the base surrogate forms, plus the number of name parts per
    entity; cached per vault version."""
    cache = vault.__dict__.setdefault("matchers", {})
    ver = vault.version.get(user_id, 0)
    hit = cache.get((user_id, "bases"))
    if hit and hit[0] == ver:
        return hit[1], hit[2]
    index, nparts = {}, {}
    for form, part, eid, kind, canonical in vault.surrogate_bases(user_id):
        key = (kind, part_kind(part), form) if kind == "PERSON" else (kind, "", form.lower())
        index.setdefault(key, set()).add(eid)
        if kind == "PERSON":
            nparts[eid] = len(person_parts(canonical))
    cache[(user_id, "bases")] = (ver, index, nparts)
    return index, nparts


def _owner(vault, user_id: str, c) -> int | None:
    """The entity whose whole surrogate the new mention c equals: every name part, or the address or email.
    None for a mention of a known real value (a later mention of someone accepted as new)."""
    if c.entity_id or c.kind not in REALISH or vault.find(user_id, ("PERSON", "SELF") if c.kind == "PERSON"
                                                           else (c.kind,), c.canonical):
        return None
    index, nparts = _surrogate_index(vault, user_id)
    if c.kind != "PERSON":
        return min(index.get((c.kind, "", c.canonical.lower()), ()), default=None)
    if not c.parts:
        return None
    ids = set.intersection(*[index.get(("PERSON", part_kind(p["part"]), cap(p.get("lemma") or "")), set())
                             for p in c.parts])
    return min((e for e in ids if nparts.get(e) == len(c.parts)), default=None)


def _collisions(vault, user_id: str, session_id: str, cands: list) -> tuple[list[dict], list]:
    """User input equal to an issued surrogate is a different real person or value with the same name or
    address (phase-12 decisions 6 and 7). Each one is parked in the pending lane; the caller fails the turn closed.
    A mention the user said is that entity (rejected) stays as it is: it is that entity's surrogate. Its span
    is recorded, so the session counts the entity as seen and the model's echoes in tool results keep it."""
    found, keep = [], []
    for c in cands:
        eid = _owner(vault, user_id, c)
        status = vault.collision_status(user_id, eid, c.surface) if eid else None
        if eid is None or status == "accepted":
            keep.append(c)
        elif status == "rejected":
            vault.record_spans(user_id, session_id, None, [dict(start=c.start, end=c.end, entity_id=eid,
                                                                surrogate=c.surface, detector="collision", score=1.0)])
        else:
            pid = vault.pending_add(user_id, session_id, c, eid, reason="collision")
            found.append(dict(pending_id=pid, entity_id=eid, kind=c.kind))
    return found, keep


def _entities(vault, user_id: str, session_id: str | None, cands: list) -> list:
    """Vault rows for the candidates. A lone first name or surname of a full name found in the same text
    is that person (Liisa Kallion ... Liisalle), not a new one. A full name whose first name alone is an
    entity upgrades that entity (upgrade_first)."""
    ents, by_part = {}, {}
    for c in sorted(cands, key=lambda c: -len(c.parts)):
        if c.entity_id:
            e = vault.entity(user_id, c.entity_id)  # None when merged away meanwhile: skipped later
        elif c.kind == "PERSON" and len(c.parts) == 1 and (c.parts[0]["part"], c.parts[0].get("lemma")) in by_part:
            e = by_part[(c.parts[0]["part"], c.parts[0].get("lemma"))]
        else:
            e = (c.kind == "PERSON" and len(c.parts) == 2 and upgrade_first(vault, user_id, session_id, c.canonical)) \
                or get_or_create_entity(vault, user_id, c.kind, c.canonical, c.surface)
        if c.kind == "PERSON" and len(c.parts) > 1 and not c.entity_id:
            by_part.update({(p["part"], p.get("lemma")): e for p in c.parts})
        ents[id(c)] = e
    return [ents[id(c)] for c in cands]


def mask_text(vault, user_id: str, session_id: str, text: str, path=None, layers=FULL, lower=False,
              collisions: list | None = None):
    """`collisions` (a list) marks user input: names equal to issued surrogates are checked, appended there, and
    a text with any comes back empty and unrecorded (the turn fails closed until the user answers)."""
    ctx = Ctx(vault, user_id, session_id, lower=lower)

    cover = _surrogate_cover(vault, user_id, session_id, text, collisions is not None)

    def resolved(cands):
        return resolve([c for c in cands if not _covered(c, cover, text)], vault.never_detect(user_id))

    cands = resolved([c for layer in layers for c in layer.detect(text, ctx)])
    if collisions is None:
        echo = _echo(vault, user_id, session_id, cands)
        cands = [c for c in cands if c not in echo]
    else:
        found, cands = _collisions(vault, user_id, session_id, cands)
        if found:
            collisions.extend(found)
            return "", []
    ents = _entities(vault, user_id, session_id, cands)
    new = tuple(dict.fromkeys(e["id"] for c, e in zip(cands, ents) if not c.entity_id))
    if new and vault_rec in layers:
        # new people: let the vault find their later mentions (Marja Saari ... Marjan); first-pass spans stay.
        # Only the new entities are matched, with a small ad-hoc regex.
        later = resolved(vault_rec.detect(text, Ctx(vault, user_id, session_id, new, lower)))
        extra = [(c, vault.entity(user_id, c.entity_id)) for c in later
                 if not any(c.start < d.end and d.start < c.end for d in cands)]
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
    if text is not None:  # plain text (user input, titles, memory): lower-case names too
        return mask_text(vault, user_id, session_id, text, lower=True)
    # JSON (tool results) carries code, paths and English: capitalised names only
    return walk(json, lambda s, p: mask_text(vault, user_id, session_id, s, p))


def mask_input(vault, user_id: str, session_id: str, text: str):
    """What the user typed (the extension's `input` hook): plain text plus the collision check.
    Returns (masked, spans, collisions); with collisions, masked is empty and nothing is recorded."""
    ensure_self(vault, user_id)
    collisions: list[dict] = []
    masked, spans = mask_text(vault, user_id, session_id, text, lower=True, collisions=collisions)
    return masked, spans, collisions


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
    Surrogates are skipped by mask_text itself. Lower-case names only in user messages (plain text)."""
    out, leaked = [], []
    for i, msg in enumerate(messages):
        lower = msg.get("role") == "user"
        content, spans = walk(msg.get("content"), lambda s, p: mask_text(vault, user_id, session_id, s, p, FAST, lower))
        for s in spans:
            leak = dict(message_index=i, start=s["start"], end=s["end"], kind=s["kind"], entity_id=s["entity_id"])
            if s.get("path"):
                leak["path"] = s["path"]
            leaked.append(leak)
        out.append({**msg, "content": content})
    if leaked:
        log.warning("scan leaked=%d kinds=%s", len(leaked), sorted({x["kind"] for x in leaked}))
    return out, leaked
