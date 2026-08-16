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

# Pool-wall previews: display-only JPEGs. Not a match/pHash source.
WALL_WHICH = "wall"
WALL_PAIR_WHICH = "wall_pair"
WALL_WIDTH = 120
WALL_FILENAME = "wall.jpg"
WALL_PAIR_FILENAME = "wall_pair.jpg"

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
    """True when a usable JPEG is already on disk.

    extract_v is a write-side stamp for new extracts. An existing JPEG is a
    paid cache hit — do not hide it because the stamp is older or missing.
    """
    size = normalize_thumb_size(size)
    tp = _thumb_path(content_hash, which, size)
    try:
        return tp.exists() and tp.stat().st_size > 0
    except OSError:
        return False


def _wall_path(content_hash: str) -> Path:
    return _hash_dir(content_hash) / WALL_FILENAME


def existing_wall_file(content_hash: str) -> Path | None:
    """On-disk first-frame wall preview if already written. No record I/O."""
    return _existing_named(content_hash, WALL_FILENAME)


def _wall_pair_path(content_hash: str) -> Path:
    return _hash_dir(content_hash) / WALL_PAIR_FILENAME


def existing_wall_pair_file(content_hash: str) -> Path | None:
    """On-disk first+last combo wall if already written. No record I/O."""
    return _existing_named(content_hash, WALL_PAIR_FILENAME)


def _existing_named(content_hash: str, filename: str) -> Path | None:
    if not content_hash:
        return None
    tp = _hash_dir(content_hash) / filename
    try:
        if tp.exists() and tp.stat().st_size > 0:
            return tp
    except OSError:
        return None
    return None


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
    """No-op. Existing last-frame JPEGs stay; a version bump must not delete them."""
    return


def _path_key(path: Path) -> str:
    return str(path.resolve())
