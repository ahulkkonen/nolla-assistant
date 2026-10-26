"""Layer 3: DVV first-name and surname gazetteers (CC BY 4.0, release 2026-08-04)."""

import csv
import re
from collections import defaultdict
from functools import lru_cache
from pathlib import Path

from .. import forms
from . import Candidate
from .codes import locality

DATA = Path(__file__).resolve().parents[2] / "data" / "dvv"
TOKEN_RE = re.compile(r"[A-ZÅÄÖ][a-zåäöéü]+(?:-[A-ZÅÄÖ][a-zåäöéü]+)?")
SENT_END = re.compile(r"(^|[.!?:;\"”»(\n]\s*|^\s*[-*•]\s*)$")
TITLES = re.compile(
    r"^(hra|rva|nti|herra|rouva|neiti|tohtori|tri|dr|toimitusjohtaja|johtaja|professori|prof|dosentti|"
    r"maisteri|insinööri|lääkäri|opettaja|rehtori|pastori|kirkkoherra|ministeri|presidentti|kollega|"
    r"naapuri|ystävä|kaveri|pomo|esihenkilö|esimies|asiakas|potilas|sihteeri|asianajaja|"
    r"veli|veljeni|sisko|siskoni|sisar|serkku|setä|täti|eno|isä|äiti|mummo|vaari|poika|tytär|vaimo|mies|"
    r"puoliso|kumppani|isoäiti|isoisä|appi|anoppi|vävy|miniä|lanko|käly|tyttöystävä|poikaystävä)",
    re.I,
)
# capitalised words that start sentences and are also names (Usko, Toivo, Onni): need extra context
MIN_SURNAME_COUNT = 40
MIN_FIRST_COUNT = 50
LONE_SURNAME_MIN = 200  # a lone lower-case surname the lexicon does not know needs this many DVV holders


@lru_cache(maxsize=1)
def names() -> dict:
    """{'first': {name: (count, gender)}, 'last': {name: count}}"""
    first: dict[str, tuple[int, str]] = {}
    for gender in ("male", "female"):
        with open(DATA / f"first_{gender}.csv", encoding="utf-8") as f:
            for row in csv.DictReader(f):
                n, c = row["name"], int(row["count"])
                if n not in first or first[n][0] < c:
                    first[n] = (c, gender)
    with open(DATA / "surnames.csv", encoding="utf-8") as f:
        last = {row["name"]: int(row["count"]) for row in csv.DictReader(f)}
    return {"first": first, "last": last}


@lru_cache(maxsize=1)
def _index() -> dict[str, list[tuple[str, str]]]:
    idx = defaultdict(list)
    for kind in ("first", "last"):
        for n in names()[kind]:
            idx[n[:2]].append((n, kind))
    return idx


@lru_cache(maxsize=1)
def _voikko():
    import ctypes.util

    if not ctypes.util.find_library("voikko"):
        return None
    try:
        from libvoikko import Voikko  # GPL data, this container only

        return Voikko("fi")
    except Exception:
        return None


def _lcp(a: str, b: str) -> int:
    i = 0
    while i < min(len(a), len(b)) and a[i] == b[i]:
        i += 1
    return i


@lru_cache(maxsize=50000)
def lemmas(word: str) -> tuple[tuple[str, str], ...]:
    """(lemma, 'first'|'last') pairs for a capitalised token, most likely first."""
    db = names()
    out = [(word, k) for k in ("first", "last") if word in db[k]]
    if out:
        return tuple(out)
    v = _voikko()
    if v:
        for a in v.analyze(word):
            base, cls = a.get("BASEFORM", ""), a.get("CLASS", "")
            for k in ("first", "last"):
                if base in db[k] and (cls in ("etunimi", "sukunimi", "paikannimi", "nimi") or not cls):
                    out.append((base, k))
        if out:
            return tuple(dict.fromkeys(out))
    om = forms.omorfi()
    if om:
        for a in om.analyses(word):
            m = re.match(r"\[WORD_ID=([^\]]+)\]", a)
            if m:
                for k in ("first", "last"):
                    if m.group(1) in db[k]:
                        out.append((m.group(1), k))
        if out:
            return tuple(dict.fromkeys(out))
    # suffix fallback: candidates sharing a long prefix, verified by generating their forms
    for n, k in _index().get(word[:2], ()):
        if abs(len(n) - len(word)) <= 7 and _lcp(n, word) >= max(2, len(n) - 3):
            if word in forms.rule_forms(n, k).values():
                out.append((n, k))
    out.sort(key=lambda nk: -(db[nk[1]][nk[0]][0] if nk[1] == "first" else db[nk[1]][nk[0]]))
    return tuple(out)


def _count(lemma: str, kind: str) -> int:
    v = names()[kind].get(lemma)
    return (v[0] if kind == "first" else v) if v else 0


def _sentence_start(text: str, start: int) -> bool:
    return bool(SENT_END.search(text[max(0, start - 4):start])) or start == 0


STOP = frozenset("""The A An My Your Our His Her Its This That These Those Can Could Will Would Please Hi Hello
Dear Thanks Meeting Reminder Deadline Shipping Recipient Summarise Forwarding Notes I We You He She They It Is
Minä Sinä Hän Me Te He Se Ne Tämä Tuo Nämä Missä Mikä Kuka Ja Tai Mutta Kun Jos Että Onko Oliko""".split())
COMMON_CLASSES = {"nimisana", "laatusana", "nimisana_laatusana", "teonsana", "seikkasana", "asemosana",
                  "suhdesana", "sidesana", "kieltosana", "huudahdussana", "lukusana"}
COMMON_NAME_COUNT = 2000


@lru_cache(maxsize=50000)
def common_word(word: str) -> bool:
    """True when the lower-cased token is an ordinary word (Pojan, Annoin). Needs Voikko or Omorfi."""
    lw = word.lower()
    v = _voikko()
    if v:
        return any(a.get("CLASS") in COMMON_CLASSES for a in v.analyze(lw))
    om = forms.omorfi()
    if om:
        return any("[UPOS=PROPN]" not in a and "BOUNDARY" not in a and "BLACKLIST" not in a
                   for a, _ in om.describe.lookup(lw))
    return False


@lru_cache(maxsize=50000)
def place(word: str) -> bool:
    """Municipality (any case) or a token Omorfi knows only as a place or a country."""
    if locality(word):
        return True
    om = forms.omorfi()
    if om:
        props = [a for a, _ in om.describe.lookup(word) if "[UPOS=PROPN]" in a]
        return bool(props) and all("PROPER=GEO" in a or "SEM=COUNTRY" in a or "PROPER=ORG" in a for a in props) \
            or any("SEM=COUNTRY" in a for a in props)
    return False


@lru_cache(maxsize=50000)
def readings(word: str) -> frozenset[str]:
    """Omorfi PROPER tags of a token (FIRST, LAST, GEO, ORG, ...); empty without Omorfi."""
    om = forms.omorfi()
    return frozenset(re.findall(r"\[PROPER=(\w+)\]", "".join(om.analyses(word)))) if om else frozenset()


LOWER_RE = re.compile(r"(?<![\w-])[a-zåäö][a-zåäöéü]{2,}(?:-[a-zåäö][a-zåäöéü]+)?(?![\w-])")
# lower-case chat words that are also DVV first names: English words and abbreviations
LOWER_STOP = frozenset("max min jan may mark will eli dan ron rose hope grace faith tom kim kai".split())


def cap(word: str) -> str:
    """laura -> Laura, anna-liisan -> Anna-Liisan."""
    return "-".join(p[:1].upper() + p[1:] for p in word.split("-"))


def plain_word(text: str, start: int, end: int) -> bool:
    """False inside a path, file name, address or identifier: /data/work/aleksi, laura.txt, laura@x."""
    return text[start - 1:start] not in ("/", "\\", "@", ".", "_", "#") and not re.match(r"[/\\@_]|\.\w", text[end:end + 2])


NAME_CLASSES = ("etunimi", "sukunimi", "paikannimi", "nimi")


@lru_cache(maxsize=50000)
def known_name(word: str) -> bool:
    """Voikko (else Omorfi) knows the capitalised token as a name. DVV alone is not enough for a
    lower-case word: from, said and ma are DVV names too."""
    v = _voikko()
    if v:
        return any(a.get("CLASS") in NAME_CLASSES for a in v.analyze(word))
    return bool(readings(word) & {"FIRST", "LAST"})


@lru_cache(maxsize=50000)
def surname_shaped(word: str) -> str | None:
    """The DVV surname with at least LONE_SURNAME_MIN holders that the capitalised token is an inflected form
    of (Nyströmille -> Nyström), else None. The bare nominative does not count: from and said are DVV surnames."""
    return next((lemma for lemma, kind in lemmas(word) if kind == "last" and word != lemma
                 and _count(lemma, "last") >= LONE_SURNAME_MIN and word in forms.generate_forms(lemma, "last").values()),
                None)


def lower_names(text: str) -> list[Candidate]:
    """Lower-case names, as typed on a phone. Every word must be a name the lexicon knows, or no ordinary
    word and an inflected form of a DVV surname with at least LONE_SURNAME_MIN holders (phase-12 decision 15):
    this also keeps the DVV lookups off ordinary words. A first name followed by a surname is a name unless
    both words are ordinary words (toivo laine); it goes to the pending lane if one of them is. A lone word
    must be no ordinary word and no place, and a common first name or a surname. Without Voikko or Omorfi
    only pairs are found: nothing tells an ordinary word."""
    lexicon = _voikko() is not None or forms.omorfi() is not None
    info = []
    for m in LOWER_RE.finditer(text):
        w = m.group(0)
        if w in LOWER_STOP or not plain_word(text, m.start(), m.end()):
            continue
        if lexicon and not known_name(cap(w)) and (common_word(w) or not surname_shaped(cap(w))):
            continue
        lem = lemmas(cap(w))
        first = next((l for l, k in lem if k == "first" and _count(l, "first") >= MIN_FIRST_COUNT), None)
        last = next((l for l, k in lem if k == "last" and _count(l, "last") >= MIN_SURNAME_COUNT), None)
        if first or last:
            info.append((m, first, last, common_word(w)))
    out, i = [], 0
    while i < len(info):
        m, first, last, common = info[i]
        nxt = info[i + 1] if i + 1 < len(info) else None
        if first and nxt and nxt[2] and text[m.end():nxt[0].start()] == " " and not (common and nxt[3]):
            n2 = nxt[0]
            parts = [dict(start=m.start(), end=m.end(), part="first", lemma=first),
                     dict(start=n2.start(), end=n2.end(), part="last", lemma=nxt[2])]
            out.append(Candidate(m.start(), n2.end(), "PERSON", f"{first} {nxt[2]}", "gazetteer",
                                 0.55 if common or nxt[3] else 0.9, text[m.start():n2.end()], parts))
            i += 2
            continue
        i += 1
        if common or not lexicon or place(cap(m.group(0))):
            continue
        if first and _count(first, "first") >= COMMON_NAME_COUNT and "ORG" not in readings(cap(m.group(0))):
            part, lemma, score = "first", first, 0.7
        elif last and not place(last):
            part, lemma, score = "last", last, 0.8 if last.endswith("nen") else 0.65
        else:
            continue
        out.append(Candidate(m.start(), m.end(), "PERSON", lemma, "gazetteer", score, m.group(0),
                             [dict(start=m.start(), end=m.end(), part=part, lemma=lemma)]))
    return out


@lru_cache(maxsize=1)
def _particles() -> dict[str, list[str]]:
    """Lower-case particle -> the rest of each DVV surname that starts with it: von -> [Hertzen, ...]."""
    out: dict[str, list[str]] = defaultdict(list)
    for n in names()["last"]:
        head, _, rest = n.partition(" ")
        if rest and head.islower():
            out[head].append(rest)
    return out


def _particle_name(text: str, m) -> tuple[int, int, str] | None:
    """'Carl von Hertzenin' after the first name m: (start, end, lemma) of the inflected surname after the particle
    (Hertzenin -> Hertzen); the particle itself stays in the text, unmasked."""
    pm = re.match(r" ([a-z]{2,3}) ([A-ZÅÄÖ][a-zåäöéü]+)", text[m.end():m.end() + 80])
    if not pm or pm.group(1) not in _particles():
        return None
    tail = pm.group(2)
    lemma = next((n for n in _particles()[pm.group(1)] if tail in forms.rule_forms(n, "last").values()), None)
    return (m.end() + pm.start(2), m.end() + pm.end(2), lemma) if lemma else None


def detect(text: str, ctx=None) -> list[Candidate]:
    toks = [m for m in TOKEN_RE.finditer(text) if m.group(0) not in STOP]
    info = []
    for m in toks:
        w = m.group(0)
        lem = lemmas(w)
        first = next((l for l, k in lem if k == "first" and _count(l, "first") >= MIN_FIRST_COUNT), None)
        last = next((l for l, k in lem if k == "last" and _count(l, "last") >= MIN_SURNAME_COUNT), None)
        info.append((m, first, last))
    out: list[Candidate] = []
    full_firsts = set()
    i = 0
    singles = []
    while i < len(info):
        m, first, last = info[i]
        nxt = info[i + 1] if i + 1 < len(info) else None
        adjacent = nxt and text[m.end():nxt[0].start()] == " "
        noble = _particle_name(text, m) if first else None
        if noble:  # Carl von Hertzenin: a DVV surname with a particle
            start, end, lemma = noble
            parts = [dict(start=m.start(), end=m.end(), part="first", lemma=first),
                     dict(start=start, end=end, part="last", lemma=lemma)]
            out.append(Candidate(m.start(), end, "PERSON", f"{first} {lemma}", "gazetteer", 0.95, text[m.start():end], parts))
            full_firsts.add(first)
            i += 2 if nxt and nxt[0].start() == start else 1
            continue
        # full name: first name followed by a surname or a capitalised word that is not a place
        if first and adjacent and (nxt[2] or not nxt[1] or nxt[0].group(0).endswith("nen")) \
                and not (not nxt[2] and place(nxt[0].group(0))):
            n2 = nxt[0]
            last_lemma = nxt[2] or (lemmas(n2.group(0))[0][0] if lemmas(n2.group(0)) else n2.group(0))
            score = 0.95 if nxt[2] else 0.75
            parts = [dict(start=m.start(), end=m.end(), part="first", lemma=first),
                     dict(start=n2.start(), end=n2.end(), part="last", lemma=last_lemma)]
            out.append(Candidate(m.start(), n2.end(), "PERSON", f"{first} {last_lemma}", "gazetteer", score,
                                 text[m.start():n2.end()], parts))
            full_firsts.add(first)
            i += 2
            continue
        singles.append(info[i])
        i += 1
    for m, first, last in singles:
        w = m.group(0)
        prev_word = text[max(0, m.start() - 200):m.start()].split()[-1:]
        titled = bool(prev_word and TITLES.match(prev_word[0].strip(",.:;()")))
        start_pos = _sentence_start(text, m.start())
        lemma = first or last
        if not titled and (place(w) or (lemma and place(lemma))):
            continue
        if first and not titled and first not in full_firsts:
            r = readings(w)  # Kreetalla (Crete), Elisalle (the operator): a lone rare or brand first name
            if "ORG" in r or ("GEO" in r and _count(first, "first") < COMMON_NAME_COUNT):
                continue
        common = common_word(w)
        score, part = 0.0, None
        if first and first in full_firsts:
            score, part = 0.85, "first"  # "Marja Saari ... Marjan hinta"
        elif first and (titled or not start_pos):
            score, part = (0.9 if titled else 0.8), "first"
        elif last and titled:
            score, part = 0.9, "last"
        elif last and not start_pos:
            score, part = (0.8 if last.endswith("nen") else 0.65), "last"
        elif first and start_pos and not common:
            score, part = 0.5, "first"  # pending lane
        elif titled and not start_pos:
            score, part, lemma = 0.55, "last", w
        if part and common and not titled and score < 0.85:
            if start_pos or _count(lemma, part) < COMMON_NAME_COUNT:
                continue
        if score >= 0.5:
            lemma = lemma if part != "last" or not first or last else w
            out.append(Candidate(m.start(), m.end(), "PERSON", lemma, "gazetteer", score, w,
                                 [dict(start=m.start(), end=m.end(), part=part, lemma=lemma)]))
    return out + lower_names(text) if ctx is not None and ctx.lower else out
