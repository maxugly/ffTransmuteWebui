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
import shutil
import uuid
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

from ..contract import OperationResult, OperationSpec, register
from ..shell import TRANSMUTE, ensure_video_output_path, parse_line, run_command

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
    from ..pathutil import unique_output_path

    output_path = ensure_video_output_path(output_path)
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
    target: str | None = Field(
        None,
        description=(
            "Preset id from ENCODE_PRESETS, e.g. 'dnxhr_hq'. "
            "None = legacy H.264 CRF18 via transmute (backward compatible)."
        ),
    )
    use_rife: bool = Field(
        False,
        description=(
            "Interpolate clips below target_fps with RIFE before stitching so the "
            "sequence is smoothly re-timed to exactly target_fps instead of "
            "duplicating frames. RIFEd copies are kept next to their originals "
            "and registered as 'rifed' variants in the media cache."
        ),
    )
    target_fps: float | None = Field(
        None,
        gt=0,
        description=(
            "Target sequence FPS (exact final rate). With use_rife, clips whose "
            "effective fps is below this are RIF-interpolated. Omit for "
            "'max native fps of inputs'. Capped at the RIFE multiplier limit "
            "(128x source fps)."
        ),
    )
    output_path: str | None = Field(None, description="Output path; auto-named (join-<mode>_<W>x<H>.mp4) if omitted")
    dry_run: bool = False


_RIFE_EPS = 1e-6  # float tolerance for "below target fps" checks


def _rife_multiplier(target_fps: float, effective_fps: float) -> int:
    """Smallest power of two (>=2) with effective_fps * m >= target_fps.

    RIFE can only multiply by 2^k, so we overshoot to the next 2^k and let the
    final encode resample down to the exact target_fps (CORRECTED math — the
    old ceil() produced 72/96fps intermediates that leaked a stutter).

    Raises ValueError if the required multiplier exceeds 128 (AGENTS.md rule 8).
    """
    _RIFE_MULTIPLIER_MAX = 128
    m = 2
    while effective_fps * m < target_fps - _RIFE_EPS:
        m *= 2
        if m > _RIFE_MULTIPLIER_MAX:
            raise ValueError(
                f"target_fps={target_fps} needs RIFE multiplier > {_RIFE_MULTIPLIER_MAX}; "
                f"lower target_fps (max ~{_RIFE_MULTIPLIER_MAX * effective_fps:.0f}fps "
                f"for {effective_fps:.0f}fps source)"
            )
    return m


async def _rife_preprocess(
    input_paths: list[str],
    durations: list[float | None] | None,
    target_fps: float | None,
) -> tuple[list[str], float]:
    """Interpolate clips whose effective fps is below the target with RIFE.

    For each clip needing interpolation:
      - dump native frames → run_rife_directory(multiplier) → encode a video-only
        intermediate at effective_fps * multiplier (neutral libx264 crf 18).
      - probe the ORIGINAL for an audio stream: if present, mux it into the RIFE
        video via a single ffmpeg call and persist `<stem>_rifed.mov` NEXT TO the
        original; if silent, persist the video-only output as the variant.
      - register the rifed file as a 'rifed' variant of the original.

    Returns (processed_paths, resolved_target_fps) where processed_paths[i] is
    the rifed file for interpolated clips and the original otherwise.
    """
    from ..job_workspace import JobWorkspace
    from ..video_pipeline import dump, encode, probe, _time_factor
    from ..filters.rife import resolve_rife_bin, run_rife_directory
    from ..media import register_variant

    # Fast fail with a clean message if rife-ncnn-vulkan is missing.
    try:
        resolve_rife_bin()
    except RuntimeError as e:
        raise RuntimeError("RIFE binary not found; install rife-ncnn-vulkan") from e

    infos: list[tuple[float, float, float, bool]] = []
    for i, p in enumerate(input_paths):
        info = await probe(str(Path(p).expanduser()))
        native_fps = float(info.get("fps") or 0.0)
        native_dur = float(info.get("duration") or 0.0)
        has_audio = bool(info.get("has_audio"))
        req_dur = durations[i] if durations and i < len(durations) else None
        # effective fps after temporal stretch (mirrors concat_clips _time_factor)
        eff = native_fps * _time_factor(req_dur, native_dur) if req_dur else native_fps
        infos.append((native_fps, native_dur, eff, has_audio))

    resolved_target = float(target_fps) if target_fps else max(i[2] for i in infos)
    resolved_target = max(resolved_target, 1.0)

    processed: list[str] = list(input_paths)
    for i, p in enumerate(input_paths):
        native_fps, native_dur, eff, has_audio = infos[i]
        if eff >= resolved_target - _RIFE_EPS:
            continue  # already fast enough — no interpolation

        multiplier = _rife_multiplier(resolved_target, eff)
        original = Path(p).expanduser().resolve()
        parent = original.parent
        rifed_path = parent / f"{original.stem}_rifed.mov"

        sub = JobWorkspace(uuid.uuid4().hex[:12], prefix="rife_")
        rife_ok = False
        try:
            await dump(sub, original)
            rife_out = sub.root / "rife_out"
            await run_rife_directory(sub.frames_in, rife_out, multiplier=multiplier)

            intermediate = sub.root / "rife_video.mp4"
            await encode(
                sub, intermediate, eff * multiplier,
                mux_audio=False,
                frame_source_dir=rife_out,
            )

            if has_audio:
                mux_argv = [
                    "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                    "-i", str(intermediate),
                    "-i", str(original),
                    "-map", "0:v:0", "-map", "1:a:0",
                    "-c:v", "copy", "-c:a", "copy",
                    str(rifed_path),
                ]
                code, _, err = await run_command(mux_argv)
                if code != 0:
                    raise RuntimeError(
                        f"ffmpeg rife audio mux failed (exit {code}): {err.strip() or 'no stderr'}"
                    )
            else:
                shutil.copyfile(str(intermediate), str(rifed_path))

            if not rifed_path.is_file():
                raise RuntimeError(f"RIFE variant not written: {rifed_path}")

            await register_variant(
                str(original),
                kind="rifed",
                variant_path=rifed_path,
                detail={
                    "multiplier": multiplier,
                    "target_fps": resolved_target,
                    "has_audio": bool(has_audio),
                },
            )
            processed[i] = str(rifed_path)
            rife_ok = True
        finally:
            sub.cleanup(keep_on_failure=not rife_ok, keep_on_success=False)

    return processed, resolved_target


async def _join_with_preset(
    p: JoinParams,
    *,
    processed_paths: list[str] | None = None,
    rife_target_fps: float | None = None,
) -> OperationResult:
    from ..convert_presets import ENCODE_PRESETS, VIDEO_EXTS
    from ..job_workspace import JobWorkspace
    from ..pathutil import unique_output_path

    target = p.target
    if target not in ENCODE_PRESETS:
        return OperationResult(
            ok=False, operation="join", error=f"Unknown target preset: {target}",
        )
    ep = ENCODE_PRESETS[target]
    ext = (ep.container_ext or ep.container).lower()
    if ext and not ext.startswith("."):
        ext = f".{ext}"

    if p.output_path:
        suggested = Path(p.output_path).expanduser()
        if not suggested.suffix or suggested.suffix.lower() not in VIDEO_EXTS:
            suggested = suggested.with_suffix(ext or ".mp4")
    else:
        first = Path((processed_paths or p.input_paths)[0]).expanduser()
        suggested = first.parent / f"{first.stem}_join_{target}{ext or '.mp4'}"
    out = unique_output_path(suggested)

    inputs = processed_paths if processed_paths is not None else p.input_paths

    summary = f"join {len(inputs)} clips -> {target}"
    if p.dry_run:
        return OperationResult(
            ok=True, operation="join", output_path=str(out), dry_run=True,
            command=summary,
            stdout=f"Command: {summary}\nOutput: {out}\n(dry run — no files written)",
        )

    from ..video_pipeline import concat_clips, dump, encode

    ws = JobWorkspace(uuid.uuid4().hex[:12], prefix="join_")
    success = False
    logs: list[str] = [summary]
    try:
        intermediate = ws.root / "joined_tmp.mkv"
        stitched = await concat_clips(
            ws, inputs, intermediate,
            mode=p.mode, aspect=p.aspect, durations=p.durations,
        )
        dump_info = await dump(ws, intermediate)
        encode_fps = rife_target_fps if rife_target_fps is not None else dump_info["fps"]
        result_path = await encode(
            ws, out, encode_fps,
            encode_preset=ep,
            frame_source_dir=ws.frames_in,
            mux_audio=True,
            silence_on_no_audio=True,
        )
        success = True
        logs.append(f"Stitched {len(p.input_paths)} clips -> {intermediate}")
        logs.append(
            f"Canvas {stitched['width']}x{stitched['height']} @ "
            f"{dump_info['fps']} fps -> {result_path}"
        )
        return OperationResult(
            ok=True, operation="join", output_path=str(result_path),
            command=summary, stdout="\n".join(logs),
        )
    except Exception as e:
        return OperationResult(
            ok=False, operation="join", error=str(e),
            command=summary, stdout="\n".join(logs), stderr=str(e),
        )
    finally:
        ws.cleanup(keep_on_failure=not success)


async def join(p: JoinParams) -> OperationResult:
    if p.use_rife:
        if not p.target:
            return OperationResult(
                ok=False,
                operation="join",
                error=(
                    "use_rife requires a target preset (the legacy bash H.264 "
                    "path cannot consume RIFEd inputs)"
                ),
            )
        try:
            processed_paths, target_fps = await _rife_preprocess(
                p.input_paths, p.durations, p.target_fps
            )
        except Exception as e:
            return OperationResult(ok=False, operation="join", error=str(e))
        return await _join_with_preset(
            p,
            processed_paths=processed_paths,
            rife_target_fps=target_fps,
        )
    if p.target:
        return await _join_with_preset(p)
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
