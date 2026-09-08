"""CFR directory stage — resample a dumped PNG sequence to even spacing.

Pure resample: duplicates/drops frames so the sequence runs at exactly
`fps`. Used by /ops/cfr (VFR → CFR before optional RIFE) so RIFE sees
even-spaced input.

kind=directory (not per_frame). Lives under app/filters/* per invariant §1.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from .. import job_control
from ..shell import run_command
from . import register_stage


def _count_frame_pngs(directory: Path) -> int:
    if not directory.is_dir():
        return 0
    return len(list(directory.glob("frame_*.png")))


async def run_cfr_directory(
    src_dir: Path | str,
    dst_dir: Path | str,
    *,
    fps: float,
    input_fps: float | None = None,
) -> dict[str, Any]:
    """Resample src PNGs to `fps` via the ffmpeg fps filter.

    Returns {frame_count_in, frame_count_out, command}.
    """
    from .rife import normalize_frame_sequence

    src = Path(src_dir).resolve()
    dst = Path(dst_dir).resolve()
    dst.mkdir(parents=True, exist_ok=True)

    target = float(fps)
    if target <= 0:
        raise ValueError(f"CFR target fps must be > 0, got {fps!r}")

    in_count = _count_frame_pngs(src)
    if in_count <= 0:
        # Also accept plain *.png folders (same tolerance as the RIFE stage).
        in_count = len(sorted(src.glob("*.png")))
    if in_count <= 0:
        raise RuntimeError(f"No PNG frames in {src}")

    src_rate = float(input_fps) if input_fps and float(input_fps) > 0 else target
    out_target = max(1, int(round(in_count * target / src_rate)))

    argv = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-framerate", f"{src_rate:.6g}",
        "-start_number", "0",
        "-i", str(src / "frame_%06d.png"),
        "-vf", f"fps={target:.6g}",
        "-start_number", "0",
        str(dst / "frame_%06d.png"),
    ]

    token = job_control.current_token()
    if token:
        job_control.report_progress(
            f"cfr 0/{out_target} frames",
            phase="cfr", current=0, total=out_target, unit="frames", token=token,
        )
        job_control.start_dir_watch(
            token,
            directory=dst,
            total=out_target,
            phase="cfr",
            unit="frames",
            message=f"cfr 0/{out_target} frames",
        )
    try:
        code, _, stderr = await run_command(argv)
    finally:
        if token:
            job_control.stop_dir_watch(token)

    if code != 0:
        raise RuntimeError(
            f"ffmpeg cfr resample failed (exit {code}): {stderr.strip() or 'no stderr'}"
        )

    out_count = normalize_frame_sequence(dst)
    if out_count <= 0:
        raise RuntimeError(f"cfr produced no frames in {dst}")

    if token:
        job_control.report_progress(
            f"cfr done: {out_count} frames",
            phase="cfr", current=out_count, total=out_count, unit="frames",
            token=token, watch_dir=str(dst), watch_count=out_count,
        )

    return {
        "frame_count_in": in_count,
        "frame_count_out": out_count,
        "command": " ".join(argv),
        "fps": target,
    }


def make_cfr_directory_fn(fps: float, **extra: Any):
    """Factory for pipeline registry. Returned callable has kind='directory'.

    `input_fps` (optional): framerate of the dumped source sequence, used as
    the ffmpeg image-demuxer input rate so the fps filter resamples
    dump-rate → target. Defaults to `fps` (identity-safe).
    """

    input_fps = extra.get("input_fps")

    async def directory_fn(src_dir: Path, dst_dir: Path) -> dict[str, Any]:
        return await run_cfr_directory(
            src_dir, dst_dir, fps=float(fps),
            input_fps=float(input_fps) if input_fps else None,
        )

    directory_fn.kind = "directory"  # type: ignore[attr-defined]
    directory_fn.stage_name = "cfr"  # type: ignore[attr-defined]
    return directory_fn


register_stage("cfr", make_cfr_directory_fn)
