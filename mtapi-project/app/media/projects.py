"""
Named project files (.ffproject.json): save, load, last path.

Explicit Save writes only the named project file. Session autosave is a separate
pool-state writer; it must NEVER write named project files (see persistence.js).
"""
from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any

from .config import MEDIA_ROOT
from .pool import _normalize_media_entries, _normalize_pool_payload

log = logging.getLogger("mtapi.media_store")

PROJECT_KIND = "fftransmute-project"
PROJECT_VERSION = 2
LAST_PROJECT_PATH = MEDIA_ROOT.parent / "last_project_path.txt"


def _ensure_project_ext(path: Path) -> Path:
    name = path.name
    lower = name.lower()
    if lower.endswith(".ffproject.json") or lower.endswith(".ffproj"):
        return path
    if lower.endswith(".json"):
        return path.with_name(path.stem + ".ffproject.json")
    return path.with_name(name + ".ffproject.json")


async def save_project_file(
    project_path: str | Path,
    payload: dict[str, Any],
    *,
    name: str | None = None,
) -> dict[str, Any]:
    path = _ensure_project_ext(Path(project_path).expanduser().resolve())
    path.parent.mkdir(parents=True, exist_ok=True)
    pool = _normalize_pool_payload(payload)
    proj_name = name or payload.get("project_name") or path.stem.replace(".ffproject", "")
    doc = {
        "kind": PROJECT_KIND,
        "project_version": PROJECT_VERSION,
        "name": proj_name,
        "created_at": payload.get("created_at") or time.time(),
        "updated_at": time.time(),
        "pool": pool,
        "desk": payload.get("desk") if isinstance(payload.get("desk"), dict) else None,
    }
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(doc, indent=2, sort_keys=True), encoding="utf-8")
    tmp.replace(path)
    try:
        LAST_PROJECT_PATH.parent.mkdir(parents=True, exist_ok=True)
        LAST_PROJECT_PATH.write_text(str(path), encoding="utf-8")
    except Exception:
        pass
    return {
        "ok": True,
        "path": str(path),
        "name": proj_name,
        "item_count": len(pool["items"]),
        "image_count": len(pool.get("images") or []),
        "sequence_count": len(pool["sequence"]),
        "updated_at": doc["updated_at"],
    }


def load_project_file(project_path: str | Path) -> dict[str, Any]:
    path = Path(project_path).expanduser().resolve()
    if not path.is_file():
        return {"ok": False, "error": f"Project not found: {path}"}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        return {"ok": False, "error": f"Invalid project JSON: {e}"}

    if isinstance(raw, dict) and raw.get("kind") == PROJECT_KIND and isinstance(raw.get("pool"), dict):
        pool_raw = raw["pool"]
        name = raw.get("name") or path.stem
        created = raw.get("created_at")
        updated = raw.get("updated_at")
    elif isinstance(raw, dict) and ("items" in raw or "sequence" in raw):
        pool_raw = raw
        name = path.stem
        created = raw.get("created_at")
        updated = raw.get("updated_at")
    else:
        return {"ok": False, "error": "Unrecognized project file format"}

    missing: list[str] = []
    items_out = _normalize_media_entries(pool_raw.get("items"), missing=missing)
    images_out = _normalize_media_entries(pool_raw.get("images"), missing=missing)

    sequence_out = []
    for it in pool_raw.get("sequence") or []:
        if isinstance(it, str):
            p = it
            name_e = Path(p).name
            td = None
            vp = None
            rm = None
        elif isinstance(it, dict):
            p = it.get("path")
            name_e = it.get("name") or (Path(p).name if p else None)
            td = it.get("target_duration")
            vp = it.get("variant_path")
            rm = it.get("rife_multiplier")
        else:
            continue
        if not p:
            continue
        pth = Path(p)
        if not pth.is_file():
            missing.append(p)
            continue
        entry = {"path": str(pth.resolve()), "name": name_e or pth.name}
        if td is not None:
            try:
                tdf = float(td)
                if tdf > 0:
                    entry["target_duration"] = tdf
            except (TypeError, ValueError):
                pass
        if isinstance(it, dict):
            vp = it.get("variant_path")
            if vp:
                entry["variant_path"] = str(Path(vp).expanduser().resolve())
            rm = it.get("rife_multiplier")
            try:
                if rm is not None and int(rm) >= 2:
                    entry["rife_multiplier"] = int(rm)
            except (TypeError, ValueError):
                pass
        if vp:
            entry["variant_path"] = vp
        if rm:
            try:
                m = int(rm)
                if m >= 2:
                    entry["rife_multiplier"] = m
            except (TypeError, ValueError):
                pass
        sequence_out.append(entry)

    selected = pool_raw.get("selected_path")
    if selected and not Path(selected).is_file():
        selected = None
    selected_image = pool_raw.get("selected_image_path")
    if selected_image and not Path(selected_image).is_file():
        selected_image = None
    tile_zoom = pool_raw.get("tile_zoom", 200)
    try:
        tile_zoom = int(tile_zoom)
    except Exception:
        tile_zoom = 200

    try:
        LAST_PROJECT_PATH.parent.mkdir(parents=True, exist_ok=True)
        LAST_PROJECT_PATH.write_text(str(path), encoding="utf-8")
    except Exception:
        pass

    return {
        "ok": True,
        "path": str(path),
        "name": name,
        "created_at": created,
        "updated_at": updated,
        "version": pool_raw.get("version", 1),
        "items": items_out,
        "images": images_out,
        "sequence": sequence_out,
        "selected_path": selected,
        "selected_image_path": selected_image,
        "reconcile": pool_raw.get("reconcile") or "pad",
        "aspect": pool_raw.get("aspect") or "auto",
        "aspect_custom": pool_raw.get("aspect_custom") or "",
        "output_path": pool_raw.get("output_path") or "",
        "tile_zoom": tile_zoom,
        "tile_info": pool_raw.get("tile_info") if isinstance(pool_raw.get("tile_info"), dict) else None,
        "layout": pool_raw.get("layout") if isinstance(pool_raw.get("layout"), dict) else None,
        "desk": raw.get("desk") if isinstance(raw.get("desk"), dict) else (
            pool_raw.get("desk") if isinstance(pool_raw.get("desk"), dict) else None
        ),
        "missing": missing,
        "item_count": len(items_out),
        "image_count": len(images_out),
        "sequence_count": len(sequence_out),
    }


def get_last_project_path() -> str | None:
    try:
        if LAST_PROJECT_PATH.exists():
            p = LAST_PROJECT_PATH.read_text(encoding="utf-8").strip()
            return p if p else None
    except Exception:
        pass
    return None
