"""The private HTTP boundary must not leak model credentials or accept malformed batches."""

from pathlib import Path

import httpx
import pytest
from test_engine import SOURCE, engine_for, event_record

from imbrex_memory.app import create_app
from imbrex_memory.models import digest


@pytest.mark.asyncio
async def test_private_http_auth_validation_idempotency_and_shutdown(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("MEMORY_SERVICE_TOKEN", "synthetic-private-test-token-32chars")
    engine, store, _, _ = engine_for(tmp_path)
    headers = {"authorization": "Bearer synthetic-private-test-token-32chars"}
    body = {
        "store_id": "test-store",
        "instance_id": "memory",
        "caller_id": "memory-reader",
        "scopes": [SOURCE],
        "request_id": digest("http-ingest"),
        "kind": "ingest",
        "payload": {"schema_version": 1, "records": [event_record("message:1", "1")]},
    }
    app = create_app(engine.config, engine)
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://memory") as client,
    ):
        assert (await client.get("/health")).status_code == 403
        assert (await client.get("/health", headers=headers)).status_code == 200
        invalid = await client.post("/v1/operations", headers=headers, json={**body, "caller_id": {"credential": "do-not-echo"}})
        assert invalid.status_code == 409
        assert "do-not-echo" not in invalid.text
        accepted = await client.post("/v1/operations", headers=headers, json=body)
        assert accepted.status_code == 200
        assert accepted.json()["accepted"] is True
        assert (await client.post("/v1/operations", headers=headers, json=body)).status_code == 200
        changed = await client.post(
            "/v1/operations", headers=headers, json={**body, "payload": {"schema_version": 2, "records": body["payload"]["records"]}}
        )
        assert changed.status_code == 409
        too_large = await client.post("/v1/query", headers=headers, content=b"x" * (2 * 1024 * 1024 + 1))
        assert too_large.status_code == 413
        assert (await client.get("/docs", headers=headers)).status_code == 404
    assert engine.worker is not None and engine.worker.done()
