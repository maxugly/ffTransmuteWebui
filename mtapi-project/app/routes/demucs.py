"""Demucs OV status route: GET /api/demucs_ov/status (read-only).

Tab-local installer card driver. Install itself is
POST /ops/demucs_ov_setup (registry-built).
"""
from fastapi import FastAPI

from ..operations.demucs_ops import get_demucs_ov_status


def register(app: FastAPI) -> None:
    @app.get("/api/demucs_ov/status", tags=["meta"])
    async def demucs_ov_status():
        return get_demucs_ov_status()
