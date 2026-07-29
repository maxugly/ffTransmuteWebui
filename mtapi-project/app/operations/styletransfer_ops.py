"""
Neural style transfer operation — Magenta arbitrary stylization (TF-Hub).

Image mode: stylize_batch() with one style image → PNG/WebP output.
Video mode: frame-by-frame via VideoPipeline + JobWorkspace →
  model + style loaded once, each frame stylized → MP4 output.

Simplest non-DeepDream art path: content photo(s) + one style image.
Outputs are always non-destructive (incremented) and default next to each content file.
"""
from __future__ import annotations

import asyncio
from pathlib import Path

from pydantic import BaseModel, Field

from ..contract import OperationResult, OperationSpec, register
from .. import job_control
from ..pathutil import finalize_output_path
from . import styletransfer_engine as ste

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".tif", ".tiff", ".webp"}
VIDEO_EXTS = {".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi"}


class StyleTransferParams(BaseModel):
    content_path: str | None = Field(
        None,
        description="Single content image path, or a directory of images",
    )
    content_paths: list[str] | None = Field(
        None,
        description="Batch of content images and/or directories (same style applied to each file)",
    )
    style_path: str = Field(
        ...,
        description="Style reference image (painting, texture, stained glass photo, …)",
    )
    output_path: str | None = Field(
        None,
        description=(
            "Optional explicit output file (single content) or directory. "
            "Omitted → `{content_stem}_styled.png` next to each content, never overwriting."
        ),
    )
    output_dir: str | None = Field(
        None,
        description="Optional folder for all outputs (default: each content's own directory)",
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
        description="Filename suffix for auto-named outputs",
    )
    dry_run: bool = False


def _list_images_in_dir(d: Path) -> list[str]:
    if not d.is_dir():
        return []
    out: list[str] = []
    try:
        for child in sorted(d.iterdir()):
            if child.is_file() and child.suffix.lower() in IMAGE_EXTS and not child.name.startswith("."):
                out.append(str(child.resolve()))
    except OSError:
        pass
    return out


def _collect_contents(p: StyleTransferParams) -> list[str]:
    """Expand files + directories into a de-duplicated list of image paths."""
    seen: set[str] = set()
    out: list[str] = []

    def add_path(raw: str) -> None:
        path = Path(raw).expanduser().resolve()
        if path.is_dir():
            for f in _list_images_in_dir(path):
                if f not in seen:
                    seen.add(f)
                    out.append(f)
            return
        if path.is_file() and path.suffix.lower() in IMAGE_EXTS:
            s = str(path)
            if s not in seen:
                seen.add(s)
                out.append(s)

    if p.content_paths:
        for x in p.content_paths:
            add_path(x)
    if p.content_path:
        # Prefer listing content_path first when it's the primary single input
        head: list[str] = []
        path = Path(p.content_path).expanduser().resolve()
        if path.is_dir():
            head = _list_images_in_dir(path)
        elif path.is_file():
            head = [str(path)]
        for s in reversed(head):
            if s in seen:
                out.remove(s)
            seen.add(s)
            out.insert(0, s)
    return out


def _dest_for(src: str, p: StyleTransferParams, *, multi: bool) -> Path:
    """Always unique; default next to source (or under output_dir)."""
    src_p = Path(src)
    # Explicit single-file Save As only when one content and output_path is a file target
    explicit = None
    if p.output_path and not multi:
        explicit = p.output_path
    elif p.output_path and multi:
        # For multi, output_path if set is treated as a directory preference
        op = Path(p.output_path).expanduser()
        if op.is_dir() or str(p.output_path).endswith(("/", "\\")):
            return finalize_output_path(
                None,
                source=src_p,
                default_suffix=p.suffix,
                default_ext=".png",
                output_dir=op,
                allowed_exts=IMAGE_EXTS,
            )
        # otherwise ignore per-file explicit for batch (use output_dir / next-to-source)
        explicit = None

    return finalize_output_path(
        explicit,
        source=src_p,
        default_suffix=p.suffix,
        default_ext=".png",
        output_dir=p.output_dir,
        allowed_exts=IMAGE_EXTS,
    )


async def _styletransfer_video(p: StyleTransferParams, video_path: str) -> OperationResult:
    """Frame-by-frame style transfer for video using VideoPipeline.

    Model and style image are loaded once; each frame is stylized individually.
    """
    from ..job_workspace import JobWorkspace
    from ..video_pipeline import probe, dump, process, encode, cleanup
    import uuid

    input_path = Path(video_path).expanduser().resolve()
    style_path = Path(p.style_path).expanduser().resolve()

    out = finalize_output_path(
        p.output_path or None,
        source=input_path,
        default_suffix="_styled",
        default_ext=".mp4",
        allowed_exts=VIDEO_EXTS,
        output_dir=p.output_dir or None,
    )

    summary = (
        f"styletransfer video {input_path.name} ← {style_path.name} "
        f"strength={p.strength} max_side={p.max_side}"
    )

    if p.dry_run:
        return OperationResult(
            ok=True, operation="styletransfer", output_path=str(out),
            dry_run=True, command=summary,
            stdout=f"{summary}\nWould process {input_path.name} frame-by-frame → {out}\n",
        )

    info = await probe(input_path)
    if info["frame_count"] <= 0:
        return OperationResult(
            ok=False, operation="styletransfer",
            error=f"Could not probe video frames",
        )

    ws = JobWorkspace(uuid.uuid4().hex[:12], prefix="styletransfer_")
    success = False
    logs: list[str] = [summary]

    # Preload model and style image once
    try:
        model = ste._get_model()
    except Exception as e:
        return OperationResult(
            ok=False, operation="styletransfer",
            error=f"Failed to load style transfer model: {e}",
        )

    import numpy as np
    import tensorflow as tf
    from PIL import Image as PILImage

    style_img = ste._load_rgb(style_path)
    import tensorflow as tf
    style_tensor = ste._to_tf(style_img, (p.style_size, p.style_size))

    async def styletransfer_filter(input_png: Path, output_png: Path, index: int) -> None:
        content_img = ste._load_rgb(input_png)
        content_work = ste._resize_max_side(content_img, int(p.max_side) if p.max_side else 0)
        c = ste._to_tf(content_work)

        out_tensor = model(tf.constant(c), tf.constant(style_tensor))[0]
        stylized = np.clip(out_tensor.numpy()[0], 0.0, 1.0)

        if p.strength < 1.0 - 1e-6:
            base = np.asarray(content_work, dtype=np.float32) / 255.0
            if base.shape[:2] != stylized.shape[:2]:
                base_img = content_work.resize(
                    (stylized.shape[1], stylized.shape[0]),
                    PILImage.Resampling.LANCZOS,
                )
                base = np.asarray(base_img, dtype=np.float32) / 255.0
            stylized = stylized * p.strength + base * (1.0 - p.strength)

        result = PILImage.fromarray((stylized * 255.0).astype(np.uint8), "RGB")
        result.save(str(output_png))

    try:
        dump_info = await dump(ws, input_path)
        logs.append(f"dump: {dump_info['frame_count']} frames")

        processed = await process(ws, styletransfer_filter)
        logs.append(f"process: {processed} frames")

        result_path = await encode(ws, out, info["fps"])
        logs.append(f"Output: {result_path}")
        success = True

        return OperationResult(
            ok=True, operation="styletransfer", output_path=str(out),
            dry_run=False, command=summary, stdout="\n".join(logs),
        )

    except Exception as e:
        return OperationResult(
            ok=False, operation="styletransfer", error=str(e),
            dry_run=False, command=summary, stdout="\n".join(logs), stderr=str(e),
        )

    finally:
        await cleanup(ws, keep_on_failure=not success)


async def styletransfer(p: StyleTransferParams) -> OperationResult:
    # ── video path ──
    if p.content_path:
        first = Path(p.content_path).expanduser()
        if first.suffix.lower() in VIDEO_EXTS and first.is_file():
            return await _styletransfer_video(p, p.content_path)

    contents = _collect_contents(p)
    if not contents:
        return OperationResult(
            ok=False,
            operation="styletransfer",
            error="Need at least one content image (file or folder of images).",
            dry_run=p.dry_run,
        )

    if not p.dry_run:
        from ..pathutil import verify_paths_exist
        missing = verify_paths_exist(contents)
        if missing:
            return OperationResult(
                ok=False,
                operation="styletransfer",
                error=f"Content files not found: {', '.join(missing)}",
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

    multi = len(contents) > 1
    summary = (
        f"styletransfer n={len(contents)} style={style.name} "
        f"strength={p.strength} max_side={p.max_side}"
    )

    planned = [(src, _dest_for(src, p, multi=multi)) for src in contents]

    if p.dry_run:
        lines = [summary, f"Style: {style}"]
        for src, dest in planned:
            lines.append(f"  {Path(src).name} → {dest}")
        return OperationResult(
            ok=True,
            operation="styletransfer",
            output_path=str(planned[-1][1]) if planned else None,
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
        # Warm model once, then stylize each with a pre-allocated unique dest
        try:
            ste.preload()
        except Exception as e:
            return {"ok": False, "error": str(e), "results": [], "output_path": None}

        results = []
        ok_n = 0
        primary = None
        total = len(planned)
        progress_cb(
            f"style transfer: {total} image(s), style={style.name}",
            phase="styletransfer",
            current=0,
            total=total,
            unit="images",
        )
        for i, (src, dest) in enumerate(planned):
            job_control.check_cancelled()
            progress_cb(
                f"image {i + 1}/{total}: {Path(src).name} → {dest.name}",
                phase="styletransfer",
                current=i + 1,
                total=total,
                unit="images",
            )
            # Re-finalize right before write (another job may have taken the name)
            dest_final = finalize_output_path(
                dest,
                source=src,
                default_suffix=p.suffix,
                default_ext=".png",
                allowed_exts=IMAGE_EXTS,
            )
            r = ste.stylize_pair(
                src,
                style,
                dest_final,
                strength=p.strength,
                max_side=p.max_side,
                style_size=p.style_size,
                progress_cb=None,
            )
            results.append(r)
            if r.get("ok"):
                ok_n += 1
                if primary is None:
                    primary = r.get("output_path")
        progress_cb(
            f"style transfer done: {ok_n}/{total} ok",
            phase="done",
            current=total,
            total=total,
            unit="images",
        )
        return {
            "ok": ok_n > 0,
            "ok_count": ok_n,
            "total": total,
            "results": results,
            "output_path": primary,
            "error": None if ok_n > 0 else "All images failed",
        }

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
        "Pass content photo(s) or a folder, plus any style reference image. "
        "Outputs default next to each content as *_styled.png and never overwrite "
        "(auto _0001, _0002, …)."
    ),
    params_model=StyleTransferParams,
    handler=styletransfer,
    tags=["styletransfer", "image", "neural"],
))
