"""
OpenVINO static DeepDream engine (GPU path for the DeepDream tab).

Port of the proven OVS-DD octave-pyramid runtime (``ovs_dd/run.py``):
Inception v3 with the gradient step baked into a static forward graph —
one fused inference call per ascent step, per-octave native-shape IRs.

IRs are single-shape AND single-layer (Inception v3, baked target layer —
default ``Mixed_6c`` per the OVS-DD build config). Supported pyramid is
therefore fixed: base 512, scale 1.4, up to 4 octaves → shapes
186 / 261 / 365 / 512. Anything else fails loudly (no silent fallback,
no silent downscale).

Only ``openvino`` + ``cv2`` + ``numpy`` are needed at runtime; the torch
export stack is NOT required.

Artifacts (``static_deepdream_<HxW>_fp16.xml``) resolve in this order:
  1. ``$OVS_DD_DIR``
  2. ``mtapi-project/junk/models/deepdream_ov/`` (installed via
     ``POST /ops/deepdream_ov_setup``)
  3. The dev-machine build at ``/home/m/snc/cod/testLamaEraser/ovs_dd/artifacts``

Device: ``"GPU"`` is strict — any GPU failure raises (no silent CPU
fallback; the tab's Engine dropdown must mean what it says). Pass
``allow_fallback=True`` only for diagnostics.
"""
from __future__ import annotations

import os
import threading
from pathlib import Path
from typing import Any, Callable

import numpy as np

OV_BASE: tuple[int, int] = (512, 512)
OV_SCALE: float = 1.4
OV_MAX_OCTAVES: int = 4
#: Baked ascent target of the shipped IRs (OVS-DD build default).
OV_LAYER: str = "Mixed_6c"
OV_MODEL: str = "inception_v3"

_DEV_FALLBACK = Path("/home/m/snc/cod/testLamaEraser/ovs_dd/artifacts")

_lock = threading.Lock()
_compiled: dict[str, Any] = {}


def artifacts_candidates() -> list[Path]:
    out: list[Path] = []
    env = os.environ.get("OVS_DD_DIR", "").strip()
    if env:
        out.append(Path(env).expanduser())
    out.append(
        Path(__file__).resolve().parent.parent.parent / "junk" / "models" / "deepdream_ov"
    )
    out.append(_DEV_FALLBACK)
    return out


def _ir_name(shape: tuple[int, int]) -> str:
    return f"static_deepdream_{shape[0]}x{shape[1]}_fp16.xml"


def resolve_artifacts_dir() -> Path | None:
    """First candidate dir holding the base-shape IR, else None."""
    for d in artifacts_candidates():
        try:
            if (d / _ir_name(OV_BASE)).is_file():
                return d
        except OSError:
            continue
    return None


def ir_present() -> bool:
    return resolve_artifacts_dir() is not None


def available_shapes() -> list[tuple[int, int]]:
    """Octave shapes with IR installed, ascending."""
    d = resolve_artifacts_dir()
    if d is None:
        return []
    out = []
    for shape in octave_shapes(OV_MAX_OCTAVES):
        if (d / _ir_name(shape)).is_file():
            out.append(shape)
    return out


def available_devices() -> list[str]:
    try:
        import openvino as ov

        return [str(x) for x in ov.Core().available_devices]
    except Exception:
        return []


def octave_shapes(num_octaves: int) -> list[tuple[int, int]]:
    """Ascending native working shapes for the fixed 512/1.4 pyramid."""
    n = int(num_octaves)
    if n < 1 or n > OV_MAX_OCTAVES:
        raise RuntimeError(
            f"GPU dream supports 1–{OV_MAX_OCTAVES} octaves, got {n} "
            f"(shapes only exist for the 512/1.4 pyramid)."
        )
    H, W = OV_BASE
    return [
        (int(H / OV_SCALE ** (n - 1 - i)), int(W / OV_SCALE ** (n - 1 - i)))
        for i in range(n)
    ]


def _get_compiled(
    shape: tuple[int, int], device: str, *, allow_fallback: bool = False
) -> tuple[Any, str]:
    """Compile (or hit cache) the IR for one octave shape. Strict by default.

    GPU compiles force ``hint.inference_precision=f32``: with the default
    fp16 GPU path the 365/512 octave IRs return pure zeros (186/261 are
    unaffected) while CPU is correct — same iGPU fp16-accumulation family as
    the LaMA spectral-MatMul corruption fixed by the same hint in
    ``filters.erase.get_compiled``.
    """
    import openvino as ov

    want = (device or "GPU").upper()
    if want not in ("GPU", "CPU"):
        want = "GPU"
    candidates = [want]
    if allow_fallback and want == "GPU":
        candidates.append("CPU")
    available = []
    try:
        available = [str(x) for x in ov.Core().available_devices]
    except Exception:
        pass
    last_err: Exception | None = None
    for dev in candidates:
        if available and dev not in available:
            last_err = RuntimeError(f"device {dev} not in {available}")
            continue
        key = f"{shape[0]}x{shape[1]}@{dev}"
        with _lock:
            hit = _compiled.get(key)
        if hit is not None:
            return hit, dev
        d = resolve_artifacts_dir()
        if d is None:
            last_err = RuntimeError(
                "OVS-DD IR missing — install via POST /ops/deepdream_ov_setup "
                "(or set $OVS_DD_DIR)."
            )
            continue
        ir = d / _ir_name(shape)
        if not ir.is_file():
            last_err = RuntimeError(
                f"OVS-DD IR missing for octave shape {shape[0]}x{shape[1]} "
                f"(need {ir.name} — GPU dream only supports the 512/1.4 pyramid)."
            )
            continue
        try:
            model = ov.Core().read_model(str(ir))
            cfg = ({ov.properties.hint.inference_precision: ov.Type.f32}
                   if dev == "GPU" else {})
            compiled = ov.Core().compile_model(model, dev, cfg)
        except Exception as e:  # noqa: BLE001 — strict raise below, fallback only if asked
            last_err = e
            continue
        with _lock:
            if len(_compiled) >= 8:
                _compiled.pop(next(iter(_compiled)))
            _compiled[key] = compiled
        return compiled, dev
    if len(candidates) == 1:
        raise RuntimeError(f"OpenVINO GPU failed (no CPU fallback — engine=gpu): {last_err}")
    raise RuntimeError(f"OpenVINO compile failed on {candidates}: {last_err}")


def clear_cache() -> None:
    with _lock:
        _compiled.clear()


def check_compatible(
    *,
    model_name: str = "inception_v3",
    custom_layer_weights: dict | None = None,
    layer_cycle: bool = False,
    guide_path: str | None = None,
    max_loss: float | None = 0.0,
    max_loss_to: float | None = None,
    preview_width: int | None = 0,
    optical_flow: bool = False,
    octave_scale: float = 1.4,
    num_octave: int = 4,
    num_octave_to: float | None = None,
    octave_scale_to: float | None = None,
) -> str:
    """Fail loudly on GPU-incompatible settings. Returns the baked-layer warning.

    Layer *presets* are accepted but do not apply (single baked ascent
    target) — the caller must surface the returned warning in stdout.
    """
    bad: list[str] = []
    if (model_name or "inception_v3") != "inception_v3":
        bad.append(f"model_name={model_name} (GPU bakes {OV_MODEL} only)")
    if custom_layer_weights:
        bad.append(
            "custom_layer_weights (GPU bakes InceptionV3/Mixed_6c only — "
            "switch Layers to a built-in preset; note the ascent target stays Mixed_6c)"
        )
    if layer_cycle:
        bad.append("layer_cycle (GPU bakes a single layer)")
    if guide_path:
        bad.append("guide_path (guided dreaming is CPU-only)")
    if (max_loss or 0) > 0 or (max_loss_to or 0) > 0:
        bad.append(
            f"max_loss={max_loss}→{max_loss_to} (the OV graph exposes no loss ceiling)"
        )
    if (preview_width or 0) > 0:
        bad.append(f"preview_width={preview_width} (GPU dreams the full frame)")
    if optical_flow:
        bad.append("optical_flow (CPU-only seed warping)")
    if abs(float(octave_scale) - OV_SCALE) > 1e-9:
        bad.append(f"octave_scale={octave_scale} (GPU IRs exist only for scale {OV_SCALE})")
    if int(num_octave) > OV_MAX_OCTAVES:
        bad.append(f"num_octave={num_octave} (GPU IRs exist only for ≤{OV_MAX_OCTAVES})")
    # Shape-changing ramps: only reject ramps that ACTUALLY change the shape.
    # Dynamic mode always sends *_to endpoints — equal endpoints are a harmless
    # constant, not a ramp.
    if num_octave_to is not None and abs(float(num_octave_to) - float(num_octave)) > 1e-9:
        bad.append(
            f"num_octave ramp {num_octave}→{num_octave_to} "
            "(GPU IRs are shape-fixed — turn Dynamic off or match start=end)"
        )
    if octave_scale_to is not None and abs(float(octave_scale_to) - float(octave_scale)) > 1e-9:
        bad.append(
            f"octave_scale ramp {octave_scale}→{octave_scale_to} "
            "(GPU IRs are shape-fixed — turn Dynamic off or match start=end)"
        )
    if bad:
        raise RuntimeError(
            "engine=gpu incompatible setting(s): " + "; ".join(bad)
            + ". Use engine=cpu for the full knob set."
        )
    return (
        f"GPU: ascent target is baked {OV_MODEL}/{OV_LAYER} — "
        "layer presets do not apply (CPU-only)"
    )


def _load_rgb(path: Path) -> np.ndarray:
    """File → uint8 RGB HWC."""
    from PIL import Image

    with Image.open(path) as im:
        return np.asarray(im.convert("RGB"), dtype=np.uint8)


def _resize(arr: np.ndarray, w: int, h: int) -> np.ndarray:
    import cv2

    if arr.shape[1] == w and arr.shape[0] == h:
        return arr
    interp = cv2.INTER_AREA if (w * h < arr.shape[0] * arr.shape[1]) else cv2.INTER_LINEAR
    return cv2.resize(arr, (w, h), interpolation=interp)


def preload(*, device: str = "GPU", allow_fallback: bool = False) -> str:
    """Compile the base-shape IR so the first real run is warm."""
    _, settled = _get_compiled(OV_BASE, device, allow_fallback=allow_fallback)
    return settled


def dream_array(
    content_rgb: np.ndarray,
    *,
    step: float = 0.01,
    iterations: int = 20,
    num_octave: int = 4,
    jitter: bool = True,
    reinject_detail: bool = True,
    device: str = "GPU",
    allow_fallback: bool = False,
    progress_cb: Callable | None = None,
    evolve_dir: str | Path | None = None,
) -> tuple[np.ndarray, str]:
    """Dream one uint8 RGB HWC array → (uint8 RGB HWC at the SAME size, settled device).

    Pyramid runs at native octave shapes; the result is resized back to the
    input dims at the end (same contract as the OV style-transfer engine).
    """
    from .. import job_control

    shapes = octave_shapes(num_octave)  # validates range; IR presence per shape below
    h0, w0 = content_rgb.shape[:2]
    base = (content_rgb.astype(np.float32) / 255.0).copy()
    current = _resize(base, shapes[0][1], shapes[0][0])
    settled = (device or "GPU").upper()
    lr = np.array([float(step)], dtype=np.float32)
    n_iter = max(1, int(iterations))
    total_steps = n_iter * len(shapes)
    done = 0

    evolve_paths: list[str] = []
    if evolve_dir is not None:
        evolve_path = Path(evolve_dir)
        evolve_path.mkdir(parents=True, exist_ok=True)

    for oi, shape in enumerate(shapes):
        job_control.check_cancelled()
        oh, ow = shape
        if reinject_detail:
            current = _resize(current, ow, oh)
        else:
            current = _resize(base, ow, oh)
        compiled, settled = _get_compiled(shape, device, allow_fallback=allow_fallback)
        if oi == 0 and progress_cb:
            progress_cb(f"dreaming (OV/{settled}, {OV_MODEL}/{OV_LAYER})", phase="dream")
        tensor = current.transpose(2, 0, 1)[np.newaxis, ...].astype(np.float32).copy()
        for it in range(n_iter):
            job_control.check_cancelled()
            dx = dy = 0
            if jitter:
                rng = np.random.default_rng()
                dx, dy = int(rng.integers(-16, 17)), int(rng.integers(-16, 17))
                tensor = np.roll(tensor, shift=(dy, dx), axis=(2, 3))
            try:
                tensor = compiled({"image_tensor": tensor, "learning_rate": lr})[0]
            except Exception as e:  # noqa: BLE001 — loud, never silent
                raise RuntimeError(f"OV dream infer failed on {settled}: {e}") from e
            if jitter and (dx or dy):
                tensor = np.roll(tensor, shift=(-dy, -dx), axis=(2, 3))
            done += 1
            if progress_cb and (done % 5 == 0 or done == total_steps):
                progress_cb(
                    f"dream octave {oi + 1}/{len(shapes)} step {it + 1}/{n_iter} (OV/{settled})",
                    phase="dream",
                    current=done,
                    total=total_steps,
                    unit="steps",
                )
        current = np.clip(tensor[0].transpose(1, 2, 0), 0.0, 1.0)
        if evolve_dir is not None:
            from PIL import Image

            dest = evolve_path / f"frame_{oi:06d}.png"
            Image.fromarray((current * 255.0).astype(np.uint8), "RGB").save(dest)
            evolve_paths.append(str(dest))

    return _resize((np.clip(current, 0.0, 1.0) * 255.0).astype(np.uint8), w0, h0), settled


def dream_pair(
    content_path: str | Path,
    output_path: str | Path,
    *,
    step: float = 0.01,
    iterations: int = 20,
    num_octave: int = 4,
    jitter: bool = True,
    reinject_detail: bool = True,
    blend: float = 1.0,
    device: str = "GPU",
    allow_fallback: bool = False,
    progress_cb: Callable | None = None,
    evolve_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Dream one image file. Result-dict shape mirrors the TF engine's outputs."""
    from .. import job_control
    from ..pathutil import finalize_output_path
    from PIL import Image

    IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".tif", ".tiff", ".webp"}

    content_p = Path(content_path).expanduser().resolve()
    if not content_p.is_file():
        return {"ok": False, "error": f"content not found: {content_p}"}
    blend_f = float(np.clip(blend, 0.0, 1.0))

    job_control.check_cancelled()
    if progress_cb:
        progress_cb("loading OV deepdream model…", phase="load")
    try:
        content = _load_rgb(content_p)
        job_control.check_cancelled()
        dreamed, settled = dream_array(
            content,
            step=step,
            iterations=iterations,
            num_octave=num_octave,
            jitter=jitter,
            reinject_detail=reinject_detail,
            device=device,
            allow_fallback=allow_fallback,
            progress_cb=progress_cb,
            evolve_dir=evolve_dir,
        )
    except Exception as e:  # noqa: BLE001 — HTTP 200 + ok:false downstream
        return {"ok": False, "error": str(e)}
    job_control.check_cancelled()

    if blend_f < 1.0 - 1e-6:
        dreamed = (
            dreamed.astype(np.float32) * blend_f
            + content.astype(np.float32) * (1.0 - blend_f)
        ).astype(np.uint8)

    out_path = finalize_output_path(
        output_path,
        source=content_p,
        default_suffix="_dream",
        default_ext=".png",
        allowed_exts=IMAGE_EXTS,
    )
    img = Image.fromarray(dreamed, "RGB")
    ext = out_path.suffix.lower()
    if ext in (".jpg", ".jpeg"):
        img.save(out_path, quality=95)
    else:
        img.save(out_path)
    if progress_cb:
        progress_cb(f"wrote {out_path}", phase="done")
    return {
        "ok": True,
        "output_path": str(out_path),
        "size": [int(dreamed.shape[1]), int(dreamed.shape[0])],
        "device_settled": settled,
        "engine": "openvino",
        "ov_layer": OV_LAYER,
    }
