"""
Session pool state: load, save, normalize.

Persisted to POOL_STATE_PATH (sibling of the media hash store).
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from pathlib import Path
from typing import Any

from .config import POOL_STATE_PATH

log = logging.getLogger("mtapi.media_store")

_pool_state_lock = asyncio.Lock()


def _default_pool_state() -> dict[str, Any]:
    return {
        "version": 2,
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
        "audio_engine": "rubberband",
        "selected_variant_paths": {},
        "tile_zoom": 200,
        "tile_info": None,
        "layout": None,
        # Open named project pointer (session only — file written only on explicit Save)
        "project_path": None,
        "project_name": None,
        "project_dirty": False,
        "updated_at": None,
    }


def _normalize_media_entries(
    raw_list: list | None,
    *,
    missing: list[str] | None = None,
) -> list[dict[str, Any]]:
    """Dedupe path entries that still exist on disk (videos or images)."""
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    miss = missing if missing is not None else []
    for it in raw_list or []:
        if not isinstance(it, dict):
            continue
        p = it.get("path")
        if not p:
            continue
        path = Path(p)
        if not path.is_file():
            miss.append(p)
            continue
        key = str(path.resolve())
        if key in seen:
            continue
        seen.add(key)
        out.append({
            "path": key,
            "name": it.get("name") or path.name,
            "hash": it.get("hash"),
            "size": it.get("size"),
        })
    return out


def load_pool_state() -> dict[str, Any]:
    state = _default_pool_state()
    if not POOL_STATE_PATH.exists():
        return {**state, "ok": True, "restored": False}

    try:
        raw = json.loads(POOL_STATE_PATH.read_text(encoding="utf-8"))
    except Exception as e:
        log.warning("pool state load failed: %s", e)
        return {**state, "ok": False, "error": str(e), "restored": False}

    missing: list[str] = []
    items_out = _normalize_media_entries(raw.get("items"), missing=missing)
    images_out = _normalize_media_entries(raw.get("images"), missing=missing)

    sequence_out = []
    for it in raw.get("sequence") or []:
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
        entry = {
            "path": str(path.resolve()),
            "name": name or path.name,
        }
        if isinstance(it, dict):
            if it.get("target_duration") is not None:
                try:
                    td = float(it["target_duration"])
                    if td > 0:
                        entry["target_duration"] = td
                except (TypeError, ValueError):
                    pass
            if it.get("variant_path"):
                entry["variant_path"] = it["variant_path"]
            if it.get("rife_multiplier"):
                try:
                    m = int(it["rife_multiplier"])
                    if m >= 2:
                        entry["rife_multiplier"] = m
                except (TypeError, ValueError):
                    pass
        sequence_out.append(entry)

    selected = raw.get("selected_path")
    if selected and not Path(selected).is_file():
        selected = None
    selected_image = raw.get("selected_image_path")
    if selected_image and not Path(selected_image).is_file():
        selected_image = None

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
        "images": images_out,
        "sequence": sequence_out,
        "selected_path": selected,
        "selected_image_path": selected_image,
        "reconcile": raw.get("reconcile") or "pad",
        "aspect": raw.get("aspect") or "auto",
        "aspect_custom": raw.get("aspect_custom") or "",
        "output_path": raw.get("output_path") or "",
        "target": raw.get("target") or None,
        "use_rife": bool(raw.get("use_rife")),
        "target_fps": raw.get("target_fps") or None,
        "instant_rife": bool(raw.get("instant_rife")),
        "audio_engine": raw.get("audio_engine") or "rubberband",
        "selected_variant_paths": raw.get("selected_variant_paths") or {},
        "tile_zoom": tile_zoom,
        "tile_info": raw.get("tile_info") if isinstance(raw.get("tile_info"), dict) else None,
        "layout": raw.get("layout") if isinstance(raw.get("layout"), dict) else None,
        "project_path": raw.get("project_path") or None,
        "project_name": raw.get("project_name") or None,
        "project_dirty": bool(raw.get("project_dirty")),
        "updated_at": raw.get("updated_at"),
        "missing": missing,
        "path": str(POOL_STATE_PATH),
    }


def _normalize_pool_payload(payload: dict[str, Any]) -> dict[str, Any]:
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
    return {
        "version": int(payload.get("version") or 2),
        "items": payload.get("items") or [],
        "images": payload.get("images") or [],
        "sequence": payload.get("sequence") or [],
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
        "selected_variant_paths": payload.get("selected_variant_paths") or {},
        "tile_zoom": tile_zoom,
        "tile_info": tile_info,
        "layout": layout,
        "project_path": payload.get("project_path") or None,
        "project_name": payload.get("project_name") or None,
        "project_dirty": bool(payload.get("project_dirty")),
        "updated_at": time.time(),
    }


async def save_pool_state(payload: dict[str, Any]) -> dict[str, Any]:
    async with _pool_state_lock:
        POOL_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        data = _normalize_pool_payload(payload)
        tmp = POOL_STATE_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2, sort_keys=True), encoding="utf-8")
        tmp.replace(POOL_STATE_PATH)
        return {
            "ok": True,
            "path": str(POOL_STATE_PATH),
            "item_count": len(data["items"]),
            "image_count": len(data["images"]),
            "sequence_count": len(data["sequence"]),
            "updated_at": data["updated_at"],
        }
