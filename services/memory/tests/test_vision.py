"""Exercise the complete preprocessing-to-vision payload, partial results and variant invalidation."""

import io
import json
from pathlib import Path

import httpx
import pytest
from PIL import Image
from test_engine import SOURCE, config, event_record

from imbrex_memory.config import ModelConfig
from imbrex_memory.media import DownloadedImage
from imbrex_memory.models import canonical
from imbrex_memory.store import Store
from imbrex_memory.vision import Vision


@pytest.mark.asyncio
async def test_vision_uses_real_encoded_model_budget_and_records_partial_and_expired_variants(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("VISION_FIXTURE_KEY", "synthetic-vision-key")
    settings = config(tmp_path)
    settings.vision = ModelConfig(base_url="https://vision.example.invalid/v1", model="explicit-model", api_key_env="VISION_FIXTURE_KEY")
    settings.vision_profile = {
        "formats": ["png"],
        "max_input_bytes": 12000,
        "max_width": 256,
        "max_height": 256,
        "max_pixels": 65536,
        "max_images": 2,
        "context_tokens": 4096,
        "prompt_tokens": 2048,
        "output_tokens": 512,
        "image_tokens_per_tile": 500,
    }
    settings.media = {"allowed_hosts": ["image.example.invalid"], "allow_private": False}
    store = Store(tmp_path / "ledger.sqlite3")
    scope = store.scope("test", "memory", SOURCE, settings.fingerprint())
    image = Image.new("RGB", (800, 1000), "white")
    data = io.BytesIO()
    image.save(data, format="PNG")
    original = tmp_path / "fixture.png"
    original.write_bytes(data.getvalue())
    record = event_record("message:1", "1")
    record["images"] = [{"segment_index": 0, "url": "https://image.example.invalid/private-locator", "file": "fixture"}]
    store.db.execute("INSERT INTO records VALUES(?,?,?)", (scope["key"], record["id"], canonical(record)))
    vision = Vision(settings, store)
    calls = []

    async def download(*_args, **_kwargs):
        return DownloadedImage(original, "a" * 64, original.stat().st_size, False, False)

    async def model(request: httpx.Request) -> httpx.Response:
        assert len(request.content) <= 12000
        body = json.loads(request.content)
        assert body["model"] == "explicit-model" and body["max_tokens"] == 512
        assert b"private-locator" not in request.content
        parts = body["messages"][0]["content"]
        assert sum(part["type"] == "image_url" for part in parts) <= 2
        ids = [
            int(part["text"].split(";")[0].split("=")[1])
            for part in parts
            if part["type"] == "text" and part["text"].startswith("tile_index=")
        ]
        calls.append(ids)
        if len(calls) == 2:
            return httpx.Response(500)
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": json.dumps(
                                {"tiles": [{"tile_index": index, "text": f"line {index}", "description": "合成梗图"} for index in ids]}
                            )
                        }
                    }
                ]
            },
        )

    vision.downloader.download = download
    await vision.http.aclose()
    vision.http = httpx.AsyncClient(transport=httpx.MockTransport(model))
    try:
        result = (await vision.process(scope["key"], record))[0]
        assert len(calls) > 2
        assert result["state"] == "partial" and result["failed_tiles"] > 0
        assert result["original_sha256"] == "a" * 64
        assert original.exists()
        assert (await vision.process(scope["key"], record))[0] == result
        old_fingerprint = vision.fingerprint
    finally:
        await vision.close()
    settings.vision_profile["max_images"] = 1
    newer = Vision(settings, store)
    try:
        assert newer.fingerprint != old_fingerprint
        result = (await newer.process(scope["key"], record))[0]
        assert result["reason"] == "original_cache_expired_cannot_reprocess"
    finally:
        await newer.close()
        store.close()
