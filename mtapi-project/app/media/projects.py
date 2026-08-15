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
from .pool import (
    POOL_SCHEMA_VERSION,
    _existing_path_or_none,
    _normalize_pool_payload,
    _schema_version,
    enrich_items_from_records,
)

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
    # Named projects never store global settings. Save must not touch media cache.
    pool = _normalize_pool_payload(payload, require_exists=False, drop_settings=True)
    proj_name = name or payload.get("project_name") or path.stem.replace(".ffproject", "")
    desk = pool.get("desk")
    doc = {
        "kind": PROJECT_KIND,
        "project_version": PROJECT_VERSION,
        "name": proj_name,
        "created_at": payload.get("created_at") or time.time(),
        "updated_at": time.time(),
        "pool": pool,
        "desk": desk,
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
        pool_raw = dict(raw["pool"])
        name = raw.get("name") or path.stem
        created = raw.get("created_at")
        updated = raw.get("updated_at")
        raw_version = raw.get("project_version", pool_raw.get("version"))
        desk_raw = raw.get("desk") if isinstance(raw.get("desk"), dict) else pool_raw.get("desk")
    elif isinstance(raw, dict) and ("items" in raw or "sequence" in raw):
        pool_raw = dict(raw)
        name = path.stem
        created = raw.get("created_at")
        updated = raw.get("updated_at")
        raw_version = raw.get("project_version", raw.get("version"))
        desk_raw = raw.get("desk")
    else:
        return {"ok": False, "error": "Unrecognized project file format"}

    if isinstance(desk_raw, dict) and "desk" not in pool_raw:
        pool_raw["desk"] = desk_raw

    missing: list[str] = []
    # Named project loads must drop desk.settings so they cannot overwrite globals.
    pool = _normalize_pool_payload(
        pool_raw, require_exists=True, drop_settings=True, missing=missing,
    )

    try:
        LAST_PROJECT_PATH.parent.mkdir(parents=True, exist_ok=True)
        LAST_PROJECT_PATH.write_text(str(path), encoding="utf-8")
    except Exception:
        pass

    enrich_items_from_records(pool)

    return {
        "ok": True,
        "path": str(path),
        "name": name,
        "created_at": created,
        "updated_at": updated,
        **pool,
        "selected_path": _existing_path_or_none(pool.get("selected_path")),
        "selected_image_path": _existing_path_or_none(pool.get("selected_image_path")),
        "migrated_from": _schema_version(raw_version),
        "project_version": POOL_SCHEMA_VERSION,
        "missing": missing,
        "item_count": len(pool["items"]),
        "image_count": len(pool.get("images") or []),
        "sequence_count": len(pool["sequence"]),
    }


def get_last_project_path() -> str | None:
    try:
        if LAST_PROJECT_PATH.exists():
            p = LAST_PROJECT_PATH.read_text(encoding="utf-8").strip()
            return p if p else None
    except Exception:
        pass
    return None
