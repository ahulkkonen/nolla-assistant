"""Surrogates (plan section 6) and the entity operations that create or change them."""

import bisect
import hashlib
import hmac
import os
import random
import re
from functools import lru_cache

from . import forms
from .detect.codes import (STREET_RE, STREET_SUFFIX, SUFFIX_CASE, SWEDISH, email_forms, hetu_check_char,
                           luhn_ok)
from .detect.gazetteer import names
from .vault import SurrogateConflict

PLACEHOLDER = {"PERSON": "henkilö", "HETU": "hetu", "IBAN": "tili", "PHONE": "puhelin", "EMAIL": "sähköposti",
               "ADDRESS": "osoite", "POSTCODE_CITY": "postinumero", "PLATE": "rekisterinumero"}
FAKE_STREETS = [
    "Pihlaja", "Vaahtera", "Kanerva", "Kataja", "Tuomi", "Haapa", "Lehmus", "Saarni", "Kotka", "Kurki",
    "Joutsen", "Kuovi", "Tikka", "Peippo", "Västäräkki", "Sinivuokko", "Kielo", "Apila", "Kaisla", "Ruoko",
    "Kallio", "Louhi", "Kivikko", "Lähde", "Puro", "Kaarna", "Tähkä", "Sarka", "Pelto", "Niitty",
    "Paja", "Mylly", "Sahan", "Veräjä", "Aitta", "Riihi", "Torppa", "Kehto", "Lyhty", "Purje",
]
FAKE_STREETS_SV = ["Björk", "Lind", "Ek", "Strand", "Sjö", "Berg", "Rönn", "Gran", "Asp", "Hag", "Kvarn", "Ström"]
FIRST_MIN, LAST_MIN = 300, 200
# Phase-12 decision 1: a surrogate first name + surname pair has fewer than PAIR_MAX estimated real holders,
# and a one-word surrogate (a lone first name or surname) comes from names with fewer than LONE_MAX holders.
PAIR_MAX, LONE_MAX = 5, 1000
# Webmail and ISP domains anyone can have an address at: an email surrogate keeps them (decision 10).
PUBLIC_MAIL = frozenset("""gmail.com googlemail.com hotmail.com hotmail.fi outlook.com outlook.fi live.com live.fi
msn.com yahoo.com yahoo.fi icloud.com me.com mac.com protonmail.com proton.me pm.me aol.com gmx.com gmx.net mail.com
yandex.com zoho.com elisanet.fi kolumbus.fi saunalahti.fi suomi24.fi luukku.com netti.fi pp.inet.fi inet.fi
dnainternet.net welho.com kotiposti.net mbnet.fi sci.fi jippii.fi surffi.net""".split())


def self_label() -> str:
    return os.environ.get("SELF_LABEL", "[sinä]")


def rng(vault, user_id: str, canonical: str, gen: int, attempt: int) -> random.Random:
    """Deterministic per vault: HMAC-SHA256 keyed with the vault's random secret, so a surrogate
    cannot be recomputed from a guessed real value without the vault."""
    msg = f"{user_id}\0{canonical}\0{gen}\0{attempt}".encode()
    h = hmac.new(vault.secret, msg, hashlib.sha256).digest()
    return random.Random(int.from_bytes(h[:8], "big"))


@lru_cache(maxsize=1)
def population() -> int:
    """Sum of the DVV surname counts. It leaves out names with fewer than 20 holders, so it is a lower bound
    of the people the counts describe, and a pair estimate made with it errs high."""
    return sum(names()["last"].values())


def pair_limit(first: str) -> float:
    """Surname count below which `first` + surname has fewer than PAIR_MAX estimated holders, with the names
    taken as independent: count(first) * count(last) / population < PAIR_MAX. The first-name counts include
    every given name, not only the first one, which also errs high."""
    c = names()["first"].get(first, (0, None))[0]
    return PAIR_MAX * population() / c if c else float("inf")


@lru_cache(maxsize=1)
def pools() -> dict:
    """bucket key -> (names, counts, cumulative weights), sorted by count ascending so that the names under
    a count limit are a prefix; keys from specific to general. A first name too common to pair with any
    pool surname (pair_limit <= LAST_MIN: Juhani, Maria) is left out."""
    raw: dict[tuple, list] = {}
    db = names()
    rows = [("first", n, c, g) for n, (c, g) in db["first"].items()
            if c >= FIRST_MIN and n.isalpha() and pair_limit(n) > LAST_MIN]
    rows += [("last", n, c, None) for n, c in db["last"].items() if c >= LAST_MIN and n.isalpha()]
    pre = {k: forms.table(k) for k in ("first", "last")}  # precomputed names only, when the tables exist
    rows = [r for r in rows if not pre[r[0]] or r[1] in pre[r[0]]]
    for kind, n, c, g in rows:
        cls, hv, gr = forms.classify(n, kind), forms.harmony(n), forms.grades(n, kind)
        for key in dict.fromkeys(keys(kind, g, cls, hv, gr)):
            raw.setdefault(key, []).append((n, c))
    out = {}
    for key, lst in raw.items():
        lst.sort(key=lambda nc: nc[1])
        acc, cum = 0, []
        for _, c in lst:
            acc += c
            cum.append(acc)
        out[key] = ([n for n, _ in lst], [c for _, c in lst], cum)
    return out


def pool_pairs() -> int:
    """Number of first name + surname pairs the pair rule allows (the pool size, logged at startup)."""
    firsts, _, _ = pools()[("first", None)]
    _, counts, _ = pools()[("last", None)]
    return sum(bisect.bisect_left(counts, pair_limit(f)) for f in firsts)


def keys(kind, g, cls, hv, gr) -> tuple:
    """Pool keys from narrow to wide: drop gradation, then harmony, then class, then gender."""
    return (kind, g, cls, hv, gr), (kind, g, cls, hv), (kind, g, cls), (kind, g), (kind, None)


WIDEN = 4  # pool levels make_surrogate tries before it falls back to placeholder mode


def pick_name(r: random.Random, kind: str, real: str, level: int = 0, below: float = float("inf")) -> str:
    """A pool name like `real` (gender, inflection class), weighted by its count, with fewer than `below` holders."""
    db = names()
    gender = db["first"].get(real, (0, None))[1] if kind == "first" else None
    cls, hv, gr = forms.classify(real, kind), forms.harmony(real), forms.grades(real, kind)
    for key in keys(kind, gender, cls, hv, gr)[level:]:
        pool = pools().get(key)
        k = bisect.bisect_left(pool[1], below) if pool else 0
        if k >= 3:
            return pool[0][bisect.bisect_right(pool[2], r.random() * pool[2][k - 1])]
    raise LookupError("no surrogate pool")


def pick_person(r: random.Random, parts: list[tuple[str, str]], level: int, keep: str | None = None) -> list[tuple[str, str]]:
    """Surrogate names per part. The surname is drawn under the pair limit of the first given name. `keep` is
    the surrogate first name to keep (an entity upgraded from a lone first name to a full name)."""
    out: list[tuple[str, str]] = []
    for part, lemma in parts:
        below = LONE_MAX if len(parts) == 1 else pair_limit(out[0][1]) if part == "last" else float("inf")
        out.append((part, keep if keep and part == "first" else pick_name(r, part_kind(part), lemma, level, below)))
    return out


def person_parts(canonical: str) -> list[tuple[str, str]]:
    toks = canonical.split()
    if len(toks) == 1:
        return [("first" if toks[0] in names()["first"] and toks[0] not in names()["last"] else "last", toks[0])]
    return [("first" if i == 0 else f"first{i + 1}", t) for i, t in enumerate(toks[:-1])] + [("last", toks[-1])]


def part_kind(part: str) -> str:
    return "last" if part == "last" else "first"


def name_rows(parts: list[tuple[str, str]]) -> list[tuple[str, str, str]]:
    return [(f, case, part) for part, lemma in parts for case, f in forms.generate_forms(lemma, part_kind(part)).items()]


def _ascii(s: str) -> str:
    return s.lower().translate(str.maketrans("äöåéü", "aoaeu"))


def _digits(r: random.Random, n: int) -> str:
    return "".join(str(r.randrange(10)) for _ in range(n))


def with_check(country: str, bban: str) -> str:
    n = int("".join(str(int(c, 36)) for c in bban + country + "00"))
    return f"{country}{98 - n % 97:02d}{bban}"


def luhn_complete(body: str) -> str:
    return next(body + d for d in "0123456789" if luhn_ok(body + d))


def street_forms(street: str) -> list[tuple[str, str]]:
    """'Pihlajakatu 17' -> [(form, 'S<i>')] for every case of the suffix class."""
    m = STREET_RE.fullmatch(street)
    if not m:
        return [(street, "S0")]
    cls = SUFFIX_CASE[m.group(2)][0]
    out = {}  # a Swedish name has one form for every case: keep the first
    for i, suf in enumerate(STREET_SUFFIX[cls].split()):
        out.setdefault(m.group(1) + suf + m.group(3), f"S{i}")
    return list(out.items())


def code_surrogate(r: random.Random, kind: str, canonical: str) -> str:
    if kind == "HETU":
        sep = canonical[6]
        century = 1800 if sep == "+" else 1900 if sep in "-YXWVU" else 2000
        yy = r.randrange(0, 26) if century == 2000 else r.randrange(100)
        date = f"{r.randrange(1, 29):02d}{r.randrange(1, 13):02d}{yy:02d}"
        num = str(r.randrange(900, 1000))
        return date + sep + num + hetu_check_char(date + num)
    if kind == "IBAN":
        if canonical[:2].isalpha():
            body = "9" + _digits(r, len(canonical) - 6)
            return with_check(canonical[:2], luhn_complete(body) if canonical[:2] == "FI" else body + _digits(r, 1))
        return luhn_complete("9" + _digits(r, 12))
    if kind == "PHONE":
        d = _digits(r, 7)
        return f"048 {d[:3]} {d[3:]}"
    if kind == "PLATE":
        letters, digits = canonical.split("-")
        if letters == "ÅL":
            return "ÅL-" + str(r.randrange(10 ** (len(digits) - 1), 10 ** len(digits)))
        abc = "ABCDEFGHIJKLMNOPRSTUVYZ"
        return "".join(r.choice(abc) for _ in letters) + "-" + str(r.randrange(10 ** (len(digits) - 1), 10 ** len(digits)))
    if kind == "POSTCODE_CITY":
        return canonical[0] + "99" + _digits(r, 2)
    if kind == "ADDRESS":
        m = STREET_RE.fullmatch(canonical)
        cls = SUFFIX_CASE[m.group(2)][0] if m else "katu"
        rest = m.group(3).strip() if m else "1"
        num = str(r.randrange(1, 60))
        tail = re.sub(r"^\d+", "", rest)  # keep the shape of "B 12" / "as 3"
        tail = re.sub(r"\d+", lambda x: str(r.randrange(1, 40)), tail)
        return f"{r.choice(FAKE_STREETS_SV if cls in SWEDISH else FAKE_STREETS).capitalize()}{cls} {num}{tail}"
    raise ValueError(kind)


def email_surrogate(vault, user_id: str, r: random.Random, canonical: str) -> str:
    """Name-shaped local part with two digits; a webmail domain stays, any other becomes example-N.invalid
    (RFC 2606: never a real domain), with N fixed per real domain for the user, so colleagues still share a
    domain. The local part skips the pair rule: the two digits already make the address rare."""
    domain = canonical.rsplit("@", 1)[1]
    local = f"{_ascii(pick_name(r, 'first', 'Anna'))}.{_ascii(pick_name(r, 'last', 'Virtanen'))}{r.randrange(10, 100)}"
    return f"{local}@{domain if domain in PUBLIC_MAIL else f'example-{vault.domain_number(user_id, domain)}.invalid'}"


def make_surrogate(vault, user_id: str, kind: str, canonical: str, gen: int, keep: str | None = None):
    """(surrogate, infl_class, surrogate_rows, mode) with forms unused by the user's other entities.
    Widens the name pool step by step; placeholder mode when nothing free is left. `keep`: see pick_person;
    the kept name's forms already belong to the entity, so only the new names must be free."""
    per_level = 15
    for attempt in range(per_level * WIDEN):
        r = rng(vault, user_id, canonical, gen, attempt)
        if kind == "PERSON":
            parts = person_parts(canonical)
            try:
                surr = pick_person(r, parts, attempt // per_level, keep)
            except LookupError:
                continue
            if any(s == lemma for (_, s), (_, lemma) in zip(surr, parts)):
                continue
            om = forms.omorfi()
            if om and not all(s in forms.table(part_kind(p)) or om.prefix(s, part_kind(p)) for p, s in surr):
                continue  # surrogates only from names Omorfi knows (0003)
            rows = name_rows(surr)
            text = " ".join(s for _, s in surr)
            infl = " ".join(f"{p}:{forms.classify(lemma, part_kind(p))}" for p, lemma in parts)
            if any(vault.real_taken(user_id, s) for _, s in surr):
                continue
        elif kind == "EMAIL":
            text, infl = email_surrogate(vault, user_id, r, canonical), None
            rows = [(f, c, "") for f, c in email_forms(text)]
        else:
            text, infl = code_surrogate(r, kind, canonical), None
            rows = [(f, c, "") for f, c in street_forms(text)] if kind == "ADDRESS" else [(text, "NOM", "")]
        if len({f for f, _, _ in rows}) == len({(f, c, p) for f, c, p in rows}) or kind == "PERSON":
            if not vault.surrogate_taken(user_id, [f for f, _, p in rows if not (keep and p == "first")]):
                return text, infl, rows, "realistic"
    ph = placeholder(vault, user_id, kind)
    return ph, None, [(ph, "NOM", "all")], "placeholder"


@lru_cache(maxsize=1)
def nicknames() -> dict[str, list[str]]:
    from .detect.gazetteer import DATA

    out = {}
    for line in (DATA.parent / "nicknames.tsv").read_text(encoding="utf-8").splitlines():
        if line and not line.startswith("#"):
            name, nicks = line.split("\t")
            out[name] = nicks.split()
    return out


def real_rows(kind: str, canonical: str, surface: str) -> list[tuple[str, str, str]]:
    if kind == "PERSON":
        parts = person_parts(canonical)
        # nicknames are real forms of the first name part: Masalle restores as Matille
        return name_rows(parts + [(p, n) for p, lemma in parts if p != "last" for n in nicknames().get(lemma, ())])
    if kind == "ADDRESS":
        return [(f, c, "") for f, c in street_forms(canonical)]
    if kind == "EMAIL":  # the surface may carry a case ending: x@firma.fi:hin
        return list(dict.fromkeys((f, c, "") for a in (surface.partition(":")[0], canonical) for f, c in email_forms(a)))
    return [(surface, "NOM", ""), (canonical, "NOM", "")]


def placeholder(vault, user_id: str, kind: str) -> str:
    return f"[{PLACEHOLDER.get(kind, kind.lower())} {vault.next_counter(user_id, 'placeholder:' + kind)}]"


# -- entity operations

def get_or_create_entity(vault, user_id: str, kind: str, canonical: str, surface: str | None = None):
    kinds = ("PERSON", "SELF") if kind == "PERSON" else (kind,)
    hit = vault.find(user_id, kinds, canonical)
    if hit:
        return hit
    real = real_rows(kind, canonical, surface or canonical)
    made = make_surrogate(vault, user_id, kind, canonical, 0)  # outside the lock: Omorfi is slow
    with vault.lock:
        hit = vault.find(user_id, kinds, canonical)
        if hit:
            return hit
        try:
            surr, infl, rows, mode = made
            return vault.create(user_id, kind, canonical, surr, infl, real, rows, mode)
        except SurrogateConflict:  # another request took a form meanwhile: retry under the lock
            surr, infl, rows, mode = make_surrogate(vault, user_id, kind, canonical, 0)
            return vault.create(user_id, kind, canonical, surr, infl, real, rows, mode)


def upgrade_first(vault, user_id: str, session_id: str | None, canonical: str):
    """A full name whose first name alone is already a PERSON entity is that person (phase-12 decision 19): the
    entity seen last in this session, else the only one in the vault. The entity takes the full name as its
    canonical, keeps its surrogate first name and gets a surrogate surname under the pair rule. Its old forms stay,
    so earlier transcripts still restore. None when no entity fits; the caller then creates a new one."""
    parts = person_parts(canonical)
    if len(parts) != 2 or vault.find(user_id, ("PERSON", "SELF"), canonical):
        return None
    first = parts[0][1]
    lone = [e for e in vault.q("SELECT * FROM entity WHERE user_id=? AND kind='PERSON' AND canonical=?"
                               " AND surrogate_mode='realistic' AND allowlisted=0", (user_id, first))
            if person_parts(first)[0][0] == "first"]
    seen = vault.last_seen(session_id, [e["id"] for e in lone]) if lone and session_id else {}
    e = max(lone, key=lambda e: seen[e["id"]]) if seen else lone[0] if len(lone) == 1 else None
    if e is None:
        return None
    with vault.lock:
        surr, infl, rows, mode = make_surrogate(vault, user_id, "PERSON", canonical, e["gen"], keep=e["surrogate"])
        if mode != "realistic":
            return None
        vault.add_forms(user_id, e["id"], "real", real_rows("PERSON", canonical, canonical))
        vault.add_forms(user_id, e["id"], "surrogate", rows)
        vault.set_fields(user_id, e["id"], canonical=canonical, surrogate=surr, infl_class=infl)
        return vault.entity(user_id, e["id"])


def ensure_self(vault, user_id: str):
    hit = vault.q("SELECT * FROM entity WHERE user_id=? AND kind='SELF'", (user_id,))
    if hit:
        return hit[0]
    name = os.environ.get("SELF_NAME", "").strip()
    real = name_rows(person_parts(name)) if name else []
    label = self_label()
    with vault.lock:
        hit = vault.q("SELECT * FROM entity WHERE user_id=? AND kind='SELF'", (user_id,))
        return hit[0] if hit else vault.create(user_id, "SELF", name or "self", label, "self", real,
                                               [(label, "NOM", "self")])


def accept_collision(vault, user_id: str, pending) -> None:
    """The user says a mention equal to an issued surrogate is someone new (phase-12 decision 9): it gets its
    own entity, and the entity whose surrogate it matched gets a fresh one unless pinned. The old surrogate
    forms stay, so earlier transcripts still restore."""
    get_or_create_entity(vault, user_id, pending["kind"], pending["canonical"], pending["text"])
    old = vault.entity(user_id, pending["entity_id"])
    if old and not old["pinned"]:
        regenerate(vault, user_id, old)


def regenerate(vault, user_id: str, entity) -> None:
    gen = entity["gen"] + 1
    surr, infl, rows, mode = make_surrogate(vault, user_id, entity["kind"], entity["canonical"], gen)
    vault.add_forms(user_id, entity["id"], "surrogate", rows)  # old forms stay so past transcripts restore
    vault.set_fields(user_id, entity["id"], surrogate=surr, infl_class=infl, gen=gen, surrogate_mode=mode)


def set_placeholder(vault, user_id: str, entity) -> None:
    ph = placeholder(vault, user_id, entity["kind"])
    vault.add_forms(user_id, entity["id"], "surrogate", [(ph, "NOM", "all")])
    vault.set_fields(user_id, entity["id"], surrogate=ph, surrogate_mode="placeholder")


def split(vault, user_id: str, entity_id: int, span_ids: list[int]) -> int:
    e = vault.entity(user_id, entity_id)
    if not e or e["kind"] == "SELF":
        raise KeyError("entity")
    surr, infl, rows, mode = make_surrogate(vault, user_id, e["kind"], e["canonical"], e["gen"] + 1000)
    real = [(r["form"], r["analysis"], r["part"]) for r in vault.forms_for(entity_id) if r["side"] == "real"]
    new = vault.create(user_id, e["kind"], e["canonical"], surr, infl, real, rows, mode)
    if span_ids:
        vault.reassign_spans(user_id, entity_id, span_ids, new["id"])
    return new["id"]


def surrogate_form(entity, part: str, case: str | None) -> str:
    """Surrogate surface for one detected real form, in the same case when known."""
    if entity["kind"] == "SELF" or entity["surrogate_mode"] == "placeholder":
        return entity["surrogate"]
    if entity["kind"] == "PERSON":
        parts = dict(zip([p for p, _ in person_parts(entity["canonical"])], entity["surrogate"].split()))
        s = parts.get(part) or entity["surrogate"].split()[-1]
        f = forms.generate_forms(s, part_kind(part))
        return f.get(case or "NOM", s)
    if entity["kind"] == "ADDRESS" and case:
        return dict((c, f) for f, c in street_forms(entity["surrogate"])).get(case, entity["surrogate"])
    if entity["kind"] == "EMAIL" and case:
        return dict((c, f) for f, c in email_forms(entity["surrogate"])).get(case, entity["surrogate"])
    return entity["surrogate"]
