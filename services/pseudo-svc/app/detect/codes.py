"""Layer 1: deterministic detectors with checksums or tight shapes (0003 questions 6-9)."""

import datetime
import re
from functools import lru_cache
from pathlib import Path

import phonenumbers

from . import Candidate

HETU_CHECK = "0123456789ABCDEFHJKLMNPRSTUVWXY"
CENTURY = {"+": 1800, **{c: 1900 for c in "-YXWVU"}, **{c: 2000 for c in "ABCDEF"}}
HETU_RE = re.compile(r"(?<![\w-])(\d{6})([-+A-FU-Y])(\d{3})([0-9A-Y])(?![\w-])", re.I)
IBAN_RE = re.compile(r"\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{1,4}){3,8}\b")
BBAN_RE = re.compile(r"(?<![\w-])(\d{6}-\d{2,8}|\d{14})(?![\w-])")
BBAN_CTX = re.compile(r"^(tilinumero|tili|iban|pankkitili)", re.I)
EMAIL_RE = re.compile(r"\b[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}\b")
PLATE_RE = re.compile(r"\b(?:[A-ZÅÄÖ]{2,3}-[1-9]\d{0,2}|ÅL-\d{1,5})(?![\w-])")
PLATE_CTX = re.compile(r"\b(auto|rekisteri|rekkari|pysäk|kilpi|kilve|kilv|ajoneuvo)", re.I)

# case order: NOM GEN PAR ADE ABL ALL INE ELA ILL (the index is the case key for surrogates)
STREET_SUFFIX = {
    "katu": "katu kadun katua kadulla kadulta kadulle kadussa kadusta katuun",
    "tie": "tie tien tietä tiellä tieltä tielle tiessä tiestä tiehen",
    "kuja": "kuja kujan kujaa kujalla kujalta kujalle kujassa kujasta kujaan",
    "polku": "polku polun polkua polulla polulta polulle polussa polusta polkuun",
    "väylä": "väylä väylän väylää väylällä väylältä väylälle väylässä väylästä väylään",
    "kaari": "kaari kaaren kaarta kaarella kaarelta kaarelle kaaressa kaaresta kaareen",
    "rinne": "rinne rinteen rinnettä rinteellä rinteeltä rinteelle rinteessä rinteestä rinteeseen",
    "raitti": "raitti raitin raittia raitilla raitilta raitille raitissa raitista raittiin",
    "ranta": "ranta rannan rantaa rannalla rannalta rannalle rannassa rannasta rantaan",
    "tori": "tori torin toria torilla torilta torille torissa torista toriin",
    "aukio": "aukio aukion aukiota aukiolla aukiolta aukiolle aukiossa aukiosta aukioon",
}
SUFFIX_CASE = {f: (cls, i) for cls, forms in STREET_SUFFIX.items() for i, f in enumerate(forms.split())}
_suf = "|".join(sorted(SUFFIX_CASE, key=len, reverse=True))
STREET_RE = re.compile(
    rf"\b((?:(?:Vanha|Uusi|Iso|Pikku|Pieni|Ylä|Ala|Itäinen|Läntinen|Pohjoinen|Eteläinen) )?"
    rf"[A-ZÅÄÖ][a-zåäö]*(?:-[a-zåäö]*)*?)({_suf})"
    r"(\s\d{1,4}(?:\s?[A-Za-z](?![\wåäö])(?:\s?\d{1,3})?|\s(?:as\.?|asunto)\s?\d{1,3})?(?::[a-zä]{1,3})?)(?![\w-])"
)
POSTCODE_RE = re.compile(r"\b(\d{5})\s+([A-ZÅÄÖ][A-Za-zÅÄÖåäö-]+)")


@lru_cache(maxsize=1)
def municipalities() -> frozenset[str]:
    p = Path(__file__).resolve().parents[2] / "data" / "municipalities.txt"
    return frozenset(x.strip().lower() for x in p.read_text(encoding="utf-8").splitlines() if x.strip())


LOC_REST = re.compile(r"[a-zåäö]{0,2}(?:n|ssa|ssä|sta|stä|lla|llä|lta|ltä|lle|ksi|na|nä|a|ä|ta|tä|"
                      r"aan|een|iin|oon|uun|yyn|ään|öön|seen|hin)")


def locality(word: str) -> str | None:
    """Municipality behind a possibly inflected word: Helsingissä -> helsinki, Turussa -> turku.

    The part after the shared prefix must be at most two stem letters plus a case ending, so
    Rauhala is not Rauma and Turunen is not Turku.
    """
    w = word.lower()
    if w in municipalities():
        return w
    for m in municipalities():
        if len(m) >= 4 and w[:3] == m[:3]:
            i = 3
            while i < min(len(w), len(m)) and w[i] == m[i]:
                i += 1
            rest = w[i:]
            if i == len(m) and re.match(r"nen|s[aeiouyäö]", rest):
                continue  # -nen surname built on the place: Lahtinen, Lahtisen
            if i >= len(m) - 2 and LOC_REST.fullmatch(rest):
                return m
    return None


def hetu_valid(code: str) -> bool:
    m = HETU_RE.fullmatch(code)
    if not m:
        return False
    date, sep, num, check = m.group(1), m.group(2).upper(), m.group(3), m.group(4).upper()
    if int(num) < 2:
        return False
    try:
        datetime.date(CENTURY[sep] + int(date[4:]), int(date[2:4]), int(date[:2]))
    except ValueError:
        return False
    return HETU_CHECK[int(date + num) % 31] == check


def hetu_check_char(date_num: str) -> str:
    return HETU_CHECK[int(date_num) % 31]


def iban_valid(iban: str) -> bool:
    """ISO 13616 mod-97; FI IBANs must also have 18 characters."""
    s = iban.replace(" ", "").upper()
    if not 15 <= len(s) <= 34 or (s.startswith("FI") and (len(s) != 18 or not s[2:].isdigit())):
        return False
    return int("".join(str(int(c, 36)) for c in s[4:] + s[:4])) % 97 == 1


def bban_machine(bban: str) -> str | None:
    """Old 'XXXXXX-YYY' form to 14 digits (zero fill after the 7th digit for banks 4 and 5)."""
    if "-" not in bban:
        return bban
    head, tail = bban.split("-")
    fill = "0" * (14 - len(head) - len(tail))
    return head + tail[0] + fill + tail[1:] if head[0] in "45" else head + fill + tail


def luhn_ok(digits: str) -> bool:
    total = 0
    for i, d in enumerate(reversed(digits)):
        n = int(d) * (2 if i % 2 else 1)
        total += n - 9 if n > 9 else n
    return total % 10 == 0


def iban_check_digits(bban: str) -> str:
    return f"{98 - int(bban + '151800') % 97:02d}"


def _cand(m, kind, canonical, score=1.0, group=0):
    return Candidate(m.start(group), m.end(group), kind, canonical, "codes", score, m.group(group))


def _near(text: str, start: int, end: int, pattern: re.Pattern, tokens: int = 5) -> bool:
    before = text[:start].split()[-tokens:]
    after = text[end:].split()[:tokens]
    return any(pattern.match(t.strip("(),.;:")) for t in before + after)


def streets(text: str) -> list[Candidate]:
    return [Candidate(m.start(), m.end(), "ADDRESS", m.group(1) + STREET_SUFFIX[SUFFIX_CASE[m.group(2)][0]].split()[0]
                      + m.group(3).split(":")[0], "codes", 1.0, m.group(0)) for m in STREET_RE.finditer(text)]


def detect(text: str, ctx=None) -> list[Candidate]:
    out: list[Candidate] = []
    for m in HETU_RE.finditer(text):
        if hetu_valid(m.group(0)):
            out.append(_cand(m, "HETU", m.group(0).upper()))
    for m in IBAN_RE.finditer(text):
        groups = m.group(0).split(" ")
        while groups:  # the regex may swallow a trailing word or number; drop groups until the checksum holds
            iban = " ".join(groups)
            if iban_valid(iban):
                out.append(Candidate(m.start(), m.start() + len(iban), "IBAN", iban.replace(" ", ""), "codes", 1.0, iban))
                break
            groups.pop()
    for m in BBAN_RE.finditer(text):
        bban = bban_machine(m.group(1))
        ctx_ok = any(BBAN_CTX.match(t) for t in text[:m.start()].split()[-5:])
        hetu_shaped = re.fullmatch(r"\d{6}-\d{4}", m.group(1))
        if bban[0] != "0" and (("-" in m.group(1) and not hetu_shaped) or ctx_ok):
            out.append(_cand(m, "IBAN", bban, 1.0 if ctx_ok else 0.9, 1))
    for m in phonenumbers.PhoneNumberMatcher(text, "FI", leniency=phonenumbers.Leniency.VALID):
        raw = m.raw_string
        if raw.lstrip("(").startswith(("+", "00", "0")) and (raw.count("-") < 2 or raw.startswith("+")):
            canon = phonenumbers.format_number(m.number, phonenumbers.PhoneNumberFormat.E164)
            out.append(Candidate(m.start, m.end, "PHONE", canon, "codes", 1.0, raw))
    for m in EMAIL_RE.finditer(text):
        out.append(_cand(m, "EMAIL", m.group(0).lower()))
    for m in PLATE_RE.finditer(text):
        if _near(text, m.start(), m.end(), PLATE_CTX):
            out.append(_cand(m, "PLATE", m.group(0)))
    st = streets(text)
    out += st
    ends = [c.end for c in st]
    for m in POSTCODE_RE.finditer(text):
        after_street = any(0 <= m.start() - e <= 3 for e in ends)
        if after_street or locality(m.group(2)):
            out.append(_cand(m, "POSTCODE_CITY", m.group(1), 1.0, 1))  # the locality itself stays
    return out
