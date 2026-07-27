from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import HTMLResponse, PlainTextResponse

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"


def register(app: FastAPI) -> None:
    @app.get("/", response_class=HTMLResponse, tags=["ui"])
    async def read_index():
        index_path = STATIC_DIR / "index.html"
        if not index_path.exists():
            return HTMLResponse("<h1>UI Not Found</h1><p>Please create index.html in app/static</p>", status_code=404)
        return HTMLResponse(content=index_path.read_text(encoding="utf-8"))

    @app.get("/style.css", tags=["ui"])
    async def read_css():
        css_path = STATIC_DIR / "style.css"
        if not css_path.exists():
            return PlainTextResponse("", status_code=404)
        return PlainTextResponse(content=css_path.read_text(encoding="utf-8"), media_type="text/css")

    @app.get("/app.js", tags=["ui"])
    async def read_js():
        js_path = STATIC_DIR / "app.js"
        if not js_path.exists():
            return PlainTextResponse("", status_code=404)
        return PlainTextResponse(content=js_path.read_text(encoding="utf-8"), media_type="application/javascript")
