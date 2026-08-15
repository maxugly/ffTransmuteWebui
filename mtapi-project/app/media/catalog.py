"""
Server-resident catalog index.

One long-lived in-memory catalog for the mtapi process. Display reads this
index after ``catalog_ready``. Disk JSON, source stats, probe, hash, and
repair stay on the mutation / compatibility paths.

See docs/server-memory-catalog-spec.md.
"""
from __future__ import annotations

import asyncio
import fcntl
import json
import logging
import os
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

from .config import THUMBNAIL_SIZES, normalize_thumb_size
from .performance import load_settings, thumbnail_cache

log = logging.getLogger("mtapi.catalog")

THUMB_RAM_BUDGET = 64 * 1024 * 1024
THUMB_WHICH = ("first", "last")
THUMB_SIZES = ("L", "M", "H")
RESOURCE_STATES = ("known", "missing", "queued", "repairing", "failed", "stale")
THUMB_SLOT_STATES = ("available", "missing", "queued", "repairing", "failed")


class CatalogError(Exception):
    """Catalog process or hydration failure."""


class CatalogLockHeld(CatalogError):
    """Another mtapi process already owns the catalog lock."""


@dataclass
class ThumbSlot:
    state: str = "missing"
    path: str | None = None
    served_size: str | None = None
    rev: int | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "state": self.state,
            "path": self.path,
            "served_size": self.served_size,
            "rev": self.rev,
        }


def _empty_slots() -> dict[str, dict[str, ThumbSlot]]:
    return {which: {size: ThumbSlot() for size in THUMB_SIZES} for which in THUMB_WHICH}


@dataclass
class IsolatedRecord:
    path: str
    hash: str | None
    reason: str


@dataclass
class CatalogRecord:
    hash: str
    algo: str = "blake2b"
    size: int = 0
    paths: list[str] = field(default_factory=list)
    meta: dict[str, Any] | None = None
    meta_error: str | None = None
    meta_signature: dict[str, int] | None = None
    thumbs: dict[str, dict[str, ThumbSlot]] = field(default_factory=_empty_slots)
    thumb_failed: dict[str, Any] = field(default_factory=dict)
    variants: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    variants_status: str = "missing"
    phashes: dict[str, str | None] = field(default_factory=lambda: {"first": None, "last": None})
    history_count: int = 0
    open_count: int = 0
    created_at: float = 0.0
    updated_at: float = 0.0
    persist_failed: bool = False
    fps: float | None = None
    repair_errors: list[str] = field(default_factory=list)

    def hash_state(self) -> dict[str, Any]:
        return {"hash": self.hash, "status": "known"}

    def signature_state(self) -> dict[str, Any]:
        sig = self.meta_signature or {}
        status = "known" if sig.get("size") is not None else "missing"
        return {
            "size": sig.get("size", self.size),
            "mtime_ns": sig.get("mtime_ns"),
            "status": status,
        }

    def metadata_state(self) -> dict[str, Any]:
        if self.meta_error and not self.meta:
            return {"meta": None, "status": "failed"}
        if self.meta:
            return {"meta": self.meta, "status": "known"}
        return {"meta": None, "status": "missing"}

    def variants_state(self) -> dict[str, Any]:
        return {"variants": self.variants or None, "status": self.variants_status}

    def thumbnails_state(self) -> dict[str, dict[str, str]]:
        return {
            which: {size: self.thumbs[which][size].state for size in THUMB_SIZES}
            for which in THUMB_WHICH
        }


@dataclass
class IoCounters:
    index_json_reads: int = 0
    record_json_reads: int = 0
    source_stats: int = 0
    persist_failed_count: int = 0
    malformed_record_count: int = 0
    duplicate_record_count: int = 0
    ram_hits: int = 0
    ram_misses: int = 0
    ram_evicted: int = 0
    disk_fallbacks: int = 0
    warm_considered: int = 0
    repair_enqueued: int = 0
    probes: int = 0
    hashes: int = 0


def _opt_int(raw: Any) -> int | None:
    if raw is None or raw is False:
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def _opt_float(raw: Any) -> float | None:
    if raw is None or raw is False:
        return None
    try:
        return float(raw)
    except (TypeError, ValueError):
        return None


def _expand_path_text(raw: Any) -> str | None:
    """String path without resolve()/stat()/exists()."""
    if raw is None:
        return None
    text = str(raw).strip()
    if not text:
        return None
    try:
        return str(Path(text).expanduser())
    except (OSError, ValueError, TypeError):
        return text


class CatalogIndex:
    """Authoritative long-lived in-memory catalog for one mtapi process."""

    def __init__(self, *, media_root: Path | None = None, acquire_lock: bool = True):
        self._explicit_root = Path(media_root).expanduser() if media_root else None
        self.acquire_lock_on_hydrate = acquire_lock

        self._global_lock = threading.RLock()
        self._record_locks: dict[str, threading.Lock] = {}
        self._record_locks_guard = threading.Lock()
        self._lock_fd: int | None = None

        self.path_to_hash: dict[str, str] = {}
        self.path_identity: dict[str, dict[str, Any]] = {}
        self.hash_to_record: dict[str, CatalogRecord] = {}
        self.hash_to_paths: dict[str, list[str]] = {}
        self.isolated: list[IsolatedRecord] = []

        self.membership: dict[str, Any] = {
            "items": [],
            "images": [],
            "sequence": [],
            "selected_path": None,
            "selected_image_path": None,
            "raw": {},
        }

        self.catalog_ready = False
        self.hydration_phase = "idle"
        self.records_loaded = 0
        self.records_total = 0
        self.index_load_failed = False
        self.hydration_duration = 0.0
        self.hydration_failures = 0

        self.selected_size = "H"
        self.thumbnails_to_ram = False
        self.warmer_epoch = 0
        self.thumbnail_warm_complete = False
        self._warmer_task: asyncio.Task | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

        self.counters = IoCounters()
        self.inject_persist_error = False
        self._persist_failed_hashes: set[str] = set()
        self._index_persist_failed = False
        self._index_doc: dict[str, Any] = {"version": 1, "paths": {}}

    # ── paths ──────────────────────────────────────────────────────────────

    @property
    def media_root(self) -> Path:
        if self._explicit_root is not None:
            return self._explicit_root
        from . import config
        return config.MEDIA_ROOT

    @property
    def by_hash_dir(self) -> Path:
        return self.media_root / "by_hash"

    @property
    def index_path(self) -> Path:
        return self.media_root / "index.json"

    @property
    def settings_path(self) -> Path:
        return self.media_root.parent / "settings.json"

    @property
    def pool_state_path(self) -> Path:
        return self.media_root.parent / "pool_state.json"

    @property
    def lock_path(self) -> Path:
        return self.media_root.parent / "catalog.lock"

    @property
    def last_project_pointer(self) -> Path:
        return self.media_root.parent / "last_project_path.txt"

    # ── locks ──────────────────────────────────────────────────────────────

    def _record_lock(self, content_hash: str) -> threading.Lock:
        with self._record_locks_guard:
            lock = self._record_locks.get(content_hash)
            if lock is None:
                lock = threading.Lock()
                self._record_locks[content_hash] = lock
            return lock

    def acquire_process_lock(self) -> None:
        if self._lock_fd is not None:
            return
        path = self.lock_path
        path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(str(path), os.O_CREAT | os.O_RDWR, 0o644)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            holder = ""
            try:
                os.lseek(fd, 0, os.SEEK_SET)
                holder = os.read(fd, 256).decode("utf-8", "replace").strip()
            except OSError:
                holder = ""
            os.close(fd)
            msg = (
                f"catalog lock already held ({path})"
                + (f": {holder}" if holder else "")
                + ". mtapi is a single-process catalog; stop the other instance."
            )
            raise CatalogLockHeld(msg) from None
        payload = f"pid={os.getpid()} started={int(time.time())}\n".encode("utf-8")
        os.ftruncate(fd, 0)
        os.lseek(fd, 0, os.SEEK_SET)
        os.write(fd, payload)
        self._lock_fd = fd

    def release_process_lock(self) -> None:
        fd = self._lock_fd
        self._lock_fd = None
        if fd is None:
            return
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        except OSError:
            pass
        try:
            os.close(fd)
        except OSError:
            pass

    # ── I/O notes (post-hydration display counters) ────────────────────────

    def note_index_json_read(self) -> None:
        if self.catalog_ready:
            self.counters.index_json_reads += 1

    def note_record_json_read(self) -> None:
        if self.catalog_ready:
            self.counters.record_json_reads += 1

    def note_source_stat(self) -> None:
        if self.catalog_ready:
            self.counters.source_stats += 1

    def note_probe(self) -> None:
        if self.catalog_ready:
            self.counters.probes += 1

    def note_hash(self) -> None:
        if self.catalog_ready:
            self.counters.hashes += 1

    def note_repair_enqueue(self) -> None:
        if self.catalog_ready:
            self.counters.repair_enqueued += 1

    # ── hydration ──────────────────────────────────────────────────────────

    def _set_phase(self, phase: str) -> None:
        self.hydration_phase = phase
        log.info(
            "catalog hydrate phase=%s records_loaded=%d records_total=%d "
            "failures=%d index_load_failed=%s",
            phase,
            self.records_loaded,
            self.records_total,
            self.hydration_failures,
            self.index_load_failed,
        )

    def hydrate(self) -> None:
        """Load the full catalog. Blocks until every record is resident or isolated."""
        t0 = time.perf_counter()
        if self.acquire_lock_on_hydrate:
            self._set_phase("lock")
            self.acquire_process_lock()

        self._set_phase("settings")
        self._load_settings()

        self._set_phase("index")
        self._hydrate_index()

        self._set_phase("records")
        self._hydrate_records()

        self._set_phase("maps")
        self._apply_index_precedence()

        self._set_phase("membership")
        self._hydrate_membership()

        self._set_phase("states")
        self._assign_startup_states()

        self.hydration_duration = time.perf_counter() - t0
        self.catalog_ready = True
        self._set_phase("ready")
        log.info(
            "catalog ready records_loaded=%d records_total=%d isolated=%d "
            "index_load_failed=%s duration=%.3fs",
            self.records_loaded,
            self.records_total,
            len(self.isolated),
            self.index_load_failed,
            self.hydration_duration,
        )

    async def startup(self) -> None:
        """FastAPI startup: hydrate fully, then start the warmer if enabled."""
        try:
            self._loop = asyncio.get_running_loop()
        except RuntimeError:
            self._loop = None
        await asyncio.to_thread(self.hydrate)
        if self.thumbnails_to_ram:
            self._start_warmer()

    async def shutdown(self) -> None:
        await self._cancel_warmer()
        self._flush_persist_failed()
        self.release_process_lock()
        self.catalog_ready = False
        self.hydration_phase = "stopped"

    def _load_settings(self) -> None:
        if self._explicit_root is not None:
            raw: dict[str, Any] = {}
            try:
                raw = json.loads(self.settings_path.read_text(encoding="utf-8"))
            except (FileNotFoundError, OSError, ValueError):
                raw = {}
            self.selected_size = normalize_thumb_size(raw.get("thumbnail_size", "H"))
            self.thumbnails_to_ram = bool(raw.get("thumbnails_to_ram", False))
            return
        data = load_settings()
        self.selected_size = normalize_thumb_size(data.get("thumbnail_size", "H"))
        self.thumbnails_to_ram = bool(data.get("thumbnails_to_ram", False))

    def _hydrate_index(self) -> None:
        path = self.index_path
        if not path.exists():
            self._index_doc = {"version": 1, "paths": {}}
            self.index_load_failed = False
            return
        try:
            text = path.read_text(encoding="utf-8")
            data = json.loads(text)
            if not isinstance(data, dict):
                raise ValueError("index.json is not an object")
            raw_paths = data.get("paths")
            if raw_paths is None:
                raw_paths = {}
            if not isinstance(raw_paths, dict):
                raise ValueError("index.json paths is not an object")
            cleaned: dict[str, Any] = {}
            seen: set[str] = set()
            for key, entry in raw_paths.items():
                path_key = str(key)
                if path_key in seen:
                    log.warning("catalog index duplicate path key %s", path_key)
                seen.add(path_key)
                if not isinstance(entry, dict) or not entry.get("hash"):
                    continue
                cleaned[path_key] = {
                    "hash": str(entry["hash"]),
                    "size": _opt_int(entry.get("size")),
                    "mtime_ns": _opt_int(entry.get("mtime_ns")),
                    "updated_at": _opt_float(entry.get("updated_at")) or 0.0,
                }
            self._index_doc = {
                "version": int(data.get("version") or 1),
                "paths": cleaned,
            }
            self.index_load_failed = False
        except Exception as e:
            log.warning("catalog index load failed: %s — refusing to persist index.json", e)
            self.index_load_failed = True
            self._index_doc = {"version": 1, "paths": {}}

    def _iter_record_files(self) -> list[tuple[str, Path]]:
        root = self.by_hash_dir
        found: list[tuple[str, Path]] = []
        if not root.is_dir():
            return found
        for child in root.iterdir():
            if not child.is_dir() or child.name.startswith("."):
                continue
            rec = child / "record.json"
            tmp = child / "record.tmp"
            if rec.name.endswith(".tmp") or rec.suffix == ".tmp":
                continue
            if not rec.is_file():
                if tmp.is_file():
                    log.warning("catalog ignoring leftover %s", tmp)
                continue
            found.append((child.name, rec))
        return found

    def _isolate(self, path: Path, content_hash: str | None, reason: str) -> None:
        self.isolated.append(IsolatedRecord(str(path), content_hash, reason))
        self.counters.malformed_record_count += 1
        self.hydration_failures += 1
        log.warning("catalog isolated %s hash=%s (%s)", path, content_hash, reason)

    def _hydrate_records(self) -> None:
        files = self._iter_record_files()
        self.records_total = len(files)
        self.records_loaded = 0
        pending: dict[str, tuple[float, CatalogRecord, Path]] = {}
        for dir_hash, rec_path in files:
            parsed = self._parse_record_file(dir_hash, rec_path)
            if parsed is None:
                continue
            rec, updated_at = parsed
            existing = pending.get(rec.hash)
            if existing is None:
                pending[rec.hash] = (updated_at, rec, rec_path)
                self.records_loaded += 1
                continue
            prev_at, prev_rec, prev_path = existing
            if updated_at > prev_at:
                self._isolate(prev_path, prev_rec.hash, "duplicate hash; older updated_at")
                self.counters.duplicate_record_count += 1
                pending[rec.hash] = (updated_at, rec, rec_path)
            else:
                self._isolate(rec_path, rec.hash, "duplicate hash; keep first completed parse")
                self.counters.duplicate_record_count += 1
            self.records_loaded += 1
            if self.records_loaded % 250 == 0:
                self._set_phase("records")
        self.hash_to_record = {h: rec for h, (_at, rec, _p) in pending.items()}
        self.hash_to_paths = {h: list(rec.paths) for h, rec in self.hash_to_record.items()}

    def _parse_record_file(
        self, dir_hash: str, rec_path: Path
    ) -> tuple[CatalogRecord, float] | None:
        try:
            text = rec_path.read_text(encoding="utf-8")
            data = json.loads(text)
        except Exception as e:
            self._isolate(rec_path, dir_hash, f"parse error: {e}")
            return None
        if not isinstance(data, dict) or not data:
            self._isolate(rec_path, dir_hash, "non-object or empty record")
            return None
        content_hash = data.get("hash")
        if not isinstance(content_hash, str) or not content_hash.strip():
            self._isolate(rec_path, dir_hash, "missing hash field")
            return None
        content_hash = content_hash.strip()
        rec = self._record_from_json(data, fallback_hash=content_hash)
        updated = _opt_float(data.get("updated_at")) or 0.0
        return rec, updated

    def _record_from_json(self, data: dict[str, Any], *, fallback_hash: str = "") -> CatalogRecord:
        content_hash = str(data.get("hash") or fallback_hash)
        paths: list[str] = []
        seen: set[str] = set()
        for raw in data.get("paths") or []:
            key = _expand_path_text(raw)
            if not key or key in seen:
                continue
            seen.add(key)
            paths.append(key)
        hist = data.get("history")
        history_count = len(hist) if isinstance(hist, list) else int(data.get("history_count") or 0)
        variants = data.get("variants") if isinstance(data.get("variants"), dict) else {}
        clean_variants: dict[str, list[dict[str, Any]]] = {}
        for kind, entries in variants.items():
            if not isinstance(entries, list):
                continue
            clean_variants[str(kind)] = [dict(v) for v in entries if isinstance(v, dict)]
        phashes_raw = data.get("phashes") if isinstance(data.get("phashes"), dict) else {}
        phashes = {
            "first": phashes_raw.get("first") if isinstance(phashes_raw.get("first"), str) else None,
            "last": phashes_raw.get("last") if isinstance(phashes_raw.get("last"), str) else None,
        }
        failed = data.get("thumb_failed") if isinstance(data.get("thumb_failed"), dict) else {}
        sig = None
        raw_sig = data.get("meta_signature")
        if isinstance(raw_sig, dict):
            size = _opt_int(raw_sig.get("size"))
            mtime_ns = _opt_int(raw_sig.get("mtime_ns"))
            if size is not None:
                sig = {"size": size, "mtime_ns": mtime_ns or 0}
        fps = _opt_float((data.get("meta") or {}).get("fps") if isinstance(data.get("meta"), dict) else None)
        if fps is None:
            fps = _opt_float(data.get("fps"))
        return CatalogRecord(
            hash=content_hash,
            algo=str(data.get("algo") or "blake2b"),
            size=int(data.get("size") or 0),
            paths=paths,
            meta=data.get("meta") if isinstance(data.get("meta"), dict) else None,
            meta_error=data.get("meta_error") if isinstance(data.get("meta_error"), str) else None,
            meta_signature=sig,
            thumbs=_empty_slots(),
            thumb_failed=dict(failed),
            variants=clean_variants,
            variants_status="known" if clean_variants else "missing",
            phashes=phashes,
            history_count=history_count,
            open_count=int(data.get("open_count") or 0),
            created_at=_opt_float(data.get("created_at")) or 0.0,
            updated_at=_opt_float(data.get("updated_at")) or 0.0,
            fps=fps,
        )

    def _apply_index_precedence(self) -> None:
        """Index wins path identity. Records seed the fallback maps."""
        self.path_to_hash = {}
        self.path_identity = {}
        self.hash_to_paths = {h: list(rec.paths) for h, rec in self.hash_to_record.items()}
        for rec in self.hash_to_record.values():
            for p in rec.paths:
                if p not in self.path_to_hash:
                    self.path_to_hash[p] = rec.hash
        if self.index_load_failed:
            return
        for path_key, entry in (self._index_doc.get("paths") or {}).items():
            if not isinstance(entry, dict):
                continue
            h = entry.get("hash")
            if not h:
                continue
            h = str(h)
            self.path_to_hash[path_key] = h
            self.path_identity[path_key] = {
                "hash": h,
                "size": entry.get("size"),
                "mtime_ns": entry.get("mtime_ns"),
                "updated_at": entry.get("updated_at") or 0.0,
            }
            bucket = self.hash_to_paths.setdefault(h, [])
            if path_key not in bucket:
                bucket.append(path_key)

    def _hydrate_membership(self) -> None:
        raw = self._read_json_object(self.pool_state_path)
        if raw is None:
            pointer = self._read_text(self.last_project_pointer)
            if pointer:
                raw = self._read_json_object(Path(pointer).expanduser())
        if raw is None:
            return
        self.membership = self._membership_from_snapshot(raw)

    def _read_text(self, path: Path) -> str | None:
        try:
            if not path.is_file():
                return None
            return path.read_text(encoding="utf-8").strip()
        except OSError:
            return None

    def _read_json_object(self, path: Path) -> dict[str, Any] | None:
        try:
            if not path.is_file():
                return None
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        return data if isinstance(data, dict) else None

    def _membership_from_snapshot(self, raw: dict[str, Any]) -> dict[str, Any]:
        pool = raw
        if raw.get("kind") == "fftransmute-project" and isinstance(raw.get("pool"), dict):
            pool = raw["pool"]
        items = self._membership_items(pool.get("items"))
        images = self._membership_items(pool.get("images"))
        sequence = self._membership_sequence(pool.get("sequence"))
        return {
            "items": items,
            "images": images,
            "sequence": sequence,
            "selected_path": _expand_path_text(pool.get("selected_path")),
            "selected_image_path": _expand_path_text(pool.get("selected_image_path")),
            "raw": pool,
        }

    def _membership_items(self, raw_list: Any) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        seen: set[str] = set()
        for it in raw_list or []:
            if not isinstance(it, dict):
                continue
            path = _expand_path_text(it.get("path"))
            if not path or path in seen:
                continue
            seen.add(path)
            out.append({
                "path": path,
                "name": it.get("name") or Path(path).name,
                "hash": it.get("hash") if isinstance(it.get("hash"), str) else None,
                "size": _opt_int(it.get("size")),
                "meta": it.get("meta") if isinstance(it.get("meta"), dict) else None,
                "metaError": it.get("metaError") or it.get("meta_error"),
                "meta_signature": it.get("meta_signature") if isinstance(it.get("meta_signature"), dict) else None,
                "history_count": _opt_int(it.get("history_count")),
                "open_count": _opt_int(it.get("open_count")),
                "thumbsFailed": it.get("thumbsFailed") or it.get("thumbs_failed"),
            })
        return out

    def _membership_sequence(self, raw_list: Any) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for it in raw_list or []:
            if isinstance(it, str):
                path = _expand_path_text(it)
                if path:
                    out.append({"path": path, "name": Path(path).name})
                continue
            if not isinstance(it, dict):
                continue
            path = _expand_path_text(it.get("path"))
            if not path:
                continue
            entry = {
                "path": path,
                "name": it.get("name") or Path(path).name,
            }
            for src, dst in (
                ("target_duration", "target_duration"),
                ("targetDuration", "target_duration"),
                ("variant_path", "variant_path"),
                ("variantPath", "variant_path"),
                ("rife_multiplier", "rife_multiplier"),
                ("_rifeMultiplier", "rife_multiplier"),
                ("variant_hash", "variant_hash"),
                ("rife_need", "rife_need"),
                ("rifeNeed", "rife_need"),
            ):
                if src in it and it[src] is not None and dst not in entry:
                    if dst in ("variant_path",):
                        entry[dst] = _expand_path_text(it[src]) or it[src]
                    else:
                        entry[dst] = it[src]
            out.append(entry)
        return out

    def _assign_startup_states(self) -> None:
        """Startup-only exists()/stat() on known thumbnail, pHash, and variant files."""
        for rec in self.hash_to_record.values():
            self._assign_thumb_slots(rec)
            self._assign_phashes(rec)
            self._assign_variant_status(rec)

    def _thumb_file(self, content_hash: str, which: str, size: str) -> Path:
        return self.by_hash_dir / content_hash / f"{which}_{size}.jpg"

    def _legacy_thumb_file(self, content_hash: str, which: str) -> Path:
        return self.by_hash_dir / content_hash / f"{which}.jpg"

    def _phash_file(self, content_hash: str, which: str) -> Path:
        return self.by_hash_dir / content_hash / f"{which}.phash"

    def _file_nonempty(self, path: Path) -> bool:
        try:
            return path.is_file() and path.stat().st_size > 0
        except OSError:
            return False

    def _assign_thumb_slots(self, rec: CatalogRecord) -> None:
        failed = rec.thumb_failed or {}
        for which in THUMB_WHICH:
            which_failed = bool(failed.get(which))
            for size in THUMB_SIZES:
                if which_failed:
                    rec.thumbs[which][size] = ThumbSlot(state="failed")
                    continue
                found, served = self._startup_thumb_path(rec.hash, which, size)
                if found is None:
                    rec.thumbs[which][size] = ThumbSlot(state="missing")
                    continue
                try:
                    rev = found.stat().st_mtime_ns
                except OSError:
                    rec.thumbs[which][size] = ThumbSlot(state="missing")
                    continue
                rec.thumbs[which][size] = ThumbSlot(
                    state="available",
                    path=str(found),
                    served_size=served,
                    rev=int(rev),
                )

    def _startup_thumb_path(self, content_hash: str, which: str, size: str) -> tuple[Path | None, str | None]:
        ordered = [size]
        if size != "H":
            ordered.append("H")
        for extra in THUMB_SIZES:
            if extra not in ordered:
                ordered.append(extra)
        for cand in ordered:
            p = self._thumb_file(content_hash, which, cand)
            if self._file_nonempty(p):
                return p, cand
        legacy = self._legacy_thumb_file(content_hash, which)
        if self._file_nonempty(legacy):
            return legacy, "legacy"
        return None, None

    def _assign_phashes(self, rec: CatalogRecord) -> None:
        for which in THUMB_WHICH:
            if rec.phashes.get(which):
                continue
            pp = self._phash_file(rec.hash, which)
            try:
                if pp.is_file():
                    val = pp.read_text(encoding="utf-8").strip()
                    rec.phashes[which] = val or None
            except OSError:
                continue

    def _assign_variant_status(self, rec: CatalogRecord) -> None:
        if not rec.variants:
            rec.variants_status = "missing"
            return
        rec.variants_status = "known"

    # ── lookups (RAM only after ready) ─────────────────────────────────────

    def record_for_hash(self, content_hash: str | None) -> CatalogRecord | None:
        if not content_hash:
            return None
        return self.hash_to_record.get(content_hash)

    def hash_for_path(self, path: str | Path | None) -> str | None:
        key = _expand_path_text(path)
        if not key:
            return None
        h = self.path_to_hash.get(key)
        if h:
            return h
        return self.path_to_hash.get(str(path)) if path is not None else None

    def record_for_path(self, path: str | Path | None) -> CatalogRecord | None:
        h = self.hash_for_path(path)
        return self.hash_to_record.get(h) if h else None

    def variants_for_path(self, path: str | Path | None) -> dict[str, list[dict[str, Any]]] | None:
        rec = self.record_for_path(path)
        if rec is None:
            return None
        return rec.variants or {}

    def known_paths_for_hash(self, content_hash: str) -> list[str]:
        return list(self.hash_to_paths.get(content_hash) or [])

    def index_document(self) -> dict[str, Any]:
        """In-memory index.json equivalent. Never reads disk."""
        paths: dict[str, Any] = {}
        for p, ident in self.path_identity.items():
            paths[p] = dict(ident)
        for p, h in self.path_to_hash.items():
            if p not in paths:
                paths[p] = {"hash": h}
        return {"version": 1, "paths": paths}

    def serving_dict(self, rec: CatalogRecord) -> dict[str, Any]:
        size = self.selected_size
        return {
            "hash": rec.hash,
            "algo": rec.algo,
            "size": rec.size,
            "paths": list(rec.paths),
            "meta": rec.meta,
            "meta_error": rec.meta_error,
            "meta_signature": rec.meta_signature,
            "thumbs": {
                "first": rec.thumbs["first"][size].state == "available",
                "last": rec.thumbs["last"][size].state == "available",
            },
            "thumb_failed": dict(rec.thumb_failed),
            "variants": rec.variants,
            "phashes": dict(rec.phashes),
            "history": [],
            "history_count": rec.history_count,
            "open_count": rec.open_count,
            "created_at": rec.created_at,
            "updated_at": rec.updated_at,
            "persist_failed": rec.persist_failed,
            "fps": rec.fps,
        }

    def public_payload(self, content_hash: str) -> dict[str, Any] | None:
        rec = self.record_for_hash(content_hash)
        if rec is None:
            return None
        path_str = (rec.paths[0] if rec.paths else None)
        size = self.selected_size
        out: dict[str, Any] = {
            "ok": True,
            "hash": rec.hash,
            "algo": rec.algo,
            "cached": True,
            "path": path_str,
            "name": Path(path_str).name if path_str else None,
            "size": rec.size,
            "thumbs": {
                "first": rec.thumbs["first"][size].state == "available",
                "last": rec.thumbs["last"][size].state == "available",
            },
            "phashes": dict(rec.phashes),
            "open_count": rec.open_count,
            "history": [],
            "history_count": rec.history_count,
            "paths_seen": list(rec.paths),
            "created_at": rec.created_at,
            "updated_at": rec.updated_at,
            "persist_failed": rec.persist_failed,
        }
        meta = rec.meta or {}
        for k in (
            "width", "height", "fps", "duration", "frames",
            "video_codec", "audio_codec", "format_name", "bit_rate", "has_audio",
        ):
            if k in meta:
                out[k] = meta[k]
        if rec.meta_error and not meta:
            out["ok"] = False
            out["error"] = rec.meta_error
        return out

    def overlay_item(self, item: dict[str, Any]) -> dict[str, Any]:
        out = dict(item)
        rec = None
        if item.get("hash"):
            rec = self.record_for_hash(str(item["hash"]))
        if rec is None:
            rec = self.record_for_path(item.get("path"))
        if rec is None:
            out.setdefault("thumbs", {"first": False, "last": False})
            return out
        size = self.selected_size
        out["hash"] = rec.hash
        out["size"] = rec.size
        out["meta"] = rec.meta
        out["metaError"] = rec.meta_error
        if rec.meta_signature:
            out["meta_signature"] = rec.meta_signature
        out["history_count"] = rec.history_count
        out["open_count"] = rec.open_count
        out["thumbs"] = {
            "first": rec.thumbs["first"][size].state == "available",
            "last": rec.thumbs["last"][size].state == "available",
        }
        out["thumbsFailed"] = {
            "first": rec.thumbs["first"][size].state == "failed",
            "last": rec.thumbs["last"][size].state == "failed",
        }
        first_slot = rec.thumbs["first"][size]
        last_slot = rec.thumbs["last"][size]
        out["thumb_rev"] = {
            "first": first_slot.rev,
            "last": last_slot.rev,
        }
        return out

    def pool_state_payload(self) -> dict[str, Any]:
        raw = dict(self.membership.get("raw") or {})
        items = [self.overlay_item(it) for it in self.membership.get("items") or []]
        images = [self.overlay_item(it) for it in self.membership.get("images") or []]
        payload = {
            "ok": True,
            "restored": True,
            **raw,
            "items": items,
            "images": images,
            "sequence": list(self.membership.get("sequence") or []),
            "selected_path": self.membership.get("selected_path"),
            "selected_image_path": self.membership.get("selected_image_path"),
            "missing": [],
            "path": str(self.pool_state_path),
        }
        return payload

    def apply_membership_snapshot(self, raw: dict[str, Any]) -> dict[str, Any]:
        """Project/session switch: membership and UI only. Catalog records stay."""
        self.membership = self._membership_from_snapshot(raw)
        return self.pool_state_payload()

    def load_project_membership(self, project_path: str | Path) -> dict[str, Any]:
        path = Path(str(project_path)).expanduser()
        raw = self._read_json_object(path)
        if raw is None:
            return {"ok": False, "error": f"Project not found: {path}"}
        payload = self.apply_membership_snapshot(raw)
        name = raw.get("name") or path.stem
        payload.update({
            "ok": True,
            "path": str(path),
            "name": name,
            "created_at": raw.get("created_at"),
            "updated_at": raw.get("updated_at"),
            "item_count": len(payload.get("items") or []),
            "image_count": len(payload.get("images") or []),
            "sequence_count": len(payload.get("sequence") or []),
            "project_version": 2,
        })
        try:
            self.last_project_pointer.parent.mkdir(parents=True, exist_ok=True)
            self.last_project_pointer.write_text(str(path), encoding="utf-8")
        except OSError:
            pass
        return payload

    # ── mutation / persist ─────────────────────────────────────────────────

    def upsert_record(self, record_dict: dict[str, Any], *, persist: bool = True) -> CatalogRecord:
        content_hash = str(record_dict["hash"])
        with self._global_lock:
            with self._record_lock(content_hash):
                rec = self._record_from_json(record_dict, fallback_hash=content_hash)
                prev = self.hash_to_record.get(content_hash)
                if prev is not None:
                    rec.thumbs = prev.thumbs
                    if not rec.phashes.get("first"):
                        rec.phashes["first"] = prev.phashes.get("first")
                    if not rec.phashes.get("last"):
                        rec.phashes["last"] = prev.phashes.get("last")
                    rec.persist_failed = prev.persist_failed
                    if rec.history_count == 0 and prev.history_count:
                        rec.history_count = prev.history_count
                self._assign_thumb_slots(rec)
                self.hash_to_record[content_hash] = rec
                self._sync_record_paths_unlocked(rec)
        if persist:
            self._persist_record(rec, record_dict)
        return rec

    def _sync_record_paths_unlocked(self, rec: CatalogRecord) -> None:
        bucket = self.hash_to_paths.setdefault(rec.hash, [])
        for p in rec.paths:
            if p not in bucket:
                bucket.append(p)
            if p not in self.path_to_hash:
                self.path_to_hash[p] = rec.hash

    def update_path_mapping(
        self,
        path: str | Path,
        content_hash: str,
        size: int | None = None,
        mtime_ns: int | None = None,
        *,
        persist: bool = True,
    ) -> None:
        key = _expand_path_text(path) or str(path)
        with self._global_lock:
            self.path_to_hash[key] = content_hash
            self.path_identity[key] = {
                "hash": content_hash,
                "size": size,
                "mtime_ns": mtime_ns,
                "updated_at": time.time(),
            }
            bucket = self.hash_to_paths.setdefault(content_hash, [])
            if key not in bucket:
                bucket.append(key)
            rec = self.hash_to_record.get(content_hash)
            if rec is not None and key not in rec.paths:
                rec.paths.insert(0, key)
            if persist:
                self._persist_index_unlocked()

    def register_thumb(
        self,
        content_hash: str,
        which: str,
        size: str,
        file_path: Path,
        *,
        persist: bool = True,
    ) -> None:
        which = which if which in THUMB_WHICH else "first"
        size = normalize_thumb_size(size)
        lock = self._record_lock(content_hash)
        with lock:
            rec = self.hash_to_record.get(content_hash)
            if rec is None:
                return
            try:
                rev = file_path.stat().st_mtime_ns
            except OSError:
                rev = int(time.time_ns())
            slot = ThumbSlot(
                state="available",
                path=str(file_path),
                served_size=size,
                rev=int(rev),
            )
            rec.thumbs[which][size] = slot
            if size == "H":
                for smaller in ("L", "M"):
                    if rec.thumbs[which][smaller].state != "available":
                        rec.thumbs[which][smaller] = ThumbSlot(
                            state="available",
                            path=str(file_path),
                            served_size="H",
                            rev=int(rev),
                        )
            rec.updated_at = time.time()
        if persist:
            rec = self.hash_to_record[content_hash]
            self._persist_record(rec, None)

    def append_history(
        self,
        content_hash: str,
        event: str,
        *,
        detail: dict[str, Any] | None = None,
        max_events: int = 200,
    ) -> CatalogRecord | None:
        """Mutation path: may read record.json to preserve/extend history."""
        rec = self.record_for_hash(content_hash)
        if rec is None:
            return None
        disk = self._read_disk_record(content_hash) or {}
        hist = list(disk.get("history") or [])
        hist.append({"ts": time.time(), "event": event, **(detail or {})})
        if len(hist) > max_events:
            hist = hist[-max_events:]
        disk.update(self.serving_dict(rec))
        disk["history"] = hist
        disk["hash"] = content_hash
        rec.history_count = len(hist)
        rec.open_count = int(disk.get("open_count") or rec.open_count)
        rec.updated_at = time.time()
        self._persist_record(rec, disk)
        return rec

    def _read_disk_record(self, content_hash: str) -> dict[str, Any] | None:
        rp = self.by_hash_dir / content_hash / "record.json"
        try:
            if not rp.is_file():
                return None
            data = json.loads(rp.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else None
        except (OSError, ValueError):
            return None

    def _persist_record(self, rec: CatalogRecord, incoming: dict[str, Any] | None) -> None:
        rp = self.by_hash_dir / rec.hash / "record.json"
        rp.parent.mkdir(parents=True, exist_ok=True)
        existing = self._read_disk_record(rec.hash) or {}
        payload = dict(existing)
        if incoming:
            for k, v in incoming.items():
                if k == "history" and not v and existing.get("history"):
                    continue
                payload[k] = v
        payload["hash"] = rec.hash
        payload["algo"] = rec.algo
        payload["size"] = rec.size
        payload["paths"] = list(rec.paths)
        payload["meta"] = rec.meta
        if rec.meta_error is not None:
            payload["meta_error"] = rec.meta_error
        payload["variants"] = rec.variants
        payload["phashes"] = rec.phashes
        payload["thumb_failed"] = rec.thumb_failed
        payload["open_count"] = rec.open_count
        payload["created_at"] = rec.created_at or existing.get("created_at") or time.time()
        payload["updated_at"] = time.time()
        rec.updated_at = payload["updated_at"]
        if "history" not in payload and existing.get("history"):
            payload["history"] = existing["history"]
        thumbs_bool = existing.get("thumbs") if isinstance(existing.get("thumbs"), dict) else {}
        payload["thumbs"] = {
            "first": rec.thumbs["first"][self.selected_size].state == "available" or bool(thumbs_bool.get("first")),
            "last": rec.thumbs["last"][self.selected_size].state == "available" or bool(thumbs_bool.get("last")),
        }
        try:
            self._atomic_write(rp, payload)
            rec.persist_failed = False
            self._persist_failed_hashes.discard(rec.hash)
        except OSError as e:
            rec.persist_failed = True
            self._persist_failed_hashes.add(rec.hash)
            self.counters.persist_failed_count += 1
            log.warning("catalog persist record failed %s: %s", rec.hash, e)

    def _persist_index_unlocked(self) -> None:
        if self.index_load_failed:
            log.warning("catalog refusing to persist index.json (index_load_failed)")
            return
        doc = self.index_document()
        if not doc.get("paths") and self.hash_to_record:
            log.error(
                "catalog refusing to write empty index.json with %d records resident",
                len(self.hash_to_record),
            )
            return
        try:
            self._atomic_write(self.index_path, doc)
            self._index_persist_failed = False
        except OSError as e:
            self._index_persist_failed = True
            self.counters.persist_failed_count += 1
            log.warning("catalog persist index failed: %s", e)

    def persist_index(self) -> None:
        with self._global_lock:
            self._persist_index_unlocked()

    def _atomic_write(self, dest: Path, payload: dict[str, Any]) -> None:
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_name(dest.name + ".tmp") if dest.suffix == ".json" else dest.with_suffix(".tmp")
        if dest.name == "index.json":
            tmp = dest.with_suffix(".tmp")
        elif dest.name == "record.json":
            tmp = dest.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
        if self.inject_persist_error:
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass
            raise OSError("injected persist failure")
        tmp.replace(dest)

    def _flush_persist_failed(self) -> None:
        if self.inject_persist_error:
            return
        for h in list(self._persist_failed_hashes):
            rec = self.hash_to_record.get(h)
            if rec is None:
                continue
            self._persist_record(rec, None)
        if self._index_persist_failed and not self.index_load_failed:
            with self._global_lock:
                self._persist_index_unlocked()

    # ── thumbnails ─────────────────────────────────────────────────────────

    def thumb_cache_key(self, content_hash: str, which: str, size: str, rev: int | None) -> tuple:
        return (content_hash, which, normalize_thumb_size(size), rev)

    def thumb_slot(self, content_hash: str, which: str, size: str) -> ThumbSlot | None:
        rec = self.record_for_hash(content_hash)
        if rec is None:
            return None
        which = which if which in THUMB_WHICH else "first"
        size = normalize_thumb_size(size)
        return rec.thumbs[which][size]

    async def serve_hash_thumbnail(
        self, content_hash: str, which: str, size: str
    ) -> tuple[bytes | Path | None, str]:
        """Display GET. Returns (payload, source) source in ram|disk|missing|failed|unknown."""
        which = which if which in THUMB_WHICH else "first"
        size = normalize_thumb_size(size)
        rec = self.record_for_hash(content_hash)
        if rec is None:
            if self.thumbnails_to_ram:
                self.counters.ram_misses += 1
            return None, "unknown"
        slot = rec.thumbs[which][size]
        if slot.state in ("missing", "failed", "queued", "repairing") or not slot.path:
            if self.thumbnails_to_ram:
                self.counters.ram_misses += 1
            return None, slot.state if slot.state in THUMB_SLOT_STATES else "missing"
        key = self.thumb_cache_key(content_hash, which, size, slot.rev)
        if self.thumbnails_to_ram:
            cached = await thumbnail_cache.get(key)
            if isinstance(cached, bytes):
                self.counters.ram_hits += 1
                return cached, "ram"
            self.counters.ram_misses += 1
            self.counters.disk_fallbacks += 1
            try:
                data = Path(slot.path).read_bytes()
            except OSError:
                slot.state = "missing"
                slot.path = None
                return None, "missing"
            await thumbnail_cache.put(key, data)
            return data, "disk"
        stored = Path(slot.path)
        return stored, "disk"

    async def apply_settings(self, data: dict[str, Any]) -> None:
        new_size = normalize_thumb_size(data.get("thumbnail_size", self.selected_size))
        new_ram = bool(data.get("thumbnails_to_ram", self.thumbnails_to_ram))
        if new_size != self.selected_size:
            await self.set_thumbnail_size(new_size)
        if new_ram != self.thumbnails_to_ram:
            await self.set_thumbnails_to_ram(new_ram)

    async def set_thumbnail_size(self, size: str) -> None:
        size = normalize_thumb_size(size)
        if size == self.selected_size:
            return
        self.selected_size = size
        await thumbnail_cache.drop_sizes_except(size)
        stats = await thumbnail_cache.stats()
        self.counters.ram_evicted = int(stats.get("evicted") or 0)
        self._bump_warmer_epoch()
        if self.thumbnails_to_ram:
            self._start_warmer()
        else:
            self.thumbnail_warm_complete = True

    async def set_thumbnails_to_ram(self, enabled: bool) -> None:
        if enabled == self.thumbnails_to_ram:
            return
        self.thumbnails_to_ram = enabled
        self._bump_warmer_epoch()
        if not enabled:
            await self._cancel_warmer()
            await thumbnail_cache.clear()
            self.thumbnail_warm_complete = True
            self.counters.warm_considered = 0
            return
        self.thumbnail_warm_complete = False
        self._start_warmer()

    def _bump_warmer_epoch(self) -> None:
        with self._global_lock:
            self.warmer_epoch += 1
            self.thumbnail_warm_complete = False
            self.counters.warm_considered = 0

    def _start_warmer(self) -> None:
        if not self.thumbnails_to_ram or not self.catalog_ready:
            return
        epoch = self.warmer_epoch
        loop = self._loop
        try:
            loop = loop or asyncio.get_running_loop()
            self._loop = loop
        except RuntimeError:
            return
        prev = self._warmer_task
        if prev is not None and not prev.done():
            prev.cancel()
        self.thumbnail_warm_complete = False
        self.counters.warm_considered = 0
        self._warmer_task = loop.create_task(self._warm_loop(epoch))

    async def _cancel_warmer(self) -> None:
        task = self._warmer_task
        self._warmer_task = None
        if task is None:
            return
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass

    async def run_warmer(self) -> None:
        """Test helper: run one warmer pass on the current epoch."""
        if not self.thumbnails_to_ram:
            self.thumbnail_warm_complete = True
            return
        await self._warm_loop(self.warmer_epoch)

    async def _warm_loop(self, epoch: int) -> None:
        if not self.thumbnails_to_ram:
            if epoch == self.warmer_epoch:
                self.thumbnail_warm_complete = True
            return
        considered = 0
        size = self.selected_size
        items: list[tuple[str, str, ThumbSlot]] = []
        for rec in self.hash_to_record.values():
            for which in THUMB_WHICH:
                slot = rec.thumbs[which][size]
                if slot.state == "available" and slot.path:
                    items.append((rec.hash, which, slot))
        for content_hash, which, slot in items:
            if epoch != self.warmer_epoch:
                return
            considered += 1
            self.counters.warm_considered = considered
            try:
                data = Path(slot.path).read_bytes()
            except OSError:
                continue
            if epoch != self.warmer_epoch:
                return
            key = self.thumb_cache_key(content_hash, which, size, slot.rev)
            await thumbnail_cache.put(key, data)
            if epoch != self.warmer_epoch:
                await thumbnail_cache.invalidate(key)
                return
        if epoch != self.warmer_epoch:
            return
        stats = await thumbnail_cache.stats()
        self.counters.ram_evicted = int(stats.get("evicted") or 0)
        self.thumbnail_warm_complete = True
        log.info(
            "catalog warmer epoch=%d considered=%d resident=%d evicted=%d complete=1",
            epoch,
            self.counters.warm_considered,
            stats.get("entries") or 0,
            self.counters.ram_evicted,
        )

    async def warmer_put_for_test(self, epoch: int, key: Any, data: bytes) -> bool:
        """Stale-epoch puts must not land. Used by tests."""
        if epoch != self.warmer_epoch:
            return False
        await thumbnail_cache.put(key, data)
        if epoch != self.warmer_epoch:
            await thumbnail_cache.invalidate(key)
            return False
        return True

    # ── status ─────────────────────────────────────────────────────────────

    def status_now(self) -> dict[str, Any]:
        stats = {
            "entries": len(thumbnail_cache._items),
            "bytes": thumbnail_cache._bytes,
            "evicted": thumbnail_cache.evicted,
            "max_bytes": thumbnail_cache.max_bytes,
        }
        resident_entries = int(stats["entries"]) if self.thumbnails_to_ram else 0
        resident_bytes = int(stats["bytes"]) if self.thumbnails_to_ram else 0
        ram_evicted = int(stats["evicted"]) if self.thumbnails_to_ram else 0
        if self.thumbnails_to_ram:
            self.counters.ram_evicted = ram_evicted
        warm_complete = True if not self.thumbnails_to_ram else self.thumbnail_warm_complete
        return {
            "ok": True,
            "catalog_ready": self.catalog_ready,
            "hydration_phase": self.hydration_phase,
            "hydration_duration": self.hydration_duration,
            "records_loaded": self.records_loaded,
            "records_total": self.records_total,
            "index_load_failed": self.index_load_failed,
            "record_count": len(self.hash_to_record),
            "path_count": len(self.path_to_hash),
            "hash_count": len(self.hash_to_record),
            "malformed_record_count": self.counters.malformed_record_count,
            "duplicate_record_count": self.counters.duplicate_record_count,
            "isolated_count": len(self.isolated),
            "persist_failed_count": self.counters.persist_failed_count,
            "warmer_epoch": self.warmer_epoch,
            "thumbnail_warm_complete": warm_complete,
            "selected_size": self.selected_size,
            "thumbnails_to_ram": self.thumbnails_to_ram,
            "budget_bytes": THUMB_RAM_BUDGET,
            "resident_entries": resident_entries,
            "resident_bytes": resident_bytes,
            "warm_considered": 0 if not self.thumbnails_to_ram else self.counters.warm_considered,
            "ram_hits": 0 if not self.thumbnails_to_ram else self.counters.ram_hits,
            "ram_misses": 0 if not self.thumbnails_to_ram else self.counters.ram_misses,
            "ram_evicted": 0 if not self.thumbnails_to_ram else ram_evicted,
            "disk_fallbacks": 0 if not self.thumbnails_to_ram else self.counters.disk_fallbacks,
            "index_json_reads": self.counters.index_json_reads,
            "record_json_reads": self.counters.record_json_reads,
            "source_stats": self.counters.source_stats,
            "repair_enqueued": self.counters.repair_enqueued,
            "probes": self.counters.probes,
            "hashes": self.counters.hashes,
        }

    async def status(self) -> dict[str, Any]:
        return self.status_now()


_CATALOG: CatalogIndex | None = None


def get_catalog() -> CatalogIndex:
    global _CATALOG
    if _CATALOG is None:
        _CATALOG = CatalogIndex()
    return _CATALOG


def catalog_if_ready() -> CatalogIndex | None:
    cat = _CATALOG
    if cat is not None and cat.catalog_ready:
        return cat
    return None


def reset_catalog() -> None:
    global _CATALOG
    if _CATALOG is not None:
        _CATALOG.release_process_lock()
    _CATALOG = None


def set_catalog(cat: CatalogIndex) -> CatalogIndex:
    global _CATALOG
    _CATALOG = cat
    return cat


def note_index_json_read() -> None:
    cat = _CATALOG
    if cat is not None:
        cat.note_index_json_read()


def note_record_json_read() -> None:
    cat = _CATALOG
    if cat is not None:
        cat.note_record_json_read()


def note_source_stat() -> None:
    cat = _CATALOG
    if cat is not None:
        cat.note_source_stat()
