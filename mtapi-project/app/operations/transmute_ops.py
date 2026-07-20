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


async def _run_transmute(
    operation: str,
    input_arg: str,
    flags: list[str],
    output_path: str | None,
    dry_run: bool,
) -> OperationResult:
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
    mode: JoinGridMode = Field("pad", description="How to reconcile differing resolutions before joining")
    output_path: str | None = Field(None, description="Output path; auto-named (join-<mode>_<W>x<H>.mp4) if omitted")
    dry_run: bool = False


async def join(p: JoinParams) -> OperationResult:
    return await _run_transmute("join", ",".join(p.input_paths), ["-j", p.mode], p.output_path, p.dry_run)


register(OperationSpec(
    id="join",
    summary="Stitch clips end-to-end",
    description="Wraps `transmute -j MODE`. All clips normalized to max(W) x max(H) first.",
    params_model=JoinParams,
    handler=join,
    tags=["transmute", "multi-clip"],
))


class GridParams(BaseModel):
    input_paths: list[str] = Field(..., min_length=4, max_length=4, description="Exactly 4 clips: top-left, top-right, bottom-left, bottom-right")
    mode: JoinGridMode = Field("pad", description="How to reconcile differing resolutions before tiling")
    output_path: str | None = Field(None, description="Output path; auto-named (grid-<mode>_<W>x<H>.mp4) if omitted")
    dry_run: bool = False


async def grid(p: GridParams) -> OperationResult:
    return await _run_transmute("grid", ",".join(p.input_paths), ["-g", p.mode], p.output_path, p.dry_run)


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
