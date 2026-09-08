"""PTS-aware RIFE directory stage — interpolate from true timestamps.

For genuinely VFR sources, CFR-first resampling destroys timing (duplicates
compress true gaps, drops widen them) and the model can't recover it. This
stage instead reads the real per-frame PTS sidecar, brackets each output
timestamp with its true source pair, and calls single-pair
`rife-ncnn-vulkan -s t` at the (quantized) fractional position.

kind=directory (not per_frame). See docs/pts-aware-rife-spec.md.
"""
from __future__ import annotations

import bisect
import shutil
import statistics
from pathlib import Path
from typing import Any

from .. import job_control
from . import register_stage
from .rife import run_rife_single_pair

#: A target falling inside a gap wider than this × median gap is treated as a
#: segment boundary (cut/edit) — copy the nearest endpoint, never morph across.
PTS_GAP_SEGMENT_FACTOR = 4.0


def quantize_timestep(t: float, step: float) -> float:
    """Snap fractional position `t` in [0,1] to the `step` grid.

    `step <= 0` → exact `t`. Otherwise nearest grid point clamped to [0,1].
    """
    t = min(1.0, max(0.0, float(t)))
    s = float(step)
    if s <= 0:
        return t
    q = round(t / s) * s
    # Round-trip through the grid then clamp (avoids 1.0000002iotas).
    return min(1.0, max(0.0, q))


def plan_rife_pts(
    pts: list[float],
    target_fps: float,
    t_step: float = 0.25,
) -> dict[str, Any]:
    """Pure timeline plan: targets → (action, pair, t_q) without inference.

    Returns {"targets": [{"t": T, "action": "copy"|"infer",
    "a": idx, "b": idx, "t_q": float}...], "num_targets": N,
    "inferences": K, "copies": C}.
    Shared by the stage (execute) and op dry-runs (count only).
    """
    f = float(target_fps)
    if f <= 0:
        raise ValueError(f"target_fps must be > 0, got {target_fps!r}")
    times = [float(v) for v in (pts or [])]
    if len(times) < 1:
        raise ValueError("plan_rife_pts needs at least 1 PTS value")

    if len(times) == 1:
        return {
            "targets": [{"t": times[0], "action": "copy", "a": 0, "b": 0, "t_q": 0.0}],
            "num_targets": 1, "inferences": 0, "copies": 1,
        }

    gaps = [b - a for a, b in zip(times, times[1:])]
    med = statistics.median(gaps) if gaps else 0.0
    seg_limit = PTS_GAP_SEGMENT_FACTOR * med if med > 0 else float("inf")

    start, end = times[0], times[-1]
    num = max(1, int(round((end - start) * f)))
    targets: list[dict[str, Any]] = []
    inferences = 0
    copies = 0
    for i in range(num):
        T = start + i / f
        if T <= times[0]:
            targets.append({"t": T, "action": "copy", "a": 0, "b": 0, "t_q": 0.0})
            copies += 1
            continue
        if T >= times[-1]:
            n = len(times) - 1
            targets.append({"t": T, "action": "copy", "a": n, "b": n, "t_q": 0.0})
            copies += 1
            continue
        j = bisect.bisect_right(times, T) - 1
        j = min(max(j, 0), len(times) - 2)
        a, b = j, j + 1
        gap = times[b] - times[a]
        if gap > seg_limit:
            # Cut/edit boundary — nearest endpoint, no morph.
            near = a if (T - times[a]) <= (times[b] - T) else b
            targets.append({"t": T, "action": "copy", "a": near, "b": near, "t_q": 0.0})
            copies += 1
            continue
        t = (T - times[a]) / gap if gap > 0 else 0.0
        t_q = quantize_timestep(t, t_step)
        if t_q <= 0.0:
            targets.append({"t": T, "action": "copy", "a": a, "b": a, "t_q": 0.0})
            copies += 1
        elif t_q >= 1.0:
            targets.append({"t": T, "action": "copy", "a": b, "b": b, "t_q": 1.0})
            copies += 1
        else:
            targets.append({"t": T, "action": "infer", "a": a, "b": b, "t_q": t_q})
            inferences += 1

    return {
        "targets": targets,
        "num_targets": num,
        "inferences": inferences,
        "copies": copies,
    }


def _sorted_frame_pngs(directory: Path) -> list[Path]:
    frames = sorted(directory.glob("frame_*.png"))
    if not frames:
        frames = sorted(directory.glob("*.png"))
    return frames


async def run_rife_pts_directory(
    src_dir: Path | str,
    dst_dir: Path | str,
    *,
    target_fps: float,
    pts: list[float],
    model: str = "rife-v4.6",
    tta: bool = False,
    uhd: bool = False,
    t_step: float = 0.25,
) -> dict[str, Any]:
    """Execute a PTS-aware interpolation plan over dumped PNGs.

    `pts` is the presentation-sorted sidecar from `video_pipeline.pts_map`
    (same frame range as the dump). PNG index i ↔ pts[i] — asserted, not
    trusted. Returns {frame_count_in, frame_count_out, inferences, copies,
    command}.
    """
    src = Path(src_dir).resolve()
    dst = Path(dst_dir).resolve()
    dst.mkdir(parents=True, exist_ok=True)

    frames = _sorted_frame_pngs(src)
    if not frames:
        raise RuntimeError(f"No PNG frames in {src}")
    times = [float(v) for v in (pts or [])]
    if len(times) != len(frames):
        raise RuntimeError(
            f"PTS/PNG count mismatch: {len(times)} timestamps vs "
            f"{len(frames)} frames in {src}"
        )

    plan = plan_rife_pts(times, float(target_fps), t_step)
    todo = plan["targets"]
    total = len(todo)
    if total <= 0:
        raise RuntimeError("PTS plan produced no output targets")

    memo: dict[tuple[int, int, float], Path] = {}
    done = 0
    token = job_control.current_token()

    for i, item in enumerate(todo):
        job_control.check_cancelled()
        out = dst / f"frame_{i:06d}.png"
        if item["action"] == "copy":
            shutil.copy2(str(frames[int(item["a"])]), str(out))
        else:
            key = (int(item["a"]), int(item["b"]), float(item["t_q"]))
            hit = memo.get(key)
            if hit is not None and hit.is_file():
                shutil.copy2(str(hit), str(out))
            else:
                await run_rife_single_pair(
                    frames[int(item["a"])], frames[int(item["b"])], out,
                    timestep=float(item["t_q"]), model=model,
                    tta=tta, uhd=uhd,
                )
                memo[key] = out
        done += 1
        if token:
            job_control.report_progress(
                f"rife_pts {done}/{total} frames",
                phase="rife_pts", current=done, total=total,
                unit="frames", token=token,
            )

    if token:
        job_control.report_progress(
            f"rife_pts done: {done} frames",
            phase="rife_pts", current=done, total=done, unit="frames",
            token=token, watch_dir=str(dst), watch_count=done,
        )

    return {
        "frame_count_in": len(frames),
        "frame_count_out": done,
        "inferences": plan["inferences"],
        "copies": plan["copies"],
        "command": (
            f"rife_pts {len(frames)} frames + {len(times)} PTS → {done} "
            f"@ {float(target_fps):.6g}fps "
            f"({plan['inferences']} inferred, {plan['copies']} copied, "
            f"t_step={float(t_step):.6g}, {model})"
        ),
    }


def make_rife_pts_directory_fn(
    *,
    target_fps: float,
    pts: list[float],
    model: str = "rife-v4.6",
    tta: bool = False,
    uhd: bool = False,
    t_step: float = 0.25,
    **_extra: Any,
):
    """Factory for pipeline registry. Returned callable has kind='directory'."""

    async def directory_fn(src_dir: Path, dst_dir: Path) -> dict[str, Any]:
        return await run_rife_pts_directory(
            src_dir, dst_dir,
            target_fps=float(target_fps),
            pts=[float(v) for v in pts],
            model=str(model), tta=bool(tta), uhd=bool(uhd),
            t_step=float(t_step),
        )

    directory_fn.kind = "directory"  # type: ignore[attr-defined]
    directory_fn.stage_name = "rife_pts"  # type: ignore[attr-defined]
    return directory_fn


register_stage("rife_pts", make_rife_pts_directory_fn)
