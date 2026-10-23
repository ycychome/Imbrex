from __future__ import annotations

from collections.abc import Mapping
from urllib.parse import urlsplit

from httpx2 import Request
from openai import AsyncOpenAI
from openai._models import FinalRequestOptions

from .config import ChatModelConfig


class ExtractionAsyncOpenAI(AsyncOpenAI):
    """Apply configured chat reasoning and output bounds at the request boundary.

    OpenAI's generated chat endpoint accepts ``reasoning_effort`` directly, but
    Graphiti 0.31.2 owns those calls and does not expose that option. The SDK's
    ``_build_request`` hook lets us add it as extra JSON without copying its
    retry, transport, or error-handling logic. Keep this at the SDK boundary.
    """

    def __init__(self, config: ChatModelConfig, *, timeout: int, max_output_tokens: int):
        self.reasoning_effort = config.reasoning_effort
        self.max_output_tokens = max_output_tokens
        super().__init__(
            base_url=config.base_url,
            api_key=config.secret(),
            timeout=timeout,
            max_retries=0,
        )

    def _build_request(self, options: FinalRequestOptions, *, retries_taken: int = 0) -> Request:
        path = urlsplit(options.url).path
        if options.method.lower() != "post" or not path.endswith("/chat/completions"):
            return super()._build_request(options, retries_taken=retries_taken)

        extra_json = dict(options.extra_json or {})
        if self.reasoning_effort is not None:
            extra_json.setdefault("reasoning_effort", self.reasoning_effort)

        body = options.json_data if isinstance(options.json_data, Mapping) else {}
        token_keys = {key for key in ("max_tokens", "max_completion_tokens") if key in body or key in extra_json}
        if not token_keys:
            token_keys.add("max_tokens")
        for key in token_keys:
            value = extra_json.get(key, body.get(key))
            capped = min(value, self.max_output_tokens) if isinstance(value, int) and not isinstance(value, bool) else self.max_output_tokens
            extra_json[key] = capped

        updated_options = options.model_copy(update={"extra_json": extra_json})
        return super()._build_request(updated_options, retries_taken=retries_taken)
