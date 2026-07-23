"""
transmute wrapped as one operation per flag.

transmute itself lets you combine flags in one call (e.g. -f -s for a
square-cropped first frame) — that's good CLI ergonomics but it doesn't
map cleanly onto "one typed node, one job," which is the shape we want
for a future graph UI. So the clean operations below are each exactly one
transformation, and `transmute_raw` is the escape hatch for combinations:
pass whatever flags you want and it's a thin pass-through, same as typing
them at the CLI.

Every op mirrors transmute's own CLI contract closely on purpose: input
first, flags, output last, comma-join for multi-input. If you're adding a
new one, copy the closest existing operation rather than inventing a new
shape.
"""
from __future__ import annotations

import os
from typing import Literal

from pydantic import BaseModel, Field

from ..contract import OperationResult, OperationSpec, register
from ..shell import TRANSMUTE, parse_line, run_command

JoinGridMode = Literal["pad", "crop", "stretch"]


def _cwd_for(input_arg: str) -> str | None:
    """transmute auto-names outputs as bare filenames (no directory), so it
    needs to run with cwd set to the input's directory or an auto-named
    output lands wherever the API process happened to start instead of
    next to the source file. Comma-joined multi-input uses the first
    path's directory. Falls back to None (inherit) if nothing resolves."""
    first = input_arg.split(",", 1)[0]
    d = os.path.dirname(os.path.abspath(first))
    return d if os.path.isdir(d) else None


_VIDEO_OUT_EXTS = (".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi")


def _ensure_video_output_path(output_path: str | None) -> str | None:
    """ffmpeg cannot guess a muxer for extensionless paths like '.../1'."""
    if not output_path:
        return output_path
    p = output_path.strip()
    if not p:
        return None
    lower = p.lower()
    if any(lower.endswith(ext) for ext in _VIDEO_OUT_EXTS):
        return p
    # Replace unknown short extension, or append .mp4
    base, ext = os.path.splitext(p)
    if ext and len(ext) <= 6 and ext[1:].isalnum():
        return base + ".mp4"
    return p + ".mp4"


async def _run_transmute(
    operation: str,
    input_arg: str,
    flags: list[str],
    output_path: str | None,
    dry_run: bool,
) -> OperationResult:
    from ..pathutil import unique_output_path

    output_path = _ensure_video_output_path(output_path)
    if output_path:
        # Avoid clobbering prior runs when the UI/user reuses a path
        output_path = str(unique_output_path(output_path))
    argv = [TRANSMUTE, input_arg, *flags]
    if dry_run:
        argv.append("-d")
    if output_path:
        argv.append(output_path)

    code, out, err = await run_command(argv, cwd=_cwd_for(input_arg))
    ok = code == 0
    if output_path:
        resolved_output = output_path
    else:
        parsed = parse_line(out, "Output:")
        cwd = _cwd_for(input_arg)
        resolved_output = os.path.join(cwd, parsed) if (parsed and cwd) else parsed
    return OperationResult(
        ok=ok,
        operation=operation,
        output_path=resolved_output if ok else None,
        dry_run=dry_run,
        command=parse_line(out, "Command:"),
        stdout=out,
        stderr=err,
        error=None if ok else (err.strip() or f"transmute exited {code}"),
    )


# ---------------------------------------------------------------- frames --

class FirstFrameParams(BaseModel):
    input_path: str = Field(..., description="Source video path")
    output_path: str | None = Field(None, description="PNG path; auto-named (<name>_f:00001.png) if omitted")
    quality: int = Field(2, ge=2, le=31, description="2-31, lower is better")
    dry_run: bool = False


async def first_frame(p: FirstFrameParams) -> OperationResult:
    return await _run_transmute("first_frame", p.input_path, ["-f", "-q", str(p.quality)], p.output_path, p.dry_run)


register(OperationSpec(
    id="first_frame",
    summary="Extract the first frame as a PNG",
    description="Wraps `transmute -f`. No scaling.",
    params_model=FirstFrameParams,
    handler=first_frame,
    tags=["transmute", "extract"],
))


class LastFrameParams(BaseModel):
    input_path: str = Field(..., description="Source video path")
    output_path: str | None = Field(None, description="JPG path; auto-named if omitted")
    seconds_from_end: float = Field(0.1, gt=0, description="How far from the end to seek before grabbing the frame")
    quality: int = Field(2, ge=2, le=31, description="2-31, lower is better")
    dry_run: bool = False


async def last_frame(p: LastFrameParams) -> OperationResult:
    return await _run_transmute(
        "last_frame", p.input_path, ["-l", str(p.seconds_from_end), "-q", str(p.quality)], p.output_path, p.dry_run
    )


register(OperationSpec(
    id="last_frame",
    summary="Extract the last frame as a JPG",
    description="Wraps `transmute -l [N]`. N is seconds from the end, default 0.1.",
    params_model=LastFrameParams,
    handler=last_frame,
    tags=["transmute", "extract"],
))


class ExtractAudioParams(BaseModel):
    input_path: str = Field(..., description="Source video path")
    output_path: str | None = Field(None, description="M4A path; auto-named if omitted")
    dry_run: bool = False


async def extract_audio(p: ExtractAudioParams) -> OperationResult:
    return await _run_transmute("extract_audio", p.input_path, ["-a"], p.output_path, p.dry_run)


register(OperationSpec(
    id="extract_audio",
    summary="Pull the audio track out as M4A",
    description="Wraps `transmute -a`. Stream copy, no re-encode.",
    params_model=ExtractAudioParams,
    handler=extract_audio,
    tags=["transmute", "extract"],
))


# ------------------------------------------------------------- geometry --

class SimpleGeometryParams(BaseModel):
    input_path: str = Field(..., description="Source video path")
    output_path: str | None = Field(None, description="Output video path; auto-named if omitted")
    dry_run: bool = False


def _make_simple_geometry_op(op_id: str, flag: str, summary: str, description: str) -> None:
    async def handler(p: SimpleGeometryParams) -> OperationResult:
        return await _run_transmute(op_id, p.input_path, [flag], p.output_path, p.dry_run)

    register(OperationSpec(
        id=op_id,
        summary=summary,
        description=description,
        params_model=SimpleGeometryParams,
        handler=handler,
        tags=["transmute", "geometry"],
    ))


_make_simple_geometry_op("crop_16x9", "-c", "Center-crop to 16:9", "Wraps `transmute -c`. No scaling.")
_make_simple_geometry_op("letterbox_16x9", "-b", "Letterbox (pad) to 16:9", "Wraps `transmute -b`. Black bars, no scaling.")
_make_simple_geometry_op("square_crop", "-s", "Center-crop to a 1:1 square (min side)", "Wraps `transmute -s`. No scaling.")
_make_simple_geometry_op("square_letterbox", "-S", "Letterbox (pad) to a 1:1 square (max side)", "Wraps `transmute -S`. Black bars, no scaling.")
_make_simple_geometry_op("reverse", "-r", "Reverse video and audio", "Wraps `transmute -r`.")


class ExactResParams(BaseModel):
    input_path: str = Field(..., description="Source video path")
    width: int = Field(..., gt=0)
    height: int = Field(..., gt=0)
    output_path: str | None = Field(None, description="Output video path; auto-named if omitted")
    dry_run: bool = False


async def crop_exact(p: ExactResParams) -> OperationResult:
    return await _run_transmute("crop_exact", p.input_path, ["-z", f"{p.width}x{p.height}"], p.output_path, p.dry_run)


register(OperationSpec(
    id="crop_exact",
    summary="Center-crop to an exact WxH",
    description="Wraps `transmute -z WxH`. No scaling — crops, doesn't resize.",
    params_model=ExactResParams,
    handler=crop_exact,
    tags=["transmute", "geometry"],
))


async def stretch_exact(p: ExactResParams) -> OperationResult:
    return await _run_transmute("stretch_exact", p.input_path, ["-x", f"{p.width}x{p.height}"], p.output_path, p.dry_run)


register(OperationSpec(
    id="stretch_exact",
    summary="Stretch to an exact WxH (may distort)",
    description="Wraps `transmute -x WxH`. Scales, so aspect ratio can change.",
    params_model=ExactResParams,
    handler=stretch_exact,
    tags=["transmute", "geometry"],
))


# ------------------------------------------------------ multi-clip ops --

class JoinParams(BaseModel):
    input_paths: list[str] = Field(..., min_length=2, description="Clips to join end-to-end, in order")
    mode: JoinGridMode = Field(
        "pad",
        description=(
            "pad=scale-up keep AR + letterbox only if AR differs; "
            "crop=scale-up keep AR + center crop; "
            "stretch=warp to canvas"
        ),
    )
    aspect: str = Field(
        "auto",
        description=(
            "Target canvas AR: auto|1:1|16:9|3:2|2:3|9:16|W:H|WxH. "
            "auto = shared AR if all match, else largest clip's AR. "
            "Canvas always grows to fit max content size (never downscale content)."
        ),
    )
    durations: list[float | None] | None = Field(
        None,
        description=(
            "Optional per-clip target duration in seconds (same order as input_paths). "
            "null/omit entry = keep native length. Applies temporal stretch via setpts/rubberband (pitch-preserving)."
        ),
    )
    output_path: str | None = Field(None, description="Output path; auto-named (join-<mode>_<W>x<H>.mp4) if omitted")
    dry_run: bool = False


async def join(p: JoinParams) -> OperationResult:
    flags = ["-j", p.mode, "-A", p.aspect or "auto"]
    if p.durations and any(d is not None for d in p.durations):
        # -T 3.0,,5.5  (empty = native)
        parts: list[str] = []
        for d in p.durations:
            if d is None:
                parts.append("")
            else:
                parts.append(str(float(d)))
        # pad length to match inputs
        while len(parts) < len(p.input_paths):
            parts.append("")
        flags.extend(["-T", ",".join(parts[: len(p.input_paths)])])
    return await _run_transmute("join", ",".join(p.input_paths), flags, p.output_path, p.dry_run)


register(OperationSpec(
    id="join",
    summary="Stitch clips end-to-end",
    description=(
        "Wraps `transmute -j MODE -A ASPECT`. Canvas = max content size snapped to "
        "target AR. pad/crop keep aspect (scale up); stretch warps."
    ),
    params_model=JoinParams,
    handler=join,
    tags=["transmute", "multi-clip"],
))


class FitParams(BaseModel):
    input_path: str = Field(..., description="Single source video to reformat")
    mode: JoinGridMode = Field(
        "pad",
        description="pad=letterbox keep AR; crop=center-crop keep AR; stretch=warp",
    )
    aspect: str = Field(
        "auto",
        description="Target canvas AR: auto|1:1|16:9|…|W:H|WxH (same as join -A)",
    )
    output_path: str | None = Field(
        None,
        description="Output path; auto-named next to source if omitted",
    )
    dry_run: bool = False


async def fit(p: FitParams) -> OperationResult:
    """Single-clip canvas fit — same pad/crop/stretch + -A as join, no concat."""
    flags = ["-j", p.mode, "-A", p.aspect or "auto"]
    return await _run_transmute("fit", p.input_path, flags, p.output_path, p.dry_run)


register(OperationSpec(
    id="fit",
    summary="Fit one clip to a canvas (pad / crop / stretch + AR)",
    description=(
        "Wraps single-file `transmute -j MODE -A ASPECT`. Used by Quick Transmute: "
        "auto-names next to the source, same geometry rules as sequence stitch."
    ),
    params_model=FitParams,
    handler=fit,
    tags=["transmute", "geometry", "quick"],
))


class GridParams(BaseModel):
    input_paths: list[str] = Field(..., min_length=4, max_length=4, description="Exactly 4 clips: top-left, top-right, bottom-left, bottom-right")
    mode: JoinGridMode = Field("pad", description="How to reconcile differing resolutions before tiling")
    aspect: str = Field("auto", description="Tile AR: auto|1:1|16:9|… (same as join -A)")
    output_path: str | None = Field(None, description="Output path; auto-named (grid-<mode>_<W>x<H>.mp4) if omitted")
    dry_run: bool = False


async def grid(p: GridParams) -> OperationResult:
    flags = ["-g", p.mode, "-A", p.aspect or "auto"]
    return await _run_transmute("grid", ",".join(p.input_paths), flags, p.output_path, p.dry_run)


register(OperationSpec(
    id="grid",
    summary="Tile 4 clips into a 2x2 grid",
    description="Wraps `transmute -g MODE`. Audio is mixed only if every input clip has an audio track.",
    params_model=GridParams,
    handler=grid,
    tags=["transmute", "multi-clip"],
))


# -------------------------------------------------------- escape hatch --

class RawParams(BaseModel):
    input_arg: str = Field(..., description="Same rules as the CLI's INPUT: a file, a folder, or a comma-joined list")
    flags: list[str] = Field(default_factory=list, description="Raw flags/args exactly as you'd type them, e.g. ['-f', '-s'] for a square-cropped first frame")
    output_path: str | None = Field(None, description="Output path; auto-named if omitted")
    dry_run: bool = False


async def transmute_raw(p: RawParams) -> OperationResult:
    return await _run_transmute("transmute_raw", p.input_arg, p.flags, p.output_path, p.dry_run)


register(OperationSpec(
    id="transmute_raw",
    summary="Pass-through to transmute for flag combinations the named ops don't cover",
    description="E.g. flags=['-f', '-s'] for a square-cropped first frame, or flags=['-r', '-s'] for a reversed square crop. Same mutual-exclusivity rules as the CLI apply.",
    params_model=RawParams,
    handler=transmute_raw,
    tags=["transmute", "advanced"],
))
