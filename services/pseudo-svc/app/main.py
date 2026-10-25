"""pseudo-svc HTTP API. Logs carry kinds, ids, counts and timings, never real values."""

import logging
import os
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from . import api_models as m
from . import forms, mask as pipeline
from . import surrogate as S
from .detect import codes, gazetteer, ner
from .detect.codes import normalise
from .vault import Vault

log = logging.getLogger("pseudo")
logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
state: dict = {}


def vault() -> Vault:
    return state["vault"]


@asynccontextmanager
async def lifespan(app: FastAPI):
    t = time.perf_counter()
    state["vault"] = Vault(os.environ.get("VAULT_PATH", "/data/vault.db"), os.environ.get("PSEUDO_VAULT_KEY", ""))
    gazetteer.names(), gazetteer._index(), codes.municipalities(), S.pools(), S.nicknames()
    layers = {"omorfi": forms.omorfi() is not None, "voikko": gazetteer._voikko() is not None,
              "ner": ner.engine() is not None}
    state["layers"] = layers
    required = [x.strip() for x in os.environ.get("PSEUDO_REQUIRE_LAYERS", "").split(",") if x.strip()]
    state["missing"] = [x for x in required if not layers.get(x)]
    if state["missing"]:
        log.error("required layers missing: %s", state["missing"])
    log.info("startup layers=%s ms=%d", layers, (time.perf_counter() - t) * 1000)
    yield


app = FastAPI(title="pseudo-svc", lifespan=lifespan)


@app.exception_handler(RequestValidationError)
async def invalid(request: Request, exc: RequestValidationError):
    """Only where and why: the default handler echoes the input, which holds real values."""
    return JSONResponse({"detail": [{"loc": e.get("loc"), "msg": e.get("msg")} for e in exc.errors()]}, 422)


@app.exception_handler(pipeline.TooLarge)
async def too_large(request: Request, exc: pipeline.TooLarge):
    return JSONResponse({"detail": str(exc)}, 413)


def timed(name: str, t: float, **counts) -> None:
    log.info("%s ms=%.1f %s", name, (time.perf_counter() - t) * 1000, " ".join(f"{k}={v}" for k, v in counts.items()))


@app.get("/healthz")
def healthz():
    if state.get("missing"):
        return JSONResponse({"ok": False, "missing": state["missing"]}, 503)
    return {"ok": True, "layers": state.get("layers", {})}


@app.post("/mask", response_model=m.MaskRes, response_model_exclude_none=True)
def mask(req: m.MaskReq):
    t = time.perf_counter()
    masked, spans = pipeline.mask(vault(), req.user_id, req.session_id, req.text, req.json_)
    timed("mask", t, spans=len(spans))
    return {"masked": masked, "spans": spans}


@app.post("/unmask", response_model=m.UnmaskRes, response_model_exclude_none=True)
def unmask(req: m.TextOrJson):
    t = time.perf_counter()
    restored, spans, unresolved, hold = pipeline.unmask(vault(), req.user_id, req.text, req.json_)
    timed("unmask", t, spans=len(spans), unresolved=len(unresolved))
    return {"restored": restored, "spans": spans, "unresolved": unresolved, "hold": hold}


@app.post("/scan", response_model=m.ScanRes)
def scan(req: m.ScanReq):
    t = time.perf_counter()
    msgs, leaked = pipeline.scan(vault(), req.user_id, req.session_id, [x.model_dump() for x in req.messages])
    timed("scan", t, messages=len(msgs), leaked=len(leaked))
    return {"messages": msgs, "leaked": leaked}


def _entity(row) -> dict:
    keys = row.keys()
    return dict(id=row["id"], kind=row["kind"], canonical=row["canonical"], surrogate=row["surrogate"],
                mode=row["surrogate_mode"], pinned=bool(row["pinned"]), allowlisted=bool(row["allowlisted"]),
                seen_count=row["seen_count"] if "seen_count" in keys else 0,
                last_seen=row["last_seen"] if "last_seen" in keys else None)


@app.get("/vault/entities", response_model=m.EntitiesRes)
def entities(user_id: str = Query(min_length=1, max_length=200)):
    S.ensure_self(vault(), user_id)
    return {"entities": [_entity(r) for r in vault().list_entities(user_id)],
            "pending": [dict(r) for r in vault().pending_list(user_id)]}


@app.post("/vault/merge", response_model=m.Ok, response_model_exclude_none=True)
def merge(req: m.MergeReq):
    try:
        vault().merge(req.user_id, req.from_ids, req.into_id)
    except KeyError:
        raise HTTPException(404, "entity not found")
    except ValueError as e:
        raise HTTPException(422, str(e))
    log.info("merge from=%s into=%d", req.from_ids, req.into_id)
    return {"ok": True}


@app.post("/vault/split", response_model=m.Ok, response_model_exclude_none=True)
def split(req: m.SplitReq):
    try:
        new_id = S.split(vault(), req.user_id, req.entity_id, req.span_ids)
    except KeyError:
        raise HTTPException(404, "entity not found")
    return {"ok": True, "new_entity_id": new_id}


@app.post("/vault/entity/{entity_id}")
def update(entity_id: int, req: m.UpdateReq):
    v = vault()
    e = v.entity(req.user_id, entity_id)
    if not e:
        raise HTTPException(404, "entity not found")
    if req.regenerate and e["pinned"]:
        raise HTTPException(409, "entity is pinned")
    if e["kind"] == "SELF" and (req.regenerate or req.mode or req.never_detect):
        raise HTTPException(422, "the self entity keeps its label")
    fields = {k: int(getattr(req, k)) for k in ("pinned", "allowlisted") if getattr(req, k) is not None}
    v.set_fields(req.user_id, entity_id, **fields)
    if req.never_detect:
        v.add_never_detect(req.user_id, e["kind"], e["canonical"])
    if req.regenerate or req.mode == "realistic" and e["surrogate_mode"] == "placeholder":
        S.regenerate(v, req.user_id, v.entity(req.user_id, entity_id))
    elif req.mode == "placeholder" and e["surrogate_mode"] != "placeholder":
        S.set_placeholder(v, req.user_id, v.entity(req.user_id, entity_id))
    return {"entity": _entity(v.entity(req.user_id, entity_id))}


@app.post("/vault/seed", response_model=m.Ok, response_model_exclude_none=True)
def seed(req: m.SeedReq):
    canon = [normalise(e.kind, e.canonical) for e in req.entities]
    errors = [{"index": i, "msg": f"not a valid {e.kind}"} for i, (e, c) in enumerate(zip(req.entities, canon)) if not c]
    if errors:
        raise HTTPException(422, errors)
    ids = [S.get_or_create_entity(vault(), req.user_id, e.kind, c)["id"] for e, c in zip(req.entities, canon)]
    log.info("seed count=%d", len(ids))
    return {"ok": True, "ids": ids}


@app.post("/vault/pending/{pending_id}", response_model=m.Ok, response_model_exclude_none=True)
def pending(pending_id: int, req: m.PendingReq):
    v = vault()
    p = v.pending_get(req.user_id, pending_id)
    if not p:
        raise HTTPException(404, "pending not found")
    e = v.entity(req.user_id, p["entity_id"]) if p["entity_id"] else None
    if req.action == "allowlist" and e:
        v.set_fields(req.user_id, e["id"], allowlisted=1)
    if req.action == "confirm" and e:
        v.set_fields(req.user_id, e["id"], confirmed=1)  # later low-score mentions are not queued again
    if req.action == "dismiss" and e:
        v.add_never_detect(req.user_id, e["kind"], e["canonical"])
    v.pending_set(req.user_id, pending_id, {"confirm": "confirmed", "dismiss": "dismissed", "allowlist": "allowlisted"}[req.action])
    return {"ok": True}
