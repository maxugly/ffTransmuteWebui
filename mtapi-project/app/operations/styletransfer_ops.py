"""
Neural style transfer operation — Magenta arbitrary stylization (TF-Hub).

Simplest non-DeepDream art path: content photo(s) + one style image.
"""
from __future__ import annotations

import asyncio
from pathlib import Path

from pydantic import BaseModel, Field

from ..contract import OperationResult, OperationSpec, register
from .. import job_control
from . import styletransfer_engine as ste


class StyleTransferParams(BaseModel):
    content_path: str | None = Field(
        None,
        description="Single content image path (or use content_paths)",
    )
    content_paths: list[str] | None = Field(
        None,
        description="Batch of content images (same style applied to each)",
    )
    style_path: str = Field(
        ...,
        description="Style reference image (painting, texture, stained glass photo, …)",
    )
    output_path: str | None = Field(
        None,
        description="Output for single content; auto-named if omitted",
    )
    output_dir: str | None = Field(
        None,
        description="Output folder for batch (default: next to each content)",
    )
    strength: float = Field(
        1.0,
        ge=0.0,
        le=1.0,
        description="0 = original content, 1 = full style transfer",
    )
    max_side: int = Field(
        1280,
        ge=0,
        le=4096,
        description="Longest side of content for inference (0 = full resolution). "
        "Lower = less RAM / faster. 1280 is a good default.",
    )
    style_size: int = Field(
        256,
        ge=64,
        le=512,
        description="Style encoder resolution (model default 256)",
    )
    suffix: str = Field(
        "_styled",
        description="Filename suffix for batch / auto single outputs",
    )
    dry_run: bool = False


def _collect_contents(p: StyleTransferParams) -> list[str]:
    out: list[str] = []
    if p.content_paths:
        for x in p.content_paths:
            path = Path(x).expanduser().resolve()
            if path.is_file():
                out.append(str(path))
    if p.content_path:
        path = Path(p.content_path).expanduser().resolve()
        if path.is_file() and str(path) not in out:
            out.insert(0, str(path))
    return out


async def styletransfer(p: StyleTransferParams) -> OperationResult:
    contents = _collect_contents(p)
    if not contents:
        return OperationResult(
            ok=False,
            operation="styletransfer",
            error="Need at least one content image (content_path or content_paths).",
            dry_run=p.dry_run,
        )

    style = Path(p.style_path).expanduser().resolve()
    if not style.is_file() and not p.dry_run:
        return OperationResult(
            ok=False,
            operation="styletransfer",
            error=f"Style image not found: {style}",
            dry_run=p.dry_run,
        )

    summary = (
        f"styletransfer n={len(contents)} style={style.name} "
        f"strength={p.strength} max_side={p.max_side}"
    )

    if p.dry_run:
        from ..pathutil import unique_output_path

        lines = [summary, f"Style: {style}"]
        last_dest = None
        for src in contents:
            src_p = Path(src)
            if len(contents) == 1 and p.output_path:
                dest = unique_output_path(Path(p.output_path).expanduser())
            else:
                od = Path(p.output_dir).expanduser().resolve() if p.output_dir else src_p.parent
                dest = unique_output_path(od / f"{src_p.stem}{p.suffix}.png")
            last_dest = dest
            lines.append(f"  {src_p.name} → {dest}")
        return OperationResult(
            ok=True,
            operation="styletransfer",
            output_path=str(last_dest) if last_dest else None,
            dry_run=True,
            command=summary,
            stdout="\n".join(lines) + "\n",
        )

    logs: list[str] = []
    job_token = job_control.current_token()

    def progress_cb(msg: str, **kw):
        logs.append(msg)
        try:
            job_control.report_progress(msg, token=job_token, **kw)
        except Exception:
            pass
        job_control.check_cancelled()

    def runner():
        job_control.bind(job_token)
        if len(contents) == 1 and p.output_path:
            dest = Path(p.output_path).expanduser().resolve()
            r = ste.stylize_pair(
                contents[0],
                style,
                dest,
                strength=p.strength,
                max_side=p.max_side,
                style_size=p.style_size,
                progress_cb=progress_cb,
            )
            return {
                "ok": r.get("ok"),
                "output_path": r.get("output_path"),
                "results": [r],
                "error": r.get("error"),
            }
        return ste.stylize_batch(
            contents,
            style,
            output_dir=p.output_dir,
            suffix=p.suffix,
            strength=p.strength,
            max_side=p.max_side,
            style_size=p.style_size,
            progress_cb=progress_cb,
        )

    try:
        result = await asyncio.to_thread(runner)
    except job_control.JobCancelled as e:
        return OperationResult(
            ok=False,
            operation="styletransfer",
            dry_run=False,
            command=summary,
            stdout="\n".join(logs),
            error=str(e),
        )
    except Exception as e:
        if "Cancelled by user" in str(e):
            return OperationResult(
                ok=False,
                operation="styletransfer",
                dry_run=False,
                command=summary,
                stdout="\n".join(logs),
                error="Cancelled by user",
            )
        return OperationResult(
            ok=False,
            operation="styletransfer",
            dry_run=False,
            command=summary,
            stdout="\n".join(logs),
            stderr=str(e),
            error=str(e),
        )

    lines = list(logs)
    for r in result.get("results") or []:
        if r.get("ok"):
            lines.append(f"  OK {r.get('output_path')}")
        else:
            lines.append(f"  FAIL {r.get('content') or r.get('error')}: {r.get('error')}")

    ok = bool(result.get("ok"))
    return OperationResult(
        ok=ok,
        operation="styletransfer",
        output_path=result.get("output_path"),
        dry_run=False,
        command=summary,
        stdout="\n".join(lines) + "\n",
        error=None if ok else (result.get("error") or "style transfer failed"),
    )


register(OperationSpec(
    id="styletransfer",
    summary="Neural style transfer (Magenta: any style image)",
    description=(
        "Arbitrary artistic style transfer via Magenta TF-Hub model. "
        "Pass a content photo and any style reference image (painting, glass, etc.). "
        "Not DeepDream — no ImageNet dog faces."
    ),
    params_model=StyleTransferParams,
    handler=styletransfer,
    tags=["styletransfer", "image", "neural"],
))
