FROM python:3.12.12-slim-bookworm@sha256:593bd06efe90efa80dc4eee3948be7c0fde4134606dd40d8dd8dbcade98e669c
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 UV_NO_PROGRESS=1 \
    PATH=/app/.venv/bin:$PATH PYTHONPATH=/app/src GRAPHITI_TELEMETRY_ENABLED=false
WORKDIR /app
RUN pip install --no-cache-dir uv==0.13.4 && groupadd -g 10001 memory && useradd -u 10001 -g memory memory \
    && mkdir /data && chown memory:memory /data
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY src ./src
USER 10001:10001
EXPOSE 8090
CMD ["uvicorn", "imbrex_memory.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8090", "--no-access-log"]
