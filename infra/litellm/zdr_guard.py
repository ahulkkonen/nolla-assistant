"""LiteLLM pre_call guardrail enforcing plan invariant 2 (ZDR by default on every model call).

Mounted next to litellm.yaml and loaded as `zdr_guard.ZdrGuard` with `default_on: true`, so it
runs for chat completions, embeddings and audio transcriptions. It allows:

- an exact `zdr/` alias whose every deployment carries
  extra_body.provider {zdr: true, data_collection: "deny", allow_fallbacks: false}, on any call type;
- `zdr/<vendor>/<model>` on chat completions, when every `zdr/*` deployment carries
  {zdr: true, data_collection: "deny"};
- `open/<vendor>/<model>` on chat completions, when OPENROUTER_OPEN_API_KEY is set and every
  `open/*` deployment carries {data_collection: "deny"} without `zdr: true`.

Only the `zdr/search` alias may carry a plugin, and only OpenRouter's web plugin in its
`extra_body` (phase-14); it serves chat completions only. Any other deployment with `plugins` is not
allowlisted.

Everything else gets HTTP 400. So does a request with a top-level key outside ALLOWED_KEYS (for
example `extra_body`, `provider`, `plugins` or `web_search_options`), and any tool that is not a
`function` tool (an `openrouter:*` server tool or a `web_search` type would let OpenRouter search).
A client `extra_body` replaces the configured one in LiteLLM 1.105.1 and would drop the provider
block (decision 0004, finding 2).

Decision records: docs/decisions/0004-litellm-openrouter-zdr.md, docs/decisions/phase-10-models.md,
docs/decisions/phase-14-search.md.
"""

import os
import re

from fastapi import HTTPException
from litellm.integrations.custom_guardrail import CustomGuardrail

# Top-level request keys the guard lets through (phase-14 review). Anything else is refused, so a
# new OpenRouter field (routing, plugins, server options) cannot pass by default.
CLIENT_KEYS = frozenset(
    {
        # Chat completions: OpenAI fields and what Pi 1.3.0 sends (pi-ai openai-completions.js).
        "model",
        "messages",
        "stream",
        "stream_options",
        "max_tokens",
        "max_completion_tokens",
        "temperature",
        "top_p",
        "tools",
        "tool_choice",
        "parallel_tool_calls",
        "reasoning",
        "reasoning_effort",
        "response_format",
        "stop",
        "seed",
        "user",
        "metadata",
        "n",
        "store",
        "prompt_cache_key",
        "prompt_cache_retention",
        # Embeddings.
        "input",
        "encoding_format",
        "dimensions",
        # Audio transcriptions (multipart form fields).
        "file",
        "language",
        "prompt",
        "timestamp_granularities",
    }
)
# Keys the LiteLLM 1.105.1 proxy adds before the guard runs: the first four on every chat,
# embedding and transcription call (measured); the rest on some paths (`litellm/proxy` source:
# a stream without `include_usage`, trace and session headers, an alias). `metadata` and `user`
# are also added and are in CLIENT_KEYS. None of them reaches OpenRouter as a routing field.
PROXY_KEYS = frozenset(
    {
        "litellm_call_id",
        "litellm_logging_obj",
        "proxy_server_request",
        "secret_fields",
        "_litellm_strip_stream_usage",
        "_litellm_client_requested_model",
        "litellm_trace_id",
        "litellm_session_id",
    }
)
ALLOWED_KEYS = CLIENT_KEYS | PROXY_KEYS
# The one alias with a plugin: OpenRouter's web plugin, fixed in its extra_body (phase-14).
SEARCH_ALIAS = "zdr/search"
ZDR_PREFIX = "zdr/"
OPEN_PREFIX = "open/"
WILDCARD_PREFIXES = (ZDR_PREFIX, OPEN_PREFIX)
# The proxy passes route_type as call_type: "acompletion" for /chat/completions in 1.105.1.
CHAT_CALL_TYPES = ("completion", "acompletion")
# Same shape as ModelId in packages/protocol: vendor/model, lowercase, no `~alias`, no `:variant`.
OPENROUTER_ID = re.compile(r"^[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*$")


def provider_block(litellm_params: dict) -> dict:
    return (litellm_params.get("extra_body") or {}).get("provider") or {}


def plugins_ok(name: str, litellm_params: dict) -> bool:
    """No plugin anywhere, except exactly the web plugin in the extra_body of zdr/search."""
    if "plugins" in litellm_params:
        return False
    plugins = (litellm_params.get("extra_body") or {}).get("plugins")
    if name != SEARCH_ALIAS:
        return plugins is None
    return (
        isinstance(plugins, list)
        and len(plugins) == 1
        and isinstance(plugins[0], dict)
        and plugins[0].get("id") == "web"
    )


def is_zdr_pinned(litellm_params: dict) -> bool:
    provider = provider_block(litellm_params)
    return (
        provider.get("zdr") is True
        and provider.get("data_collection") == "deny"
        and provider.get("allow_fallbacks") is False
    )


def zdr_allowlist(model_list: list) -> set:
    """Aliases with the zdr/ prefix whose every deployment is ZDR-pinned and has no stray plugin."""
    names = {d["model_name"] for d in model_list}
    return {
        name
        for name in names
        if name.startswith(ZDR_PREFIX)
        and all(
            is_zdr_pinned(d["litellm_params"]) and plugins_ok(name, d["litellm_params"])
            for d in model_list
            if d["model_name"] == name
        )
    }


def route_ok(prefix: str, litellm_params: dict) -> bool:
    """A wildcard route denies data collection and has no plugin; zdr/* also requires ZDR, open/* must not claim it."""
    provider = provider_block(litellm_params)
    if provider.get("data_collection") != "deny" or not plugins_ok(prefix + "*", litellm_params):
        return False
    return (provider.get("zdr") is True) == (prefix == ZDR_PREFIX)


def refuse(detail: str):
    raise HTTPException(status_code=400, detail=f"zdr_guard: {detail}")


class ZdrGuard(CustomGuardrail):
    async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):
        from litellm.proxy.proxy_server import llm_router

        unknown = sorted(k for k in data if k not in ALLOWED_KEYS)
        if unknown:
            refuse(f"request fields not allowed: {unknown}")
        tools = data.get("tools") or []
        if not isinstance(tools, list):
            tools = [tools]
        odd = [
            t.get("type") if isinstance(t, dict) else t
            for t in tools
            if not (isinstance(t, dict) and t.get("type") == "function")
        ]
        if odd:
            refuse(f"only function tools are allowed, got {odd}")
        model = data.get("model")
        if not isinstance(model, str):
            refuse(f"model must be a string, got {model!r}")
        model_list = llm_router.model_list if llm_router else []
        if model in zdr_allowlist(model_list):
            if model == SEARCH_ALIAS and call_type not in CHAT_CALL_TYPES:
                refuse(f"{SEARCH_ALIAS} is allowed on chat completions only, got {call_type!r}")
            return data
        # The router sends an exact model_name to its own deployment, never to a pattern route.
        if model in {d["model_name"] for d in model_list}:
            refuse(f"alias {model!r} is not a ZDR-pinned alias in litellm.yaml")

        prefix = next((p for p in WILDCARD_PREFIXES if model.startswith(p)), None)
        if prefix is None:
            refuse(f"model must be a zdr/ alias, zdr/<vendor>/<model> or open/<vendor>/<model>, got {model!r}")
        if not OPENROUTER_ID.match(model[len(prefix) :]):
            refuse(f"{model!r} is not a ZDR-pinned alias or {prefix}<vendor>/<model>")
        if call_type not in CHAT_CALL_TYPES:
            refuse(f"{prefix}<vendor>/<model> is allowed on chat completions only, got {call_type!r}")
        # LiteLLM falls back to OPENROUTER_API_KEY when a deployment key is empty: fail closed here.
        if prefix == OPEN_PREFIX and not os.environ.get("OPENROUTER_OPEN_API_KEY"):
            refuse("open/ models are off: OPENROUTER_OPEN_API_KEY is not set")
        pattern = [d for d in model_list if d["model_name"] == prefix + "*"]
        if not pattern or not all(route_ok(prefix, d["litellm_params"]) for d in pattern):
            refuse(f"route {prefix}* is missing in litellm.yaml or has the wrong provider block")
        return data
