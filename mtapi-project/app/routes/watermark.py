"""Watermark status route: GET /api/watermark/status (read-only).

Tab-local installer card driver (see docs/watermark-tab-spec.md §5.4).
Install/update itself is POST /ops/watermark_setup (registry-built).
"""
from fastapi import FastAPI

from ..operations.watermark_lama_ops import get_lama_status
from ..operations.watermark_ops import get_watermark_status


def register(app: FastAPI) -> None:
    @app.get("/api/watermark/status", tags=["meta"])
    async def watermark_status():
        payload = get_watermark_status()
        payload["lama"] = get_lama_status()
        return payload
