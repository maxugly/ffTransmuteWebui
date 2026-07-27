#!/usr/bin/env python3
"""Convenience entry point: `python run.py`. For reload-on-save during
development, use `uvicorn app.main:app --reload` directly instead."""
import os
from pathlib import Path

# Durable TF-Hub cache (Magenta style transfer, etc.)
os.environ.setdefault(
    "TFHUB_CACHE_DIR",
    str(Path.home() / ".cache" / "tfhub_modules"),
)

import uvicorn

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

    uvicorn.run("app.main:app", host="0.0.0.0", port=24590)
