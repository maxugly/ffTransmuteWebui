"""Speed ramp — exponential spin-up / spin-down via PNG frame remap.

kind=directory: reads frames_in (frame_%06d.png), writes frames_out with
skip/duplicate remapping. No ffmpeg setpts.

Shared by /ops/speed_ramp and optional pipeline stage \"speedramp\".
"""
from __future__ import annotations

import math
import shutil
from pathlib import Path
from typing import Any, Literal

from . import register_stage

Direction = Literal["spin_up", "spin_down"]


def compute_curve(
    direction: str,
    duration: float,
    start_speed: float,
    end_speed: float,
    input_dur: float,
    fps: float,
) -> dict[str, Any]:
    """Map each output frame index → source frame index (0-based).

    ``start_speed`` / ``end_speed`` are multipliers at t=0 and t=duration of the
    *output* timeline. Direction only validates intent (spin_down expects
    start>end; spin_up expects start<end) and swaps if the UI left defaults
    inverted.
    """
    S = float(start_speed)
    E = float(end_speed)
    duration = float(duration)
    fps = float(fps)
    input_dur = float(input_dur)

    if duration <= 0 or fps <= 0:
        raise ValueError("duration and fps must be > 0")
    if S <= 0 or E <= 0:
        raise ValueError("speeds must be > 0")

    # Normalize direction vs speeds (UI may leave 4→0.33 with spin_up selected)
    if direction == "spin_up" and S > E:
        S, E = E, S
    elif direction == "spin_down" and S < E:
        S, E = E, S

    if abs(S - E) < 1e-12:
        raise ValueError("start_speed and end_speed must differ")

    if S > E:
        # decelerate: t_in = A * (1 - exp(-k * t_out))
        k = math.log(S / E) / duration
        A = S / k

        def curve_source_time(t_out: float) -> float:
            return A * (1.0 - math.exp(-k * t_out))
    else:
        # accelerate: t_in = A * (exp(k * t_out) - 1)
        k = math.log(E / S) / duration
        A = S / k

        def curve_source_time(t_out: float) -> float:
            return A * (math.exp(k * t_out) - 1.0)

    requested_input_needed = curve_source_time(duration)
    available_input = max(input_dur, 1.0 / fps)
    scale = min(1.0, available_input / max(requested_input_needed, 1e-12))
    adjusted = scale < 1.0 - 1e-12
    effective_S = S * scale
    effective_E = E * scale
    total_input_needed = requested_input_needed * scale

    output_frames = max(1, int(round(duration * fps)))
    max_frame = max(0, int(math.floor(input_dur * fps + 1e-9)) - 1)
    # Prefer actual dumped count if known later — clamp by max_frame for now

    source_frame: list[int] = []
    for out_n in range(output_frames):
        t_out = (out_n / max(output_frames - 1, 1)) * duration
        t_in = scale * curve_source_time(t_out)
        src_n = int(round(t_in * fps))
        src_n = max(0, min(src_n, max_frame))
        source_frame.append(src_n)

    return {
        "output_frames": output_frames,
        "source_frame": source_frame,
        "k": k,
        "A": A,
        "fps": fps,
        "duration": duration,
        "total_input_needed": total_input_needed,
        "requested_input_needed": requested_input_needed,
        "effective_start_speed": effective_S,
        "effective_end_speed": effective_E,
        "scale": scale,
        "end_speed_adjusted": adjusted,
        "input_available": input_dur,
        "input_frames_available": max_frame + 1,
        "start_speed": S,
        "end_speed": E,
        "direction": direction,
    }


def remap_frames(
    src_dir: Path | str,
    dst_dir: Path | str,
    source_frame: list[int],
    *,
    src_pattern: str = "frame_{:06d}.png",
    dst_pattern: str = "frame_{:06d}.png",
) -> dict[str, Any]:
    """Copy/duplicate source PNGs into dst sequence per source_frame map."""
    src = Path(src_dir)
    dst = Path(dst_dir)
    dst.mkdir(parents=True, exist_ok=True)

    # Discover available frames
    available = sorted(src.glob("frame_*.png"))
    if not available:
        available = sorted(src.glob("*.png"))
    if not available:
        raise RuntimeError(f"No PNG frames in {src}")

    # Build index → path (prefer frame_%06d.png)
    by_idx: dict[int, Path] = {}
    for p in available:
        stem = p.stem
        if stem.startswith("frame_"):
            try:
                by_idx[int(stem.split("_", 1)[1])] = p
                continue
            except ValueError:
                pass
        # fallback: enumerate order
    if not by_idx:
        for i, p in enumerate(available):
            by_idx[i] = p

    max_src = max(by_idx.keys())
    written = 0
    for out_n, src_n in enumerate(source_frame):
        src_n = max(0, min(int(src_n), max_src))
        # walk down if hole
        while src_n not in by_idx and src_n > 0:
            src_n -= 1
        if src_n not in by_idx:
            src_n = min(by_idx.keys())
        out_path = dst / dst_pattern.format(out_n)
        shutil.copy2(by_idx[src_n], out_path)
        written += 1

    return {
        "output_frames": written,
        "unique_sources": len(set(source_frame)),
        "src_dir": str(src),
        "dst_dir": str(dst),
    }


def run_speedramp_directory(
    src_dir: Path | str,
    dst_dir: Path | str,
    *,
    direction: str = "spin_down",
    duration: float = 5.0,
    start_speed: float = 4.0,
    end_speed: float = 0.333,
    input_dur: float,
    fps: float,
) -> dict[str, Any]:
    """Directory stage body: curve + remap. Returns curve meta + remap stats."""
    curve = compute_curve(
        direction, duration, start_speed, end_speed, input_dur, fps,
    )
    # Clamp source indices to actual dumped frame count
    src = Path(src_dir)
    n_dumped = len(list(src.glob("frame_*.png"))) or len(list(src.glob("*.png")))
    if n_dumped > 0:
        max_i = n_dumped - 1
        curve["source_frame"] = [min(s, max_i) for s in curve["source_frame"]]
        curve["input_frames_available"] = n_dumped

    remap = remap_frames(src_dir, dst_dir, curve["source_frame"])
    return {**curve, **remap, "frame_count_out": remap["output_frames"]}


def make_speedramp_directory_fn(
    *,
    direction: str = "spin_down",
    duration: float = 5.0,
    start_speed: float = 4.0,
    end_speed: float = 0.333,
    input_dur: float | None = None,
    fps: float | None = None,
    **_extra: Any,
):
    """Factory for pipeline. Requires input_dur + fps (or set before run)."""

    async def directory_fn(src_dir: Path, dst_dir: Path) -> dict[str, Any]:
        # Probe duration/fps from metadata if not provided — caller should pass
        idur = input_dur
        ffps = fps
        if idur is None or ffps is None:
            # Estimate from frame count at 24fps fallback
            n = len(list(Path(src_dir).glob("frame_*.png")))
            ffps = ffps or 24.0
            idur = idur if idur is not None else (n / ffps if n else 1.0)
        return run_speedramp_directory(
            src_dir,
            dst_dir,
            direction=direction,
            duration=duration,
            start_speed=start_speed,
            end_speed=end_speed,
            input_dur=float(idur),
            fps=float(ffps),
        )

    directory_fn.kind = "directory"  # type: ignore[attr-defined]
    directory_fn.stage_name = "speedramp"  # type: ignore[attr-defined]
    return directory_fn


register_stage("speedramp", make_speedramp_directory_fn)
