"""
Zoompan (Pan & Zoom) — image → video via linear viewport interpolation.

POST /ops/zoompan

Renders N frames by lerping start_box → end_box (pixel space), cropping with
Pillow, then encoding with ffmpeg. Frame-by-frame lerp is intentional: ffmpeg
crop expressions with dynamic w/h/x/y are unreliable across builds and often
look "stuck" on the first crop.

Progress for frame i of N: p = i / (N-1)  (first = start, last = end).

See docs/zoompan-spec.md.
"""
from __future__ import annotations

import logging
import math
import shutil
import tempfile
import uuid
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
    start_box: Box = Field(..., description="Viewport at frame 0")
    end_box: Box = Field(..., description="Viewport at last frame")
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
    dry_run: bool = Field(False, description="Return plan only")

    @model_validator(mode="after")
    def _boxes_positive(self):
        for name, b in (("start_box", self.start_box), ("end_box", self.end_box)):
            if b.w < 2 or b.h < 2:
                raise ValueError(f"{name} too small (need w,h ≥ 2)")
        return self


def _even(n: float | int) -> int:
    v = max(2, int(round(float(n))))
    return v if v % 2 == 0 else v + 1


def _clamp_box(b: Box, iw: int, ih: int) -> Box:
    w = min(max(2.0, float(b.w)), float(iw))
    h = min(max(2.0, float(b.h)), float(ih))
    x = min(max(0.0, float(b.x)), max(0.0, iw - w))
    y = min(max(0.0, float(b.y)), max(0.0, ih - h))
    if x + w > iw:
        x = max(0.0, iw - w)
    if y + h > ih:
        y = max(0.0, ih - h)
    return Box(x=x, y=y, w=w, h=h)


def _lerp(a: float, b: float, p: float) -> float:
    return a + (b - a) * p


def _lerp_box(start: Box, end: Box, p: float, iw: int, ih: int) -> Box:
    """Linear interpolate boxes; p in [0, 1]. Clamp to image."""
    p = max(0.0, min(1.0, float(p)))
    raw = Box(
        x=_lerp(start.x, end.x, p),
        y=_lerp(start.y, end.y, p),
        w=_lerp(start.w, end.w, p),
        h=_lerp(start.h, end.h, p),
    )
    return _clamp_box(raw, iw, ih)


def _box_tuple(b: Box) -> tuple[int, int, int, int]:
    """Integer pixel crop (left, top, right, bottom) for PIL — at least 1×1."""
    x1 = int(math.floor(b.x))
    y1 = int(math.floor(b.y))
    x2 = int(math.ceil(b.x + b.w))
    y2 = int(math.ceil(b.y + b.h))
    if x2 <= x1:
        x2 = x1 + 1
    if y2 <= y1:
        y2 = y1 + 1
    return x1, y1, x2, y2


def _boxes_nearly_equal(a: Box, b: Box, eps: float = 0.75) -> bool:
    return (
        abs(a.x - b.x) < eps
        and abs(a.y - b.y) < eps
        and abs(a.w - b.w) < eps
        and abs(a.h - b.h) < eps
    )


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
        from PIL import Image
    except ImportError:
        return OperationResult(
            ok=False,
            operation="zoompan",
            error="Pillow is required for zoompan frame generation",
            dry_run=p.dry_run,
        )

    try:
        with Image.open(input_path) as im0:
            img = im0.convert("RGB")
            iw, ih = img.size
    except Exception as e:
        return OperationResult(
            ok=False,
            operation="zoompan",
            error=f"Failed to open image: {e}",
            dry_run=p.dry_run,
        )

    start = _clamp_box(p.start_box, iw, ih)
    end = _clamp_box(p.end_box, iw, ih)

    out_w = _even(p.output_width if p.output_width else start.w)
    out_h = _even(p.output_height if p.output_height else start.h)

    n_frames = max(2, int(round(float(p.duration_sec) * float(p.fps))))
    duration = n_frames / float(p.fps)
    denom = max(1, n_frames - 1)

    out = finalize_output_path(
        p.output_path,
        source=input_path,
        default_suffix="_zoompan",
        default_ext=".mp4",
        allowed_exts=VIDEO_EXTS,
    )

    summary = (
        f"zoompan {input_path.name} {n_frames}f @{p.fps:g}fps "
        f"{duration:.3f}s → {out_w}x{out_h} "
        f"start=({start.x:.1f},{start.y:.1f},{start.w:.1f}x{start.h:.1f}) "
        f"end=({end.x:.1f},{end.y:.1f},{end.w:.1f}x{end.h:.1f})"
    )
    if _boxes_nearly_equal(start, end):
        summary += " [WARN: start≈end — output will look static]"

    plan = (
        f"# linear lerp boxes over {n_frames} frames (p=i/{denom})\n"
        f"# PIL crop + LANCZOS resize → {out_w}x{out_h} PNG sequence\n"
        f"# ffmpeg -framerate {p.fps} -i frame_%06d.png → {out}\n"
        f"{summary}"
    )

    if p.dry_run:
        return OperationResult(
            ok=True,
            operation="zoompan",
            output_path=str(out),
            dry_run=True,
            command=summary,
            stdout=plan,
        )

    from .. import job_control

    job_control.report_progress(
        "zoompan render frames",
        phase="render",
        current=0,
        total=n_frames,
        unit="frames",
    )

    tmp = Path(tempfile.mkdtemp(prefix=f"mtapi_zoompan_{uuid.uuid4().hex[:8]}_"))
    frames_dir = tmp / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)

    try:
        # Render every output frame explicitly so motion is exact
        for i in range(n_frames):
            p_i = i / denom
            box = _lerp_box(start, end, p_i, iw, ih)
            x1, y1, x2, y2 = _box_tuple(box)
            # Keep inside image after floor/ceil
            x1 = max(0, min(x1, iw - 1))
            y1 = max(0, min(y1, ih - 1))
            x2 = max(x1 + 1, min(x2, iw))
            y2 = max(y1 + 1, min(y2, ih))

            crop = img.crop((x1, y1, x2, y2))
            if crop.size != (out_w, out_h):
                frame = crop.resize((out_w, out_h), Image.Resampling.LANCZOS)
            else:
                frame = crop
            frame_path = frames_dir / f"frame_{i:06d}.png"
            frame.save(frame_path, format="PNG", compress_level=1)

            if i == 0 or i == n_frames - 1 or (i + 1) % max(1, n_frames // 10) == 0:
                job_control.report_progress(
                    f"zoompan frame {i + 1}/{n_frames}",
                    phase="render",
                    current=i + 1,
                    total=n_frames,
                    unit="frames",
                )

        job_control.report_progress(
            "zoompan encode",
            phase="encode",
            current=0,
            total=n_frames,
            unit="frames",
        )

        pattern = str(frames_dir / "frame_%06d.png")
        argv = [
            "ffmpeg", "-y",
            "-framerate", str(p.fps),
            "-i", pattern,
            "-frames:v", str(n_frames),
            "-c:v", "libx264",
            "-preset", "medium",
            "-crf", "18",
            "-pix_fmt", "yuv420p",
            "-movflags", "+faststart",
            str(out),
        ]
        _log.info("zoompan encode: %s", " ".join(argv))
        code, stdout, stderr = await run_command(argv)
        if code != 0:
            return OperationResult(
                ok=False,
                operation="zoompan",
                output_path=str(out) if out.exists() else None,
                command=summary,
                stdout=stdout or "",
                stderr=stderr or "",
                error=f"ffmpeg encode failed (exit {code})",
            )

        if not out.is_file() or out.stat().st_size < 32:
            return OperationResult(
                ok=False,
                operation="zoompan",
                command=summary,
                error="encode produced empty output",
            )

        job_control.report_progress(
            "zoompan done",
            phase="done",
            current=n_frames,
            total=n_frames,
            unit="frames",
        )

        warn = ""
        if _boxes_nearly_equal(start, end):
            warn = (
                "Start and end viewports are nearly identical — "
                "video will look static. Move the Last box (Zoomed Out) "
                "so it differs from Start."
            )

        return OperationResult(
            ok=True,
            operation="zoompan",
            output_path=str(out),
            command=summary,
            stdout=plan + (("\n" + warn) if warn else ""),
            stderr=warn,
        )
    except Exception as e:
        _log.exception("zoompan failed")
        return OperationResult(
            ok=False,
            operation="zoompan",
            error=str(e),
            command=summary,
        )
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


register(OperationSpec(
    id="zoompan",
    summary="Pan & zoom still image into a video",
    description=(
        "Linearly interpolate between two crop viewports on a still image "
        "(evenly spaced frames) and encode H.264 MP4."
    ),
    params_model=ZoompanParams,
    handler=zoompan_run,
    tags=["image", "video", "ffmpeg", "zoompan"],
))
