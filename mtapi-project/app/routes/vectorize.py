"""Vectorize routes — status, manifest, svg.

Global in/out only (repo standard): input arrives as an absolute path from the
top input bar (bestInput) and runs through the standard /ops/vectorize chain;
output honors X-MTAPI-Output-Dir via pathutil.finalize_output_path —
never-overwrite, falling back next to the source. There is deliberately no
private upload/job path.
"""
import importlib
import json
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

from ..shell import find_binary

router = APIRouter(prefix="/vectorize")

# Host allowlist for /vectorize/svg: this endpoint serves local files and must
# not answer cross-origin requests (DNS-rebinding sends an attacker Host).
_LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})


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
        found = find_binary(binary, f"~/.local/bin/{binary}")
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
def serve_svg(request: Request, path: str):
    """Serve a produced SVG by absolute path (localhost requests only)."""
    host = (request.headers.get("host") or "").rsplit(":", 1)[0].strip("[]").lower()
    if host not in _LOCAL_HOSTS:
        raise HTTPException(status_code=403, detail="forbidden")
    target = Path(path).expanduser().resolve()
    if target.suffix.lower() != ".svg" or not target.is_file():
        raise HTTPException(status_code=404, detail="not found")
    return FileResponse(str(target), media_type="image/svg+xml")


@router.get("/analyze")
def analyze_svg(request: Request, path: str):
    """Convertico-style structure readout for a produced SVG (localhost only).

    Returns element-type counts, nesting-depth histogram, color inventory
    (fill/stroke/stop-color/lighting-color/color + inline styles) and a
    flag list for embedded images. Reads the file, returns derived stats only.
    """
    host = (request.headers.get("host") or "").rsplit(":", 1)[0].strip("[]").lower()
    if host not in _LOCAL_HOSTS:
        raise HTTPException(status_code=403, detail="forbidden")
    from ..operations.svg_analyze import analyze_svg_file

    target = Path(path).expanduser().resolve()
    if target.suffix.lower() != ".svg":
        raise HTTPException(status_code=404, detail="not an svg")
    if not target.is_file():
        raise HTTPException(status_code=404, detail="not found")
    try:
        return analyze_svg_file(target)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
