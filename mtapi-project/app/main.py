"""
Turns every OperationSpec in the registry into its own POST /ops/<id>
route. This file doesn't know what transmute or datamosh are — it just
walks contract.REGISTRY, which gets populated by importing `operations`
below. Add a new tool by writing a new *_ops.py; this file never changes.

Run with:  uvicorn app.main:app --reload --port 24590
Then see:  http://localhost:24590/docs
"""
import asyncio
import json
import logging
import os
import shutil
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse, PlainTextResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware

from .contract import REGISTRY, OperationResult
from .shell import check_tools
from . import media_store
from . import operations  # noqa: F401  (side effect: populates REGISTRY)

log = logging.getLogger("mtapi")

app = FastAPI(
    title="multitool API",
    description=(
        "Typed HTTP wrapper around local video/image CLI tools (transmute, datamosh, "
        "more to come). Every operation is one POST with a typed JSON body — see the "
        "schemas below or /openapi.json for a machine-readable spec.\n\n"
        "Local/trusted-network tool: it accepts arbitrary filesystem paths and shells "
        "out to ffmpeg-wrapping scripts with whatever privileges this process has. "
        "Don't expose it past localhost/your LAN without adding auth and path checks."
    ),
    version="0.1.0",
)

# Allow CORS for ease of local testing
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

STATIC_DIR = Path(__file__).resolve().parent / "static"
WORKSPACE_PATH = "/home/m/snc/cod/ffTransmuteWebui"
VIDEO_EXTENSIONS = {
    ".mp4", ".m4v", ".mov", ".avi", ".mkv", ".webm",
    ".mpeg", ".mpg", ".wmv", ".flv", ".ts", ".mts", ".m2ts",
}


def _parse_fps(fps_str: str | None) -> float:
    if not fps_str or fps_str in ("N/A", "0/0"):
        return 0.0
    try:
        if "/" in fps_str:
            num, den = map(float, fps_str.split("/", 1))
            return num / den if den != 0 else 0.0
        return float(fps_str)
    except Exception:
        return 0.0


def _safe_float(val, default: float = 0.0) -> float:
    try:
        if val is None or val == "N/A":
            return default
        return float(val)
    except Exception:
        return default


def _safe_int(val, default: int = 0) -> int:
    try:
        if val is None or val == "N/A":
            return default
        return int(float(val))
    except Exception:
        return default


async def _probe_media_full(path_obj: Path) -> dict:
    """Rich ffprobe: duration, fps, frames, video/audio codecs, size, dims."""
    cmd = [
        "ffprobe", "-v", "error",
        "-show_entries",
        "format=duration,size,bit_rate,format_name:"
        "stream=index,codec_type,codec_name,width,height,r_frame_rate,nb_frames,duration,avg_frame_rate",
        "-of", "json",
        str(path_obj),
    ]
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout_b, stderr_b = await proc.communicate()
        if proc.returncode != 0:
            return {"ok": False, "error": stderr_b.decode().strip() or "ffprobe failed"}

        data = json.loads(stdout_b.decode())
        fmt = data.get("format") or {}
        streams = data.get("streams") or []

        vstream = next((s for s in streams if s.get("codec_type") == "video"), None)
        astream = next((s for s in streams if s.get("codec_type") == "audio"), None)

        if not vstream:
            return {"ok": False, "error": "No video streams found"}

        fps = _parse_fps(vstream.get("avg_frame_rate") or vstream.get("r_frame_rate"))
        duration = _safe_float(fmt.get("duration"))
        if duration <= 0:
            duration = _safe_float(vstream.get("duration"))

        frames = _safe_int(vstream.get("nb_frames"))
        if frames <= 0 and duration > 0 and fps > 0:
            frames = int(round(duration * fps))

        try:
            file_size = path_obj.stat().st_size
        except Exception:
            file_size = _safe_int(fmt.get("size"))

        return {
            "ok": True,
            "path": str(path_obj),
            "name": path_obj.name,
            "width": vstream.get("width"),
            "height": vstream.get("height"),
            "fps": round(fps, 3) if fps else 0.0,
            "duration": round(duration, 3) if duration else 0.0,
            "frames": frames,
            "video_codec": vstream.get("codec_name") or "unknown",
            "audio_codec": (astream.get("codec_name") if astream else None) or "none",
            "size": file_size,
            "format_name": fmt.get("format_name"),
            "bit_rate": _safe_int(fmt.get("bit_rate")),
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _is_video_file(path: Path) -> bool:
    return path.is_file() and path.suffix.lower() in VIDEO_EXTENSIONS


def _params_input_path(params) -> str | None:
    """Best-effort pull of primary input path from an op params model."""
    data = params.model_dump() if hasattr(params, "model_dump") else dict(params)
    for key in ("input_path", "input", "path"):
        val = data.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    # multi-clip ops
    for key in ("inputs", "input_paths", "clips"):
        val = data.get(key)
        if isinstance(val, list) and val:
            first = val[0]
            if isinstance(first, str):
                return first
    return None

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
    """Probe used by mosh timeline. Includes rich fields; `frames` is floored at 100
    for slider UX, with `true_frames` holding the exact count."""
    path_obj = Path(path).resolve()
    if not path_obj.exists() or not path_obj.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    info = await _probe_media_full(path_obj)
    if not info.get("ok"):
        return info

    true_frames = info.get("frames") or 0
    info["true_frames"] = true_frames
    # mosh timeline expects a usable max range
    info["frames"] = max(true_frames, 100)
    return info


@app.get("/api/media_info", tags=["meta"])
async def media_info(path: str, ensure_thumbs: bool = True):
    """Open a media file: content-hash, probe, persistent thumbs, history.

    First open hashes the full file and extracts first/last frames (slow).
    Later opens hit the path index + hash-keyed cache (fast).
    """
    path_obj = Path(path).resolve()
    if not path_obj.exists() or not path_obj.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    return await media_store.open_media(
        path_obj,
        probe_fn=_probe_media_full,
        ensure_thumbs_flag=ensure_thumbs,
        record_open=True,
    )


@app.get("/api/thumbnail", tags=["meta"])
async def get_thumbnail(path: str | None = None, hash: str | None = None, which: str = "first"):
    """Return first/last frame JPEG keyed by content hash.

    Pass either `path` (will hash/register) or known `hash`. Thumbs live under
    ~/.cache/mtapi/media/by_hash/<hash>/{first,last}.jpg permanently.
    """
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
        # Resolve hash (uses path index when size+mtime match — no rehash)
        content_hash, _ = await media_store.resolve_hash(path_obj)
        # Ensure record exists so thumbs stay associated
        if media_store.load_record(content_hash) is None:
            await media_store.open_media(
                path_obj,
                probe_fn=_probe_media_full,
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
    """Lookup a registered media record by content hash (no path required)."""
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
    """Extract full-resolution first or last frame as PNG to disk.

    Body: { path, which: "first"|"last", output_path?: string }
    If output_path omitted, writes <stem>_<which>.png next to the video.
    """
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
    result = await media_store.export_frame_png(path_obj, which=which, output_path=out)
    return result


@app.get("/api/media_cache", tags=["meta"])
async def media_cache_info():
    """Stats for the persistent hash/thumb store."""
    return {"ok": True, **media_store.media_cache_stats()}


@app.get("/api/pool/state", tags=["meta"])
async def get_pool_state():
    """Restore media pool + sequence from disk (~/.cache/mtapi/pool_state.json)."""
    return media_store.load_pool_state()


@app.put("/api/pool/state", tags=["meta"])
@app.post("/api/pool/state", tags=["meta"])
async def put_pool_state(body: dict):
    """Persist media pool items and stitch sequence (PUT or POST for sendBeacon)."""
    return await media_store.save_pool_state(body or {})


@app.get("/api/pool/match", tags=["meta"])
async def pool_match(
    path: str,
    mode: str = "next",
    max_distance: int = 10,
    limit: int = 40,
):
    """Find clips whose first/last frames match the query via pHash Hamming distance.

    mode=next: query last frame vs candidate first frames (default — what can follow).
    mode=prev: query first vs candidate lasts.
    mode=both: either direction.

    max_distance: 0 = exact under pHash, typical useful range 0–16 on 64-bit hash.
    Candidates = current saved pool items.
    """
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
        # Still 200 with ok:false for soft failures (missing hash deps etc.)
        return result
    return result


@app.get("/api/pool/scan", tags=["meta"])
async def pool_scan(path: str, recursive: bool = False):
    """List video files in a directory for pool import (non-recursive by default)."""
    path_obj = Path(path).resolve()
    if not path_obj.exists() or not path_obj.is_dir():
        raise HTTPException(status_code=404, detail="Directory not found")

    videos = []
    try:
        if recursive:
            iterator = path_obj.rglob("*")
        else:
            iterator = path_obj.iterdir()

        for item in iterator:
            if item.name.startswith("."):
                continue
            try:
                if not _is_video_file(item):
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


@app.get("/api/picker", tags=["meta"])
async def open_native_picker(mode: str = "file", start_path: str = ""):
    """Native file dialog. modes: file | files | dir | save.
    `files` returns {paths: [...], path: first} for multi-select.
    """
    kdialog_path = shutil.which("kdialog")
    zenity_path = shutil.which("zenity")

    if not start_path:
        start_path = WORKSPACE_PATH

    video_filter = (
        "Video Files (*.mp4 *.mkv *.avi *.mov *.m4v *.webm *.mpg *.mpeg);;All Files (*)"
    )

    def _result_from_paths(paths: list[str]) -> dict:
        paths = [p for p in paths if p]
        return {
            "path": paths[0] if paths else None,
            "paths": paths,
        }

    cmd = []
    multi = mode == "files"

    if kdialog_path:
        if mode == "dir":
            cmd = [kdialog_path, "--getexistingdirectory", start_path]
        elif mode == "save":
            cmd = [kdialog_path, "--getsavefilename", start_path]
        elif multi:
            cmd = [
                kdialog_path, "--multiple", "--separate-output",
                "--getopenfilename", start_path, video_filter,
            ]
        else:
            cmd = [kdialog_path, "--getopenfilename", start_path, video_filter]
    elif zenity_path:
        if mode == "dir":
            cmd = [zenity_path, "--file-selection", "--directory", f"--filename={start_path}/"]
        elif mode == "save":
            cmd = [
                zenity_path, "--file-selection", "--save", "--confirm-overwrite",
                f"--filename={start_path}/",
            ]
        elif multi:
            cmd = [
                zenity_path, "--file-selection", "--multiple", "--separator=\n",
                f"--filename={start_path}/",
            ]
        else:
            cmd = [zenity_path, "--file-selection", f"--filename={start_path}/"]
    else:
        try:
            import tkinter as tk
            from tkinter import filedialog
            root = tk.Tk()
            root.withdraw()
            root.wm_attributes("-topmost", 1)

            if mode == "dir":
                path = filedialog.askdirectory(initialdir=start_path)
                root.destroy()
                return _result_from_paths([path] if path else [])
            if mode == "save":
                path = filedialog.asksaveasfilename(initialdir=start_path)
                root.destroy()
                return _result_from_paths([path] if path else [])
            if multi:
                paths = list(filedialog.askopenfilenames(initialdir=start_path))
                root.destroy()
                return _result_from_paths(paths)
            path = filedialog.askopenfilename(initialdir=start_path)
            root.destroy()
            return _result_from_paths([path] if path else [])
        except Exception:
            raise HTTPException(
                status_code=501,
                detail="No native file dialog utility found on server",
            )

    if cmd:
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout_b, _ = await proc.communicate()
            if proc.returncode != 0:
                return {"path": None, "paths": []}
            raw = stdout_b.decode().strip()
            if not raw:
                return {"path": None, "paths": []}
            if multi:
                paths = [p.strip() for p in raw.splitlines() if p.strip()]
                return _result_from_paths(paths)
            return _result_from_paths([raw])
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

    return {"path": None, "paths": []}


def _make_endpoint(spec):
    async def endpoint(params: spec.params_model) -> OperationResult:  # type: ignore[name-defined]
        result = await spec.handler(params)
        # Track what we've done against each content-hash identity
        try:
            await media_store.record_operation(
                _params_input_path(params),
                operation=spec.id,
                output_path=result.output_path,
                ok=result.ok,
                dry_run=result.dry_run,
            )
        except Exception as e:
            log.warning("media history hook failed for %s: %s", spec.id, e)
        return result

    endpoint.__name__ = f"run_{spec.id}"
    return endpoint


for _spec in REGISTRY.values():
    app.add_api_route(
        f"/ops/{_spec.id}",
        _make_endpoint(_spec),
        methods=["POST"],
        response_model=OperationResult,
        summary=_spec.summary,
        description=_spec.description,
        tags=_spec.tags or ["operations"],
    )


@app.get("/ops", tags=["meta"], summary="List every registered operation")
async def list_ops() -> dict:
    return {
        op_id: {"summary": spec.summary, "tags": spec.tags, "params_schema": spec.params_model.model_json_schema()}
        for op_id, spec in REGISTRY.items()
    }


@app.get("/health", tags=["meta"], summary="Liveness + missing-dependency check")
async def health() -> dict:
    warnings = check_tools()
    return {"ok": True, "operations_registered": len(REGISTRY), "warnings": warnings}


@app.on_event("startup")
async def _warn_on_missing_tools() -> None:
    for w in check_tools():
        log.warning("mtapi startup: %s", w)
