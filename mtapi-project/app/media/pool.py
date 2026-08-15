"""
Session pool state: load, save, normalize.

Persisted to POOL_STATE_PATH (sibling of the media hash store).

Normalization strictly prunes unknown fields but MUST preserve metadata,
signatures, hashes, probe errors, and counters. Save/load never touch the
content-addressable media cache.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from pathlib import Path
from typing import Any

from .config import POOL_STATE_PATH, existing_thumb_file
from .cache import load_record

log = logging.getLogger("mtapi.media_store")

_pool_state_lock = asyncio.Lock()

POOL_SCHEMA_VERSION = 2

_META_FLOAT_KEYS = ("duration", "fps")
_META_INT_KEYS = ("width", "height", "frames")
_META_STR_KEYS = ("video_codec", "audio_codec")
_META_BOOL_KEYS = ("has_audio",)

# Safe defaults for desk.state keys that v1 projects omit.
DESK_TAB_DEFAULTS: dict[str, dict[str, Any]] = {
    "faceMorph": {"images": [], "folder": None, "selected": 0},
    "withoutbg": {"images": [], "folder": None, "selected": 0},
    "styleTransfer": {"contents": [], "stylePath": None, "selected": 0},
    "quick": {"reconcile": "pad", "aspect": "auto", "aspectCustom": ""},
    "watcher": {
        "enabled": False,
        "in_dir": "",
        "out_dir": "",
        "resize_mode": "letterbox",
        "target_width": 1920,
        "target_height": 1080,
    },
    "imageSort": {
        "images": [],
        "folder": None,
        "selected": 0,
        "sortMode": "phash",
        "sortStrategy": "radial",
        "sortOrder": "nearest_first",
        "output": "",
    },
    "cut": {
        "refA": None,
        "refB": None,
        "mode": "separate",
        "compareMode": "separate",
        "overlayOpacity": 50,
        "abPosition": 50,
    },
    "zoompan": {
        "imagePath": None,
        "refPath": None,
        "imageW": 0,
        "imageH": 0,
        "startBox": None,
        "endBox": None,
        "durationSec": 5,
        "fps": 30,
        "aspect": "auto",
        "viewModeStart": "full",
        "viewModeEnd": "full",
        "compareTarget": "end_ref",
        "mode": "separate",
        "overlayOpacity": 50,
        "abPosition": 50,
    },
    "imgCompare": {
        "pathA": None,
        "pathB": None,
        "sortMode": "phash",
        "lastScore": None,
        "lastScoreMode": None,
        "lastError": None,
        "rating": None,
        "mode": "separate",
        "compareMode": "separate",
        "overlayOpacity": 50,
        "abPosition": 50,
    },
    "imageEdit": {"engine": "ffmpeg", "outputFormat": "png", "stack": []},
}


def _default_pool_state() -> dict[str, Any]:
    return {
        "version": POOL_SCHEMA_VERSION,
        "items": [],
        "images": [],
        "sequence": [],
        "selected_path": None,
        "selected_image_path": None,
        "reconcile": "pad",
        "aspect": "auto",
        "aspect_custom": "",
        "output_path": "",
        "target": None,
        "use_rife": False,
        "target_fps": None,
        "instant_rife": False,
        "audio_engine": "rubberband",
        "selected_variant_paths": {},
        "tile_zoom": 200,
        "tile_info": None,
        "seq_token_w": 2,
        "seq_token_h": 2,
        "layout": None,
        "desk": None,
        # Open named project pointer (session only — file written only on explicit Save)
        "project_path": None,
        "project_name": None,
        "project_dirty": False,
        "updated_at": None,
    }


def _opt_int(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _opt_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _schema_version(raw: Any) -> int:
    """Missing or malformed versions are treated as schema v1."""
    n = _opt_int(raw)
    if n is None or n < 1:
        return 1
    return n


def _normalize_meta(raw: Any) -> dict[str, Any] | None:
    if raw is None:
        return None
    if not isinstance(raw, dict):
        return None
    out: dict[str, Any] = {}
    for key in _META_FLOAT_KEYS:
        if key in raw and raw[key] is not None:
            parsed = _opt_float(raw[key])
            if parsed is not None:
                out[key] = parsed
    for key in _META_INT_KEYS:
        if key in raw and raw[key] is not None:
            parsed = _opt_int(raw[key])
            if parsed is not None:
                out[key] = parsed
    for key in _META_STR_KEYS:
        val = raw.get(key)
        if isinstance(val, str) and val:
            out[key] = val
    for key in _META_BOOL_KEYS:
        if key in raw:
            out[key] = bool(raw[key])
    return out or None


def _normalize_meta_signature(raw: Any) -> dict[str, int] | None:
    if not isinstance(raw, dict):
        return None
    size = _opt_int(raw.get("size"))
    mtime_ns = _opt_int(raw.get("mtime_ns"))
    if size is None or mtime_ns is None:
        return None
    return {"size": size, "mtime_ns": mtime_ns}


def _normalize_hash(raw: Any) -> str | None:
    if isinstance(raw, str) and raw.strip():
        return raw.strip()
    return None


def _normalize_size(raw: Any) -> int | None:
    return _opt_int(raw)


def _normalize_media_entry(
    it: dict[str, Any],
    *,
    require_exists: bool,
    missing: list[str],
) -> dict[str, Any] | None:
    p = it.get("path")
    if not p:
        return None
    path = Path(str(p)).expanduser()
    if require_exists and not path.is_file():
        missing.append(str(p))
        return None
    try:
        key = str(path.resolve()) if path.exists() else str(path)
    except OSError:
        key = str(path)
    if require_exists:
        try:
            key = str(path.resolve())
        except OSError:
            missing.append(str(p))
            return None
    err = it.get("metaError")
    if err is None:
        err = it.get("meta_error")
    if err is not None and not isinstance(err, str):
        err = str(err) if err else None
    failed_raw = it.get("thumbsFailed") or it.get("thumbs_failed") or {}
    thumbs_failed = None
    if isinstance(failed_raw, dict) and failed_raw:
        thumbs_failed = {
            "first": bool(failed_raw.get("first")),
            "last": bool(failed_raw.get("last")),
        }
    return {
        "path": key,
        "name": it.get("name") or path.name,
        "hash": _normalize_hash(it.get("hash")),
        "size": _normalize_size(it.get("size")),
        "meta": _normalize_meta(it.get("meta")),
        "metaError": err,
        "meta_signature": _normalize_meta_signature(it.get("meta_signature")),
        "history_count": _opt_int(it.get("history_count")),
        "open_count": _opt_int(it.get("open_count")),
        "thumbsFailed": thumbs_failed,
    }


def _normalize_media_entries(
    raw_list: list | None,
    *,
    missing: list[str] | None = None,
    require_exists: bool = True,
) -> list[dict[str, Any]]:
    """Dedupe path entries and prune unknown fields.

    Metadata, signatures, hashes, probe errors, and counters are preserved.
    On load (``require_exists=True``) missing files are skipped. On save they
    are kept so offline media is not silently dropped from a project.
    """
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    miss = missing if missing is not None else []
    for it in raw_list or []:
        if not isinstance(it, dict):
            continue
        entry = _normalize_media_entry(it, require_exists=require_exists, missing=miss)
        if not entry:
            continue
        if entry["path"] in seen:
            continue
        seen.add(entry["path"])
        out.append(entry)
    return out


def _normalize_sequence_entries(
    raw_list: list | None,
    *,
    missing: list[str] | None = None,
    require_exists: bool = True,
) -> list[dict[str, Any]]:
    """Normalize sequence rows. Maps legacy ``targetDuration`` → ``target_duration``."""
    out: list[dict[str, Any]] = []
    miss = missing if missing is not None else []
    for it in raw_list or []:
        if isinstance(it, str):
            p = it
            name = Path(p).name
            td = None
            vp = None
            rm = None
            vh = None
            raw_dict: dict[str, Any] | None = None
        elif isinstance(it, dict):
            p = it.get("path")
            name = it.get("name") or (Path(p).name if p else None)
            td = it.get("target_duration")
            if td is None:
                td = it.get("targetDuration")
            vp = it.get("variant_path") or it.get("variantPath")
            rm = it.get("rife_multiplier")
            if rm is None:
                rm = it.get("_rifeMultiplier")
            vh = it.get("variant_hash") or it.get("_variantHash")
            raw_dict = it
        else:
            continue
        if not p:
            continue
        path = Path(str(p)).expanduser()
        if require_exists and not path.is_file():
            miss.append(str(p))
            continue
        try:
            resolved = str(path.resolve()) if path.exists() else str(path)
        except OSError:
            resolved = str(path)
        entry: dict[str, Any] = {
            "path": resolved,
            "name": name or path.name,
        }
        parsed_td = _opt_float(td)
        if parsed_td is not None and parsed_td > 0:
            entry["target_duration"] = parsed_td
        if vp:
            try:
                vp_path = Path(str(vp)).expanduser()
                entry["variant_path"] = str(vp_path.resolve()) if vp_path.exists() else str(vp)
            except OSError:
                entry["variant_path"] = str(vp)
        parsed_rm = _opt_int(rm)
        if parsed_rm is not None and parsed_rm >= 2:
            entry["rife_multiplier"] = parsed_rm
        if isinstance(vh, str) and vh.strip():
            entry["variant_hash"] = vh.strip()
        rn = None
        if raw_dict:
            rn = raw_dict.get("rife_need") or raw_dict.get("rifeNeed")
        if rn in ("rifed", "needsRife", "noRifeNeeded"):
            entry["rife_need"] = rn
        if raw_dict is None:
            out.append(entry)
            continue
        out.append(entry)
    return out


def _hydrate_desk(desk: Any, *, drop_settings: bool = False) -> dict[str, Any] | None:
    if not isinstance(desk, dict):
        return None
    out: dict[str, Any] = {}
    if "schema_version" in desk:
        out["schema_version"] = _schema_version(desk.get("schema_version"))
        if out["schema_version"] < 2:
            out["schema_version"] = POOL_SCHEMA_VERSION
    else:
        out["schema_version"] = POOL_SCHEMA_VERSION
    gi = desk.get("global_inputs")
    if isinstance(gi, dict):
        out["global_inputs"] = {
            "video": gi.get("video") or "",
            "image": gi.get("image") or "",
            "path_in": gi.get("path_in") or "",
            "path_out": gi.get("path_out") or "",
            "frame_start": _opt_int(gi.get("frame_start")) or 1,
            "frame_end": _opt_int(gi.get("frame_end")) or 100,
        }
    if isinstance(desk.get("active_tab"), str):
        out["active_tab"] = desk["active_tab"]
    fs = desk.get("form_state")
    if isinstance(fs, dict):
        out["form_state"] = fs
    raw_state = desk.get("state")
    state: dict[str, Any] = dict(raw_state) if isinstance(raw_state, dict) else {}
    for key, default in DESK_TAB_DEFAULTS.items():
        cur = state.get(key)
        if isinstance(cur, dict):
            state[key] = {**default, **cur}
        else:
            state[key] = dict(default)
    if drop_settings:
        state.pop("settings", None)
    elif "settings" in state and not isinstance(state.get("settings"), dict):
        state.pop("settings", None)
    if isinstance(state.get("project"), dict) or "project" in state:
        # project pointer is session-owned; keep if present
        pass
    out["state"] = state
    return out


def _existing_path_or_none(value: Any) -> str | None:
    if not value:
        return None
    try:
        p = Path(str(value))
        return str(p.resolve()) if p.is_file() else None
    except OSError:
        return None


def _clamp_token(value: Any, default: int = 2) -> int:
    n = _opt_int(value)
    if n is None:
        return default
    return max(0, min(5, n))


def _normalize_pool_payload(
    payload: dict[str, Any],
    *,
    require_exists: bool = False,
    drop_settings: bool = False,
    missing: list[str] | None = None,
) -> dict[str, Any]:
    """Strict pool document: known keys only. Always rewritten as schema v2."""
    miss = missing if missing is not None else []
    tile_zoom = _opt_int(payload.get("tile_zoom"))
    if tile_zoom is None:
        tile_zoom = 200
    tile_info = payload.get("tile_info")
    if not isinstance(tile_info, dict):
        tile_info = None
    layout = payload.get("layout")
    if not isinstance(layout, dict):
        layout = None
    variants = payload.get("selected_variant_paths")
    if not isinstance(variants, dict):
        variants = {}
    items = payload.get("items") or []
    images = payload.get("images") or []
    # Already-normalized lists (from load) are passed through the same pruner.
    return {
        "version": POOL_SCHEMA_VERSION,
        "items": _normalize_media_entries(
            items, missing=miss, require_exists=require_exists,
        ),
        "images": _normalize_media_entries(
            images, missing=miss, require_exists=require_exists,
        ),
        "sequence": _normalize_sequence_entries(
            payload.get("sequence") or [],
            missing=miss,
            require_exists=require_exists,
        ),
        "selected_path": payload.get("selected_path"),
        "selected_image_path": payload.get("selected_image_path"),
        "reconcile": payload.get("reconcile") or "pad",
        "aspect": payload.get("aspect") or "auto",
        "aspect_custom": payload.get("aspect_custom") or "",
        "output_path": payload.get("output_path") or "",
        "target": payload.get("target") or None,
        "use_rife": bool(payload.get("use_rife")),
        "target_fps": payload.get("target_fps") or None,
        "instant_rife": bool(payload.get("instant_rife")),
        "audio_engine": payload.get("audio_engine") or "rubberband",
        "selected_variant_paths": variants,
        "tile_zoom": tile_zoom,
        "tile_info": tile_info,
        "seq_token_w": _clamp_token(payload.get("seq_token_w") or payload.get("seqTokenW"), 2),
        "seq_token_h": _clamp_token(payload.get("seq_token_h") or payload.get("seqTokenH"), 2),
        "layout": layout,
        "desk": _hydrate_desk(payload.get("desk"), drop_settings=drop_settings),
        "project_path": payload.get("project_path") or None,
        "project_name": payload.get("project_name") or None,
        "project_dirty": bool(payload.get("project_dirty")),
        "updated_at": time.time(),
    }


def _record_thumb_flags(content_hash: str, rec: dict[str, Any] | None) -> tuple[dict[str, bool], dict[str, bool]]:
    """Presence + hard-fail flags from the on-disk record. No ffmpeg."""
    failed_raw = (rec or {}).get("thumb_failed") or {}
    failed = {
        "first": bool(failed_raw.get("first")),
        "last": bool(failed_raw.get("last")),
    }
    thumbs = {
        "first": (not failed["first"]) and existing_thumb_file(content_hash, "first") is not None,
        "last": (not failed["last"]) and existing_thumb_file(content_hash, "last") is not None,
    }
    return thumbs, failed


def enrich_items_from_records(data: dict[str, Any]) -> dict[str, Any]:
    """Fill persisted items from already-paid records. Display-only — no probe."""
    for key in ("items", "images"):
        rows = data.get(key)
        if not isinstance(rows, list):
            continue
        for item in rows:
            if not isinstance(item, dict):
                continue
            h = item.get("hash")
            if not h:
                continue
            rec = load_record(h)
            if rec is None:
                continue
            if not item.get("meta") and rec.get("meta"):
                item["meta"] = _normalize_meta(rec.get("meta"))
            if not item.get("metaError") and rec.get("meta_error"):
                err = rec.get("meta_error")
                item["metaError"] = err if isinstance(err, str) else str(err)
            thumbs, failed = _record_thumb_flags(h, rec)
            item["thumbs"] = thumbs
            item["thumbsFailed"] = failed
            if item.get("size") is None and rec.get("size") is not None:
                item["size"] = _normalize_size(rec.get("size"))
    return data


def load_pool_state() -> dict[str, Any]:
    from .catalog import catalog_if_ready
    cat = catalog_if_ready()
    if cat is not None:
        return cat.pool_state_payload()
    state = _default_pool_state()
    if not POOL_STATE_PATH.exists():
        return {**state, "ok": True, "restored": False}

    try:
        raw = json.loads(POOL_STATE_PATH.read_text(encoding="utf-8"))
    except Exception as e:
        log.warning("pool state load failed: %s", e)
        return {**state, "ok": False, "error": str(e), "restored": False}

    if not isinstance(raw, dict):
        return {**state, "ok": False, "error": "Invalid pool state", "restored": False}

    missing: list[str] = []
    data = _normalize_pool_payload(
        raw, require_exists=True, drop_settings=False, missing=missing,
    )
    selected = _existing_path_or_none(data.get("selected_path"))
    selected_image = _existing_path_or_none(data.get("selected_image_path"))
    enrich_items_from_records(data)
    return {
        "ok": True,
        "restored": True,
        **data,
        "selected_path": selected,
        "selected_image_path": selected_image,
        "missing": missing,
        "path": str(POOL_STATE_PATH),
        "migrated_from": _schema_version(raw.get("version")),
    }


async def save_pool_state(payload: dict[str, Any]) -> dict[str, Any]:
    async with _pool_state_lock:
        POOL_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        data = _normalize_pool_payload(payload)
        tmp = POOL_STATE_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2, sort_keys=True), encoding="utf-8")
        tmp.replace(POOL_STATE_PATH)
        from .catalog import catalog_if_ready
        cat = catalog_if_ready()
        if cat is not None:
            cat.apply_membership_snapshot(data)
        return {
            "ok": True,
            "path": str(POOL_STATE_PATH),
            "item_count": len(data["items"]),
            "image_count": len(data["images"]),
            "sequence_count": len(data["sequence"]),
            "updated_at": data["updated_at"],
        }
