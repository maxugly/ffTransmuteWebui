"""Style-transfer OV status route: GET /api/styletransfer_ov/status (read-only).

Tab-local installer card driver. Install itself is
POST /ops/styletransfer_ov_setup (registry-built).
"""
from fastapi import FastAPI

from ..operations.styletransfer_ops import get_styletransfer_ov_status


def register(app: FastAPI) -> None:
    @app.get("/api/styletransfer_ov/status", tags=["meta"])
    async def styletransfer_ov_status():
        return get_styletransfer_ov_status()
