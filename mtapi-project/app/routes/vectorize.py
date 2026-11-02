"""Vectorize routes — status, manifest, run, svg.

Global in/out only (repo standard): input arrives as an absolute path from the
top input bar (bestInput), output honors X-MTAPI-Output-Dir via
pathutil.finalize_output_path — never-overwrite, falling back next to the
source. There is deliberately no private upload/job path.
"""
import importlib
import json
import shutil
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app.pathutil import finalize_output_path

router = APIRouter(prefix="/vectorize")

_ENGINE_DIR = Path(__file__).resolve().parent.parent / "filters" / "vectorize_engines"


def load_manifests() -> dict:
    out = {}
    if _ENGINE_DIR.is_dir():
        for f in sorted(_ENGINE_DIR.glob("*.json")):
            try:
                out[f.stem] = json.loads(f.read_text())
            except Exception:  # noqa: BLE001 — skip malformed manifest
                continue
    return out


def _engine_availability(engine_id: str) -> tuple[bool, str | None]:
    """Real dependency check per engine (spec §2, §8)."""
    manifest = load_manifests().get(engine_id, {})
    deps = manifest.get("dependencies", {})
    binary = deps.get("binary")
    if binary:
        found = shutil.which(binary)
        if not found and binary == "inkscape":
            found = shutil.which("inkscape") or ("/home/m/.local/bin/inkscape"
                                                 if Path("/home/m/.local/bin/inkscape").exists() else None)
        if not found:
            return False, f"{binary} binary not found"
    # Inkscape 1.4 removed the headless tracing CLI (--tracer-engine); tracing
    # only runs in the GUI/Action dialogs. Report it honestly as unavailable
    # rather than failing a run with a confusing error (spec §8).
    if deps.get("headless_trace") is False:
        return False, f"{engine_id} 1.4 has no headless trace CLI (GUI only)"
    py_mod = deps.get("python_module")
    if py_mod:
        try:
            importlib.import_module(py_mod)
        except Exception:  # noqa: BLE001
            return False, f"{py_mod} python module unavailable"
    if deps.get("gpu"):
        try:
            import torch
            if not torch.cuda.is_available():
                return False, "GPU not detected — neural disabled"
        except Exception:  # noqa: BLE001
            return False, "torch unavailable"
    return True, None


@router.get("/status")
def status():
    engines = []
    for engine_id, manifest in load_manifests().items():
        available, reason = _engine_availability(engine_id)
        engines.append({
            "id": engine_id,
            "name": manifest.get("name", engine_id),
            "available": available,
            "reason": reason,
        })
    return {"ok": True, "engines": engines, "openvino_device": "CPU"}


@router.get("/manifest")
def manifest():
    return {"ok": True, "manifests": load_manifests()}


class RunRequest(BaseModel):
    enabled: list[str]
    options: dict = {}
    # Absolute path from the global input bar — the only input channel.
    input_path: str


@router.post("/run")
async def run(
    req: RunRequest,
    x_mtapi_output_dir: str | None = Header(None, alias="X-MTAPI-Output-Dir"),
):
    from app.operations import vectorize_ops

    p = Path(req.input_path).expanduser()
    if not p.is_file():
        return {"ok": False, "error": f"input not found: {req.input_path}"}
    input_path = str(p.resolve())

    # Per-engine output paths via the repo standard: global output dir when
    # set (X-MTAPI-Output-Dir), else next to source; never overwrites
    # (_0001 numbering). SVG vectors — no scaling involved (spec §9).
    out_paths = {}
    out_dirs = set()
    for engine_id in req.enabled:
        out = finalize_output_path(
            None,
            source=input_path,
            default_suffix=f"_{engine_id}",
            default_ext=".svg",
            output_dir=x_mtapi_output_dir,
        )
        out_paths[engine_id] = str(out)
        out_dirs.add(str(out.parent))

    results = await vectorize_ops.orchestrate(
        req.enabled, req.options, input_path, out_paths
    )
    for r in results:
        if r.get("ok") and r.get("svg_path"):
            r["svg_url"] = "/vectorize/svg?path=" + quote(r["svg_path"])
    return {
        "ok": True,
        "input": input_path,
        "output_dir": next(iter(out_dirs)) if len(out_dirs) == 1 else None,
        "results": results,
    }


@router.get("/svg")
def serve_svg(path: str):
    """Serve a produced SVG by absolute path."""
    target = Path(path).expanduser().resolve()
    if target.suffix.lower() != ".svg" or not target.is_file():
        raise HTTPException(status_code=404, detail="not found")
    return FileResponse(str(target), media_type="image/svg+xml")
