"""
Zoompan (Pan & Zoom) — image → video via interpolated crop viewports.

POST /ops/zoompan

Takes a still image and two crop boxes (start / end). Renders a smooth
pan/zoom between them using ffmpeg crop expressions + scale (more reliable
than the zoompan filter for arbitrary boxes).

See docs/zoompan-spec.md.
"""
from __future__ import annotations

import logging
from pathlib import Path

from pydantic import BaseModel, Field, field_validator, model_validator

from ..contract import OperationResult, OperationSpec, register
from ..pathutil import finalize_output_path
from ..shell import run_command

_log = logging.getLogger("mtapi")

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".tif", ".tiff", ".webp", ".gif"}
VIDEO_EXTS = {".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi"}


class Box(BaseModel):
    """Crop rectangle in source image pixels (top-left origin)."""

    x: float = Field(..., description="Left edge (pixels)")
    y: float = Field(..., description="Top edge (pixels)")
    w: float = Field(..., gt=0, description="Width (pixels)")
    h: float = Field(..., gt=0, description="Height (pixels)")

    @field_validator("x", "y", "w", "h", mode="before")
    @classmethod
    def _num(cls, v):
        return float(v)


class ZoompanParams(BaseModel):
    input_path: str = Field(..., description="Source still image (absolute path)")
    start_box: Box = Field(..., description="Viewport at t=0")
    end_box: Box = Field(..., description="Viewport at t=duration")
    duration_sec: float = Field(5.0, gt=0, le=600, description="Output duration in seconds")
    fps: float = Field(24.0, gt=0, le=120, description="Output frame rate")
    output_path: str | None = Field(None, description="Output video path; auto-named if omitted")
    output_width: int | None = Field(
        None,
        ge=16,
        le=7680,
        description="Output width (even). Default = start_box.w (rounded even).",
    )
    output_height: int | None = Field(
        None,
        ge=16,
        le=4320,
        description="Output height (even). Default = start_box.h (rounded even).",
    )
    dry_run: bool = Field(False, description="Return ffmpeg argv only")

    @model_validator(mode="after")
    def _boxes_positive(self):
        for name, b in (("start_box", self.start_box), ("end_box", self.end_box)):
            if b.w < 2 or b.h < 2:
                raise ValueError(f"{name} too small (need w,h ≥ 2)")
        return self


def _even(n: float | int) -> int:
    v = max(2, int(round(float(n))))
    return v if v % 2 == 0 else v + 1


async def _probe_image_size(path: Path) -> tuple[int, int]:
    code, out, err = await run_command([
        "ffprobe", "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height",
        "-of", "csv=p=0",
        str(path),
    ])
    if code != 0:
        raise RuntimeError(f"ffprobe failed: {err or out}")
    line = (out or "").strip().split("\n")[0].strip()
    parts = [p.strip() for p in line.replace(",", "x").split("x") if p.strip()]
    if len(parts) < 2:
        # csv may be "320,240"
        parts = [p.strip() for p in line.split(",") if p.strip()]
    if len(parts) < 2:
        raise RuntimeError(f"Could not parse image size from ffprobe: {line!r}")
    return int(parts[0]), int(parts[1])


def _clamp_box(b: Box, iw: int, ih: int) -> Box:
    w = min(max(2.0, float(b.w)), float(iw))
    h = min(max(2.0, float(b.h)), float(ih))
    x = min(max(0.0, float(b.x)), max(0.0, iw - w))
    y = min(max(0.0, float(b.y)), max(0.0, ih - h))
    # re-clamp if rounding pushed past edge
    if x + w > iw:
        x = max(0.0, iw - w)
    if y + h > ih:
        y = max(0.0, ih - h)
    return Box(x=x, y=y, w=w, h=h)


def _build_filter(
    start: Box,
    end: Box,
    n_frames: int,
    out_w: int,
    out_h: int,
) -> str:
    """
    Linearly interpolate crop box over frame index n, then scale.

    progress p = n / max(1, n_frames-1)  (0 on first frame, 1 on last).
    Prefer n-based exprs over t — more reliable at filter init than min(1,t/D).
    """
    denom = max(1, int(n_frames) - 1)
    # p = n/denom  (no nested commas → no filtergraph escaping headaches)
    p = f"n/{denom}"
    sx, sy, sw, sh = float(start.x), float(start.y), float(start.w), float(start.h)
    ex, ey, ew, eh = float(end.x), float(end.y), float(end.w), float(end.h)
    # Keep expressions simple (ffmpeg crop rejects some nested max/min at config)
    w_expr = f"{sw}+({ew - sw})*{p}"
    h_expr = f"{sh}+({eh - sh})*{p}"
    x_expr = f"{sx}+({ex - sx})*{p}"
    y_expr = f"{sy}+({ey - sy})*{p}"
    crop = f"crop=w='{w_expr}':h='{h_expr}':x='{x_expr}':y='{y_expr}'"
    scale = f"scale={out_w}:{out_h}:flags=lanczos"
    return f"{crop},{scale},format=yuv420p"


def _build_argv(
    input_path: Path,
    out: Path,
    vf: str,
    fps: float,
    n_frames: int,
) -> list[str]:
    return [
        "ffmpeg", "-y",
        "-loop", "1",
        "-framerate", str(fps),
        "-i", str(input_path),
        "-vf", vf,
        "-frames:v", str(n_frames),
        "-r", str(fps),
        "-c:v", "libx264",
        "-preset", "medium",
        "-crf", "18",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        str(out),
    ]


async def zoompan_run(p: ZoompanParams) -> OperationResult:
    input_path = Path(p.input_path).expanduser().resolve()
    if not input_path.is_file():
        return OperationResult(
            ok=False,
            operation="zoompan",
            error=f"Input not found: {input_path}",
            dry_run=p.dry_run,
        )
    if input_path.suffix.lower() not in IMAGE_EXTS:
        return OperationResult(
            ok=False,
            operation="zoompan",
            error=f"Expected an image file, got: {input_path.suffix or '(no ext)'}",
            dry_run=p.dry_run,
        )

    try:
        iw, ih = await _probe_image_size(input_path)
    except Exception as e:
        return OperationResult(
            ok=False,
            operation="zoompan",
            error=str(e),
            dry_run=p.dry_run,
        )

    start = _clamp_box(p.start_box, iw, ih)
    end = _clamp_box(p.end_box, iw, ih)

    out_w = _even(p.output_width if p.output_width else start.w)
    out_h = _even(p.output_height if p.output_height else start.h)

    n_frames = max(2, int(round(p.duration_sec * p.fps)))
    # snap duration to frame count for clean encode
    duration = n_frames / float(p.fps)

    out = finalize_output_path(
        p.output_path,
        source=input_path,
        default_suffix="_zoompan",
        default_ext=".mp4",
        allowed_exts=VIDEO_EXTS,
    )

    vf = _build_filter(start, end, n_frames, out_w, out_h)
    argv = _build_argv(input_path, out, vf, p.fps, n_frames)
    summary = (
        f"zoompan {input_path.name} {n_frames}f @{p.fps:g}fps "
        f"{duration:.3f}s → {out_w}x{out_h} "
        f"start=({start.x:.0f},{start.y:.0f},{start.w:.0f}x{start.h:.0f}) "
        f"end=({end.x:.0f},{end.y:.0f},{end.w:.0f}x{end.h:.0f})"
    )

    if p.dry_run:
        return OperationResult(
            ok=True,
            operation="zoompan",
            output_path=str(out),
            dry_run=True,
            command=summary,
            stdout=" ".join(argv),
        )

    from .. import job_control
    job_control.report_progress(
        "zoompan encode",
        phase="encode",
        current=0,
        total=n_frames,
        unit="frames",
    )

    _log.info("zoompan: %s", " ".join(argv))
    code, stdout, stderr = await run_command(argv)
    if code != 0:
        return OperationResult(
            ok=False,
            operation="zoompan",
            output_path=str(out) if out.exists() else None,
            command=summary,
            stdout=stdout or "",
            stderr=stderr or "",
            error=f"ffmpeg failed (exit {code})",
            dry_run=False,
        )

    if not out.is_file() or out.stat().st_size < 32:
        return OperationResult(
            ok=False,
            operation="zoompan",
            command=summary,
            stdout=stdout or "",
            stderr=stderr or "",
            error="ffmpeg reported success but output is missing or empty",
        )

    job_control.report_progress(
        "zoompan done",
        phase="done",
        current=n_frames,
        total=n_frames,
        unit="frames",
    )

    return OperationResult(
        ok=True,
        operation="zoompan",
        output_path=str(out),
        command=summary,
        stdout=stdout or "",
        stderr=stderr or "",
    )


register(OperationSpec(
    id="zoompan",
    summary="Pan & zoom still image into a video",
    description=(
        "Interpolate between two crop viewports on a single still image and "
        "encode an H.264 MP4 (ffmpeg crop + scale)."
    ),
    params_model=ZoompanParams,
    handler=zoompan_run,
    tags=["image", "video", "ffmpeg", "zoompan"],
))
