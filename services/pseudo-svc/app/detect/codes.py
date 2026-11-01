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
EMAIL_RE = re.compile(r"\b[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){0,8}\.[A-Za-z]{2,24}\b")
EMAIL_MAX = 254
# logo@2x.png is a file name: these endings are no top-level domains
FILE_EXT = frozenset("png jpg jpeg gif svg webp heic bmp tif tiff pdf txt json csv docx xlsx pptx".split())
EMAIL_SUFFIX = re.compile(r":[a-zåäö]{1,5}(?!\w)")
EMAIL_CASES = ("NOM", "GEN", "PAR", "ESS", "TRA", "INE", "ELA", "ILL", "ADE", "ABL", "ALL")
WINDOW = 200  # context lookups read at most this many characters around a match
PLATE_RE = re.compile(r"\b(?:[A-ZÅÄÖ]{2,3}-[1-9]\d{0,2}|ÅL-\d{1,5})(?![\w-])")
PLATE_CTX = re.compile(r"\b(auto|rekisteri|rekkari|pysäk|kilpi|kilve|kilv|ajoneuvo)", re.I)

# case order: NOM GEN PAR ADE ABL ALL INE ELA ILL (the index is the case key for surrogates).
# Swedish names stay uninflected in Finnish text: one form for every case.
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
    "kaarre": "kaarre kaarteen kaarretta kaarteella kaarteelta kaarteelle kaarteessa kaarteesta kaarteeseen",
    "piha": "piha pihan pihaa pihalla pihalta pihalle pihassa pihasta pihaan",
    "portti": "portti portin porttia portilla portilta portille portissa portista porttiin",
    **{sv: " ".join([sv] * 9) for sv in ("vägen", "gatan", "gränden", "stigen", "backen", "torget")},
}
SWEDISH = frozenset(c for c, forms in STREET_SUFFIX.items() if len(set(forms.split())) == 1)
SUFFIX_CASE: dict[str, tuple[str, int]] = {}
for _cls, _forms in STREET_SUFFIX.items():
    for _i, _f in enumerate(_forms.split()):
        SUFFIX_CASE.setdefault(_f, (_cls, _i))
_suf = "|".join(sorted(SUFFIX_CASE, key=len, reverse=True))
_NUM = r"(\s\d{1,4}(?:\s?[A-Za-z](?![\wåäö])(?:\s?\d{1,3})?|\s(?:as\.?|asunto)\s?\d{1,3})?(?::[a-zä]{1,3})?)(?![\w-])"
STREET_RE = re.compile(
    rf"\b((?:(?:Vanha|Uusi|Iso|Pikku|Pieni|Ylä|Ala|Itäinen|Läntinen|Pohjoinen|Eteläinen) )?"
    rf"[A-ZÅÄÖ][a-zåäö]*(?:-[a-zåäö]*)*?)({_suf}){_NUM}"
)
# plain text typed on a phone: "asun koivukuja 7 b 12"
STREET_LOWER_RE = re.compile(rf"(?<![\w-])([a-zåäö][a-zåäö]*(?:-[a-zåäö]*)*?)({_suf}){_NUM}")
# road numbers, not addresses: Valtatie 4, Kantatie 51:lle
ROADS = frozenset("valtatie kantatie seututie yhdystie moottoritie".split())
# a measure, not a house number: "kuntotie 5 km", "Kuntotie 3 h"; a letter before a number is a staircase
# ("koivukuja 7 e 12")
UNIT_RE = re.compile(r"\s?(?:km|cm|mm|m|min|h|s|kpl|%|€|e|euroa|metriä|kertaa)(?![\wåäö])(?!\s?\d)")
# a lower-case street needs an address-like end: a staircase or an apartment, the number at a phrase end
# or before a postcode, or (with Voikko) a next word that the number does not count: "uimaranta 2 kertaa" and
# "lasiportti 3 metriä" are no addresses, "puistokatu 12 ovikoodi on 1234" is one (phase-33 decision 1)
PHRASE_END = re.compile(r"\s*(?:[.,;:!?)\n]|$|\d{5}(?!\d))")
NEXT_WORD = re.compile(r"\s+([a-zåäöA-ZÅÄÖ]+)")
POSTCODE_RE = re.compile(r"\b(\d{5})\s+([A-ZÅÄÖ][A-Za-zÅÄÖåäö-]+)")
# plain text: "rantatie 22 a 3 40100 jyväskylä" (only right after a street, see detect)
POSTCODE_LOWER_RE = re.compile(r"\b(\d{5})\s+([a-zåäö][a-zåäö-]+)")


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
    before = text[max(0, start - WINDOW):start].split()[-tokens:]
    after = text[end:end + WINDOW].split()[:tokens]
    return any(pattern.match(t.strip("(),.;:")) for t in before + after)


def email_endings(address: str) -> list[str]:
    """Case endings after a colon, in EMAIL_CASES order, by how the last label is read: fi:hin, com:iin."""
    tld = address.rsplit(".", 1)[-1].lower()
    a = "a" if set(tld) & set("aou") else "ä"
    if tld[-1:] in tuple("aeiouyäö"):
        return ["", ":n", f":t{a}", f":n{a}", ":ksi", f":ss{a}", f":st{a}", f":h{tld[-1]}n", f":ll{a}", f":lt{a}", ":lle"]
    return ["", ":in", f":i{a}", f":in{a}", ":iksi", f":iss{a}", f":ist{a}", ":iin", f":ill{a}", f":ilt{a}", ":ille"]


def email_forms(address: str) -> list[tuple[str, str]]:
    """(form, case) for every case ending of an address."""
    return [(address + e, c) for e, c in zip(email_endings(address), EMAIL_CASES)]


def email_case(surface: str) -> tuple[str, str | None]:
    """'x@firma.fi:hin' -> ('x@firma.fi', 'ILL'); the case is None for an ending of no known case."""
    base, colon, rest = surface.partition(":")
    return base, dict(zip(email_endings(base), EMAIL_CASES)).get(colon + rest)


def _counted(text: str, end: int) -> bool:
    """The word after a bare house number may be what the number counts: a partitive or a translative
    (2 kertaa, 3 lasta, 2 tunniksi), or no word at all. True without Voikko, which keeps the phrase-end rule
    of phase 12."""
    from .gazetteer import counted  # gazetteer imports this module

    w = NEXT_WORD.match(text, end)
    return not w or counted(w.group(1).lower()) is not False


def streets(text: str, lower: bool = False) -> list[Candidate]:
    out = []
    for rx in (STREET_RE, STREET_LOWER_RE) if lower else (STREET_RE,):
        for m in rx.finditer(text):
            cls = SUFFIX_CASE[m.group(2)][0]
            name = m.group(1)[:1].upper() + m.group(1)[1:]
            num = re.match(r"\s\d+", m.group(3))
            if name.lower() + cls in ROADS or num and UNIT_RE.match(text, m.start(3) + num.end()):
                continue
            bare = re.fullmatch(r"\s\d{1,4}(?::[a-zä]{1,3})?", m.group(3))  # only the number
            if rx is STREET_LOWER_RE and (not num or bare and not PHRASE_END.match(text, m.end())
                                          and _counted(text, m.end())):
                continue
            out.append(Candidate(m.start(), m.end(), "ADDRESS", name + STREET_SUFFIX[cls].split()[0]
                                 + m.group(3).split(":")[0], "codes", 1.0, m.group(0)))
    return out


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
        ctx_ok = any(BBAN_CTX.match(t) for t in text[max(0, m.start() - WINDOW):m.start()].split()[-5:])
        hetu_shaped = re.fullmatch(r"\d{6}-\d{4}", m.group(1))
        if bban[0] != "0" and (("-" in m.group(1) and not hetu_shaped) or ctx_ok):
            out.append(_cand(m, "IBAN", bban, 1.0 if ctx_ok else 0.9, 1))
    for m in phonenumbers.PhoneNumberMatcher(text, "FI", leniency=phonenumbers.Leniency.VALID):
        raw = m.raw_string
        if re.search(r"\d[.,]?$", text[max(0, m.start - 2):m.start]):
            continue  # the tail of a decimal or a longer number: "total": 0.0107338
        if raw.lstrip("(").startswith(("+", "00", "0")) and (raw.count("-") < 2 or raw.startswith("+")):
            canon = phonenumbers.format_number(m.number, phonenumbers.PhoneNumberFormat.E164)
            out.append(Candidate(m.start, m.end, "PHONE", canon, "codes", 1.0, raw))
    for m in EMAIL_RE.finditer(text):
        addr = m.group(0)
        if len(addr) > EMAIL_MAX or addr.rsplit(".", 1)[1].lower() in FILE_EXT:
            continue
        end, suf = m.end(), EMAIL_SUFFIX.match(text, m.end())
        if suf and suf.group(0) in email_endings(addr):
            end = suf.end()  # "osoitteeseen x@firma.fi:hin": the ending follows the surrogate's domain
        out.append(Candidate(m.start(), end, "EMAIL", addr.lower(), "codes", 1.0, text[m.start():end]))
    for m in PLATE_RE.finditer(text):
        if _near(text, m.start(), m.end(), PLATE_CTX):
            out.append(_cand(m, "PLATE", m.group(0)))
    lower = ctx is not None and ctx.lower
    st = streets(text, lower)
    out += st
    ends = [c.end for c in st]
    for rx in (POSTCODE_RE, POSTCODE_LOWER_RE) if lower else (POSTCODE_RE,):
        for m in rx.finditer(text):
            after_street = any(0 <= m.start() - e <= 3 for e in ends)
            if after_street or rx is POSTCODE_RE and locality(m.group(2)):
                out.append(_cand(m, "POSTCODE_CITY", m.group(1), 1.0, 1))  # the locality itself stays
    return out


PERSON_RE = re.compile(r"[A-ZÅÄÖ][\w'-]*(?: [A-ZÅÄÖ][\w'-]*){0,5}")


def normalise(kind: str, value: str) -> str | None:
    """Canonical form of a seeded value as the detectors produce it, or None when it is not valid."""
    v = " ".join(value.split())
    if kind == "HETU":
        return v.upper() if hetu_valid(v) else None
    if kind == "IBAN":
        c = v.replace(" ", "").upper()
        return c if iban_valid(c) else None
    if kind == "PHONE":
        try:
            n = phonenumbers.parse(v, "FI")
        except phonenumbers.NumberParseException:
            return None
        return phonenumbers.format_number(n, phonenumbers.PhoneNumberFormat.E164) if phonenumbers.is_valid_number(n) else None
    if kind == "EMAIL":
        return v.lower() if len(v) <= EMAIL_MAX and EMAIL_RE.fullmatch(v) else None
    if kind == "PLATE":
        p = re.sub(r"^([A-ZÅÄÖ]{1,3})\s*-?\s*(\d+)$", r"\1-\2", v.upper())
        return p if PLATE_RE.fullmatch(p) else None
    if kind == "POSTCODE_CITY":
        return v if re.fullmatch(r"\d{5}", v) else None
    if kind == "ADDRESS":
        return v if STREET_RE.fullmatch(v) else None
    if kind == "PERSON":
        return v if PERSON_RE.fullmatch(v) else None
    return None
