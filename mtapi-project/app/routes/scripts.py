"""Scripts catalog read route: GET /api/scripts/catalog (read-only V1)."""
from fastapi import FastAPI

from .. import scripts_catalog as catalog


def register(app: FastAPI) -> None:
    @app.get("/api/scripts/catalog", tags=["scripts"])
    async def scripts_catalog_list():
        return {"ok": True, "scripts": catalog.load_catalog()}
