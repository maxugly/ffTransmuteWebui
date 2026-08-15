#!/usr/bin/env python3
"""Convenience entry point: `python run.py`. For reload-on-save during
development, use `uvicorn app.main:app --reload` directly instead.

The media catalog is a single in-memory writer. This entrypoint always
pins workers=1 and ignores WEB_CONCURRENCY / UVICORN_WORKERS > 1.
"""
import os
import sys
from pathlib import Path

# Durable TF-Hub cache (Magenta style transfer, etc.)
os.environ.setdefault(
    "TFHUB_CACHE_DIR",
    str(Path.home() / ".cache" / "tfhub_modules"),
)

import uvicorn


def _forced_workers() -> int:
    """Catalog lock + RAM index require exactly one process."""
    for key in ("WEB_CONCURRENCY", "UVICORN_WORKERS"):
        raw = os.environ.get(key)
        if not raw:
            continue
        try:
            requested = int(raw)
        except ValueError:
            continue
        if requested > 1:
            print(
                f"mtapi: ignoring {key}={requested}; catalog requires workers=1",
                file=sys.stderr,
            )
    return 1


if __name__ == "__main__":
    # Auto-detect Wayland/X11 session so kdialog (native file picker) works
    # even when the server is launched from a headless context.
    if "XDG_RUNTIME_DIR" not in os.environ:
        candidate = f"/run/user/{os.getuid()}"
        if os.path.isdir(candidate):
            os.environ["XDG_RUNTIME_DIR"] = candidate

    if not os.environ.get("WAYLAND_DISPLAY") and not os.environ.get("DISPLAY"):
        runtime = os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")
        wayland_sock = os.path.join(runtime, "wayland-0")
        if os.path.exists(wayland_sock):
            os.environ.setdefault("WAYLAND_DISPLAY", "wayland-0")
            os.environ.setdefault("QT_QPA_PLATFORM", "wayland")
        elif not os.environ.get("DISPLAY"):
            # Fall back to a reasonable X11 display
            os.environ.setdefault("DISPLAY", ":0")

    uvicorn.run("app.main:app", host="127.0.0.1", port=24590, workers=_forced_workers())
