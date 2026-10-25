"""LiteLLM pre_call guardrail enforcing plan invariant 2 (ZDR on every model call).

Mounted next to litellm.yaml and loaded as `zdr_guard.ZdrGuard` with `default_on: true`, so it
runs for chat completions, embeddings and audio transcriptions. Refuses with HTTP 400:

- a `model` that does not start with `zdr/`;
- a `model` that is not in the allowlist: aliases whose every deployment carries
  extra_body.provider {zdr: true, data_collection: "deny", allow_fallbacks: false};
- any client-sent `extra_body` or routing field. A client `extra_body` replaces the configured
  one in LiteLLM 1.105.1 and would drop the provider block (see decision 0004, finding 2).

Decision record: docs/decisions/0004-litellm-openrouter-zdr.md.
"""

from fastapi import HTTPException
from litellm.integrations.custom_guardrail import CustomGuardrail

CLIENT_ROUTING_FIELDS = ("extra_body", "provider", "models", "route", "transforms")
ZDR_PREFIX = "zdr/"


def is_zdr_pinned(litellm_params: dict) -> bool:
    provider = (litellm_params.get("extra_body") or {}).get("provider") or {}
    return (
        provider.get("zdr") is True
        and provider.get("data_collection") == "deny"
        and provider.get("allow_fallbacks") is False
    )


def zdr_allowlist(model_list: list) -> set:
    """Aliases with the zdr/ prefix whose every deployment is ZDR-pinned."""
    names = {d["model_name"] for d in model_list}
    return {
        name
        for name in names
        if name.startswith(ZDR_PREFIX)
        and all(is_zdr_pinned(d["litellm_params"]) for d in model_list if d["model_name"] == name)
    }


def refuse(detail: str):
    raise HTTPException(status_code=400, detail=f"zdr_guard: {detail}")


class ZdrGuard(CustomGuardrail):
    async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):
        from litellm.proxy.proxy_server import llm_router

        sent = [f for f in CLIENT_ROUTING_FIELDS if f in data]
        if sent:
            refuse(f"client routing fields not allowed: {sent}")
        model = data.get("model")
        if not isinstance(model, str) or not model.startswith(ZDR_PREFIX):
            refuse(f"model must be a zdr/ alias, got {model!r}")
        if model not in zdr_allowlist(llm_router.model_list if llm_router else []):
            refuse(f"alias {model!r} is not a ZDR-pinned alias in litellm.yaml")
        return data
