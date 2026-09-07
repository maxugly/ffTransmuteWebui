"""Script catalog loader — reads scripts/catalog.json, validates, caches.

Corrupt file or missing keys -> [] (never crash the route).
"""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

_CATALOG_PATH = Path(__file__).resolve().parents[1] / "scripts" / "catalog.json"

_cache: dict[str, Any] = {"mtime": 0.0, "scripts": []}


def catalog_path() -> Path:
    return _CATALOG_PATH


def _valid_param(p: Any) -> bool:
    return (
        isinstance(p, dict)
        and isinstance(p.get("name"), str)
        and p.get("name")
        and p.get("type") in ("knob", "select", "text", "binary", "file")
    )


def _valid_entry(e: Any) -> bool:
    if not isinstance(e, dict):
        return False
    if not e.get("id") or not e.get("endpoint"):
        return False
    params = e.get("parameters", [])
    if not isinstance(params, list) or not all(_valid_param(p) for p in params):
        return False
    return True


def _normalize_entry(e: dict) -> dict:
    out = dict(e)
    # op = basename of endpoint (job id for runOpWithCancel)
    try:
        out["op"] = str(e.get("op") or str(e.get("endpoint", "")).rstrip("/").rsplit("/", 1)[-1])
    except Exception:
        out["op"] = str(e.get("id"))
    out.setdefault("method", "POST")
    out.setdefault("dry_run_param", "dry_run")
    out.setdefault("input_mode", "single")
    out.setdefault("accepts", "any")
    out.setdefault("uses_frame_range", False)
    return out


def load_catalog(*, force: bool = False) -> list[dict]:
    """Load + validate the catalog. Corrupt/missing -> []. Cached by mtime."""
    path = _CATALOG_PATH
    try:
        mtime = path.stat().st_mtime if path.is_file() else 0.0
    except OSError:
        mtime = 0.0
    if not force and mtime == _cache.get("mtime"):
        return list(_cache.get("scripts") or [])
    scripts: list[dict] = []
    try:
        if path.is_file():
            raw = json.loads(path.read_text(encoding="utf-8"))
            entries = raw.get("scripts") if isinstance(raw, dict) else raw
            if isinstance(entries, list):
                scripts = [_normalize_entry(e) for e in entries if _valid_entry(e)]
    except Exception:
        scripts = []
    _cache["mtime"] = mtime
    _cache["scripts"] = scripts
    return list(scripts)


def clear_cache() -> None:
    _cache["mtime"] = 0.0
    _cache["scripts"] = []
