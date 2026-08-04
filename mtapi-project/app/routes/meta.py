"""Remaining meta routes: watcher, cancel, facemorph list, job progress, ops list, health."""
from pathlib import Path

from fastapi import FastAPI, HTTPException


def register(app: FastAPI, *, folder_watcher, job_control, check_tools, REGISTRY) -> None:
    from .. import job_queue
    @app.get("/api/watcher", tags=["meta"])
    async def watcher_status():
        return {"ok": True, **folder_watcher.get_status()}

    @app.post("/api/watcher", tags=["meta"])
    async def watcher_configure(body: dict):
        st = folder_watcher.apply_config(
            enabled=body.get("enabled"),
            in_dir=body.get("in_dir"),
            out_dir=body.get("out_dir"),
            target_width=body.get("target_width"),
            target_height=body.get("target_height"),
            resize_mode=body.get("resize_mode"),
        )
        ok = not st.get("last_error") or not st.get("enabled")
        if body.get("enabled") is True and not st.get("enabled"):
            return {"ok": False, "error": st.get("last_error") or "could not enable watcher", **st}
        return {"ok": True, **st}

    @app.post("/api/cancel", tags=["meta"])
    async def cancel_job(body: dict):
        token = body.get("token")
        if not token:
            raise HTTPException(status_code=400, detail="token is required")
        found = job_control.request_cancel(str(token))
        return {
            "ok": True,
            "found": found,
            "token": token,
            "message": "Cancel requested" if found else "No active job with that token (may have already finished)",
        }

    @app.get("/api/facemorph/list", tags=["meta"])
    @app.get("/api/images/list", tags=["meta"])
    async def list_images_in_dir(path: str):
        """List stills in a directory (non-recursive).

        Used by Image Sort, Face Morph, WithoutBG, etc. to expand + Folder
        into an ordered path list. Self-contained — does not import facemorph.
        """
        # Keep in sync with frontend IMAGE_EXTS / pool scan.
        image_exts = {
            ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif",
            ".tif", ".tiff", ".ppm", ".pgm",
        }
        p = Path(path).expanduser().resolve()
        if not p.is_dir():
            raise HTTPException(status_code=400, detail=f"Not a directory: {p}")
        files = sorted(
            str(child.resolve())
            for child in p.iterdir()
            if child.is_file() and child.suffix.lower() in image_exts
            and not child.name.startswith(".")
        )
        return {"ok": True, "path": str(p), "files": files, "count": len(files)}

    @app.post("/api/queue", tags=["meta"])
    async def queue_add(body: dict):
        op_id = (body or {}).get("op_id") or (body or {}).get("operation")
        if not op_id:
            raise HTTPException(status_code=400, detail="op_id is required")
        return await job_queue.enqueue(
            str(op_id),
            (body or {}).get("body") or {},
            label=(body or {}).get("label"),
        )

    @app.get("/api/queue", tags=["meta"])
    async def queue_get():
        return await job_queue.snapshot()

    @app.delete("/api/queue/{item_id}", tags=["meta"])
    async def queue_delete(item_id: str):
        return await job_queue.remove_pending(item_id)

    @app.post("/api/queue/{item_id}/cancel", tags=["meta"])
    async def queue_cancel(item_id: str):
        return await job_queue.cancel_item(item_id)

    @app.post("/api/queue/clear", tags=["meta"])
    async def queue_clear():
        return await job_queue.clear_pending()

    @app.get("/api/job/{token}", tags=["meta"])
    async def job_progress(token: str):
        snap = job_control.get_progress(token)
        if not snap:
            return {
                "ok": False,
                "found": False,
                "token": token,
                "status": "unknown",
                "message": "No progress for this token (job finished or never started)",
            }
        elapsed = snap.get("elapsed_s")
        eta = snap.get("eta_s")
        rate = snap.get("rate")
        return {
            "ok": True,
            "found": True,
            **snap,
            "elapsed_h": job_control.format_duration(elapsed),
            "eta_h": job_control.format_duration(eta) if eta is not None else "—",
            "rate_h": snap.get("rate_h"),
        }

    @app.get("/ops", tags=["meta"])
    async def list_ops() -> dict:
        return {
            op_id: {
                "summary": spec.summary,
                "tags": spec.tags,
                "params_schema": spec.params_model.model_json_schema(),
            }
            for op_id, spec in REGISTRY.items()
        }

    @app.get("/health", tags=["meta"])
    async def health() -> dict:
        warnings = check_tools()
        return {
            "ok": True,
            "version": app.version,
            "operations_registered": len(REGISTRY),
            "warnings": warnings,
        }
