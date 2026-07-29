"""
Unified VideoPipeline — probe, dump, process, encode, cleanup.

Replaces the repeated dump→process→encode pattern across engines.
Built on JobWorkspace for isolated per-job temp directories.

Stages:
  A. probe(input_path) → {fps, duration, frame_count, width, height, has_audio}
  B. dump(workspace, input_path) → dumps input to workspace.frames_in as PNGs
  C. process(workspace, filter_fn) → iterates frames_in, calls filter_fn,
     writes to frames_out. Checks job_control.check_cancelled() between frames.
  D. encode(workspace, output_path, fps) → encodes frames_out to video,
     muxes audio if available.
"""
from __future__ import annotations

import asyncio
import json
import shutil
import time
from pathlib import Path
from typing import Any, Callable, Coroutine

from .job_workspace import JobWorkspace
from .shell import run_command
from . import job_control


# ── A. Probe ───────────────────────────────────────────────────────────────

async def probe(input_path: str | Path) -> dict[str, Any]:
    """ffprobe the input video. Returns fps, duration, frame_count, dims, audio flag."""
    sp = str(Path(input_path).resolve())
    cmd = [
        "ffprobe", "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height,r_frame_rate,nb_frames",
        "-show_entries", "format=duration",
        "-of", "json",
        sp,
    ]
    code, out, _ = await run_command(cmd)
    if code != 0:
        raise RuntimeError(f"ffprobe failed on {sp}")

    try:
        data = json.loads(out)
    except json.JSONDecodeError:
        raise RuntimeError(f"ffprobe produced invalid JSON for {sp}")

    streams = data.get("streams") or [{}]
    s0 = streams[0] if streams else {}
    fmt = data.get("format") or {}

    width = int(s0.get("width") or 0)
    height = int(s0.get("height") or 0)

    fps = 25.0
    r = s0.get("r_frame_rate") or "25/1"
    try:
        if "/" in r:
            a, b = r.split("/", 1)
            fps = float(a) / max(float(b), 1e-9)
        else:
            fps = float(r)
    except Exception:
        fps = 25.0

    duration = float(fmt.get("duration") or 0)

    frame_count = 0
    try:
        frame_count = int(s0.get("nb_frames") or 0)
    except (ValueError, TypeError):
        pass
    if frame_count <= 0 and duration > 0 and fps > 0:
        frame_count = int(round(duration * fps))

    has_audio = await _probe_has_audio(sp)

    return {
        "fps": round(fps, 3),
        "duration": round(duration, 3),
        "frame_count": frame_count,
        "width": width,
        "height": height,
        "has_audio": has_audio,
    }


async def _probe_has_audio(input_path: str) -> bool:
    code, out, _ = await run_command([
        "ffprobe", "-v", "error",
        "-select_streams", "a",
        "-show_entries", "stream=index",
        "-of", "csv=p=0", input_path,
    ])
    return code == 0 and bool(out.strip())


# ── B. Dump ────────────────────────────────────────────────────────────────

async def dump(workspace: JobWorkspace, input_path: str | Path) -> dict[str, Any]:
    """Dump input video to workspace.frames_in as PNG sequence.

    Returns {frame_count, fps, audio_path}. Extracts audio sidestream if present.
    """
    workspace.create()
    sp = str(Path(input_path).resolve())
    info = await probe(sp)

    out_pattern = str(workspace.frames_in / "frame_%06d.png")
    argv = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-i", sp,
        "-fps_mode", "passthrough",
        "-start_number", "0",
        "-an",
        out_pattern,
    ]
    code, _, stderr = await run_command(argv)
    if code != 0:
        raise RuntimeError(f"ffmpeg PNG dump failed (exit {code}): {stderr.strip() or 'no stderr'}")

    frame_count = len(workspace.list_frames_in())
    audio_path: str | None = None
    if info.get("has_audio"):
        ext = _audio_ext(sp)
        ap = workspace.root / f"audio{ext}"
        acode, _, astderr = await run_command([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-i", sp, "-vn", "-acodec", "copy",
            str(ap),
        ])
        if acode == 0 and ap.exists() and ap.stat().st_size > 0:
            audio_path = str(ap)
            workspace.audio_path = ap

    workspace.write_metadata({
        "input_path": sp,
        "fps": info["fps"],
        "duration": info["duration"],
        "frame_count": frame_count,
        "width": info["width"],
        "height": info["height"],
        "has_audio": info["has_audio"],
        "audio_path": audio_path,
        "dumped_at": time.time(),
    })

    return {
        "frame_count": frame_count,
        "fps": info["fps"],
        "audio_path": audio_path,
    }


def _audio_ext(video_path: str) -> str:
    """Guess a safe audio extension for stream copy."""
    lower = Path(video_path).suffix.lower()
    if lower in (".mp4", ".m4v", ".mov", ".m4a"):
        return ".m4a"
    if lower in (".mkv", ".webm"):
        return ".mka"
    return ".aac"


# ── C. Process ─────────────────────────────────────────────────────────────

FilterFn = Callable[[Path, Path, int], Coroutine[Any, Any, None]]


async def process(
    workspace: JobWorkspace,
    filter_fn: FilterFn,
    *,
    progress_cb: Callable[[int, int], Any] | None = None,
) -> int:
    """Iterate frames_in, apply filter_fn to each, write to frames_out.

    filter_fn signature: async def fn(input_png: Path, output_png: Path, index: int) -> None

    Calls job_control.check_cancelled() between frames.

    Returns the number of frames processed.
    """
    frames = workspace.list_frames_in()
    if not frames:
        raise RuntimeError("No frames to process — did you call dump() first?")

    total = len(frames)
    for idx, src in enumerate(frames):
        job_control.check_cancelled()
        dst = workspace.frames_out / src.name
        await filter_fn(src, dst, idx)
        if progress_cb:
            progress_cb(idx + 1, total)

    return total


# ── D. Encode ──────────────────────────────────────────────────────────────

async def encode(
    workspace: JobWorkspace,
    output_path: str | Path,
    fps: float,
    *,
    crf: int = 18,
    mux_audio: bool = True,
    preset: str = "fast",
    codec: str = "libx264",
    pix_fmt: str = "yuv420p",
    frame_pattern: str = "frame_%06d.png",
) -> str:
    """Encode frames_out/*.png to output video. Muxes audio if available.

    codec / pix_fmt are overrideable for non-standard formats
    (e.g. libvpx-vp9 + yuva420p for WebM with alpha).

    Returns the output_path as a string.
    """
    out_path = str(Path(output_path).resolve())
    out_parent = Path(out_path).parent
    out_parent.mkdir(parents=True, exist_ok=True)

    in_pattern = str(workspace.frames_out / frame_pattern)

    argv = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-framerate", str(fps),
        "-start_number", "0",
        "-i", in_pattern,
    ]

    if mux_audio and workspace.audio_path and workspace.audio_path.exists():
        argv.extend([
            "-i", str(workspace.audio_path),
            "-map", "0:v:0", "-map", "1:a:0?",
            "-c:v", codec, "-preset", preset, "-crf", str(crf),
            "-pix_fmt", pix_fmt,
            "-c:a", "aac", "-b:a", "192k", "-shortest",
        ])
    else:
        argv.extend([
            "-c:v", codec, "-preset", preset, "-crf", str(crf),
            "-pix_fmt", pix_fmt,
            "-an",
        ])

    argv.append(out_path)

    code, _, stderr = await run_command(argv)
    if code != 0:
        raise RuntimeError(
            f"ffmpeg encode failed (exit {code}): {stderr.strip() or 'no stderr'}"
        )

    return out_path


# ── Cleanup (convenience) ──────────────────────────────────────────────────

async def cleanup(workspace: JobWorkspace, *, keep_on_failure: bool = True) -> None:
    """Clean workspace on success, keep on failure."""
    workspace.cleanup(keep_on_failure=keep_on_failure, keep_on_success=False)
