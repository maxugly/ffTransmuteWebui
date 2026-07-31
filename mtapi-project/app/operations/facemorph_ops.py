"""
Face morph — chain face stills into a morph video (multi-source generator).

Writes frames into JobWorkspace + video_pipeline.encode.
dream_mode=after → deepdream_ops video path (filters.deepdream), not legacy PngFramePipeline.
faces_first still uses dream_image per still before morph.
"""
from __future__ import annotations

import asyncio
import shutil
import tempfile
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

from ..contract import OperationResult, OperationSpec, register
from .. import job_control
from . import facemorph_engine as fme

DreamMode = Literal["none", "after", "faces_first"]


class FaceMorphParams(BaseModel):
    input_path: str | None = Field(
        None,
        description="Newline-separated image paths (alternative to image_paths). "
                    "If set, each line is one face image. Used by global image input.",
    )
    image_dir: str | None = Field(
        None,
        description="Directory of face images (sorted alphabetically). Or use image_paths.",
    )
    image_paths: list[str] | None = Field(
        None,
        description="Explicit ordered list of face image paths (overrides image_dir if set).",
    )
    output_path: str | None = Field(
        None,
        description="Output mp4 path; auto next to first image if omitted",
    )
    duration: float = Field(2.0, ge=0.2, le=30.0, description="Seconds per face transition")
    fps: int = Field(30, ge=1, le=120, description="Output frames per second")
    crf: int = Field(18, ge=0, le=51, description="x264 CRF (0=lossless, 18=near-lossless)")
    keep_frames: bool = Field(False, description="Keep intermediate morph PNG frames")
    show_triangles: bool = Field(
        False,
        description="Draw Delaunay triangle wireframe on every morph frame",
    )
    align_faces: bool = Field(
        False,
        description=(
            "Auto-align faces before morphing (FFHQ-style: center nose, "
            "horizontal eyes, crop to square). Uses dlib landmarks + "
            "perspective transform."
        ),
    )
    align_size: int = Field(
        1024, ge=256, le=4096,
        description="Output size for aligned face images (square)",
    )

    # DeepDream integration
    dream_mode: DreamMode = Field(
        "none",
        description=(
            "none = morph only; "
            "after = DeepDream the finished morph video; "
            "faces_first = DeepDream each still, then morph"
        ),
    )
    # Light dream settings when dream_mode != none (reuse deepdream engine)
    dream_model_name: str = Field("inception_v3", description="DeepDream model")
    dream_layer_preset: str = Field("classic", description="DeepDream layer preset")
    dream_iterations: int = Field(10, ge=1, le=100)
    dream_octaves: int = Field(2, ge=1, le=8)
    dream_step: float = Field(0.015, ge=0.0001, le=0.5)
    dream_preview_width: int = Field(
        640, ge=0, le=2048,
        description="Resize for dreaming (0=full). Recommended for faces_first/after.",
    )
    dream_optical_flow: bool = Field(
        True,
        description="When dream_mode=after, use optical-flow temporal coherence on the morph video",
    )
    dream_temporal_blend: float = Field(0.85, ge=0.0, le=1.0)
    dry_run: bool = False


def _collect_images(p: FaceMorphParams, *, allow_missing: bool = False) -> list[str]:
    from ..pathutil import parse_path_list, verify_paths_exist
    if p.input_path:
        paths = parse_path_list(p.input_path)
        if not allow_missing:
            missing = verify_paths_exist(paths)
            if missing:
                return []  # caller reports the missing list
        out = []
        for x in paths:
            path = Path(x).expanduser().resolve()
            if path.is_file() or allow_missing:
                out.append(str(path))
        if out:
            return out
    if p.image_paths:
        out = []
        for x in p.image_paths:
            path = Path(x).expanduser().resolve()
            if path.is_file() or allow_missing:
                out.append(str(path))
        return out
    if p.image_dir:
        d = Path(p.image_dir).expanduser().resolve()
        if d.is_dir():
            return fme.get_image_files(d)
        if allow_missing:
            return []
    return []


def _default_output(images: list[str], dream_mode: str) -> Path:
    first = Path(images[0])
    tag = "morph_dream" if dream_mode != "none" else "morph"
    return first.parent / f"{first.stem}_chain_{tag}.mp4"


async def _facemorph_v2(p: FaceMorphParams, images: list[str]) -> OperationResult:
    """v2 handler using JobWorkspace + VideoPipeline for encode.

    Frame generation stays in facemorph engine; only the encode is migrated.
    Keeps dream_mode support. The sync morph thread writes to workspace.frames_out,
    then the async handler encodes with VideoPipeline.encode().
    """
    from ..job_workspace import JobWorkspace
    from ..video_pipeline import encode as vp_encode
    import uuid

    from ..pathutil import finalize_output_path

    default_path = _default_output(images, p.dream_mode)
    out = finalize_output_path(
        p.output_path or str(default_path),
        source=images[0],
        default_suffix="_chain_morph",
        default_ext=".mp4",
        allowed_exts={".mp4", ".mkv", ".mov", ".webm"},
    )

    summary = (
        f"facemorph n={len(images)} duration={p.duration}s fps={p.fps} crf={p.crf} "
        f"dream_mode={p.dream_mode}"
    )

    if p.dry_run:
        return OperationResult(
            ok=True, operation="facemorph", output_path=str(out),
            dry_run=True, command=summary,
            stdout=f"Command: {summary}\nImages:\n" + "\n".join(images) + f"\nOutput: {out}\n",
        )

    ws = JobWorkspace(uuid.uuid4().hex[:12], prefix="facemorph_")
    success = False
    logs: list[str] = [summary]
    job_token = job_control.current_token()

    def progress_cb(msg: str, **kw):
        logs.append(msg)
        try:
            job_control.report_progress(msg, token=job_token, **kw)
        except Exception:
            pass
        job_control.check_cancelled()

    def _bind_run(fn, *a, **k):
        def runner():
            job_control.bind(job_token)
            return fn(*a, **k)
        return runner

    try:
        work_images = list(images)
        tmp_dream_dir = None

        if p.dream_mode == "faces_first":
            from . import deepdream as dd
            tmp_dream_dir = Path(tempfile.mkdtemp(prefix="mtapi_face_dream_"))
            dreamed: list[str] = []
            for i, src in enumerate(images):
                job_control.check_cancelled()
                progress_cb(
                    f"dream face {i + 1}/{len(images)}: {Path(src).name}",
                    phase="dream-faces",
                    current=i + 1, total=len(images), unit="faces",
                )
                dest = tmp_dream_dir / f"{i:03d}_{Path(src).stem}_dream.png"
                await asyncio.to_thread(
                    _bind_run(
                        dd.dream_image, Path(src), dest,
                        model_name=p.dream_model_name,
                        layer_preset=p.dream_layer_preset,
                        iterations=p.dream_iterations,
                        num_octave=p.dream_octaves, step=p.dream_step,
                        preview_width=p.dream_preview_width or None,
                        progress_cb=None,
                    ),
                )
                dreamed.append(str(dest))
            work_images = dreamed

        morph_out = out if p.dream_mode != "after" else out.with_name(out.stem + "_raw_morph.mp4")

        # Generate frames into workspace.frames_out (using frame_%08d.png pattern
        # as expected by the facemorph engine)
        result = await asyncio.to_thread(
            _bind_run(
                fme.morph_image_list, work_images, morph_out,
                duration=p.duration, fps=p.fps, crf=p.crf,
                keep_frames=p.keep_frames,
                show_triangles=p.show_triangles,
                align_faces=p.align_faces, align_size=p.align_size,
                progress_cb=progress_cb,
                frames_out=ws.frames_out, skip_encode=True,
            ),
        )
        if not result.get("ok"):
            return OperationResult(
                ok=False, operation="facemorph", dry_run=False,
                command=summary, stdout="\n".join(logs),
                error=result.get("error") or "facemorph failed",
            )

        # Encode with VideoPipeline
        final_path = await vp_encode(
            ws, morph_out, p.fps,
            frame_pattern="frame_%08d.png",
            crf=p.crf, mux_audio=False,
        )
        logs.append(f"morph ok: {final_path} ({result.get('total_frames')} frames, {result.get('pairs')} pairs)")
        if result.get("skipped"):
            logs.append("skipped: " + "; ".join(result["skipped"][:12]))

        if p.dream_mode == "after":
            # Reuse filter-platform DeepDream video path (not legacy dream_video/PngFramePipeline)
            from .deepdream_ops import deepdream, DeepDreamParams
            progress_cb(
                "DeepDream on morph video…",
                phase="dream-video", current=0, total=1, unit="pass",
            )
            dream_res = await deepdream(
                DeepDreamParams(
                    input_path=str(final_path),
                    output_path=str(out),
                    media_kind="video",
                    model_name=p.dream_model_name,  # type: ignore[arg-type]
                    layer_preset=p.dream_layer_preset,  # type: ignore[arg-type]
                    iterations=p.dream_iterations,
                    num_octave=p.dream_octaves,
                    step=p.dream_step,
                    preview_width=p.dream_preview_width or 0,
                    temporal_blend=p.dream_temporal_blend,
                    optical_flow=p.dream_optical_flow,
                    keep_audio=False,
                )
            )
            if not dream_res.ok:
                return OperationResult(
                    ok=False, operation="facemorph", dry_run=False,
                    command=summary, stdout="\n".join(logs),
                    error=dream_res.error or "DeepDream after morph failed",
                    stderr=dream_res.stderr,
                )
            if Path(final_path).resolve() != out.resolve() and Path(final_path).is_file():
                try:
                    Path(final_path).unlink()
                except OSError:
                    pass
            final_path = dream_res.output_path or str(out)
            logs.append(f"dream video ok (filters.deepdream): {final_path}")

        if tmp_dream_dir and tmp_dream_dir.is_dir():
            shutil.rmtree(tmp_dream_dir, ignore_errors=True)

        success = True
        return OperationResult(
            ok=True, operation="facemorph", output_path=str(final_path),
            dry_run=False, command=summary,
            stdout="\n".join(logs) + f"\nOutput: {final_path}\n",
        )

    except job_control.JobCancelled as e:
        return OperationResult(
            ok=False, operation="facemorph", dry_run=False,
            command=summary, stdout="\n".join(logs), error=str(e),
        )
    except Exception as e:
        if "Cancelled by user" in str(e):
            return OperationResult(
                ok=False, operation="facemorph", dry_run=False,
                command=summary, stdout="\n".join(logs),
                error="Cancelled by user",
            )
        return OperationResult(
            ok=False, operation="facemorph", dry_run=False,
            command=summary, stdout="\n".join(logs),
            stderr=str(e), error=str(e),
        )
    finally:
        if not p.keep_frames:
            ws.cleanup(keep_on_failure=not success)


async def facemorph(p: FaceMorphParams) -> OperationResult:
    images = _collect_images(p, allow_missing=bool(p.dry_run))
    if p.input_path and not p.dry_run:
        from ..pathutil import parse_path_list, verify_paths_exist
        raw = parse_path_list(p.input_path)
        missing = verify_paths_exist(raw)
        if missing:
            return OperationResult(
                ok=False, operation="facemorph",
                error=f"Files not found: {', '.join(missing)}",
                dry_run=p.dry_run,
            )
    if len(images) < 2:
        return OperationResult(
            ok=False, operation="facemorph",
            error="Need at least 2 face images (image_dir or image_paths).",
            dry_run=p.dry_run,
        )
    return await _facemorph_v2(p, images)


register(OperationSpec(
    id="facemorph",
    summary="Chain face images into a morph video (optional DeepDream)",
    description=(
        "dlib 68-point landmark morph (facemorph package). "
        "dream_mode=none|after|faces_first. "
        "after uses filters.deepdream video path (not legacy PngFramePipeline)."
    ),
    params_model=FaceMorphParams,
    handler=facemorph,
    tags=["facemorph", "video", "deepdream"],
))
