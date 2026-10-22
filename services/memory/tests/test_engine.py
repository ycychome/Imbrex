from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from pathlib import Path

import pytest

from imbrex_memory.config import EmbeddingConfig, ExtractionModelConfig, ServiceConfig
from imbrex_memory.engine import Engine
from imbrex_memory.models import Candidate, Extraction, MemoryError, OperationRequest, QueryRequest, digest, now
from imbrex_memory.store import Store

SOURCE = "imbrex://qq/123456/main/group/987654"
OTHER_SOURCE = "imbrex://qq/123456/main/private/654321"
STORE_ID = "fixture-store"
INSTANCE_ID = "memory"


class FakeGraph:
    def __init__(self) -> None:
        self.initialized = False
        self.added: list[tuple[str, dict[str, object]]] = []
        self.searched: list[tuple[list[str], str, int]] = []
        self.fail_after_add = False

    async def initialize(self) -> None:
        self.initialized = True

    async def add(self, group: str, memory: dict[str, object]) -> str:
        self.added.append((group, memory.copy()))
        if self.fail_after_add:
            self.fail_after_add = False
            raise RuntimeError("remote graph acknowledgement lost")
        return f"episode-{len(self.added)}"

    async def search(self, groups: list[str], query: str, limit: int) -> set[str]:
        self.searched.append((groups, query, limit))
        return {memory.get("episode_uuid", "") for group, memory in self.added if group in groups}

    async def close(self) -> None:
        return None


class FakeVisual:
    async def process(self, _scope: str, record: dict[str, object]) -> list[dict[str, object]]:
        return [{"segment_index": image["segment_index"], "state": "succeeded", "text": "视觉观察"} for image in record.get("images", [])]

    async def close(self) -> None:
        return None

    async def sweep(self) -> None:
        return None


class BlockingVisual(FakeVisual):
    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def process(self, _scope: str, record: dict[str, object]) -> list[dict[str, object]]:
        self.started.set()
        await self.release.wait()
        return await super().process(_scope, record)


class FakeExtractor:
    def __init__(self) -> None:
        self.next = Extraction(memories=[])
        self.calls: list[list[dict[str, object]]] = []
        self.fail_next = False

    async def extract(self, records: list[dict[str, object]]) -> Extraction:
        self.calls.append(records)
        if self.fail_next:
            self.fail_next = False
            raise RuntimeError("synthetic extractor failure")
        return self.next

    async def close(self) -> None:
        return None


def config(tmp_path: Path, *, queue_limit: int = 4) -> ServiceConfig:
    return ServiceConfig(
        data_dir=str(tmp_path),
        queue_limit=queue_limit,
        request_timeout_seconds=1,
        extraction=ExtractionModelConfig(base_url="https://models.example.invalid/v1", model="extract-test", api_key_env="EXTRACT_KEY"),
        embedding=EmbeddingConfig(base_url="https://models.example.invalid/v1", model="embed-test", api_key_env="EMBED_KEY", dimensions=8),
    )


def request(
    kind: str, payload: dict[str, object], *, caller: str = "caller-a", source: str = SOURCE, request_id: str | None = None
) -> OperationRequest:
    return OperationRequest(
        request_id=request_id or digest([kind, payload, caller]),
        store_id=STORE_ID,
        instance_id=INSTANCE_ID,
        caller_id=caller,
        scopes=[source],
        kind=kind,
        payload=payload,
    )


def query(
    kind: str, params: dict[str, object], *, caller: str = "caller-a", source: str = SOURCE, instance: str = INSTANCE_ID
) -> QueryRequest:
    return QueryRequest(store_id=STORE_ID, instance_id=instance, caller_id=caller, scopes=[source], kind=kind, params=params)


def event_record(identifier: str, seq: str, *, source: str = SOURCE, text: str = "小林喜欢乌龙茶。") -> dict[str, object]:
    return {
        "source": source,
        "id": identifier,
        "seq": seq,
        "accepted_at": now(),
        "account_id": "123456",
        "identity_namespace": "main",
        "conversation_type": "group",
        "conversation_id": "987654",
        "sender_id": "111111",
        "text": text,
        "type": "qq.message.group",
    }


def candidate(*, source: str = SOURCE, event_id: str = "message:1", content: str = "小林喜欢乌龙茶。") -> Candidate:
    return Candidate(
        category="preference",
        content=content,
        subjects=["qq:123456:main:111111"],
        evidence_refs=[{"source": source, "id": event_id}],
        origin="reported",
    )


def engine_for(
    tmp_path: Path, *, extracted: list[Candidate] | None = None, queue_limit: int = 4
) -> tuple[Engine, Store, FakeGraph, FakeExtractor]:
    store = Store(tmp_path / "memory.sqlite3")
    graph, extractor = FakeGraph(), FakeExtractor()
    extractor.next = Extraction(memories=extracted or [])
    engine = Engine(config(tmp_path, queue_limit=queue_limit), store, graph, extractor)
    return engine, store, graph, extractor


@pytest.mark.asyncio
async def test_operation_acceptance_is_idempotent_conflicts_on_reuse_and_enforces_queue_limit(tmp_path: Path) -> None:
    engine, store, _, _ = engine_for(tmp_path, queue_limit=1)
    try:
        original = request("rebuild", {"reason": "rebuild stale index"}, request_id="a" * 64)
        accepted = engine.accept(original)
        assert accepted == {"operation_id": "a" * 64, "state": "queued", "accepted": True, "applied": False}
        assert engine.accept(original) == accepted
        with pytest.raises(MemoryError, match="idempotency_conflict"):
            engine.accept(request("rebuild", {"reason": "different intent"}, request_id="a" * 64))
        with pytest.raises(MemoryError, match="busy"):
            engine.accept(request("rebuild", {"reason": "another queued intent"}, request_id="b" * 64))
        assert store.db.execute("SELECT count(*) FROM operations").fetchone()[0] == 1
    finally:
        store.close()


@pytest.mark.asyncio
async def test_ingestion_is_evidence_bound_and_replay_does_not_duplicate_graph_or_ledger(tmp_path: Path) -> None:
    extracted = [candidate()]
    engine, store, graph, extractor = engine_for(tmp_path, extracted=extracted)
    ingest = request("ingest", {"records": [event_record("message:1", "1")]}, request_id="c" * 64)
    try:
        result = await engine.apply(ingest)
        assert result["indexed_records"] == 1
        assert len(graph.added) == 1
        assert store.db.execute("SELECT count(*) FROM records").fetchone()[0] == 1

        replay = await engine.apply(ingest)
        assert replay == result
        assert len(graph.added) == 1
        assert len(extractor.calls) == 1

        extractor.next = Extraction(memories=[candidate(event_id="message:unknown")])
        with pytest.raises(MemoryError, match="invalid_extraction"):
            await engine.apply(request("ingest", {"records": [event_record("message:2", "2")]}, request_id="d" * 64))
        assert store.db.execute("SELECT count(*) FROM records").fetchone()[0] == 1
    finally:
        store.close()


@pytest.mark.asyncio
async def test_ingest_validates_all_candidates_before_any_graph_write(tmp_path: Path) -> None:
    engine, store, graph, _ = engine_for(
        tmp_path,
        extracted=[candidate(event_id="message:1"), candidate(event_id="message:missing")],
    )
    ingest = request(
        "ingest",
        {"records": [event_record("message:1", "1"), event_record("message:2", "2")]},
        request_id="a" * 64,
    )
    try:
        with pytest.raises(MemoryError, match="invalid_extraction"):
            await engine.apply(ingest)
        assert graph.added == []
        assert store.db.execute("SELECT count(*) FROM records").fetchone()[0] == 0
    finally:
        store.close()


@pytest.mark.asyncio
async def test_specific_chinese_evidence_outranks_a_generic_graph_hit(tmp_path: Path) -> None:
    engine, store, graph, _ = engine_for(
        tmp_path,
        extracted=[
            candidate(content="紫苏明确说自己不喝浓茶。"),
            candidate(content="紫苏喜欢在项目群分享图片。"),
        ],
    )
    try:
        await engine.apply(request("ingest", {"records": [event_record("message:1", "1")]}))
        scope = store.scope(STORE_ID, INSTANCE_ID, SOURCE, engine.config.fingerprint())
        memories = store.current([scope["key"]])
        generic = next(memory for memory in memories if "分享图片" in memory["content"])

        async def generic_graph_hit(_groups: list[str], _query: str, _limit: int) -> set[str]:
            return {generic["episode_uuid"]}

        graph.search = generic_graph_hit  # type: ignore[method-assign]
        engine.ready = True
        result = await engine.query(query("search", {"query": "紫苏明确表示不喝什么？", "limit": 1}))
        assert result["stale"] is False
        assert result["memories"][0]["content"] == "紫苏明确说自己不喝浓茶。"
        # With no lexical overlap, graph relevance is still useful.
        result = await engine.query(query("search", {"query": "unrelated semantic paraphrase", "limit": 1}))
        assert result["memories"][0]["id"] == generic["id"]
    finally:
        store.close()


@pytest.mark.asyncio
async def test_maintenance_rebuild_recovers_rejected_ingest_in_a_fresh_generation(tmp_path: Path) -> None:
    engine, store, graph, extractor = engine_for(tmp_path, extracted=[candidate(event_id="message:missing")])
    original = request("ingest", {"records": [event_record("message:1", "1")]})
    try:
        engine.accept(original)
        with pytest.raises(MemoryError, match="invalid_extraction"):
            await engine.apply(original)
        store.finish(original, "failed", error="invalid_extraction")
        original_scope = store.scope(STORE_ID, INSTANCE_ID, SOURCE, engine.config.fingerprint())
        old_group = store.group(original_scope)
        assert graph.added == []
        extractor.next = Extraction(memories=[candidate()])
        await engine.apply(request("rebuild", {"reason": "explicitly recover rejected extraction"}, caller="maintenance"))
        current_scope = store.scope(STORE_ID, INSTANCE_ID, SOURCE, engine.config.fingerprint())
        assert store.group(current_scope) != old_group
        status = await engine.query(query("operation", {"operation_id": original.request_id}))
        assert status["state"] == "succeeded"
        assert status["applied"] is True
        assert len(store.current([current_scope["key"]])) == 1
        assert len(graph.added) == 1
        assert graph.added[0][0] != old_group
    finally:
        store.close()


@pytest.mark.asyncio
async def test_forget_tombstone_and_revision_conflict_keep_deleted_evidence_out_of_queries(tmp_path: Path) -> None:
    engine, store, graph, _ = engine_for(tmp_path)
    source_event = event_record("message:1", "1")
    evidence = {"source": SOURCE, "id": source_event["id"]}
    try:
        created = await engine.apply(
            request(
                "remember",
                {
                    "category": "preference",
                    "content": "小林喜欢乌龙茶。",
                    "subjects": ["qq:123456:main:111111"],
                    "evidence_refs": [evidence],
                },
                request_id="e" * 64,
            )
        )
        memory_id = str(created["memory_id"])
        revised = await engine.apply(
            request(
                "update",
                {"memory_id": memory_id, "expected_revision": 1, "reason": "本人更正偏好", "content": "小林现在更喜欢绿茶。"},
                request_id="f" * 64,
            )
        )
        assert revised["revision"] == 2
        with pytest.raises(MemoryError, match="revision_conflict"):
            await engine.apply(
                request(
                    "update",
                    {"memory_id": memory_id, "expected_revision": 1, "reason": "stale correction", "content": "旧版本更正"},
                    request_id="1" * 64,
                )
            )
        forgotten = await engine.apply(
            request("forget", {"memory_id": memory_id, "expected_revision": 2, "reason": "用户要求删除"}, request_id="2" * 64)
        )
        assert forgotten["revision"] == 3
        assert store.db.execute("SELECT count(*) FROM tombstones WHERE evidence_id='message:1'").fetchone()[0] == 1
        with pytest.raises(MemoryError, match="not_found"):
            await engine.query(query("get", {"memory_id": memory_id}))
        context = await engine.query(query("context", {"input_event_ref": evidence, "max_bytes": 8192}))
        assert "小林现在更喜欢绿茶" not in context["context"]
        assert len(graph.added) == 2
    finally:
        store.close()


@pytest.mark.asyncio
async def test_graph_acknowledgement_loss_marks_unknown_quarantines_scope_and_rebuild_uses_new_generation(tmp_path: Path) -> None:
    engine, store, graph, _ = engine_for(tmp_path)
    manual = request(
        "remember",
        {"category": "fact", "content": "值班时间是周五。", "subjects": [], "evidence_refs": [{"source": SOURCE, "id": "message:5"}]},
        request_id="3" * 64,
    )
    try:
        graph.fail_after_add = True
        engine.accept(manual)
        engine.start()
        await wait_for(lambda: operation_state(store, manual.request_id) == "unknown")
        scope = store.scope(STORE_ID, INSTANCE_ID, SOURCE, engine.config.fingerprint())
        first_generation = scope["generation"]
        assert scope["quarantined"] == 1

        rebuild = request("rebuild", {"reason": "recover uncertain graph write"}, request_id="4" * 64)
        engine.accept(rebuild)
        await wait_for(lambda: operation_state(store, rebuild.request_id) == "succeeded")
        recovered = store.scope(STORE_ID, INSTANCE_ID, SOURCE, engine.config.fingerprint())
        assert recovered["quarantined"] == 0
        assert recovered["generation"] != first_generation
        original_status = await engine.query(query("operation", {"operation_id": manual.request_id}))
        assert original_status["state"] == "succeeded"
        assert original_status["applied"] is True
        assert original_status["result"] == {"memory_id": digest([scope_key(store), manual.request_id]), "revision": 1}
        assert len(graph.added) == 2
    finally:
        await engine.close()


@pytest.mark.asyncio
async def test_restart_turns_running_operation_unknown_and_quarantines_its_scope(tmp_path: Path) -> None:
    path = tmp_path / "memory.sqlite3"
    store = Store(path)
    config_value = config(tmp_path)
    pending = request("rebuild", {"reason": "interrupted during remote write"}, request_id="5" * 64)
    store.scope(STORE_ID, INSTANCE_ID, SOURCE, config_value.fingerprint())
    store.accept(pending, config_value.queue_limit)
    store.finish(pending, "running")
    store.close()

    recovered = Store(path)
    try:
        row = recovered.db.execute("SELECT state,error FROM operations WHERE id=?", (pending.request_id,)).fetchone()
        scope = recovered.scope(STORE_ID, INSTANCE_ID, SOURCE, config_value.fingerprint())
        assert tuple(row) == ("unknown", "interrupted")
        assert scope["quarantined"] == 1
    finally:
        recovered.close()


def test_restart_requeues_running_images_operation_without_text_quarantine(tmp_path: Path) -> None:
    path = tmp_path / "memory.sqlite3"
    initial = Store(path)
    config_value = config(tmp_path)
    initial.scope(STORE_ID, INSTANCE_ID, SOURCE, config_value.fingerprint())
    image_request = request(
        "images",
        {
            "input_event_ref": {"source": SOURCE, "id": "message:14"},
            "images": [{"segment_index": 0, "file": "synthetic-file", "url": "https://images.example.invalid/a.png"}],
        },
        request_id="3" * 64,
    )
    initial.accept(image_request, config_value.queue_limit)
    initial.finish(image_request, "running")
    initial.close()

    recovered = Store(path)
    try:
        operation = recovered.db.execute("SELECT state,error FROM operations WHERE id=?", (image_request.request_id,)).fetchone()
        recovered_scope = recovered.scope(STORE_ID, INSTANCE_ID, SOURCE, config_value.fingerprint())
        assert operation["state"] == "queued"
        assert operation["error"] is None
        assert recovered_scope["quarantined"] == 0
        assert recovered_scope["visual_quarantined"] == 0
    finally:
        recovered.close()


def test_store_rejects_second_process_for_the_same_data_directory(tmp_path: Path) -> None:
    first = Store(tmp_path / "memory.sqlite3")
    try:
        with pytest.raises(RuntimeError, match="already in use"):
            Store(tmp_path / "memory.sqlite3")
    finally:
        first.close()
    reopened = Store(tmp_path / "memory.sqlite3")
    reopened.close()


@pytest.mark.asyncio
async def test_full_visual_queue_and_hung_ocr_do_not_block_text_ingest(tmp_path: Path) -> None:
    engine, store, _, extractor = engine_for(tmp_path, queue_limit=1)
    visual = BlockingVisual()
    engine.visual = visual
    image_record = event_record("message:30", "30")
    image_record["images"] = [{"segment_index": 0, "file": "synthetic-file", "url": "https://images.example.invalid/a.png"}]
    try:
        await engine.apply(request("ingest", {"records": [image_record]}, request_id="4" * 64))
        await engine.apply(
            request(
                "images", {"input_event_ref": {"source": SOURCE, "id": "message:30"}, "images": image_record["images"]}, request_id="9" * 64
            )
        )
        extractor.next = Extraction(memories=[candidate(event_id="message:31", content="队列满时仍可记录的文本。")])
        engine.start()
        await asyncio.wait_for(visual.started.wait(), timeout=2)

        extra_images = request(
            "images",
            {
                "input_event_ref": {"source": SOURCE, "id": "message:30"},
                "images": [{"segment_index": 0, "file": "synthetic-file", "url": "https://images.example.invalid/a.png"}],
            },
            request_id="5" * 64,
        )
        with pytest.raises(MemoryError, match="busy"):
            engine.accept(extra_images)

        text_operation = request("ingest", {"records": [event_record("message:31", "31")]}, request_id="6" * 64)
        engine.accept(text_operation)
        await wait_for(lambda: operation_state(store, text_operation.request_id) == "succeeded")
        assert store.db.execute("SELECT 1 FROM records WHERE id='message:31'").fetchone()
        scope = store.scope(STORE_ID, INSTANCE_ID, SOURCE, engine.config.fingerprint())
        assert scope["quarantined"] == 0
        assert scope["visual_quarantined"] == 0
    finally:
        visual.release.set()
        await engine.close()


@pytest.mark.asyncio
async def test_operation_query_is_owned_by_original_caller_and_status_does_not_leak_other_callers(tmp_path: Path) -> None:
    engine, store, _, _ = engine_for(tmp_path)
    accepted = request(
        "remember",
        {"category": "fact", "content": "仅属于A的私有记忆。", "subjects": [], "evidence_refs": [{"source": SOURCE, "id": "message:8"}]},
        caller="caller-a",
        request_id="6" * 64,
    )
    try:
        engine.accept(accepted)
        store.finish(accepted, "succeeded", {"private_marker": "do not disclose"})
        with pytest.raises(MemoryError, match="not_found"):
            await engine.query(query("operation", {"operation_id": accepted.request_id}, caller="caller-b"))
        status = await engine.query(query("status", {}, caller="caller-b"))
        assert accepted.request_id not in json.dumps(status)
    finally:
        store.close()


def test_ingest_contract_accepts_versioned_ts_payload_and_rejects_unknown_schema(tmp_path: Path) -> None:
    engine, store, _, _ = engine_for(tmp_path)
    try:
        ts_request = request("ingest", {"schema_version": 1, "records": [event_record("message:9", "9")]})
        engine.validate(ts_request)
        with pytest.raises(MemoryError, match="invalid_params"):
            engine.validate(request("ingest", {"schema_version": 2, "records": [event_record("message:9", "9")]}, request_id="7" * 64))
    finally:
        store.close()


@pytest.mark.asyncio
async def test_unindexed_context_ref_never_returns_unrelated_fresh_memory(tmp_path: Path) -> None:
    engine, store, _, _ = engine_for(tmp_path)
    try:
        await engine.apply(
            request(
                "remember",
                {
                    "category": "fact",
                    "content": "旧会话中的无关事实。",
                    "subjects": [],
                    "evidence_refs": [{"source": SOURCE, "id": "message:10"}],
                },
                request_id="8" * 64,
            )
        )
        result = await engine.query(query("context", {"input_event_ref": {"source": SOURCE, "id": "not-indexed"}}))
        assert result["stale"] is True
        assert result["input_indexed"] is False
        assert result["memories"] == []
        assert "无关事实" not in result["context"]
    finally:
        store.close()


def test_restart_requeues_pre_graph_visual_work_but_quarantines_indexing_visual_work_only(tmp_path: Path) -> None:
    path = tmp_path / "memory.sqlite3"
    initial = Store(path)
    running_scope = initial.scope(STORE_ID, INSTANCE_ID, SOURCE, config(tmp_path).fingerprint())
    indexing_scope = initial.scope(STORE_ID, INSTANCE_ID, OTHER_SOURCE, config(tmp_path).fingerprint())
    initial.db.execute("INSERT INTO visual_jobs VALUES(?,?,?)", (running_scope["key"], "message:11", "running"))
    initial.db.execute("INSERT INTO visual_jobs VALUES(?,?,?)", (indexing_scope["key"], "message:12", "indexing"))
    initial.close()

    recovered = Store(path)
    try:
        running_job = recovered.db.execute(
            "SELECT state FROM visual_jobs WHERE scope=? AND event_id=?", (running_scope["key"], "message:11")
        ).fetchone()
        indexing_job = recovered.db.execute(
            "SELECT state FROM visual_jobs WHERE scope=? AND event_id=?", (indexing_scope["key"], "message:12")
        ).fetchone()
        recovered_running_scope = recovered.scope(STORE_ID, INSTANCE_ID, SOURCE, config(tmp_path).fingerprint())
        recovered_indexing_scope = recovered.scope(STORE_ID, INSTANCE_ID, OTHER_SOURCE, config(tmp_path).fingerprint())
        assert running_job["state"] == "queued"
        assert recovered_running_scope["quarantined"] == 0
        assert recovered_running_scope["visual_quarantined"] == 0
        assert indexing_job["state"] == "unknown"
        assert recovered_indexing_scope["quarantined"] == 0
        assert recovered_indexing_scope["visual_quarantined"] == 1
    finally:
        recovered.close()


@pytest.mark.asyncio
async def test_visual_extractor_failure_fails_only_visual_job_and_text_ingest_continues(tmp_path: Path) -> None:
    engine, store, _, extractor = engine_for(tmp_path)
    engine.visual = FakeVisual()
    visual_record = event_record("message:20", "20")
    visual_record["images"] = [{"segment_index": 0, "file": "synthetic-file", "url": "https://images.example.invalid/a.png"}]
    try:
        await engine.apply(request("ingest", {"records": [visual_record]}, request_id="d" * 64))
        await engine.apply(
            request(
                "images",
                {"input_event_ref": {"source": SOURCE, "id": "message:20"}, "images": visual_record["images"]},
                request_id="7" * 64,
            )
        )
        extractor.fail_next = True
        assert await engine.process_visual_job()
        scope = store.scope(STORE_ID, INSTANCE_ID, SOURCE, engine.config.fingerprint())
        job = store.db.execute("SELECT state FROM visual_jobs WHERE scope=? AND event_id=?", (scope["key"], "message:20")).fetchone()
        assert job["state"] == "failed"
        assert scope["quarantined"] == 0
        assert scope["visual_quarantined"] == 0

        extractor.next = Extraction(memories=[candidate(event_id="message:21", content="文本通道仍可索引。")])
        result = await engine.apply(request("ingest", {"records": [event_record("message:21", "21")]}, request_id="e" * 64))
        assert result["indexed_records"] == 1
        assert scope["quarantined"] == 0
        assert scope["visual_quarantined"] == 0
    finally:
        store.close()


@pytest.mark.asyncio
async def test_uncertain_visual_graph_write_quarantines_vision_only_and_rebuild_clears_it(tmp_path: Path) -> None:
    engine, store, graph, extractor = engine_for(tmp_path)
    engine.visual = FakeVisual()
    visual_record = event_record("message:22", "22")
    visual_record["images"] = [{"segment_index": 0, "file": "synthetic-file", "url": "https://images.example.invalid/a.png"}]
    try:
        await engine.apply(request("ingest", {"records": [visual_record]}, request_id="f" * 64))
        await engine.apply(
            request(
                "images",
                {"input_event_ref": {"source": SOURCE, "id": "message:22"}, "images": visual_record["images"]},
                request_id="8" * 64,
            )
        )
        extractor.next = Extraction(memories=[candidate(event_id="message:22", content="图片描述的记忆。")])
        graph.fail_after_add = True
        assert await engine.process_visual_job()
        scope = store.scope(STORE_ID, INSTANCE_ID, SOURCE, engine.config.fingerprint())
        job = store.db.execute("SELECT state FROM visual_jobs WHERE scope=? AND event_id=?", (scope["key"], "message:22")).fetchone()
        assert job["state"] == "unknown"
        assert scope["quarantined"] == 0
        assert scope["visual_quarantined"] == 1

        extractor.next = Extraction(memories=[candidate(event_id="message:23", content="文本通道仍可索引。")])
        result = await engine.apply(request("ingest", {"records": [event_record("message:23", "23")]}, request_id="1" * 64))
        assert result["indexed_records"] == 1
        assert store.db.execute(
            "SELECT 1 FROM memories WHERE scope=? AND active=1 AND body LIKE '%文本通道仍可索引%'", (scope["key"],)
        ).fetchone()

        engine.ready = True
        await engine.query(query("context", {"input_event_ref": {"source": SOURCE, "id": "message:23"}}))
        assert graph.searched
        groups = graph.searched[-1][0]
        assert store.group(scope) in groups
        assert store.group(scope, channel="vision") not in groups

        rebuilt = await engine.apply(request("rebuild", {"reason": "recover uncertain visual index"}, request_id="2" * 64))
        assert rebuilt["rebuilt_scopes"] == 1
        recovered_scope = store.scope(STORE_ID, INSTANCE_ID, SOURCE, engine.config.fingerprint())
        assert recovered_scope["quarantined"] == 0
        assert recovered_scope["visual_quarantined"] == 0
    finally:
        store.close()


@pytest.mark.asyncio
async def test_model_rebuild_reextracts_records_without_overwriting_manual_or_reviving_tombstones(tmp_path: Path) -> None:
    initial_candidates = [
        candidate(event_id="message:12", content="旧模型自动提取偏好。"),
        candidate(event_id="message:13", content="旧模型待删除偏好。"),
    ]
    engine, store, _, extractor = engine_for(tmp_path, extracted=initial_candidates)
    try:
        await engine.apply(
            request("ingest", {"records": [event_record("message:12", "12"), event_record("message:13", "13")]}, request_id="9" * 64)
        )
        manual = await engine.apply(
            request(
                "remember",
                {
                    "category": "preference",
                    "content": "用户人工确认的偏好。",
                    "subjects": ["qq:123456:main:111111"],
                    "evidence_refs": [{"source": SOURCE, "id": "message:12"}],
                },
                request_id="a" * 64,
            )
        )
        deleted_auto = store.db.execute(
            "SELECT id FROM memories WHERE scope=? AND active=1 AND manual=0 AND body LIKE '%待删除%'", (scope_key(store),)
        ).fetchone()
        assert deleted_auto is not None
        await engine.apply(
            request("forget", {"memory_id": deleted_auto["id"], "expected_revision": 1, "reason": "用户要求删除"}, request_id="b" * 64)
        )

        engine.config = engine.config.model_copy(update={"extraction": engine.config.extraction.model_copy(update={"model": "extract-v2"})})
        extractor.next = Extraction(
            memories=[
                candidate(event_id="message:12", content="新模型重抽取但被人工记忆保护。"),
                candidate(event_id="message:13", content="新模型试图复活已删除偏好。"),
            ]
        )
        result = await engine.apply(request("rebuild", {"reason": "extractor model changed"}, request_id="c" * 64))

        assert result["rebuilt_scopes"] == 1
        scope = store.scope(STORE_ID, INSTANCE_ID, SOURCE, engine.config.fingerprint())
        assert scope["quarantined"] == 0
        assert scope["fingerprint"] == engine.config.fingerprint()
        memories = [json.loads(row[0]) for row in store.db.execute("SELECT body FROM memories WHERE scope=?", (scope["key"],))]
        active = [memory for memory in memories if memory["active"]]
        manual_row = store.db.execute("SELECT body FROM memories WHERE id=?", (manual["memory_id"],)).fetchone()
        assert manual_row is not None
        assert any(memory["id"] == manual["memory_id"] and memory["content"] == "用户人工确认的偏好。" for memory in active)
        assert not any(memory["content"] == "新模型重抽取但被人工记忆保护。" for memory in active)
        assert not any(memory["content"] == "新模型试图复活已删除偏好。" for memory in active)
        assert store.db.execute("SELECT 1 FROM tombstones WHERE scope=? AND evidence_id='message:13'", (scope["key"],)).fetchone()
        assert len(extractor.calls) == 2
    finally:
        store.close()


async def wait_for(condition: Callable[[], bool], timeout: float = 2.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if condition():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("condition did not become true before deadline")


def operation_state(store: Store, request_id: str) -> str | None:
    row = store.db.execute("SELECT state FROM operations WHERE id=?", (request_id,)).fetchone()
    return row["state"] if row else None


def scope_key(store: Store) -> str:
    return store.db.execute(
        "SELECT key FROM scopes WHERE store_id=? AND instance_id=? AND source=?", (STORE_ID, INSTANCE_ID, SOURCE)
    ).fetchone()["key"]
