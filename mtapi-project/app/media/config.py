"""
Shared paths, constants, and locks for the media package.

Single source of truth — all sub-modules import from here, never duplicate.
"""
from __future__ import annotations

import asyncio
import os
from pathlib import Path


# ── paths ──────────────────────────────────────────────────────────────────

def _default_root() -> Path:
    env = os.environ.get("MTAPI_MEDIA_CACHE")
    if env:
        return Path(env).expanduser().resolve()
    return Path.home() / ".cache" / "mtapi" / "media"


MEDIA_ROOT = _default_root()
BY_HASH_DIR = MEDIA_ROOT / "by_hash"
INDEX_PATH = MEDIA_ROOT / "index.json"
POOL_STATE_PATH = MEDIA_ROOT.parent / "pool_state.json"

HASH_ALGO = "blake2b"
HASH_DIGEST_SIZE = 16
HASH_CHUNK = 1024 * 1024

FRAME_EXTRACT_VERSION = 3
THUMBNAIL_SIZES = {"H": 480, "M": 240, "L": 120}

# ── locks (single source — no duplication) ─────────────────────────────────

_index_lock = asyncio.Lock()
_hash_locks: dict[str, asyncio.Lock] = {}
_hash_locks_guard = asyncio.Lock()


# ── path helpers ───────────────────────────────────────────────────────────

def _ensure_dirs() -> None:
    BY_HASH_DIR.mkdir(parents=True, exist_ok=True)


def _hash_dir(content_hash: str) -> Path:
    return BY_HASH_DIR / content_hash


def _record_path(content_hash: str) -> Path:
    return _hash_dir(content_hash) / "record.json"


def normalize_thumb_size(size: str | None) -> str:
    value = str(size or "H").upper()
    return value if value in THUMBNAIL_SIZES else "H"


def _thumb_path(content_hash: str, which: str, size: str = "H") -> Path:
    return _hash_dir(content_hash) / f"{which}_{normalize_thumb_size(size)}.jpg"


def _phash_path(content_hash: str, which: str) -> Path:
    return _hash_dir(content_hash) / f"{which}.phash"


def _frames_dir(content_hash: str) -> Path:
    """Directory for full-video frame-strip thumbnails (Frame Scrubber)."""
    return _hash_dir(content_hash) / "frames"


def _extract_ver_path(content_hash: str, which: str, size: str = "H") -> Path:
    return _hash_dir(content_hash) / f"{which}_{normalize_thumb_size(size)}.extract_v"


def _thumb_is_current(content_hash: str, which: str, size: str = "H") -> bool:
    size = normalize_thumb_size(size)
    tp = _thumb_path(content_hash, which, size)
    if not tp.exists() or tp.stat().st_size <= 0:
        return False
    if which != "last":
        return True
    vp = _extract_ver_path(content_hash, which, size)
    try:
        return vp.read_text(encoding="utf-8").strip() == str(FRAME_EXTRACT_VERSION)
    except Exception:
        return False


def existing_thumb_file(content_hash: str, which: str, size: str = "H") -> Path | None:
    """Return an on-disk JPEG if it is already usable. No record/index I/O.

    Prefer the requested size, then H, then the unsized legacy file. A Low
    request must not 404 when High already exists — that is a display miss
    with a perfectly good cache hit.
    """
    if not content_hash:
        return None
    which = which if which in ("first", "last") else "first"
    size = normalize_thumb_size(size)
    candidates = [size]
    for extra in ("H", "M", "L"):
        if extra not in candidates:
            candidates.append(extra)
    for cand in candidates:
        if _thumb_is_current(content_hash, which, cand):
            return _thumb_path(content_hash, which, cand)
    legacy = _hash_dir(content_hash) / f"{which}.jpg"
    try:
        if legacy.exists() and legacy.stat().st_size > 0:
            return legacy
    except OSError:
        return None
    return None


def _mark_extract_version(content_hash: str, which: str, size: str = "H") -> None:
    d = _hash_dir(content_hash)
    d.mkdir(parents=True, exist_ok=True)
    try:
        _extract_ver_path(content_hash, which, size).write_text(
            f"{FRAME_EXTRACT_VERSION}\n", encoding="utf-8"
        )
    except Exception:
        pass


def _invalidate_stale_last_thumb(content_hash: str, size: str | None = None) -> None:
    sizes = [normalize_thumb_size(size)] if size else list(THUMBNAIL_SIZES)
    for thumb_size in sizes:
        if _thumb_is_current(content_hash, "last", thumb_size):
            continue
        for p in (
            _thumb_path(content_hash, "last", thumb_size),
            _phash_path(content_hash, "last"),
            _extract_ver_path(content_hash, "last", thumb_size),
        ):
            try:
                if p.exists():
                    p.unlink()
            except OSError:
                pass


def _path_key(path: Path) -> str:
    return str(path.resolve())
