from app import mask as M
from app import surrogate as S

U = "u1"


def mask(v, text, session="s1"):
    return M.mask(v, U, session, text)


def unmask(v, text):
    return M.unmask(v, U, text)


def test_round_trip_with_inflection(vault):
    S.get_or_create_entity(vault, U, "PERSON", "Mikko Virtanen")
    text = "Soitin Mikko Virtaselle ja sitten Virtasen vaimolle."
    masked, spans = mask(vault, text)
    assert "Virta" not in masked and len(spans) == 2
    restored, uspans, unresolved, hold = unmask(vault, masked)
    assert restored == text and not unresolved and hold == 0
    assert [restored[s["start"]:s["end"]] for s in uspans] == ["Mikko Virtaselle", "Virtasen"]


def test_codes_mask_and_restore(vault):
    text = "Hetu 131052-308T, tili FI21 1234 5600 0007 85, puh. 040 123 4567, posti matti.v@example.com."
    masked, spans = mask(vault, text)
    assert [s["kind"] for s in spans] == ["HETU", "IBAN", "PHONE", "EMAIL"]
    assert "131052-308T" not in masked and "048 " in masked and "@example.invalid" in masked
    hetu = spans[0]["surrogate"]
    assert 900 <= int(hetu[7:10]) <= 999 and hetu[6] == "-"
    assert unmask(vault, masked)[0] == text


def test_shared_first_name_gets_distinct_surrogates(vault):
    a = S.get_or_create_entity(vault, U, "PERSON", "Matti Laine")
    b = S.get_or_create_entity(vault, U, "PERSON", "Matti Virtanen")
    assert a["surrogate"].split()[0] != b["surrogate"].split()[0]


def test_surrogates_are_deterministic(tmp_path):
    from app.vault import Vault

    got = [S.get_or_create_entity(Vault(str(tmp_path / f"{i}.db"), "k"), U, "PERSON", "Sanna Hyvönen")["surrogate"]
           for i in range(2)]
    assert got[0] == got[1] and got[0].split()[1].endswith("nen")


def test_pending_lane(vault):
    masked, spans = mask(vault, "Sirpa soitti eilen.")
    assert spans and spans[0]["pending"] and "Sirpa" not in masked
    assert [p["text"] for p in vault.pending_list(U)] == ["Sirpa"]


def test_allowlist_and_never_detect(vault):
    a = S.get_or_create_entity(vault, U, "PERSON", "Mikko Virtanen")
    vault.set_fields(U, a["id"], allowlisted=1)
    assert mask(vault, "Mikko Virtanen tuli.")[0] == "Mikko Virtanen tuli."
    b = S.get_or_create_entity(vault, U, "PHONE", "+358401234567", "040 123 4567")
    vault.add_never_detect(U, b["kind"], b["canonical"])
    assert mask(vault, "Soita 040 123 4567.")[0] == "Soita 040 123 4567."


def test_merge_repoints_spans(vault):
    a = S.get_or_create_entity(vault, U, "PERSON", "Mikko Virtanen")
    mask(vault, "Mikko Virtanen tuli.")
    b = S.get_or_create_entity(vault, U, "PERSON", "Mikko Wirtanen")  # the same person, typo
    masked, spans = mask(vault, "Mikko Wirtaselle soitettiin.")
    assert spans[0]["entity_id"] == b["id"]
    vault.merge(U, [b["id"]], a["id"])
    assert {r[0] for r in vault.q("SELECT entity_id FROM span WHERE user_id=?", (U,))} == {a["id"]}
    assert vault.entity(U, b["id"]) is None and vault.q("SELECT from_id, into_id FROM merge_log")[0][:] == (b["id"], a["id"])
    row = next(r for r in vault.list_entities(U) if r["id"] == a["id"])
    assert row["seen_count"] == 2 and row["last_seen"].endswith("Z")
    restored, uspans, _, _ = unmask(vault, masked)
    assert restored == "Mikko Virtaselle soitettiin." and uspans[0]["entity_id"] == a["id"]  # merged identity


def test_json_structure_kept(vault):
    value = {"content": [{"type": "text", "text": "Hetu 131052-308T"}], "n": 3, "ok": True, "k": None}
    masked, spans = M.mask(vault, U, "s1", json=value)
    assert masked["n"] == 3 and masked["ok"] is True and masked["k"] is None
    assert "131052-308T" not in masked["content"][0]["text"] and spans[0]["path"] == ["content", 0, "text"]
    assert M.unmask(vault, U, json=masked)[0] == value


def test_self_label(vault, monkeypatch):
    monkeypatch.setenv("SELF_NAME", "Aleksi Hulkkonen")
    masked, spans = mask(vault, "Aleksi Hulkkosen kalenteri.")
    assert masked == "[sinä] kalenteri." and spans[0]["kind"] == "SELF"
    # restores to the configured name for tools; never mapped to a third-party name
    assert unmask(vault, "Kysy [sinä], kiitos.")[0] == "Kysy Aleksi Hulkkonen, kiitos."
    monkeypatch.delenv("SELF_NAME")
    assert M.unmask(vault, "u2", "Kysy [sinä], kiitos.")[0] == "Kysy [sinä], kiitos."


def test_astral_offsets_are_utf16(vault):
    S.get_or_create_entity(vault, U, "PERSON", "Mikko Virtanen")
    masked, spans = mask(vault, "😀 Mikko Virtanen 😀")
    s = spans[0]
    units = masked.encode("utf-16-le")
    assert s["start"] == 3 and units[s["start"] * 2:s["end"] * 2].decode("utf-16-le") == s["surrogate"]
    _, uspans, _, _ = unmask(vault, masked)
    assert uspans[0]["start"] == 3 and uspans[0]["end"] == 3 + len("Mikko Virtanen")


def test_hold_for_streamed_prefix(vault):
    real = S.real_rows("PERSON", "Mikko Virtanen", "")
    surr = S.name_rows([("first", "Juha"), ("last", "Laaksonen")])
    vault.create(U, "PERSON", "Mikko Virtanen", "Juha Laaksonen", None, real, surr)
    assert unmask(vault, "Terve Laak")[3] == 4
    assert unmask(vault, "Terve Laaksoselle")[0] == "Terve Virtaselle"
    assert unmask(vault, "Terve.")[3] == 0


def test_unknown_name_gets_surrogate(vault):
    e = S.get_or_create_entity(vault, U, "PERSON", "Xyzzy Qwertyläinen")  # NER finds names DVV lacks
    assert len(e["surrogate"].split()) == 2 and e["surrogate"].endswith("nen")


def test_ner_filter():
    from app.detect.ner import plausible

    assert plausible("Mikko Virtanen") and plausible("Hulkkonen")
    assert not any(map(plausible, ["SKU-123", "B.", "ma 3.11", "Helsinki"]))
