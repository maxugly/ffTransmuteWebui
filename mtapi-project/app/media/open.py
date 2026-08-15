"""
Media open/orchestration: hash, probe, thumbnails, and public payload.

The `open_media` function is the main entry point — not cache.py.
"""
from __future__ import annotations

import time
from pathlib import Path
from typing import Any

from .config import HASH_ALGO
from .cache import (
    _empty_record,
    _lock_for_hash,
    _load_index,
    _remember_path,
    load_record,
    resolve_hash,
    save_record,
)
from .thumbnails import ensure_thumbs, load_phash


async def open_media(
    path: Path,
    *,
    probe_fn=None,
    ensure_thumbs_flag: bool = True,
    record_open: bool = True,
) -> dict[str, Any]:
    """
    Hash (or reuse), load/create record, probe if needed, generate thumbs if missing.

    Returns a public payload suitable for /api/media_info:
      ok, hash, cached, path, name, meta fields…, thumbs, history, open_count
    """
    path = path.resolve()
    if not path.is_file():
        return {"ok": False, "error": "File not found"}

    t0 = time.time()
    index = _load_index()
    content_hash, was_cached = await resolve_hash(path, index=index)
    lock = await _lock_for_hash(content_hash)

    async with lock:
        record = load_record(content_hash)
        if record is None:
            st = path.stat()
            record = _empty_record(content_hash, size=st.st_size)

        _remember_path(record, path)
        st = path.stat()
        if not was_cached or record.get("size") != st.st_size:
            record["size"] = st.st_size

        if not record.get("meta") and probe_fn is not None:
            meta = await probe_fn(path)
            if meta.get("ok"):
                record["meta"] = {
                    k: v for k, v in meta.items()
                    if k not in ("ok", "path", "name", "error")
                }
            else:
                record["meta"] = None
                record["meta_error"] = meta.get("error")

        if ensure_thumbs_flag:
            thumbs = await ensure_thumbs(content_hash, path, record=record)
            record.setdefault("thumbs", {}).update(thumbs)

        if record_open:
            record["open_count"] = int(record.get("open_count") or 0) + 1
            hist = record.setdefault("history", [])
            hist.append({
                "ts": time.time(),
                "event": "opened",
                "path": str(path),
                "cached_hash": was_cached,
            })
            if len(hist) > 200:
                record["history"] = hist[-200:]

        save_record(record)

    elapsed = round(time.time() - t0, 3)
    return _public_payload(record, path, was_cached=was_cached, elapsed=elapsed)


def _public_payload(
    record: dict[str, Any],
    path: Path | None = None,
    *,
    was_cached: bool = True,
    elapsed: float | None = None,
) -> dict[str, Any]:
    meta = record.get("meta") or {}
    path_str = str(path.resolve()) if path else (record.get("paths") or [None])[0]
    name = Path(path_str).name if path_str else None

    out: dict[str, Any] = {
        "ok": True,
        "hash": record["hash"],
        "algo": record.get("algo", HASH_ALGO),
        "cached": was_cached,
        "path": path_str,
        "name": name,
        "size": record.get("size") or meta.get("size"),
        "thumbs": {
            "first": bool((record.get("thumbs") or {}).get("first")),
            "last": bool((record.get("thumbs") or {}).get("last")),
        },
        "phashes": {
            "first": load_phash(record["hash"], "first") or (record.get("phashes") or {}).get("first"),
            "last": load_phash(record["hash"], "last") or (record.get("phashes") or {}).get("last"),
        },
        "open_count": record.get("open_count") or 0,
        "history": list(record.get("history") or [])[-20:],
        "history_count": len(record.get("history") or []),
        "paths_seen": list(record.get("paths") or []),
        "created_at": record.get("created_at"),
        "updated_at": record.get("updated_at"),
    }
    if elapsed is not None:
        out["elapsed_s"] = elapsed

    for k in (
        "width", "height", "fps", "duration", "frames",
        "video_codec", "audio_codec", "format_name", "bit_rate",
        "has_audio",
    ):
        if k in meta:
            out[k] = meta[k]

    if record.get("meta_error") and not meta:
        out["ok"] = False
        out["error"] = record["meta_error"]

    return out
