"""
Unified VideoPipeline — probe, dump, process, encode, cleanup.

Replaces the repeated dump→process→encode pattern across engines.
Built on JobWorkspace for isolated per-job temp directories.

Stages:
  A. probe(input_path) → {fps, duration, frame_count, width, height, has_audio}
  B. dump(workspace, input_path) → dumps input to workspace.frames_in as PNGs
     (or other image_format, or into durable out_dir)
  C. process(workspace, filter_fn) → iterates frames_in, calls filter_fn,
     writes to frames_out. Checks job_control.check_cancelled() between frames.
  D. encode(workspace, output_path, fps) → encodes frames_out to video,
     muxes audio if available. Accepts EncodePreset or individual kwargs.
  E. load_frames_dir(dir_path) → inspects an image-sequence folder for encode.
"""
from __future__ import annotations

import asyncio
import json
import math
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

async def dump(
    workspace: JobWorkspace,
    input_path: str | Path,
    *,
    image_format: str = "png",
    out_dir: str | Path | None = None,
    start_frame: int = 1,
    end_frame: int = 999999,
) -> dict[str, Any]:
    """Dump input video/GIF to frames as image sequence.

    Args:
        workspace: JobWorkspace (used for metadata and audio extraction).
        input_path: Source video or animated GIF.
        image_format: png | webp | jpg | tiff. Default png.
        out_dir: If set, write frames to this durable directory instead of
                 workspace.frames_in. For Convert/Export durable dumps.
        start_frame: First frame to dump, **1-based inclusive** (1 = first frame).
        end_frame: Last frame to dump, **1-based inclusive**. Large value (e.g.
                   999999) means through end of clip.

    Returns {frame_count, fps, audio_path, pattern, start_number, start_frame, end_frame}.
    Frame pattern is always frame_%06d.<ext>, start_number 0 (output renumbered).
    """
    workspace.create()
    sp = str(Path(input_path).resolve())
    info = await probe(sp)
    fps = float(info.get("fps") or 25.0)
    if fps <= 0:
        fps = 25.0

    ext = image_format.lower()
    if ext == "tiff":
        ext = "tif"
    if ext == "jpg":
        ext = "jpg"

    frames_dir = Path(out_dir) if out_dir else workspace.frames_in
    frames_dir = Path(frames_dir).resolve()
    frames_dir.mkdir(parents=True, exist_ok=True)
    out_pattern = str(frames_dir / f"frame_%06d.{ext}")

    sf = int(start_frame) if start_frame is not None else 1
    ef = int(end_frame) if end_frame is not None else 999999
    if sf < 1:
        sf = 1
    if ef < sf:
        ef = sf

    # 0-based inclusive indices for ffmpeg select filter (n is 0-based)
    n0 = sf - 1
    full_clip = sf <= 1 and ef >= 999999
    n1: int | None = None if full_clip else max(n0, ef - 1)

    argv = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-i", sp,
    ]
    if n1 is not None:
        # Frame-accurate range; renumber timestamps so encode sees a clean sequence
        argv.extend([
            "-vf", f"select='between(n\\,{n0}\\,{n1})',setpts=PTS-STARTPTS",
            "-vsync", "vfr",
        ])
    else:
        argv.extend(["-fps_mode", "passthrough"])

    argv.extend(["-start_number", "0", "-an"])
    if image_format == "webp":
        argv.extend(["-quality", "90"])
    elif image_format == "jpg":
        argv.extend(["-q:v", "2"])

    argv.append(out_pattern)

    # Dir watch while ffmpeg dumps (opaque writer fills frames_dir)
    from . import job_control
    token = job_control.current_token()
    dump_total = 0
    try:
        fc = int(info.get("frame_count") or 0)
        if n1 is not None:
            dump_total = max(1, (n1 - n0) + 1)
        elif fc > 0:
            dump_total = fc
    except Exception:
        dump_total = 0
    if token and dump_total > 0:
        job_control.report_progress(
            f"dump 0/{dump_total} frames",
            phase="dump", current=0, total=dump_total, unit="frames", token=token,
        )
        job_control.start_dir_watch(
            token,
            directory=frames_dir,
            total=dump_total,
            phase="dump",
            unit="frames",
            message=f"dump 0/{dump_total} frames",
        )
    try:
        code, _, stderr = await run_command(argv)
    finally:
        if token:
            job_control.stop_dir_watch(token)

    if code != 0:
        raise RuntimeError(f"ffmpeg {ext} dump failed (exit {code}): {stderr.strip() or 'no stderr'}")

    frame_count = _count_frames_in_dir(frames_dir, ext)
    if token and frame_count:
        job_control.report_progress(
            f"dump done {frame_count} frames",
            phase="dump", current=frame_count, total=max(frame_count, dump_total or frame_count),
            unit="frames", token=token,
        )

    audio_path: str | None = None
    if info.get("has_audio") and not out_dir:
        ap = workspace.root / f"audio{_audio_ext(sp)}"
        if n1 is not None:
            start_t = n0 / fps
            end_t = (n1 + 1) / fps
            a_argv = [
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                "-i", sp,
                "-ss", f"{start_t:.6f}",
                "-to", f"{end_t:.6f}",
                "-vn", "-acodec", "copy",
                str(ap),
            ]
        else:
            a_argv = [
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                "-i", sp, "-vn", "-acodec", "copy", str(ap),
            ]
        acode, _, _ = await run_command(a_argv)
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
        "image_format": ext,
        "out_dir": str(frames_dir) if out_dir else None,
        "start_frame": sf,
        "end_frame": ef if n1 is not None else None,
    })

    return {
        "frame_count": frame_count,
        "fps": info["fps"],
        "audio_path": audio_path,
        "pattern": f"frame_%06d.{ext}",
        "start_number": 0,
        "start_frame": sf,
        "end_frame": ef if n1 is not None else None,
    }


def _count_frames_in_dir(directory: Path, ext: str) -> int:
    if not directory.is_dir():
        return 0
    return len(list(directory.glob(f"frame_*.{ext}")))


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
    encode_preset: Any | None = None,
    frame_source_dir: str | Path | None = None,
    silence_on_no_audio: bool = False,
    even_floor: bool = False,
    extra_vf: str | None = None,
) -> str:
    """Encode frames to output video. Muxes audio if available.

    Two modes:
      1. Legacy: pass codec/crf/preset/pix_fmt directly (backward compat).
      2. Preset-driven: pass encode_preset (EncodePreset from convert_presets)
         which provides all codec/container/audio/extra args.

    Args:
        workspace: JobWorkspace (for audio path).
        output_path: Destination video file.
        fps: Frame rate for encoding.
        crf/preset/codec/pix_fmt: Legacy mode kwargs.
        frame_pattern: Glob pattern for frames.
        encode_preset: Optional EncodePreset that overrides legacy kwargs.
        frame_source_dir: Optional alternate frames-in directory (for
                          load_frames_dir path — not workspace.frames_out).
        silence_on_no_audio: If true and no audio available, inject silence
                             instead of dropping audio. Used by Convert/Export.
        even_floor: Force even width/height by applying pad filter. Used for
                    yuv420p delivery encodes where dimensions must be even.

    Returns the output_path as a string.
    """
    out_path = str(Path(output_path).resolve())
    out_parent = Path(out_path).parent
    out_parent.mkdir(parents=True, exist_ok=True)

    src_dir = Path(frame_source_dir) if frame_source_dir else workspace.frames_out
    in_pattern = str(src_dir / frame_pattern)

    argv = _build_encode_argv(
        in_pattern=in_pattern,
        out_path=out_path,
        fps=fps,
        audio_path=workspace.audio_path,
        mux_audio=mux_audio,
        silence_on_no_audio=silence_on_no_audio,
        codec=codec,
        crf=crf,
        preset=preset,
        pix_fmt=pix_fmt,
        even_floor=even_floor,
        encode_preset=encode_preset,
        extra_vf=extra_vf,
    )

    code, _, stderr = await run_command(argv)
    if code != 0:
        raise RuntimeError(
            f"ffmpeg encode failed (exit {code}): {stderr.strip() or 'no stderr'}"
        )

    return out_path


def _build_encode_argv(
    *,
    in_pattern: str,
    out_path: str,
    fps: float,
    audio_path: str | Path | None,
    mux_audio: bool,
    silence_on_no_audio: bool,
    codec: str,
    crf: int,
    preset: str,
    pix_fmt: str,
    even_floor: bool,
    encode_preset: Any | None,
    extra_vf: str | None = None,
) -> list[str]:
    """Build ffmpeg argv for encode from either legacy kwargs or EncodePreset."""
    if encode_preset is not None:
        ep = encode_preset
        codec = ep.codec
        pix_fmt = ep.pix_fmt
        crf = ep.crf
        preset = ep.preset
        even_floor = ep.even_floor

    argv = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-framerate", str(fps),
        "-start_number", "0",
        "-i", in_pattern,
    ]

    has_audio_input = bool(audio_path and Path(audio_path).exists())

    if encode_preset is not None:
        audio_codec = encode_preset.audio_codec
        audio_bitrate = encode_preset.audio_bitrate
    else:
        audio_codec = "aac"
        audio_bitrate = "192k"

    has_audio = has_audio_input and mux_audio
    inject_silence = False
    if not has_audio_input and mux_audio and silence_on_no_audio and encode_preset:
        inject_silence = True

    # Audio input
    if has_audio:
        argv.extend([
            "-i", str(audio_path),
            "-map", "0:v:0", "-map", "1:a:0?",
        ])
    elif inject_silence:
        argv.extend(["-f", "lavfi", "-i", "anullsrc"])
        argv.extend(["-map", "0:v:0", "-map", "1:a:0"])

    # Video filter for even dimensions
    video_filter: str | None = None
    if even_floor:
        video_filter = "pad=ceil(iw/2)*2:ceil(ih/2)*2"

    if encode_preset is not None:
        ep = encode_preset

        if ep.codec == "prores_ks":
            argv.extend([
                "-c:v", "prores_ks",
                "-profile:v", str(ep.profile or 3),
                "-pix_fmt", ep.pix_fmt,
            ])
        elif ep.codec == "dnxhd":
            argv.extend([
                "-c:v", "dnxhd",
                *ep.extra,
                "-pix_fmt", ep.pix_fmt,
            ])
        elif ep.codec in ("libx264", "libx265"):
            argv.extend([
                "-c:v", ep.codec,
                "-preset", ep.preset or "medium",
                "-crf", str(ep.crf),
                "-pix_fmt", ep.pix_fmt,
                *ep.extra,
            ])
        elif ep.codec == "libvpx-vp9":
            argv.extend([
                "-c:v", "libvpx-vp9",
                "-crf", str(ep.crf),
                "-b:v", "0",
                "-pix_fmt", ep.pix_fmt,
                *ep.extra,
            ])
        elif ep.codec == "libsvtav1":
            argv.extend([
                "-c:v", "libsvtav1",
                "-crf", str(ep.crf),
                "-preset", ep.preset or "6",
                "-pix_fmt", ep.pix_fmt,
            ])
        elif ep.codec == "ffv1":
            argv.extend([
                "-c:v", "ffv1",
                *ep.extra,
                "-pix_fmt", ep.pix_fmt,
            ])
        else:
            argv.extend([
                "-c:v", codec,
                "-preset", preset, "-crf", str(crf),
                "-pix_fmt", pix_fmt,
            ])

        if has_audio or inject_silence:
            argv.extend(["-c:a", audio_codec])
            if audio_bitrate:
                argv.extend(["-b:a", audio_bitrate])
            argv.append("-shortest")
        else:
            argv.append("-an")

    else:
        if mux_audio and has_audio_input:
            argv.extend([
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

    if extra_vf:
        video_filter = f"{video_filter},{extra_vf}" if video_filter else extra_vf
    if video_filter:
        argv.extend(["-vf", video_filter])

    argv.append(out_path)
    return argv


def _needs_audio_for_preset(encode_preset: Any | None) -> bool:
    if encode_preset is None:
        return False
    return encode_preset.audio_codec in ("aac", "pcm_s16le", "libopus")


# ── E. Load frames directory ────────────────────────────────────────────────

async def load_frames_dir(
    workspace: JobWorkspace,
    dir_path: str | Path,
    *,
    fps: float = 24.0,
) -> dict[str, Any]:
    """Inspect a directory of still images for encode.

    Detects dominant extension, counts frames, and optionally copies/symlinks
    into workspace.frames_out for downstream encode.

    Returns:
        {frame_count, dominant_ext, pattern, start_number, fps}
    """
    d = Path(dir_path).resolve()
    if not d.is_dir():
        raise RuntimeError(f"Not a directory: {d}")

    extensions: dict[str, int] = {}
    all_images: list[Path] = []

    from .convert_presets import IMAGE_EXTS

    for f in sorted(d.iterdir()):
        if f.is_file() and f.suffix.lower() in IMAGE_EXTS:
            ext = f.suffix.lower()
            extensions[ext] = extensions.get(ext, 0) + 1
            all_images.append(f)

    if not all_images:
        raise RuntimeError(f"No image files found in {d}")

    dominant_ext = max(extensions, key=extensions.get)  # type: ignore[arg-type]
    dominant_ext_clean = dominant_ext.lstrip(".")

    if len(extensions) > 1:
        import logging
        logging.getLogger("mtapi").warning(
            "Multiple image extensions in %s: %s. Using dominant: %s",
            d, list(extensions.keys()), dominant_ext,
        )

    frame_count = len(all_images)

    workspace.create()
    workspace.frames_out.mkdir(parents=True, exist_ok=True)

    if not _is_pipeline_pattern(all_images):
        for idx, src in enumerate(all_images):
            dst = workspace.frames_out / f"frame_{idx:06d}.png"
            try:
                shutil.copy2(str(src), str(dst))
            except OSError:
                pass
        dominant_ext_clean = "png"

    workspace.write_metadata({
        "source_dir": str(d),
        "frame_count": frame_count,
        "dominant_ext": dominant_ext,
        "fps": fps,
        "loaded_at": time.time(),
    })

    return {
        "frame_count": frame_count,
        "dominant_ext": dominant_ext_clean,
        "pattern": f"frame_%06d.{dominant_ext_clean}",
        "start_number": 0,
        "fps": fps,
    }


def _is_pipeline_pattern(images: list[Path]) -> bool:
    """Check if images already follow frame_%06d.* naming starting at 0."""
    if not images:
        return False
    expected = [f"frame_{i:06d}" for i in range(min(len(images), 10))]
    for stem, img in zip(expected, images[:10]):
        if img.stem != stem:
            return False
    return True


# ── Cleanup (convenience) ──────────────────────────────────────────────────

async def cleanup(workspace: JobWorkspace, *, keep_on_failure: bool = True) -> None:
    """Clean workspace on success, keep on failure."""
    workspace.cleanup(keep_on_failure=keep_on_failure, keep_on_success=False)


# ── Sync helpers (engines / CLI that cannot await) ─────────────────────────
# Prefer async dump/encode + JobWorkspace in ops. These exist so legacy sync
# helpers (e.g. deepdream.dream_video) do not depend on PngFramePipeline.

import subprocess as _subprocess


def dump_frames_sync(
    input_path: str | Path,
    frames_dir: str | Path,
    *,
    frame_pattern: str = "frame_%06d.png",
    start_number: int = 0,
    vsync: int = 0,
    fps: float | None = None,
    audio: bool = False,
) -> None:
    """Synchronous ffmpeg dump into an existing directory."""
    frames_dir = Path(frames_dir)
    frames_dir.mkdir(parents=True, exist_ok=True)
    argv = [
        "ffmpeg", "-y", "-v", "error",
        "-i", str(input_path),
        "-fps_mode", "passthrough" if vsync == 0 else "cfr",
        "-start_number", str(start_number),
    ]
    if not audio:
        argv.append("-an")
    if fps is not None:
        argv.extend(["-r", str(fps)])
    argv.append(str(frames_dir / frame_pattern))
    r = _subprocess.run(argv, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(
            f"ffmpeg dump failed: {(r.stderr or r.stdout or '').strip() or r.returncode}"
        )


def encode_frames_sync(
    frame_dir: str | Path,
    output_path: str | Path,
    fps: float,
    *,
    frame_pattern: str = "frame_%06d.png",
    start_number: int = 0,
    codec: str = "libx264",
    preset: str = "medium",
    crf: int = 18,
    pix_fmt: str = "yuv420p",
    audio_from: str | Path | None = None,
) -> None:
    """Synchronous ffmpeg encode from a frame directory."""
    frame_dir = Path(frame_dir)
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    argv = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-framerate", str(fps),
        "-start_number", str(start_number),
        "-i", str(frame_dir / frame_pattern),
    ]
    muxed = False
    if audio_from and Path(audio_from).is_file():
        has_a = _subprocess.run(
            [
                "ffprobe", "-v", "error", "-select_streams", "a",
                "-show_entries", "stream=index", "-of", "csv=p=0", str(audio_from),
            ],
            capture_output=True, text=True,
        )
        if has_a.stdout.strip():
            argv.extend([
                "-i", str(audio_from),
                "-map", "0:v:0", "-map", "1:a:0?",
                "-c:v", codec, "-preset", preset, "-crf", str(crf), "-pix_fmt", pix_fmt,
                "-c:a", "aac", "-b:a", "192k", "-shortest",
            ])
            muxed = True
    if not muxed:
        argv.extend([
            "-an",
            "-c:v", codec, "-preset", preset, "-crf", str(crf), "-pix_fmt", pix_fmt,
        ])
    argv.append(str(output_path))
    r = _subprocess.run(argv, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(
            f"ffmpeg encode failed: {(r.stderr or r.stdout or '').strip() or r.returncode}"
        )
