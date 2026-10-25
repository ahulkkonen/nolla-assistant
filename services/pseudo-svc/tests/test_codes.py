import pytest

from app.detect.codes import detect, hetu_valid, iban_valid


def kinds(text):
    return [(c.kind, c.surface) for c in detect(text)]


@pytest.mark.parametrize("code", ["131052-308T", "010594Y9032", "010100A123D", "290200B002C", "010105F456E",
                                  "311299U333Y", "150387-9451", "131052-308t"])
def test_hetu_valid(code):
    assert hetu_valid(code)


@pytest.mark.parametrize("code", [
    "131052-308X",  # wrong check character
    "131052-000V",  # individual number 000
    "131052-0014",  # 001 is never issued
    "290201B002C",  # 29 Feb 2001 does not exist
    "290200+002C",  # 1800 group: 29 Feb 1800 does not exist
    "131052G308T",  # G is no separator
])
def test_hetu_invalid(code):
    assert not hetu_valid(code)


def test_hetu_in_text_and_decoy():
    assert kinds("Hetu 150387-9451 ja väärä 150387-9452.") == [("HETU", "150387-9451")]


def test_iban():
    assert iban_valid("FI21 1234 5600 0007 85") and not iban_valid("FI21 1234 5600 0007 86")
    assert iban_valid("DE35370400445242731672")
    assert ("IBAN", "FI21 1234 5600 0007 85") in kinds("Tili FI21 1234 5600 0007 85, kiitos.")
    assert ("IBAN", "12345600000785") in kinds("Tilinumero on 12345600000785.")
    assert ("IBAN", "123456-785") in kinds("Vanha muoto 123456-785 vielä.")
    assert not [k for k in kinds("Tilausnumero 12345600000785.") if k[0] == "IBAN"]


def test_phones():
    found = kinds("Soita 040 123 4567, +358 50 1234567, (09) 310 4471 tai +46 70 123 45 67.")
    assert [s for k, s in found if k == "PHONE"] == ["040 123 4567", "+358 50 1234567", "(09) 310 4471", "+46 70 123 45 67"]
    assert not kinds("Tilausnumero 4501 234 5678 ja arkistotunnus 0401-2025-117.")


def test_plates_need_context():
    assert ("PLATE", "ABC-123") in kinds("Auton rekisterinumero on ABC-123.")
    assert ("PLATE", "ÅL-12345") in kinds("Ahvenanmaan kilpi ÅL-12345 näkyi.")
    assert not kinds("Tuotekoodi SKU-123 on loppu.")
    assert not kinds("ABC-012 auto")  # numbers never start with 0


def test_addresses_and_postcodes():
    found = kinds("Asun Hämeenkadulla 21 A 4, 33100 Tampereella. Paketti Asema-aukiolta 1 ja Kalevankaari 11 as 3.")
    assert ("ADDRESS", "Hämeenkadulla 21 A 4") in found
    assert ("POSTCODE_CITY", "33100") in found
    assert ("ADDRESS", "Asema-aukiolta 1") in found
    assert ("ADDRESS", "Kalevankaari 11 as 3") in found
    assert not kinds("Remontti maksoi 12500 euroa.")


def test_email():
    assert kinds("Posti matti.v@example.com nyt") == [("EMAIL", "matti.v@example.com")]
