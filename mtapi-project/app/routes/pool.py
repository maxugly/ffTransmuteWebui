"""Pool and project routes: state, match, scan, save/load."""
from pathlib import Path

from fastapi import FastAPI, HTTPException

from .. import media_store


def register(app: FastAPI, is_video_fn) -> None:
    @app.get("/api/pool/state", tags=["meta"])
    async def get_pool_state():
        return media_store.load_pool_state()

    @app.put("/api/pool/state", tags=["meta"])
    @app.post("/api/pool/state", tags=["meta"])
    async def put_pool_state(body: dict):
        return await media_store.save_pool_state(body or {})

    @app.post("/api/project/save", tags=["meta"])
    async def project_save(body: dict):
        path = (body or {}).get("path")
        if not path:
            raise HTTPException(status_code=400, detail="path is required")
        name = (body or {}).get("name")
        return await media_store.save_project_file(path, body or {}, name=name)

    @app.get("/api/project/load", tags=["meta"])
    async def project_load(path: str):
        result = media_store.load_project_file(path)
        if not result.get("ok"):
            raise HTTPException(status_code=400, detail=result.get("error") or "load failed")
        await media_store.save_pool_state(result)
        return result

    @app.get("/api/project/last", tags=["meta"])
    async def project_last():
        p = media_store.get_last_project_path()
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
        result = await media_store.match_frames(
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
    async def pool_scan(path: str, recursive: bool = False):
        path_obj = Path(path).resolve()
        if not path_obj.exists() or not path_obj.is_dir():
            raise HTTPException(status_code=404, detail="Directory not found")
        videos = []
        try:
            iterator = path_obj.rglob("*") if recursive else path_obj.iterdir()
            for item in iterator:
                if item.name.startswith("."):
                    continue
                try:
                    if not is_video_fn(item):
                        continue
                    st = item.stat()
                    videos.append({
                        "name": item.name,
                        "path": str(item.resolve()),
                        "size": st.st_size,
                    })
                except Exception:
                    continue
            videos.sort(key=lambda v: v["name"].lower())
            return {
                "ok": True,
                "directory": str(path_obj),
                "count": len(videos),
                "videos": videos,
            }
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))
