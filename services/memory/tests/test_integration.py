"""Opt-in integration coverage against the disposable real Neo4j test container.

Run with MEMORY_INTEGRATION=1. All LLM traffic is served by the local deterministic
OpenAI-compatible fixture; these tests verify graph/index wiring, not model quality.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import uuid
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import pytest
from neo4j import AsyncGraphDatabase

from imbrex_memory.config import EmbeddingConfig, ModelConfig, ServiceConfig
from imbrex_memory.engine import Engine
from imbrex_memory.graph import GraphitiIndex, ModelExtractor
from imbrex_memory.models import OperationRequest, QueryRequest, digest, now
from imbrex_memory.store import Store

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(os.getenv("MEMORY_INTEGRATION") != "1", reason="requires opt-in disposable Neo4j"),
]


class OpenAIStub:
    """Tiny local HTTP server implementing the two OpenAI endpoints Graphiti uses."""

    def __init__(self) -> None:
        self.server: asyncio.AbstractServer | None = None
        self.requests: list[dict[str, Any]] = []
        self.port = 0

    async def start(self) -> None:
        self.server = await asyncio.start_server(self._handle, "127.0.0.1", 0)
        sock = self.server.sockets[0]
        self.port = int(sock.getsockname()[1])

    async def close(self) -> None:
        if self.server:
            self.server.close()
            await self.server.wait_closed()

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            head = await reader.readuntil(b"\r\n\r\n")
            headers = head.decode("latin1").split("\r\n")
            length = next((int(line.split(":", 1)[1]) for line in headers if line.lower().startswith("content-length:")), 0)
            request = json.loads(await reader.readexactly(length))
            path = headers[0].split(" ")[1]
            self.requests.append(request)
            if path.endswith("/embeddings"):
                response = self._embeddings(request)
            elif path.endswith("/chat/completions"):
                response = self._completion(request)
            else:
                response = {"error": {"message": "unsupported test route"}}
                await self._write(writer, 404, response)
                return
            await self._write(writer, 200, response)
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        finally:
            writer.close()
            await writer.wait_closed()

    async def _write(self, writer: asyncio.StreamWriter, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode()
        writer.write(
            f"HTTP/1.1 {status} {'OK' if status == 200 else 'Not Found'}\r\nContent-Type: application/json\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode()
            + body
        )
        await writer.drain()

    @staticmethod
    def _embeddings(request: dict[str, Any]) -> dict[str, Any]:
        items = request["input"]
        if isinstance(items, str):
            items = [items]
        vectors = []
        for index, item in enumerate(items):
            raw = hashlib.sha256(str(item).encode()).digest()
            # Deterministic distinct, fixed-size vectors for integration search.
            vector = [((raw[i % len(raw)] / 255.0) * 2.0) - 1.0 for i in range(8)]
            vectors.append({"object": "embedding", "index": index, "embedding": vector})
        return {"object": "list", "data": vectors, "model": request.get("model", "fixture-embedding")}

    def _completion(self, request: dict[str, Any]) -> dict[str, Any]:
        rf = request.get("response_format", {})
        schema = rf.get("json_schema", {}).get("schema", {})
        title = schema.get("title") or rf.get("json_schema", {}).get("name", "")
        # Dispatch by the schema title supplied by the actual Graphiti integration.
        content = self._schema_response(title, request)
        return {
            "id": f"chatcmpl-{uuid.uuid4().hex}",
            "object": "chat.completion",
            "created": 1,
            "model": request.get("model", "fixture-extractor"),
            "choices": [{"index": 0, "message": {"role": "assistant", "content": json.dumps(content)}, "finish_reason": "stop"}],
        }

    @staticmethod
    def _schema_response(title: str, request: dict[str, Any]) -> dict[str, Any]:
        if title == "Extraction":
            # This integration exercises the real ModelExtractor boundary; the incoming
            # event evidence is copied from the controlled test request, not fabricated.
            raw = json.loads(request["messages"][-1]["content"])
            record = raw[0]
            return {
                "memories": [
                    {
                        "category": "preference",
                        "content": "Alice likes tea.",
                        "subjects": [record["person_id"]],
                        "evidence_refs": [{"source": record["source"], "id": record["id"]}],
                        "origin": "reported",
                        "occurred_at": None,
                    }
                ]
            }
        if title in {"ExtractedEntities", "ExtractedEntitiesBulk"}:
            return {
                "extracted_entities": [
                    {"name": "Alice", "entity_type_id": 0, "episode_indices": [0]},
                    {"name": "tea", "entity_type_id": 0, "episode_indices": [0]},
                ]
            }
        if title in {"ExtractedEdges", "ExtractedEdgesBulk"}:
            return {
                "edges": [
                    {
                        "source_entity_name": "Alice",
                        "target_entity_name": "tea",
                        "relation_type": "PREFERS",
                        "fact": "Alice likes tea.",
                        "valid_at": None,
                        "invalid_at": None,
                        "episode_indices": [0],
                    }
                ]
            }
        if title == "CombinedExtraction":
            return {
                "extracted_entities": [{"name": "Alice", "entity_type_id": 0}, {"name": "tea", "entity_type_id": 0}],
                "edges": [
                    {
                        "source_entity_name": "Alice",
                        "target_entity_name": "tea",
                        "relation_type": "PREFERS",
                        "fact": "Alice likes tea.",
                        "episode_indices": [0],
                    }
                ],
            }
        if title in {"EntitySummary", "EdgeSummary", "SagaSummary"}:
            return {"summary": "Alice prefers tea."}
        # All other graph decisions are deterministic no-op resolutions. Their schema
        # titles are recorded in `requests`, so failures reveal Graphiti API drift.
        return OpenAIStub._empty_schema_value(title)

    @staticmethod
    def _empty_schema_value(_title: str) -> dict[str, Any]:
        # Graphiti's selection/deduplication prompts accept empty lists as no-op decisions.
        return {
            "entity_resolutions": [],
            "duplicate_facts": [],
            "contradicted_facts": [],
            "summaries": [],
            "timestamps": [],
            "edges": [],
            "extracted_entities": [],
        }


@pytest.fixture
async def openai_stub() -> AsyncIterator[OpenAIStub]:
    stub = OpenAIStub()
    await stub.start()
    try:
        yield stub
    finally:
        await stub.close()


@pytest.mark.asyncio
async def test_real_graphiti_add_search_forget_rebuild_and_idempotent_replay(
    tmp_path: Path, openai_stub: OpenAIStub, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MEMORY_TEST_MODEL_KEY", "synthetic-model-key")
    monkeypatch.setenv("MEMORY_NEO4J_PASSWORD", os.getenv("MEMORY_NEO4J_PASSWORD", "integration-only-password"))
    neo4j_uri = os.getenv("MEMORY_NEO4J_URI", "bolt://127.0.0.1:17687")
    base = f"http://127.0.0.1:{openai_stub.port}/v1"
    source = f"imbrex://qq/fixture/main/group/{uuid.uuid4().hex[:8]}"
    settings = ServiceConfig(
        data_dir=str(tmp_path),
        neo4j_uri=neo4j_uri,
        neo4j_user="neo4j",
        neo4j_password_env="MEMORY_NEO4J_PASSWORD",
        queue_limit=8,
        request_timeout_seconds=20,
        extraction=ModelConfig(base_url=base, model="fixture-chat", api_key_env="MEMORY_TEST_MODEL_KEY"),
        embedding=EmbeddingConfig(base_url=base, model="fixture-embedding", api_key_env="MEMORY_TEST_MODEL_KEY", dimensions=8),
    )
    graph = GraphitiIndex(settings)
    extractor = ModelExtractor(settings)
    store = Store(tmp_path / "memory.sqlite3")
    engine = Engine(settings, store, graph, extractor)
    caller = "integration-caller"
    store_id, instance_id = "integration-store", "integration-instance"
    record = {
        "source": source,
        "id": f"message:{uuid.uuid4().hex}",
        "seq": "1",
        "accepted_at": now(),
        "account_id": "synthetic-account",
        "identity_namespace": "fixture",
        "conversation_type": "group",
        "conversation_id": "synthetic-group",
        "sender_id": "alice-001",
        "text": "Alice likes tea.",
        "type": "qq.message.group",
    }
    ingest = OperationRequest(
        request_id=digest(["integration-ingest", record]),
        store_id=store_id,
        instance_id=instance_id,
        caller_id=caller,
        scopes=[source],
        kind="ingest",
        payload={"records": [record]},
    )
    neo = AsyncGraphDatabase.driver(settings.neo4j_uri, auth=(settings.neo4j_user, os.environ[settings.neo4j_password_env]))
    group_id = ""
    try:
        await graph.initialize()
        accepted = await engine.apply(ingest)
        assert accepted["indexed_records"] == 1
        assert await engine.apply(ingest) == accepted
        assert len(openai_stub.requests) >= 1
        memories = store.current([store.scope(store_id, instance_id, source, settings.fingerprint())["key"]])
        assert len(memories) == 1
        memory = memories[0]
        assert memory["content"] == "Alice likes tea."
        group_id = store.group(store.scope(store_id, instance_id, source, settings.fingerprint()))

        # Verify the episode is persisted in Neo4j, rather than only returned by a fake index.
        result = await neo.execute_query(
            "MATCH (e:Episodic {uuid: $uuid}) RETURN e.uuid AS uuid, e.name AS name", uuid=memory["episode_uuid"], database_="neo4j"
        )
        assert result.records and result.records[0]["uuid"] == memory["episode_uuid"]
        relation = await neo.execute_query(
            "MATCH (a:Entity {name: 'Alice'})-[r:RELATES_TO {fact: 'Alice likes tea.', group_id: $group}]->(t:Entity {name: 'tea'}) "
            "RETURN r.uuid AS uuid LIMIT 1",
            group=group_id,
            database_="neo4j",
        )
        assert relation.records, "the controlled Graphiti schema response must materialize Alice -> tea preference"
        # First-write-wins replay must not add a second canonical graph episode.
        replay_count = await neo.execute_query(
            "MATCH (e:Episodic {name: $name}) RETURN count(e) AS n", name=f"{memory['id']}:1", database_="neo4j"
        )
        assert replay_count.records[0]["n"] == 1

        search = QueryRequest(
            store_id=store_id,
            instance_id=instance_id,
            caller_id=caller,
            scopes=[source],
            kind="search",
            params={"query": "Alice tea preference"},
        )
        found = await engine.query(search)
        assert [item["id"] for item in found["memories"]] == [memory["id"]]
        assert found["memories"][0]["content"] == "Alice likes tea."
        assert memory["episode_uuid"] in await graph.search([group_id], "Alice tea preference", 10)

        rebuild = OperationRequest(
            request_id=digest(["rebuild", source]),
            store_id=store_id,
            instance_id=instance_id,
            caller_id=caller,
            scopes=[source],
            kind="rebuild",
            payload={"reason": "integration rebuild"},
        )
        rebuilt = await engine.apply(rebuild)
        assert rebuilt == {"rebuilt_scopes": 1}
        rebuilt_query = await engine.query(search)
        assert [item["id"] for item in rebuilt_query["memories"]] == [memory["id"]]
        rebuilt_scope = store.scope(store_id, instance_id, source, settings.fingerprint())
        rebuilt_group = store.group(rebuilt_scope)
        assert rebuilt_group != group_id
        current_memory = store.current([rebuilt_scope["key"]])[0]
        assert current_memory["episode_uuid"] in await graph.search([rebuilt_group], "Alice tea preference", 10)

        # Rebuild reindexes active canonical data in a fresh generation.
        generation_count = await neo.execute_query(
            "MATCH (e:Episodic {name: $name}) RETURN count(e) AS n", name=f"{memory['id']}:1", database_="neo4j"
        )
        assert generation_count.records[0]["n"] == 2

        forget = OperationRequest(
            request_id=digest(["forget", memory["id"]]),
            store_id=store_id,
            instance_id=instance_id,
            caller_id=caller,
            scopes=[source],
            kind="forget",
            payload={"memory_id": memory["id"], "expected_revision": 1, "reason": "integration cleanup"},
        )
        await engine.apply(forget)
        assert (await engine.query(search))["memories"] == []
        assert len(openai_stub.requests) > 1
    finally:
        # Remove test-owned graph relationships and episodic nodes; avoid deleting any
        # possibly shared Entity node from the disposable database.
        if group_id:
            await neo.execute_query("MATCH ()-[r]->() WHERE r.group_id = $group DELETE r", group=group_id, database_="neo4j")
            await neo.execute_query("MATCH (e:Episodic {group_id: $group}) DELETE e", group=group_id, database_="neo4j")
            try:
                scope_now = store.scope(store_id, instance_id, source, settings.fingerprint())
                current_group = store.group(scope_now)
                if current_group != group_id:
                    await neo.execute_query("MATCH ()-[r]->() WHERE r.group_id = $group DELETE r", group=current_group, database_="neo4j")
                    await neo.execute_query("MATCH (e:Episodic {group_id: $group}) DELETE e", group=current_group, database_="neo4j")
            except Exception:
                pass
        await neo.close()
        await engine.close()
