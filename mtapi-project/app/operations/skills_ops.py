"""Model-assisted skill install: normalize via LLM, save to skill library.

Single-file/paste uploads AND .zip bundles (base64 inside the JSON body, so
no multipart dependency) go through this one op — full job machinery,
progress, cancel, and single-flight come for free.
"""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from ..agents.skills import build_skill_install_messages
from ..contract import OperationResult, OperationSpec, register
from .. import skills_store as store
from .agent_ops import BackendId


class SkillInstallParams(BaseModel):
    backend: BackendId = Field(
        "deepseek",
        description="grok|agy|stub|deepseek|openrouter|xai|openai|groq (text-only use)",
    )
    mode: Literal["normalize", "custom"] = Field(
        "normalize", description="normalize | custom (custom needs custom_prompt)",
    )
    custom_prompt: str = Field(
        "", description="Extra direction for the model (custom mode only)",
    )
    filename: str = Field(
        "SKILL.md", description="Original upload filename (single-file path)",
    )
    content_text: str = Field(
        "", description="Skill markdown/text (single-file/paste path)",
    )
    content_b64: str = Field(
        "", description="Base64 .zip bytes (bundle path; exactly one of text/b64)",
    )
    source: str = Field("pasted", description="pasted | upload-single | upload-zip")
    model: str | None = Field(None, description="Optional model id override")
    overwrite: bool = Field(
        False, description="Confirm overwrite when a same-named skill exists",
    )
    timeout_s: float = Field(300.0, ge=10.0, le=900.0)
    dry_run: bool = Field(False)


def _conflict(name: str, existing: dict) -> OperationResult:
    return OperationResult(
        ok=False,
        operation="skills_install",
        error=f"A skill named '{name}' already exists — confirm to overwrite",
        meta={"conflict": True, "name": name, "existing_id": existing.get("id")},
    )


async def skills_install(p: SkillInstallParams) -> OperationResult:
    from .. import job_control
    from ..agents import list_backends, run_backend

    op = "skills_install"
    token = job_control.current_token()

    has_text = bool((p.content_text or "").strip())
    has_zip = bool((p.content_b64 or "").strip())
    if has_text == has_zip:
        return OperationResult(
            ok=False, operation=op,
            error="Provide exactly one of content_text or content_b64",
        )
    if p.mode == "custom" and not (p.custom_prompt or "").strip():
        return OperationResult(
            ok=False, operation=op,
            error="Custom mode needs a custom_prompt for the model",
        )

    # ── gather raw text + bundle extras ──────────────────────────────────
    extra_files: dict[str, str] = {}
    source = (p.source or "pasted").strip() or "pasted"
    raw_text = ""
    try:
        if has_zip:
            if source == "pasted":
                source = "upload-zip"
            zip_bytes = store.decode_zip_b64(p.content_b64.strip())
            raw_text, extra_files = store.extract_skill_zip(zip_bytes)
        else:
            raw_text = p.content_text
            if len(raw_text.encode("utf-8", errors="replace")) > store.MAX_SINGLE_BYTES:
                return OperationResult(
                    ok=False, operation=op,
                    error=f"Skill text too large (>{store.MAX_SINGLE_BYTES // 1024} KB)",
                )
            if source not in ("pasted", "upload-single", "upload-zip"):
                source = "pasted"
    except ValueError as e:
        return OperationResult(ok=False, operation=op, error=str(e))

    if p.dry_run:
        return OperationResult(
            ok=True, operation=op, dry_run=True,
            command=f"skills_install backend={p.backend} mode={p.mode} source={source}",
            stdout=f"backends={list_backends()}\nchars={len(raw_text)}\nextras={sorted(extra_files)}\n",
        )

    def progress(msg: str) -> None:
        job_control.report_progress(
            msg, phase="skills", current=0, total=1, unit="call", token=token,
        )

    # ── model pass ───────────────────────────────────────────────────────
    try:
        system, user = build_skill_install_messages(
            p.mode, text=raw_text, custom_prompt=p.custom_prompt,
        )
    except ValueError as e:
        return OperationResult(ok=False, operation=op, error=str(e))

    model_warning = ""
    model_output = ""
    progress(f"skills {p.backend} / {p.mode}…")
    try:
        result = await run_backend(
            p.backend,
            system=system,
            user=user,
            model=p.model,
            timeout_s=p.timeout_s,
            progress_cb=progress,
            clamp_sd=False,
            require_vision=False,
        )
        model_output = (result.text or "").strip()
    except Exception as e:
        model_warning = f"model {p.backend} failed ({e}); used input as-is"

    job_control.report_progress(
        "skills done", phase="skills", current=1, total=1, unit="call", token=token,
    )

    # ── frontmatter: model output wins, else fall back to the input as-is ─
    name = desc = None
    body_text = model_output
    if model_output:
        name, desc, _ = store.parse_frontmatter(model_output)
    if not name:
        in_name, in_desc, _ = store.parse_frontmatter(raw_text)
        if in_name:
            name, desc = in_name, in_desc
            body_text = raw_text
            note = "input already structured; used as-is"
            model_warning = f"{model_warning}; {note}" if model_warning else note

    if not name:
        return OperationResult(
            ok=False, operation=op,
            error="Model output has no usable name — retry with a Custom prompt",
            meta={"model_output": (model_output or "")[:4000]},
        )
    name = store.slugify_name(name)
    if not name:
        return OperationResult(
            ok=False, operation=op,
            error="Model output has no usable name — retry with a Custom prompt",
            meta={"model_output": (model_output or "")[:4000]},
        )
    if not desc:
        _, _, body = store.parse_frontmatter(body_text)
        desc = store.derive_description(body)

    # ── collision protocol: refuse unless overwrite=True ─────────────────
    existing = store.find_by_name(name)
    if existing and not p.overwrite:
        return _conflict(name, existing)
    skill_id = existing["id"] if existing else None

    entry = store.new_entry(name, desc, source, {}) if skill_id is None else dict(existing)
    entry.update({
        "name": name, "description": desc, "source": source,
        "files": {store.ENTRY_NAME: store.ENTRY_NAME, **extra_files},
        "entry": store.ENTRY_NAME,
    })
    if skill_id is not None:
        entry["id"] = skill_id

    try:
        store.write_skill_files(entry["id"], {store.ENTRY_NAME: body_text, **extra_files})
        saved = store.upsert_skill(entry)
    except ValueError as e:
        return OperationResult(ok=False, operation=op, error=str(e))

    payload: dict[str, Any] = {
        "id": saved["id"], "name": name, "description": desc,
        "source": source, "files": sorted(saved.get("files") or {}),
        "overwrote": bool(skill_id),
    }
    meta: dict[str, Any] = {"backend": p.backend, "mode": p.mode}
    if model_warning:
        meta["warning"] = model_warning
    return OperationResult(
        ok=True, operation=op,
        command=f"skills_install {name} ({source}, {p.mode})",
        stdout=f"Installed skill '{name}' — {desc}\nfiles: {', '.join(payload['files'])}",
        items=[payload],
        meta=meta,
    )


register(OperationSpec(
    id="skills_install",
    summary="Model-assisted skill install: normalize SKILL.md via LLM, save to library",
    description=(
        "Single-file skill text (content_text) or a .zip bundle (content_b64) is "
        "passed through an LLM (normalize, or custom with custom_prompt) to extract "
        "name/description frontmatter, then saved under ~/.cache/mtapi/skills/ and "
        "registered in skills.json. Same-name collision returns ok:false with "
        "meta.conflict — retry with overwrite=true. Text-only backends are fine."
    ),
    params_model=SkillInstallParams,
    handler=skills_install,
    tags=["skills", "agent", "library"],
))
