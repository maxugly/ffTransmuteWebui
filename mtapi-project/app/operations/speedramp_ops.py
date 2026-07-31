"""
Speed ramp — exponential spin-up / spin-down via PNG frame remap.

dump → filters.speedramp (directory remap) → encode
No ffmpeg setpts (unreliable). Audio dropped for v1 (remap changes timeline).

See docs/speed-ramp-spec.md and docs/filter-platform-spec.md.
"""
from __future__ import annotations

import math
import os
import uuid
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

from ..contract import OperationResult, OperationSpec, register
from ..pathutil import unique_output_path
from ..shell import ensure_video_output_path


class SpeedRampParams(BaseModel):
    input_path: str = Field(..., description="Source video path")
    output_path: str | None = Field(None, description="Output path; auto-named if omitted")
    direction: Literal["spin_up", "spin_down"] = Field(
        "spin_down",
        description="spin_down = fast→slow, spin_up = slow→fast (UI defaults)",
    )
    duration: float = Field(5.0, gt=0, le=300, description="Target output duration in seconds")
    start_speed: float = Field(4.0, gt=0.01, le=50, description="Speed multiplier at start of ramp")
    end_speed: float = Field(0.333, gt=0.01, le=50, description="Speed multiplier at end of ramp")
    dry_run: bool = Field(False, description="Print plan only")


def _auto_name(input_path: str, direction: str, duration: float) -> str:
    base = os.path.splitext(os.path.basename(input_path))[0]
    dur_str = f"{duration:.1f}".rstrip("0").rstrip(".")
    return os.path.join(
        os.path.dirname(os.path.abspath(input_path)),
        f"{base}_ramp-{direction}_{dur_str}s.mp4",
    )


def _resolve_output(p: SpeedRampParams) -> str:
    if p.output_path:
        out = ensure_video_output_path(p.output_path)
    else:
        out = _auto_name(p.input_path, p.direction, p.duration)
        out = ensure_video_output_path(out)
    return str(unique_output_path(out))


async def speed_ramp(p: SpeedRampParams) -> OperationResult:
    """Frame-remap speed ramp via shared filter platform bookends."""
    from ..job_workspace import JobWorkspace
    from ..video_pipeline import probe, dump, encode, cleanup
    from ..filters.speedramp import compute_curve, run_speedramp_directory

    input_path = Path(p.input_path).expanduser().resolve()
    if not input_path.is_file():
        return OperationResult(
            ok=False, operation="speed_ramp",
            error=f"Input not found: {input_path}", dry_run=p.dry_run,
        )

    output = _resolve_output(p)
    summary = (
        f"speed_ramp {p.direction} {p.start_speed}×→{p.end_speed}× "
        f"duration={p.duration}s (PNG remap)"
    )

    info = await probe(str(input_path))
    fps = float(info.get("fps") or 24.0)
    input_dur = float(info.get("duration") or 0.0)
    if input_dur <= 0 or fps <= 0:
        return OperationResult(
            ok=False, operation="speed_ramp",
            error=f"Could not probe input (dur={input_dur}, fps={fps})",
            dry_run=p.dry_run,
        )

    try:
        curve = compute_curve(
            p.direction, p.duration, p.start_speed, p.end_speed, input_dur, fps,
        )
    except ValueError as e:
        return OperationResult(ok=False, operation="speed_ramp", error=str(e), dry_run=p.dry_run)

    plan = (
        f"{summary}\n"
        f"Input: {input_dur:.2f}s @ {fps:.3g}fps\n"
        f"Curve: {curve['effective_start_speed']:.4g}×→{curve['effective_end_speed']:.4g}× "
        f"(scale={curve['scale']:.4g}"
        f"{', short-source adjust' if curve['end_speed_adjusted'] else ''})\n"
        f"Input needed: {curve['total_input_needed']:.2f}s / available {input_dur:.2f}s\n"
        f"Output frames: {curve['output_frames']} (~{curve['output_frames']/fps:.2f}s)\n"
        f"Path: dump → remap → encode (audio dropped)\n"
        f"Output: {output}\n"
    )

    if p.dry_run:
        return OperationResult(
            ok=True, operation="speed_ramp", output_path=output,
            dry_run=True, command=summary, stdout=plan,
        )

    ws = JobWorkspace(uuid.uuid4().hex[:12], prefix="speedramp_")
    success = False
    logs = [plan.rstrip()]

    try:
        dump_info = await dump(ws, str(input_path))
        logs.append(f"dump: {dump_info['frame_count']} frames")

        meta = run_speedramp_directory(
            ws.frames_in,
            ws.frames_out,
            direction=p.direction,
            duration=p.duration,
            start_speed=p.start_speed,
            end_speed=p.end_speed,
            input_dur=input_dur,
            fps=fps,
        )
        logs.append(
            f"remap: {meta['output_frames']} out frames "
            f"({meta['unique_sources']} unique sources)"
        )

        out_fps = fps
        # Duration-preserving fps if frame count changed vs naive duration*fps
        if meta["output_frames"] > 0 and p.duration > 0:
            out_fps = meta["output_frames"] / p.duration

        result_path = await encode(
            ws, output, out_fps, mux_audio=False, crf=18, preset="fast",
        )
        logs.append(f"Output: {result_path} @ {out_fps:.4g} fps (no audio)")
        success = True

        return OperationResult(
            ok=True, operation="speed_ramp", output_path=str(result_path),
            dry_run=False, command=summary, stdout="\n".join(logs),
        )
    except Exception as e:
        return OperationResult(
            ok=False, operation="speed_ramp", error=str(e),
            dry_run=False, command=summary, stdout="\n".join(logs), stderr=str(e),
        )
    finally:
        await cleanup(ws, keep_on_failure=not success)


register(OperationSpec(
    id="speed_ramp",
    summary="Speed ramp (spin-up / spin-down) with exponential curve",
    description=(
        "Continuous exponential speed ramp via PNG frame remap (not setpts). "
        "spin_down = fast→slow (record winding down); spin_up = slow→fast. "
        "dump → remap → encode. Audio dropped in v1. "
        "Same curve as filters.speedramp / speedramp_png CLI."
    ),
    params_model=SpeedRampParams,
    handler=speed_ramp,
    tags=["speed", "filter", "remap"],
))
