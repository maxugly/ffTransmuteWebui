"""Vectorize operations — async orchestrator + engine runners.

Every engine runs through app.shell.run_command (argv lists only — never
shell=True, invariant 2). Each enabled engine runs concurrently; a failing
engine is captured and reported without stopping the others (spec §3).
"""
import asyncio
import json
import math
import time
from pathlib import Path

_ENGINE_DIR = Path(__file__).resolve().parent.parent / "filters" / "vectorize_engines"


def load_manifest(engine_id: str) -> dict:
    return json.loads((_ENGINE_DIR / f"{engine_id}.json").read_text())


def _float(opts: dict, key: str, default: float) -> float:
    try:
        v = opts.get(key, default)
        return float(v)
    except (TypeError, ValueError):
        return default


def _int(opts: dict, key: str, default: int) -> int:
    try:
        v = opts.get(key, default)
        return int(float(v))
    except (TypeError, ValueError):
        return default


def _bool(opts: dict, key: str, default: bool) -> bool:
    v = opts.get(key, default)
    if isinstance(v, str):
        return v.strip().lower() in ("1", "true", "yes", "on")
    return bool(v)


def _vtracer_preset(preset: str) -> dict:
    """Map a named preset onto concrete vtracer kwargs (spec §2 presets)."""
    presets = {
        "bw": {"colormode": "binary", "filter_speckle": 8, "color_precision": 2,
               "layer_difference": 64, "path_precision": 6},
        "poster": {"colormode": "color", "hierarchical": "stacked", "filter_speckle": 6,
                   "color_precision": 5, "layer_difference": 32, "path_precision": 7},
        "photo": {"colormode": "color", "hierarchical": "stacked", "filter_speckle": 4,
                  "color_precision": 6, "layer_difference": 16, "path_precision": 8},
    }
    return dict(presets.get(preset, presets["photo"]))


async def run_vtracer(input_path: str, opts: dict, out_path: str) -> dict:
    """Raster -> SVG via the in-process vtracer Rust library (spec §2 engine 1).

    Uses vtracer.convert_image_to_svg_py rather than a CLI subprocess; the
    CPU-bound Rust trace runs in a worker thread so the event loop stays free.
    """
    try:
        import vtracer  # noqa: F401 — fail fast if missing
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"vtracer python module unavailable: {e}"}

    def _call() -> None:
        import vtracer
        kwargs = _vtracer_preset(str(opts.get("preset", "photo")))
        # Explicit user options override the preset.
        if opts.get("color_count") is not None:
            # color_precision is a 1..8 power-of-two exponent; map 2..64 colors onto it.
            colors = max(2, _int(opts, "color_count", 16))
            kwargs["color_precision"] = max(1, min(8, int(round(math.log2(colors)))))
        if opts.get("layering") is not None:
            kwargs["hierarchical"] = "cutout" if _int(opts, "layering", 3) <= 1 else "stacked"
        if opts.get("corner_threshold") is not None:
            kwargs["corner_threshold"] = max(1, int(round(_float(opts, "corner_threshold", 0.6) * 100)))
        if opts.get("path_precision") is not None:
            kwargs["path_precision"] = max(1, int(round(_float(opts, "path_precision", 0.9) * 10)))
        if opts.get("speckles_filter") is not None:
            kwargs["filter_speckle"] = max(1, int(round(_float(opts, "speckles_filter", 0.5) * 10)))
        if opts.get("max_iterations") is not None:
            kwargs["max_iterations"] = max(1, _int(opts, "max_iterations", 10))
        if _bool(opts, "skip_black_white", True) and kwargs.get("colormode") == "color":
            kwargs["mode"] = "spline"
        vtracer.convert_image_to_svg_py(input_path, out_path, **kwargs)

    start = time.time()
    try:
        await asyncio.to_thread(_call)
    except Exception as e:  # noqa: BLE001 — engine isolation
        return {"ok": False, "error": str(e)}
    elapsed = time.time() - start
    size = Path(out_path).stat().st_size if Path(out_path).exists() else 0
    if size == 0:
        return {"ok": False, "error": "vtracer produced an empty SVG"}
    return {"ok": True, "elapsed_s": round(elapsed, 2), "bytes": size}


async def run_inkscape(input_path: str, opts: dict, out_path: str) -> dict:
    """Raster -> SVG via Inkscape's tracing CLI."""
    from app.shell import run_command
    try:
        import shutil
        binary = shutil.which("inkscape") or "/home/m/.local/bin/inkscape"
        if not Path(binary).exists() and not shutil.which(binary):
            return {"ok": False, "error": "inkscape binary not found (install inkscape)"}
        mode = str(opts.get("trace_mode", "brightness-cutoff"))
        colors = _int(opts, "colors", 8)
        smooth = _bool(opts, "smooth", True)
        speckles = _int(opts, "speckles", 2)
        threshold = _float(opts, "threshold", 0.5)
        argv = [
            binary, input_path,
            "--export-type=svg",
            f"--export-filename={out_path}",
        ]
        # Inkscape 1.x tracing options (--tracer-engine / -t flags).
        if mode == "color-quant":
            argv += ["--tracer-engine=sioxf", "--colors", str(colors)]
        elif mode == "edge-detection":
            argv += ["--tracer-engine= potrace".strip()]
        else:  # brightness-cutoff
            argv += ["--tracer-engine=autotrace", "--brightness-threshold", str(threshold)]
        if smooth:
            argv.append("--smoothing")
        if speckles > 0:
            argv += ["--min-removal", str(speckles)]
        start = time.time()
        rc, out, err = await run_command(argv)
        elapsed = time.time() - start
        if rc != 0:
            return {"ok": False, "error": err.strip() or out.strip() or f"inkscape exit {rc}"}
        size = Path(out_path).stat().st_size if Path(out_path).exists() else 0
        return {"ok": True, "elapsed_s": round(elapsed, 2), "bytes": size, "log": (out + err).strip()}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}


async def run_neural(input_path: str, opts: dict, out_path: str) -> dict:
    """Neural / DiffVG loop — GPU-gated, lazy torch import (spec §3, §10)."""
    try:
        import torch
        if not torch.cuda.is_available():
            return {"ok": False, "error": "GPU not detected — neural disabled"}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"torch unavailable: {e}"}
    # DiffVG differentiable loop is out of scope for this pass (placeholder).
    return {"ok": False, "error": "neural DiffVG loop not yet implemented"}


_RUNNERS = {
    "vtracer": run_vtracer,
    "inkscape": run_inkscape,
    "neural": run_neural,
}


async def orchestrate(enabled_ids: list[str], options: dict, input_path: str,
                      out_paths: dict[str, str]) -> list[dict]:
    """Run every enabled engine concurrently; never let one failure stop the rest.

    `out_paths` maps engine_id -> absolute output SVG path (resolved by the
    caller via pathutil.finalize_output_path — global out dir, never-overwrite).
    """
    async def _one(engine_id: str) -> dict:
        runner = _RUNNERS.get(engine_id)
        if not runner:
            return {"engine_id": engine_id, "ok": False, "error": f"unknown engine '{engine_id}'"}
        opts = options.get(engine_id, {}) if isinstance(options, dict) else {}
        out_path = out_paths.get(engine_id)
        if not out_path:
            return {"engine_id": engine_id, "ok": False, "error": "no output path resolved"}
        Path(out_path).parent.mkdir(parents=True, exist_ok=True)
        res = await runner(input_path, opts, out_path)
        res["engine_id"] = engine_id
        res["svg_path"] = out_path if res.get("ok") else None
        return res

    return list(await asyncio.gather(*(_one(e) for e in enabled_ids)))
