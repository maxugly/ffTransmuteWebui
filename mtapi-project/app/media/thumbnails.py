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
    WALL_PAIR_WHICH,
    WALL_WHICH,
    WALL_WIDTH,
    _extract_ver_path,
    _hash_dir,
    _invalidate_stale_last_thumb,
    _mark_extract_version,
    _phash_path,
    _thumb_is_current,
    _thumb_path,
    _wall_pair_path,
    _wall_path,
    existing_thumb_file,
    existing_wall_file,
    existing_wall_pair_file,
    THUMBNAIL_SIZES,
    normalize_thumb_size,
)
from .cache import append_history, load_record, resolve_hash, save_record, source_path_for_hash
from .performance import load_settings, phash_cache

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
        "-fps_mode", "passthrough",
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


async def extract_frame(path: Path, out_path: Path, which: str, *, size: str = "H") -> bool:
    """Extract first or last frame as JPEG into out_path.

    Last frame is decoded to EOF (``-update 1``) so B-frame streams yield the
    true final display frame, not a nearby keyframe.
    """
    out_path.parent.mkdir(parents=True, exist_ok=True)
    size = normalize_thumb_size(size)
    scale = f"scale={THUMBNAIL_SIZES[size]}:-2"

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


async def ensure_thumbs(
    content_hash: str,
    source_path: Path,
    which: str | None = None,
    record: dict | None = None,
    *,
    size: str = "H",
) -> dict[str, bool]:
    """Generate missing (or stale last-frame) thumbs for this hash. which=None means both."""
    size = normalize_thumb_size(size)
    wanted = [which] if which in ("first", "last") else ["first", "last"]
    result = {}
    
    rec = record if record is not None else load_record(content_hash)
    failed_flags = rec.get("thumb_failed", {}) if rec else {}

    if "last" in wanted:
        _invalidate_stale_last_thumb(content_hash, size)

    needs_save = False
    for w in wanted:
        tp = _thumb_path(content_hash, w, size)
        if _thumb_is_current(content_hash, w, size):
            result[w] = True
            continue
            
        if failed_flags.get(w) == FRAME_EXTRACT_VERSION:
            result[w] = False
            continue

        ok = await extract_frame(source_path, tp, w, size=size)
        result[w] = ok
        if ok:
            _mark_extract_version(content_hash, w, size)
            if w == "last":
                pp = _phash_path(content_hash, "last")
                try:
                    if pp.exists():
                        pp.unlink()
                except OSError:
                    pass
        else:
            log.warning("thumb %s failed for %s (%s)", w, content_hash, source_path)
            if rec is not None:
                rec.setdefault("thumb_failed", {})[w] = FRAME_EXTRACT_VERSION
                needs_save = True

    if needs_save and record is None and rec is not None:
        save_record(rec)

    await ensure_phashes(content_hash, source_path, which=which, record=rec)
    return result


# ── pool-wall preview (display only — never a pHash / match source) ────────

_wall_sem = asyncio.Semaphore(8)


def _write_wall_from_image(src: Path, dest: Path) -> bool:
    """Resize an existing still to the 120px wall JPEG. No video decode."""
    try:
        from PIL import Image
    except ImportError as e:
        log.warning("wall preview needs Pillow: %s", e)
        return False
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_name(dest.name + ".tmp")
        with Image.open(src) as im:
            im = im.convert("RGB")
            w, h = im.size
            if w != WALL_WIDTH and w > 0:
                nh = max(1, int(round(h * (WALL_WIDTH / float(w)))))
                im = im.resize((WALL_WIDTH, nh), Image.Resampling.BILINEAR)
            im.save(tmp, "JPEG", quality=70, optimize=True)
        if not tmp.exists() or tmp.stat().st_size <= 0:
            try:
                tmp.unlink()
            except OSError:
                pass
            return False
        tmp.replace(dest)
        return dest.exists() and dest.stat().st_size > 0
    except Exception as e:
        log.warning("wall preview resize failed for %s: %s", src, e)
        try:
            dest.with_name(dest.name + ".tmp").unlink()
        except OSError:
            pass
        return False


async def ensure_wall_preview(
    content_hash: str,
    source_path: Path | None = None,
    record: dict | None = None,
    *,
    generate_from_video: bool = False,
) -> Path | None:
    """Materialize by_hash/<hash>/wall.jpg.

    Prefer an already-paid first-frame JPEG (any size). Only extract a first
    frame from the source file when generate_from_video is set (import/open).
    Never writes first/last match thumbs and never computes pHash.
    """
    if not content_hash:
        return None
    ready = existing_wall_file(content_hash)
    if ready is not None:
        return ready

    rec = record if record is not None else load_record(content_hash)
    failed = rec.get("thumb_failed", {}) if rec else {}
    if failed.get(WALL_WHICH) == FRAME_EXTRACT_VERSION and not generate_from_video:
        return None

    async with _wall_sem:
        ready = existing_wall_file(content_hash)
        if ready is not None:
            return ready

        dest = _wall_path(content_hash)
        src = existing_thumb_file(content_hash, "first", "L")
        if src is not None:
            ok = await asyncio.to_thread(_write_wall_from_image, src, dest)
            if ok:
                if rec is not None:
                    rec.setdefault("thumbs", {})[WALL_WHICH] = True
                    if "thumb_failed" in rec:
                        rec["thumb_failed"].pop(WALL_WHICH, None)
                return dest

        if generate_from_video:
            if source_path is None or not source_path.is_file():
                source_path = source_path_for_hash(content_hash)
            if source_path is not None and source_path.is_file():
                ok = await extract_frame(source_path, dest, "first", size="L")
                if ok:
                    if rec is not None:
                        rec.setdefault("thumbs", {})[WALL_WHICH] = True
                        if "thumb_failed" in rec:
                            rec["thumb_failed"].pop(WALL_WHICH, None)
                    return dest
                if rec is not None:
                    rec.setdefault("thumb_failed", {})[WALL_WHICH] = FRAME_EXTRACT_VERSION
                    if record is None:
                        save_record(rec)
        return existing_wall_file(content_hash)


def _write_wall_pair(first_src: Path, last_src: Path, dest: Path) -> bool:
    """Side-by-side first|last at 120px per half. No video decode."""
    try:
        from PIL import Image
    except ImportError as e:
        log.warning("wall pair needs Pillow: %s", e)
        return False

    def _half(im: "Image.Image") -> "Image.Image":
        im = im.convert("RGB")
        w, h = im.size
        if w <= 0:
            return im
        nh = max(1, int(round(h * (WALL_WIDTH / float(w)))))
        return im.resize((WALL_WIDTH, nh), Image.Resampling.BILINEAR)

    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_name(dest.name + ".tmp")
        with Image.open(first_src) as a_im, Image.open(last_src) as b_im:
            a = _half(a_im)
            b = _half(b_im)
            h = min(a.size[1], b.size[1])
            if a.size[1] != h:
                top = (a.size[1] - h) // 2
                a = a.crop((0, top, WALL_WIDTH, top + h))
            if b.size[1] != h:
                top = (b.size[1] - h) // 2
                b = b.crop((0, top, WALL_WIDTH, top + h))
            out = Image.new("RGB", (WALL_WIDTH * 2, h))
            out.paste(a, (0, 0))
            out.paste(b, (WALL_WIDTH, 0))
            out.save(tmp, "JPEG", quality=70, optimize=True)
        if not tmp.exists() or tmp.stat().st_size <= 0:
            try:
                tmp.unlink()
            except OSError:
                pass
            return False
        tmp.replace(dest)
        return dest.exists() and dest.stat().st_size > 0
    except Exception as e:
        log.warning("wall pair compose failed for %s + %s: %s", first_src, last_src, e)
        try:
            dest.with_name(dest.name + ".tmp").unlink()
        except OSError:
            pass
        return False


async def ensure_wall_pair(
    content_hash: str,
    source_path: Path | None = None,
    record: dict | None = None,
    *,
    generate_from_video: bool = False,
) -> Path | None:
    """Materialize by_hash/<hash>/wall_pair.jpg from first+last frames."""
    if not content_hash:
        return None
    ready = existing_wall_pair_file(content_hash)
    if ready is not None:
        return ready

    rec = record if record is not None else load_record(content_hash)
    failed = rec.get("thumb_failed", {}) if rec else {}
    if failed.get(WALL_PAIR_WHICH) == FRAME_EXTRACT_VERSION and not generate_from_video:
        return None

    async with _wall_sem:
        ready = existing_wall_pair_file(content_hash)
        if ready is not None:
            return ready

        if generate_from_video:
            if source_path is None or not source_path.is_file():
                source_path = source_path_for_hash(content_hash)
            if source_path is not None and source_path.is_file():
                await ensure_thumbs(content_hash, source_path, record=rec)

        first = existing_thumb_file(content_hash, "first", "L")
        last = existing_thumb_file(content_hash, "last", "L")
        dest = _wall_pair_path(content_hash)
        if first is not None and last is not None:
            ok = await asyncio.to_thread(_write_wall_pair, first, last, dest)
            if ok:
                if rec is not None:
                    rec.setdefault("thumbs", {})[WALL_PAIR_WHICH] = True
                    if "thumb_failed" in rec:
                        rec["thumb_failed"].pop(WALL_PAIR_WHICH, None)
                return dest

        if generate_from_video and first is not None and last is None:
            # Last extract failed — still offer a wall file so the tile is not blank.
            ok = await asyncio.to_thread(_write_wall_from_image, first, dest)
            if ok:
                if rec is not None:
                    rec.setdefault("thumbs", {})[WALL_PAIR_WHICH] = True
                return dest

        if generate_from_video and rec is not None and existing_wall_pair_file(content_hash) is None:
            rec.setdefault("thumb_failed", {})[WALL_PAIR_WHICH] = FRAME_EXTRACT_VERSION
            if record is None:
                save_record(rec)
        return existing_wall_pair_file(content_hash)


async def ensure_wall_previews(
    content_hash: str,
    source_path: Path | None = None,
    record: dict | None = None,
    *,
    generate_from_video: bool = False,
) -> dict[str, Path | None]:
    """Write both wall.jpg (first only) and wall_pair.jpg (first|last)."""
    single = await ensure_wall_preview(
        content_hash, source_path, record, generate_from_video=generate_from_video,
    )
    pair = await ensure_wall_pair(
        content_hash, source_path, record, generate_from_video=generate_from_video,
    )
    return {WALL_WHICH: single, WALL_PAIR_WHICH: pair}


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
    settings = load_settings()
    # pHash is deliberately keyed independently of display thumbnail size.
    # The H representation remains the stable source for matching.
    if settings.get("phash_to_ram"):
        # The sync caller is kept for existing APIs; async matching uses the
        # disk path below when the value is not already available.
        pass
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
    record: dict | None = None,
    *,
    size: str = "H",
) -> dict[str, str | None]:
    """Ensure first/last.phash exist (from thumbs; extract thumbs if needed)."""
    # pHash always uses the high-resolution representation for stable results.
    size = "H"
    wanted = [which] if which in ("first", "last") else ["first", "last"]
    out: dict[str, str | None] = {}
    
    rec = record if record is not None else load_record(content_hash)
    failed_flags = rec.get("thumb_failed", {}) if rec else {}

    for w in wanted:
        if load_settings().get("phash_to_ram"):
            cached_hash = await phash_cache.get((content_hash, w))
            if isinstance(cached_hash, str) and cached_hash:
                out[w] = cached_hash
                continue
        existing = load_phash(content_hash, w)
        if existing:
            out[w] = existing
            if load_settings().get("phash_to_ram"):
                await phash_cache.put((content_hash, w), existing)
            continue
        tp = _thumb_path(content_hash, w, size)
        if not (tp.exists() and tp.stat().st_size > 0):
            if source_path and source_path.is_file() and failed_flags.get(w) != FRAME_EXTRACT_VERSION:
                # If we get here and it fails, ensure_thumbs didn't catch it,
                # but we'll try once and then it'll fail the exists check below.
                # Ideally ensure_thumbs handles the failure caching.
                await extract_frame(source_path, tp, w, size=size)
        if tp.exists() and tp.stat().st_size > 0:
            hex_h = await asyncio.to_thread(_compute_phash_hex, tp)
            if hex_h:
                save_phash(content_hash, w, hex_h)
                out[w] = hex_h
                if load_settings().get("phash_to_ram"):
                    await phash_cache.put((content_hash, w), hex_h)
            else:
                out[w] = None
        else:
            out[w] = None

    if rec is not None:
        rec.setdefault("phashes", {})
        for w, h in out.items():
            if h:
                rec["phashes"][w] = h
        if record is None:
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


async def get_thumb_file(
    content_hash: str,
    which: str,
    source_path: Path | None = None,
    *,
    size: str = "H",
) -> Path | None:
    """Return path to thumb JPEG, generating if needed.

    Hash-only callers have no source_path. Resolve one from the record's
    remembered paths so existing cache records can still serve thumbs.
    Already-failed extracts (thumb_failed == FRAME_EXTRACT_VERSION) are not
    retried. Missing thumbs with no usable source return None (caller 404s).
    """
    which = which if which in ("first", "last") else "first"
    size = normalize_thumb_size(size)
    if which == "last":
        _invalidate_stale_last_thumb(content_hash, size)
    tp = _thumb_path(content_hash, which, size)
    if _thumb_is_current(content_hash, which, size):
        return tp
    # Legacy unsized first.jpg from before per-size cache keys.
    if which == "first" and size == "H":
        legacy = _hash_dir(content_hash) / "first.jpg"
        if legacy.exists() and legacy.stat().st_size > 0:
            return legacy

    rec = load_record(content_hash)
    failed = (rec or {}).get("thumb_failed") or {}
    if failed.get(which) == FRAME_EXTRACT_VERSION:
        return None

    if source_path is None or not source_path.is_file():
        source_path = source_path_for_hash(content_hash)

    if source_path is not None and source_path.is_file():
        ok = await extract_frame(source_path, tp, which, size=size)
        if ok:
            _mark_extract_version(content_hash, which, size)
            if which == "last":
                try:
                    pp = _phash_path(content_hash, "last")
                    if pp.exists():
                        pp.unlink()
                except OSError:
                    pass
            rec = rec or load_record(content_hash)
            if rec:
                rec.setdefault("thumbs", {})[which] = True
                if "thumb_failed" in rec:
                    rec["thumb_failed"].pop(which, None)
                save_record(rec)
            return tp
        if rec is not None:
            rec.setdefault("thumb_failed", {})[which] = FRAME_EXTRACT_VERSION
            save_record(rec)
    return None


def _frame_n_thumb_path(content_hash: str, frame_1based: int, size: str = "H") -> Path:
    """Cache path for a specific 1-based frame thumbnail."""
    n = max(1, int(frame_1based))
    return _hash_dir(content_hash) / "range_thumbs" / f"frame_{n:06d}_{normalize_thumb_size(size)}.jpg"


async def extract_frame_at(
    path: Path,
    out_path: Path,
    frame_1based: int,
    *,
    fps: float | None = None,
    size: str = "H",
) -> bool:
    """Extract a single 1-based display frame as JPEG.

    Uses a fast ``-ss`` seek when *fps* is known, then falls back to an exact
    ``select=eq(n,…)`` decode if the seek fails.
    """
    out_path.parent.mkdir(parents=True, exist_ok=True)
    n = max(1, int(frame_1based))
    n0 = n - 1  # 0-based for ffmpeg select
    size = normalize_thumb_size(size)
    scale = f"scale={THUMBNAIL_SIZES[size]}:-2"

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
        "-fps_mode", "vfr",
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
    size: str = "H",
) -> Path | None:
    """Return JPEG for 1-based frame N, caching under by_hash/.../range_thumbs/."""
    size = normalize_thumb_size(size)
    n = max(1, int(frame_1based))
    # Reuse permanent first/last cache when applicable
    if n == 1:
        return await get_thumb_file(content_hash, "first", source_path=source_path, size=size)

    tp = _frame_n_thumb_path(content_hash, n, size)
    if tp.exists() and tp.stat().st_size > 0:
        return tp
    if source_path is None or not source_path.is_file():
        source_path = source_path_for_hash(content_hash)
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

    ok = await extract_frame_at(source_path, tp, n, fps=fps, size=size)
    return tp if ok else None
