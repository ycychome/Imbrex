from __future__ import annotations

import asyncio
import json
from collections import deque
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import pytest
from graphiti_core.prompts.models import Message
from pydantic import ValidationError

from imbrex_memory import config as config_module
from imbrex_memory.config import EmbeddingConfig, ExtractionModelConfig, ServiceConfig
from imbrex_memory.engine import Engine
from imbrex_memory.graph import GraphitiIndex, ModelExtractor
from imbrex_memory.models import Extraction, MemoryError, OperationRequest
from imbrex_memory.store import Store


class CompletionServer:
    def __init__(self, *, reject_json_schema: bool = False, contents: list[str] | None = None) -> None:
        self.server: asyncio.AbstractServer | None = None
        self.requests: list[dict[str, Any]] = []
        self.replies = deque(contents or ['{"memories": []}'])
        self.reject_json_schema = reject_json_schema
        self.port = 0

    async def start(self) -> None:
        self.server = await asyncio.start_server(self._handle, "127.0.0.1", 0)
        self.port = int(self.server.sockets[0].getsockname()[1])

    async def close(self) -> None:
        if self.server is not None:
            self.server.close()
            await self.server.wait_closed()

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            header = await reader.readuntil(b"\r\n\r\n")
            headers = header.decode("latin1").split("\r\n")
            length = next(int(line.split(":", 1)[1]) for line in headers if line.lower().startswith("content-length:"))
            request = json.loads(await reader.readexactly(length))
            self.requests.append(request)
            unsupported = self.reject_json_schema and request.get("response_format", {}).get("type") == "json_schema"
            if unsupported:
                status, payload = 400, {"error": {"message": "json_schema is not supported"}}
            else:
                content = self.replies.popleft() if self.replies else '{"memories": []}'
                status = 200
                payload = {
                    "id": "chatcmpl-fixture",
                    "object": "chat.completion",
                    "created": 1,
                    "model": request.get("model", "fixture"),
                    "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}],
                }
            body = json.dumps(payload, separators=(",", ":")).encode()
            phrase = "OK" if status == 200 else "Bad Request"
            writer.write(
                f"HTTP/1.1 {status} {phrase}\r\nContent-Type: application/json\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode()
                + body
            )
            await writer.drain()
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        finally:
            writer.close()
            await writer.wait_closed()


@pytest.fixture
async def completion_server() -> AsyncIterator[CompletionServer]:
    server = CompletionServer()
    await server.start()
    try:
        yield server
    finally:
        await server.close()


@pytest.fixture(autouse=True)
def model_credentials(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MEMORY_TEST_MODEL_KEY", "synthetic-model-key")
    monkeypatch.setenv("MEMORY_TEST_NEO4J_PASSWORD", "synthetic-neo4j-password")


def service_config(
    base_url: str,
    *,
    mode: str = "json_schema",
    max_output_tokens: int = 2048,
    reasoning_effort: str | None = None,
) -> ServiceConfig:
    return ServiceConfig(
        neo4j_password_env="MEMORY_TEST_NEO4J_PASSWORD",
        extraction=ExtractionModelConfig(
            base_url=base_url,
            model="fixture-chat",
            api_key_env="MEMORY_TEST_MODEL_KEY",
            structured_output_mode=mode,  # type: ignore[arg-type]
            max_output_tokens=max_output_tokens,
            reasoning_effort=reasoning_effort,  # type: ignore[arg-type]
        ),
        embedding=EmbeddingConfig(
            base_url=base_url,
            model="fixture-embedding",
            api_key_env="MEMORY_TEST_MODEL_KEY",
            dimensions=8,
        ),
    )


@pytest.mark.asyncio
async def test_model_extractor_json_object_avoids_unsupported_schema_and_validates_locally(
    completion_server: CompletionServer,
) -> None:
    completion_server.reject_json_schema = True
    config = service_config(f"http://127.0.0.1:{completion_server.port}/v1", mode="json_object", reasoning_effort="none")
    extractor = ModelExtractor(config)
    record = {
        "source": "source-fixture",
        "id": "message:1",
        "text": "合成输入",
        "sender_id": "10001",
        "person_id": "qq:123456:real-test:10001",
        "sender_nickname": "昵称甲",
        "sender_card": "群名片甲",
        "mentioned_person_ids": ["qq:123456:real-test:20002"],
    }
    try:
        result = await extractor.extract([record])
    finally:
        await extractor.close()

    assert result == Extraction(memories=[])
    request = completion_server.requests[0]
    assert request["response_format"] == {"type": "json_object"}
    assert request["max_tokens"] == 2048
    assert request["reasoning_effort"] == "none"
    assert "Pydantic schema" in request["messages"][0]["content"]
    assert '"memories"' in request["messages"][0]["content"]
    assert 'Allowed subject IDs (exact JSON list): ["qq:123456:real-test:10001","qq:123456:real-test:20002"]' in request[
        "messages"
    ][0]["content"]
    assert "do not discard a supported memory merely because it is phrased as an imperative" in request["messages"][0]["content"]
    assert "A single observation can support a concrete fact, arrangement or commitment, place, or rule" in request["messages"][0]["content"]
    supplied_record = json.loads(request["messages"][1]["content"])[0]
    assert "sender_id" not in supplied_record
    assert supplied_record["person_id"] == record["person_id"]
    assert supplied_record["sender_nickname"] == record["sender_nickname"]
    assert supplied_record["sender_card"] == record["sender_card"]
    assert supplied_record["mentioned_person_ids"] == record["mentioned_person_ids"]


@pytest.mark.asyncio
async def test_json_object_output_still_uses_strict_local_validation(completion_server: CompletionServer) -> None:
    completion_server.replies = deque(['{"memories": [{"category": "unknown"}]}', "not-json"])
    config = service_config(f"http://127.0.0.1:{completion_server.port}/v1", mode="json_object")
    extractor = ModelExtractor(config)
    try:
        with pytest.raises(ValidationError):
            await extractor.extract([{"source": "source-fixture", "id": "message:1", "text": "合成输入"}])
        with pytest.raises(ValidationError):
            await extractor.extract([{"source": "source-fixture", "id": "message:2", "text": "合成输入"}])
    finally:
        await extractor.close()


@pytest.mark.asyncio
async def test_model_bare_numeric_subject_is_still_rejected_by_engine(
    completion_server: CompletionServer, tmp_path: Path
) -> None:
    source = "imbrex://qq/123456/real-test/group/987654"
    event_id = "message:1"
    completion_server.replies = deque(
        [
            json.dumps(
                {
                    "memories": [
                        {
                            "category": "preference",
                            "content": "小林喜欢乌龙茶。",
                            "subjects": ["10001"],
                            "evidence_refs": [{"source": source, "id": event_id}],
                            "origin": "reported",
                            "occurred_at": None,
                        }
                    ]
                }
            )
        ]
    )
    config = service_config(f"http://127.0.0.1:{completion_server.port}/v1")
    store = Store(tmp_path / "memory.sqlite3")

    class CountingGraph:
        def __init__(self) -> None:
            self.add_count = 0

        async def add(self, _group: str, _memory: dict[str, Any]) -> str:
            self.add_count += 1
            return "unexpected-episode"

    graph = CountingGraph()
    extractor = ModelExtractor(config)
    engine = Engine(config, store, graph, extractor)
    operation = OperationRequest(
        request_id="f" * 64,
        store_id="fixture-store",
        instance_id="memory",
        caller_id="fixture-reader",
        scopes=[source],
        kind="ingest",
        payload={
            "records": [
                {
                    "source": source,
                    "id": event_id,
                    "seq": "1",
                    "accepted_at": "2026-01-01T00:00:00+00:00",
                    "account_id": "123456",
                    "identity_namespace": "real-test",
                    "conversation_type": "group",
                    "conversation_id": "987654",
                    "sender_id": "10001",
                    "text": "合成输入",
                    "type": "qq.message.group",
                }
            ]
        },
    )
    try:
        with pytest.raises(MemoryError, match="invalid_extraction"):
            await engine.apply(operation)
        assert graph.add_count == 0
    finally:
        await extractor.close()
        store.close()


@pytest.mark.asyncio
async def test_default_mode_keeps_json_schema_and_does_not_send_reasoning(completion_server: CompletionServer) -> None:
    config = service_config(f"http://127.0.0.1:{completion_server.port}/v1", max_output_tokens=4096)
    extractor = ModelExtractor(config)
    try:
        await extractor.extract([{"source": "source-fixture", "id": "message:1", "text": "合成输入"}])
    finally:
        await extractor.close()

    request = completion_server.requests[0]
    assert request["response_format"]["type"] == "json_schema"
    assert request["max_tokens"] == 4096
    assert "reasoning_effort" not in request


@pytest.mark.asyncio
async def test_graphiti_uses_configured_output_mode_token_cap_and_reasoning(
    completion_server: CompletionServer, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = service_config(f"http://127.0.0.1:{completion_server.port}/v1", mode="json_object", reasoning_effort="none")

    class GraphStub:
        def __init__(self, *_args: Any, llm_client: Any, **_kwargs: Any) -> None:
            self.llm_client = llm_client

        async def close(self) -> None:
            return None

    monkeypatch.setattr("imbrex_memory.graph.Graphiti", GraphStub)
    index = GraphitiIndex(config)
    try:
        await index.graph.llm_client.generate_response(
            [Message(role="system", content="Extract facts.")],
            response_model=Extraction,
            max_tokens=8192,
        )
    finally:
        await index.close()

    request = completion_server.requests[0]
    assert request["response_format"] == {"type": "json_object"}
    assert request["max_tokens"] == 2048
    assert request["reasoning_effort"] == "none"
    assert '"memories"' in request["messages"][-1]["content"]


def test_extraction_defaults_and_fingerprint_include_text_generation_options(monkeypatch: pytest.MonkeyPatch) -> None:
    config = service_config("https://models.example.invalid/v1", max_output_tokens=4096)
    assert config.extraction.structured_output_mode == "json_schema"
    assert config.extraction.max_output_tokens == 4096
    assert config.extraction.reasoning_effort is None

    changed = config.model_copy(
        update={"extraction": config.extraction.model_copy(update={"max_output_tokens": 2048})}
    )
    assert changed.fingerprint() != config.fingerprint()

    fingerprint = config.fingerprint()
    monkeypatch.setattr(config_module, "EXTRACTION_CONTRACT_VERSION", config_module.EXTRACTION_CONTRACT_VERSION + 1)
    assert config.fingerprint() != fingerprint
