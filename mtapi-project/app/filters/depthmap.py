import asyncio
import threading
import urllib.request
from functools import wraps
from pathlib import Path
from typing import Dict, Any, Literal

import cv2
import numpy as np

from app.job_control import report_progress, check_cancelled

_depth_model_cache: dict[str, str] = {}
_runtime_model_cache: dict[str, object] = {}

_runtime_lock = threading.RLock()


def _serialized(fn):
    @wraps(fn)
    def run(*args, **kwargs):
        with _runtime_lock:
            return fn(*args, **kwargs)
    return run


def _depth_weights_dir() -> Path:
    return (
        Path(__file__).resolve().parent.parent.parent
        / "junk" / "models" / "depth-anything-v2"
    )


class DepthEstimatorPredictor:
    def __init__(self, compiled_model, model_id: str, model_path: str):
        self.compiled_model = compiled_model
        self.model_id = model_id
        self.model_path = model_path
        self.predictor = None  # None until first inference for lazy load tracking

    def __call__(self, image: np.ndarray, input_size: int = 518, colormap: str = "grayscale", invert: bool = False, **kwargs) -> np.ndarray:
        self.predictor = object()
        if image is None:
            return np.zeros((100, 100, 3), dtype=np.uint8)

        h, w = image.shape[:2]

        # Aspect-aware resize constrained to multiples of 14
        scale = float(input_size) / max(h, w)
        new_h = max(14, int(round(h * scale / 14.0)) * 14)
        new_w = max(14, int(round(w * scale / 14.0)) * 14)

        rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        resized = cv2.resize(rgb, (new_w, new_h), interpolation=cv2.INTER_CUBIC)

        # ImageNet normalization: (x - mean) / std
        mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
        std = np.array([0.229, 0.224, 0.225], dtype=np.float32)
        norm = (resized.astype(np.float32) / 255.0 - mean) / std
        tensor = np.transpose(norm[None, ...].astype(np.float32), (0, 3, 1, 2))

        res = self.compiled_model([tensor])
        raw_depth = res[0].squeeze()

        # Scale back to full resolution
        depth_full = cv2.resize(raw_depth, (w, h), interpolation=cv2.INTER_CUBIC)

        d_min, d_max = float(depth_full.min()), float(depth_full.max())
        if d_max > d_min:
            depth_uint8 = ((depth_full - d_min) / (d_max - d_min) * 255.0).astype(np.uint8)
        else:
            depth_uint8 = np.zeros((h, w), dtype=np.uint8)

        if invert:
            depth_uint8 = 255 - depth_uint8

        # Color mapping
        cmap = str(colormap).lower()
        if cmap == "inferno":
            return cv2.applyColorMap(depth_uint8, cv2.COLORMAP_INFERNO)
        elif cmap == "magma":
            return cv2.applyColorMap(depth_uint8, cv2.COLORMAP_MAGMA)
        elif cmap == "plasma":
            return cv2.applyColorMap(depth_uint8, cv2.COLORMAP_PLASMA)
        elif cmap == "viridis":
            return cv2.applyColorMap(depth_uint8, cv2.COLORMAP_VIRIDIS)
        else:
            return cv2.cvtColor(depth_uint8, cv2.COLOR_GRAY2BGR)


@_serialized
def ensure_depth_model(model_id: str = "depth-anything-v2-small", device: str = "CPU") -> str:
    cache_key = f"{model_id}:{device}"
    if cache_key in _depth_model_cache:
        cached = _depth_model_cache[cache_key]
        if Path(cached).exists():
            return cached
        del _depth_model_cache[cache_key]

    wdir = _depth_weights_dir()
    wdir.mkdir(parents=True, exist_ok=True)
    xml_path = wdir / "depth_anything_v2_s_int8.xml"
    bin_path = wdir / "depth_anything_v2_s_int8.bin"
    onnx_path = wdir / "model_int8.onnx"

    if xml_path.is_file() and bin_path.is_file():
        _depth_model_cache[cache_key] = str(xml_path)
        return str(xml_path)

    from app import model_hot
    model_key = model_hot.start_loading('depthmap', model_id, [str(xml_path)])
    try:
        if not onnx_path.is_file():
            print(f"[depthmap] downloading {onnx_path.name}...")
            url = "https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx/model_int8.onnx"
            urllib.request.urlretrieve(url, str(onnx_path))

        import openvino as ov
        core = ov.Core()
        model = core.read_model(str(onnx_path))
        ov.save_model(model, str(xml_path))
        model_hot.loaded(model_key)
    finally:
        model_hot.forget(model_key)

    _depth_model_cache[cache_key] = str(xml_path)
    return str(xml_path)


@_serialized
def get_runtime_model(model_path: str, *, keep_warm: bool = False, model_id: str = "depth-anything-v2-small", device: str = "CPU"):
    from app import model_hot
    keep_warm = keep_warm or model_hot.enabled('depthmap')
    cache_key = f"{model_id}:{model_path}:{device}"
    if keep_warm and cache_key in _runtime_model_cache:
        return _runtime_model_cache[cache_key]

    import openvino as ov
    core = ov.Core()
    target_device = device or "CPU"
    if target_device.startswith("intel:"):
        target_device = target_device.split(":", 1)[1].upper()
    if target_device not in core.available_devices:
        target_device = "CPU"

    compiled = core.compile_model(model_path, target_device)
    model = DepthEstimatorPredictor(compiled, model_id, model_path)

    if keep_warm:
        _runtime_model_cache[cache_key] = model
    return model


@_serialized
def predict_depth_runtime(model, image, *, model_id, model_path, **kwargs):
    from app import model_hot
    predictor = getattr(model, 'predictor', None)
    if predictor is None or getattr(predictor, 'model', True) is None:
        with model_hot.loading('depthmap', model_id, [model_path]):
            return model(image, **kwargs)
    return model(image, **kwargs)


async def make_depthmap_directory(
    device: str = "CPU",
    input_size: int = 518,
    colormap: str = "grayscale",
    invert: bool = False,
    model_id: str = "depth-anything-v2-small",
    keep_model_warm: bool = False,
    **kwargs,
):
    ov_model_path = await asyncio.to_thread(ensure_depth_model, model_id=model_id, device=device)
    model = await asyncio.to_thread(get_runtime_model, ov_model_path, keep_warm=keep_model_warm, model_id=model_id, device=device)
    print(f"[depthmap] using {model_id} on {device}")

    async def depthmap_directory(src_dir: Path, dst_dir: Path) -> dict:
        frames = sorted(list(src_dir.glob("frame_*.png")))
        total = len(frames)

        for idx, frame_path in enumerate(frames):
            check_cancelled()

            img = cv2.imread(str(frame_path))
            if img is None:
                continue

            ov_device = device
            if ov_device and not ov_device.lower().startswith("intel:") and ov_device.upper() != "CPU":
                ov_device = f"intel:{ov_device.lower()}"

            out_depth = await asyncio.to_thread(
                predict_depth_runtime, model, img,
                model_id=model_id, model_path=ov_model_path, device=ov_device,
                input_size=input_size, colormap=colormap, invert=invert,
            )

            out_path = dst_dir / frame_path.name
            cv2.imwrite(str(out_path), out_depth)

            report_progress(
                f"depthmap {idx + 1}/{total}",
                phase="depthmap",
                current=idx + 1,
                total=total,
                unit="frames",
                latest_frame=str(dst_dir / frame_path.name),
            )

        return {"frame_count_in": total, "frame_count_out": total}

    depthmap_directory.kind = "directory"
    return depthmap_directory


from . import register_stage
register_stage('depthmap', make_depthmap_directory)
