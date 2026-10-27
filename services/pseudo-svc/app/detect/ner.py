"""Layer 4: Presidio + spaCy fi_core_news_lg (0003 question 2). Off when PSEUDO_NER=0."""

import logging
import os
import re
from functools import lru_cache
from pathlib import Path

from . import Candidate

CONF = Path(__file__).resolve().parents[2] / "presidio-fi.yaml"


def enabled() -> bool:
    return os.environ.get("PSEUDO_NER", "1") != "0"


@lru_cache(maxsize=1)
def engine():
    """Presidio analyzer, or None when it or the spaCy model is not installed (local runs)."""
    if not enabled():
        return None
    try:
        from presidio_analyzer import AnalyzerEngine
        from presidio_analyzer.nlp_engine import NlpEngineProvider

        nlp = NlpEngineProvider(conf_file=str(CONF)).create_engine()
        return AnalyzerEngine(nlp_engine=nlp, supported_languages=["fi"])
    except (ImportError, OSError) as e:
        logging.getLogger("pseudo").warning("ner layer off: %s", type(e).__name__)
        return None


NAME_TOKEN = re.compile(r"[A-ZÅÄÖ][a-zåäöéü]+(?:-[A-ZÅÄÖ][a-zåäöéü]+)?")


def plausible(span: str, at_start: bool = False) -> bool:
    """spaCy tags SKU-123, 'B.' and sentence-initial nouns (Koski, Juhannus, Mentorini) as PERSON: keep only
    capitalised name-shaped tokens, and a single token only when it is no ordinary word or place, and at a
    sentence start only when the lexicon knows it as a name."""
    from .gazetteer import common_word, known_name, place

    toks = span.split()
    if not toks or not all(NAME_TOKEN.fullmatch(t) for t in toks):
        return False
    if len(toks) > 1:
        return True
    return not (common_word(toks[0]) or place(toks[0])) and (not at_start or known_name(toks[0]))


def detect(text: str, ctx=None) -> list[Candidate]:
    if not engine():
        return []
    from .gazetteer import _sentence_start

    out = []
    for r in engine().analyze(text=text, language="fi", entities=["PERSON"]):
        s = text[r.start:r.end]
        if plausible(s, _sentence_start(text, r.start)):
            out.append(Candidate(r.start, r.end, "PERSON", s, "ner", float(r.score), s))
    return out
