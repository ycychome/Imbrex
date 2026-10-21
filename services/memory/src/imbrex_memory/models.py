from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

Text = Annotated[str, StringConstraints(min_length=1, max_length=1024)]
Identifier = Annotated[str, StringConstraints(min_length=1, max_length=256)]
Category = Literal[
    "profile",
    "preference",
    "style",
    "relationship",
    "meme",
    "episode",
    "fact",
    "knowledge",
    "commitment",
    "procedure",
]


def canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(value: Any) -> str:
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def now() -> str:
    return datetime.now(UTC).isoformat()


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class EventRef(StrictModel):
    source: Text
    id: Identifier


class Envelope(StrictModel):
    store_id: Identifier
    instance_id: Identifier
    caller_id: Identifier
    scopes: list[Text] = Field(min_length=1, max_length=8)


class OperationRequest(Envelope):
    request_id: Annotated[str, StringConstraints(pattern=r"^[a-f0-9]{64}$")]
    kind: Literal["ingest", "images", "remember", "update", "forget", "rebuild"]
    payload: dict[str, Any]


class QueryRequest(Envelope):
    kind: Literal["search", "context", "get", "status", "operation"]
    params: dict[str, Any]


class Candidate(StrictModel):
    category: Category
    content: Annotated[str, StringConstraints(min_length=1, max_length=4096)]
    subjects: list[Identifier] = Field(default_factory=list, max_length=32)
    evidence_refs: list[EventRef] = Field(min_length=1, max_length=32)
    origin: Literal["quotation", "reported", "inference", "vision", "agent_authored"]
    occurred_at: str | None = None

    @field_validator("occurred_at")
    @classmethod
    def timestamp(cls, value: str | None) -> str | None:
        if value is None:
            return None
        parsed = datetime.fromisoformat(value)
        if parsed.tzinfo is None:
            raise ValueError("occurred_at requires a timezone")
        return parsed.astimezone(UTC).isoformat()


class Extraction(StrictModel):
    memories: list[Candidate] = Field(default_factory=list, max_length=64)


class MemoryError(Exception):
    def __init__(self, code: str, status: int = 409):
        super().__init__(code)
        self.code = code
        self.status = status
