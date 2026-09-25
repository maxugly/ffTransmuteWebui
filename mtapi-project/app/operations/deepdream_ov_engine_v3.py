from __future__ import annotations

import os
import threading
from pathlib import Path
from typing import Any, Callable

import numpy as np

OV_BASE: tuple[int, int] = (512, 512)
OV_SCALE: float = 1.4
OV_MAX_OCTAVES: int = 4
OV_MODEL: str = "inception_v3"
OV_LAYER: str = "5b+5c+6a+6b+6c"
V3_LAYERS: tuple[str, ...] = ("5b", "5c", "6a", "6b", "6c")
V3_LAYER_LABELS: dict[str, str] = {
    "5b": "Mixed_5b",
    "5c": "Mixed_5c",
    "6a": "Mixed_6a",
    "6b": "Mixed_6b",
    "6c": "Mixed_6c",
}
V3_PRESETS: dict[str, dict[str, float]] = {
    "shallow": {"5b": 1.5, "5c": 0.5},
    "mid": {"5b": 1.0, "5c": 1.5, "6a": 1.0},
    "deep": {"5c": 1.0, "6a": 1.5, "6b": 1.5, "6c": 2.0},
    "classic": {"5b": 1.0, "5c": 1.5, "6a": 1.5, "6b": 1.5, "6c": 2.0},
    "full": {"5b": 1.5, "5c": 1.5, "6a": 2.0, "6b": 2.0, "6c": 2.5},
}

_DEV_FALLBACK = Path("/home/m/snc/cod/testLamaEraser/ovs_dd/artifacts")
_lock = threading.Lock()
_compiled: dict[str, Any] = {}


def artifacts_candidates() -> list[Path]:
    values = [
        os.environ.get("OVS_DD_V3_DIR", "").strip(),
        os.environ.get("OVS_DD_DIR", "").strip(),
    ]
    out: list[Path] = []
    for value in values:
        if value:
            path = Path(value).expanduser()
            if path not in out:
                out.append(path)
    default = Path(__file__).resolve().parent.parent.parent / "junk" / "models" / "deepdream_ov_v3"
    if default not in out:
        out.append(default)
    if _DEV_FALLBACK not in out:
        out.append(_DEV_FALLBACK)
    return out


def _ir_name(shape: tuple[int, int], kind: str = "ascent") -> str:
    suffix = "turbo_" if kind == "turbo" else ""
    return f"static_deepdream_v3_{suffix}{shape[0]}x{shape[1]}_fp16.xml"


def resolve_artifacts_dir(kind: str = "ascent") -> Path | None:
    for directory in artifacts_candidates():
        try:
            if (directory / _ir_name(OV_BASE, kind)).is_file():
                return directory
        except OSError:
            continue
    return None


def ir_present(kind: str = "ascent") -> bool:
    return resolve_artifacts_dir(kind) is not None


def available_shapes(kind: str = "ascent") -> list[tuple[int, int]]:
    directory = resolve_artifacts_dir(kind)
    if directory is None:
        return []
    return [
        shape
        for shape in octave_shapes(OV_MAX_OCTAVES)
        if (directory / _ir_name(shape, kind)).is_file()
    ]


def available_devices() -> list[str]:
    try:
        import openvino as ov

        return [str(device) for device in ov.Core().available_devices]
    except Exception:
        return []


def octave_shapes(num_octaves: int) -> list[tuple[int, int]]:
    count = int(num_octaves)
    if count < 1 or count > OV_MAX_OCTAVES:
        raise RuntimeError(
            f"GPU V3 dream supports 1–{OV_MAX_OCTAVES} octaves, got {num_octaves} "
            f"(shapes only exist for the {OV_BASE[0]}/{OV_SCALE} pyramid)."
        )
    height, width = OV_BASE
    return [
        (
            int(height / OV_SCALE ** (count - 1 - index)),
            int(width / OV_SCALE ** (count - 1 - index)),
        )
        for index in range(count)
    ]


def _legacy_mixed_weights(layer_weights: dict[str, float]) -> dict[str, float]:
    values = {str(key).lower(): float(value) for key, value in layer_weights.items()}
    mixed6 = max(0.0, values.get("mixed6", 0.0))
    return {
        "5b": max(0.0, values.get("mixed3", 0.0) * 0.5 + values.get("mixed4", 0.0)),
        "5c": max(0.0, values.get("mixed5", 0.0)),
        "6a": mixed6 * 0.5,
        "6b": mixed6 * 0.5,
        "6c": max(0.0, values.get("mixed7", 0.0) + mixed6 * 0.5),
    }


def resolve_v3_weights(
    layer_preset: str = "classic",
    layer_weights: dict[str, float] | None = None,
) -> dict[str, float]:
    source = {str(key): float(value) for key, value in (layer_weights or {}).items()}
    canonical = {
        str(key).lower().replace("mixed_", "").replace("mixed", ""): float(value)
        for key, value in source.items()
    }
    has_canonical = any(key in V3_LAYERS for key in canonical)
    if has_canonical:
        resolved = {key: max(0.0, canonical.get(key, 0.0)) for key in V3_LAYERS}
    else:
        resolved = _legacy_mixed_weights(source)
    if not any(value > 0 for value in resolved.values()):
        resolved = dict(V3_PRESETS.get(layer_preset, V3_PRESETS["classic"]))
    return {key: float(resolved.get(key, 0.0)) for key in V3_LAYERS}


def check_compatible(
    *,
    model_name: str = OV_MODEL,
    layer_weights: dict[str, float] | None = None,
    custom_layer_weights: dict[str, float] | None = None,
    layer_cycle: bool = False,
    guide_path: str | None = None,
    max_loss: float | None = 0.0,
    max_loss_to: float | None = None,
    preview_width: int | None = 0,
    optical_flow: bool = False,
    octave_scale: float = OV_SCALE,
    num_octave: int = 4,
    num_octave_to: float | None = None,
    octave_scale_to: float | None = None,
    turbo: bool = False,
    turbo_strength: float = 0.5,
) -> str:
    bad: list[str] = []
    if (model_name or OV_MODEL) != OV_MODEL:
        bad.append(f"model_name={model_name} (GPU V3 bakes {OV_MODEL} only)")
    if guide_path:
        bad.append("guide_path (GPU V3 has no guide input)")
    if (max_loss or 0) > 0 or (max_loss_to or 0) > 0:
        bad.append("max_loss (GPU V3 exposes no loss ceiling)")
    if (preview_width or 0) > 0:
        bad.append(f"preview_width={preview_width} (GPU V3 uses its fixed pyramid)")
    if optical_flow:
        bad.append("optical_flow (GPU V3 does not warp the host seed)")
    if abs(float(octave_scale) - OV_SCALE) > 1e-9:
        bad.append(f"octave_scale={octave_scale} (GPU V3 IRs use {OV_SCALE})")
    if int(num_octave) < 1 or int(num_octave) > OV_MAX_OCTAVES:
        bad.append(f"num_octave={num_octave} (GPU V3 supports 1–{OV_MAX_OCTAVES})")
    if num_octave_to is not None and (
        int(num_octave_to) < 1 or int(num_octave_to) > OV_MAX_OCTAVES
    ):
        bad.append(f"num_octave_to={num_octave_to} (GPU V3 supports 1–{OV_MAX_OCTAVES})")
    if octave_scale_to is not None and abs(float(octave_scale_to) - float(octave_scale)) > 1e-9:
        bad.append(
            f"octave_scale ramp {octave_scale}→{octave_scale_to} "
            "(GPU V3 IRs are scale-fixed)"
        )
    if not 0 <= float(turbo_strength) <= 1:
        bad.append("turbo_strength must be in [0, 1]")
    weights = custom_layer_weights or layer_weights
    if weights:
        keys = {str(key).lower() for key in weights}
        allowed = set(V3_LAYERS) | {
            "mixed3", "mixed4", "mixed5", "mixed6", "mixed7",
            "mixed_5b", "mixed_5c", "mixed_6a", "mixed_6b", "mixed_6c",
        }
        unknown = sorted(keys - allowed)
        if unknown:
            bad.append(f"layer weights unsupported by GPU V3: {', '.join(unknown)}")
    if bad:
        raise RuntimeError(
            "engine=gpu_v3 incompatible setting(s): "
            + "; ".join(bad)
            + ". Use engine=cpu for the full knob set."
        )
    mode = "Turbo forward-only" if turbo else "weighted gradient"
    _ = layer_cycle
    return f"GPU V3: {mode}, taps {','.join(V3_LAYER_LABELS[k] for k in V3_LAYERS)}"


def _get_compiled(
    shape: tuple[int, int],
    device: str,
    *,
    kind: str = "ascent",
    allow_fallback: bool = False,
) -> tuple[Any, str]:
    import openvino as ov

    wanted = (device or "GPU").upper()
    if wanted not in ("GPU", "CPU"):
        wanted = "GPU"
    candidates = [wanted]
    if allow_fallback and wanted == "GPU":
        candidates.append("CPU")
    available: list[str] = []
    try:
        available = [str(item) for item in ov.Core().available_devices]
    except Exception:
        pass
    last_error: Exception | None = None
    for settled in candidates:
        if available and settled not in available:
            last_error = RuntimeError(f"device {settled} not in {available}")
            continue
        key = f"{kind}:{shape[0]}x{shape[1]}@{settled}"
        with _lock:
            cached = _compiled.get(key)
        if cached is not None:
            return cached, settled
        directory = resolve_artifacts_dir(kind)
        if directory is None:
            last_error = RuntimeError(
                f"DeepDream V3 {kind} IR missing — export with tools/export_v3.py "
                "or set $OVS_DD_V3_DIR."
            )
            continue
        ir = directory / _ir_name(shape, kind)
        if not ir.is_file():
            last_error = RuntimeError(
                f"DeepDream V3 {kind} IR missing for {shape[0]}x{shape[1]}: {ir.name}"
            )
            continue
        try:
            model = ov.Core().read_model(str(ir))
            config = {}
            if settled == "GPU":
                config[ov.properties.hint.inference_precision] = ov.Type.f32
            compiled = ov.Core().compile_model(model, settled, config)
        except Exception as exc:
            last_error = exc
            continue
        with _lock:
            if len(_compiled) >= 12:
                _compiled.pop(next(iter(_compiled)))
            _compiled[key] = compiled
        return compiled, settled
    if len(candidates) == 1:
        raise RuntimeError(
            f"OpenVINO V3 {kind} failed on {wanted} (no CPU fallback): {last_error}"
        )
    raise RuntimeError(f"OpenVINO V3 compile failed on {candidates}: {last_error}")


def clear_cache() -> None:
    with _lock:
        _compiled.clear()


def _load_rgb(path: Path) -> np.ndarray:
    from PIL import Image

    with Image.open(path) as image:
        return np.asarray(image.convert("RGB"), dtype=np.uint8)


def _resize(array: np.ndarray, width: int, height: int) -> np.ndarray:
    import cv2

    if array.shape[1] == width and array.shape[0] == height:
        return array
    interpolation = cv2.INTER_AREA if width * height < array.shape[0] * array.shape[1] else cv2.INTER_LINEAR
    return cv2.resize(array, (width, height), interpolation=interpolation)


def _laplacian_detail(original: np.ndarray, dreamed: np.ndarray) -> np.ndarray:
    height, width = original.shape[:2]
    scale = min(1.0, 512.0 / max(height, width))
    small_h = max(1, int(round(height * scale)))
    small_w = max(1, int(round(width * scale)))
    low = _resize(_resize(original, small_w, small_h), width, height)
    return np.clip(dreamed + (original - low), 0.0, 1.0)


def _infer(
    compiled: Any,
    *,
    image_tensor: np.ndarray,
    learning_rate: float,
    weights: dict[str, float],
    kind: str,
) -> np.ndarray:
    import openvino as ov

    request = compiled.create_infer_request()
    tensors = {
        "image_tensor": ov.Tensor(
            np.ascontiguousarray(image_tensor, dtype=np.float32),
            shared_memory=True,
        )
    }
    if kind == "ascent":
        tensors["learning_rate"] = ov.Tensor(
            np.asarray([learning_rate], dtype=np.float32),
            shared_memory=True,
        )
    for name in V3_LAYERS:
        tensors[f"w_{name}"] = ov.Tensor(
            np.asarray([weights[name]], dtype=np.float32),
            shared_memory=True,
        )
    for name, tensor in tensors.items():
        request.set_tensor(name, tensor)
    request.infer()
    return np.array(request.get_output_tensor(0).data, copy=True)


def preload(*, device: str = "GPU", kind: str = "ascent", allow_fallback: bool = False) -> str:
    _, settled = _get_compiled(OV_BASE, device, kind=kind, allow_fallback=allow_fallback)
    return settled


def dream_array(
    content_rgb: np.ndarray,
    *,
    step: float = 0.01,
    iterations: int = 20,
    num_octave: int = 4,
    jitter: bool = True,
    reinject_detail: bool = True,
    layer_preset: str = "classic",
    layer_weights: dict[str, float] | None = None,
    turbo: bool = False,
    turbo_strength: float = 0.5,
    device: str = "GPU",
    allow_fallback: bool = False,
    progress_cb: Callable | None = None,
    evolve_dir: str | Path | None = None,
) -> tuple[np.ndarray, str]:
    from .. import job_control

    shapes = octave_shapes(num_octave)
    height0, width0 = content_rgb.shape[:2]
    base = content_rgb.astype(np.float32) / 255.0
    current = _resize(base, shapes[0][1], shapes[0][0])
    weights = resolve_v3_weights(layer_preset, layer_weights)
    kind = "turbo" if turbo else "ascent"
    iterations_count = 1 if turbo else max(1, int(iterations))
    total_steps = iterations_count * len(shapes)
    done = 0
    settled = (device or "GPU").upper()
    evolve_path = Path(evolve_dir) if evolve_dir is not None else None
    if evolve_path is not None:
        evolve_path.mkdir(parents=True, exist_ok=True)

    for octave_index, shape in enumerate(shapes):
        job_control.check_cancelled()
        octave_h, octave_w = shape
        current = _resize(current if reinject_detail else base, octave_w, octave_h)
        compiled, settled = _get_compiled(
            shape,
            device,
            kind=kind,
            allow_fallback=allow_fallback,
        )
        if octave_index == 0 and progress_cb:
            mode = "Turbo" if turbo else "ascent"
            progress_cb(
                f"dreaming (OV-V3/{settled}, {mode}, taps 5b+5c+6a+6b+6c)",
                phase="dream",
            )
        tensor = current.transpose(2, 0, 1)[np.newaxis, ...].astype(np.float32)
        for iteration in range(iterations_count):
            job_control.check_cancelled()
            dx = dy = 0
            if jitter:
                rng = np.random.default_rng()
                dx, dy = int(rng.integers(-16, 17)), int(rng.integers(-16, 17))
                tensor = np.roll(tensor, shift=(dy, dx), axis=(2, 3))
            try:
                output = _infer(
                    compiled,
                    image_tensor=tensor,
                    learning_rate=float(step),
                    weights=weights,
                    kind=kind,
                )
            except Exception as exc:
                raise RuntimeError(
                    f"OV V3 {kind} infer failed on {settled}: {exc}"
                ) from exc
            if turbo:
                saliency = output[0, 0]
                saliency = _resize(saliency[..., np.newaxis], octave_w, octave_h)[..., 0]
                amount = float(np.clip(turbo_strength, 0.0, 1.0))
                stamp = 0.5 + 0.5 * saliency
                tensor = np.clip(
                    (1.0 - amount) * tensor + amount * stamp[np.newaxis, np.newaxis, ...],
                    0.0,
                    1.0,
                )
            else:
                tensor = np.clip(output, 0.0, 1.0)
            if jitter and (dx or dy):
                tensor = np.roll(tensor, shift=(-dy, -dx), axis=(2, 3))
            done += 1
            if progress_cb and (done % 5 == 0 or done == total_steps):
                progress_cb(
                    f"dream octave {octave_index + 1}/{len(shapes)} step {iteration + 1}/{iterations_count} (OV-V3/{settled})",
                    phase="dream",
                    current=done,
                    total=total_steps,
                    unit="steps",
                )
        current = np.clip(tensor[0].transpose(1, 2, 0), 0.0, 1.0)
        if evolve_path is not None:
            from PIL import Image

            destination = evolve_path / f"frame_{octave_index:06d}.png"
            Image.fromarray((current * 255.0).astype(np.uint8), "RGB").save(destination)

    dreamed = _resize(current, width0, height0)
    if reinject_detail:
        dreamed = _laplacian_detail(base, dreamed)
    return (np.clip(dreamed, 0.0, 1.0) * 255.0).astype(np.uint8), settled


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
    layer_preset: str = "classic",
    layer_weights: dict[str, float] | None = None,
    turbo: bool = False,
    turbo_strength: float = 0.5,
    device: str = "GPU",
    allow_fallback: bool = False,
    progress_cb: Callable | None = None,
    evolve_dir: str | Path | None = None,
) -> dict[str, Any]:
    from .. import job_control
    from ..pathutil import finalize_output_path
    from PIL import Image

    image_exts = {".jpg", ".jpeg", ".png", ".bmp", ".tif", ".tiff", ".webp"}
    source = Path(content_path).expanduser().resolve()
    if not source.is_file():
        return {"ok": False, "error": f"content not found: {source}"}
    job_control.check_cancelled()
    if progress_cb:
        progress_cb("loading OV V3 deepdream model…", phase="load")
    try:
        content = _load_rgb(source)
        dreamed, settled = dream_array(
            content,
            step=step,
            iterations=iterations,
            num_octave=num_octave,
            jitter=jitter,
            reinject_detail=reinject_detail,
            layer_preset=layer_preset,
            layer_weights=layer_weights,
            turbo=turbo,
            turbo_strength=turbo_strength,
            device=device,
            allow_fallback=allow_fallback,
            progress_cb=progress_cb,
            evolve_dir=evolve_dir,
        )
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
    amount = float(np.clip(blend, 0.0, 1.0))
    if amount < 1.0 - 1e-6:
        dreamed = (
            dreamed.astype(np.float32) * amount
            + content.astype(np.float32) * (1.0 - amount)
        ).astype(np.uint8)
    destination = finalize_output_path(
        output_path,
        source=source,
        default_suffix="_dream_v3",
        default_ext=".png",
        allowed_exts=image_exts,
    )
    image = Image.fromarray(dreamed, "RGB")
    if destination.suffix.lower() in (".jpg", ".jpeg"):
        image.save(destination, quality=95)
    else:
        image.save(destination)
    if progress_cb:
        progress_cb(f"wrote {destination}", phase="done")
    return {
        "ok": True,
        "output_path": str(destination),
        "size": [int(dreamed.shape[1]), int(dreamed.shape[0])],
        "device_settled": settled,
        "engine": "openvino_v3",
        "ov_layer": OV_LAYER,
        "mode": "turbo" if turbo else "ascent",
    }
