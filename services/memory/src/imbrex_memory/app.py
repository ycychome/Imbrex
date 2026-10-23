from __future__ import annotations

import asyncio
import hmac
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, Header, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from .config import ServiceConfig, load_config
from .engine import Engine
from .graph import GraphitiIndex, ModelExtractor
from .models import MemoryError, OperationRequest, QueryRequest
from .store import Store


def create_app(config: ServiceConfig | None = None, engine: Engine | None = None) -> FastAPI:
    settings = config or load_config()
    token = settings.token()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        os.umask(0o077)
        current = engine or Engine(
            settings, Store(Path(settings.data_dir) / "memory.sqlite3"), GraphitiIndex(settings), ModelExtractor(settings)
        )
        if settings.vision and engine is None:
            from .vision import Vision

            current.visual = Vision(settings, current.store)
        app.state.engine = current
        current.start()
        try:
            yield
        finally:
            await current.close()

    app = FastAPI(title="Imbrex private Memory service", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)

    async def authorized(authorization: str | None = Header(default=None)) -> None:
        if authorization is None or not hmac.compare_digest(authorization, "Bearer " + token):
            raise MemoryError("forbidden", 403)

    @app.middleware("http")
    async def request_budget(request: Request, call_next):  # type: ignore[no-untyped-def]
        # Enforce the actual stream size as well as Content-Length. Do not log request bodies.
        if not hmac.compare_digest(request.headers.get("authorization", "").encode(), ("Bearer " + token).encode()):
            return JSONResponse({"error": {"code": "forbidden", "message": "Memory API authentication required."}}, status_code=403)
        size = 0
        chunks = []
        try:
            async with asyncio.timeout(10):
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > 2 * 1024 * 1024:
                        return JSONResponse(
                            {"error": {"code": "request_too_large", "message": "Memory request exceeds resource budget."}}, status_code=413
                        )
                    chunks.append(chunk)
        except TimeoutError:
            return JSONResponse({"error": {"code": "request_timeout", "message": "Memory request body timed out."}}, status_code=408)
        request._body = b"".join(chunks)
        return await call_next(request)

    @app.exception_handler(MemoryError)
    async def memory_error(_request: Request, error: MemoryError) -> JSONResponse:
        return JSONResponse({"error": {"code": error.code, "message": "Memory request could not be completed."}}, status_code=error.status)

    @app.exception_handler(RequestValidationError)
    async def invalid(_request: Request, _error: RequestValidationError) -> JSONResponse:
        return JSONResponse({"error": {"code": "invalid_params", "message": "Invalid Memory request."}}, status_code=409)

    @app.exception_handler(Exception)
    async def internal(_request: Request, _error: Exception) -> JSONResponse:
        # Exception details may contain endpoint credentials. No raw provider errors are returned.
        return JSONResponse({"error": {"code": "service_unavailable", "message": "Memory service unavailable."}}, status_code=503)

    @app.get("/health", dependencies=[Depends(authorized)])
    async def health(request: Request) -> dict[str, object]:
        return {"ready": request.app.state.engine.ready, "ledger_id": request.app.state.engine.store.ledger_id}

    @app.post("/v1/operations", dependencies=[Depends(authorized)])
    async def operation(body: OperationRequest, request: Request) -> dict[str, object]:
        return request.app.state.engine.accept(body)  # type: ignore[no-any-return]

    @app.post("/v1/query", dependencies=[Depends(authorized)])
    async def query(body: QueryRequest, request: Request) -> dict[str, object]:
        return await request.app.state.engine.query(body)  # type: ignore[no-any-return]

    return app
