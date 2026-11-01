import re

import pytest
from conftest import KEY

from app import forms
from app import mask as M
from app import surrogate as S
from app.detect import gazetteer

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
    text = "Hetu 131052-913A, tili FI21 1234 5600 0007 85, puh. 040 123 4567, posti matti.v@example.com."
    masked, spans = mask(vault, text)
    assert [s["kind"] for s in spans] == ["HETU", "IBAN", "PHONE", "EMAIL"]
    assert "131052-913A" not in masked and "048 " in masked and "@example-1.invalid" in masked  # a company domain
    hetu = spans[0]["surrogate"]
    assert 900 <= int(hetu[7:10]) <= 999 and hetu[6] == "-"
    assert unmask(vault, masked)[0] == text


def test_shared_first_name_gets_distinct_surrogates(vault):
    a = S.get_or_create_entity(vault, U, "PERSON", "Matti Laine")
    b = S.get_or_create_entity(vault, U, "PERSON", "Matti Virtanen")
    assert a["surrogate"].split()[0] != b["surrogate"].split()[0]


def test_surrogates_are_deterministic(tmp_path):
    from app.vault import Vault

    got = [S.get_or_create_entity(Vault(str(tmp_path / f"{i}.db"), KEY, b"s" * 32), U, "PERSON", "Sanna Hyvönen")["surrogate"]
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
    value = {"content": [{"type": "text", "text": "Hetu 131052-913A"}], "n": 3, "ok": True, "k": None}
    masked, spans = M.mask(vault, U, "s1", json=value)
    assert masked["n"] == 3 and masked["ok"] is True and masked["k"] is None
    assert "131052-913A" not in masked["content"][0]["text"] and spans[0]["path"] == ["content", 0, "text"]
    assert M.unmask(vault, U, json=masked)[0] == value


def test_self_label(vault, monkeypatch):
    monkeypatch.setenv("SELF_NAME", "Juho Rantanen")
    masked, spans = mask(vault, "Juho Rantasen kalenteri.")
    assert masked == "[sinä] kalenteri." and spans[0]["kind"] == "SELF"
    # restores to the configured name for tools; never mapped to a third-party name
    assert unmask(vault, "Kysy [sinä], kiitos.")[0] == "Kysy Juho Rantanen, kiitos."
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

    assert plausible("Mikko Virtanen") and plausible("Pulkkinen")
    assert not any(map(plausible, ["SKU-123", "B.", "ma 3.11", "Helsinki"]))


def test_secret_seeds_surrogates(tmp_path):
    from app.vault import Vault

    a = Vault(str(tmp_path / "a.db"), KEY, b"a" * 32)
    b = Vault(str(tmp_path / "b.db"), KEY, b"b" * 32)
    names = ["Mikko Virtanen", "Sanna Hyvönen", "Pekka Lahti"]
    assert [S.get_or_create_entity(a, U, "PERSON", n)["surrogate"] for n in names] != \
        [S.get_or_create_entity(b, U, "PERSON", n)["surrogate"] for n in names]
    assert Vault(str(tmp_path / "a.db"), KEY).secret == b"a" * 32  # stored in the vault, survives reopen


def test_placeholder_numbers_survive_merge(vault):
    a = S.get_or_create_entity(vault, U, "PERSON", "Mikko Virtanen")
    b = S.get_or_create_entity(vault, U, "PERSON", "Mikko Wirtanen")
    S.set_placeholder(vault, U, a)
    S.set_placeholder(vault, U, b)
    vault.merge(U, [b["id"]], a["id"])
    c = S.get_or_create_entity(vault, U, "PERSON", "Sanna Hyvönen")
    S.set_placeholder(vault, U, c)
    assert vault.entity(U, c["id"])["surrogate"] == "[henkilö 3]"


def test_surrogate_conflict_raises(vault):
    import pytest
    from app.vault import SurrogateConflict

    a = S.get_or_create_entity(vault, U, "PERSON", "Mikko Virtanen")
    b = S.get_or_create_entity(vault, U, "PERSON", "Sanna Hyvönen")
    with pytest.raises(SurrogateConflict):
        vault.add_forms(U, b["id"], "surrogate", [(a["surrogate"].split()[0], "NOM", "first")])
    other = S.get_or_create_entity(vault, "u2", "PERSON", "Pekka Lahti")
    vault.add_forms("u2", other["id"], "surrogate", [(a["surrogate"].split()[0], "NOM", "first")])  # per user


def test_pool_exhausted_falls_back_to_placeholder(vault, monkeypatch):
    monkeypatch.setattr(vault, "surrogate_taken", lambda user_id, forms: True)
    e = S.get_or_create_entity(vault, U, "PERSON", "Mikko Virtanen")
    assert e["surrogate_mode"] == "placeholder" and e["surrogate"] == "[henkilö 1]"


def test_split_moves_only_own_spans(vault):
    a = S.get_or_create_entity(vault, U, "PERSON", "Mikko Virtanen")
    b = S.get_or_create_entity(vault, U, "PERSON", "Sanna Hyvönen")
    mask(vault, "Mikko Virtanen ja Sanna Hyvönen.")
    ids = [r[0] for r in vault.q("SELECT id FROM span WHERE user_id=?", (U,))]
    new = S.split(vault, U, a["id"], ids)
    owners = sorted(r[0] for r in vault.q("SELECT entity_id FROM span WHERE user_id=?", (U,)))
    assert owners == sorted([new, b["id"]])


def test_surrogates_are_not_masked_again(vault):
    S.get_or_create_entity(vault, U, "PERSON", "Mikko Virtanen")
    masked, _ = mask(vault, "Soitin Mikko Virtaselle, puh. 040 123 4567.")
    again, spans = mask(vault, masked)
    assert again == masked and spans == []
    # another session never sent this name: it may be a real person with that name, so mask it.
    # The phone surrogate (048 range) is skipped everywhere.
    assert [s["kind"] for s in mask(vault, masked, session="s2")[1]] == ["PERSON"]


def test_pending_dedupe_and_confirm(vault):
    for _ in range(2):
        mask(vault, "Sirpa soitti eilen.")
    rows = vault.pending_list(U)
    assert len(rows) == 1
    vault.pending_set(U, rows[0]["id"], "dismissed")
    mask(vault, "Sirpa soitti taas.")
    assert vault.pending_list(U) == []  # a dismissed row also blocks re-queueing
    eid = vault.q("SELECT entity_id FROM pending")[0][0]
    vault.set_fields(U, eid, confirmed=1)
    assert not mask(vault, "Sirpa soitti.")[1][0]["pending"]


def test_never_detect_keeps_restoring_old_surrogates(vault):
    a = S.get_or_create_entity(vault, U, "PERSON", "Mikko Virtanen")
    masked, _ = mask(vault, "Mikko Virtanen tuli.")
    vault.add_never_detect(U, a["kind"], a["canonical"])
    assert mask(vault, "Mikko Virtanen tuli.")[0] == "Mikko Virtanen tuli."
    assert unmask(vault, masked)[0] == "Mikko Virtanen tuli."


def test_email_length_cap():
    from app.detect.codes import detect

    assert not [c for c in detect("a" * 64 + "@" + ("b" * 63 + ".") * 4 + "fi") if c.kind == "EMAIL"]


def test_ten_new_people_compile_the_matcher_at_most_twice(vault):
    from app.detect import vault_rec

    people = ["Mikko Virtanen", "Anna Korhonen", "Juha Mäkinen", "Liisa Nieminen", "Pekka Laine",
              "Maria Heikkinen", "Timo Koskinen", "Sari Järvinen", "Jukka Lehtonen", "Tiina Saarinen"]
    text = "Tapaamisessa olivat " + ", ".join(people) + ". Myöhemmin Mikko Virtasen kanssa puhuttiin."
    before = vault_rec.compiles
    masked, spans = mask(vault, text)
    assert vault_rec.compiles - before <= 2
    assert len([s for s in spans if s["kind"] == "PERSON"]) >= 11
    assert "Virtan" not in masked and "Korhon" not in masked


def _entities(v) -> int:
    return v.q("SELECT count(*) FROM entity WHERE user_id=?", (U,))[0][0]


def test_lowercase_inflected_name_is_masked(vault):
    # the incident sentence: a lower-case genitive typed on a phone reached the model unmasked
    masked, spans = mask(vault, "tiina heinon kanssa")
    e = vault.entity(U, spans[0]["entity_id"])
    assert e["canonical"] == "Tiina Heino" and masked == f"{spans[0]['surrogate']} kanssa"
    assert spans[0]["surrogate"] == f"{e['surrogate'].split()[0]} {S.surrogate_form(e, 'last', 'GEN')}"
    for text in ["en ole nähnyt tiina heinoa", "menen huomenna tiina heinoon", "Tiina Heinon kanssa"]:
        got, sp = mask(vault, text)
        assert "heino" not in got.lower() and [s["entity_id"] for s in sp] == [e["id"]]
    assert unmask(vault, masked)[0] == "Tiina Heinon kanssa"


def test_masked_surrogate_keeps_its_surrogate(vault):
    masked, spans = mask(vault, "Tiina Heinon kanssa")
    e = vault.entity(U, spans[0]["entity_id"])
    first, last = e["surrogate"].split()
    n = _entities(vault)
    echoes = [masked, f"Kirjoitit {first} {last}.", f"Soitin {S.surrogate_form(e, 'last', 'ALL')}.",
              f"{first.lower()} {S.surrogate_form(e, 'last', 'GEN').lower()} kanssa"]
    for text in echoes:  # the model echoes the surrogate: no second surrogate, in any form
        assert mask(vault, text) == (text, [])
        assert M.scan(vault, U, "s1", [{"role": "assistant", "content": text}])[1] == []
    assert _entities(vault) == n
    assert mask(vault, "tiina heinon kanssa")[0] == masked  # the real name keeps the same surrogate
    assert mask(vault, masked, session="s1/sub/1") == (masked, [])  # a subagent of the chat


def test_lone_name_of_a_full_name_in_the_same_text_is_that_person(vault):
    masked, spans = mask(vault, "Tapasin Liisa Kallion eilen. Liisalle soitin tänään.")
    assert len({s["entity_id"] for s in spans}) == 1 and "Liisa" not in masked


def test_scan_takes_json_messages_and_leaves_numbers_alone(vault):
    from app.detect.codes import detect

    assert not [c for c in detect('"total":0.0107338, summa 1.0401234567') if c.kind == "PHONE"]
    S.get_or_create_entity(vault, U, "PERSON", "Tiina Heino")
    msg = {"role": "assistant", "content": [{"type": "text", "text": "Tiina Heino"}],
           "usage": {"cost": {"total": 0.0107338}}, "timestamp": 1792959932652}
    out, leaked = M.scan(vault, U, "s1", [{"role": "assistant", "content": msg},
                                          {"role": "user", "content": {"role": "user", "content": "tiina heinon kanssa"}},
                                          {"role": "assistant", "content": "tiina heinon kanssa"}])
    assert out[0]["content"]["usage"] == msg["usage"] and out[0]["content"]["timestamp"] == msg["timestamp"]
    assert "Heino" not in out[0]["content"]["content"][0]["text"]
    assert "heino" not in out[1]["content"]["content"]  # user text: lower-case names too
    assert out[2]["content"] == "tiina heinon kanssa"  # model text: capitalised names only
    assert [x["message_index"] for x in leaked] == [0, 1]


def test_lowercase_names_skip_json_and_paths(vault):
    S.get_or_create_entity(vault, U, "PERSON", "Tiina Heino")
    value = {"path": "/data/work/tiina", "text": "tiina heinon kanssa"}
    assert M.mask(vault, U, "s1", json=value) == (value, [])  # tool results: capitalised names only
    assert mask(vault, "katso /data/work/tiina/ja tiina.txt")[1] == []


needs_lexicon = pytest.mark.skipif(gazetteer._voikko() is None and forms.omorfi() is None,
                                   reason="lone lower-case names need Voikko or Omorfi (the Docker image)")


@needs_lexicon
def test_lowercase_lone_names_and_ordinary_words(vault):
    for text, canonical in [("soitin eilen tiinalle", "Tiina"), ("virtasen kanssa sovittiin", "Virtanen"),
                            ("kävin eilen korhosella", "Korhonen")]:
        _, spans = mask(vault, text)
        assert [vault.entity(U, s["entity_id"])["canonical"] for s in spans] == [canonical], text
    # "aino kerta" (only once) is masked: Voikko does not know "aino" as a word, and Aino is a top name
    for text in ["toivo on hyvä asia ja onni myös", "satu kertoi sadun", "meri oli tyyni ja saari kaunis",
                 "max 50 euroa", "tulen illalla kotiin", "usko pois", "lahja oli kiva"]:
        assert mask(vault, text)[1] == [], text


# -- phase 12 (docs/decisions/phase-12-pseudo.md)

def test_surrogate_pairs_are_rare(vault):
    db = gazetteer.names()
    for canonical in ["Mikko Virtanen", "Sanna Hyvönen", "Anna-Liisa Mäkelä", "Matti Juhani Laine", "Erik Åkerlund"]:
        parts = S.get_or_create_entity(vault, U, "PERSON", canonical)["surrogate"].split()
        first, last = db["first"][parts[0]][0], db["last"][parts[-1]]
        assert first * last / S.population() < S.PAIR_MAX, (canonical, parts)
        assert last >= S.LAST_MIN and first >= S.FIRST_MIN
    for canonical in ["Hyvönen", "Sirpa"]:  # one-word surrogates come from names with < LONE_MAX holders
        (name,) = S.get_or_create_entity(vault, U, "PERSON", canonical)["surrogate"].split()
        assert max(db["first"].get(name, (0,))[0], db["last"].get(name, 0)) < S.LONE_MAX
    assert S.pool_pairs() > 1_000_000 and "Juhani" not in S.pools()[("first", None)][0]


def _collide(vault, canonical="Mikko Virtanen"):
    """An entity and user input that names its whole surrogate in the genitive."""
    a = S.get_or_create_entity(vault, U, "PERSON", canonical)
    first, _ = a["surrogate"].split()
    return a, f"Soitin eilen {first} {S.surrogate_form(a, 'last', 'GEN')} kanssa."


def test_collision_parks_user_input_until_answered(vault):
    a, text = _collide(vault)
    mask(vault, "Mikko Virtanen tuli.")  # the surrogate went to the model in this session
    masked, spans, found = M.mask_input(vault, U, "s1", text)
    assert (masked, spans) == ("", []) and found == [{"pending_id": found[0]["pending_id"], "entity_id": a["id"],
                                                     "kind": "PERSON"}]
    assert M.mask_input(vault, U, "s1", text)[2] == found  # asked once, also when sent again
    (row,) = vault.pending_list(U)
    assert (row["reason"], row["entity_id"], row["text"]) == ("collision", a["id"], text[13:-8])
    assert vault.q("SELECT count(*) FROM span WHERE session_id='s1'")[0][0] == 1  # the dropped text left no span
    # a lone part of the surrogate is no collision: a real first name like any other
    assert M.mask_input(vault, U, "s1", f"Hei {a['surrogate'].split()[0]}!")[2] == []
    # not user input (model text, tool results, titles): the old echo rule
    assert mask(vault, text) == (text, [])


def test_expired_collision_asks_again(vault):
    a, text = _collide(vault)
    pid = M.mask_input(vault, U, "s1", text)[2][0]["pending_id"]
    vault.pending_set(U, pid, "expired")  # the held message was dropped
    again = M.mask_input(vault, U, "s1", text)[2]
    assert again and again[0]["pending_id"] != pid


def test_collision_accept_makes_a_new_person_and_renames_the_old(vault):
    a, text = _collide(vault)
    pid = M.mask_input(vault, U, "s1", text)[2][0]["pending_id"]
    S.accept_collision(vault, U, vault.pending_get(U, pid))
    vault.pending_set(U, pid, "accepted")
    masked, spans, found = M.mask_input(vault, U, "s1", text)
    new = vault.entity(U, spans[0]["entity_id"])
    assert found == [] and new["id"] != a["id"] and new["canonical"] == " ".join(a["surrogate"].split())
    assert a["surrogate"].split()[0] not in masked  # the new person has a surrogate of its own
    renamed = vault.entity(U, a["id"])
    assert renamed["surrogate"] != a["surrogate"] and renamed["gen"] == 1
    assert unmask(vault, f"{a['surrogate']} soitti.")[0] == "Mikko Virtanen soitti."  # old transcripts restore


def test_collision_reject_keeps_that_entity_and_pinned_keeps_its_surrogate(vault):
    a, text = _collide(vault)
    pid = M.mask_input(vault, U, "s1", text)[2][0]["pending_id"]
    vault.pending_set(U, pid, "rejected")
    assert M.mask_input(vault, U, "s1", text) == (text, [], [])  # it is that entity's surrogate: stays
    # the reject recorded a span: the model's echo in a tool result keeps the surrogate, and the reply restores
    tool = {"content": [f"Löytyi: {a['surrogate']}"]}
    assert M.mask(vault, U, "s1", json=tool) == (tool, [])
    assert unmask(vault, f"Soitan, {a['surrogate']} vastaa.")[0] == "Soitan, Mikko Virtanen vastaa."
    b, text_b = _collide(vault, "Sanna Hyvönen")
    vault.set_fields(U, b["id"], pinned=1)
    S.accept_collision(vault, U, vault.pending_get(U, M.mask_input(vault, U, "s1", text_b)[2][0]["pending_id"]))
    assert vault.entity(U, b["id"])["surrogate"] == b["surrogate"]


def test_email_surrogates_keep_the_domain_class(vault):
    masked, spans = mask(vault, "Kirjoitin tuomas@firma.fi:hin, liisa@firma.fi ja x.y@gmail.com sekä a@toinen.fi.")
    s1, s2, s3, s4 = [s["surrogate"] for s in spans]
    assert s1.endswith("@example-1.invalid:iin") and s2.endswith("@example-1.invalid")  # same domain, same N
    assert s4.endswith("@example-2.invalid")
    assert re.fullmatch(r"[a-z]+\.[a-z]+\d\d@gmail\.com", s3)  # webmail stays webmail
    # the case moves to the surrogate's ending class (fi:hin -> invalid:iin) and back
    assert unmask(vault, masked)[0] == "Kirjoitin tuomas@firma.fi:hin, liisa@firma.fi ja x.y@gmail.com sekä a@toinen.fi."
    e = vault.entity(U, spans[0]["entity_id"])
    assert S.surrogate_form(e, "", "ELA") == e["surrogate"] + ":ista"


def test_street_and_postcode_are_two_spans(vault):
    text = "Asumme Lehtikaarteella 4, 02210 Espoo. Mökki: Strandvägen 3."
    masked, spans = mask(vault, text)
    assert [s["kind"] for s in spans] == ["ADDRESS", "POSTCODE_CITY", "ADDRESS"] and "02210" not in masked
    assert re.search(r"[A-ZÅÄÖ][a-zäö]+kaarteella \d+, 099\d\d Espoo", masked) and "vägen " in masked
    assert unmask(vault, masked)[0] == text
    assert mask(vault, "asun koivukuja 7 b 12")[1][0]["kind"] == "ADDRESS"  # plain text: lower case too
    assert M.mask(vault, U, "s1", json={"p": "koivukuja 7 b 12"})[1] == []  # tool results: capitalised only


def test_lower_case_nickname_of_a_new_person(vault):
    masked, spans = mask(vault, "veikko hakala soitti ja veke tulee illalla")
    assert len(spans) == 2 and len({s["entity_id"] for s in spans}) == 1 and "veke" not in masked


def test_lone_surname_needs_200_holders_and_a_surname_form():
    from app.detect.gazetteer import LONE_SURNAME_MIN, surname_shaped

    assert surname_shaped("Lahtiseksi") == "Lahtinen" and surname_shaped("Nyströmille") == "Nyström"
    assert surname_shaped("Lahtinen") is None and surname_shaped("From") is None  # the nominative is no evidence
    rare = next(n for n, c in gazetteer.names()["last"].items() if n.endswith("nen") and 50 <= c < LONE_SURNAME_MIN)
    assert surname_shaped(forms.generate_forms(rare, "last")["ALL"]) is None


@needs_lexicon
def test_lowercase_lone_surname_rule(vault):
    # Voikko knows Kettunen as a surname; Halinen (822 holders) and Paaso (852) only the DVV list knows
    for text, canonical in [("kysyin kettuselta", "Kettunen"), ("soitin eilen haliselle", "Halinen"),
                            ("vie tämä paasolle", "Paaso")]:
        assert [vault.entity(U, s["entity_id"])["canonical"] for s in mask(vault, text)[1]] == [canonical], text
    # ordinary words that are surnames too (lahtiseksi: Voikko reads it as the adjective lahtinen), and
    # English words that are DVV surnames
    for text in ["kokko paloi juhannuksena", "meri oli tyyni", "nimi vaihtu lahtiseksi", "a gift from said friend"]:
        assert mask(vault, text)[1] == [], text


def test_surname_with_a_particle_is_masked_whole(vault):
    text = "Puhuin eilen Carl von Hertzenin kanssa."
    masked, spans = mask(vault, text)
    assert "Hertzen" not in masked and " von " in masked and len(spans) == 1
    assert unmask(vault, masked)[0] == text


def test_plural_locative_of_a_surname_keeps_its_case(vault):
    e = S.get_or_create_entity(vault, U, "PERSON", "Mikko Virtanen")
    text = "ensin olimme Virtasilla, ja ensi kerralla mennään virtasille."
    masked, spans = mask(vault, text)
    assert [s["surrogate"] for s in spans] == [S.surrogate_form(e, "last", "PL_ADE"), S.surrogate_form(e, "last", "PL_ALL")]
    assert unmask(vault, masked)[0] == "ensin olimme Virtasilla, ja ensi kerralla mennään Virtasille."


def test_full_name_wins_over_a_newer_lone_first_name(vault):
    S.get_or_create_entity(vault, U, "PERSON", "Tiina Kokko")
    S.get_or_create_entity(vault, U, "PERSON", "Tiina")  # newer, owns "tiina" too
    masked, spans = mask(vault, "tiina kokko lähti jo")
    assert masked == spans[0]["surrogate"] + " lähti jo" and len(spans[0]["surrogate"].split()) == 2
    assert vault.entity(U, spans[0]["entity_id"])["canonical"] == "Tiina Kokko"


# -- phase-12 decision 19: a lower-case surname after a first name; a lone first name grows into a full name

def _people(vault):
    return [(r["id"], r["canonical"]) for r in vault.q("SELECT * FROM entity WHERE user_id=? AND kind='PERSON'", (U,))]


def test_first_name_and_lower_case_surname_are_one_person(vault):
    masked, spans = mask(vault, "hei, nimeni on Jari pouta, pidän säästä")
    assert len(spans) == 1 and spans[0]["kind"] == "PERSON" and spans[0]["real_form"] == "Jari pouta"
    assert "Jari" not in masked and "pouta" not in masked
    assert vault.entity(U, spans[0]["entity_id"])["canonical"] == "Jari Pouta"
    # an ordinary word after a first name stays; the first name alone is masked
    masked, spans = mask(vault, "eilen Ville soitti ja kertoi uutiset")
    assert [s["real_form"] for s in spans] == ["Ville"] and " soitti ja" in masked


def _upgrade(vault, session):
    """A lone "Jari" in session s1, then the full name in `session`: returns (entity, old first-name surrogate)."""
    _, spans = mask(vault, "Tänään Jari soitti.")
    lone = vault.entity(U, spans[0]["entity_id"])
    assert lone["canonical"] == "Jari"
    masked, spans = mask(vault, "Tapasin Jari Pouta eilen.", session)
    assert len(spans) == 1 and spans[0]["entity_id"] == lone["id"] and "Pouta" not in masked
    e = vault.entity(U, lone["id"])
    assert e["canonical"] == "Jari Pouta" and _people(vault) == [(lone["id"], "Jari Pouta")]
    first, last = e["surrogate"].split()
    assert first == lone["surrogate"]
    db = gazetteer.names()
    assert db["first"][first][0] * db["last"][last] / S.population() < S.PAIR_MAX
    return e, lone["surrogate"]


def test_lone_first_name_upgrades_in_the_same_session(vault):
    _upgrade(vault, "s1")


def test_lone_first_name_upgrades_without_a_session(vault):
    # the memory injection masks with a session that never saw the person (or none): the only "Jari" fits
    _upgrade(vault, None)


def test_upgraded_person_keeps_resolving(vault):
    e, old = _upgrade(vault, "s1")
    allative = forms.generate_forms("Pouta", "last")["ALL"]  # Poudalle with Omorfi, Poutalle by the rules
    for text in ["huomenna Jari pouta tulee", f"Soitin {allative} eilen.", "jari pouta soitti"]:
        _, spans = mask(vault, text, "s2")
        assert [s["entity_id"] for s in spans] == [e["id"]], text
    first, last = e["surrogate"].split()
    assert unmask(vault, f"Soita {first} {last}.")[0] == "Soita Jari Pouta."
    assert unmask(vault, f"Terveisiä {first} {S.surrogate_form(e, 'last', 'ALL')}.")[0] == f"Terveisiä Jari {allative}."
    assert unmask(vault, f"Moi {old}!")[0] == "Moi Jari!"  # earlier chats keep the first-name surrogate


def test_two_lone_first_names_without_a_session_make_a_new_person(vault):
    a = S.get_or_create_entity(vault, U, "PERSON", "Jari")
    b = S.split(vault, U, a["id"], [])
    _, spans = mask(vault, "Tapasin Jari Pouta eilen.", None)
    e = vault.entity(U, spans[0]["entity_id"])
    assert e["canonical"] == "Jari Pouta" and e["id"] not in (a["id"], b)
    assert sorted(c for _, c in _people(vault)) == ["Jari", "Jari", "Jari Pouta"]


def test_upgrade_takes_the_one_lone_first_name_the_session_saw(vault):
    a = S.get_or_create_entity(vault, U, "PERSON", "Jari")
    b = S.split(vault, U, a["id"], [])
    _, spans = mask(vault, "Tänään Jari soitti.")  # the newest "Jari" wins: the session sees b only
    assert [s["entity_id"] for s in spans] == [b]
    _, spans = mask(vault, "Tapasin Jari Pouta eilen.")
    assert [s["entity_id"] for s in spans] == [b] and vault.entity(U, b)["canonical"] == "Jari Pouta"
    assert vault.entity(U, a["id"])["canonical"] == "Jari"


def test_ordinary_word_pair_never_upgrades(vault):
    _, spans = mask(vault, "Tänään Jari soitti.")
    lone = spans[0]["entity_id"]
    _, spans = mask(vault, "nimeni on Jari pouta")  # pouta is an ordinary word (or no lexicon): 0.75
    assert spans[0]["score"] == 0.75 and spans[0]["entity_id"] != lone
    assert vault.entity(U, lone)["canonical"] == "Jari"
    assert vault.entity(U, spans[0]["entity_id"])["canonical"] == "Jari Pouta"


def test_no_upgrade_when_a_full_name_shares_the_first_name(vault):
    lone = S.get_or_create_entity(vault, U, "PERSON", "Jari")
    S.get_or_create_entity(vault, U, "PERSON", "Jari Virtanen")
    _, spans = mask(vault, "Tapasin Jari Pouta eilen.", None)
    assert spans[0]["entity_id"] != lone["id"] and vault.entity(U, lone["id"])["canonical"] == "Jari"
    assert sorted(c for _, c in _people(vault)) == ["Jari", "Jari Pouta", "Jari Virtanen"]


def test_old_one_word_surrogate_still_collides_after_the_upgrade(vault):
    e, old = _upgrade(vault, "s1")
    masked, spans, found = M.mask_input(vault, U, "s1", f"Hei {old}!")
    assert (masked, spans) == ("", []) and [(f["entity_id"], f["kind"]) for f in found] == [(e["id"], "PERSON")]


def test_title_must_be_the_whole_word():
    assert gazetteer.TITLES.match("dr") and gazetteer.TITLES.match("Naapuri")
    assert gazetteer.TITLES.match("dreijauskurssilla") is None  # "dr" is no title prefix
    _, spans = mask(Vault_(), "Käyn dreijauskurssilla Vantaalla joka toinen viikko.")
    assert spans == []


def Vault_():
    import tempfile

    from app.vault import Vault

    return Vault(str(tempfile.mkdtemp()) + "/v.db", KEY)


@needs_lexicon
def test_two_ordinary_words_are_no_mixed_case_name(vault):
    _, spans = mask(vault, "Ensi vuoden loppuun mennessä tavoittelen B1-tasoa.")
    assert spans == []
    _, spans = mask(vault, "Ensi vuoden alussa Jari pouta soittaa.")
    assert [s["real_form"] for s in spans] == ["Jari pouta"]


@needs_lexicon
def test_first_name_and_inflected_surname_with_a_place_reading(vault):
    # phase-33 decision 2: ranta and salmi are places too, but after a nominative first name they are surnames
    for text, real in [("soitin Anu rannalle mutta hän ei vastannut", "Anu rannalle"),
                       ("soitin Nina lehtiselle ja Mika salmelle", "Mika salmelle")]:
        masked, spans = mask(vault, text)
        assert real in [s["real_form"] for s in spans] and real.split()[1] not in masked, text
    _, spans = mask(vault, "vein Liisan rannalle uimaan")  # a genitive first name: no full name
    assert [s["real_form"] for s in spans] == ["Liisan"]
    _, spans = mask(vault, "onko Riikka kotona jo")  # koto has fewer than LONE_SURNAME_MIN holders
    assert [s["real_form"] for s in spans] == ["Riikka"]


def test_nickname_in_the_vault_is_masked(vault):
    # phase-33 decision 3: the detector does not guess nicknames; the user adds one to the vault once
    text = "Lauri Mattila tuli jo. Late odottaa autossa."
    assert "Late" in mask(vault, text)[0]  # decision 3: a nickname leaks before the vault knows it
    S.get_or_create_entity(vault, U, "PERSON", "Late")  # what POST /vault/seed does
    masked, spans = mask(vault, text, "s2")
    assert "Late" not in masked and "Late" in [s["real_form"] for s in spans]
    assert unmask(vault, masked)[0] == text


@needs_lexicon
def test_ner_drops_unknown_words_at_a_sentence_start():
    from app.detect.ner import plausible

    assert plausible("Pulkkinen", at_start=True) and plausible("Mentorini")
    assert not plausible("Mentorini", at_start=True)


@needs_lexicon
def test_question_word_and_unknown_word_are_no_person(vault):
    _, spans = mask(vault, "Milloin Satamarahdin sopimus uusitaan?")  # Milloin: a form of Milla for Voikko
    assert spans == []
    _, spans = mask(vault, "Eilen Milla Satamarahdin soitti.")
    assert [s["real_form"] for s in spans] == ["Milla Satamarahdin"]
