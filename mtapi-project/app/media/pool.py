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
        "version": 1,
        "items": [],
        "sequence": [],
        "selected_path": None,
        "reconcile": "pad",
        "aspect": "auto",
        "aspect_custom": "",
        "output_path": "",
        "tile_zoom": 200,
        "tile_info": None,
        "layout": None,
        "updated_at": None,
    }


def load_pool_state() -> dict[str, Any]:
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
        entry = {
            "path": str(path.resolve()),
            "name": name or path.name,
        }
        if isinstance(it, dict) and it.get("target_duration") is not None:
            try:
                td = float(it["target_duration"])
                if td > 0:
                    entry["target_duration"] = td
            except (TypeError, ValueError):
                pass
        sequence_out.append(entry)

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
        "version": int(payload.get("version") or 1),
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
            "sequence_count": len(data["sequence"]),
            "updated_at": data["updated_at"],
        }
