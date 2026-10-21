from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from pydantic import Field, field_validator

from .models import StrictModel, digest


class ModelConfig(StrictModel):
    base_url: str
    model: str = Field(min_length=1)
    api_key_env: str = Field(pattern=r"^[A-Z][A-Z0-9_]*$")

    @field_validator("base_url")
    @classmethod
    def endpoint(cls, value: str) -> str:
        parsed = urlsplit(value)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("invalid model endpoint")
        return value.rstrip("/")

    def secret(self) -> str:
        value = os.environ.get(self.api_key_env)
        if not value:
            raise ValueError(f"missing credential environment variable: {self.api_key_env}")
        return value


class EmbeddingConfig(ModelConfig):
    dimensions: int = Field(ge=1, le=8192)


class ServiceConfig(StrictModel):
    data_dir: str = "/data"
    token_env: str = "MEMORY_SERVICE_TOKEN"
    neo4j_uri: str = "bolt://neo4j:7687"
    neo4j_user: str = "neo4j"
    neo4j_password_env: str = "NEO4J_PASSWORD"
    extraction: ModelConfig
    embedding: EmbeddingConfig
    vision: ModelConfig | None = None
    vision_profile: dict[str, Any] | None = None
    media: dict[str, Any] = Field(default_factory=dict)
    queue_limit: int = Field(default=32, ge=1, le=128)
    request_timeout_seconds: int = Field(default=120, ge=1, le=600)

    def fingerprint(self) -> str:
        return digest({"extraction": self.extraction.model_dump(), "embedding": self.embedding.model_dump()})

    def token(self) -> str:
        value = os.environ.get(self.token_env, "")
        if len(value) < 24:
            raise ValueError("service token must contain at least 24 characters")
        return value


def load_config() -> ServiceConfig:
    path = Path(os.environ.get("MEMORY_CONFIG_FILE", "/config/memory.json"))
    return ServiceConfig.model_validate(json.loads(path.read_text()))
