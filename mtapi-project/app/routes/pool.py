"""Pool and project routes: state, match, scan, save/load."""
from pathlib import Path

from fastapi import FastAPI, HTTPException

from .. import media
from ..media.cache import lookup_cached_hash_batch, load_record


# Still-image extensions for Image Pool folder scan (mirrors frontend IMAGE_EXTS).
IMAGE_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff", ".ppm", ".pgm",
}


def register(app: FastAPI, is_video_fn, is_image_fn=None) -> None:
    def _is_image(path: Path) -> bool:
        if is_image_fn is not None:
            return bool(is_image_fn(path))
        return path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS
    @app.get("/api/pool/state", tags=["meta"])
    async def get_pool_state():
        return media.load_pool_state()

    @app.put("/api/pool/state", tags=["meta"])
    @app.post("/api/pool/state", tags=["meta"])
    async def put_pool_state(body: dict):
        return await media.save_pool_state(body or {})

    @app.post("/api/project/save", tags=["meta"])
    async def project_save(body: dict):
        path = (body or {}).get("path")
        if not path:
            raise HTTPException(status_code=400, detail="path is required")
        name = (body or {}).get("name")
        return await media.save_project_file(path, body or {}, name=name)

    @app.get("/api/project/load", tags=["meta"])
    async def project_load(path: str):
        result = media.load_project_file(path)
        if not result.get("ok"):
            raise HTTPException(status_code=400, detail=result.get("error") or "load failed")
        await media.save_pool_state(result)
        return result

    @app.get("/api/project/last", tags=["meta"])
    async def project_last():
        p = media.get_last_project_path()
        return {"ok": True, "path": p}

    @app.get("/api/pool/match", tags=["meta"])
    async def pool_match(
        path: str,
        mode: str = "next",
        max_distance: int = 10,
        limit: int = 40,
    ):
        path_obj = Path(path).resolve()
        if not path_obj.exists() or not path_obj.is_file():
            raise HTTPException(status_code=404, detail="Query file not found")
        result = await media.match_frames(
            path_obj,
            mode=mode,
            max_distance=max_distance,
            candidate_paths=None,
            limit=limit,
        )
        if not result.get("ok"):
            return result
        return result

    @app.get("/api/pool/scan", tags=["meta"])
    async def pool_scan(path: str, recursive: bool = False, kind: str = "video"):
        """Scan a directory for media.

        kind: ``video`` (default, backward-compat), ``image``, or ``all``.
        Always returns ``videos``; when kind is image/all also returns ``images``.
        """
        path_obj = Path(path).resolve()
        if not path_obj.exists() or not path_obj.is_dir():
            raise HTTPException(status_code=404, detail="Directory not found")
        kind = (kind or "video").lower().strip()
        if kind not in ("video", "image", "all"):
            kind = "video"
        want_video = kind in ("video", "all")
        want_image = kind in ("image", "all")
        videos = []
        images = []
        try:
            iterator = path_obj.rglob("*") if recursive else path_obj.iterdir()
            all_paths = []
            for item in iterator:
                if item.name.startswith("."):
                    continue
                try:
                    if not item.is_file():
                        continue
                    st = item.stat()
                    entry = {
                        "name": item.name,
                        "path": str(item.resolve()),
                        "size": st.st_size,
                    }
                    if want_video and is_video_fn(item):
                        videos.append(entry)
                        all_paths.append(item)
                    elif want_image and _is_image(item):
                        images.append(entry)
                        all_paths.append(item)
                except Exception:
                    continue
            index = media.cache._load_index()
            hash_map = lookup_cached_hash_batch(all_paths, index=index)
            for entry in videos + images:
                h = hash_map.get(entry["path"])
                if h:
                    entry["hash"] = h
                    entry["cached"] = True
                    rec = load_record(h)
                    if rec:
                        meta = rec.get("meta") or {}
                        entry["meta"] = {
                            k: v for k, v in meta.items()
                            if k in (
                                "width", "height", "fps", "duration", "frames",
                                "video_codec", "audio_codec", "format_name", "bit_rate",
                            )
                        }
                        entry["thumbs"] = rec.get("thumbs") or {}
                        entry["history_count"] = len(rec.get("history") or [])
                        entry["open_count"] = int(rec.get("open_count") or 0)
            videos.sort(key=lambda v: v["name"].lower())
            images.sort(key=lambda v: v["name"].lower())
            payload = {
                "ok": True,
                "directory": str(path_obj),
                "kind": kind,
                "count": len(videos) if kind == "video" else (len(images) if kind == "image" else len(videos) + len(images)),
                "videos": videos,
            }
            if want_image or kind == "all":
                payload["images"] = images
                payload["image_count"] = len(images)
            if want_video:
                payload["video_count"] = len(videos)
            return payload
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))
