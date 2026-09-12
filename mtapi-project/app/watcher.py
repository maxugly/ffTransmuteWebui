"""
Folder watcher: when enabled, poll an input directory for new videos.

Two independent jobs share the one poll loop (either can run without the
other):

1. DNxHR ingest (``enabled``) — transcode to DNxHR-LB .mov (Resolve-friendly)
   in the output directory.
2. Pool import (``pool_ingest``) — append the clip to the Video Pool
   (``items[]``, optionally ``sequence[]``) straight into the server pool
   file, so it works headless with the browser closed. RIFE is NOT run here;
   Sequence Instant-RIFE picks variants up through the normal funnel.

Canonical pool path is always the ORIGINAL clip (now under ``dun/``); the
DNxHR output is registered as a ``dnxhr`` variant of it, so the proxy
dropdown lists Original / dnxhr / rifed from the same record.

Controlled via GET/POST /api/watcher. Both toggles default OFF and never
auto-enable at boot.
"""
from __future__ import annotations

import json
import logging
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any

from .pathutil import unique_output_path

log = logging.getLogger("mtapi.watcher")

VIDEO_EXTS = {".mp4", ".m4v", ".mov", ".avi", ".mkv", ".webm", ".mpeg", ".mpg", ".wmv", ".mts", ".m2ts"}
POLL_S = 2.0
STABLE_S = 1.5  # file size must be unchanged this long before we take it
MAX_LOG = 80

_CONFIG_DIR = Path(__file__).resolve().parent.parent / "data"
_CONFIG_PATH = _CONFIG_DIR / "watcher.json"


@dataclass
class WatcherState:
    enabled: bool = False  # DNxHR transcode job
    pool_ingest: bool = False  # hot-folder → Video Pool job (independent)
    pool_add_sequence: bool = False  # pool imports also append to sequence[]
    in_dir: str = ""
    out_dir: str = ""
    # 16:9 letterbox target AR (matches 2mv defaults; pixels used only for AR)
    target_width: int = 1920
    target_height: int = 1080
    resize_mode: str = "letterbox"  # letterbox | crop
    last_error: str | None = None
    last_event: str | None = None
    processing: str | None = None
    processed_count: int = 0
    failed_count: int = 0
    pool_ingested_count: int = 0
    log_lines: list[str] = field(default_factory=list)

    def public(self) -> dict[str, Any]:
        d = asdict(self)
        d["running"] = (
            _thread is not None
            and _thread.is_alive()
            and (self.enabled or self.pool_ingest)
        )
        d["in_dir_ok"] = bool(self.in_dir and Path(self.in_dir).expanduser().is_dir())
        d["out_dir_ok"] = bool(self.out_dir and Path(self.out_dir).expanduser().is_dir())
        return d


_state = WatcherState()
_lock = threading.RLock()
_stop = threading.Event()
_thread: threading.Thread | None = None
_seen_sizes: dict[str, tuple[int, float]] = {}  # path -> (size, first_stable_ts)
_processed_names: set[str] = set()


def _log(msg: str) -> None:
    line = f"{time.strftime('%H:%M:%S')} {msg}"
    log.info("%s", msg)
    with _lock:
        _state.log_lines.append(line)
        if len(_state.log_lines) > MAX_LOG:
            _state.log_lines = _state.log_lines[-MAX_LOG:]
        _state.last_event = msg


def _load_config() -> None:
    global _state
    if not _CONFIG_PATH.is_file():
        return
    try:
        data = json.loads(_CONFIG_PATH.read_text(encoding="utf-8"))
        with _lock:
            _state.enabled = False  # never auto-enable on process start
            _state.pool_ingest = False  # same — headless ingest is opt-in per boot
            in_dir = str(data.get("in_dir") or "")
            out_dir = str(data.get("out_dir") or "")
            if in_dir and Path(in_dir).expanduser().is_dir():
                _state.in_dir = in_dir
            if out_dir and Path(out_dir).expanduser().is_dir():
                _state.out_dir = out_dir
            _state.target_width = int(data.get("target_width") or 1920)
            _state.target_height = int(data.get("target_height") or 1080)
            _state.pool_add_sequence = bool(data.get("pool_add_sequence") or False)
            mode = str(data.get("resize_mode") or "letterbox")
            _state.resize_mode = mode if mode in ("letterbox", "crop") else "letterbox"
    except Exception as e:
        log.warning("watcher config load failed: %s", e)


def get_status() -> dict[str, Any]:
    with _lock:
        return _state.public()


def apply_config(
    *,
    enabled: bool | None = None,
    pool_ingest: bool | None = None,
    pool_add_sequence: bool | None = None,
    in_dir: str | None = None,
    out_dir: str | None = None,
    target_width: int | None = None,
    target_height: int | None = None,
    resize_mode: str | None = None,
) -> dict[str, Any]:
    req_dnxhr_on = enabled is True
    req_ingest_on = pool_ingest is True
    with _lock:
        if in_dir is not None:
            _state.in_dir = str(in_dir).strip()
        if out_dir is not None:
            _state.out_dir = str(out_dir).strip()
        if target_width is not None:
            _state.target_width = max(2, int(target_width))
        if target_height is not None:
            _state.target_height = max(2, int(target_height))
        if resize_mode is not None:
            rm = str(resize_mode).strip().lower()
            if rm in ("letterbox", "crop"):
                _state.resize_mode = rm
        if pool_ingest is not None:
            _state.pool_ingest = bool(pool_ingest)
        if pool_add_sequence is not None:
            _state.pool_add_sequence = bool(pool_add_sequence)
        if enabled is not None:
            _state.enabled = bool(enabled)

        want_thread = _state.enabled or _state.pool_ingest
        start_ok = True
        if want_thread:
            err = _validate_dirs_unlocked(
                dnxhr_on=_state.enabled, ingest_on=_state.pool_ingest
            )
            if err:
                _state.last_error = err
                start_ok = False
                # Only force off the job(s) being turned on by this call —
                # never kill the other independent job.
                if req_dnxhr_on:
                    _state.enabled = False
                if req_ingest_on:
                    _state.pool_ingest = False
                _state.processing = None
                return _state.public()
            _state.last_error = None
        else:
            _state.processing = None

        _save_config_unlocked()

    if want_thread and start_ok:
        _ensure_thread()
    elif not want_thread:
        _stop.set()

    with _lock:
        return _state.public()


def _save_config_unlocked() -> None:
    payload = {
        "in_dir": _state.in_dir,
        "out_dir": _state.out_dir,
        "target_width": _state.target_width,
        "target_height": _state.target_height,
        "resize_mode": _state.resize_mode,
        "pool_add_sequence": _state.pool_add_sequence,
        "enabled": False,
        "pool_ingest": False,
    }
    try:
        _CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        _CONFIG_PATH.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    except Exception as e:
        log.warning("watcher config save failed: %s", e)


def _validate_dirs_unlocked(*, dnxhr_on: bool, ingest_on: bool) -> str | None:
    if not _state.in_dir:
        return "Input directory is required"
    inp = Path(_state.in_dir).expanduser()
    if not inp.is_dir():
        return f"Input is not a directory: {inp}"
    if not (dnxhr_on or ingest_on):
        return None
    if dnxhr_on:
        if not _state.out_dir:
            return "Output directory is required"
        out = Path(_state.out_dir).expanduser()
        if not out.is_dir():
            try:
                out.mkdir(parents=True, exist_ok=True)
            except Exception as e:
                return f"Cannot create output directory: {e}"
        if inp.resolve() == out.resolve():
            return "Input and output directories must be different"
    return None


def _ensure_thread() -> None:
    global _thread
    _stop.clear()
    if _thread is not None and _thread.is_alive():
        return
    _thread = threading.Thread(target=_loop, name="mtapi-watcher", daemon=True)
    _thread.start()
    _log("watcher started")


def _loop() -> None:
    while not _stop.is_set():
        with _lock:
            on = _state.enabled or _state.pool_ingest
            in_dir = _state.in_dir
            out_dir = _state.out_dir
            tw = _state.target_width
            th = _state.target_height
            mode = _state.resize_mode
            dnxhr_on = _state.enabled
            ingest_on = _state.pool_ingest
            add_seq = _state.pool_add_sequence
        if not on:
            break
        try:
            _scan_once(in_dir, out_dir, tw, th, mode,
                        dnxhr_on=dnxhr_on, ingest_on=ingest_on,
                        add_seq=add_seq)
        except Exception as e:
            with _lock:
                _state.last_error = str(e)
            _log(f"scan error: {e}")
        _stop.wait(POLL_S)
    with _lock:
        _state.processing = None
    _log("watcher stopped")


def _scan_once(in_dir: str, out_dir: str, tw: int, th: int, mode: str,
               *, dnxhr_on: bool, ingest_on: bool, add_seq: bool) -> None:
    root = Path(in_dir).expanduser()
    if not root.is_dir():
        return
    now = time.time()
    candidates: list[Path] = []
    for p in sorted(root.iterdir()):
        if not p.is_file() or p.name.startswith("."):
            continue
        if p.suffix.lower() not in VIDEO_EXTS:
            continue
        key = str(p)
        try:
            size = p.stat().st_size
        except OSError:
            continue
        if size <= 0:
            continue
        prev = _seen_sizes.get(key)
        if prev is None or prev[0] != size:
            _seen_sizes[key] = (size, now)
            continue
        # size stable
        if now - prev[1] < STABLE_S:
            continue
        if key in _processed_names:
            continue
        candidates.append(p)

    for p in candidates:
        with _lock:
            if not (_state.enabled or _state.pool_ingest):
                return
            _state.processing = p.name
        # 1) DNxHR transcode (legacy job). With pool ingest also on, the
        #    dun-move is deferred so one central move covers both jobs.
        dest: Path | None = None
        dnxhr_ok = False
        if dnxhr_on:
            dnxhr_ok, dest = _process_one(
                p, Path(out_dir).expanduser(), tw, th, mode,
                move_source=not ingest_on,
            )
        with _lock:
            _state.processing = None
            if dnxhr_on:
                if dnxhr_ok:
                    _state.processed_count += 1
                else:
                    _state.failed_count += 1
        if dnxhr_on and not dnxhr_ok and not ingest_on:
            # DNxHR-only failure — leave the source in place for a later retry
            # (size change restarts it); still mark seen for this boot.
            # (With pool ingest also on we continue below: jobs are
            # independent, a failed transcode must not block the import.)
            with _lock:
                _processed_names.add(str(p))
            continue
        # 2) Central dun-move: the original leaves in_dir exactly once, after
        #    every enabled job has consumed it. Canonical from here on.
        final = p
        if ingest_on or (dnxhr_on and not ingest_on):
            # DNxHR-only already moved inside _process_one (move_source=True).
            if ingest_on:
                moved = _move_to_dun(p)
                if moved is None:
                    with _lock:
                        _state.failed_count += 1
                        _processed_names.add(str(p))
                    continue
                final = moved
            else:
                dun_guess = p.parent / "dun" / p.name
                if dun_guess.is_file():
                    final = dun_guess
        # 3) Register the DNxHR output as a proxy variant of the original, so
        #    the pool dropdown lists Original / dnxhr (/ rifed) from one record.
        if dest is not None:
            _register_variant_sync(
                final, kind="dnxhr", variant_path=dest,
                detail={"codec": "dnxhr_lb", "pix_fmt": "yuv422p",
                        "resize_mode": mode, "source": "watcher"},
            )
        # 4) Pool import (headless — server writes the pool file directly).
        if ingest_on:
            _ingest_one(final, add_seq=add_seq)
        with _lock:
            _processed_names.add(str(p))
            _seen_sizes.pop(str(p), None)


def _probe_dims(path: Path) -> tuple[int, int] | None:
    try:
        r = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-select_streams", "v:0",
                "-show_entries", "stream=width,height",
                "-of", "csv=s=x:p=0",
                str(path),
            ],
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
        line = (r.stdout or "").strip().splitlines()
        if not line:
            return None
        w, h = line[0].split("x", 1)
        return int(w), int(h)
    except Exception:
        return None


def _has_audio(path: Path) -> bool:
    try:
        r = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-select_streams", "a",
                "-show_entries", "stream=codec_type",
                "-of", "default=noprint_wrappers=1:nokey=1",
                str(path),
            ],
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
        return "audio" in (r.stdout or "")
    except Exception:
        return False


def _vf_for(iw: int, ih: int, tw: int, th: int, mode: str) -> str:
    """Match 2mv: keep native pixels when AR matches; else crop or letterbox without scale-up."""
    in_ar = iw / ih if ih else 1.0
    tg_ar = tw / th if th else 1.0
    if abs(in_ar - tg_ar) < 0.01:
        return "scale=trunc(iw/2)*2:trunc(ih/2)*2"

    iw_e = (iw // 2) * 2
    ih_e = (ih // 2) * 2
    if mode == "crop":
        if in_ar > tg_ar:
            ow = int((ih_e * tg_ar) / 2) * 2
            oh = ih_e
        else:
            ow = iw_e
            oh = int((iw_e / tg_ar) / 2) * 2
        return f"scale=trunc(iw/2)*2:trunc(ih/2)*2,crop={ow}:{oh}"
    # letterbox
    if in_ar > tg_ar:
        ow = iw_e
        oh = int((iw_e / tg_ar) / 2) * 2
    else:
        ow = int((ih_e * tg_ar) / 2) * 2
        oh = ih_e
    return f"scale=trunc(iw/2)*2:trunc(ih/2)*2,pad={ow}:{oh}:(ow-iw)/2:(oh-ih)/2:color=black"


def _process_one(src: Path, out_dir: Path, tw: int, th: int, mode: str,
                 *, move_source: bool = True) -> tuple[bool, Path | None]:
    """Transcode one clip to DNxHR. Returns (ok, dest).

    When ``move_source`` is False the caller owns the dun-move (used when
    pool ingest runs in the same pass — one central move for both jobs).
    """
    _log(f"processing {src.name}")
    out_dir.mkdir(parents=True, exist_ok=True)
    base = src.stem
    dest = unique_output_path(out_dir / f"{base}_resolve.mov")
    work = dest.with_suffix(".partial.mov")

    dims = _probe_dims(src)
    if dims:
        vf = _vf_for(dims[0], dims[1], tw, th, mode)
    else:
        vf = "scale=trunc(iw/2)*2:trunc(ih/2)*2"

    has_a = _has_audio(src)
    if has_a:
        cmd = [
            "ffmpeg", "-hide_banner", "-y", "-i", str(src),
            "-vf", vf,
            "-c:v", "dnxhd", "-profile:v", "dnxhr_lb", "-pix_fmt", "yuv422p",
            "-c:a", "pcm_s16le",
            "-loglevel", "warning",
            str(work),
        ]
    else:
        cmd = [
            "ffmpeg", "-hide_banner", "-y",
            "-i", str(src),
            "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
            "-vf", vf,
            "-c:v", "dnxhd", "-profile:v", "dnxhr_lb", "-pix_fmt", "yuv422p",
            "-c:a", "pcm_s16le",
            "-shortest",
            "-loglevel", "warning",
            str(work),
        ]

    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=3600 * 6, check=False)
    except Exception as e:
        with _lock:
            _state.last_error = str(e)
        _log(f"failed {src.name}: {e}")
        work.unlink(missing_ok=True)
        return False, None

    if r.returncode != 0:
        err = (r.stderr or r.stdout or "ffmpeg failed")[-500:]
        with _lock:
            _state.last_error = err
        _log(f"failed {src.name}: {err.splitlines()[-1] if err else 'ffmpeg error'}")
        work.unlink(missing_ok=True)
        return False, None

    try:
        work.replace(dest)
    except Exception:
        shutil.move(str(work), str(dest))

    if move_source:
        # Move original next to a "done" sibling of in_dir if possible, else leave it
        _move_to_dun(src)

    with _lock:
        _state.last_error = None
    _log(f"done → {dest.name}")
    return True, dest


def _move_to_dun(src: Path) -> Path | None:
    """Move a consumed original into ``dun/`` next to its folder.

    Collision-safe (``stem_1.ext`` …). Returns the final path, or None when
    the move failed (caller counts it as failed — the file stays for retry).
    """
    dun = src.parent / "dun"
    try:
        dun.mkdir(exist_ok=True)
        target = dun / src.name
        if target.exists():
            stem, suffix = src.stem, src.suffix
            n = 1
            while (dun / f"{stem}_{n}{suffix}").exists():
                n += 1
            target = dun / f"{stem}_{n}{suffix}"
        shutil.move(str(src), str(target))
        return target
    except Exception as e:
        _log(f"dun move failed for {src.name}: {e}")
        return None


def _ingest_one(final: Path, *, add_seq: bool) -> None:
    """Append one arrived clip to the server pool file (headless import)."""
    try:
        res = _pool_ingest_sync([str(final)], add_sequence=add_seq)
    except Exception as e:
        _log(f"pool ingest failed for {final.name}: {e}")
        return
    if res.get("added_items"):
        with _lock:
            _state.pool_ingested_count += 1
        _log(f"pool +{res['added_items']} → {final.name}"
             + (" (+sequence)" if res.get("added_seq") else ""))
    else:
        _log(f"pool skip (already in pool) → {final.name}")


def _pool_ingest_sync(paths: list[str], *, add_sequence: bool) -> dict[str, int]:
    """Sync Video-Pool append for the watcher thread (no event loop).

    Canonical entries are ``{path, name}`` — the browser hydrates ids, probe
    meta and thumbs on next load/save through the normal funnel
    (``addPathsToPool`` semantics: dedupe, optional sequence append).
    Uses the live catalog membership when ready (thread-safe), else merges
    the pool file on disk. Never raises.
    """
    resolved: list[str] = []
    for raw in paths:
        if not raw:
            continue
        try:
            rp = str(Path(str(raw)).expanduser().resolve())
        except OSError:
            continue
        if rp and rp not in resolved:
            resolved.append(rp)
    if not resolved:
        return {"added_items": 0, "added_seq": 0}

    try:
        from .media.catalog import catalog_if_ready
        cat = catalog_if_ready()
    except Exception:
        cat = None

    if cat is not None:
        with cat._global_lock:
            items = cat.membership.setdefault("items", [])
            seq = cat.membership.setdefault("sequence", [])
            have = {it.get("path") for it in items if isinstance(it, dict)}
            seq_have = {e.get("path") for e in seq if isinstance(e, dict)}
            ai = aq = 0
            for rp in resolved:
                if rp not in have:
                    items.append({"path": rp, "name": Path(rp).name,
                                  "hash": None, "size": None, "meta": None,
                                  "metaError": None, "meta_signature": None,
                                  "history_count": None, "open_count": None,
                                  "thumbsFailed": None})
                    have.add(rp)
                    ai += 1
                if add_sequence and rp not in seq_have:
                    seq.append({"path": rp, "name": Path(rp).name})
                    seq_have.add(rp)
                    aq += 1
            # Bumping updated_at is what lets save_pool_state detect that a
            # browser autosave loaded before this ingest (stale basis: merge).
            raw = cat.membership.setdefault("raw", {})
            if ai or aq:
                raw["updated_at"] = time.time()
            _persist_pool_file_locked(cat)
        return {"added_items": ai, "added_seq": aq}

    # No catalog yet (early boot / tests): merge the pool file directly.
    from .media import config as _cfg
    pool_path = Path(str(_cfg.POOL_STATE_PATH))
    try:
        raw = json.loads(pool_path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            raw = {}
    except Exception:
        raw = {}
    items = raw.get("items") if isinstance(raw.get("items"), list) else []
    seq = raw.get("sequence") if isinstance(raw.get("sequence"), list) else []
    have = {it.get("path") for it in items if isinstance(it, dict)}
    seq_have = {e.get("path") for e in seq if isinstance(e, dict)}
    ai = aq = 0
    for rp in resolved:
        if rp not in have:
            items.append({"path": rp, "name": Path(rp).name})
            have.add(rp)
            ai += 1
        if add_sequence and rp not in seq_have:
            seq.append({"path": rp, "name": Path(rp).name})
            seq_have.add(rp)
            aq += 1
    raw["items"] = items
    raw["sequence"] = seq
    if ai or aq:
        raw["updated_at"] = time.time()
    try:
        pool_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = pool_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(raw, indent=2, sort_keys=True), encoding="utf-8")
        tmp.replace(pool_path)
    except Exception as e:
        log.warning("watcher pool file write failed: %s", e)
    return {"added_items": ai, "added_seq": aq}


def _persist_pool_file_locked(cat: Any) -> None:
    """Write the session pool file from live membership. Caller holds the lock."""
    from .media import config as _cfg
    try:
        pool_path = Path(str(_cfg.POOL_STATE_PATH))
        try:
            raw = json.loads(pool_path.read_text(encoding="utf-8"))
            if not isinstance(raw, dict):
                raw = {}
        except Exception:
            raw = {}
        base = dict(cat.membership.get("raw") or raw)
        base["items"] = list(cat.membership.get("items") or [])
        base["sequence"] = list(cat.membership.get("sequence") or [])
        base["version"] = 2
        base.setdefault("updated_at", time.time())
        pool_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = pool_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(base, indent=2, sort_keys=True), encoding="utf-8")
        tmp.replace(pool_path)
    except Exception as e:
        log.warning("watcher pool file persist failed: %s", e)


def _register_variant_sync(parent_path: str | Path, *, kind: str,
                           variant_path: str | Path,
                           detail: dict[str, Any] | None = None) -> bool:
    """Attach a derived file to its parent's variant record — sync, thread-safe.

    Same shape as the async ``media.register_variant`` (``kind`` list capped
    at 32, content-hashed, paths remembered) so the proxy dropdown lists it
    with zero UI changes. Never raises; failure only skips the menu row.
    """
    try:
        parent = Path(str(parent_path)).expanduser().resolve()
        variant = Path(str(variant_path)).expanduser().resolve()
        if not parent.is_file() or not variant.is_file():
            return False
        pst = parent.stat()
        vst = variant.stat()
        from .media.cache import _hash_file_sync
        ph = _hash_file_sync(parent)
        vh = _hash_file_sync(variant)
    except OSError as e:
        log.warning("watcher variant hash failed: %s", e)
        return False

    try:
        from .media.catalog import catalog_if_ready, CatalogRecord
        cat = catalog_if_ready()
    except Exception:
        cat = None

    entry = {"kind": kind, "hash": vh, "path": str(variant),
             "created_at": time.time(), "detail": detail or {}}
    try:
        if cat is not None:
            import time as _time
            cat.update_path_mapping(parent, ph, pst.st_size, pst.st_mtime_ns,
                                    persist=True)
            cat.update_path_mapping(variant, vh, vst.st_size, vst.st_mtime_ns,
                                    persist=True)
            with cat._global_lock:
                rec = cat.hash_to_record.get(ph)
                if rec is None:
                    now = _time.time()
                    rec = CatalogRecord(hash=ph, size=pst.st_size,
                                        created_at=now, updated_at=now)
                    cat.hash_to_record[ph] = rec
                if str(parent) not in rec.paths:
                    rec.paths.insert(0, str(parent))
                bucket = cat.hash_to_paths.setdefault(ph, [])
                if str(parent) not in bucket:
                    bucket.append(str(parent))
                lst = rec.variants.setdefault(kind, [])
                if all(v.get("path") != str(variant) for v in lst if isinstance(v, dict)):
                    lst.append(entry)
                    del lst[:-32]
                rec.variants_status = "known"
                vrec = cat.hash_to_record.get(vh)
                if vrec is None:
                    now = _time.time()
                    vrec = CatalogRecord(hash=vh, size=vst.st_size,
                                         created_at=now, updated_at=now)
                    cat.hash_to_record[vh] = vrec
                if str(variant) not in vrec.paths:
                    vrec.paths.insert(0, str(variant))
                vbucket = cat.hash_to_paths.setdefault(vh, [])
                if str(variant) not in vbucket:
                    vbucket.append(str(variant))
                cat._persist_record(rec, None)
                cat._persist_record(vrec, None)
            return True

        # Fallback: direct record.json + index.json merge (no catalog yet).
        from .media import config as _cfg
        from .media.cache import _empty_record
        by_hash = Path(str(_cfg.BY_HASH_DIR))
        index_path = Path(str(_cfg.INDEX_PATH))
        by_hash.mkdir(parents=True, exist_ok=True)
        rp = by_hash / ph / "record.json"
        try:
            rec = json.loads(rp.read_text(encoding="utf-8"))
            if not isinstance(rec, dict):
                rec = None
        except Exception:
            rec = None
        if rec is None:
            try:
                rec = _empty_record(ph, size=pst.st_size)
            except Exception:
                rec = {"hash": ph, "size": pst.st_size, "paths": [],
                       "variants": {}}
        paths = rec.setdefault("paths", [])
        if str(parent) not in paths:
            paths.insert(0, str(parent))
        variants = rec.setdefault("variants", {})
        lst = variants.setdefault(kind, [])
        if all(v.get("path") != str(variant) for v in lst if isinstance(v, dict)):
            lst.append(entry)
            del lst[:-32]
        rec["updated_at"] = time.time()
        rp.parent.mkdir(parents=True, exist_ok=True)
        tmp = rp.with_suffix(".tmp")
        tmp.write_text(json.dumps(rec, indent=2, sort_keys=True), encoding="utf-8")
        tmp.replace(rp)
        try:
            index = json.loads(index_path.read_text(encoding="utf-8"))
            if not isinstance(index, dict):
                index = {}
        except Exception:
            index = {}
        index.setdefault("version", 1)
        pmap = index.setdefault("paths", {})
        pmap[str(parent)] = {"hash": ph, "size": pst.st_size,
                             "mtime_ns": pst.st_mtime_ns,
                             "updated_at": time.time()}
        pmap[str(variant)] = {"hash": vh, "size": vst.st_size,
                              "mtime_ns": vst.st_mtime_ns,
                              "updated_at": time.time()}
        itmp = index_path.with_suffix(".tmp")
        itmp.write_text(json.dumps(index, indent=2, sort_keys=True), encoding="utf-8")
        itmp.replace(index_path)
        return True
    except Exception as e:
        log.warning("watcher variant register failed: %s", e)
        return False


# Load paths on import; never auto-start.
_load_config()
