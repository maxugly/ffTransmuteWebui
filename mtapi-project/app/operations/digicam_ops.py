"""
digicam_2000s — early-2000s cheap-camera photo look, image + video.

Image mode: core.process_image direct -> `{stem}_digicam.jpg`.
Video mode: dump -> filters.digicam (per_frame) -> encode -> `{stem}_digicam.mp4`
  (audio preserved via pipeline encode; identical params every frame).

See docs/filter-platform-spec.md.
"""
from __future__ import annotations

import asyncio
import uuid
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

from ..contract import OperationResult, OperationSpec, register
from .. import job_control
from ..frame_range import end_frame_field, start_frame_field
from ..pathutil import finalize_output_path

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".tif", ".tiff", ".webp"}
VIDEO_EXTS = {".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi"}


class DigicamParams(BaseModel):
    model_config = {"extra": "ignore"}

    input_path: str | None = Field(None, description="Single input image or video (global input)")
    output_path: str | None = Field(None, description="Optional explicit output file")
    output_dir: str | None = Field(None, description="Optional output folder")

    # Resolution
    preset: str = Field("vga")
    width: int = Field(640, ge=32, le=1280)
    height: int = Field(480, ge=32, le=1024)
    downscale_method: str = Field("LANCZOS")
    pixelate: int = Field(0, ge=0, le=16)
    # Lens
    blur_type: str = Field("gaussian")
    blur_radius: float = Field(0.7, ge=0, le=5)
    focus_jitter: float = Field(0.0, ge=0, le=3)
    # Color
    contrast: float = Field(0.65, ge=0.2, le=2)
    brightness: float = Field(1.12, ge=0.5, le=2)
    saturation: float = Field(0.8, ge=0, le=2)
    gamma: float = Field(1.0, ge=0.5, le=2.5)
    warm_r: int = Field(22, ge=-50, le=50)
    warm_g: int = Field(12, ge=-50, le=50)
    warm_b: int = Field(-8, ge=-50, le=50)
    tint_strength: float = Field(0.0, ge=0, le=1)
    # Grain
    noise_enabled: bool = Field(True)
    noise_amount: float = Field(22.0, ge=0, le=60)
    chroma_r_amount: float = Field(10.0, ge=0, le=30)
    chroma_b_amount: float = Field(8.0, ge=-20, le=30)
    grain_type: str = Field("gaussian")
    deterministic: bool = Field(True)
    noise_seed: int = Field(2003, ge=0, le=999999)
    # Flash
    flash_enabled: bool = Field(True)
    flash_strength: float = Field(95.0, ge=0, le=200)
    flash_x: float = Field(0.48, ge=0, le=1)
    flash_y: float = Field(0.32, ge=0, le=1)
    flash_radius: float = Field(1.4, ge=0.2, le=3)
    flash_falloff: float = Field(1.8, ge=0.5, le=4)
    shadow_strength: float = Field(42.0, ge=0, le=120)
    vignette_strength: float = Field(0.6, ge=0, le=1.5)
    # CCD defects
    chroma_aberration: float = Field(0.0, ge=0, le=5)
    barrel_distortion: float = Field(0.0, ge=0, le=0.5)
    stuck_pixels: int = Field(0, ge=0, le=20)
    vertical_banding: float = Field(0.0, ge=0, le=5)
    # JPEG
    jpeg_passes: int = Field(2, ge=1, le=5)
    final_quality: int = Field(38, ge=5, le=95)
    subsampling: int = Field(0, ge=0, le=2)
    # Extras
    timestamp_enabled: bool = Field(False)
    timestamp_text: str = Field("2003/10/12 21:42")
    timestamp_pos: Literal["bottom_left", "bottom_right", "top_left"] = Field("bottom_left")
    timestamp_color: str = Field("#FFE600")
    interlace: bool = Field(False)
    scanline_strength: float = Field(0.15, ge=0, le=0.5)

    start_frame: int = start_frame_field()
    end_frame: int = end_frame_field()
    dry_run: bool = False


def _first_input(p: DigicamParams) -> str | None:
    raw = (p.input_path or "").strip()
    if not raw:
        return None
    for line in raw.splitlines():
        s = line.strip()
        if s:
            return s
    return None


def _core_params(p: DigicamParams):
    from ..digicam_core import params_from_dict

    return params_from_dict(p.model_dump())


async def _digicam_video(p: DigicamParams, video_path: str) -> OperationResult:
    """Video path: dump -> shared filters.digicam (per_frame) -> encode."""
    from ..job_workspace import JobWorkspace
    from ..video_pipeline import probe, dump, process, encode, cleanup
    from ..filters.digicam import make_digicam_filter

    input_path = Path(video_path).expanduser().resolve()
    out = finalize_output_path(
        p.output_path or None,
        source=input_path,
        default_suffix="_digicam",
        default_ext=".mp4",
        allowed_exts=VIDEO_EXTS,
        output_dir=p.output_dir or None,
    )
    core = _core_params(p)
    summary = (
        f"digicam_2000s video {input_path.name} "
        f"{core.width}x{core.height} q={core.final_quality} "
        f"frames={p.start_frame}-{p.end_frame if p.end_frame < 999999 else 'end'}"
    )
    if p.dry_run:
        return OperationResult(
            ok=True, operation="digicam_2000s", output_path=str(out),
            dry_run=True, command=summary,
            stdout=f"{summary}\ndump -> filters.digicam (per_frame) -> encode -> {out}\n",
        )
    if not input_path.is_file():
        return OperationResult(
            ok=False, operation="digicam_2000s",
            error=f"Video not found: {input_path}", dry_run=False,
        )
    info = await probe(input_path)
    if info.get("frame_count", 0) <= 0 or info.get("fps", 0) <= 0:
        return OperationResult(
            ok=False, operation="digicam_2000s",
            error=f"Could not probe video (fps={info.get('fps')}, frames={info.get('frame_count')})",
        )
    ws = JobWorkspace(uuid.uuid4().hex[:12], prefix="digicam_")
    success = False
    logs: list[str] = [summary]
    try:
        filter_fn = make_digicam_filter(**p.model_dump())
        dump_info = await dump(
            ws, input_path, start_frame=p.start_frame, end_frame=p.end_frame,
        )
        n_frames = int(dump_info.get("frame_count") or 0)
        fps = float(dump_info.get("fps") or info["fps"] or 24.0)
        logs.append(
            f"dump: {n_frames} frames @ {fps:g} fps "
            f"(src {p.start_frame}-{p.end_frame if p.end_frame < 999999 else 'end'})"
        )
        job_control.report_progress(
            "digicam frames", phase="digicam",
            current=0, total=max(1, n_frames), unit="frames",
        )

        def progress_cb(cur: int, tot: int) -> None:
            job_control.report_progress(
                f"digicam {cur}/{tot}", phase="digicam",
                current=cur, total=tot, unit="frames",
                latest_frame=str(ws.frames_out / f"frame_{cur-1:06d}.png"),
            )

        processed = await process(ws, filter_fn, progress_cb=progress_cb)
        logs.append(f"process: {processed} frames via filters.digicam")
        result_path = await encode(ws, out, fps)
        logs.append(f"Output: {result_path}")
        success = True
        job_control.report_progress(
            "digicam done", phase="done",
            current=processed, total=processed, unit="frames",
        )
        return OperationResult(
            ok=True, operation="digicam_2000s", output_path=str(out),
            dry_run=False, command=summary, stdout="\n".join(logs),
        )
    except job_control.JobCancelled as e:
        return OperationResult(
            ok=False, operation="digicam_2000s", error=str(e),
            dry_run=False, command=summary, stdout="\n".join(logs),
        )
    except Exception as e:
        return OperationResult(
            ok=False, operation="digicam_2000s", error=str(e),
            dry_run=False, command=summary, stdout="\n".join(logs), stderr=str(e),
        )
    finally:
        await cleanup(ws, keep_on_failure=not success)


async def _digicam_image(p: DigicamParams, image_path: str) -> OperationResult:
    from .. import digicam_core as core

    input_path = Path(image_path).expanduser().resolve()
    out = finalize_output_path(
        p.output_path or None,
        source=input_path,
        default_suffix="_digicam",
        default_ext=".jpg",
        allowed_exts={".jpg", ".jpeg"},
        output_dir=p.output_dir or None,
    )
    params = _core_params(p)
    summary = (
        f"digicam_2000s image {input_path.name} "
        f"{params.width}x{params.height} q={params.final_quality}"
    )
    if p.dry_run:
        return OperationResult(
            ok=True, operation="digicam_2000s", output_path=str(out),
            dry_run=True, command=summary,
            stdout=f"{summary}\nWould write {out}\n",
        )
    if not input_path.is_file():
        return OperationResult(
            ok=False, operation="digicam_2000s",
            error=f"Image not found: {input_path}", dry_run=False,
        )
    job_token = job_control.current_token()

    def runner() -> str:
        job_control.bind(job_token)
        job_control.report_progress(
            f"digicam {input_path.name}", phase="digicam",
            current=0, total=1, unit="images",
        )
        result = core.process_image(str(input_path), str(out), params)
        job_control.report_progress(
            "digicam done", phase="done", current=1, total=1,
            unit="images", latest_frame=result,
        )
        return result

    try:
        result = await asyncio.to_thread(runner)
    except job_control.JobCancelled as e:
        return OperationResult(
            ok=False, operation="digicam_2000s", error=str(e),
            dry_run=False, command=summary,
        )
    except Exception as e:
        if "Cancelled by user" in str(e):
            return OperationResult(
                ok=False, operation="digicam_2000s", error="Cancelled by user",
                dry_run=False, command=summary,
            )
        return OperationResult(
            ok=False, operation="digicam_2000s", error=str(e),
            dry_run=False, command=summary, stderr=str(e),
        )
    return OperationResult(
        ok=True, operation="digicam_2000s", output_path=result,
        dry_run=False, command=summary, stdout=f"{summary}\nOutput: {result}\n",
    )


async def digicam_2000s(p: DigicamParams) -> OperationResult:
    src = _first_input(p)
    if not src:
        return OperationResult(
            ok=False, operation="digicam_2000s",
            error="Need an input image or video path.", dry_run=p.dry_run,
        )
    suffix = Path(src).suffix.lower()
    if suffix in VIDEO_EXTS:
        return await _digicam_video(p, src)
    if suffix in IMAGE_EXTS:
        return await _digicam_image(p, src)
    # Unknown extension: let existence decide the error message
    if not Path(src).expanduser().exists():
        return OperationResult(
            ok=False, operation="digicam_2000s",
            error=f"Input not found: {src}", dry_run=p.dry_run,
        )
    return OperationResult(
        ok=False, operation="digicam_2000s",
        error=f"Unsupported input type: {suffix or '(no extension)'}",
        dry_run=p.dry_run,
    )


register(OperationSpec(
    id="digicam_2000s",
    summary="Early-2000s cheap-camera photo look (image + video)",
    description=(
        "VGA squish, soft plastic lens, CCD color, luma/chroma grain, "
        "on-camera flash blowout + vignette, JPEG block passes, optional "
        "date stamp / scanlines. Image -> *_digicam.jpg, video -> *_digicam.mp4."
    ),
    params_model=DigicamParams,
    handler=digicam_2000s,
    tags=["digicam", "image", "video", "filter", "scripts"],
))
