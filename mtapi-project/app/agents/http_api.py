"""OpenAI-compatible HTTP chat backends (DeepSeek, OpenRouter, xAI, OpenAI, …)."""
from __future__ import annotations

import base64
import json
import mimetypes
import time
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .base import AgentResult, clamp_words, clean_prompt_text
from .secrets import ensure_secrets, get_secret

# Provider presets. vision=False means we will not send image bytes (text paths only / error on vision skills).
PROVIDERS: dict[str, dict[str, Any]] = {
    "deepseek": {
        "label": "DeepSeek API",
        "base_url": "https://api.deepseek.com/v1",
        "key_env": "DEEPSEEK_API_KEY",
        "default_model": "deepseek-chat",
        "vision": False,  # official chat API is text-only
    },
    "openrouter": {
        "label": "OpenRouter API",
        "base_url": "https://openrouter.ai/api/v1",
        "key_env": "OPENROUTER_API_KEY",
        "default_model": "openai/gpt-4o-mini",
        "vision": True,
    },
    "xai": {
        "label": "xAI Grok API",
        "base_url": "https://api.x.ai/v1",
        "key_env": "XAI_API_KEY",
        "default_model": "grok-2-vision-1212",
        "vision": True,
    },
    "openai": {
        "label": "OpenAI API",
        "base_url": "https://api.openai.com/v1",
        "key_env": "OPENAI_API_KEY",
        "default_model": "gpt-4o-mini",
        "vision": True,
    },
    "groq": {
        "label": "Groq API",
        "base_url": "https://api.groq.com/openai/v1",
        "key_env": "GROQ_API_KEY",
        "default_model": "llama-3.3-70b-versatile",
        "vision": False,
    },
}


def provider_ids() -> list[str]:
    return list(PROVIDERS.keys())


def provider_available(pid: str) -> bool:
    ensure_secrets()
    conf = PROVIDERS.get(pid)
    if not conf:
        return False
    return bool(get_secret(conf["key_env"]))


def list_api_backends() -> list[dict]:
    ensure_secrets()
    out = []
    for pid, conf in PROVIDERS.items():
        out.append({
            "id": pid,
            "label": conf["label"],
            "available": provider_available(pid),
            "vision": bool(conf.get("vision")),
            "default_model": conf["default_model"],
        })
    return out


def _image_data_url(path: Path) -> str:
    mime, _ = mimetypes.guess_type(str(path))
    if not mime or not mime.startswith("image/"):
        mime = "image/png"
    data = path.read_bytes()
    b64 = base64.standard_b64encode(data).decode("ascii")
    return f"data:{mime};base64,{b64}"


def _build_user_content(
    user: str,
    image_paths: list[Path],
    *,
    vision: bool,
) -> str | list[dict[str, Any]]:
    if not image_paths:
        return user
    if not vision:
        # Text-only API: list paths (model cannot see pixels)
        lines = [user, "", "Image paths (text only — this API cannot view pixels):"]
        for p in image_paths:
            lines.append(f"- {p}")
        return "\n".join(lines)

    content: list[dict[str, Any]] = [{"type": "text", "text": user}]
    for p in image_paths:
        content.append({
            "type": "image_url",
            "image_url": {"url": _image_data_url(p)},
        })
    return content


async def run_http_chat(
    provider_id: str,
    *,
    system: str,
    user: str,
    image_paths: list[Path] | None = None,
    model: str | None = None,
    timeout_s: float = 300.0,
    progress_cb: Callable[[str], None] | None = None,
    clamp_sd: bool = False,
    require_vision: bool = False,
) -> AgentResult:
    """Call OpenAI-compatible /chat/completions."""
    import asyncio

    ensure_secrets()
    pid = provider_id.lower().strip()
    conf = PROVIDERS.get(pid)
    if not conf:
        raise ValueError(f"Unknown API provider: {provider_id!r}")

    api_key = get_secret(conf["key_env"])
    if not api_key:
        path = " ~/.secrets" if (Path.home() / ".secrets").is_file() else ""
        raise RuntimeError(
            f"Missing {conf['key_env']} for {pid}. "
            f"Add `export {conf['key_env']}=…` to{path or ' environment'}."
        )

    images = list(image_paths or [])
    vision = bool(conf.get("vision"))
    if require_vision and images and not vision:
        raise RuntimeError(
            f"{conf['label']} is text-only (no vision API). "
            "For image→prompt use backend grok/agy/openrouter/xai/openai, "
            "or put a description in the message and use skill chat."
        )

    model_id = (model or conf["default_model"]).strip()
    base = conf["base_url"].rstrip("/")
    url = f"{base}/chat/completions"

    user_content = _build_user_content(user, images, vision=vision and bool(images))
    body = {
        "model": model_id,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user_content},
        ],
        "temperature": 0.4,
    }

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    # OpenRouter optional headers
    if pid == "openrouter":
        headers["HTTP-Referer"] = "http://localhost:24590"
        headers["X-Title"] = "ffTransmute-mtapi"

    if progress_cb:
        progress_cb(f"http {pid} / {model_id}…")

    def _post() -> tuple[str, int]:
        data = json.dumps(body).encode("utf-8")
        req = Request(url, data=data, headers=headers, method="POST")
        t0 = time.perf_counter()
        try:
            with urlopen(req, timeout=timeout_s) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
        except HTTPError as e:
            err_body = e.read().decode("utf-8", errors="replace")[:800]
            raise RuntimeError(f"{pid} HTTP {e.code}: {err_body}") from e
        except URLError as e:
            raise RuntimeError(f"{pid} request failed: {e}") from e
        ms = int((time.perf_counter() - t0) * 1000)
        return raw, ms

    raw_json, duration_ms = await asyncio.to_thread(_post)
    try:
        parsed = json.loads(raw_json)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"{pid} invalid JSON: {raw_json[:400]}") from e

    try:
        text = parsed["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as e:
        raise RuntimeError(f"{pid} unexpected response: {raw_json[:500]}") from e

    if isinstance(text, list):
        # some APIs return content parts
        text = " ".join(
            part.get("text", "") if isinstance(part, dict) else str(part)
            for part in text
        )

    text = clean_prompt_text(str(text or ""))
    if not text:
        raise RuntimeError(f"{pid} returned empty content")
    if clamp_sd:
        text = clamp_words(text, 50)

    return AgentResult(
        text=text,
        agent=pid,
        cli="http",
        model=model_id,
        duration_ms=duration_ms,
        raw=raw_json[:2000],
        command=["http", "POST", url, model_id],
    )
