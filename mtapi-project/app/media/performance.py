"""Performance preferences and bounded in-process media caches."""
from __future__ import annotations

import asyncio
import json
from collections import OrderedDict
from pathlib import Path
from typing import Any

from .config import MEDIA_ROOT, normalize_thumb_size

SETTINGS_PATH = MEDIA_ROOT.parent / "settings.json"
DEFAULT_SETTINGS: dict[str, Any] = {
    "thumbnail_size": "H",
    "thumbnails_to_ram": False,
    "phash_to_ram": False,
    "autosave_interval": 30,
    "warm_models": {"deepdream": False, "styletransfer": False, "fastsam": False},
}
_settings_lock = asyncio.Lock()
_settings_cache: tuple[float, dict[str, Any]] | None = None


def _normalize_settings(raw: dict[str, Any] | None) -> dict[str, Any]:
    raw = raw if isinstance(raw, dict) else {}
    warm = raw.get("warm_models") if isinstance(raw.get("warm_models"), dict) else {}
    try:
        interval = int(raw.get("autosave_interval", DEFAULT_SETTINGS["autosave_interval"]))
    except (TypeError, ValueError):
        interval = DEFAULT_SETTINGS["autosave_interval"]
    return {
        "thumbnail_size": normalize_thumb_size(raw.get("thumbnail_size", "H")),
        "thumbnails_to_ram": bool(raw.get("thumbnails_to_ram", False)),
        "phash_to_ram": bool(raw.get("phash_to_ram", False)),
        "autosave_interval": max(5, min(3600, interval)),
        "warm_models": {
            name: bool(warm.get(name, False))
            for name in ("deepdream", "styletransfer", "fastsam")
        },
    }


def load_settings() -> dict[str, Any]:
    global _settings_cache
    try:
        mtime = SETTINGS_PATH.stat().st_mtime
    except OSError:
        mtime = -1.0
        raw = {}
    else:
        if _settings_cache is not None and _settings_cache[0] == mtime:
            return _settings_cache[1]
        try:
            raw = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
        except (FileNotFoundError, OSError, ValueError):
            raw = {}
    data = _normalize_settings(raw)
    _settings_cache = (mtime, data)
    return data


async def save_settings(raw: dict[str, Any] | None) -> dict[str, Any]:
    async with _settings_lock:
        data = _normalize_settings(raw)
        SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = SETTINGS_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2, sort_keys=True), encoding="utf-8")
        tmp.replace(SETTINGS_PATH)
        global _settings_cache
        _settings_cache = None
        return {"ok": True, **data}


class ByteLRU:
    """A small byte-budgeted LRU safe for use by the async route layer."""

    def __init__(self, max_bytes: int):
        self.max_bytes = max(1, int(max_bytes))
        self._items: OrderedDict[Any, bytes | str] = OrderedDict()
        self._bytes = 0
        self._lock = asyncio.Lock()

    async def get(self, key: Any) -> bytes | str | None:
        async with self._lock:
            value = self._items.get(key)
            if value is not None:
                self._items.move_to_end(key)
            return value

    async def put(self, key: Any, value: bytes | str) -> None:
        size = len(value.encode("utf-8")) if isinstance(value, str) else len(value)
        if size > self.max_bytes:
            return
        async with self._lock:
            old = self._items.pop(key, None)
            if old is not None:
                self._bytes -= len(old.encode("utf-8")) if isinstance(old, str) else len(old)
            self._items[key] = value
            self._bytes += size
            while self._bytes > self.max_bytes and self._items:
                _, evicted = self._items.popitem(last=False)
                self._bytes -= len(evicted.encode("utf-8")) if isinstance(evicted, str) else len(evicted)

    async def invalidate(self, key: Any) -> None:
        async with self._lock:
            old = self._items.pop(key, None)
            if old is not None:
                self._bytes -= len(old.encode("utf-8")) if isinstance(old, str) else len(old)

    async def clear(self) -> None:
        async with self._lock:
            self._items.clear()
            self._bytes = 0

    async def stats(self) -> dict[str, int]:
        async with self._lock:
            return {"entries": len(self._items), "bytes": self._bytes, "max_bytes": self.max_bytes}


# Conservative defaults for a local media server. These are byte limits, not
# object counts, so a large pool cannot turn cache population into an OOM.
thumbnail_cache = ByteLRU(64 * 1024 * 1024)
phash_cache = ByteLRU(1 * 1024 * 1024)

