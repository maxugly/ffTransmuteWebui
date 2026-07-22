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
    uvicorn.run("app.main:app", host="0.0.0.0", port=24590)
