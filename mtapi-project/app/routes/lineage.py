"""Lineage + mask routes for the Sequence Erase → RIFE → Conform pipeline.

Spec: docs/sequence-erase-pipeline-spec.md §2, §3, §6.

- POST /api/lineages/ensure   mint/reuse a lineageId for a source path
- GET  /api/lineages/{id}     lineage record (mask ref + clean artifacts)
- POST /api/lineages/{id}/mask  save the canonical mask (no processing)
- DELETE /api/lineages/{id}/mask  clear after confirmation (client confirms)
- GET  /api/lineages/{id}/mask.png  canonical mask bytes

All failures are HTTP 200 + {"ok": false} (invariant 10). Saving a mask
never runs an operation; it only invalidates downstream artifacts by
signature (files are kept, never deleted).
"""
from fastapi import FastAPI
from fastapi.responses import FileResponse
from pydantic import BaseModel

from ..media import lineage as lin


class EnsureBody(BaseModel):
    model_config = {"extra": "ignore"}

    path: str
    lineage_id: str | None = None


class MaskBody(BaseModel):
    model_config = {"extra": "ignore"}

    mask_b64: str
    width: int
    height: int
    erase_settings: dict | None = None


def _record(lineage_id: str, original_path: str | None = None) -> dict:
    mask = lin.load_mask_record(lineage_id)
    return {
        "ok": True,
        "lineage_id": lineage_id,
        "original_path": original_path,
        "mask": mask,
        "version": lin.LINEAGE_VERSION,
    }


def register(app: FastAPI) -> None:
    @app.post("/api/lineages/ensure", tags=["meta"])
    async def ensure_lineage(body: EnsureBody):
        canon = lin.canonical_source_path(body.path)
        if not canon:
            return {"ok": False, "error": f"invalid path: {body.path}"}
        lid = lin.ensure_lineage_id_for_path(canon, body.lineage_id)
        return {"ok": True, "lineage_id": lid, "original_path": canon,
                "mask": lin.load_mask_record(lid)}

    @app.get("/api/lineages/{lineage_id}", tags=["meta"])
    async def get_lineage(lineage_id: str):
        lid = lin.normalize_lineage_id(lineage_id)
        if not lid:
            return {"ok": False, "error": f"invalid lineage_id: {lineage_id}"}
        return _record(lid)

    @app.post("/api/lineages/{lineage_id}/mask", tags=["meta"])
    async def set_mask(lineage_id: str, body: MaskBody):
        lid = lin.normalize_lineage_id(lineage_id)
        if not lid:
            return {"ok": False, "error": f"invalid lineage_id: {lineage_id}"}
        try:
            raw = lin.decode_mask_b64(body.mask_b64)
        except ValueError as e:
            return {"ok": False, "error": str(e)}
        try:
            record = lin.save_mask(lid, raw, int(body.width), int(body.height),
                                   body.erase_settings)
        except ValueError as e:
            return {"ok": False, "error": str(e)}
        except OSError as e:
            return {"ok": False, "error": str(e)}
        record = dict(record)
        record["invalidated"] = lin.downstream_after_mask_change()
        out = _record(lid)
        out["mask"] = record
        return out

    @app.delete("/api/lineages/{lineage_id}/mask", tags=["meta"])
    async def delete_mask(lineage_id: str):
        lid = lin.normalize_lineage_id(lineage_id)
        if not lid:
            return {"ok": False, "error": f"invalid lineage_id: {lineage_id}"}
        lin.clear_mask(lid)
        return {"ok": True, "lineage_id": lid, "mask": None}

    @app.get("/api/lineages/{lineage_id}/mask.png", tags=["meta"])
    async def get_mask_png(lineage_id: str):
        lid = lin.normalize_lineage_id(lineage_id)
        if not lid:
            return {"ok": False, "error": f"invalid lineage_id: {lineage_id}"}
        path = lin.mask_path_for(lid)
        if not path.is_file():
            return {"ok": False, "error": "no mask saved for this lineage"}
        return FileResponse(str(path), media_type="image/png")
