"""Media-related routes: video, image, probe, media_info, thumbnail, export_frame."""
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse

from .. import media_store


def register(app: FastAPI, probe_fn) -> None:
    @app.get("/api/video", tags=["meta"])
    async def get_video(path: str):
        path_obj = Path(path).resolve()
        if not path_obj.exists() or not path_obj.is_file():
            raise HTTPException(status_code=404, detail="Video file not found")
        return FileResponse(str(path_obj))

    @app.get("/api/image", tags=["meta"])
    async def get_image(path: str):
        path_obj = Path(path).resolve()
        if not path_obj.exists() or not path_obj.is_file():
            raise HTTPException(status_code=404, detail="Image file not found")
        return FileResponse(str(path_obj))

    @app.get("/api/probe", tags=["meta"])
    async def probe_video(path: str):
        path_obj = Path(path).resolve()
        if not path_obj.exists() or not path_obj.is_file():
            raise HTTPException(status_code=404, detail="File not found")
        info = await probe_fn(path_obj)
        if not info.get("ok"):
            return info
        true_frames = info.get("frames") or 0
        info["true_frames"] = true_frames
        info["frames"] = max(true_frames, 100)
        return info

    @app.get("/api/media_info", tags=["meta"])
    async def media_info(path: str, ensure_thumbs: bool = True):
        path_obj = Path(path).resolve()
        if not path_obj.exists() or not path_obj.is_file():
            raise HTTPException(status_code=404, detail="File not found")
        return await media_store.open_media(
            path_obj,
            probe_fn=probe_fn,
            ensure_thumbs_flag=ensure_thumbs,
            record_open=True,
        )

    @app.get("/api/thumbnail", tags=["meta"])
    async def get_thumbnail(path: str | None = None, hash: str | None = None, which: str = "first"):
        which = (which or "first").lower()
        if which not in ("first", "last"):
            raise HTTPException(status_code=400, detail="which must be 'first' or 'last'")
        content_hash = hash
        source: Path | None = None
        if path:
            path_obj = Path(path).resolve()
            if not path_obj.exists() or not path_obj.is_file():
                raise HTTPException(status_code=404, detail="File not found")
            source = path_obj
            content_hash, _ = await media_store.resolve_hash(path_obj)
            if media_store.load_record(content_hash) is None:
                await media_store.open_media(
                    path_obj,
                    probe_fn=probe_fn,
                    ensure_thumbs_flag=False,
                    record_open=False,
                )
        elif not content_hash:
            raise HTTPException(status_code=400, detail="Provide path or hash")
        thumb = await media_store.get_thumb_file(content_hash, which, source_path=source)
        if not thumb:
            raise HTTPException(status_code=500, detail=f"Failed to extract {which} frame")
        return FileResponse(str(thumb), media_type="image/jpeg")

    @app.get("/api/media/{content_hash}", tags=["meta"])
    async def get_media_by_hash(content_hash: str):
        record = media_store.load_record(content_hash)
        if not record:
            raise HTTPException(status_code=404, detail="Unknown media hash")
        path = None
        for p in record.get("paths") or []:
            if Path(p).is_file():
                path = Path(p)
                break
        return media_store._public_payload(record, path, was_cached=True)

    @app.post("/api/export_frame", tags=["meta"])
    async def export_frame(body: dict):
        path = (body or {}).get("path")
        which = ((body or {}).get("which") or "first").lower()
        output_path = (body or {}).get("output_path") or None
        if not path:
            raise HTTPException(status_code=400, detail="path is required")
        if which not in ("first", "last"):
            raise HTTPException(status_code=400, detail="which must be 'first' or 'last'")
        path_obj = Path(path).resolve()
        if not path_obj.exists() or not path_obj.is_file():
            raise HTTPException(status_code=404, detail="Source file not found")
        out = Path(output_path).resolve() if output_path else None
        return await media_store.export_frame_png(path_obj, which=which, output_path=out)

    @app.get("/api/media_cache", tags=["meta"])
    async def media_cache_info():
        return {"ok": True, **media_store.media_cache_stats()}
