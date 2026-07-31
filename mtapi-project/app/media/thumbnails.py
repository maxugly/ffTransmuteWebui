"""
Thumbnail generation, frame export, and perceptual hashing.

Frame extraction is hash-keyed via config — first frame uses -frames:v 1,
last frame decodes to EOF with -update 1 for true display-frame accuracy.
"""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any

from .config import (
    FRAME_EXTRACT_VERSION,
    _extract_ver_path,
    _hash_dir,
    _invalidate_stale_last_thumb,
    _mark_extract_version,
    _phash_path,
    _thumb_is_current,
    _thumb_path,
)
from .cache import append_history, load_record, resolve_hash, save_record

log = logging.getLogger("mtapi.media_store")


# ── frame extraction (hash-keyed paths) ────────────────────────────────────

def _last_frame_ffmpeg_cmds(
    path: Path,
    out_path: Path,
    *,
    scale: str | None = None,
    q: int = 4,
) -> list[list[str]]:
    """Build ffmpeg command ladder for the *true* last display frame.

    Old approach used ``-sseof -0.5 -frames:v 1`` which grabs the first frame
    after a near-end keyframe seek — often wrong with B-frames / open GOPs.

    Correct approach: seek near the end (for speed), then decode *all*
    remaining frames and keep overwriting the output with ``-update 1``.
    The file that remains after EOF is the actual last presentation frame.
    Fall back to longer windows, then a full-file decode if needed.
    """
    vf = ["-vf", scale] if scale else []
    common_tail = [
        "-an", "-sn",
        "-vsync", "0",
        *vf,
        "-update", "1",
        "-q:v", str(q),
        str(out_path),
    ]
    windows = ["-3", "-10", "-30", "-120"]
    cmds: list[list[str]] = []
    for w in windows:
        cmds.append([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-sseof", w, "-i", str(path),
            *common_tail,
        ])
    cmds.append([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(path),
        *common_tail,
    ])
    return cmds


async def extract_frame(path: Path, out_path: Path, which: str) -> bool:
    """Extract first or last frame as JPEG into out_path.

    Last frame is decoded to EOF (``-update 1``) so B-frame streams yield the
    true final display frame, not a nearby keyframe.
    """
    out_path.parent.mkdir(parents=True, exist_ok=True)
    scale = "scale=480:-2"

    async def _run(cmd: list[str]) -> bool:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, err = await proc.communicate()
        ok = proc.returncode == 0 and out_path.exists() and out_path.stat().st_size > 0
        if not ok and err:
            log.debug("extract_frame cmd failed: %s\n%s", " ".join(cmd[:8]), err.decode(errors="replace")[:400])
        return ok

    if which == "last":
        attempts = _last_frame_ffmpeg_cmds(path, out_path, scale=scale, q=4)
    else:
        attempts = [
            [
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                "-i", str(path),
                "-frames:v", "1", "-vf", scale, "-q:v", "4", str(out_path),
            ],
            [
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                "-ss", "0", "-i", str(path),
                "-frames:v", "1", "-vf", scale, "-q:v", "4", str(out_path),
            ],
        ]

    for cmd in attempts:
        if out_path.exists():
            try:
                out_path.unlink()
            except OSError:
                pass
        if await _run(cmd):
            return True
    return False


async def ensure_thumbs(content_hash: str, source_path: Path, which: str | None = None) -> dict[str, bool]:
    """Generate missing (or stale last-frame) thumbs for this hash. which=None means both."""
    wanted = [which] if which in ("first", "last") else ["first", "last"]
    result = {}
    if "last" in wanted:
        _invalidate_stale_last_thumb(content_hash)

    for w in wanted:
        tp = _thumb_path(content_hash, w)
        if _thumb_is_current(content_hash, w):
            result[w] = True
            continue
        ok = await extract_frame(source_path, tp, w)
        result[w] = ok
        if ok:
            _mark_extract_version(content_hash, w)
            if w == "last":
                pp = _phash_path(content_hash, "last")
                try:
                    if pp.exists():
                        pp.unlink()
                except OSError:
                    pass
        else:
            log.warning("thumb %s failed for %s (%s)", w, content_hash, source_path)
    await ensure_phashes(content_hash, source_path, which=which)
    return result


# ── perceptual hashes (pHash) for frame matching ───────────────────────────

def _compute_phash_hex(image_path: Path) -> str | None:
    """64-bit pHash as hex string (16 chars)."""
    try:
        from PIL import Image
        import imagehash
    except ImportError as e:
        log.warning("pHash deps missing (Pillow/ImageHash): %s", e)
        return None
    try:
        with Image.open(image_path) as im:
            im = im.convert("RGB")
            h = imagehash.phash(im, hash_size=8)
            return str(h)
    except Exception as e:
        log.warning("pHash compute failed for %s: %s", image_path, e)
        return None


def load_phash(content_hash: str, which: str) -> str | None:
    pp = _phash_path(content_hash, which)
    if not pp.exists():
        return None
    try:
        val = pp.read_text(encoding="utf-8").strip()
        return val or None
    except Exception:
        return None


def save_phash(content_hash: str, which: str, hex_hash: str) -> None:
    d = _hash_dir(content_hash)
    d.mkdir(parents=True, exist_ok=True)
    _phash_path(content_hash, which).write_text(hex_hash.strip() + "\n", encoding="utf-8")


def hamming_distance_hex(a: str, b: str) -> int | None:
    """Hamming distance between two hex pHash strings (equal length)."""
    if not a or not b:
        return None
    a = a.strip().lower()
    b = b.strip().lower()
    if len(a) != len(b):
        return None
    try:
        xa = int(a, 16)
        xb = int(b, 16)
    except ValueError:
        return None
    return (xa ^ xb).bit_count()


async def ensure_phashes(
    content_hash: str,
    source_path: Path | None = None,
    which: str | None = None,
) -> dict[str, str | None]:
    """Ensure first/last.phash exist (from thumbs; extract thumbs if needed)."""
    wanted = [which] if which in ("first", "last") else ["first", "last"]
    out: dict[str, str | None] = {}
    for w in wanted:
        existing = load_phash(content_hash, w)
        if existing:
            out[w] = existing
            continue
        tp = _thumb_path(content_hash, w)
        if not (tp.exists() and tp.stat().st_size > 0):
            if source_path and source_path.is_file():
                await extract_frame(source_path, tp, w)
        if tp.exists() and tp.stat().st_size > 0:
            hex_h = await asyncio.to_thread(_compute_phash_hex, tp)
            if hex_h:
                save_phash(content_hash, w, hex_h)
                out[w] = hex_h
            else:
                out[w] = None
        else:
            out[w] = None
    rec = load_record(content_hash)
    if rec is not None:
        rec.setdefault("phashes", {})
        for w, h in out.items():
            if h:
                rec["phashes"][w] = h
        save_record(rec)
    return out


# ── public export API ─────────────────────────────────────────────────────

async def export_frame_png(
    source_path: Path,
    which: str = "first",
    output_path: Path | None = None,
) -> dict[str, Any]:
    """Extract full-resolution first/last frame as PNG to disk (never overwrites)."""
    which = which if which in ("first", "last") else "first"
    source_path = source_path.resolve()
    if not source_path.is_file():
        return {"ok": False, "error": "Source file not found"}

    from ..pathutil import finalize_output_path

    output_path = finalize_output_path(
        output_path,
        source=source_path,
        default_suffix=f"_{which}",
        default_ext=".png",
        allowed_exts={".png"},
    )

    async def _run(cmd: list[str]) -> tuple[bool, str]:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, err = await proc.communicate()
        ok = proc.returncode == 0 and output_path.exists() and output_path.stat().st_size > 0
        return ok, err.decode(errors="replace").strip()

    if which == "last":
        attempts = _last_frame_ffmpeg_cmds(source_path, output_path, scale=None, q=2)
    else:
        attempts = [
            [
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                "-i", str(source_path),
                "-frames:v", "1", "-update", "1", str(output_path),
            ],
        ]

    last_err = ""
    for cmd in attempts:
        if output_path.exists():
            try:
                output_path.unlink()
            except OSError:
                pass
        ok, last_err = await _run(cmd)
        if ok:
            try:
                content_hash, _ = await resolve_hash(source_path)
                append_history(
                    content_hash,
                    "export_frame",
                    detail={
                        "which": which,
                        "output_path": str(output_path),
                        "format": "png",
                        "extract_version": FRAME_EXTRACT_VERSION if which == "last" else 1,
                    },
                )
            except Exception:
                pass
            return {
                "ok": True,
                "which": which,
                "input_path": str(source_path),
                "output_path": str(output_path),
                "size": output_path.stat().st_size,
            }

    return {
        "ok": False,
        "error": last_err or f"Failed to extract {which} frame as PNG",
        "which": which,
        "input_path": str(source_path),
    }


async def get_thumb_file(content_hash: str, which: str, source_path: Path | None = None) -> Path | None:
    """Return path to thumb JPEG, generating if needed and source_path given.

    Stale last-frame thumbs (pre accuracy fix) are regenerated automatically.
    """
    which = which if which in ("first", "last") else "first"
    if which == "last":
        _invalidate_stale_last_thumb(content_hash)
    tp = _thumb_path(content_hash, which)
    if _thumb_is_current(content_hash, which):
        return tp
    if source_path is not None and source_path.is_file():
        ok = await extract_frame(source_path, tp, which)
        if ok:
            _mark_extract_version(content_hash, which)
            if which == "last":
                try:
                    pp = _phash_path(content_hash, "last")
                    if pp.exists():
                        pp.unlink()
                except OSError:
                    pass
            rec = load_record(content_hash)
            if rec:
                rec.setdefault("thumbs", {})[which] = True
                save_record(rec)
            return tp
    return None


def _frame_n_thumb_path(content_hash: str, frame_1based: int) -> Path:
    """Cache path for a specific 1-based frame thumbnail."""
    n = max(1, int(frame_1based))
    return _hash_dir(content_hash) / "range_thumbs" / f"frame_{n:06d}.jpg"


async def extract_frame_at(
    path: Path,
    out_path: Path,
    frame_1based: int,
    *,
    fps: float | None = None,
) -> bool:
    """Extract a single 1-based display frame as JPEG.

    Uses a fast ``-ss`` seek when *fps* is known, then falls back to an exact
    ``select=eq(n,…)`` decode if the seek fails.
    """
    out_path.parent.mkdir(parents=True, exist_ok=True)
    n = max(1, int(frame_1based))
    n0 = n - 1  # 0-based for ffmpeg select
    scale = "scale=480:-2"

    async def _run(cmd: list[str]) -> bool:
        if out_path.exists():
            try:
                out_path.unlink()
            except OSError:
                pass
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, err = await proc.communicate()
        ok = proc.returncode == 0 and out_path.exists() and out_path.stat().st_size > 0
        if not ok and err:
            log.debug(
                "extract_frame_at failed frame=%s: %s\n%s",
                n,
                " ".join(cmd[:10]),
                err.decode(errors="replace")[:400],
            )
        return ok

    attempts: list[list[str]] = []
    # Fast approximate seek (input-side) when fps known
    if fps is not None and fps > 0:
        t = max(0.0, n0 / float(fps))
        attempts.append([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-ss", f"{t:.6f}",
            "-i", str(path),
            "-frames:v", "1",
            "-vf", scale,
            "-q:v", "4",
            str(out_path),
        ])
        # Output-side seek is slower but more accurate near keyframes
        attempts.append([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(path),
            "-ss", f"{t:.6f}",
            "-frames:v", "1",
            "-vf", scale,
            "-q:v", "4",
            str(out_path),
        ])
    # Exact frame index (slow on long clips, always correct)
    attempts.append([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(path),
        "-vf", f"select=eq(n\\,{n0}),{scale}",
        "-vsync", "vfr",
        "-frames:v", "1",
        "-q:v", "4",
        str(out_path),
    ])

    for cmd in attempts:
        if await _run(cmd):
            return True
    return False


async def get_frame_thumb_file(
    content_hash: str,
    frame_1based: int,
    source_path: Path | None = None,
    *,
    fps: float | None = None,
) -> Path | None:
    """Return JPEG for 1-based frame N, caching under by_hash/.../range_thumbs/."""
    n = max(1, int(frame_1based))
    # Reuse permanent first/last cache when applicable
    if n == 1:
        return await get_thumb_file(content_hash, "first", source_path=source_path)

    tp = _frame_n_thumb_path(content_hash, n)
    if tp.exists() and tp.stat().st_size > 0:
        return tp
    if source_path is None or not source_path.is_file():
        return None

    # Probe fps from record if not provided
    if fps is None:
        rec = load_record(content_hash)
        if rec:
            try:
                fps = float(rec.get("fps") or 0) or None
            except (TypeError, ValueError):
                fps = None

    ok = await extract_frame_at(source_path, tp, n, fps=fps)
    return tp if ok else None
