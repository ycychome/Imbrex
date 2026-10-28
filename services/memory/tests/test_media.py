from __future__ import annotations

import asyncio
import hashlib
import io
import json
import os
import random
import tempfile
import unittest
from collections.abc import Sequence
from pathlib import Path

from PIL import Image

from imbrex_memory.media import (
    ImageCache,
    ImagePreprocessor,
    ImageTile,
    MediaBudgetError,
    MediaPolicyError,
    MediaResourceLimits,
    ModelImageProfile,
    SafeImageDownloader,
    deduplicate_overlapping_ocr,
    deduplicate_reading_order,
)


def profile(**changes: object) -> ModelImageProfile:
    values: dict[str, object] = {
        "model": "configured-vision-test",
        "formats": ("jpeg", "png", "webp"),
        "max_input_bytes": 1_000_000,
        "max_width": 2048,
        "max_height": 2048,
        "max_pixels": 4_000_000,
        "max_images": 8,
        "context_tokens": 16000,
        "prompt_tokens": 1000,
        "output_tokens": 2000,
        "image_tokens_per_tile": 100,
    }
    values.update(changes)
    return ModelImageProfile(**values)  # type: ignore[arg-type]


def image_bytes(size: tuple[int, int] = (20, 12), fmt: str = "PNG", color: str = "red", **save_options: object) -> bytes:
    image = Image.new("RGB", size, color)
    stream = io.BytesIO()
    image.save(stream, format=fmt, **save_options)
    image.close()
    return stream.getvalue()


class ProfileTests(unittest.TestCase):
    def test_profile_requires_explicit_supported_capabilities(self) -> None:
        with self.assertRaises(ValueError):
            profile(formats=())
        with self.assertRaises(ValueError):
            profile(formats=("invented-model-default",))
        with self.assertRaises(ValueError):
            profile(context_tokens=100, prompt_tokens=80, output_tokens=30)
        configured = profile(formats=("image/jpeg", "png", "jpeg"))
        self.assertEqual(configured.formats, ("jpeg", "png"))

    def test_processing_cache_key_includes_source_profile_and_parameters(self) -> None:
        digest = hashlib.sha256(b"source").hexdigest()
        a = ImageCache.processed_key(digest, profile(), {"quality": 85, "tile_overlap": 0.1})
        self.assertEqual(a, ImageCache.processed_key(digest, profile(), {"tile_overlap": 0.1, "quality": 85}))
        self.assertNotEqual(a, ImageCache.processed_key(digest, profile(max_width=1000), {"quality": 85, "tile_overlap": 0.1}))
        self.assertNotEqual(a, ImageCache.processed_key(digest, profile(), {"quality": 80, "tile_overlap": 0.1}))


class PreprocessingTests(unittest.TestCase):
    def test_exif_orientation_is_applied_and_original_hash_is_retained(self) -> None:
        image = Image.new("RGB", (2, 3), "red")
        exif = Image.Exif()
        exif[274] = 6
        source = io.BytesIO()
        image.save(source, format="JPEG", exif=exif)
        image.close()
        original = source.getvalue()
        batches = ImagePreprocessor(profile()).prepare(original, prompt="inspect")
        self.assertEqual(len(batches), 1)
        tile = batches[0].images[0]
        self.assertEqual(tile.original_sha256, hashlib.sha256(original).hexdigest())
        self.assertEqual((tile.width, tile.height), (3, 2))
        self.assertEqual(tile.format, "jpeg")
        decoded = Image.open(io.BytesIO(tile.data))
        self.assertEqual(decoded.format, "JPEG")

    def test_gif_uses_first_frame_and_converts_to_configured_format(self) -> None:
        frames = [Image.new("RGB", (9, 7), color) for color in ("red", "blue")]
        source = io.BytesIO()
        frames[0].save(source, format="GIF", save_all=True, append_images=frames[1:], duration=100, loop=0)
        for frame in frames:
            frame.close()
        configured = profile(formats=("png",))
        batch = ImagePreprocessor(configured).prepare(source.getvalue(), prompt="read")
        tile = batch[0].images[0]
        decoded = Image.open(io.BytesIO(tile.data)).convert("RGB")
        self.assertEqual(tile.format, "png")
        pixel = decoded.getpixel((0, 0))
        assert isinstance(pixel, tuple)
        self.assertGreater(pixel[0], pixel[2])

    def test_large_frame_is_tiled_with_overlap_and_coordinate_metadata(self) -> None:
        original = image_bytes((110, 50), "PNG")
        configured = profile(formats=("png",), max_width=60, max_height=50, max_pixels=3000)
        batches = ImagePreprocessor(configured).prepare(original, prompt="ocr")
        tiles = [tile for batch in batches for tile in batch.images]
        self.assertEqual(len(tiles), 2)
        self.assertTrue(all(tile.partial and tile.tile_count == 2 for tile in tiles))
        self.assertEqual([tile.coordinates for tile in tiles], [(0, 0, 60, 50), (54, 0, 110, 50)])
        self.assertEqual([tile.tile_index for tile in tiles], [0, 1])

    def test_actual_json_bytes_and_token_budget_split_batches(self) -> None:
        original = image_bytes((110, 50), "PNG")
        configured = profile(
            formats=("png",),
            max_width=60,
            max_height=50,
            max_pixels=3000,
            max_images=8,
            context_tokens=1300,
            prompt_tokens=1000,
            output_tokens=200,
            image_tokens_per_tile=100,
        )
        batches = ImagePreprocessor(configured).prepare(original, prompt="ocr")
        self.assertEqual(len(batches), 2)
        for batch in batches:
            parsed = json.loads(batch.body)
            self.assertEqual(len(parsed["images"]), 1)
            self.assertLessEqual(len(batch.body), configured.max_input_bytes)
            self.assertEqual(batch.image_tokens, 100)

    def test_body_factory_measures_actual_chat_completions_json(self) -> None:
        configured = profile(max_input_bytes=20000)

        def request_body(prompt: str, tiles: Sequence[ImageTile]) -> bytes:
            content: list[dict[str, object]] = [{"type": "text", "text": prompt}]
            for tile in tiles:
                content.append(
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:{tile.mime_type};base64,{tile.base64_data}",
                        },
                    }
                )
            return json.dumps(
                {"model": configured.model, "messages": [{"role": "user", "content": content}], "max_tokens": configured.output_tokens},
                separators=(",", ":"),
            ).encode()

        batches = ImagePreprocessor(configured).prepare(image_bytes(), prompt="read", body_factory=request_body)
        self.assertEqual(batches[0].body, request_body("read", batches[0].images))
        parsed = json.loads(batches[0].body)
        self.assertEqual(parsed["model"], configured.model)
        self.assertEqual(parsed["messages"][0]["content"][1]["type"], "image_url")
        self.assertLessEqual(len(batches[0].body), configured.max_input_bytes)

    def test_ocr_mode_splits_instead_of_downscaling_below_eighty_percent(self) -> None:
        image = Image.new("RGB", (240, 60))
        rng = random.Random(42)
        image.putdata([(rng.randrange(256), rng.randrange(256), rng.randrange(256)) for _ in range(240 * 60)])
        source = io.BytesIO()
        image.save(source, format="PNG", compress_level=0)
        image.close()
        configured = profile(formats=("png",), max_input_bytes=8000, max_width=240, max_height=60, max_pixels=14400)
        batches = ImagePreprocessor(configured).prepare(source.getvalue(), prompt="transcribe", mode="ocr")
        tiles = [tile for batch in batches for tile in batch.images]
        self.assertGreater(len(tiles), 1)
        self.assertTrue(all(tile.partial for tile in tiles))
        self.assertTrue(all(tile.width >= int((tile.coordinates[2] - tile.coordinates[0]) * 0.8) for tile in tiles))

    def test_overlapping_tile_ocr_deduplicates_exact_duplicate_lines(self) -> None:
        source = image_bytes((110, 50), "PNG")
        batches = ImagePreprocessor(profile(formats=("png",), max_width=60, max_height=50, max_pixels=3000)).prepare(source, prompt="x")
        tiles = [tile for batch in batches for tile in batch.images]
        result = deduplicate_overlapping_ocr(
            [
                (tiles[0], "Account 123\nLeft side"),
                (tiles[1], "Account 123\nRight side"),
            ]
        )
        self.assertEqual(result, "Account 123\nLeft side\nRight side")

    def test_request_decode_and_temporary_budgets_are_independent(self) -> None:
        original = image_bytes((80, 40), "PNG")
        with self.assertRaises(MediaBudgetError):
            ImagePreprocessor(profile(), limits=MediaResourceLimits(max_decode_bytes=10)).prepare(original, prompt="x")
        with self.assertRaises(MediaBudgetError):
            ImagePreprocessor(profile(), limits=MediaResourceLimits(max_decode_pixels=100)).prepare(original, prompt="x")
        with self.assertRaises(MediaBudgetError):
            ImagePreprocessor(profile(), limits=MediaResourceLimits(max_temp_bytes=100)).prepare(original, prompt="x")
        with self.assertRaises(MediaBudgetError):
            ImagePreprocessor(profile(max_input_bytes=150), limits=MediaResourceLimits(max_request_bytes=150)).prepare(
                original, prompt="a long prompt"
            )

    def test_deduplication_keeps_all_tiles_of_first_occurrence(self) -> None:
        original = image_bytes((110, 50), "PNG")
        batches = ImagePreprocessor(profile(formats=("png",), max_width=60, max_height=50, max_pixels=3000)).prepare(original, prompt="x")
        tiles = [tile for batch in batches for tile in batch.images]
        entries = [(2, 0, tile) for tile in tiles] + [(3, 1, tile) for tile in tiles]
        ordered = deduplicate_reading_order(entries)
        self.assertEqual([(event, pos, tile.tile_index) for event, pos, tile in ordered], [(2, 0, 0), (2, 0, 1)])


class DownloaderTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.requests: list[tuple[str, str]] = []

        async def serve(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
            try:
                header = await reader.readuntil(b"\r\n\r\n")
                first = header.split(b"\r\n", 1)[0].decode("ascii")
                host_line = next((line for line in header.decode("latin1").split("\r\n") if line.lower().startswith("host:")), "")
                path = first.split(" ")[1]
                self.requests.append((path, host_line))
                if path == "/redirect":
                    writer.write(b"HTTP/1.1 302 Found\r\nLocation: /image\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                elif path == "/evil":
                    writer.write(
                        b"HTTP/1.1 302 Found\r\nLocation: http://evil.example/image\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    )
                else:
                    body = image_bytes()
                    writer.write(
                        b"HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: "
                        + str(len(body)).encode()
                        + b"\r\nConnection: close\r\n\r\n"
                        + body
                    )
                await writer.drain()
            finally:
                writer.close()
                await writer.wait_closed()

        self.server = await asyncio.start_server(serve, "127.0.0.1", 0)
        self.port = self.server.sockets[0].getsockname()[1]

        async def resolver(host: str, port: int) -> list[str]:
            self.resolutions.append((host, port))
            return ["127.0.0.1"]

        self.resolutions: list[tuple[str, int]] = []
        self.resolver = resolver

    async def asyncTearDown(self) -> None:
        self.server.close()
        await self.server.wait_closed()

    async def test_public_address_policy_blocks_private_dns_targets(self) -> None:
        downloader = SafeImageDownloader(resolver=self.resolver)
        with self.assertRaises(MediaPolicyError):
            await downloader.download(f"http://localhost:{self.port}/image", allowed_hosts=("localhost",))
        self.assertEqual(self.requests, [])

    async def test_redirect_revalidates_host_and_streams_content_hash(self) -> None:
        downloader = SafeImageDownloader(resolver=self.resolver)
        result = await downloader.download(f"http://localhost:{self.port}/redirect", allowed_hosts=("localhost",), allow_private=True)
        try:
            self.assertEqual(result.size, result.path.stat().st_size)
            self.assertEqual(hashlib.sha256(result.path.read_bytes()).hexdigest(), result.sha256)
            self.assertEqual([path for path, _ in self.requests], ["/redirect", "/image"])
            self.assertEqual(len(self.resolutions), 2)
            self.assertEqual(self.requests[0][1], f"Host: localhost:{self.port}")
        finally:
            result.path.unlink(missing_ok=True)

    async def test_redirect_to_unlisted_host_is_rejected_before_resolution(self) -> None:
        downloader = SafeImageDownloader(resolver=self.resolver)
        with self.assertRaises(MediaPolicyError):
            await downloader.download(f"http://localhost:{self.port}/evil", allowed_hosts=("localhost",), allow_private=True)
        self.assertEqual([path for path, _ in self.requests], ["/evil"])
        self.assertEqual(len(self.resolutions), 1)

    async def test_streaming_download_budget_is_enforced_and_temp_file_removed(self) -> None:
        downloader = SafeImageDownloader(
            limits=MediaResourceLimits(max_download_bytes=8),
            resolver=self.resolver,
        )
        before = set(Path(tempfile.gettempdir()).glob("imbrex-media-*.tmp"))
        with self.assertRaises(MediaBudgetError):
            await downloader.download(f"http://localhost:{self.port}/image", allowed_hosts=("localhost",), allow_private=True)
        after = set(Path(tempfile.gettempdir()).glob("imbrex-media-*.tmp"))
        self.assertEqual(after, before)

    async def test_temporary_download_budget_is_separate_from_download_budget(self) -> None:
        downloader = SafeImageDownloader(
            limits=MediaResourceLimits(max_download_bytes=1024 * 1024, max_temp_bytes=8),
            resolver=self.resolver,
        )
        with self.assertRaises(MediaBudgetError):
            await downloader.download(f"http://localhost:{self.port}/image", allowed_hosts=("localhost",), allow_private=True)

    async def test_cache_is_bounded_and_revalidates_dns_before_serving_hit(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            cache = ImageCache(directory, max_bytes=1024 * 1024, ttl_seconds=60)
            downloader = SafeImageDownloader(cache=cache, resolver=self.resolver)
            url = f"http://localhost:{self.port}/image"
            first = await downloader.download(url, allowed_hosts=("localhost",), allow_private=True)
            second = await downloader.download(url, allowed_hosts=("localhost",), allow_private=True)
            self.assertFalse(first.from_cache)
            self.assertFalse(first.ephemeral)
            self.assertTrue(second.from_cache)
            self.assertFalse(second.ephemeral)
            self.assertEqual(len(self.requests), 1)
            self.assertEqual(len(self.resolutions), 2)
            self.assertLessEqual(sum(path.stat().st_size for path in Path(directory).glob("*.bin")), cache.max_bytes)

    async def test_cache_lru_eviction_and_expiry(self) -> None:
        body_size = len(image_bytes())
        with tempfile.TemporaryDirectory() as directory:
            cache = ImageCache(directory, max_bytes=body_size + 4, ttl_seconds=60)
            downloader = SafeImageDownloader(cache=cache, resolver=self.resolver)
            first_url = f"http://localhost:{self.port}/one"
            second_url = f"http://localhost:{self.port}/two"
            first = await downloader.download(first_url, allowed_hosts=("localhost",), allow_private=True)
            await asyncio.sleep(0.01)
            second = await downloader.download(second_url, allowed_hosts=("localhost",), allow_private=True)
            self.assertFalse(first.path.exists())
            self.assertTrue(second.path.exists())
            self.assertEqual(len(list(Path(directory).glob("*.bin"))), 1)
            second.path.touch()
            os.utime(second.path, (0, 0))
            self.assertIsNone(await cache.get(second_url))
            self.assertFalse(second.path.exists())


if __name__ == "__main__":
    unittest.main()
