"""
Persistent, content-hash-keyed media registry.

Identity is the full-file blake2b hash (hex, 32 chars). Path/mtime only
accelerate re-lookup — move or rename the same bytes and you hit the same
record, thumbs, and history.

Layout under ~/.cache/mtapi/media/ (override with MTAPI_MEDIA_CACHE):

  index.json                 path → {hash, size, mtime_ns} quick map
  by_hash/<hash>/
    record.json              meta, paths seen, history of ops/opens
    first.jpg / last.jpg     frame thumbs (kept forever once generated)

First open of a clip is slow (hash + optional thumb extract). After that
everything is disk hits.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import time
from pathlib import Path
from typing import Any

log = logging.getLogger("mtapi.media_store")

# ── paths ──────────────────────────────────────────────────────────────────

def _default_root() -> Path:
    env = os.environ.get("MTAPI_MEDIA_CACHE")
    if env:
        return Path(env).expanduser().resolve()
    return Path.home() / ".cache" / "mtapi" / "media"


MEDIA_ROOT = _default_root()
BY_HASH_DIR = MEDIA_ROOT / "by_hash"
INDEX_PATH = MEDIA_ROOT / "index.json"
# Sibling of media hash store — survives restarts
POOL_STATE_PATH = MEDIA_ROOT.parent / "pool_state.json"

HASH_ALGO = "blake2b"
HASH_DIGEST_SIZE = 16  # 32 hex chars — enough for local identity, faster than sha256
HASH_CHUNK = 1024 * 1024  # 1 MiB

_index_lock = asyncio.Lock()
_hash_locks: dict[str, asyncio.Lock] = {}
_hash_locks_guard = asyncio.Lock()


def _ensure_dirs() -> None:
    BY_HASH_DIR.mkdir(parents=True, exist_ok=True)


def _hash_dir(content_hash: str) -> Path:
    return BY_HASH_DIR / content_hash


def _record_path(content_hash: str) -> Path:
    return _hash_dir(content_hash) / "record.json"


def _thumb_path(content_hash: str, which: str) -> Path:
    return _hash_dir(content_hash) / f"{which}.jpg"


def _phash_path(content_hash: str, which: str) -> Path:
    """Perceptual hash text file (hex) for first/last frame."""
    return _hash_dir(content_hash) / f"{which}.phash"


def _path_key(path: Path) -> str:
    return str(path.resolve())


# ── index (path → hash, skipped when size/mtime match) ─────────────────────

def _load_index() -> dict[str, Any]:
    _ensure_dirs()
    if not INDEX_PATH.exists():
        return {"version": 1, "paths": {}}
    try:
        data = json.loads(INDEX_PATH.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return {"version": 1, "paths": {}}
        data.setdefault("version", 1)
        data.setdefault("paths", {})
        return data
    except Exception as e:
        log.warning("media index load failed: %s", e)
        return {"version": 1, "paths": {}}


def _save_index(index: dict[str, Any]) -> None:
    _ensure_dirs()
    tmp = INDEX_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(index, indent=2, sort_keys=True), encoding="utf-8")
    tmp.replace(INDEX_PATH)


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


def lookup_cached_hash(path: Path) -> str | None:
    """Return content hash if path is indexed and size+mtime still match."""
    try:
        st = path.stat()
    except OSError:
        return None
    index = _load_index()
    entry = index.get("paths", {}).get(_path_key(path))
    if not entry:
        return None
    if entry.get("size") == st.st_size and entry.get("mtime_ns") == st.st_mtime_ns:
        h = entry.get("hash")
        if h and _record_path(h).exists():
            return h
    return None


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
        # Refresh thumb flags from disk
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
    # Reflect on-disk thumbs
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
        # Cap path history
        del paths[32:]


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


# ── frame extraction (hash-keyed paths) ────────────────────────────────────

async def extract_frame(path: Path, out_path: Path, which: str) -> bool:
    """Extract first or last frame as JPEG into out_path."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    scale = "scale=480:-2"

    async def _run(cmd: list[str]) -> bool:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await proc.communicate()
        return proc.returncode == 0 and out_path.exists() and out_path.stat().st_size > 0

    if which == "last":
        attempts = [
            [
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                "-sseof", "-0.5", "-i", str(path),
                "-frames:v", "1", "-vf", scale, "-q:v", "4", str(out_path),
            ],
            [
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                "-sseof", "-3", "-i", str(path),
                "-update", "1", "-frames:v", "1", "-vf", scale, "-q:v", "4", str(out_path),
            ],
        ]
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
    """Generate missing thumbs for this hash. which=None means both."""
    wanted = [which] if which in ("first", "last") else ["first", "last"]
    result = {}
    for w in wanted:
        tp = _thumb_path(content_hash, w)
        if tp.exists() and tp.stat().st_size > 0:
            result[w] = True
            continue
        ok = await extract_frame(source_path, tp, w)
        result[w] = ok
        if not ok:
            log.warning("thumb %s failed for %s (%s)", w, content_hash, source_path)
    # Always try to attach perceptual hashes for frames we have
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
    # Reflect on record if present
    rec = load_record(content_hash)
    if rec is not None:
        rec.setdefault("phashes", {})
        for w, h in out.items():
            if h:
                rec["phashes"][w] = h
        save_record(rec)
    return out


async def match_frames(
    query_path: Path,
    *,
    mode: str = "next",
    max_distance: int = 10,
    candidate_paths: list[str] | None = None,
    limit: int = 50,
) -> dict[str, Any]:
    """
    Compare query frame pHash against pool candidates.

    mode=next: query LAST vs each candidate FIRST  (what can follow this clip)
    mode=prev: query FIRST vs each candidate LAST  (what could precede)
    mode=both: run both directions, tag each hit

    Candidates default to all items in saved pool_state.json.
    """
    query_path = query_path.resolve()
    if not query_path.is_file():
        return {"ok": False, "error": "Query file not found"}

    mode = (mode or "next").lower()
    if mode not in ("next", "prev", "both"):
        return {"ok": False, "error": "mode must be next|prev|both"}

    max_distance = max(0, min(64, int(max_distance)))
    limit = max(1, min(200, int(limit)))

    # Ensure query registered + phashes
    q_hash, _ = await resolve_hash(query_path)
    await ensure_thumbs(q_hash, query_path)
    q_ph = await ensure_phashes(q_hash, query_path)

    if mode == "next" and not q_ph.get("last"):
        return {"ok": False, "error": "Could not compute query last-frame pHash"}
    if mode == "prev" and not q_ph.get("first"):
        return {"ok": False, "error": "Could not compute query first-frame pHash"}
    if mode == "both" and not (q_ph.get("first") or q_ph.get("last")):
        return {"ok": False, "error": "Could not compute query frame pHashes"}

    # Build candidate list
    if candidate_paths is None:
        pool = load_pool_state()
        candidate_paths = [it["path"] for it in (pool.get("items") or []) if it.get("path")]

    matches: list[dict[str, Any]] = []
    seen_hashes: set[str] = set()
    skipped_self = 0
    errors = 0

    for raw in candidate_paths:
        try:
            cpath = Path(raw).resolve()
            if not cpath.is_file():
                continue
            c_hash, _ = await resolve_hash(cpath)
            if c_hash == q_hash:
                skipped_self += 1
                continue
            if c_hash in seen_hashes:
                continue
            seen_hashes.add(c_hash)

            # Need thumbs/phashes for candidates
            await ensure_thumbs(c_hash, cpath)
            c_ph = await ensure_phashes(c_hash, cpath)

            directions: list[tuple[str, str, str]] = []
            # (direction_label, query_which, cand_which)
            if mode in ("next", "both"):
                directions.append(("next", "last", "first"))
            if mode in ("prev", "both"):
                directions.append(("prev", "first", "last"))

            best_for_cand: dict[str, Any] | None = None
            for dlabel, q_which, c_which in directions:
                qh = q_ph.get(q_which)
                ch = c_ph.get(c_which)
                if not qh or not ch:
                    continue
                dist = hamming_distance_hex(qh, ch)
                if dist is None or dist > max_distance:
                    continue
                # match quality label
                if dist == 0:
                    tier = "exact"
                elif dist <= 5:
                    tier = "near"
                elif dist <= 10:
                    tier = "close"
                else:
                    tier = "loose"
                # similarity 0–100 for 64-bit hash
                similarity = round(100.0 * (1.0 - dist / 64.0), 2)
                hit = {
                    "path": str(cpath),
                    "name": cpath.name,
                    "hash": c_hash,
                    "distance": dist,
                    "similarity": similarity,
                    "tier": tier,
                    "direction": dlabel,
                    "query_frame": q_which,
                    "match_frame": c_which,
                    "query_phash": qh,
                    "match_phash": ch,
                }
                if best_for_cand is None or dist < best_for_cand["distance"]:
                    best_for_cand = hit

            if best_for_cand:
                matches.append(best_for_cand)
        except Exception as e:
            errors += 1
            log.warning("match candidate failed %s: %s", raw, e)

    matches.sort(key=lambda m: (m["distance"], m["name"].lower()))
    matches = matches[:limit]

    return {
        "ok": True,
        "mode": mode,
        "max_distance": max_distance,
        "query": {
            "path": str(query_path),
            "name": query_path.name,
            "hash": q_hash,
            "phashes": {k: v for k, v in q_ph.items() if v},
        },
        "candidates_scanned": len(seen_hashes) + skipped_self,
        "skipped_self": skipped_self,
        "errors": errors,
        "match_count": len(matches),
        "matches": matches,
    }


# ── public ensure / open API ───────────────────────────────────────────────

async def resolve_hash(path: Path) -> tuple[str, bool]:
    """
    Return (content_hash, was_cached).
    Cached = path index hit (size+mtime) and record exists — no rehash.
    """
    path = path.resolve()
    cached = lookup_cached_hash(path)
    if cached:
        return cached, True

    st = path.stat()
    content_hash = await hash_file(path)
    await _update_index_entry(path, content_hash, st.st_size, st.st_mtime_ns)
    return content_hash, False


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
    content_hash, was_cached = await resolve_hash(path)
    lock = await _lock_for_hash(content_hash)

    async with lock:
        record = load_record(content_hash)
        if record is None:
            st = path.stat()
            record = _empty_record(content_hash, size=st.st_size)

        _remember_path(record, path)
        st = path.stat()
        record["size"] = st.st_size

        # Probe once per hash (or refresh if empty)
        if not record.get("meta") and probe_fn is not None:
            meta = await probe_fn(path)
            if meta.get("ok"):
                # Store probe fields without path-specific noise
                record["meta"] = {
                    k: v for k, v in meta.items()
                    if k not in ("ok", "path", "name", "error")
                }
            else:
                record["meta"] = None
                record["meta_error"] = meta.get("error")

        if ensure_thumbs_flag:
            thumbs = await ensure_thumbs(content_hash, path)
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
        "history": list(record.get("history") or [])[-20:],  # recent tail for UI
        "history_count": len(record.get("history") or []),
        "paths_seen": list(record.get("paths") or []),
        "created_at": record.get("created_at"),
        "updated_at": record.get("updated_at"),
    }
    if elapsed is not None:
        out["elapsed_s"] = elapsed

    # Flatten probe fields for pool cards (same shape as before)
    for k in (
        "width", "height", "fps", "duration", "frames",
        "video_codec", "audio_codec", "format_name", "bit_rate",
    ):
        if k in meta:
            out[k] = meta[k]

    if record.get("meta_error") and not meta:
        out["ok"] = False
        out["error"] = record["meta_error"]

    return out


async def export_frame_png(
    source_path: Path,
    which: str = "first",
    output_path: Path | None = None,
) -> dict[str, Any]:
    """Extract full-resolution first/last frame as PNG to disk."""
    which = which if which in ("first", "last") else "first"
    source_path = source_path.resolve()
    if not source_path.is_file():
        return {"ok": False, "error": "Source file not found"}

    if output_path is None:
        stem = source_path.stem
        output_path = source_path.parent / f"{stem}_{which}.png"
    else:
        output_path = Path(output_path).resolve()
        if output_path.suffix.lower() != ".png":
            output_path = output_path.with_suffix(".png")

    output_path.parent.mkdir(parents=True, exist_ok=True)

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
        attempts = [
            [
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                "-sseof", "-0.1", "-i", str(source_path),
                "-frames:v", "1", "-update", "1", str(output_path),
            ],
            [
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                "-sseof", "-1", "-i", str(source_path),
                "-frames:v", "1", "-update", "1", str(output_path),
            ],
        ]
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
            # Optionally register in media history for the source hash
            try:
                content_hash, _ = await resolve_hash(source_path)
                append_history(
                    content_hash,
                    "export_frame",
                    detail={
                        "which": which,
                        "output_path": str(output_path),
                        "format": "png",
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
    """Return path to thumb JPEG, generating if needed and source_path given."""
    which = which if which in ("first", "last") else "first"
    tp = _thumb_path(content_hash, which)
    if tp.exists() and tp.stat().st_size > 0:
        return tp
    if source_path is not None and source_path.is_file():
        ok = await extract_frame(source_path, tp, which)
        if ok:
            rec = load_record(content_hash)
            if rec:
                rec.setdefault("thumbs", {})[which] = True
                save_record(rec)
            return tp
    return None


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

        # If we produced a real output, register it too and link parent hash
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
                    # Generate thumbs for outputs too (async cost once)
                    await ensure_thumbs(out_hash, out)
    except Exception as e:
        log.warning("record_operation failed: %s", e)


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


# ── pool UI state (paths + sequence) ───────────────────────────────────────

_pool_state_lock = asyncio.Lock()


def _default_pool_state() -> dict[str, Any]:
    return {
        "version": 1,
        "items": [],       # [{path, name?, hash?}]
        "sequence": [],    # [{path, name?}] ordered
        "selected_path": None,
        "reconcile": "pad",
        "aspect": "auto",
        "aspect_custom": "",
        "output_path": "",
        "tile_zoom": 200,
        "tile_info": None,  # optional dict of field → bool
        "layout": None,     # dock sizes + collapsed sections
        "updated_at": None,
    }


def load_pool_state() -> dict[str, Any]:
    """Load persisted pool/sequence. Drops missing files; keeps known hashes."""
    state = _default_pool_state()
    if not POOL_STATE_PATH.exists():
        return {**state, "ok": True, "restored": False}

    try:
        raw = json.loads(POOL_STATE_PATH.read_text(encoding="utf-8"))
    except Exception as e:
        log.warning("pool state load failed: %s", e)
        return {**state, "ok": False, "error": str(e), "restored": False}

    items_in = raw.get("items") or []
    seq_in = raw.get("sequence") or []
    items_out = []
    seen = set()
    missing = []

    for it in items_in:
        if not isinstance(it, dict):
            continue
        p = it.get("path")
        if not p:
            continue
        path = Path(p)
        if not path.is_file():
            missing.append(p)
            continue
        key = str(path.resolve())
        if key in seen:
            continue
        seen.add(key)
        items_out.append({
            "path": key,
            "name": it.get("name") or path.name,
            "hash": it.get("hash"),
            "size": it.get("size"),
        })

    sequence_out = []
    for it in seq_in:
        if isinstance(it, str):
            p = it
            name = Path(p).name
        elif isinstance(it, dict):
            p = it.get("path")
            name = it.get("name") or (Path(p).name if p else None)
        else:
            continue
        if not p:
            continue
        path = Path(p)
        if not path.is_file():
            missing.append(p)
            continue
        sequence_out.append({
            "path": str(path.resolve()),
            "name": name or path.name,
        })

    selected = raw.get("selected_path")
    if selected and not Path(selected).is_file():
        selected = None

    tile_zoom = raw.get("tile_zoom", 200)
    try:
        tile_zoom = int(tile_zoom)
    except Exception:
        tile_zoom = 200

    return {
        "ok": True,
        "restored": True,
        "version": raw.get("version", 1),
        "items": items_out,
        "sequence": sequence_out,
        "selected_path": selected,
        "reconcile": raw.get("reconcile") or "pad",
        "aspect": raw.get("aspect") or "auto",
        "aspect_custom": raw.get("aspect_custom") or "",
        "output_path": raw.get("output_path") or "",
        "tile_zoom": tile_zoom,
        "tile_info": raw.get("tile_info") if isinstance(raw.get("tile_info"), dict) else None,
        "layout": raw.get("layout") if isinstance(raw.get("layout"), dict) else None,
        "updated_at": raw.get("updated_at"),
        "missing": missing,
        "path": str(POOL_STATE_PATH),
    }


async def save_pool_state(payload: dict[str, Any]) -> dict[str, Any]:
    """Persist pool items + sequence to disk."""
    async with _pool_state_lock:
        POOL_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        tile_zoom = payload.get("tile_zoom", 200)
        try:
            tile_zoom = int(tile_zoom)
        except Exception:
            tile_zoom = 200
        tile_info = payload.get("tile_info")
        if not isinstance(tile_info, dict):
            tile_info = None
        layout = payload.get("layout")
        if not isinstance(layout, dict):
            layout = None

        data = {
            "version": 1,
            "items": payload.get("items") or [],
            "sequence": payload.get("sequence") or [],
            "selected_path": payload.get("selected_path"),
            "reconcile": payload.get("reconcile") or "pad",
            "aspect": payload.get("aspect") or "auto",
            "aspect_custom": payload.get("aspect_custom") or "",
            "output_path": payload.get("output_path") or "",
            "tile_zoom": tile_zoom,
            "tile_info": tile_info,
            "layout": layout,
            "updated_at": time.time(),
        }
        tmp = POOL_STATE_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2, sort_keys=True), encoding="utf-8")
        tmp.replace(POOL_STATE_PATH)
        return {
            "ok": True,
            "path": str(POOL_STATE_PATH),
            "item_count": len(data["items"]),
            "sequence_count": len(data["sequence"]),
            "updated_at": data["updated_at"],
        }
