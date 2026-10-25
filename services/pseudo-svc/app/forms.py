"""Finnish inflection of person names.

Omorfi (GPL-3, loaded only inside this container) generates the paradigm when
its models are present in OMORFI_MODELS. Suffix rules fill every case Omorfi
does not return, and handle names missing from its lexicon.
"""

import gzip
import json
import os
import re
from functools import lru_cache
from pathlib import Path

SG_CASES = ["NOM", "GEN", "PAR", "ESS", "TRA", "INE", "ELA", "ILL", "ADE", "ABL", "ALL", "ABE"]
PL_CASES = ["NOM", "GEN", "PAR", "INS", "COM"]
POSS = {"SG1": "ni", "SG2": "si", "3": "nsA", "PL1": "mme", "PL2": "nne"}
CLITICS = {"KIN": "kin", "HAN": "hAn", "KO": "kO"}
CLITIC_CASES = SG_CASES  # clitics on every singular case, plan asks for NOM and GEN at least

# key -> omorfi tag suffix. Only the bare cases go through Omorfi; clitic and possessive forms are
# built from them by rule (they only append a suffix), which keeps generation at 17 lookups per name.
KEYS: dict[str, str] = {c: f"[NUM=SG][CASE={c}]" for c in SG_CASES}
KEYS.update({f"PL_{c}": f"[NUM=PL][CASE={c}]" for c in PL_CASES})

BACK = set("aouAOU")
FRONT = set("äöyÄÖY")
VOWELS = set("aeiouyäöAEIOUYÄÖ")

# strong -> weak, longest first
GRADATION = [("kk", "k"), ("pp", "p"), ("tt", "t"), ("nk", "ng"), ("mp", "mm"),
             ("nt", "nn"), ("lt", "ll"), ("rt", "rr"), ("ht", "hd")]
SINGLE = [("k", ""), ("p", "v"), ("t", "d")]


def harmony(word: str) -> str:
    """'back' or 'front' by the last harmonic vowel of the last word part."""
    part = re.split(r"[- ]", word)[-1].lower()
    for ch in reversed(part):
        if ch in BACK:
            return "back"
        if ch in FRONT:
            return "front"
    return "front"  # only neutral vowels (i, e): Lindqvist -> Lindqvistiä


def _h(suffix: str, hv: str) -> str:
    if hv == "back":
        return suffix.replace("A", "a").replace("O", "o")
    return suffix.replace("A", "ä").replace("O", "ö")


def _syllables(word: str) -> int:
    return len(re.findall(r"[aeiouyäö]+", word.lower()))


def weaken(stem: str, single: bool = False) -> str:
    """Weak grade of the consonant(s) before the final vowel of an open-syllable stem."""
    if len(stem) < 3 or stem[-1] not in VOWELS:
        return stem
    body, v = stem[:-1], stem[-1]
    for strong, weak in GRADATION:
        if body.endswith(strong):
            return body[: -len(strong)] + weak + v
    if single and body[-1:] in "kpt" and body[-2:-1] in VOWELS:
        for strong, weak in SINGLE:
            if body.endswith(strong):
                if strong == "k" and body[-2] in "uy" and body[-3:-2] == body[-2]:
                    weak = "v"
                return body[:-1] + weak + v
    return stem


E_STEM_END = ("ki", "ti", "mi", "si", "pi", "hi", "vi")


def classify(name: str, kind: str = "last") -> str:
    """Inflection class used both by the rules and by surrogate matching."""
    w = name.split("-")[-1].lower()
    if w.endswith("nen"):
        return "nen"
    if w[-1:] not in VOWELS:
        return "cons"
    if kind == "last" and w.endswith(E_STEM_END) and _syllables(w) == 2:
        return "e"
    return "v" + w[-1]


def grades(name: str, kind: str = "last") -> bool:
    cls = classify(name, kind)
    if cls in ("nen", "cons"):
        return False
    stem = name if cls != "e" else name[:-1] + "e"
    return weaken(stem, single=cls == "e") != stem


def _rule_forms(word: str, kind: str) -> dict[str, str]:
    hv = harmony(word)
    A = _h("A", hv)
    cls = classify(word, kind)
    if cls == "nen":
        base = word[:-3]
        strong = weak = base + "se"
        par, pl_gen, pl = base + "sta", base + "sten", base + "si"
        pl_par, pl_weak = pl + A, pl
    elif cls == "cons":
        strong = weak = word + "i"
        par, pl_gen = strong + A, word + "ien"
        pl = pl_weak = word + "ei"
        pl_par = word + "ej" + A
    elif cls == "e":
        strong = word[:-1] + "e"
        weak = weaken(strong, single=True)
        par = strong + A
        pl, pl_weak = word, weak[:-1] + "i"
        pl_gen, pl_par = pl + "en", pl + A
    else:
        strong, weak = word, weaken(word)
        par = strong + A
        last = word[-1].lower()
        if last in "ouyö":
            pl, pl_weak = strong + "i", weak + "i"
            pl_gen, pl_par = strong + "jen", strong + "j" + A
        elif last == "e":
            pl, pl_weak = strong + "i", weak + "i"
            pl_gen, pl_par = strong + "jen", strong + "j" + A
        else:  # a, ä, i
            pl, pl_weak = strong[:-1] + "i", weak[:-1] + "i"
            pl_gen, pl_par = strong[:-1] + "ien", strong[:-1] + ("ej" + A if last == "i" else "i" + A)
    ill_v = strong[-1]
    f = {
        "NOM": word, "GEN": weak + "n", "PAR": par, "ESS": strong + "n" + A,
        "TRA": weak + "ksi", "INE": weak + "ss" + A, "ELA": weak + "st" + A,
        "ILL": strong + ill_v + "n", "ADE": weak + "ll" + A, "ABL": weak + "lt" + A,
        "ALL": weak + "lle", "ABE": weak + "tt" + A,
        "PL_NOM": weak + "t", "PL_GEN": pl_gen, "PL_PAR": pl_par,
        "PL_INS": pl_weak + "n", "PL_COM": pl + "neen",
    }
    poss_stem = strong if cls != "cons" else word + "i"
    for p, suf in POSS.items():
        f[f"NOM+POSS_{p}"] = poss_stem + _h(suf, hv)
    return f


def _clitics(f: dict[str, str], word: str) -> dict[str, str]:
    hv = harmony(word)
    return {**f, **{f"{c}+{k}": f[c] + _h(suf, hv) for c in CLITIC_CASES for k, suf in CLITICS.items()}}


def _compound(name: str, kind: str) -> dict[str, str]:
    """Inflect only the last part of a hyphenated name (Anna-Liisa -> Anna-Liisan)."""
    if "-" in name:
        head, tail = name.rsplit("-", 1)
        return {k: f"{head}-{v}" for k, v in _rule_forms(tail, kind).items()}
    return _rule_forms(name, kind)


class _Omorfi:
    def __init__(self, models: Path):
        import pyhfst  # Apache-2.0 reader; models are GPL-3 data in this container only

        self.describe = pyhfst.HfstInputStream(str(models / "omorfi.describe.hfst")).read()
        self.generate = pyhfst.HfstInputStream(str(models / "omorfi.generate.hfst")).read()

    def analyses(self, word: str) -> list[str]:
        return [a for a, _ in self.describe.lookup(word) if "[UPOS=PROPN]" in a and "BOUNDARY" not in a]

    def prefix(self, name: str, kind: str) -> str | None:
        want = "[PROPER=FIRST]" if kind == "first" else "[PROPER=LAST]"
        nom = [a for a in self.analyses(name) if a.endswith("[NUM=SG][CASE=NOM]") and f"[WORD_ID={name}]" in a]
        nom.sort(key=lambda a: (want not in a, "BLACKLIST" in a))
        return nom[0][: -len("[NUM=SG][CASE=NOM]")] if nom else None

    def forms(self, name: str, kind: str, prefer: dict[str, str]) -> dict[str, str]:
        pre = self.prefix(name, kind)
        if not pre:
            return {}
        out = {}
        for key, tags in KEYS.items():
            res = [f for f, _ in self.generate.lookup(pre + tags)]
            if res:  # several variants (Virtasten, Virtasien): keep the rule form when Omorfi agrees
                out[key] = prefer.get(key) if prefer.get(key) in res else res[0]
        return out


@lru_cache(maxsize=1)
def omorfi() -> _Omorfi | None:
    d = os.environ.get("OMORFI_MODELS")
    if not d or not (Path(d) / "omorfi.generate.hfst").exists():
        return None
    return _Omorfi(Path(d))


@lru_cache(maxsize=20000)
def rule_forms(name: str, kind: str = "last") -> dict[str, str]:
    """Suffix-rule paradigm only (fast; used to test candidate lemmas)."""
    return _clitics(_compound(name, kind), name)


FORMS_DIR = Path(__file__).resolve().parents[1] / "data" / "forms"


@lru_cache(maxsize=2)
def table(kind: str) -> dict[str, dict[str, str]]:
    """Forms precomputed at image build by scripts/precompute_forms.py; empty when the file is absent."""
    try:
        with gzip.open(FORMS_DIR / f"{kind}.json.gz", "rt", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


@lru_cache(maxsize=20000)
def generate_forms(name: str, kind: str = "last") -> dict[str, str]:
    """Map case key -> surface form. Omorfi output wins; rules fill the gaps."""
    if name in table(kind):
        return table(kind)[name]
    om = omorfi()
    rules = _compound(name, kind)
    return _clitics({**rules, **(om.forms(name, kind, rules) if om else {})}, name)


def case_of(form: str, name: str, kind: str = "last") -> str | None:
    """Return the case key of a surface form of `name`, or None."""
    for key, f in generate_forms(name, kind).items():
        if f == form:
            return key
    return None


if __name__ == "__main__":
    for n in ["Virtanen", "Mäkelä", "Lahti", "Kokko", "Anna-Liisa", "Lindqvist", "Mäki", "Pekka"]:
        print(n, generate_forms(n))
