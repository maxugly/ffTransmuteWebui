"""Erase status route: GET /api/erase/status (read-only).

Tab-local installer card driver. Install/update itself is
POST /ops/erase_setup (registry-built).
"""
from fastapi import FastAPI

from ..operations.erase_ops import get_erase_status


def register(app: FastAPI) -> None:
    @app.get("/api/erase/status", tags=["meta"])
    async def erase_status():
        return get_erase_status()
