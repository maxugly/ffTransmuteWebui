"""Music OV status route: GET /api/music_ov/status (read-only).

Tab-local setup card driver. Install itself is
POST /ops/music_ov_setup (registry-built).
"""
from fastapi import FastAPI

from ..operations.music_ops import music_ov_setup  # noqa: F401 (op registration side effect)
from ..operations.music_ov_engine import get_music_ov_status


def register(app: FastAPI) -> None:
    @app.get("/api/music_ov/status", tags=["meta"])
    async def music_ov_status():
        return get_music_ov_status()
