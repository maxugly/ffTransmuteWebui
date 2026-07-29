"""
withoutBG operation — remove backgrounds (local open weights or Cloud API).

Image mode: batch PNG/WebP output via process_many().
Video mode: frame-by-frame via VideoPipeline + JobWorkspace →
  cutout → WebM with VP9 + yuva420p alpha
  mask → MP4 grayscale
  background → MP4 RGB

Knobs:
  save_cutout      — RGBA subject with transparent background
  save_mask        — grayscale alpha mask (white = subject)
  save_background  — leftover background (original RGB + inverted alpha)
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

from ..contract import OperationResult, OperationSpec, register
from .. import job_control
from ..pathutil import finalize_output_path
from . import withoutbg_engine as wbe

Backend = Literal["local", "api"]
OutFmt = Literal["png", "webp"]

VIDEO_EXTS = {".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi"}


class WithoutBGParams(BaseModel):
    input_path: str | None = Field(
        None,
        description="Newline-separated image paths (alternative to image_paths). "
                    "If set, each line is one image. Used by global image input.",
    )
    image_paths: list[str] | None = Field(
        None,
        description="Explicit list of image paths to process",
    )
    image_dir: str | None = Field(
        None,
        description="Directory of images (used if image_paths empty)",
    )
    output_dir: str | None = Field(
        None,
        description="Where to write outputs; default = next to each source image",
    )

    backend: Backend = Field(
        "local",
        description="local = open weights (~455MB once); api = withoutbg.com Cloud",
    )
    api_key: str | None = Field(
        None,
        description="Cloud API key (or set WITHOUTBG_API_KEY). Ignored for local.",
    )

    # Output knobs
    save_cutout: bool = Field(
        True,
        description="Save processed subject (RGBA PNG/WebP with transparent BG)",
    )
    save_mask: bool = Field(
        False,
        description="Save grayscale alpha mask (white = foreground / subject)",
    )
    save_background: bool = Field(
        False,
        description=(
            "Save leftover background: original RGB with inverted alpha "
            "(subject transparent, scene remains)"
        ),
    )

    prefix: str = Field(
        "withoutbg",
        description="Filename prefix (e.g. withoutbg-photo.png). Empty = keep stem only",
    )
    suffix: str = Field(
        "",
        description="Optional extra stem suffix before extension",
    )
    fmt: OutFmt = Field(
        "png",
        description="Cutout / background format (mask is always PNG). Prefer png/webp for alpha.",
    )
    dry_run: bool = False


def _collect_images(p: WithoutBGParams) -> list[str]:
    if p.image_paths:
        out = []
        for x in p.image_paths:
            path = Path(x).expanduser().resolve()
            if path.is_file():
                out.append(str(path))
        return out
    if p.image_dir:
        d = Path(p.image_dir).expanduser().resolve()
        if d.is_dir():
            return wbe.get_image_files(d)
    return []

def _collect_images_v2(p: WithoutBGParams) -> list[str]:
    """Collect images from input_path (newline-sep), image_paths, or image_dir."""
    from ..pathutil import parse_path_list, verify_paths_exist
    images = _collect_images(p)
    if not images and p.input_path:
        images = parse_path_list(p.input_path)
    if images:
        missing = verify_paths_exist(images)
        if missing:
            job_control.check_cancelled()  # respect cancel before error
            return []  # caller reports missing
    return images


async def _withoutbg_video(p: WithoutBGParams, video_path: str) -> OperationResult:
    """Frame-by-frame background removal for video using VideoPipeline."""
    from ..job_workspace import JobWorkspace
    from ..video_pipeline import probe, dump, process, encode, cleanup
    from PIL import Image as PILImage
    import uuid

    input_path = Path(video_path).expanduser().resolve()
    out = finalize_output_path(
        None,
        source=input_path,
        default_suffix="_withoutbg",
        default_ext=".webm" if p.save_cutout else ".mp4",
        allowed_exts=VIDEO_EXTS.union({".webm"}),
        output_dir=p.output_dir or None,
    )

    summary = (
        f"withoutbg video {input_path.name} "
        f"cutout={p.save_cutout} mask={p.save_mask} bg={p.save_background} "
        f"backend={p.backend}"
    )

    if p.dry_run:
        return OperationResult(
            ok=True, operation="withoutbg", output_path=str(out),
            dry_run=True, command=summary,
            stdout=f"{summary}\nWould process {input_path.name} frame-by-frame → {out}\n",
        )

    info = await probe(input_path)
    if info["frame_count"] <= 0:
        return OperationResult(
            ok=False, operation="withoutbg",
            error=f"Could not probe video frames", dry_run=False,
        )

    ws = JobWorkspace(uuid.uuid4().hex[:12], prefix="withoutbg_")
    success = False
    logs: list[str] = [summary]

    # Load model once
    mdl = wbe._get_model(p.backend, api_key=p.api_key)

    async def withoutbg_filter(input_png: Path, output_png: Path, index: int) -> None:
        original = PILImage.open(input_png).convert("RGB")
        rgba = mdl.remove_background(str(input_png))
        if rgba.mode != "RGBA":
            rgba = rgba.convert("RGBA")
        if rgba.size != original.size:
            rgba = rgba.resize(original.size, PILImage.Resampling.BILINEAR)

        if p.save_cutout:
            rgba.save(str(output_png))
        elif p.save_mask:
            mask = wbe._alpha_from_rgba(rgba)
            mask.save(str(output_png))
        elif p.save_background:
            alpha = wbe._alpha_from_rgba(rgba)
            bg = wbe._background_leftover(original, alpha)
            bg.save(str(output_png))

    try:
        dump_info = await dump(ws, input_path)
        logs.append(f"dump: {dump_info['frame_count']} frames")

        processed = await process(ws, withoutbg_filter)
        logs.append(f"process: {processed} frames")

        codec = "libvpx-vp9" if p.save_cutout else "libx264"
        pix_fmt = "yuva420p" if p.save_cutout else "yuv420p"
        result_path = await encode(
            ws, out, info["fps"],
            codec=codec, pix_fmt=pix_fmt, mux_audio=False,
        )
        logs.append(f"Output: {result_path}")
        success = True

        return OperationResult(
            ok=True, operation="withoutbg", output_path=str(out),
            dry_run=False, command=summary, stdout="\n".join(logs),
        )

    except Exception as e:
        return OperationResult(
            ok=False, operation="withoutbg", error=str(e),
            dry_run=False, command=summary, stdout="\n".join(logs), stderr=str(e),
        )

    finally:
        await cleanup(ws, keep_on_failure=not success)


async def withoutbg_remove(p: WithoutBGParams) -> OperationResult:
    # ── video path ──
    if p.input_path:
        lines = [l.strip() for l in p.input_path.split("\n") if l.strip()]
        if len(lines) == 1:
            first = Path(lines[0]).expanduser()
            if first.suffix.lower() in VIDEO_EXTS and first.is_file():
                return await _withoutbg_video(p, lines[0])

    images = _collect_images_v2(p)
    if not images:
        # Check if paths were provided but missing
        from ..pathutil import parse_path_list, verify_paths_exist
        raw = parse_path_list(p.input_path) if p.input_path else []
        if raw:
            missing = verify_paths_exist(raw)
            detail = "; missing: " + ", ".join(missing) if missing else ""
            return OperationResult(
                ok=False,
                operation="withoutbg",
                error=f"All paths missing or invalid{detail}",
                dry_run=p.dry_run,
            )
        return OperationResult(
            ok=False,
            operation="withoutbg",
            error="Need at least 1 image (image_paths or image_dir).",
            dry_run=p.dry_run,
        )

    if not (p.save_cutout or p.save_mask or p.save_background):
        return OperationResult(
            ok=False,
            operation="withoutbg",
            error="Enable at least one save knob: cutout, mask, or background.",
            dry_run=p.dry_run,
        )

    summary = (
        f"withoutbg n={len(images)} backend={p.backend} "
        f"cutout={p.save_cutout} mask={p.save_mask} bg={p.save_background} "
        f"fmt={p.fmt} prefix={p.prefix!r}"
    )

    if p.dry_run:
        from ..pathutil import unique_related_paths

        preview_lines = []
        out_dir = (
            Path(p.output_dir).expanduser().resolve()
            if p.output_dir
            else None
        )
        first_out = None
        for src in images:
            src_p = Path(src)
            od = out_dir or src_p.parent
            paths = wbe._out_paths(
                src_p, od, prefix=p.prefix, suffix=p.suffix, fmt=p.fmt
            )
            wanted = {}
            if p.save_cutout:
                wanted["cutout"] = paths["cutout"]
            if p.save_mask:
                wanted["mask"] = paths["mask"]
            if p.save_background:
                wanted["background"] = paths["background"]
            paths = unique_related_paths(
                wanted, primary_key="cutout" if p.save_cutout else None
            )
            bits = [str(paths[k]) for k in paths]
            if first_out is None and bits:
                first_out = bits[0]
            preview_lines.append(f"  {src_p.name} → " + ", ".join(bits))
        return OperationResult(
            ok=True,
            operation="withoutbg",
            output_path=first_out or (str(out_dir) if out_dir else str(Path(images[0]).parent)),
            dry_run=True,
            command=summary,
            stdout=f"{summary}\nWould write:\n" + "\n".join(preview_lines) + "\n",
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
        # If request carried api_key, export for this thread only if not set
        # (engine accepts api_key explicitly too)
        return wbe.process_many(
            images,
            output_dir=p.output_dir,
            backend=p.backend,
            api_key=p.api_key,
            save_cutout=p.save_cutout,
            save_mask=p.save_mask,
            save_background=p.save_background,
            prefix=p.prefix,
            suffix=p.suffix,
            fmt=p.fmt,
            progress_cb=progress_cb,
        )

    try:
        result = await asyncio.to_thread(runner)
    except job_control.JobCancelled as e:
        return OperationResult(
            ok=False,
            operation="withoutbg",
            dry_run=False,
            command=summary,
            stdout="\n".join(logs),
            error=str(e),
        )
    except Exception as e:
        if "Cancelled by user" in str(e):
            return OperationResult(
                ok=False,
                operation="withoutbg",
                dry_run=False,
                command=summary,
                stdout="\n".join(logs),
                error="Cancelled by user",
            )
        return OperationResult(
            ok=False,
            operation="withoutbg",
            dry_run=False,
            command=summary,
            stdout="\n".join(logs),
            stderr=str(e),
            error=str(e),
        )

    # Build readable stdout of all outputs
    lines = list(logs)
    written_all: list[str] = []
    for r in result.get("results") or []:
        if r.get("ok"):
            for kind, path in (r.get("written") or {}).items():
                lines.append(f"  [{kind}] {path}")
                written_all.append(path)
        else:
            lines.append(f"  FAIL {r.get('src')}: {r.get('error')}")

    ok = bool(result.get("ok"))
    return OperationResult(
        ok=ok,
        operation="withoutbg",
        output_path=result.get("output_path") or (written_all[0] if written_all else None),
        dry_run=False,
        command=summary,
        stdout="\n".join(lines) + "\n",
        error=None if ok else (result.get("error") or "withoutbg failed"),
    )


register(OperationSpec(
    id="withoutbg",
    summary="Remove image backgrounds (withoutbg local or Cloud API)",
    description=(
        "Uses withoutbg open weights locally (free, private) or Cloud API. "
        "Optional saves: RGBA cutout, alpha mask, leftover background."
    ),
    params_model=WithoutBGParams,
    handler=withoutbg_remove,
    tags=["withoutbg", "image", "matting"],
))
