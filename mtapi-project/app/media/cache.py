"""
Content-addressable cache: hashing, index, records, and operation tracking.

No thumbnail generation or open_media — those live in thumbnails.py and open.py.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from pathlib import Path
from typing import Any

from .config import (
    _ensure_dirs,
    _hash_dir,
    _hash_locks,
    _hash_locks_guard,
    _index_lock,
    _path_key,
    _record_path,
    _thumb_path,
    BY_HASH_DIR,
    HASH_ALGO,
    HASH_CHUNK,
    HASH_DIGEST_SIZE,
    INDEX_PATH,
    MEDIA_ROOT,
    POOL_STATE_PATH,
)

log = logging.getLogger("mtapi.media_store")

_index_cache: tuple[float, dict[str, Any]] | None = None


# ── index (path → hash, skipped when size/mtime match) ─────────────────────

def _load_index() -> dict[str, Any]:
    global _index_cache
    try:
        current_mtime = INDEX_PATH.stat().st_mtime
    except OSError:
        _index_cache = None
        return {"version": 1, "paths": {}}
    if _index_cache is not None:
        cache_mtime, data = _index_cache
        if cache_mtime == current_mtime:
            return data
    _ensure_dirs()
    if not INDEX_PATH.exists():
        data = {"version": 1, "paths": {}}
    else:
        try:
            data = json.loads(INDEX_PATH.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                return {"version": 1, "paths": {}}
            data.setdefault("version", 1)
            data.setdefault("paths", {})
        except Exception as e:
            log.warning("media index load failed: %s", e)
            return {"version": 1, "paths": {}}
    _index_cache = (current_mtime, data)
    return data


def _save_index(index: dict[str, Any]) -> None:
    _ensure_dirs()
    tmp = INDEX_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(index, indent=2, sort_keys=True), encoding="utf-8")
    tmp.replace(INDEX_PATH)
    _index_cache = None


async def _update_index_entry(path: Path, content_hash: str, size: int, mtime_ns: int) -> None:
    async with _index_lock:
        index = _load_index()
        index["paths"][_path_key(path)] = {
            "hash": content_hash,
            "size": size,
            "mtime_ns": mtime_ns,
            "updated_at": time.time(),
        }
        _save_index(index)


def lookup_cached_hash(path: Path, index: dict[str, Any] | None = None) -> str | None:
    """Return content hash if path is indexed and size+mtime still match."""
    try:
        st = path.stat()
    except OSError:
        return None
    if index is None:
        index = _load_index()
    entry = index.get("paths", {}).get(_path_key(path))
    if not entry:
        return None
    if entry.get("size") == st.st_size and entry.get("mtime_ns") == st.st_mtime_ns:
        h = entry.get("hash")
        if h and _record_path(h).exists():
            return h
    return None


def lookup_cached_hash_batch(paths: list[Path], index: dict[str, Any] | None = None) -> dict[str, str | None]:
    """Batch version: return mapping of resolved_path -> hash (or None)."""
    if index is None:
        index = _load_index()
    out: dict[str, str | None] = {}
    for path in paths:
        try:
            st = path.stat()
        except OSError:
            out[str(path.resolve())] = None
            continue
        entry = index.get("paths", {}).get(_path_key(path))
        if not entry:
            out[str(path.resolve())] = None
            continue
        if entry.get("size") == st.st_size and entry.get("mtime_ns") == st.st_mtime_ns:
            h = entry.get("hash")
            if h and _record_path(h).exists():
                out[str(path.resolve())] = h
                continue
        out[str(path.resolve())] = None
    return out


# ── hashing ────────────────────────────────────────────────────────────────

def _hash_file_sync(path: Path) -> str:
    """Full-file blake2b. Intentionally thorough — cached after first run."""
    h = hashlib.blake2b(digest_size=HASH_DIGEST_SIZE)
    with path.open("rb") as f:
        while True:
            chunk = f.read(HASH_CHUNK)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


async def hash_file(path: Path) -> str:
    """Hash on a worker thread so the event loop stays responsive."""
    return await asyncio.to_thread(_hash_file_sync, path)


async def _lock_for_hash(content_hash: str) -> asyncio.Lock:
    async with _hash_locks_guard:
        lock = _hash_locks.get(content_hash)
        if lock is None:
            lock = asyncio.Lock()
            _hash_locks[content_hash] = lock
        return lock


# ── records ────────────────────────────────────────────────────────────────

def _empty_record(content_hash: str, size: int = 0) -> dict[str, Any]:
    now = time.time()
    return {
        "hash": content_hash,
        "algo": HASH_ALGO,
        "size": size,
        "paths": [],
        "meta": None,
        "thumbs": {"first": False, "last": False},
        "history": [],
        "variants": {},
        "created_at": now,
        "updated_at": now,
        "open_count": 0,
    }


def load_record(content_hash: str) -> dict[str, Any] | None:
    rp = _record_path(content_hash)
    if not rp.exists():
        return None
    try:
        data = json.loads(rp.read_text(encoding="utf-8"))
        data.setdefault("thumbs", {})
        data["thumbs"]["first"] = _thumb_path(content_hash, "first").exists()
        data["thumbs"]["last"] = _thumb_path(content_hash, "last").exists()
        return data
    except Exception as e:
        log.warning("record load failed for %s: %s", content_hash, e)
        return None


def save_record(record: dict[str, Any]) -> None:
    content_hash = record["hash"]
    d = _hash_dir(content_hash)
    d.mkdir(parents=True, exist_ok=True)
    record["updated_at"] = time.time()
    record.setdefault("thumbs", {})
    record["thumbs"]["first"] = _thumb_path(content_hash, "first").exists()
    record["thumbs"]["last"] = _thumb_path(content_hash, "last").exists()
    rp = _record_path(content_hash)
    tmp = rp.with_suffix(".tmp")
    tmp.write_text(json.dumps(record, indent=2, sort_keys=True), encoding="utf-8")
    tmp.replace(rp)


def _remember_path(record: dict[str, Any], path: Path) -> None:
    p = str(path.resolve())
    paths: list = record.setdefault("paths", [])
    if p not in paths:
        paths.insert(0, p)
        del paths[RECENT_CAP:]


def append_history(
    content_hash: str,
    event: str,
    *,
    detail: dict[str, Any] | None = None,
    max_events: int = 200,
) -> dict[str, Any] | None:
    """Append a history event (opened, op, generated, …). Returns updated record."""
    record = load_record(content_hash)
    if not record:
        return None
    entry = {
        "ts": time.time(),
        "event": event,
        **(detail or {}),
    }
    hist = record.setdefault("history", [])
    hist.append(entry)
    if len(hist) > max_events:
        record["history"] = hist[-max_events:]
    save_record(record)
    return record


# ── resolve ────────────────────────────────────────────────────────────────

async def resolve_hash(path: Path, index: dict[str, Any] | None = None) -> tuple[str, bool]:
    """Return (content_hash, was_cached)."""
    path = path.resolve()
    cached = lookup_cached_hash(path, index=index)
    if cached:
        return cached, True

    st = path.stat()
    content_hash = await hash_file(path)
    await _update_index_entry(path, content_hash, st.st_size, st.st_mtime_ns)
    return content_hash, False


# ── operation tracking ─────────────────────────────────────────────────────

async def record_operation(
    input_path: str | Path | None,
    *,
    operation: str,
    output_path: str | None = None,
    ok: bool = True,
    dry_run: bool = False,
    extra: dict[str, Any] | None = None,
) -> None:
    """Attach an op event to the input's content-hash record (and output if new file)."""
    if not input_path or dry_run:
        return
    try:
        path = Path(str(input_path)).resolve()
        if not path.is_file():
            return
        content_hash, _ = await resolve_hash(path)
        detail = {
            "operation": operation,
            "ok": ok,
            "input_path": str(path),
        }
        if output_path:
            detail["output_path"] = output_path
        if extra:
            detail.update(extra)
        append_history(content_hash, "operation", detail=detail)

        if ok and output_path:
            out = Path(output_path).resolve()
            if out.is_file():
                out_hash, _ = await resolve_hash(out)
                lock = await _lock_for_hash(out_hash)
                async with lock:
                    rec = load_record(out_hash) or _empty_record(out_hash, size=out.stat().st_size)
                    _remember_path(rec, out)
                    rec.setdefault("history", []).append({
                        "ts": time.time(),
                        "event": "generated",
                        "operation": operation,
                        "parent_hash": content_hash,
                        "parent_path": str(path),
                        "path": str(out),
                    })
                    if len(rec["history"]) > 200:
                        rec["history"] = rec["history"][-200:]
                    save_record(rec)
    except Exception as e:
        log.warning("record_operation failed: %s", e)


# ── variant registry ────────────────────────────────────────────────────────
# A clip's derivative files (rifed, export, …) live NEXT TO the original on
# disk; the central record holds the named association. No sidecar JSON.

RECENT_CAP = 32  # shared cap for recent-path lists and per-kind variant lists


async def register_variant(
    parent_path: str | Path,
    *,
    kind: str,
    variant_path: str | Path,
    detail: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """Attach a derived clip (rifed/export/...) to its original's record.

    - Hashes the variant file (content-addressed, cached).
    - Loads the ORIGINAL clip's record by path (resolve_hash → record).
    - Appends a variant_entry under record["variants"][kind] (FIFO capped).
    - Creates the parent's record (minimal, no thumbs) if it doesn't yet exist,
      so callers don't need to open_media every clip before registering.
    No file moves/copies — the caller writes variant_path next to the original.
    """
    parent = Path(parent_path).resolve()
    variant = Path(variant_path).resolve()
    (parent_hash, _), (variant_hash, _) = await asyncio.gather(
        resolve_hash(parent), resolve_hash(variant)
    )

    lock = await _lock_for_hash(parent_hash)
    async with lock:
        rec = load_record(parent_hash)
        if not rec:
            rec = _empty_record(parent_hash, size=parent.stat().st_size)
        entry = {
            "kind": kind,
            "hash": variant_hash,
            "path": str(variant),
            "created_at": time.time(),
            "detail": detail or {},
        }
        lst = rec.setdefault("variants", {}).setdefault(kind, [])
        lst.append(entry)
        del lst[:-RECENT_CAP]   # keep newest RECENT_CAP; NOT lst[:RECENT_CAP] (that drops new)
        _remember_path(rec, variant)
        save_record(rec)
        return rec


async def get_variants(
    parent_path: str | Path,
    *,
    include_missing: bool = False,
) -> dict[str, list[dict[str, Any]]]:
    """Return record['variants'] for the clip at parent_path, or {}.

    - Old records without a 'variants' key return {} (no KeyError).
    - By default, entries whose 'path' no longer exists on disk are dropped,
      so callers never load dead files. Pass include_missing=True to keep them
      (e.g. so the UI can show the variant greyed-out as "missing").
    """
    parent = Path(parent_path).resolve()
    parent_hash = lookup_cached_hash(parent)
    if not parent_hash:
        return {}
    rec = load_record(parent_hash)
    if not rec:
        return {}
    variants = rec.get("variants", {})
    if include_missing:
        return variants
    return {
        kind: [v for v in entries if v.get("path") and Path(v["path"]).exists()]
        for kind, entries in variants.items()
    }


# ── stats ──────────────────────────────────────────────────────────────────

def media_cache_stats() -> dict[str, Any]:
    _ensure_dirs()
    index = _load_index()
    hash_dirs = [p for p in BY_HASH_DIR.iterdir()] if BY_HASH_DIR.exists() else []
    thumb_count = 0
    for d in hash_dirs:
        if (d / "first.jpg").exists():
            thumb_count += 1
        if (d / "last.jpg").exists():
            thumb_count += 1
    return {
        "root": str(MEDIA_ROOT),
        "indexed_paths": len(index.get("paths") or {}),
        "hashes": len(hash_dirs),
        "thumb_files": thumb_count,
        "pool_state": str(POOL_STATE_PATH),
        "pool_state_exists": POOL_STATE_PATH.exists(),
    }
