"""Agent protocol, cleaning, async CLI runner."""
from __future__ import annotations

import asyncio
import re
import shutil
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable


@dataclass
class AgentResult:
    text: str
    agent: str
    cli: str
    model: str | None
    duration_ms: int
    raw: str
    command: list[str]


_FENCE_RE = re.compile(r"^```(?:\w+)?\s*\n(.*?)\n```\s*$", re.DOTALL | re.MULTILINE)


def clean_prompt_text(raw: str) -> str:
    text = (raw or "").strip()
    for prefix in (
        "sure,",
        "sure!",
        "here is",
        "here's",
        "the prompt:",
        "prompt:",
        "final prompt:",
        "positive prompt:",
    ):
        low = text.lower()
        if low.startswith(prefix):
            text = text[len(prefix) :].lstrip(" \n:")
    m = _FENCE_RE.match(text)
    if m:
        text = m.group(1).strip()
    if "```" in text:
        parts = re.findall(r"```(?:\w+)?\s*\n(.*?)```", text, flags=re.DOTALL)
        if parts:
            text = max(parts, key=len).strip()
    # Prefer first non-empty line if multi-paragraph essay
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    if len(lines) > 1 and not any("," in ln for ln in lines[:1]):
        # if first line is short title-like, join first 2–3 phrase lines
        text = " ".join(lines)
    text = re.sub(r"\n{2,}", "\n", text).strip()
    if (text.startswith('"') and text.endswith('"')) or (
        text.startswith("'") and text.endswith("'")
    ):
        text = text[1:-1].strip()
    # Collapse whitespace for SD prompts
    text = " ".join(text.split())
    return text


def clamp_words(text: str, max_words: int = 50) -> str:
    words = text.split()
    if len(words) <= max_words:
        return text
    return " ".join(words[:max_words])


def which(binary: str) -> str | None:
    return shutil.which(binary)


def resolve_images(paths: list[str] | None) -> list[Path]:
    out: list[Path] = []
    for p in paths or []:
        if not p or not str(p).strip():
            continue
        path = Path(p).expanduser().resolve()
        if not path.is_file():
            raise FileNotFoundError(f"Image not found: {path}")
        out.append(path)
    return out


def format_cli_blob(
    *,
    system: str,
    user: str,
    image_paths: list[Path],
) -> str:
    parts = [system.strip(), "", "User message:", user.strip()]
    if image_paths:
        parts.append("")
        parts.append("Images (open and inspect each path):")
        for ip in image_paths:
            parts.append(f"- {ip}")
    return "\n".join(parts)


async def run_argv_async(
    argv: list[str],
    *,
    agent: str,
    cli: str,
    model: str | None = None,
    timeout_s: float = 300.0,
    progress_cb: Callable[[str], None] | None = None,
) -> AgentResult:
    """Run agent CLI with asyncio; raise on non-zero or timeout."""
    t0 = time.perf_counter()
    if progress_cb:
        progress_cb(f"spawn {cli}…")

    try:
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError as e:
        raise RuntimeError(f"{cli} not found on PATH") from e

    try:
        stdout_b, stderr_b = await asyncio.wait_for(
            proc.communicate(),
            timeout=timeout_s,
        )
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise TimeoutError(f"{cli} timed out after {timeout_s}s") from None
    except asyncio.CancelledError:
        proc.kill()
        await proc.wait()
        raise

    duration_ms = int((time.perf_counter() - t0) * 1000)
    stdout = (stdout_b or b"").decode(errors="replace")
    stderr = (stderr_b or b"").decode(errors="replace")
    if proc.returncode != 0:
        raise RuntimeError(
            f"{cli} exit {proc.returncode}: "
            f"{(stderr or stdout)[-2000:] or 'no output'}"
        )
    raw = stdout.strip() or stderr.strip()
    text = clean_prompt_text(raw)
    if not text:
        raise RuntimeError(f"{cli} returned empty text")
    return AgentResult(
        text=text,
        agent=agent,
        cli=cli,
        model=model,
        duration_ms=duration_ms,
        raw=raw,
        command=argv,
    )


def list_backends() -> list[dict]:
    from .http_api import list_api_backends
    from .secrets import ensure_secrets

    ensure_secrets()
    out = [
        {
            "id": "grok",
            "label": "grok CLI",
            "available": which("grok") is not None,
            "vision": True,
        },
        {
            "id": "agy",
            "label": "agy CLI",
            "available": which("agy") is not None,
            "vision": True,
        },
        {
            "id": "stub",
            "label": "stub (offline)",
            "available": True,
            "vision": False,
        },
    ]
    out.extend(list_api_backends())
    return out


async def run_backend(
    backend_id: str,
    *,
    system: str,
    user: str,
    image_paths: list[str] | None = None,
    model: str | None = None,
    timeout_s: float = 300.0,
    progress_cb: Callable[[str], None] | None = None,
    clamp_sd: bool = False,
    require_vision: bool = False,
) -> AgentResult:
    from .http_api import PROVIDERS, run_http_chat
    from .secrets import ensure_secrets

    ensure_secrets()
    images = resolve_images(image_paths)
    blob = format_cli_blob(system=system, user=user, image_paths=images)

    bid = (backend_id or "grok").lower().strip()
    if bid == "stub":
        t0 = time.perf_counter()
        # Deterministic offline text for CI / no CLI
        if images:
            name = images[0].name
            text = (
                f"subject from {name}, detailed materials, soft cinematic lighting, "
                f"rich texture, natural palette"
            )
        else:
            text = "ok (stub agent — no vision CLI)"
        if clamp_sd:
            text = clamp_words(clean_prompt_text(text), 50)
        return AgentResult(
            text=text,
            agent="stub",
            cli="stub",
            model=None,
            duration_ms=int((time.perf_counter() - t0) * 1000),
            raw=text,
            command=["stub"],
        )

    if bid == "agy":
        if not which("agy"):
            raise RuntimeError("agy not found on PATH")
        argv = ["agy", "-p", blob, "--dangerously-skip-permissions"]
        if model:
            argv.extend(["--model", model])
        result = await run_argv_async(
            argv, agent="agy", cli="agy", model=model,
            timeout_s=timeout_s, progress_cb=progress_cb,
        )
    elif bid == "grok":
        if not which("grok"):
            raise RuntimeError("grok not found on PATH")
        argv = ["grok", "-p", blob, "--yolo"]
        if model:
            argv.extend(["-m", model])
        result = await run_argv_async(
            argv, agent="grok", cli="grok", model=model,
            timeout_s=timeout_s, progress_cb=progress_cb,
        )
    elif bid in PROVIDERS:
        result = await run_http_chat(
            bid,
            system=system,
            user=user,
            image_paths=images,
            model=model,
            timeout_s=timeout_s,
            progress_cb=progress_cb,
            clamp_sd=clamp_sd,
            require_vision=require_vision,
        )
        return result
    else:
        known = "grok|agy|stub|" + "|".join(PROVIDERS)
        raise ValueError(f"Unknown backend: {backend_id!r} (use {known})")

    if clamp_sd:
        result.text = clamp_words(clean_prompt_text(result.text), 50)
    return result
