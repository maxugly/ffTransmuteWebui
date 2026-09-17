"""DeepDream OV status route: GET /api/deepdream_ov/status (read-only).

Tab-local installer card driver. Install itself is
POST /ops/deepdream_ov_setup (registry-built).
"""
from fastapi import FastAPI

from ..operations.deepdream_ops import get_deepdream_ov_status


def register(app: FastAPI) -> None:
    @app.get("/api/deepdream_ov/status", tags=["meta"])
    async def deepdream_ov_status():
        return get_deepdream_ov_status()
