"""RIFE directory stage — one rife-ncnn-vulkan pass over a frame folder.

kind=directory (not per_frame). Shared by /ops/rife and /ops/pipeline.
"""
from __future__ import annotations

import asyncio
import os
import shutil
from pathlib import Path
from typing import Any

from .. import job_control
from . import register_stage

_DEFAULT_BIN = "/usr/bin/rife-ncnn-vulkan"


def resolve_rife_bin() -> str:
    found = shutil.which("rife-ncnn-vulkan")
    if found:
        return found
    if Path(_DEFAULT_BIN).is_file():
        return _DEFAULT_BIN
    raise RuntimeError(
        "rife-ncnn-vulkan not found on PATH or at /usr/bin/rife-ncnn-vulkan"
    )


def _list_frame_pngs(directory: Path) -> list[Path]:
    if not directory.is_dir():
        return []
    return sorted(directory.glob("frame_*.png"))


def normalize_frame_sequence(directory: Path) -> int:
    """Rename frame_*.png to continuous frame_%06d.png starting at 0.

    rife-ncnn-vulkan often emits 1-based names (frame_000001.png …).
    video_pipeline.encode expects start_number 0.
    """
    frames = _list_frame_pngs(directory)
    if not frames:
        return 0

    # Already 0-based contiguous?
    expected = [directory / f"frame_{i:06d}.png" for i in range(len(frames))]
    if frames == expected:
        return len(frames)

    tmp_paths: list[Path] = []
    for i, src in enumerate(frames):
        tmp = directory / f"_norm_{i:06d}.png"
        src.rename(tmp)
        tmp_paths.append(tmp)

    for i, tmp in enumerate(tmp_paths):
        tmp.rename(directory / f"frame_{i:06d}.png")

    return len(tmp_paths)


async def run_rife_directory(
    src_dir: Path | str,
    dst_dir: Path | str,
    *,
    multiplier: int = 2,
    model: str = "rife-v4.6",
    tta: bool = False,
    uhd: bool = False,
    verbose: bool = False,
) -> dict[str, Any]:
    """Run rife-ncnn-vulkan folder mode. Returns {frame_count_in, frame_count_out, command}."""
    src = Path(src_dir).resolve()
    dst = Path(dst_dir).resolve()
    dst.mkdir(parents=True, exist_ok=True)

    frames_in = _list_frame_pngs(src)
    if not frames_in:
        # also accept plain *.png if user folder isn't frame_*-named
        frames_in = sorted(src.glob("*.png"))
    if not frames_in:
        raise RuntimeError(f"No PNG frames in {src}")

    in_count = len(frames_in)
    if multiplier < 2:
        raise ValueError("multiplier must be >= 2")
    out_target = in_count * multiplier

    rife_bin = resolve_rife_bin()
    argv = [
        rife_bin,
        "-i", str(src),
        "-o", str(dst),
        "-n", str(out_target),
        "-m", model,
        "-f", "frame_%06d.png",
    ]
    if tta:
        argv.append("-x")
    if uhd:
        argv.append("-u")
    if verbose:
        argv.append("-v")

    job_control.check_cancelled()

    token = job_control.current_token()
    if token:
        job_control.start_dir_watch(
            token,
            directory=dst,
            total=out_target,
            phase="rife",
            unit="frames",
            message=f"RIFE {0}/{out_target} frames",
        )

    proc = await asyncio.create_subprocess_exec(
        *argv,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        # Cancel-friendly wait: poll instead of blocking communicate()
        while proc.returncode is None:
            job_control.check_cancelled()
            await asyncio.sleep(0.5)
        _out_b, err_b = await proc.communicate()
    except asyncio.CancelledError:
        proc.kill()
        await proc.wait()
        if token:
            job_control.stop_dir_watch(token)
        raise
    finally:
        if token:
            job_control.stop_dir_watch(token)

    if proc.returncode != 0:
        err = (err_b or b"").decode(errors="replace")[-500:]
        raise RuntimeError(
            f"rife-ncnn-vulkan failed (exit {proc.returncode}): {err or 'no stderr'}"
        )

    out_count = normalize_frame_sequence(dst)
    if out_count <= 0:
        raise RuntimeError(f"rife produced no frames in {dst}")

    # Final accurate count after normalization
    if token:
        job_control.report_progress(
            f"rife done: {out_count} frames",
            phase="rife", current=out_count, total=out_count, unit="frames",
            token=token, watch_dir=str(dst), watch_count=out_count,
        )

    return {
        "frame_count_in": in_count,
        "frame_count_out": out_count,
        "command": " ".join(argv),
        "multiplier": multiplier,
        "model": model,
    }


def make_rife_directory_fn(
    *,
    multiplier: int = 2,
    model: str = "rife-v4.6",
    tta: bool = False,
    uhd: bool = False,
    **_extra: Any,
):
    """Factory for pipeline registry. Returned callable has kind='directory'."""

    async def directory_fn(src_dir: Path, dst_dir: Path) -> dict[str, Any]:
        return await run_rife_directory(
            src_dir,
            dst_dir,
            multiplier=int(multiplier),
            model=str(model),
            tta=bool(tta),
            uhd=bool(uhd),
        )

    directory_fn.kind = "directory"  # type: ignore[attr-defined]
    directory_fn.stage_name = "rife"  # type: ignore[attr-defined]
    return directory_fn


register_stage("rife", make_rife_directory_fn)
