"""
OpenVINO static DeepDream engine V2 (GPU path for the DeepDream tab).

V2 Optimizations applied:
1. Selective FP16: Only forces FP32 on large octaves (365, 512) to avoid
   Intel iGPU spectral-MatMul corruption. Smaller octaves (186, 261) run
   in native FP16 for massive XMX hardware throughput gains.
2. Zero-Copy Inference: Utilizes persistent InferRequests and shared memory
   tensors to bypass CPU-to-GPU memory copies during the ascent loop.
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
            cfg = {}
            if dev == "GPU":
                # V2 OPTIMIZATION: Selective FP16 Execution
                # 365 and 512 suffer from the driver bug, force them to FP32.
                # 186 and 261 are unaffected, allow them to default to FP16 for XMX acceleration.
                if shape[0] >= 365:
                    cfg[ov.properties.hint.inference_precision] = ov.Type.f32
            
            compiled = ov.Core().compile_model(model, dev, cfg)
        except Exception as e:
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
    bad: list[str] = []
    if (model_name or "inception_v3") != "inception_v3":
        bad.append(f"model_name={model_name} (GPU bakes {OV_MODEL} only)")
    if custom_layer_weights:
        bad.append("custom_layer_weights (GPU bakes InceptionV3/Mixed_6c only)")
    if layer_cycle:
        bad.append("layer_cycle (GPU bakes a single layer)")
    if guide_path:
        bad.append("guide_path (guided dreaming is CPU-only)")
    if (max_loss or 0) > 0 or (max_loss_to or 0) > 0:
        bad.append("max_loss (the OV graph exposes no loss ceiling)")
    if (preview_width or 0) > 0:
        bad.append(f"preview_width={preview_width} (GPU dreams the full frame)")
    if optical_flow:
        bad.append("optical_flow (CPU-only seed warping)")
    if abs(float(octave_scale) - OV_SCALE) > 1e-9:
        bad.append(f"octave_scale={octave_scale} (GPU IRs exist only for scale {OV_SCALE})")
    if int(num_octave) > OV_MAX_OCTAVES:
        bad.append(f"num_octave={num_octave} (GPU IRs exist only for ≤{OV_MAX_OCTAVES})")
    if num_octave_to is not None and abs(float(num_octave_to) - float(num_octave)) > 1e-9:
        bad.append("num_octave ramp (GPU IRs are shape-fixed)")
    if octave_scale_to is not None and abs(float(octave_scale_to) - float(octave_scale)) > 1e-9:
        bad.append("octave_scale ramp (GPU IRs are shape-fixed)")
    if bad:
        raise RuntimeError(
            "engine=gpu incompatible setting(s): " + "; ".join(bad)
            + ". Use engine=cpu for the full knob set."
        )
    return f"GPU V2: ascent target is baked {OV_MODEL}/{OV_LAYER}"


def _load_rgb(path: Path) -> np.ndarray:
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
    from .. import job_control
    import openvino as ov

    shapes = octave_shapes(num_octave)
    h0, w0 = content_rgb.shape[:2]
    base = (content_rgb.astype(np.float32) / 255.0).copy()
    current = _resize(base, shapes[0][1], shapes[0][0])
    settled = (device or "GPU").upper()
    
    # V2 OPTIMIZATION: Prepare contiguous learning rate buffer for zero-copy
    lr = np.array([float(step)], dtype=np.float32)
    lr_tensor = ov.Tensor(lr, shared_memory=True)
    
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
        
        # V2 OPTIMIZATION: Create persistent InferRequest for the octave
        req = compiled.create_infer_request()
        req.set_tensor("learning_rate", lr_tensor)
        
        if oi == 0 and progress_cb:
            progress_cb(f"dreaming (OV-V2/{settled}, {OV_MODEL}/{OV_LAYER})", phase="dream")
            
        tensor = current.transpose(2, 0, 1)[np.newaxis, ...].astype(np.float32).copy()
        
        for it in range(n_iter):
            job_control.check_cancelled()
            dx = dy = 0
            if jitter:
                rng = np.random.default_rng()
                dx, dy = int(rng.integers(-16, 17)), int(rng.integers(-16, 17))
                tensor = np.roll(tensor, shift=(dy, dx), axis=(2, 3))
            
            try:
                # V2 OPTIMIZATION: Bind numpy array directly to the GPU via shared memory
                in_tensor = ov.Tensor(np.ascontiguousarray(tensor), shared_memory=True)
                req.set_tensor("image_tensor", in_tensor)
                req.infer()
                # Retrieve view of output buffer
                tensor = req.get_output_tensor(0).data
                tensor = np.clip(tensor, 0.0, 1.0)
            except Exception as e:
                raise RuntimeError(f"OV V2 dream infer failed on {settled}: {e}") from e
                
            if jitter and (dx or dy):
                tensor = np.roll(tensor, shift=(-dy, -dx), axis=(2, 3))
                
            done += 1
            if progress_cb and (done % 5 == 0 or done == total_steps):
                progress_cb(
                    f"dream octave {oi + 1}/{len(shapes)} step {it + 1}/{n_iter} (OV-V2/{settled})",
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
        progress_cb("loading OV V2 deepdream model…", phase="load")
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
    except Exception as e:
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
        default_suffix="_dream_v2",
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
        "engine": "openvino_v2",
        "ov_layer": OV_LAYER,
    }