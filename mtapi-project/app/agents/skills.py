"""Skill templates: chat, sd15_prompt, caption."""
from __future__ import annotations

from pathlib import Path

SD15_SYSTEM = """You write SHORT Stable Diffusion 1.5 / CLIP prompts.
HARD LIMIT: at most 50 words, about 75 tokens. Dense comma-separated phrases, not prose.
Order: subject and distinctive details FIRST, then materials, lighting, palette, style.
No markdown, no quotes, no preamble, no explanation.
Return ONLY the positive prompt as a single line."""

CHAT_SYSTEM = """You are a helpful creative assistant for a local video/image tool (ffTransmute).
You can be given absolute filesystem image paths — open and inspect them when asked.
Be concise and practical. Do not invent file contents you did not inspect."""

CAPTION_SYSTEM = """Describe the image clearly in 2–4 short sentences.
Focus on subject, materials, lighting, and palette. No markdown."""


def build_messages(
    skill: str,
    *,
    message: str,
    image_paths: list[str] | None = None,
) -> tuple[str, str, bool]:
    """Return (system, user, clamp_sd)."""
    skill = (skill or "chat").lower().strip()
    paths = [str(Path(p).expanduser().resolve()) for p in (image_paths or []) if p]
    msg = (message or "").strip()

    if skill in ("sd15_prompt", "sd15", "image_prompt", "prompt"):
        if not paths:
            raise ValueError("sd15_prompt skill requires at least one image_path")
        primary = paths[0]
        user = (
            f"Image path (open and inspect): {primary}\n\n"
            "Write ONE SD1.5-style positive prompt for img2img that preserves composition "
            "but enriches materials/lighting. Prompt only."
        )
        if msg:
            user = f"Extra direction from user: {msg}\n\n" + user
        return SD15_SYSTEM, user, True

    if skill in ("caption", "describe"):
        if not paths:
            raise ValueError("caption skill requires at least one image_path")
        primary = paths[0]
        user = f"Image path (open and inspect): {primary}\n\nDescribe the image."
        if msg:
            user = f"{msg}\n\n" + user
        return CAPTION_SYSTEM, user, False

    # freeform chat
    user = msg or "Hello."
    if paths:
        user = user + "\n\n(See image paths listed below — inspect them.)"
    return CHAT_SYSTEM, user, False
