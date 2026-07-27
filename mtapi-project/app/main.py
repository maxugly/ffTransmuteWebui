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

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware

from pydantic import BaseModel, Field

from .contract import REGISTRY, OperationResult
from .shell import check_tools
from . import media_store
from . import job_control
from . import watcher as folder_watcher
from . import operations  # noqa: F401  (side effect: populates REGISTRY)

log = logging.getLogger("mtapi")

# Ensure progress output is visible during development.
# ffmpeg stderr is streamed line-by-line via shell.run_command.
logging.basicConfig(level=logging.INFO, format="%(name)s %(levelname)s %(message)s")
log.setLevel(logging.INFO)


def _read_project_version() -> str:
    """Humble AAA.BBB.CCC.DD from repo root VERSION (see VERSIONING.md)."""
    for candidate in (
        Path(__file__).resolve().parents[2] / "VERSION",
        Path(__file__).resolve().parents[1] / "VERSION",
    ):
        try:
            v = candidate.read_text(encoding="utf-8").strip().splitlines()[0].strip()
            if v:
                return v
        except Exception:
            continue
    return "000.000.0.00"


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
    version=_read_project_version(),
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


# TODO: remove remaining inline ffprobe — use app.probe for individual fields
async def _probe_media_full(path_obj: Path) -> dict:
    """Rich ffprobe: duration, fps, frames, video/audio codecs, size, dims."""
    from .probe import probe_duration, probe_fps, probe_dimensions, probe_frame_count
    sp = str(path_obj)
    fps = await probe_fps(sp)
    duration = await probe_duration(sp)
    width, height = await probe_dimensions(sp)
    frames = await probe_frame_count(sp)
    if frames <= 0 and duration > 0 and fps > 0:
        frames = int(round(duration * fps))

    # Codec / format info still needs a full JSON probe
    cmd = [
        "ffprobe", "-v", "error",
        "-show_entries", "format=size,format_name,bit_rate:stream=codec_type,codec_name",
        "-of", "json", sp,
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
        streams = data.get("streams") or []
        fmt = data.get("format") or {}
        vstream = next((s for s in streams if s.get("codec_type") == "video"), None)
        if not vstream:
            return {"ok": False, "error": "No video streams found"}
        astream = next((s for s in streams if s.get("codec_type") == "audio"), None)
        video_codec = vstream.get("codec_name") or "unknown"
        audio_codec = (astream.get("codec_name") if astream else None) or "none"
        try:
            file_size = path_obj.stat().st_size
        except Exception:
            file_size = _safe_int(fmt.get("size"))
        return {
            "ok": True,
            "path": str(path_obj),
            "name": path_obj.name,
            "width": width,
            "height": height,
            "fps": round(fps, 3) if fps else 0.0,
            "duration": round(duration, 3) if duration else 0.0,
            "frames": frames,
            "video_codec": video_codec,
            "audio_codec": audio_codec,
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

from .routes import static
static.register(app)

from .routes import browse
browse.register(app)


from .routes import media
media.register(app, probe_fn=_probe_media_full)

from .routes import pool
pool.register(app, is_video_fn=_is_video_file)

from .routes import picker
picker.register(app)

def _make_endpoint(spec):
    async def endpoint(
        params: spec.params_model,  # type: ignore[name-defined]
        request: Request,
        x_job_token: str | None = Header(None, alias="X-Job-Token"),
        x_mtapi_output_dir: str | None = Header(None, alias="X-MTAPI-Output-Dir"),
    ) -> OperationResult:
        from . import output_dir_ctx
        output_dir_ctx.set_output_dir(x_mtapi_output_dir)
        token = (x_job_token or "").strip() or job_control.new_token()
        job_control.register(token, operation=spec.id)
        job_control.bind(token)
        job_control.report_progress(
            f"running {spec.id}",
            phase="start",
            current=0,
            total=0,
            token=token,
        )
        try:
            # Cooperative cancel: handlers/threads call job_control.check_cancelled()
            result = await spec.handler(params)
            if result and not result.ok and result.error == "Cancelled by user":
                job_control.finish(token, status="cancelled", message="Cancelled by user")
            elif result and result.ok:
                job_control.finish(token, status="done", message="complete")
            else:
                job_control.finish(
                    token,
                    status="error",
                    message=(result.error if result else "failed") or "failed",
                )
        except job_control.JobCancelled:
            log.info("op %s cancelled (token=%s…)", spec.id, token[:8])
            job_control.finish(token, status="cancelled", message="Cancelled by user")
            return OperationResult(
                ok=False,
                operation=spec.id,
                error="Cancelled by user",
                dry_run=False,
            )
        except Exception as e:
            # deepdream_ops may wrap cancel as generic Exception with message
            if "Cancelled by user" in str(e):
                job_control.finish(token, status="cancelled", message="Cancelled by user")
                return OperationResult(
                    ok=False,
                    operation=spec.id,
                    error="Cancelled by user",
                    dry_run=False,
                )
            job_control.finish(token, status="error", message=str(e)[:200])
            raise
        finally:
            job_control.unregister(token)

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

from .routes import meta
meta.register(app, folder_watcher=folder_watcher, job_control=job_control,
              check_tools=check_tools, REGISTRY=REGISTRY)

@app.on_event("startup")
async def _warn_on_missing_tools() -> None:
    for w in check_tools():
        log.warning("mtapi startup: %s", w)
