"""
Speed ramp — continuous variable-speed ramp via ffmpeg setpts/asetpts.

Single clip in, exponential speed curve, two directions:
  spin_down = starts fast (4x), winds down to slow (1/3x)
  spin_up   = starts slow (1/3x), winds up to fast (4x)

Does NOT go through the transmute bash script — pure ffmpeg directly
via shell.run_command. No looping: if input is too short for the
requested parameters, output is proportionally shorter.
"""
from __future__ import annotations

import math
import os
from typing import Literal

from pydantic import BaseModel, Field

from ..contract import OperationResult, OperationSpec, register
from ..pathutil import unique_output_path
from ..shell import ensure_video_output_path, probe_duration, run_command


class SpeedRampParams(BaseModel):
    input_path: str = Field(..., description="Source video path")
    output_path: str | None = Field(None, description="Output path; auto-named if omitted")
    direction: Literal["spin_up", "spin_down"] = Field(
        "spin_down",
        description="spin_down = fast→slow (4x→⅓x), spin_up = slow→fast (⅓x→4x)",
    )
    duration: float = Field(5.0, gt=0, le=300, description="Target output duration in seconds")
    start_speed: float = Field(4.0, gt=0.01, le=50, description="Speed multiplier at start of ramp")
    end_speed: float = Field(0.333, gt=0.01, le=50, description="Speed multiplier at end of ramp")
    dry_run: bool = Field(False, description="Print command only")


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
    """Apply a continuous exponential speed ramp to a single clip."""
    S, E = p.start_speed, p.end_speed
    if p.direction == "spin_up":
        if S == 4.0 and E == 0.333:
            S, E = 0.333, 4.0
        else:
            S, E = p.end_speed, p.start_speed

    if S <= 0 or E <= 0 or S == E:
        return OperationResult(ok=False, operation="speed_ramp",
                               error="start_speed and end_speed must be > 0 and different")

    input_dur = await probe_duration(p.input_path)
    if input_dur <= 0:
        return OperationResult(ok=False, operation="speed_ramp",
                               error="Could not determine input duration")

    # Exponential curve: T_in = A * (1 - exp(-k * T_out))  for spin_down
    #                  T_in = A * (exp(k * T_out) - 1)     for spin_up
    # where A = S/k, and k determines the rate.
    #
    # The setpts filter needs the INVERSE: T_out = f(T_in).
    # For spin_down: T_out = -log(1 - T_in/A) / k
    # For spin_up:   T_out =  log(1 + T_in/A) / k

    if p.direction == "spin_down":
        k = math.log(S / E) / p.duration
        A = S / k
        T_needed = A * (1 - math.exp(-k * p.duration))
        expr_v = f"-log(1-PTS*TB/{A})/({k}*TB)"
    else:
        k = math.log(E / S) / p.duration
        A = S / k
        T_needed = A * (math.exp(k * p.duration) - 1)
        expr_v = f"log(1+PTS*TB/{A})/({k}*TB)"
    expr_a = expr_v

    # If input is too short for the requested curve, auto-derive end_speed
    # so the ramp consumes exactly the available footage.
    derived_e = None
    if input_dur >= T_needed:
        actual_out = p.duration
    else:
        # Solve for k where T_needed = input_dur with S and D fixed.
        # T_needed = (S - E)*D / ln(S/E) = input_dur  (spin_down)
        # Binary search for E such that the integral equals input_dur.
        lo, hi = (1e-8, S - 1e-8) if p.direction == "spin_down" else (S + 1e-8, 50.0)
        for _ in range(60):
            mid = (lo + hi) / 2
            ratio = S / mid if p.direction == "spin_down" else mid / S
            if ratio <= 1:
                lo = mid; continue
            T_est = (abs(S - mid) * p.duration) / math.log(ratio)
            if T_est < input_dur:
                lo = mid
            else:
                hi = mid
        derived_e = (lo + hi) / 2
        k2 = math.log(S / derived_e) / p.duration if p.direction == "spin_down" else math.log(derived_e / S) / p.duration
        A2 = S / k2
        actual_out = p.duration
        if p.direction == "spin_down":
            expr_v = f"-log(1-PTS*TB/{A2})/({k2}*TB)"
        else:
            expr_v = f"log(1+PTS*TB/{A2})/({k2}*TB)"
        expr_a = expr_v

    # Probe source fps for output frame rate (match source, capped)
    source_fps = await _probe_fps(p.input_path)
    out_fps = int(max(source_fps, 1))

    output = _resolve_output(p)

    argv = [
        "ffmpeg", "-y",
        "-vsync", "0",
        "-i", p.input_path,
        "-filter:v", f"setpts='{expr_v}',fps={out_fps}",
        "-filter:a", f"asetpts='{expr_a}'",
        "-shortest",
        "-c:v", "libx264", "-preset", "fast", "-crf", "23",
        "-c:a", "aac", "-b:a", "128k",
        output,
    ]

    cmd_str = " ".join(argv)

    if p.dry_run:
        return OperationResult(
            ok=True, operation="speed_ramp",
            dry_run=True, command=cmd_str, output_path=output,
            stdout=(
                f"Command: {cmd_str}\n"
                f"Output: {output}\n"
                f"Input: {input_dur:.2f}s  Target: {p.duration:.1f}s"
                + (f"  Derived end_speed: {derived_e:.4f}x" if derived_e else f"  Source needed: {T_needed:.2f}s")
                + f"  FPS: {out_fps}"
            ),
        )

    code, out, err = await run_command(argv)
    ok = code == 0
    return OperationResult(
        ok=ok, operation="speed_ramp",
        output_path=output if ok else None,
        dry_run=False, command=cmd_str,
        stdout=out, stderr=err,
        error=(err.strip() or f"ffmpeg exited {code}") if not ok else None,
    )


# TODO: remove — use app.probe.probe_fps directly
async def _probe_fps(path: str) -> float:
    from ..probe import probe_fps
    return await probe_fps(path, default=30.0)


register(OperationSpec(
    id="speed_ramp",
    summary="Speed ramp (spin-up / spin-down) with exponential curve",
    description=(
        "Applies a continuous variable-speed ramp to a single clip. "
        "Speed changes exponentially from start_speed to end_speed over "
        "the target duration. Spin-down = record winding down (4x→⅓x). "
        "Spin-up = record winding up (⅓x→4x). Audio pitch follows the speed curve. "
        "No looping — output is shorter if input is insufficient."
    ),
    params_model=SpeedRampParams,
    handler=speed_ramp,
    tags=["transmute", "speed"],
))
