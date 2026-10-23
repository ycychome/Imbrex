"""Bounded image acquisition and model-specific image preparation.

The module never follows redirects automatically. Every hop is parsed, checked
against the configured host allowlist, resolved, IP-classified, and pinned to
one of those checked addresses before the request is sent.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import ipaddress
import json
import math
import os
import socket
import tempfile
import time
from collections.abc import Awaitable, Callable, Iterable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal
from urllib.parse import urljoin, urlsplit, urlunsplit

import httpx
from PIL import Image, ImageOps, UnidentifiedImageError

# Explicit decode/pixel/temp budgets replace Pillow's global fixed pixel cutoff.
# Supported formats are checked from headers before loading their pixel buffers.
Image.MAX_IMAGE_PIXELS = None

SUPPORTED_FORMATS = frozenset({"jpeg", "png", "webp"})
_FORMAT_ALIASES = {"jpg": "jpeg", "image/jpeg": "jpeg", "image/jpg": "jpeg", "image/png": "png", "image/webp": "webp"}
_DECODE_FORMATS = frozenset({"JPEG", "PNG", "WEBP", "GIF"})
_MAX_REDIRECTS = 5


class MediaError(Exception):
    """Base error safe to return to callers; messages never include URLs."""


class MediaPolicyError(MediaError):
    pass


class MediaBudgetError(MediaError):
    pass


class MediaDecodeError(MediaError):
    pass


@dataclass(frozen=True, slots=True)
class ModelImageProfile:
    """Explicit model image limits; values must come from configured metadata."""

    model: str
    formats: tuple[str, ...]
    max_input_bytes: int
    max_width: int
    max_height: int
    max_pixels: int
    max_images: int
    context_tokens: int
    prompt_tokens: int
    output_tokens: int
    image_tokens_per_tile: int

    def __post_init__(self) -> None:
        if not isinstance(self.model, str) or not self.model.strip():
            raise ValueError("model must be explicit")
        normalized = tuple(dict.fromkeys(_FORMAT_ALIASES.get(str(fmt).lower(), str(fmt).lower()) for fmt in self.formats))
        if not normalized or any(fmt not in SUPPORTED_FORMATS for fmt in normalized):
            raise ValueError("formats must contain supported formats: jpeg, png, webp")
        object.__setattr__(self, "formats", normalized)
        values = (
            self.max_input_bytes,
            self.max_width,
            self.max_height,
            self.max_pixels,
            self.max_images,
            self.context_tokens,
            self.prompt_tokens,
            self.output_tokens,
            self.image_tokens_per_tile,
        )
        if any(not isinstance(v, int) or isinstance(v, bool) or v <= 0 for v in values):
            raise ValueError("image profile limits must be positive integers")
        if self.prompt_tokens + self.output_tokens > self.context_tokens:
            raise ValueError("prompt and output token budgets exceed context_tokens")

    @property
    def image_token_budget(self) -> int:
        return self.context_tokens - self.prompt_tokens - self.output_tokens


@dataclass(frozen=True, slots=True)
class MediaResourceLimits:
    """Independent service-side budgets, separate from a model's capabilities."""

    max_download_bytes: int = 64 * 1024 * 1024
    max_decode_bytes: int = 64 * 1024 * 1024
    max_decode_pixels: int = 100_000_000
    max_temp_bytes: int = 256 * 1024 * 1024
    max_request_bytes: int = 32 * 1024 * 1024
    cache_bytes: int = 512 * 1024 * 1024
    cache_ttl_seconds: int = 7 * 24 * 60 * 60

    def __post_init__(self) -> None:
        if any(
            not isinstance(v, int) or isinstance(v, bool) or v <= 0
            for v in (
                self.max_download_bytes,
                self.max_decode_bytes,
                self.max_decode_pixels,
                self.max_temp_bytes,
                self.max_request_bytes,
                self.cache_bytes,
                self.cache_ttl_seconds,
            )
        ):
            raise ValueError("resource limits must be positive integers")


@dataclass(frozen=True, slots=True)
class ImageTile:
    original_sha256: str
    mime_type: str
    format: str
    width: int
    height: int
    coordinates: tuple[int, int, int, int]
    tile_index: int
    tile_count: int
    partial: bool
    data: bytes = field(repr=False)

    @property
    def base64_data(self) -> str:
        return base64.b64encode(self.data).decode("ascii")

    def payload(self) -> dict[str, str]:
        return {"mime_type": self.mime_type, "data": self.base64_data}


@dataclass(frozen=True, slots=True)
class ImageBatch:
    images: tuple[ImageTile, ...]
    body: bytes = field(repr=False)
    image_tokens: int


@dataclass(frozen=True, slots=True)
class DownloadedImage:
    path: Path = field(repr=False)
    sha256: str
    size: int
    from_cache: bool
    ephemeral: bool


Resolver = Callable[[str, int], Awaitable[Sequence[str | ipaddress.IPv4Address | ipaddress.IPv6Address]]]
BodyFactory = Callable[[str, Sequence[ImageTile]], bytes]


async def _resolve(host: str, port: int) -> Sequence[str]:
    loop = asyncio.get_running_loop()
    infos = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    addresses = (info[4][0] for info in infos)
    return tuple(dict.fromkeys(address.split("%", 1)[0] for address in addresses if isinstance(address, str)))


def _host_key(host: str) -> str:
    host = host.rstrip(".").encode("idna").decode("ascii").lower()
    try:
        return ipaddress.ip_address(host.strip("[]")).compressed
    except ValueError:
        return host


def _checked_url(value: str, allowed_hosts: frozenset[str]) -> tuple[str, str, int, str]:
    try:
        parsed = urlsplit(value)
        host = parsed.hostname
        port = parsed.port
    except (ValueError, UnicodeError):
        raise MediaPolicyError("invalid image URL") from None
    if (
        parsed.scheme.lower() not in {"http", "https"}
        or not host
        or "%" in host
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
    ):
        raise MediaPolicyError("image URL is not permitted")
    canonical_host = _host_key(host)
    if canonical_host not in allowed_hosts:
        raise MediaPolicyError("image host is not allowed")
    effective_port = port or (443 if parsed.scheme.lower() == "https" else 80)
    if not 1 <= effective_port <= 65535:
        raise MediaPolicyError("invalid image URL port")
    path = urlunsplit(("", "", parsed.path or "/", parsed.query, ""))
    return parsed.scheme.lower(), canonical_host, effective_port, path


class ImageCache:
    """Private disk cache: URL and content identities are stored only as hashes."""

    def __init__(self, root: str | Path, *, max_bytes: int = 512 * 1024 * 1024, ttl_seconds: int = 7 * 24 * 60 * 60) -> None:
        if max_bytes <= 0 or ttl_seconds <= 0:
            raise ValueError("cache limits must be positive")
        self.root = Path(root)
        self.max_bytes = max_bytes
        self.ttl_seconds = ttl_seconds
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            self.root.chmod(0o700)
        except OSError:
            pass
        self._lock = asyncio.Lock()

    def _paths(self, url: str) -> tuple[Path, Path]:
        key = hashlib.sha256(url.encode("utf-8")).hexdigest()
        return self.root / (key + ".bin"), self.root / (key + ".json")

    @staticmethod
    def processed_key(original_sha256: str, profile: ModelImageProfile, params: dict[str, object]) -> str:
        """Stable key for transformed tiles; includes all profile and transform inputs."""
        material = {
            "version": 1,
            "original_sha256": original_sha256,
            "model": profile.model,
            "profile": {
                "formats": profile.formats,
                "max_input_bytes": profile.max_input_bytes,
                "max_width": profile.max_width,
                "max_height": profile.max_height,
                "max_pixels": profile.max_pixels,
                "max_images": profile.max_images,
                "context_tokens": profile.context_tokens,
                "prompt_tokens": profile.prompt_tokens,
                "output_tokens": profile.output_tokens,
                "image_tokens_per_tile": profile.image_tokens_per_tile,
            },
            "params": params,
        }
        encoded = json.dumps(material, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()

    async def get(self, url: str) -> DownloadedImage | None:
        data_path, meta_path = self._paths(url)
        async with self._lock:
            try:
                meta = json.loads(meta_path.read_text("utf-8"))
                stat = data_path.stat()
                if time.time() - stat.st_mtime > self.ttl_seconds or stat.st_size != meta["size"]:
                    raise ValueError("stale cache")
                digest = str(meta["sha256"])
                os.utime(data_path, None)
                return DownloadedImage(data_path, digest, stat.st_size, True, False)
            except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
                data_path.unlink(missing_ok=True)
                meta_path.unlink(missing_ok=True)
                return None

    async def sweep(self) -> None:
        async with self._lock:
            await self._evict_locked()

    async def store(self, url: str, temp_path: Path, digest: str, size: int) -> DownloadedImage:
        data_path, meta_path = self._paths(url)
        async with self._lock:
            if size <= self.max_bytes:
                os.replace(temp_path, data_path)
                meta_tmp = meta_path.with_suffix(".json.tmp")
                meta_tmp.write_text(json.dumps({"sha256": digest, "size": size}, separators=(",", ":")), "utf-8")
                os.chmod(meta_tmp, 0o600)
                os.replace(meta_tmp, meta_path)
                os.utime(data_path, None)
                await self._evict_locked(exclude=data_path)
                return DownloadedImage(data_path, digest, size, False, False)
            return DownloadedImage(temp_path, digest, size, False, True)

    async def _evict_locked(self, *, exclude: Path | None = None) -> None:
        now = time.time()
        entries: list[tuple[float, Path, int]] = []
        total = 0
        for path in self.root.glob("*.bin"):
            try:
                stat = path.stat()
            except OSError:
                continue
            if now - stat.st_mtime > self.ttl_seconds:
                path.unlink(missing_ok=True)
                path.with_suffix(".json").unlink(missing_ok=True)
                continue
            entries.append((stat.st_mtime, path, stat.st_size))
            total += stat.st_size
        for _, path, size in sorted(entries):
            if total <= self.max_bytes:
                break
            if path == exclude:
                continue
            path.unlink(missing_ok=True)
            path.with_suffix(".json").unlink(missing_ok=True)
            total -= size


class SafeImageDownloader:
    """Streaming HTTP downloader with per-hop DNS validation and IP pinning."""

    def __init__(
        self,
        *,
        limits: MediaResourceLimits | None = None,
        cache: ImageCache | None = None,
        resolver: Resolver = _resolve,
        timeout_seconds: float = 15.0,
    ) -> None:
        self.limits = limits or MediaResourceLimits()
        self.cache = cache
        self.resolver = resolver
        self.timeout_seconds = timeout_seconds

    async def download(self, url: str, *, allowed_hosts: Iterable[str], allow_private: bool = False) -> DownloadedImage:
        allow = frozenset(_host_key(host) for host in allowed_hosts)
        if not allow:
            raise MediaPolicyError("image host allowlist is required")
        _checked_url(url, allow)
        current = url
        for hop in range(_MAX_REDIRECTS + 1):
            scheme, host, port, path = _checked_url(current, allow)
            addresses = await self.resolver(host, port)
            if not addresses:
                raise MediaPolicyError("image host has no usable address")
            checked: list[ipaddress.IPv4Address | ipaddress.IPv6Address] = []
            for address in addresses:
                try:
                    ip = ipaddress.ip_address(str(address).split("%", 1)[0])
                except ValueError:
                    raise MediaPolicyError("image host resolved to an invalid address") from None
                if not allow_private and not ip.is_global:
                    raise MediaPolicyError("image host resolved to a non-public address")
                checked.append(ip)
            cached = await self.cache.get(current) if self.cache else None
            if cached:
                if cached.size > self.limits.max_download_bytes:
                    raise MediaBudgetError("image download exceeds resource budget")
                return cached
            connect_ip = checked[0].compressed
            authority = f"[{host}]" if ":" in host else host
            if port != (443 if scheme == "https" else 80):
                authority = f"{authority}:{port}"
            pin_host = f"[{connect_ip}]" if ":" in connect_ip else connect_ip
            pinned_url = f"{scheme}://{pin_host}:{port}{path}"
            headers = {"Host": authority, "Accept": "image/*", "Accept-Encoding": "identity"}
            transport = httpx.AsyncHTTPTransport(retries=0, verify=True, trust_env=False)
            async with httpx.AsyncClient(
                transport=transport, timeout=self.timeout_seconds, follow_redirects=False, trust_env=False
            ) as client:
                request = client.build_request("GET", pinned_url, headers=headers)
                if scheme == "https":
                    request.extensions["sni_hostname"] = host.encode("ascii")
                try:
                    response = await client.send(request, stream=True)
                    if response.status_code in {301, 302, 303, 307, 308}:
                        location = response.headers.get("location")
                        await response.aclose()
                        if not location or hop >= _MAX_REDIRECTS:
                            raise MediaPolicyError("image redirect limit exceeded")
                        current = urljoin(current, location)
                        continue
                    if response.status_code != 200:
                        await response.aclose()
                        raise MediaError(f"image server returned HTTP {response.status_code}")
                    length = response.headers.get("content-length")
                    if length is not None and (not length.isdecimal() or int(length) > self.limits.max_download_bytes):
                        await response.aclose()
                        raise MediaBudgetError("image download exceeds resource budget")
                    fd, name = tempfile.mkstemp(prefix="imbrex-media-", suffix=".tmp")
                    temp_path = Path(name)
                    os.chmod(temp_path, 0o600)
                    digest = hashlib.sha256()
                    size = 0
                    try:
                        with os.fdopen(fd, "wb") as output:
                            async for chunk in response.aiter_bytes():
                                size += len(chunk)
                                if size > self.limits.max_download_bytes:
                                    raise MediaBudgetError("image download exceeds resource budget")
                                if size > self.limits.max_temp_bytes:
                                    raise MediaBudgetError("image download exceeds temporary storage budget")
                                digest.update(chunk)
                                output.write(chunk)
                        await response.aclose()
                        result = DownloadedImage(temp_path, digest.hexdigest(), size, False, True)
                        if self.cache:
                            result = await self.cache.store(current, temp_path, result.sha256, size)
                        return result
                    except BaseException:
                        await response.aclose()
                        temp_path.unlink(missing_ok=True)
                        raise
                except (httpx.HTTPError, OSError):
                    raise MediaError("image download failed") from None
        raise MediaPolicyError("image redirect limit exceeded")


def _output_format(image: Image.Image, allowed: Sequence[str], source_format: str) -> str:
    original_format = {"JPEG": "jpeg", "PNG": "png", "WEBP": "webp"}.get(source_format)
    if original_format is not None and original_format in allowed and not (original_format == "jpeg" and image.mode in {"RGBA", "LA"}):
        return original_format
    if image.mode in {"RGBA", "LA"} or "transparency" in image.info:
        for fmt in ("png", "webp"):
            if fmt in allowed:
                return fmt
    for fmt in ("jpeg", "png", "webp"):
        if fmt in allowed:
            return fmt
    raise MediaPolicyError("model has no usable image format")


def _tile_boxes(width: int, height: int, max_width: int, max_height: int, max_pixels: int) -> list[tuple[int, int, int, int]]:
    tile_w = max(1, min(width, max_width))
    tile_h = max(1, min(height, max_height))
    if tile_w * tile_h > max_pixels:
        scale = math.sqrt(max_pixels / (tile_w * tile_h))
        tile_w = max(1, int(tile_w * scale))
        tile_h = max(1, int(tile_h * scale))
    if width <= tile_w and height <= tile_h:
        return [(0, 0, width, height)]
    overlap_x = max(1, int(tile_w * 0.1))
    overlap_y = max(1, int(tile_h * 0.1))
    step_x, step_y = max(1, tile_w - overlap_x), max(1, tile_h - overlap_y)

    def starts(length: int, tile: int, step: int) -> list[int]:
        result = [0]
        while result[-1] + tile < length:
            following = result[-1] + step
            if following >= length:
                break
            result.append(following)
        return result

    xs = starts(width, tile_w, step_x)
    ys = starts(height, tile_h, step_y)
    return [(x, y, min(width, x + tile_w), min(height, y + tile_h)) for y in ys for x in xs]


def _encode(image: Image.Image, fmt: str, byte_limit: int, *, min_scale: float) -> tuple[bytes, Image.Image] | None:
    current = image
    owns_current = False
    original_size = image.size
    while True:
        qualities: Sequence[int] = (95, 90, 85, 80, 74, 68, 60, 52) if fmt in {"jpeg", "webp"} else ()
        attempts: Sequence[int | None] = qualities or (None,)
        last_size = 0
        for quality in attempts:
            output = io.BytesIO()
            candidate = current
            owns_candidate = False
            if fmt == "jpeg" and candidate.mode not in {"RGB", "L"}:
                background = Image.new("RGB", candidate.size, "white")
                if candidate.mode in {"RGBA", "LA"}:
                    alpha = candidate.getchannel("A")
                    converted = candidate.convert("RGB")
                    background.paste(converted, mask=alpha)
                    converted.close()
                    alpha.close()
                else:
                    converted = candidate.convert("RGB")
                    background.paste(converted)
                    converted.close()
                candidate = background
                owns_candidate = True
            options: dict[str, object] = {}
            if fmt == "jpeg":
                options.update(quality=quality, optimize=True, progressive=True, subsampling=0)
            elif fmt == "png":
                options.update(optimize=True, compress_level=9)
            elif fmt == "webp":
                options.update(quality=quality, method=6, lossless=quality == 95)
            try:
                candidate.save(output, format={"jpeg": "JPEG", "png": "PNG", "webp": "WEBP"}[fmt], **options)
            except (OSError, ValueError):
                if owns_candidate:
                    candidate.close()
                continue
            data = output.getvalue()
            last_size = len(data)
            if len(data) <= byte_limit:
                if owns_current and candidate is not current:
                    current.close()
                return data, candidate
            if owns_candidate:
                candidate.close()
        if current.width <= 32 or current.height <= 32:
            break
        scale = max(0.5, min(0.9, math.sqrt(byte_limit / max(1, last_size)))) if last_size else 0.75
        scale = max(scale, min_scale)
        next_size = (max(32, int(current.width * scale)), max(32, int(current.height * scale)))
        if next_size == current.size:
            next_size = (max(32, int(current.width * 0.75)), max(32, int(current.height * 0.75)))
        if next_size[0] / original_size[0] < min_scale or next_size[1] / original_size[1] < min_scale:
            break
        resized = current.resize(next_size, Image.Resampling.LANCZOS)
        if owns_current:
            current.close()
        current = resized
        owns_current = True
    if owns_current:
        current.close()
    return None


class ImagePreprocessor:
    def __init__(self, profile: ModelImageProfile, *, limits: MediaResourceLimits | None = None) -> None:
        self.profile = profile
        self.limits = limits or MediaResourceLimits()

    def prepare(
        self,
        original: bytes,
        *,
        prompt: str,
        mode: Literal["ocr", "preview"] = "ocr",
        body_factory: BodyFactory | None = None,
    ) -> tuple[ImageBatch, ...]:
        if mode not in {"ocr", "preview"}:
            raise ValueError("mode must be ocr or preview")
        if len(original) > self.limits.max_decode_bytes:
            raise MediaBudgetError("image exceeds decode byte budget")
        original_hash = hashlib.sha256(original).hexdigest()
        try:
            with Image.open(io.BytesIO(original)) as source:
                fmt = (source.format or "").upper()
                if fmt not in _DECODE_FORMATS:
                    raise MediaDecodeError("unsupported image format")
                if source.width * source.height > self.limits.max_decode_pixels:
                    raise MediaBudgetError("image exceeds decode pixel budget")
                if source.width * source.height * 4 > self.limits.max_temp_bytes:
                    raise MediaBudgetError("decoded image exceeds temporary storage budget")
                source.seek(0)  # GIFs use their first frame only.
                oriented = ImageOps.exif_transpose(source.copy())
                oriented.load()
        except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as exc:
            raise MediaDecodeError("image could not be decoded") from exc
        fmt = _output_format(oriented, self.profile.formats, fmt)
        if mode == "preview":
            factor = min(
                1.0,
                self.profile.max_width / oriented.width,
                self.profile.max_height / oriented.height,
                (self.profile.max_pixels / (oriented.width * oriented.height)) ** 0.5,
            )
            if factor < 1:
                resized = oriented.resize(
                    (max(1, int(oriented.width * factor)), max(1, int(oriented.height * factor))), Image.Resampling.LANCZOS
                )
                oriented.close()
                oriented = resized
        factory = body_factory or self._body
        request_limit = min(self.profile.max_input_bytes, self.limits.max_request_bytes)
        empty_body = factory(prompt, ())
        probe = ImageTile(
            original_hash,
            {"jpeg": "image/jpeg", "png": "image/png", "webp": "image/webp"}[fmt],
            fmt,
            1,
            1,
            (0, 0, 1, 1),
            0,
            1,
            False,
            b"\x00",
        )
        one_body = factory(prompt, (probe,))
        per_tile_overhead = len(one_body) - len(empty_body) - len(probe.base64_data)
        raw_byte_limit = ((request_limit - len(empty_body) - per_tile_overhead) // 4) * 3
        if raw_byte_limit <= 0:
            raise MediaBudgetError("prompt exceeds image request budget")

        boxes = _tile_boxes(oriented.width, oriented.height, self.profile.max_width, self.profile.max_height, self.profile.max_pixels)
        fitted: list[tuple[tuple[int, int, int, int], bytes, int, int]] = []
        encoded_total = 0

        def fit_box(box: tuple[int, int, int, int], depth: int = 0) -> None:
            nonlocal encoded_total
            crop = oriented.crop(box)
            min_scale = 0.8 if mode == "ocr" else 0.25
            encoded = _encode(crop, fmt, raw_byte_limit, min_scale=min_scale)
            if encoded is not None:
                data, rendered = encoded
                encoded_total += len(data)
                if oriented.width * oriented.height * 4 + encoded_total > self.limits.max_temp_bytes:
                    crop.close()
                    rendered.close()
                    raise MediaBudgetError("prepared images exceed temporary storage budget")
                fitted.append((box, data, rendered.width, rendered.height))
                crop.close()
                rendered.close()
                return
            crop.close()
            if depth >= 16:
                raise MediaBudgetError("image detail cannot fit model request budget")
            left, top, right, bottom = box
            width, height = right - left, bottom - top
            if max(width, height) < 64:
                raise MediaBudgetError("image detail cannot fit model request budget")
            if width >= height and width >= 64:
                midpoint = left + width // 2
                overlap = max(1, int(width * 0.1))
                fit_box((left, top, min(right, midpoint + overlap // 2), bottom), depth + 1)
                fit_box((max(left, midpoint - overlap // 2), top, right, bottom), depth + 1)
            else:
                midpoint = top + height // 2
                overlap = max(1, int(height * 0.1))
                fit_box((left, top, right, min(bottom, midpoint + overlap // 2)), depth + 1)
                fit_box((left, max(top, midpoint - overlap // 2), right, bottom), depth + 1)

        try:
            for box in boxes:
                fit_box(box)
        finally:
            oriented.close()

        tile_count = len(fitted)
        tiles = [
            ImageTile(
                original_sha256=original_hash,
                mime_type={"jpeg": "image/jpeg", "png": "image/png", "webp": "image/webp"}[fmt],
                format=fmt,
                width=width,
                height=height,
                coordinates=box,
                tile_index=index,
                tile_count=tile_count,
                partial=tile_count > 1,
                data=data,
            )
            for index, (box, data, width, height) in enumerate(fitted)
        ]
        return self._batch(tiles, prompt, factory, request_limit)

    def _batch(self, tiles: Sequence[ImageTile], prompt: str, body_factory: BodyFactory, request_limit: int) -> tuple[ImageBatch, ...]:
        image_budget = self.profile.image_token_budget
        max_by_tokens = image_budget // self.profile.image_tokens_per_tile
        per_batch = min(self.profile.max_images, max_by_tokens)
        if per_batch < 1:
            raise MediaBudgetError("model token budget cannot fit one image tile")
        batches: list[ImageBatch] = []
        current: list[ImageTile] = []
        for tile in tiles:
            candidate = current + [tile]
            try:
                body = body_factory(prompt, candidate)
            except MediaBudgetError:
                if not current:
                    raise
                batches.append(ImageBatch(tuple(current), body_factory(prompt, current), len(current) * self.profile.image_tokens_per_tile))
                current = [tile]
                body_factory(prompt, current)  # A single tile must fit the text reservation.
                continue
            if len(candidate) > per_batch or len(body) > request_limit:
                if not current:
                    raise MediaBudgetError("one image tile exceeds request budget")
                old_body = body_factory(prompt, current)
                batches.append(ImageBatch(tuple(current), old_body, len(current) * self.profile.image_tokens_per_tile))
                current = [tile]
                body = body_factory(prompt, current)
                if len(body) > request_limit:
                    raise MediaBudgetError("one image tile exceeds request budget")
            else:
                current = candidate
        if current:
            body = body_factory(prompt, current)
            batches.append(ImageBatch(tuple(current), body, len(current) * self.profile.image_tokens_per_tile))
        return tuple(batches)

    @staticmethod
    def _body(prompt: str, images: Sequence[ImageTile]) -> bytes:
        return json.dumps(
            {"prompt": prompt, "images": [tile.payload() for tile in images]}, ensure_ascii=False, separators=(",", ":")
        ).encode("utf-8")


def reading_order_key(item: ImageTile, *, event_position: int = 0, image_position: int = 0) -> tuple[int, int, int]:
    """Stable tool key: event, original image, then row-major tile order."""
    return (event_position, image_position, item.tile_index)


def deduplicate_reading_order(items: Iterable[tuple[int, int, ImageTile]]) -> tuple[tuple[int, int, ImageTile], ...]:
    """Keep every tile of the first occurrence of each image, in row-major order."""
    first_occurrence: dict[str, tuple[int, int]] = {}
    kept: list[tuple[int, int, ImageTile]] = []
    ordered = sorted(items, key=lambda item: reading_order_key(item[2], event_position=item[0], image_position=item[1]))
    for event_position, image_position, tile in ordered:
        first_occurrence.setdefault(tile.original_sha256, (event_position, image_position))
        if first_occurrence[tile.original_sha256] == (event_position, image_position):
            kept.append((event_position, image_position, tile))
    return tuple(kept)


def deduplicate_overlapping_ocr(readings: Iterable[tuple[ImageTile, str]]) -> str:
    """Merge OCR tiles in reading order, dropping exact duplicate lines from overlaps."""
    ordered_input = list(readings)
    group_order = {tile.original_sha256: index for index, (tile, _) in enumerate(ordered_input)}
    ordered = sorted(ordered_input, key=lambda entry: (group_order[entry[0].original_sha256], entry[0].tile_index))
    prior: dict[str, list[tuple[tuple[int, int, int, int], set[str]]]] = {}
    output: list[str] = []
    for tile, text in ordered:
        lines = text.splitlines()
        own_lines = {" ".join(line.split()).casefold() for line in lines if line.strip()}
        left, top, right, bottom = tile.coordinates
        overlapping_lines: set[str] = set()
        for previous_box, previous_lines in prior.get(tile.original_sha256, []):
            px1, py1, px2, py2 = previous_box
            if max(left, px1) < min(right, px2) and max(top, py1) < min(bottom, py2):
                overlapping_lines.update(previous_lines)
        output.extend(line for line in lines if not line.strip() or " ".join(line.split()).casefold() not in overlapping_lines)
        prior.setdefault(tile.original_sha256, []).append((tile.coordinates, own_lines))
    return "\n".join(output)
