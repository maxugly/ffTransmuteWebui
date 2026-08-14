import os
from pathlib import Path

from fastapi import FastAPI, HTTPException

WORKSPACE_PATH = str(Path(__file__).resolve().parent.parent.parent.parent)


def register(app: FastAPI) -> None:
    @app.get("/api/browse", tags=["meta"])
    async def browse_directory(path: str = ""):
        if not path:
            path = WORKSPACE_PATH

        path_obj = Path(path).resolve()
        if not path_obj.exists():
            path_obj = Path(WORKSPACE_PATH).resolve()

        if not path_obj.is_dir():
            if path_obj.is_file():
                path_obj = path_obj.parent
            else:
                path_obj = Path(WORKSPACE_PATH).resolve()

        try:
            entries = []
            parent = str(path_obj.parent) if path_obj.parent != path_obj else None

            for item in path_obj.iterdir():
                if item.name.startswith("."):
                    continue
                try:
                    stat = item.stat()
                    size = stat.st_size
                except Exception:
                    size = 0
                entries.append({
                    "name": item.name,
                    "path": str(item.resolve()),
                    "is_dir": item.is_dir(),
                    "size": size if item.is_file() else None,
                })

            entries.sort(key=lambda x: (not x["is_dir"], x["name"].lower()))

            return {
                "current_path": str(path_obj),
                "parent_path": parent,
                "entries": entries,
                "shortcuts": [
                    {"name": "Workspace", "path": WORKSPACE_PATH},
                    {"name": "Home", "path": os.path.expanduser("~")},
                ],
            }
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))
