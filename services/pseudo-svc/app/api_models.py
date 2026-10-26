"""Request and response bodies (docs/decisions/phase-3.md, sidecar API contract)."""

from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

UserId = Field(min_length=1, max_length=200)
MAX_TEXT = 200_000
MAX_ITEMS = 500


class TextOrJson(BaseModel):
    user_id: str = UserId
    text: str | None = Field(None, max_length=MAX_TEXT)
    json_: Any = Field(None, alias="json")

    @model_validator(mode="after")
    def one_of(self):
        if (self.text is None) == ("json_" not in self.model_fields_set):
            raise ValueError("send exactly one of text or json")
        return self


class MaskReq(TextOrJson):
    session_id: str = Field(min_length=1, max_length=200)
    # what the user typed: names equal to issued surrogates are parked as collisions (phase-12 decisions 5-7)
    user_input: bool = False


class MaskSpan(BaseModel):
    start: int
    end: int
    entity_id: int
    kind: str
    surrogate: str
    real_form: str
    detector: str
    score: float
    pending: bool
    path: list[str | int] | None = None


class Collision(BaseModel):
    pending_id: int
    entity_id: int
    kind: str


class MaskRes(BaseModel):
    masked: Any
    spans: list[MaskSpan]
    collisions: list[Collision] | None = None


class UnmaskSpan(BaseModel):
    start: int
    end: int
    entity_id: int
    surrogate_form: str
    path: list[str | int] | None = None


class Unresolved(BaseModel):
    start: int
    end: int
    form: str
    path: list[str | int] | None = None


class UnmaskRes(BaseModel):
    restored: Any
    spans: list[UnmaskSpan]
    unresolved: list[Unresolved]
    hold: int


class Message(BaseModel, extra="allow"):
    role: str
    content: Any


class ScanReq(BaseModel):
    user_id: str = UserId
    session_id: str = Field(min_length=1, max_length=200)
    messages: list[Message] = Field(max_length=MAX_ITEMS)


class Leak(BaseModel):
    message_index: int
    start: int
    end: int
    kind: str
    entity_id: int
    path: list[str | int] | None = None


class ScanRes(BaseModel):
    messages: list[dict]
    leaked: list[Leak]


class Entity(BaseModel):
    id: int
    kind: str
    canonical: str
    surrogate: str
    mode: str
    pinned: bool
    allowlisted: bool
    seen_count: int = 0
    last_seen: str | None = None


class Pending(BaseModel):
    id: int
    kind: str
    text: str
    detector: str
    score: float
    session_id: str | None
    reason: Literal["uncertain", "collision"] = "uncertain"
    entity_id: int | None = None  # collision: the entity whose surrogate the text equals


class EntitiesRes(BaseModel):
    entities: list[Entity]
    pending: list[Pending]


class MergeReq(BaseModel):
    user_id: str = UserId
    from_ids: list[int] = Field(min_length=1, max_length=MAX_ITEMS)
    into_id: int


class SplitReq(BaseModel):
    user_id: str = UserId
    entity_id: int
    span_ids: list[int] = Field([], max_length=MAX_ITEMS)


class UpdateReq(BaseModel):
    user_id: str = UserId
    pinned: bool | None = None
    allowlisted: bool | None = None
    mode: Literal["realistic", "placeholder"] | None = None
    regenerate: bool | None = None
    never_detect: bool | None = None


class SeedEntity(BaseModel):
    canonical: str = Field(min_length=1, max_length=500)
    kind: Literal["PERSON", "HETU", "IBAN", "PHONE", "EMAIL", "ADDRESS", "POSTCODE_CITY", "PLATE"]


class SeedReq(BaseModel):
    user_id: str = UserId
    entities: list[SeedEntity] = Field(max_length=MAX_ITEMS)


class PendingReq(BaseModel):
    user_id: str = UserId
    # confirm, dismiss, allowlist: an uncertain detection; accept (a new person), reject (that entity): a collision;
    # expire: pa-server closes a collision whose held message was dropped
    action: Literal["confirm", "dismiss", "allowlist", "accept", "reject", "expire"]


class Ok(BaseModel):
    ok: bool = True
    new_entity_id: int | None = None
    ids: list[int] | None = None
