"""Load API keys from ~/.secrets (export KEY=… lines) without logging values."""
from __future__ import annotations

import os
import re
from pathlib import Path

_SECRETS_CANDIDATES = (
    Path.home() / ".secrets",
    Path.home() / ".secreta",
    Path(os.environ.get("MTAPI_SECRETS_FILE", "")),
)

_EXPORT_RE = re.compile(
    r"""^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(['"]?)(.*)\2\s*$"""
)

_loaded = False


def secrets_path() -> Path | None:
    for p in _SECRETS_CANDIDATES:
        if p and str(p) != "." and p.is_file():
            return p
    return None


def load_secrets(*, overwrite: bool = False) -> list[str]:
    """Parse ~/.secrets into os.environ. Returns list of key *names* loaded (not values)."""
    global _loaded
    path = secrets_path()
    if path is None:
        _loaded = True
        return []

    loaded: list[str] = []
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []

    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        m = _EXPORT_RE.match(s)
        if not m:
            continue
        key, _q, val = m.group(1), m.group(2), m.group(3)
        # strip trailing comments for unquoted values
        if not _q and " #" in val:
            val = val.split(" #", 1)[0].rstrip()
        if not overwrite and os.environ.get(key):
            continue
        if val:
            os.environ[key] = val
            loaded.append(key)

    _loaded = True
    return loaded


def ensure_secrets() -> None:
    if not _loaded:
        load_secrets()


def get_secret(name: str, default: str | None = None) -> str | None:
    ensure_secrets()
    v = os.environ.get(name)
    if v is None or not str(v).strip():
        return default
    return str(v).strip()
