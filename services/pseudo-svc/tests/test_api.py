import httpx
import pytest

from app import main

pytestmark = pytest.mark.anyio
U = {"user_id": "u1"}


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
async def client(vault):
    main.state["vault"] = vault
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://t") as c:
        yield c


async def post(c, path, body):
    r = await c.post(path, json={**U, **body})
    assert r.status_code == 200, r.text
    return r.json()


async def test_healthz(client):
    assert (await client.get("/healthz")).json()["ok"] is True


async def test_user_id_required(client):
    assert (await client.post("/mask", json={"session_id": "s", "text": "x"})).status_code == 422
    assert (await client.post("/mask", json={**U, "session_id": "s"})).status_code == 422  # neither text nor json
    assert (await client.get("/vault/entities")).status_code == 422


async def test_seed_mask_unmask_scan(client):
    seed = await post(client, "/vault/seed", {"entities": [{"canonical": "Mikko Virtanen", "kind": "PERSON"}]})
    assert seed["ok"] and len(seed["ids"]) == 1
    # the period: a hetu surrogate's check letter can be a prefix of a surrogate name (hold 1)
    m = await post(client, "/mask", {"session_id": "s", "text": "😀 Virtaselle 131052-913A."})
    assert {s["kind"] for s in m["spans"]} == {"PERSON", "HETU"} and m["spans"][0]["start"] == 3
    assert set(m["spans"][0]) == {"start", "end", "entity_id", "kind", "surrogate", "real_form", "detector",
                                  "score", "pending"}
    u = await post(client, "/unmask", {"text": m["masked"]})
    assert u["restored"] == "😀 Virtaselle 131052-913A." and u["hold"] == 0 and u["unresolved"] == []
    j = await post(client, "/mask", {"session_id": "s", "json": {"a": ["Virtaselle"]}})
    assert (await post(client, "/unmask", {"json": j["masked"]}))["restored"] == {"a": ["Virtaselle"]}
    sc = await post(client, "/scan", {"session_id": "s", "messages": [
        {"role": "user", "content": m["masked"]}, {"role": "assistant", "content": "Mikko Virtanen kiittää."}]})
    assert sc["messages"][0]["content"] == m["masked"]  # surrogates are not leaks
    assert [(x["message_index"], x["kind"]) for x in sc["leaked"]] == [(1, "PERSON")]
    assert "Virtanen" not in sc["messages"][1]["content"]


async def test_vault_routes(client):
    ids = (await post(client, "/vault/seed", {"entities": [
        {"canonical": "Mikko Virtanen", "kind": "PERSON"}, {"canonical": "Mikko Korhonen", "kind": "PERSON"}]}))["ids"]
    await post(client, "/mask", {"session_id": "s", "text": "Mikko Virtanen tuli."})
    await post(client, "/mask", {"session_id": "s", "text": "Sirpa soitti."})  # sentence-initial: pending
    lst = (await client.get("/vault/entities", params=U)).json()
    ent = next(e for e in lst["entities"] if e["id"] == ids[0])
    assert ent["seen_count"] == 1 and ent["last_seen"].endswith("Z") and ent["mode"] == "realistic"
    assert lst["pending"][0]["text"] == "Sirpa" and lst["pending"][0]["session_id"] == "s"

    upd = await post(client, f"/vault/entity/{ids[0]}", {"pinned": True, "mode": "placeholder"})
    assert upd["entity"]["pinned"] and upd["entity"]["surrogate"].startswith("[henkilö ")
    assert (await client.post(f"/vault/entity/{ids[0]}", json={**U, "regenerate": True})).status_code == 409
    await post(client, f"/vault/entity/{ids[0]}", {"pinned": False})
    regen = await post(client, f"/vault/entity/{ids[0]}", {"regenerate": True})
    assert regen["entity"]["mode"] == "realistic"
    await post(client, f"/vault/entity/{ids[0]}", {"allowlisted": True})
    assert (await post(client, "/mask", {"session_id": "s", "text": "Mikko Virtanen."}))["spans"] == []

    split = await post(client, "/vault/split", {"entity_id": ids[1], "span_ids": []})
    assert split["new_entity_id"] not in ids
    assert (await post(client, "/vault/merge", {"from_ids": [split["new_entity_id"]], "into_id": ids[1]}))["ok"]
    await post(client, f"/vault/entity/{ids[1]}", {"never_detect": True})
    lst = (await client.get("/vault/entities", params=U)).json()
    assert ids[1] not in [e["id"] for e in lst["entities"]]

    pid = lst["pending"][0]["id"]
    assert (await post(client, f"/vault/pending/{pid}", {"action": "dismiss"}))["ok"]
    assert (await client.get("/vault/entities", params=U)).json()["pending"] == []
    assert (await client.post("/vault/pending/999", json={**U, "action": "confirm"})).status_code == 404
    assert (await client.post("/vault/entity/999", json=U)).status_code == 404
    assert (await client.post(f"/vault/entity/{ids[0]}", json={"user_id": "other"})).status_code == 404


async def test_limits_and_errors(client, monkeypatch):
    r = await client.post("/mask", json={**U, "session_id": "s", "text": "x" * 200_001})
    assert r.status_code == 422 and "xxxx" not in r.text  # the input is never echoed
    deep: list = []
    for _ in range(40):
        deep = [deep]
    assert (await client.post("/mask", json={**U, "session_id": "s", "json": deep})).status_code == 413
    wide = {"a": [1] * 20_001}
    assert (await client.post("/mask", json={**U, "session_id": "s", "json": wide})).status_code == 413
    bad = await client.post("/vault/seed", json={**U, "entities": [
        {"canonical": "131052-913a", "kind": "HETU"}, {"canonical": "131052-913X", "kind": "HETU"}]})
    assert bad.status_code == 422 and bad.json()["detail"] == [{"index": 1, "msg": "not a valid HETU"}]
    assert "308X" not in bad.text
    ok = await post(client, "/vault/seed", {"entities": [{"canonical": "040 123 4567", "kind": "PHONE"}]})
    assert main.state["vault"].entity("u1", ok["ids"][0])["canonical"] == "+358401234567"
    sid = (await post(client, "/vault/seed", {"entities": [{"canonical": "Mikko Virtanen", "kind": "PERSON"}]}))["ids"]
    self_id = next(e["id"] for e in (await client.get("/vault/entities", params=U)).json()["entities"]
                   if e["kind"] == "SELF")
    assert (await client.post("/vault/merge", json={**U, "from_ids": [self_id], "into_id": sid[0]})).status_code == 422
    assert (await client.post("/vault/merge", json={**U, "from_ids": ok["ids"], "into_id": sid[0]})).status_code == 422

    monkeypatch.setitem(main.state, "missing", ["ner"])
    h = await client.get("/healthz")
    assert h.status_code == 503 and h.json()["missing"] == ["ner"]


async def test_scan_leak_path(client):
    await post(client, "/vault/seed", {"entities": [{"canonical": "Mikko Virtanen", "kind": "PERSON"}]})
    sc = await post(client, "/scan", {"session_id": "s", "messages": [
        {"role": "tool", "content": [{"type": "text", "text": "Mikko Virtanen"}]}]})
    assert sc["leaked"][0]["path"] == [0, "text"]


async def test_collision_round_trip(client):
    (eid,) = (await post(client, "/vault/seed", {"entities": [{"canonical": "Mikko Virtanen", "kind": "PERSON"}]}))["ids"]
    lst = (await client.get("/vault/entities", params=U)).json()
    surrogate = next(e["surrogate"] for e in lst["entities"] if e["id"] == eid)
    await post(client, "/mask", {"session_id": "s", "text": "Mikko Virtanen tuli."})
    echo = await post(client, "/mask", {"session_id": "s", "text": f"Hei {surrogate}!"})
    assert echo == {"masked": f"Hei {surrogate}!", "spans": []}  # model text: an echo, no collision check
    m = await post(client, "/mask", {"session_id": "s", "text": f"Hei {surrogate}!", "user_input": True})
    assert m["masked"] == "" and m["spans"] == []
    (c,) = m["collisions"]
    assert set(c) == {"pending_id", "entity_id", "kind"} and c["kind"] == "PERSON"
    pending = (await client.get("/vault/entities", params=U)).json()["pending"]
    row = next(p for p in pending if p["id"] == c["pending_id"])
    assert row["reason"] == "collision" and row["entity_id"] == c["entity_id"]
    bad = await client.post(f"/vault/pending/{c['pending_id']}", json={**U, "action": "confirm"})
    assert bad.status_code == 422
    assert (await post(client, f"/vault/pending/{c['pending_id']}", {"action": "accept"}))["ok"]
    twice = await client.post(f"/vault/pending/{c['pending_id']}", json={**U, "action": "accept"})
    assert twice.status_code == 409  # a double tap does not regenerate the entity again
    again = await post(client, "/mask", {"session_id": "s", "text": f"Hei {surrogate}!", "user_input": True})
    assert again["collisions"] == [] and surrogate not in again["masked"]


def _now() -> str:
    from datetime import UTC, datetime
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


async def test_session_fork_keeps_copied_surrogates(client):
    """Phase-13 decision 3: a fork keeps the surrogates its source knew up to the fork point."""
    await post(client, "/vault/seed", {"entities": [
        {"canonical": "Mikko Virtanen", "kind": "PERSON"}, {"canonical": "Liisa Korhonen", "kind": "PERSON"}]})
    first = (await post(client, "/mask", {"session_id": "src", "text": "Mikko Virtanen tuli."}))["masked"]
    until = _now()
    import asyncio
    await asyncio.sleep(0.01)
    later = (await post(client, "/mask", {"session_id": "src", "text": "Liisa Korhonen lähti."}))["masked"]
    before = (await client.get("/vault/entities", params=U)).json()["entities"]

    async def tool_result(session, text):  # pi-ext-pseudo's tool_result path: /mask with all layers
        return (await post(client, "/mask", {"session_id": session, "json": {"content": [text]}}))["masked"]["content"][0]

    async def scan(session, text):
        sc = await post(client, "/scan", {"session_id": session, "messages": [{"role": "assistant", "content": text}]})
        return sc["messages"][0]["content"]

    r = await post(client, "/session/fork", {"from_session_id": "src", "to_session_id": "fork", "until": until})
    assert r == {"ok": True, "entities": 1}
    assert await tool_result("fork", first) == first
    assert await scan("fork", first) == first
    # The vault list leaves the copied rows out of the seen count and the last-seen time.
    after = (await client.get("/vault/entities", params=U)).json()["entities"]
    pick = lambda es: [(e["id"], e["seen_count"], e["last_seen"]) for e in es]
    assert pick(after) == pick(before)
    # A span after `until` is not copied.
    assert await tool_result("fork", later) != later
    # Without the copy, a session masks the copied surrogate again: it becomes a "real" person, and from then
    # on /scan masks it in every other session too.
    assert await tool_result("plain", first) != first
    assert await scan("other", first) != first


async def test_session_fork_validates(client):
    body = {"from_session_id": "a", "to_session_id": "a", "until": _now()}
    assert (await client.post("/session/fork", json={**U, **body})).status_code == 422
    assert (await client.post("/session/fork", json={**U, **body, "to_session_id": "b", "until": "26.10.2026"})).status_code == 422


async def test_session_fork_compares_instants(client, vault):
    """`until` in the same millisecond as a span copies it, also when written with another zone form;
    a naive time is refused. The drop removes only the copied rows."""
    await post(client, "/vault/seed", {"entities": [{"canonical": "Mikko Virtanen", "kind": "PERSON"}]})
    await post(client, "/mask", {"session_id": "src", "text": "Mikko Virtanen tuli."})
    (created,) = vault.q("SELECT created_at FROM span WHERE session_id='src' ORDER BY id LIMIT 1")[0]
    assert created.endswith("Z")
    same = await post(client, "/session/fork", {"from_session_id": "src", "to_session_id": "f1", "until": created})
    assert same["entities"] == 1
    offset = created.replace("Z", "+00:00")
    assert (await post(client, "/session/fork", {"from_session_id": "src", "to_session_id": "f2",
                                                  "until": offset}))["entities"] == 1
    from datetime import datetime, timedelta
    earlier = (datetime.fromisoformat(created) - timedelta(milliseconds=1)).isoformat()
    assert (await post(client, "/session/fork", {"from_session_id": "src", "to_session_id": "f3",
                                                  "until": earlier}))["entities"] == 0
    naive = {**U, "from_session_id": "src", "to_session_id": "f4", "until": created.rstrip("Z")}
    assert (await client.post("/session/fork", json=naive)).status_code == 422
    # A fork of the fork: the copied row keeps the first-seen time, so it copies on.
    assert (await post(client, "/session/fork", {"from_session_id": "f1", "to_session_id": "f5",
                                                  "until": created}))["entities"] == 1
    assert (await post(client, "/session/fork/drop", {"session_id": "f1"}))["entities"] == 1
    assert (await post(client, "/session/fork/drop", {"session_id": "src"}))["entities"] == 0
    assert vault.q("SELECT count(*) FROM span WHERE session_id='src'")[0][0] == 1


async def test_dismissed_lower_case_hit_keeps_the_surname(client):
    # phase-34 decision 7: "Hylkää" on hämäläistä hides lower-case forms only; Hämäläinen still masks
    from app.detect import gazetteer
    from app import forms

    if gazetteer._voikko() is None and forms.omorfi() is None:
        pytest.skip("needs Voikko or Omorfi")
    m = await post(client, "/mask", {"session_id": "s", "text": "en oo nähny hämäläistä koko viikkona"})
    assert [s["pending"] for s in m["spans"]] == [True] and "hämäläistä" not in m["masked"]
    (row,) = (await client.get("/vault/entities", params=U)).json()["pending"]
    assert (await post(client, f"/vault/pending/{row['id']}", {"action": "dismiss"}))["ok"]
    m = await post(client, "/mask", {"session_id": "s2", "text": "en oo nähny hämäläistä koko viikkona"})
    assert m["spans"] == [] and (await client.get("/vault/entities", params=U)).json()["pending"] == []
    m = await post(client, "/mask", {"session_id": "s3", "text": "Soitin eilen Hämäläiselle."})
    assert [s["real_form"] for s in m["spans"]] == ["Hämäläiselle"] and "Hämäläiselle" not in m["masked"]
