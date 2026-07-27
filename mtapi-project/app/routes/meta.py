"""Remaining meta routes: watcher, cancel, facemorph list, job progress, ops list, health."""
from pathlib import Path

from fastapi import FastAPI, HTTPException


def register(app: FastAPI, *, folder_watcher, job_control, check_tools, REGISTRY) -> None:
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
    async def facemorph_list_images(path: str):
        from .operations import facemorph_engine as fme
        p = Path(path).expanduser().resolve()
        if not p.is_dir():
            raise HTTPException(status_code=400, detail=f"Not a directory: {p}")
        files = fme.get_image_files(p)
        return {"ok": True, "path": str(p), "files": files, "count": len(files)}

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
        return {
            "ok": True,
            "found": True,
            **snap,
            "elapsed_h": job_control.format_duration(elapsed),
            "eta_h": job_control.format_duration(eta) if eta is not None else "—",
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
