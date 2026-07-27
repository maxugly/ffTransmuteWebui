"""Single source of truth for ffprobe queries.

Every function calls ffprobe once, parses the output, and returns a sensible
default on failure. Async versions (used by ops) use run_command from shell;
sync wrappers (used by standalone CLI scripts) use subprocess.run.
"""
from __future__ import annotations

import asyncio
import subprocess


# ── Async (ops use these) ─────────────────────────────────────────────────

async def probe_duration(path: str, default: float = 0.0) -> float:
    """Format duration in seconds. Returns *default* (0.0) on failure."""
    from .shell import run_command
    code, out, _ = await run_command([
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration",
        "-of", "csv=p=0", path,
    ])
    try:
        return float(out.strip()) if code == 0 else default
    except ValueError:
        return default


async def probe_fps(path: str, default: float = 0.0) -> float:
    """Video frame rate as float (e.g. 24.0). Returns *default* on failure."""
    from .shell import run_command
    code, out, _ = await run_command([
        "ffprobe", "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=r_frame_rate",
        "-of", "csv=p=0", path,
    ])
    try:
        if code == 0 and "/" in out:
            num, den = out.strip().split("/", 1)
            return float(num) / float(den)
        return float(out.strip()) if code == 0 else default
    except (ValueError, ZeroDivisionError):
        return default


async def probe_dimensions(path: str) -> tuple[int, int]:
    """Video (width, height). Returns (0, 0) on failure."""
    from .shell import run_command
    code, out, _ = await run_command([
        "ffprobe", "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height",
        "-of", "csv=s=x:p=0", path,
    ])
    try:
        if code == 0:
            parts = out.strip().split("x")
            if len(parts) >= 2:
                return int(parts[0]), int(parts[1])
    except (ValueError, IndexError):
        pass
    return 0, 0


async def probe_frame_count(path: str, default: int = 0) -> int:
    """Number of video frames. Returns *default* (0) on failure."""
    from .shell import run_command
    code, out, _ = await run_command([
        "ffprobe", "-v", "error",
        "-select_streams", "v:0",
        "-count_frames",
        "-show_entries", "stream=nb_read_frames",
        "-of", "csv=p=0", path,
    ])
    try:
        return int(out.strip()) if code == 0 else default
    except ValueError:
        return default


# ── Sync (standalone CLI scripts) ────────────────────────────────────────

def _ffprobe_sync(path: str, key: str) -> str:
    """Run ffprobe synchronously, return stdout stripped."""
    r = subprocess.run([
        "ffprobe", "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", f"stream={key}",
        "-of", "csv=p=0", path,
    ], capture_output=True, text=True)
    return r.stdout.strip()


def probe_duration_sync(path: str, default: float = 0.0) -> float:
    try:
        raw = _ffprobe_sync(path, "duration")
        return float(raw) if raw else default
    except (ValueError, subprocess.SubprocessError):
        return default


def probe_fps_sync(path: str, default: float = 0.0) -> float:
    try:
        raw = _ffprobe_sync(path, "r_frame_rate")
        if "/" in raw:
            num, den = raw.split("/", 1)
            return float(num) / float(den) if float(den) != 0 else default
        return float(raw) if raw else default
    except (ValueError, ZeroDivisionError, subprocess.SubprocessError):
        return default


def probe_frame_count_sync(path: str, default: int = 0) -> int:
    try:
        raw = _ffprobe_sync(path, "nb_read_frames")
        return int(raw) if raw else default
    except (ValueError, subprocess.SubprocessError):
        return default
