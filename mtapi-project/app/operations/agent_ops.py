"""Agent chat + image→SD1.5 prompt ops (CLI + HTTP API backends)."""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from ..contract import OperationResult, OperationSpec, register

# CLI + HTTP API providers (deepseek/openrouter/xai/openai/groq)
BackendId = Literal[
    "grok", "agy", "stub",
    "deepseek", "openrouter", "xai", "openai", "groq",
]
SkillId = Literal["chat", "sd15_prompt", "caption"]


class AgentChatParams(BaseModel):
    backend: BackendId = Field(
        "grok",
        description="grok|agy|stub|deepseek|openrouter|xai|openai|groq",
    )
    skill: SkillId = Field("chat", description="chat | sd15_prompt | caption")
    message: str = Field("", description="User message (optional for sd15_prompt)")
    image_paths: list[str] = Field(default_factory=list)
    history: list[dict[str, str]] = Field(
        default_factory=list,
        description="Prior turns [{role, content}, …] — appended to user blob for chat",
    )
    model: str | None = Field(
        None,
        description="Optional model id (CLI --model or API model name)",
    )
    timeout_s: float = Field(300.0, ge=10.0, le=900.0)
    dry_run: bool = Field(False)


class ImageToPromptParams(BaseModel):
    image_path: str = Field(..., description="Absolute image path")
    backend: BackendId = Field("grok")
    message: str = Field(
        "",
        description="Optional extra direction (style, mood)",
    )
    model: str | None = Field(None)
    timeout_s: float = Field(300.0, ge=10.0, le=900.0)
    dry_run: bool = Field(False)


def _history_block(history: list[dict[str, str]]) -> str:
    if not history:
        return ""
    lines = ["Prior conversation:"]
    for turn in history[-12:]:
        role = (turn.get("role") or "user").strip()
        content = (turn.get("content") or "").strip()
        if content:
            lines.append(f"{role}: {content}")
    return "\n".join(lines) + "\n\n"


async def agent_chat(p: AgentChatParams) -> OperationResult:
    from .. import job_control
    from ..agents import build_messages, list_backends, run_backend

    op = "agent_chat"
    token = job_control.current_token()

    if p.dry_run:
        return OperationResult(
            ok=True,
            operation=op,
            dry_run=True,
            command=f"agent_chat backend={p.backend} skill={p.skill}",
            stdout=(
                f"backends={list_backends()}\n"
                f"images={p.image_paths}\n"
                f"message={p.message!r}\n"
            ),
        )

    try:
        system, user, clamp_sd = build_messages(
            p.skill,
            message=p.message,
            image_paths=p.image_paths,
        )
        if p.skill == "chat" and p.history:
            user = _history_block(p.history) + user
    except ValueError as e:
        return OperationResult(ok=False, operation=op, error=str(e))

    def progress(msg: str) -> None:
        job_control.report_progress(
            msg, phase="agent", current=0, total=1, unit="call", token=token,
        )

    # Vision-required skills with image attachments
    require_vision = bool(
        p.image_paths and p.skill in ("sd15_prompt", "caption")
    )

    progress(f"agent {p.backend} / {p.skill}…")
    try:
        result = await run_backend(
            p.backend,
            system=system,
            user=user,
            image_paths=p.image_paths,
            model=p.model,
            timeout_s=p.timeout_s,
            progress_cb=progress,
            clamp_sd=clamp_sd,
            require_vision=require_vision,
        )
    except Exception as e:
        return OperationResult(ok=False, operation=op, error=str(e))

    job_control.report_progress(
        "agent done", phase="agent", current=1, total=1, unit="call", token=token,
    )

    payload: dict[str, Any] = {
        "role": "assistant",
        "content": result.text,
        "backend": result.agent,
        "cli": result.cli,
        "duration_ms": result.duration_ms,
        "model": result.model,
    }
    if clamp_sd:
        payload["prompt"] = result.text

    # Pack structured bits in stdout for UI (stable parse)
    stdout_lines = [result.text]
    if clamp_sd:
        stdout_lines = [f"PROMPT: {result.text}", "", result.text]

    return OperationResult(
        ok=True,
        operation=op,
        command=f"{result.cli} {result.duration_ms}ms",
        stdout="\n".join(stdout_lines),
        items=[payload],
    )


async def image_to_prompt(p: ImageToPromptParams) -> OperationResult:
    """Thin alias: image path → SD1.5 prompt."""
    chat = await agent_chat(
        AgentChatParams(
            backend=p.backend,
            skill="sd15_prompt",
            message=p.message,
            image_paths=[p.image_path],
            model=p.model,
            timeout_s=p.timeout_s,
            dry_run=p.dry_run,
        )
    )
    if chat.ok and chat.items:
        # re-tag operation id for clarity
        return OperationResult(
            ok=True,
            operation="image_to_prompt",
            command=chat.command,
            stdout=chat.stdout,
            items=chat.items,
            dry_run=chat.dry_run,
        )
    return OperationResult(
        ok=False,
        operation="image_to_prompt",
        error=chat.error or "failed",
        stdout=chat.stdout,
        dry_run=p.dry_run,
    )


register(OperationSpec(
    id="agent_chat",
    summary="Agent chat: CLI (grok/agy) or HTTP API (deepseek/openrouter/xai/openai/groq)",
    description=(
        "CLI backends open image paths via tools. "
        "HTTP backends load keys from ~/.secrets (e.g. DEEPSEEK_API_KEY). "
        "DeepSeek/Groq are text-only — use openrouter/xai/openai/grok/agy for vision. "
        "skill=sd15_prompt returns a short CLIP-style SD1.5 prompt."
    ),
    params_model=AgentChatParams,
    handler=agent_chat,
    tags=["agent", "vision", "prompt", "deepseek"],
))

register(OperationSpec(
    id="image_to_prompt",
    summary="Image → short SD1.5 prompt (vision CLI or vision-capable API)",
    description=(
        "Wrapper around agent_chat skill=sd15_prompt. "
        "Prefer grok/agy/openrouter/xai/openai for images; deepseek is text-only."
    ),
    params_model=ImageToPromptParams,
    handler=image_to_prompt,
    tags=["agent", "vision", "img2img", "prompt"],
))
