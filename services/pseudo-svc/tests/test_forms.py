import os

import pytest

from app.forms import case_of, generate_forms, omorfi

PAIRS = [
    ("Virtanen", "last", "ALL", "Virtaselle"), ("Virtanen", "last", "GEN", "Virtasen"),
    ("Virtanen", "last", "PAR", "Virtasta"), ("Virtanen", "last", "ADE", "Virtasella"),
    ("Virtanen", "last", "INE", "Virtasessa"), ("Virtanen", "last", "ELA", "Virtasesta"),
    ("Virtanen", "last", "ILL", "Virtaseen"), ("Virtanen", "last", "ESS", "Virtasena"),
    ("Virtanen", "last", "TRA", "Virtaseksi"), ("Virtanen", "last", "ABL", "Virtaselta"),
    ("Virtanen", "last", "ABE", "Virtasetta"), ("Virtanen", "last", "PL_PAR", "Virtasia"),
    ("Virtanen", "last", "PL_GEN", "Virtasten"), ("Virtanen", "last", "NOM+POSS_SG1", "Virtaseni"),
    ("Virtanen", "last", "ALL+KIN", "Virtasellekin"), ("Virtanen", "last", "GEN+HAN", "Virtasenhan"),
    ("Virtanen", "last", "NOM+KO", "Virtanenko"),
    ("Mäkelä", "last", "GEN", "Mäkelän"), ("Mäkelä", "last", "ALL", "Mäkelälle"),
    ("Mäkelä", "last", "PAR", "Mäkelää"), ("Mäkelä", "last", "INE", "Mäkelässä"),
    ("Mäkelä", "last", "NOM+KO", "Mäkeläkö"),
    ("Lahti", "last", "GEN", "Lahden"), ("Lahti", "last", "PAR", "Lahtea"), ("Lahti", "last", "ILL", "Lahteen"),
    ("Lahti", "last", "ELA", "Lahdesta"), ("Lahti", "last", "ALL+KIN", "Lahdellekin"),
    ("Kokko", "last", "GEN", "Kokon"), ("Kokko", "last", "ALL", "Kokolle"), ("Kokko", "last", "PAR", "Kokkoa"),
    ("Hyvönen", "last", "ALL", "Hyvöselle"), ("Hyvönen", "last", "ABL", "Hyvöseltä"),
    ("Hyvönen", "last", "GEN+HAN", "Hyvösenhän"),
    ("Anna-Liisa", "first", "GEN", "Anna-Liisan"), ("Anna-Liisa", "first", "ALL", "Anna-Liisalle"),
    ("Lindqvist", "last", "GEN", "Lindqvistin"), ("Lindqvist", "last", "PAR", "Lindqvistiä"),
    ("Lindqvist", "last", "TRA", "Lindqvistiksi"),
    ("Åkerlund", "last", "GEN", "Åkerlundin"), ("Åkerlund", "last", "ILL", "Åkerlundiin"),
    ("Turkka", "last", "GEN", "Turkan"), ("Turkka", "last", "ABL", "Turkalta"),
    ("Mäki", "last", "GEN", "Mäen"), ("Matti", "first", "ABE", "Matitta"),
]


@pytest.mark.parametrize("name,kind,case,form", PAIRS)
def test_known_pairs(name, kind, case, form):
    assert generate_forms(name, kind)[case] == form
    assert case_of(form, name, kind) == case


def test_paradigm_size():
    f = generate_forms("Hulkkonen", "last")
    assert len(f) >= 15 + 3 + 3 * 2 and f["ALL"] == "Hulkkoselle"


@pytest.mark.skipif(not os.environ.get("OMORFI_MODELS"), reason="Omorfi models not present")
def test_omorfi_generates_known_and_unknown_names():
    assert omorfi() is not None
    f = generate_forms("Hulkkonen", "last")
    assert [f[c] for c in ("GEN", "PAR", "ALL", "ILL")] == ["Hulkkosen", "Hulkkosta", "Hulkkoselle", "Hulkkoseen"]
    # not in the lexicon: the rules fill in
    assert omorfi().prefix("Qwertyläinen", "last") is None
    assert generate_forms("Qwertyläinen", "last")["ALL"] == "Qwertyläiselle"
