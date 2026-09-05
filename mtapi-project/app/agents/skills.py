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


SKILL_INSTALL_NORMALIZE_SYSTEM = """You are a skill packager for AI-model skills (SKILL.md format).
Given raw skill text, return:
(1) YAML frontmatter with `name` (kebab-case, max 64 chars) and `description`
(one line, max 160 chars), then (2) the cleaned body.
Fix headings, remove redundancy, do NOT change semantics or drop sections.
Output the full SKILL.md only, no preamble, no explanation."""

SKILL_INSTALL_CUSTOM_SYSTEM = """You are a skill packager for AI-model skills (SKILL.md format).
Given raw skill text, return:
(1) YAML frontmatter with `name` (kebab-case, max 64 chars) and `description`
(one line, max 160 chars), then (2) the reworked body.
Output the full SKILL.md only, no preamble, no explanation.
Additionally follow this user direction:
"""


def build_skill_install_messages(
    mode: str,
    *,
    text: str,
    custom_prompt: str = "",
) -> tuple[str, str]:
    """Return (system, user) for the model-assisted skill install step."""
    mode = (mode or "normalize").lower().strip()
    body = (text or "").strip()
    if not body:
        raise ValueError("Skill text is empty — upload a file or paste text first")
    if mode == "custom":
        extra = (custom_prompt or "").strip()
        if not extra:
            raise ValueError("Custom mode needs a custom instruction for the model")
        return SKILL_INSTALL_CUSTOM_SYSTEM, f"{extra}\n\n---\n\n{body}"
    if mode != "normalize":
        raise ValueError(f"Unknown install mode: {mode!r} (use normalize | custom)")
    return SKILL_INSTALL_NORMALIZE_SYSTEM, body


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
