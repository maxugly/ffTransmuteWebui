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

def _catalog_ready():
    from .catalog import catalog_if_ready
    return catalog_if_ready()


def _load_index() -> dict[str, Any]:
    cat = _catalog_ready()
    if cat is not None:
        return cat.index_document()
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
    cat = _catalog_ready()
    if cat is not None:
        cat.persist_index()
        return
    _ensure_dirs()
    tmp = INDEX_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(index, indent=2, sort_keys=True), encoding="utf-8")
    tmp.replace(INDEX_PATH)
    _index_cache = None


async def _update_index_entry(path: Path, content_hash: str, size: int, mtime_ns: int) -> None:
    cat = _catalog_ready()
    if cat is not None:
        cat.update_path_mapping(path, content_hash, size, mtime_ns, persist=True)
        return
    async with _index_lock:
        index = _load_index()
        index["paths"][_path_key(path)] = {
            "hash": content_hash,
            "size": size,
            "mtime_ns": mtime_ns,
            "updated_at": time.time(),
        }
        _save_index(index)


def lookup_cached_hash(
    path: Path,
    index: dict[str, Any] | None = None,
    *,
    check_source: bool = False,
) -> str | None:
    """Return content hash if this path is indexed at the same file size.

    Cheap identity is path + filename + size. mtime must not force a re-hash
    (copy, backup, and NAS tools change mtime without changing bytes).
    After catalog_ready, display callers omit check_source and never stat.
    """
    cat = _catalog_ready()
    if cat is not None and not check_source:
        return cat.hash_for_path(path)
    if cat is not None and check_source:
        cat.note_source_stat()
        try:
            st = path.stat()
        except OSError:
            return None
        key_hash = cat.hash_for_path(path)
        if key_hash is None:
            return None
        rec = cat.record_for_hash(key_hash)
        if rec is None:
            return None
        if rec.size and rec.size != st.st_size:
            return None
        return key_hash
    try:
        st = path.stat()
    except OSError:
        return None
    if index is None:
        index = _load_index()
    entry = index.get("paths", {}).get(_path_key(path))
    if not entry:
        return None
    if entry.get("size") != st.st_size:
        return None
    h = entry.get("hash")
    if h and _record_path(h).exists():
        return h
    return None


def lookup_cached_hash_batch(paths: list[Path], index: dict[str, Any] | None = None) -> dict[str, str | None]:
    """Batch version: return mapping of resolved_path -> hash (or None)."""
    cat = _catalog_ready()
    if cat is not None:
        out: dict[str, str | None] = {}
        for path in paths:
            key = str(path)
            out[key] = cat.hash_for_path(path)
        return out
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
        if entry.get("size") == st.st_size:
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
    cat = _catalog_ready()
    if cat is not None:
        rec = cat.record_for_hash(content_hash)
        return cat.serving_dict(rec) if rec is not None else None
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
    cat = _catalog_ready()
    if cat is not None:
        payload = dict(record)
        if payload.get("history") == []:
            payload.pop("history", None)
        cat.upsert_record(payload)
        return
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
    cached = lookup_cached_hash(path, index=index, check_source=True)
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
BATCH_PATH_LIMIT = 100


def parse_batch_paths(raw_paths: Any) -> tuple[list[str], str | None]:
    """Normalize a batch path list.

    Returns (unique_absolute_paths, error). ``error`` is a human message when
    the payload is invalid (not a list, a relative path, or more than
    ``BATCH_PATH_LIMIT`` unique entries). Duplicates are stripped. Relative
    paths are rejected. Missing files are kept — callers map them to null.
    """
    if not isinstance(raw_paths, list):
        return [], "paths must be a list"
    unique: list[str] = []
    seen: set[str] = set()
    for item in raw_paths:
        if item is None:
            continue
        text = str(item).strip()
        if not text:
            continue
        p = Path(text).expanduser()
        if not p.is_absolute():
            return [], f"path must be absolute: {text}"
        try:
            key = str(p.resolve())
        except OSError:
            key = str(p)
        if key in seen:
            continue
        seen.add(key)
        unique.append(key)
    if len(unique) > BATCH_PATH_LIMIT:
        return [], f"maximum {BATCH_PATH_LIMIT} unique paths per request"
    return unique, None


def stat_signature(path: str | Path) -> dict[str, int] | None:
    """Direct os.stat only. Missing/inaccessible files return None."""
    p = Path(path)
    try:
        st = p.stat()
    except OSError:
        return None
    if not p.is_file():
        return None
    return {"size": int(st.st_size), "mtime_ns": int(st.st_mtime_ns)}


def source_path_for_hash(content_hash: str) -> Path | None:
    """First existing recorded file for this hash.

    Only walks the record's remembered paths. Does not scan the global
    path index (that is O(indexed files) and belongs on recovery, not
    every thumbnail request).
    """
    if not content_hash:
        return None
    rec = load_record(content_hash)
    if not rec:
        return None
    for raw in rec.get("paths") or []:
        if not raw:
            continue
        try:
            p = Path(str(raw))
            if p.is_file() and p.stat().st_size > 0:
                return p
        except OSError:
            continue
    return None


def find_existing_paths_for_hash(content_hash: str) -> list[str]:
    """Known locations of a content-hash that still exist on disk.

    Searches the record's remembered paths and the path index. This is
    identity recovery, not a filesystem walk.
    """
    if not content_hash:
        return []
    found: list[str] = []
    seen: set[str] = set()

    def _add(raw: str | Path | None) -> None:
        if not raw:
            return
        try:
            p = Path(str(raw)).expanduser()
            if not p.is_file():
                return
            key = str(p.resolve())
        except OSError:
            return
        if key in seen:
            return
        seen.add(key)
        found.append(key)

    rec = load_record(content_hash)
    if rec:
        for p in rec.get("paths") or []:
            _add(p)
    index = _load_index()
    for path_key, entry in (index.get("paths") or {}).items():
        if not isinstance(entry, dict):
            continue
        if entry.get("hash") != content_hash:
            continue
        _add(path_key)
    return found


def recover_media_path(
    *,
    content_hash: str | None = None,
    last_path: str | Path | None = None,
    parent_path: str | Path | None = None,
    multiplier: int | None = None,
) -> dict[str, Any]:
    """Targeted identity recovery for a moved/missing file.

    Never hashes, never probes, never re-encodes. Returns the first existing
    path that matches the stored hash (or a parent-record rifed entry).
    """
    if last_path:
        lp = Path(str(last_path)).expanduser()
        try:
            if lp.is_file():
                resolved = str(lp.resolve())
                return {
                    "ok": True,
                    "found": True,
                    "recovered": False,
                    "path": resolved,
                    "hash": content_hash,
                    "candidates": [resolved],
                }
        except OSError:
            pass

    hash_candidates: list[str] = []
    if content_hash:
        hash_candidates.append(content_hash)

    if parent_path:
        parent = Path(str(parent_path)).expanduser()
        try:
            parent_res = parent.resolve() if parent.exists() else parent
        except OSError:
            parent_res = parent
        parent_hash = lookup_cached_hash(parent_res) if parent_res.exists() else None
        if not parent_hash:
            index = _load_index()
            entry = (index.get("paths") or {}).get(_path_key(parent_res))
            if isinstance(entry, dict):
                parent_hash = entry.get("hash")
        rec = load_record(parent_hash) if parent_hash else None
        if rec:
            for v in (rec.get("variants") or {}).get("rifed") or []:
                if not isinstance(v, dict):
                    continue
                if last_path and v.get("path") and Path(str(v["path"])).resolve() == Path(str(last_path)).expanduser():
                    if v.get("hash"):
                        hash_candidates.append(str(v["hash"]))
                if multiplier is not None:
                    try:
                        m = int((v.get("detail") or {}).get("multiplier") or 0)
                    except (TypeError, ValueError):
                        m = 0
                    if m == int(multiplier) and v.get("hash"):
                        hash_candidates.append(str(v["hash"]))
                if v.get("hash"):
                    hash_candidates.append(str(v["hash"]))

    seen_h: set[str] = set()
    all_found: list[str] = []
    matched_hash: str | None = content_hash
    for h in hash_candidates:
        if not h or h in seen_h:
            continue
        seen_h.add(h)
        found = find_existing_paths_for_hash(h)
        if found:
            matched_hash = h
            for p in found:
                if p not in all_found:
                    all_found.append(p)

    if all_found:
        new_path = all_found[0]
        if parent_path and matched_hash:
            try:
                parent = Path(str(parent_path)).expanduser()
                parent_hash = lookup_cached_hash(parent) if parent.exists() else None
                if not parent_hash:
                    index = _load_index()
                    entry = (index.get("paths") or {}).get(_path_key(parent.resolve() if parent.exists() else parent))
                    parent_hash = entry.get("hash") if isinstance(entry, dict) else None
                rec = load_record(parent_hash) if parent_hash else None
                if rec:
                    dirty = False
                    for v in (rec.get("variants") or {}).get("rifed") or []:
                        if isinstance(v, dict) and v.get("hash") == matched_hash:
                            v["path"] = new_path
                            dirty = True
                    if dirty:
                        save_record(rec)
            except OSError:
                pass
        return {
            "ok": True,
            "found": True,
            "recovered": True,
            "path": new_path,
            "hash": matched_hash,
            "candidates": all_found,
        }
    return {
        "ok": True,
        "found": False,
        "recovered": False,
        "path": None,
        "hash": content_hash,
        "candidates": [],
    }


def _recover_variant_paths(record: dict[str, Any]) -> bool:
    """Rewrite missing variant paths in-place when the hash still exists."""
    dirty = False
    variants = record.get("variants") or {}
    for _kind, entries in variants.items():
        if not isinstance(entries, list):
            continue
        for v in entries:
            if not isinstance(v, dict):
                continue
            raw = v.get("path")
            if raw:
                try:
                    if Path(str(raw)).is_file():
                        continue
                except OSError:
                    pass
            h = v.get("hash")
            if not h:
                continue
            found = find_existing_paths_for_hash(str(h))
            if found:
                v["path"] = found[0]
                dirty = True
    return dirty


def _collect_referenced_media_paths() -> set[str]:
    """Paths still named by the session autosave and the last named project."""
    refs: set[str] = set()

    def _add(raw: Any) -> None:
        if not raw:
            return
        try:
            refs.add(str(Path(str(raw)).expanduser().resolve()))
        except OSError:
            refs.add(str(raw))

    def _absorb(doc: Any) -> None:
        if not isinstance(doc, dict):
            return
        pool = doc.get("pool") if isinstance(doc.get("pool"), dict) else doc
        if not isinstance(pool, dict):
            return
        for key in ("items", "images"):
            for it in pool.get(key) or []:
                if isinstance(it, dict):
                    _add(it.get("path"))
        for s in pool.get("sequence") or []:
            if isinstance(s, str):
                _add(s)
                continue
            if not isinstance(s, dict):
                continue
            _add(s.get("path"))
            _add(s.get("variant_path") or s.get("variantPath"))
        svp = pool.get("selected_variant_paths") or pool.get("selectedVariantPaths") or {}
        if isinstance(svp, dict):
            for v in svp.values():
                _add(v)

    try:
        if POOL_STATE_PATH.is_file():
            _absorb(json.loads(POOL_STATE_PATH.read_text(encoding="utf-8")))
    except Exception as e:
        log.warning("referenced-path session load failed: %s", e)

    try:
        from .projects import LAST_PROJECT_PATH
        if LAST_PROJECT_PATH.is_file():
            last = LAST_PROJECT_PATH.read_text(encoding="utf-8").strip()
            if last and Path(last).is_file():
                _absorb(json.loads(Path(last).read_text(encoding="utf-8")))
    except Exception as e:
        log.warning("referenced-path project load failed: %s", e)

    return refs


def gc_lower_density_rifed(
    parent_path: str | Path,
    *,
    keep_multiplier: int,
    keep_paths: list[str] | None = None,
) -> dict[str, Any]:
    """Delete unreferenced rifed files below ``keep_multiplier``.

    The original source is never deleted. A lower-density variant is removed
    only when no saved session/project still names its path.
    """
    parent = Path(parent_path).expanduser().resolve()
    keep: set[str] = set()
    try:
        keep.add(str(parent))
    except OSError:
        pass
    for raw in keep_paths or []:
        try:
            keep.add(str(Path(str(raw)).expanduser().resolve()))
        except OSError:
            keep.add(str(raw))

    referenced = _collect_referenced_media_paths() | keep
    parent_hash = lookup_cached_hash(parent)
    if not parent_hash:
        index = _load_index()
        entry = (index.get("paths") or {}).get(_path_key(parent))
        parent_hash = entry.get("hash") if isinstance(entry, dict) else None
    if not parent_hash:
        return {"ok": True, "deleted": [], "kept": [], "reason": "parent not indexed"}

    rec = load_record(parent_hash)
    if not rec:
        return {"ok": True, "deleted": [], "kept": [], "reason": "no record"}

    rifed = list((rec.get("variants") or {}).get("rifed") or [])
    remaining: list[dict[str, Any]] = []
    deleted: list[str] = []
    kept: list[str] = []

    for v in rifed:
        if not isinstance(v, dict):
            continue
        raw = v.get("path")
        try:
            m = int((v.get("detail") or {}).get("multiplier") or 0)
        except (TypeError, ValueError):
            m = 0
        try:
            resolved = str(Path(str(raw)).expanduser().resolve()) if raw else ""
        except OSError:
            resolved = str(raw or "")

        if not resolved or resolved == str(parent):
            remaining.append(v)
            continue
        if m >= int(keep_multiplier):
            remaining.append(v)
            if resolved:
                kept.append(resolved)
            continue
        if resolved in referenced:
            remaining.append(v)
            kept.append(resolved)
            continue
        try:
            p = Path(resolved)
            if p.is_file():
                p.unlink()
            deleted.append(resolved)
        except OSError as e:
            log.warning("gc unlink failed for %s: %s", resolved, e)
            remaining.append(v)
            kept.append(resolved)

    rec.setdefault("variants", {})["rifed"] = remaining
    save_record(rec)
    return {"ok": True, "deleted": deleted, "kept": kept, "keep_multiplier": int(keep_multiplier)}


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
    hash_if_missing: bool = True,
) -> dict[str, list[dict[str, Any]]] | None:
    """Return record['variants'] for the clip at parent_path, or {}.

    - Old records without a 'variants' key return {} (no KeyError).
    - Missing/inaccessible parent files return None (batch callers map to null).
    - By default, entries whose 'path' no longer exists on disk are dropped,
      so callers never load dead files. Pass include_missing=True to keep them
      (e.g. so the UI can show the variant greyed-out as "missing").
    - Missing variant files are recovered by stored content hash before drop.
    - If the path index is cold (mtime miss / never indexed), resolve_hash once
      so Instant RIFE can see already-registered densify files. GET must not
      stay forever empty when the rifed sibling is already in the record.
    - ``hash_if_missing=False`` (batch / restore) never hashes the parent.
    """
    try:
        parent = Path(parent_path).expanduser()
    except OSError:
        return None
    cat = _catalog_ready()
    if cat is not None:
        rec = cat.record_for_path(parent)
        if rec is not None:
            return rec.variants or {}
        if not hash_if_missing:
            return {}
    try:
        parent = parent.resolve()
    except OSError:
        return None
    if not parent.is_file():
        return None
    parent_hash = lookup_cached_hash(parent, check_source=True)
    if not parent_hash:
        if not hash_if_missing:
            index = _load_index()
            entry = (index.get("paths") or {}).get(_path_key(parent))
            parent_hash = entry.get("hash") if isinstance(entry, dict) else None
            if not parent_hash or not _record_path(parent_hash).exists():
                return {}
        else:
            try:
                parent_hash, _ = await resolve_hash(parent)
            except OSError:
                return None
    rec = load_record(parent_hash)
    if not rec:
        return {}
    if _recover_variant_paths(rec):
        save_record(rec)
    variants = rec.get("variants") or {}
    if include_missing:
        return variants
    return {
        kind: [v for v in entries if v.get("path") and Path(v["path"]).exists()]
        for kind, entries in variants.items()
    }


# ── stats ──────────────────────────────────────────────────────────────────

def media_cache_stats() -> dict[str, Any]:
    cat = _catalog_ready()
    if cat is not None:
        return cat.status_now()
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
