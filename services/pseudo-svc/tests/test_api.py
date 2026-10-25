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
    m = await post(client, "/mask", {"session_id": "s", "text": "😀 Virtaselle 131052-308T"})
    assert {s["kind"] for s in m["spans"]} == {"PERSON", "HETU"} and m["spans"][0]["start"] == 3
    assert set(m["spans"][0]) == {"start", "end", "entity_id", "kind", "surrogate", "real_form", "detector",
                                  "score", "pending"}
    u = await post(client, "/unmask", {"text": m["masked"]})
    assert u["restored"] == "😀 Virtaselle 131052-308T" and u["hold"] == 0 and u["unresolved"] == []
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
