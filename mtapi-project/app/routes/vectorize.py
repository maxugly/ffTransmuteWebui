"""Vectorize routes — status, manifest, svg.

Global in/out only (repo standard): input arrives as an absolute path from the
top input bar (bestInput) and runs through the standard /ops/vectorize chain;
output honors X-MTAPI-Output-Dir via pathutil.finalize_output_path —
never-overwrite, falling back next to the source. There is deliberately no
private upload/job path.
"""
import importlib
import json
import shutil
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

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


@router.get("/svg")
def serve_svg(path: str):
    """Serve a produced SVG by absolute path."""
    target = Path(path).expanduser().resolve()
    if target.suffix.lower() != ".svg" or not target.is_file():
        raise HTTPException(status_code=404, detail="not found")
    return FileResponse(str(target), media_type="image/svg+xml")
