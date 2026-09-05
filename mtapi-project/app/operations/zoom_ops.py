"""
Single-Clip Ops: Zoom / Pan — still → video or video → video.

POST /ops/zoom (op id ``zoom``).

Two engines:
- ``stable`` (default): Pillow box-lerp for stills (same math family as
  zoompan_ops, imported not copied). Video + stable → ok:false in v1.
- ``raw``: single ffmpeg ``scale → [rotate,] zoompan [,hue]`` filter graph,
  faithful to the classic still-loop command. Still inputs use ``-loop 1``;
  video inputs filter in place.

See docs/singleclip-zoom-spec.md.
"""
from __future__ import annotations

import logging
import math
import re
import shutil
import tempfile
import uuid
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

from ..contract import OperationResult, OperationSpec, register
from ..pathutil import finalize_output_path
from ..shell import run_command

_log = logging.getLogger("mtapi")

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".tif", ".tiff", ".webp", ".gif"}
VIDEO_EXTS = {".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi"}

Preset = Literal[
    "custom", "zoom_in", "zoom_out", "targeted", "kenburns",
    "ease_in", "ease_out", "punch", "spiral", "glitch", "hue_cycle",
]
Engine = Literal["stable", "raw"]
Direction = Literal["in", "out"]
Easing = Literal["none", "accel", "decel", "punch"]

_SAFE_CHARS = re.compile(r"^[0-9a-zA-Z_+\-*/()., ]*$")
_SAFE_TOKENS = {
    "on", "in", "iw", "ih", "zoom", "random", "sin", "cos", "sqrt",
    "min", "max", "if", "lt", "gte", "lte", "eq", "not", "mod", "pow",
}


class ZoomParams(BaseModel):
    input_path: str = Field(..., description="Source still image or video clip (absolute path)")
    output_path: str | None = Field(None, description="Output video path; auto-named if omitted")
    engine: Engine = Field("stable", description="stable (Pillow lerp) or raw (ffmpeg zoompan)")
    preset: Preset = Field("zoom_in", description="Named effect preset; custom = use knobs as-is")
    duration_sec: float = Field(3.0, gt=0, le=600)
    fps: float = Field(24.0, gt=0, le=120)
    output_width: int | None = Field(None, ge=16, le=7680)
    output_height: int | None = Field(None, ge=16, le=4320)
    zoom_rate: float = Field(0.02, ge=0.0001, le=1.0)
    direction: Direction = Field("in")
    zoom_cap: float = Field(3.0, ge=0, le=10, description="Max zoom; 0 = no cap")
    prescale: int = Field(4, description="Raw-still pre-scale multiplier")
    pan_x: float = Field(0.0, ge=-64, le=64)
    pan_y: float = Field(0.0, ge=-64, le=64)
    target_x: float | None = Field(None, description="Targeted preset focus X (px)")
    target_y: float | None = Field(None, description="Targeted preset focus Y (px)")
    osc_amp: float = Field(0.0, ge=0, le=500)
    osc_freq: float = Field(10.0, gt=0, le=240)
    rotate_rate: float = Field(0.0, ge=0, le=2.0, description="Spiral rotate deg-ish per frame")
    easing: Easing = Field("none")
    punch_frame: int = Field(20, ge=1, le=3600)
    glitch_amt: float = Field(0.0, ge=0, le=0.5)
    hue_cycle: bool = Field(False)
    hue_rate: float = Field(2.0, gt=0, le=60)
    frame_d: int = Field(1, ge=1, le=5)
    dry_run: bool = Field(False)


def _even(n: float | int) -> int:
    v = max(2, int(round(float(n))))
    return v if v % 2 == 0 else v + 1


def _check_expr(expr: str) -> bool:
    if not expr or not _SAFE_CHARS.match(expr):
        return False
    toks = set(re.findall(r"[A-Za-z_][A-Za-z0-9_]*", expr))
    return toks <= _SAFE_TOKENS


def _centered_xy(pan_x: float, pan_y: float, osc_amp: float, osc_freq: float) -> tuple[str, str]:
    bx, by = "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)"
    if pan_x:
        bx = f"{bx}+on*{pan_x:g}"
    if pan_y:
        by = f"{by}+on*{pan_y:g}"
    if osc_amp:
        f = float(osc_freq) or 10.0
        bx = f"{bx}+sin(on/{f:g})*{osc_amp:g}"
    return bx, by


def build_raw_expressions(p: ZoomParams) -> tuple[str, str, str, str]:
    """Return (z, x, y, extra_vf) for the zoompan graph. Preset wins; custom uses knobs."""
    r = float(p.zoom_rate)
    fps = float(p.fps)
    cx, cy = _centered_xy(float(p.pan_x), float(p.pan_y), float(p.osc_amp), float(p.osc_freq))
    extra = ""
    preset = p.preset if p.preset != "custom" else None

    if preset is None:
        z = f"1+{r:g}*on" if p.direction == "in" else f"{p.zoom_cap:g}-{r:g}*on"
        if p.easing == "accel":
            z = f"1+{r:g}*pow(on/{fps:g},1.5)" if p.direction == "in" else z
        elif p.easing == "decel":
            z = f"1+{r:g}*sqrt(on)" if p.direction == "in" else z
        elif p.easing == "punch":
            z = f"if(lt(on,{int(p.punch_frame)}),1,1+(on-{int(p.punch_frame)})*0.1)"
        x, y = cx, cy
    elif preset == "zoom_in":
        z, x, y = f"1+{r:g}*on", cx, cy
    elif preset == "zoom_out":
        cap = float(p.zoom_cap) or 2.5
        z, x, y = f"{cap:g}-{r:g}*on", cx, cy
    elif preset == "targeted":
        tx = float(p.target_x) if p.target_x is not None else 200.0
        ty = float(p.target_y) if p.target_y is not None else 300.0
        z = f"1+{r:g}*on"
        x, y = f"{tx:g}-(iw/zoom/2)", f"{ty:g}-(ih/zoom/2)"
    elif preset == "kenburns":
        z, x, y = "1+0.005*on", "on*2", "on*1"
    elif preset == "ease_in":
        z, x, y = f"1+{r:g}*pow(on/{fps:g},1.5)", cx, cy
    elif preset == "ease_out":
        z, x, y = f"1+{r:g}*sqrt(on)", cx, cy
    elif preset == "punch":
        z, x, y = f"if(lt(on,{int(p.punch_frame)}),1,1+(on-{int(p.punch_frame)})*0.1)", cx, cy
    elif preset == "spiral":
        z, x, y = f"1+{r:g}*on", cx, cy
        if float(p.rotate_rate) > 0:
            extra = f"rotate=on*{float(p.rotate_rate):g},"
    elif preset == "glitch":
        g = float(p.glitch_amt) or 0.1
        z, x, y = f"1+{r:g}*on+(random(1)-0.5)*{g:g}", cx, cy
    elif preset == "hue_cycle":
        z, x, y = f"1+{r:g}*on", cx, cy
    else:  # pragma: no cover - pydantic constrains presets
        z, x, y = f"1+{r:g}*on", cx, cy

    # Cap (skip for zoom_out base, punch, targeted absolutes are fine to cap too)
    if float(p.zoom_cap) > 0 and preset not in ("zoom_out", "punch") and "min(" not in z:
        z = f"min({z},{float(p.zoom_cap):g})"
    # Glitch flag composes on any preset when knob > 0 and not already random
    if float(p.glitch_amt) > 0 and "random" not in z:
        z = f"{z}+(random(1)-0.5)*{float(p.glitch_amt):g}"
    # Rotate knob composes when preset didn't already set it
    if float(p.rotate_rate) > 0 and "rotate=" not in extra:
        extra = f"rotate=on*{float(p.rotate_rate):g},"
    hue = ""
    if bool(p.hue_cycle) or preset == "hue_cycle":
        hue = f",hue=h=on*{float(p.hue_rate):g}:s=1"
    return z, x, y, extra + "{HUE}"  # placeholder replaced by caller


def build_raw_vf(p: ZoomParams, out_w: int, out_h: int) -> str:
    z, x, y, extra_tpl = build_raw_expressions(p)
    for expr in (z, x, y):
        if not _check_expr(expr):
            raise ValueError(f"Rejected unsafe zoompan expression: {expr!r}")
    hue = ""
    if bool(p.hue_cycle) or p.preset == "hue_cycle":
        hue = f",hue=h=on*{float(p.hue_rate):g}:s=1"
    extra = extra_tpl.replace("{HUE}", "").replace("{hue}", "")
    ps = int(p.prescale) if int(p.prescale) in (2, 4, 8) else 4
    vf = (
        f"scale=iw*{ps}:ih*{ps},{extra}"
        f"zoompan=z='{z}':x='{x}':y='{y}':d={int(p.frame_d)}:s={out_w}x{out_h}:fps={float(p.fps):g}"
        f"{hue}"
    )
    return vf


def _eased_p(p: float, easing: str) -> float:
    p = max(0.0, min(1.0, float(p)))
    if easing == "accel":
        return p ** 1.5
    if easing == "decel":
        return math.sqrt(p)
    return p


async def zoom_run(p: ZoomParams) -> OperationResult:
    from .. import job_control

    src = Path(p.input_path).expanduser()
    try:
        src = src.resolve()
    except OSError:
        pass
    if not src.is_file():
        return OperationResult(ok=False, operation="zoom", error=f"Input not found: {src}", dry_run=p.dry_run)
    is_image = src.suffix.lower() in IMAGE_EXTS
    is_video = src.suffix.lower() in VIDEO_EXTS
    if not (is_image or is_video):
        return OperationResult(
            ok=False, operation="zoom",
            error=f"Expected an image or video file, got: {src.suffix or '(no ext)'}",
            dry_run=p.dry_run,
        )
    if int(p.prescale) not in (2, 4, 8):
        return OperationResult(ok=False, operation="zoom", error="prescale must be 2, 4, or 8", dry_run=p.dry_run)

    n_frames = max(2, int(round(float(p.duration_sec) * float(p.fps))))
    duration = n_frames / float(p.fps)

    # Default output size: probe image, else 960x960 for stills; video keeps source size via vf s=.
    iw = ih = 0
    if is_image:
        try:
            from PIL import Image
            with Image.open(src) as im0:
                iw, ih = im0.convert("RGB").size
        except Exception as e:
            return OperationResult(ok=False, operation="zoom", error=f"Failed to open image: {e}", dry_run=p.dry_run)
    out_w = _even(p.output_width) if p.output_width else (_even(iw) if iw else 960)
    out_h = _even(p.output_height) if p.output_height else (_even(ih) if ih else 960)

    out = finalize_output_path(
        p.output_path, source=src, default_suffix="_zoom",
        default_ext=".mp4", allowed_exts=VIDEO_EXTS,
    )
    summary = (
        f"zoom {src.name} [{p.engine}/{p.preset}] {n_frames}f @{float(p.fps):g}fps "
        f"{duration:.2f}s → {out_w}x{out_h}"
    )

    if p.engine == "stable":
        if not is_image:
            return OperationResult(
                ok=False, operation="zoom", dry_run=p.dry_run, command=summary,
                error="stable engine is still-image only in v1 — switch Engine to raw for video clips",
            )
        if p.rotate_rate > 0 or p.glitch_amt > 0 or p.hue_cycle or p.preset in ("spiral", "glitch", "hue_cycle"):
            return OperationResult(
                ok=False, operation="zoom", dry_run=p.dry_run, command=summary,
                error="rotate/glitch/hue are raw-engine only — switch Engine to raw",
            )
        # Box-lerp plan (import shared math, don't duplicate zoompan_ops).
        plan = f"# stable Pillow lerp {p.preset} over {n_frames} frames\n{summary}"
        if p.dry_run:
            return OperationResult(ok=True, operation="zoom", output_path=str(out), dry_run=True, command=summary, stdout=plan)
        try:
            from PIL import Image
            from .zoompan_ops import _clamp_box, _lerp, _box_tuple, Box as ZBox
        except Exception as e:  # pragma: no cover
            return OperationResult(ok=False, operation="zoom", error=f"stable engine unavailable: {e}", dry_run=p.dry_run)
        job_control.report_progress("zoom render frames", phase="render", current=0, total=n_frames, unit="frames")
        tmp = Path(tempfile.mkdtemp(prefix=f"mtapi_zoom_{uuid.uuid4().hex[:8]}_"))
        frames_dir = tmp / "frames"
        frames_dir.mkdir(parents=True, exist_ok=True)
        try:
            with Image.open(src) as im0:
                img = im0.convert("RGB")
                fiw, fih = img.size
            cap = float(p.zoom_cap) or 2.0
            if p.preset == "zoom_out" or p.direction == "out":
                start = _clamp_box(ZBox(x=fiw / 2 - fiw / cap / 2, y=fih / 2 - fih / cap / 2, w=fiw / cap, h=fih / cap), fiw, fih)
                end = _clamp_box(ZBox(x=0, y=0, w=float(fiw), h=float(fih)), fiw, fih)
            elif p.preset == "targeted" and p.target_x is not None and p.target_y is not None:
                ew, eh = max(2.0, fiw / cap), max(2.0, fih / cap)
                end = _clamp_box(ZBox(x=float(p.target_x) - ew / 2, y=float(p.target_y) - eh / 2, w=ew, h=eh), fiw, fih)
                start = _clamp_box(ZBox(x=0, y=0, w=float(fiw), h=float(fih)), fiw, fih)
            else:
                start = _clamp_box(ZBox(x=0, y=0, w=float(fiw), h=float(fih)), fiw, fih)
                ew, eh = max(2.0, fiw / cap), max(2.0, fih / cap)
                ex = fiw / 2 - ew / 2 + float(p.pan_x) * n_frames / 2
                ey = fih / 2 - eh / 2 + float(p.pan_y) * n_frames / 2
                end = _clamp_box(ZBox(x=ex, y=ey, w=ew, h=eh), fiw, fih)
            easing = p.easing
            if p.preset == "ease_in":
                easing = "accel"
            elif p.preset == "ease_out":
                easing = "decel"
            elif p.preset == "punch":
                easing = "punch"
            denom = max(1, n_frames - 1)
            for i in range(n_frames):
                raw_p = i / denom
                if easing == "punch":
                    hold = min(int(p.punch_frame), n_frames - 1) / denom
                    pe = 0.0 if raw_p < hold else (raw_p - hold) / max(1e-6, 1.0 - hold)
                    pe = pe * pe  # burst
                else:
                    pe = _eased_p(raw_p, easing)
                box = ZBox(x=_lerp(start.x, end.x, pe), y=_lerp(start.y, end.y, pe),
                           w=_lerp(start.w, end.w, pe), h=_lerp(start.h, end.h, pe))
                box = _clamp_box(box, fiw, fih)
                x1, y1, x2, y2 = _box_tuple(box)
                x1 = max(0, min(x1, fiw - 1)); y1 = max(0, min(y1, fih - 1))
                x2 = max(x1 + 1, min(x2, fiw)); y2 = max(y1 + 1, min(y2, fih))
                crop = img.crop((x1, y1, x2, y2))
                frame = crop.resize((out_w, out_h), Image.Resampling.LANCZOS) if crop.size != (out_w, out_h) else crop
                fp = frames_dir / f"frame_{i:06d}.png"
                frame.save(fp, format="PNG", compress_level=1)
                job_control.report_progress(f"zoom frame {i + 1}/{n_frames}", phase="render",
                                            current=i + 1, total=n_frames, unit="frames", latest_frame=str(fp))
            job_control.report_progress("zoom encode", phase="encode", current=0, total=n_frames, unit="frames")
            argv = ["ffmpeg", "-y", "-framerate", str(float(p.fps)), "-i", str(frames_dir / "frame_%06d.png"),
                    "-frames:v", str(n_frames), "-c:v", "libx264", "-preset", "medium",
                    "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(out)]
            code, stdout, stderr = await run_command(argv)
            if code != 0:
                return OperationResult(ok=False, operation="zoom", command=summary, stdout=stdout or "",
                                       stderr=stderr or "", error=f"ffmpeg encode failed (exit {code})")
            if not out.is_file() or out.stat().st_size < 32:
                return OperationResult(ok=False, operation="zoom", command=summary, error="encode produced empty output")
            job_control.report_progress("zoom done", phase="done", current=n_frames, total=n_frames, unit="frames")
            return OperationResult(ok=True, operation="zoom", output_path=str(out), command=summary, stdout=plan)
        except Exception as e:
            _log.exception("zoom stable failed")
            return OperationResult(ok=False, operation="zoom", error=str(e), command=summary)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    # Raw engine.
    try:
        vf = build_raw_vf(p, out_w, out_h)
    except ValueError as e:
        return OperationResult(ok=False, operation="zoom", error=str(e), dry_run=p.dry_run)
    if is_image:
        argv = ["ffmpeg", "-y", "-loop", "1", "-i", str(src), "-vf", vf,
                "-t", str(duration), "-frames:v", str(n_frames),
                "-c:v", "libx264", "-preset", "medium", "-crf", "18",
                "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(out)]
    else:
        argv = ["ffmpeg", "-y", "-i", str(src), "-vf", vf,
                "-frames:v", str(n_frames),
                "-c:v", "libx264", "-preset", "medium", "-crf", "18",
                "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart", str(out)]
    preview = " ".join(argv)
    if p.dry_run:
        return OperationResult(ok=True, operation="zoom", output_path=str(out), dry_run=True,
                               command=preview, stdout=f"{summary}\n{preview}")
    job_control.report_progress("zoom encode (raw)", phase="encode", current=0, total=n_frames, unit="frames")
    code, stdout, stderr = await run_command(argv)
    if code != 0:
        return OperationResult(ok=False, operation="zoom", command=preview, stdout=stdout or "",
                               stderr=stderr or "", error=f"ffmpeg zoom failed (exit {code})")
    if not out.is_file() or out.stat().st_size < 32:
        return OperationResult(ok=False, operation="zoom", command=preview, error="encode produced empty output")
    job_control.report_progress("zoom done", phase="done", current=n_frames, total=n_frames, unit="frames")
    return OperationResult(ok=True, operation="zoom", output_path=str(out), command=preview, stdout=summary)


register(OperationSpec(
    id="zoom",
    summary="Zoom / pan a still or clip (stable lerp or raw ffmpeg zoompan)",
    description=(
        "Single-Clip zoom op: Pillow box-lerp (stills) or raw ffmpeg "
        "scale→zoompan graph with Ken Burns / easing / punch / spiral / "
        "glitch / hue presets. Auto-detects image vs video input."
    ),
    params_model=ZoomParams,
    handler=zoom_run,
    tags=["transmute", "zoom", "ffmpeg", "zoompan"],
))
