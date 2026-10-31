import asyncio
import threading
import urllib.request
from functools import wraps
import cv2
import numpy as np
from pathlib import Path
from typing import Dict, Any

from app.job_control import report_progress, check_cancelled

_openvino_model_cache: dict[str, str] = {}
_runtime_model_cache: dict[str, object] = {}

_runtime_lock = threading.RLock()


def _serialized(fn):
    @wraps(fn)
    def run(*args, **kwargs):
        with _runtime_lock:
            return fn(*args, **kwargs)
    return run


MODEL_REGISTRY = {
    "yoloe-26n-seg": "yoloe-26n-seg.pt",
    "yoloe-26n": "yoloe-26n-seg.pt",
    "efficient-sam-vitt": "efficient_sam_vitt",
    "efficient-sam-vits": "efficient_sam_vits",
    "EfficientSAM-ti": "efficient_sam_vitt",
    "EfficientSAM-s": "efficient_sam_vits",
    "FastSAM-s": "FastSAM-s.pt",
    "FastSAM-x": "FastSAM-x.pt",
}


def is_yoloe(model_id: str) -> bool:
    mid = str(model_id).lower()
    return "yoloe" in mid


def is_efficient_sam(model_id: str) -> bool:
    mid = str(model_id).lower()
    return "efficient" in mid or "esam" in mid


def _resolve_model_id(model_id: str) -> str:
    return MODEL_REGISTRY.get(model_id, model_id)


def _yoloe_weights_dir() -> Path:
    return (
        Path(__file__).resolve().parent.parent.parent
        / "junk" / "models" / "yoloe"
    )


def _efficient_sam_weights_dir() -> Path:
    return (
        Path(__file__).resolve().parent.parent.parent
        / "junk" / "models" / "efficient-sam"
    )


class EfficientSAMResult:
    def __init__(self, mask, everything_masks=None):
        self.mask = mask
        self.everything_masks = everything_masks
        self.masks = self


class EfficientSAMPredictor:
    def __init__(self, compiled_model, model_id: str, model_path: str):
        self.compiled_model = compiled_model
        self.model_id = model_id
        self.model_path = model_path
        self.predictor = None  # None until first inference for lazy load tracking

    def __call__(self, image, **kwargs):
        self.predictor = object()
        if image is None:
            return [EfficientSAMResult(None)]

        target_x = float(kwargs.get("target_x", 0.5))
        target_y = float(kwargs.get("target_y", 0.5))
        mode = kwargs.get("mode", "target")
        conf = float(kwargs.get("conf", 0.4))
        iou_thresh = float(kwargs.get("iou", 0.9))

        h, w = image.shape[:2]
        rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        img_tensor = np.transpose(rgb[None, ...].astype(np.float32) / 255.0, (0, 3, 1, 2))

        if mode == "everything":
            grid_y, grid_x = np.meshgrid(
                np.linspace(0.15 * h, 0.85 * h, 6),
                np.linspace(0.15 * w, 0.85 * w, 6)
            )
            pts_list = np.stack([grid_x.ravel(), grid_y.ravel()], axis=1)
            raw_masks = []
            for pt in pts_list:
                pts_sampled = np.array([[[[pt[0], pt[1]]]]], dtype=np.float32)
                pts_labels = np.array([[[1]]], dtype=np.float32)
                res = self.compiled_model([img_tensor, pts_sampled, pts_labels])
                logits, iou = res[0], res[1]
                best_idx = int(np.argmax(iou[0, 0]))
                score = float(iou[0, 0, best_idx])
                if score >= conf:
                    mask = (logits[0, 0, best_idx] >= 0).astype(np.uint8)
                    if mask.sum() > 20:
                        raw_masks.append(mask)

            deduped = []
            for m in raw_masks:
                is_dup = False
                for existing in deduped:
                    inter = np.logical_and(m, existing).sum()
                    union = np.logical_or(m, existing).sum()
                    if union > 0 and (inter / union) > iou_thresh:
                        is_dup = True
                        break
                if not is_dup:
                    deduped.append(m)

            if not deduped:
                tx = int(0.5 * w)
                ty = int(0.5 * h)
                pts_sampled = np.array([[[[tx, ty]]]], dtype=np.float32)
                pts_labels = np.array([[[1]]], dtype=np.float32)
                res = self.compiled_model([img_tensor, pts_sampled, pts_labels])
                logits, iou = res[0], res[1]
                best_idx = int(np.argmax(iou[0, 0]))
                mask = (logits[0, 0, best_idx] >= 0).astype(np.uint8)
                deduped = [mask]

            return [EfficientSAMResult(deduped[0], deduped)]
        else:
            tx = float(target_x * w)
            ty = float(target_y * h)
            pts_sampled = np.array([[[[tx, ty]]]], dtype=np.float32)
            pts_labels = np.array([[[1]]], dtype=np.float32)
            res = self.compiled_model([img_tensor, pts_sampled, pts_labels])
            logits, iou = res[0], res[1]
            best_idx = int(np.argmax(iou[0, 0]))
            mask = (logits[0, 0, best_idx] >= 0).astype(np.uint8)
            return [EfficientSAMResult(mask)]


@_serialized
def ensure_yoloe_model(model_id: str = "yoloe-26n-seg") -> str:
    wdir = _yoloe_weights_dir()
    wdir.mkdir(parents=True, exist_ok=True)
    filename = _resolve_model_id(model_id)
    weights_path = wdir / filename

    from ultralytics.utils import SETTINGS
    SETTINGS.update({'weights_dir': str(wdir)})

    if not weights_path.is_file():
        from app import model_hot
        model_key = model_hot.start_loading('fastsam', model_id, [str(weights_path)])
        try:
            from ultralytics.utils.downloads import attempt_download_asset
            downloaded = attempt_download_asset(filename)
            if Path(downloaded).resolve() != weights_path.resolve():
                import shutil
                shutil.copy(downloaded, str(weights_path))
            model_hot.loaded(model_key)
        finally:
            model_hot.forget(model_key)

    return str(weights_path)


@_serialized
def ensure_openvino_model(model_id: str = "efficient-sam-vitt", device: str = "GPU") -> str:
    cache_key = f"{model_id}:{device}"
    if cache_key in _openvino_model_cache:
        cached = _openvino_model_cache[cache_key]
        if Path(cached).exists():
            return cached
        del _openvino_model_cache[cache_key]

    if is_yoloe(model_id):
        path = ensure_yoloe_model(model_id)
        _openvino_model_cache[cache_key] = path
        return path

    if is_efficient_sam(model_id):
        wdir = _efficient_sam_weights_dir()
        wdir.mkdir(parents=True, exist_ok=True)
        xml_path = wdir / "efficient_sam_vitt.xml"
        bin_path = wdir / "efficient_sam_vitt.bin"
        onnx_path = wdir / "efficient_sam_vitt.onnx"

        if xml_path.is_file() and bin_path.is_file():
            _openvino_model_cache[cache_key] = str(xml_path)
            return str(xml_path)

        from app import model_hot
        model_key = model_hot.start_loading('fastsam', model_id, [str(xml_path)])
        try:
            if not onnx_path.is_file():
                print(f"[efficient-sam] downloading {onnx_path.name}...")
                url = "https://raw.githubusercontent.com/yformer/EfficientSAM/main/weights/efficient_sam_vitt.onnx"
                urllib.request.urlretrieve(url, str(onnx_path))

            import openvino as ov
            core = ov.Core()
            model = core.read_model(str(onnx_path))
            ov.save_model(model, str(xml_path), compress_to_fp16=True)
            model_hot.loaded(model_key)
        finally:
            model_hot.forget(model_key)

        _openvino_model_cache[cache_key] = str(xml_path)
        return str(xml_path)

    from ultralytics import FastSAM

    filename = _resolve_model_id(model_id)
    print(f"[fastsam] exporting {filename} for device={device}")
    from app import model_hot
    model_key = model_hot.start_loading('fastsam', model_id, [filename])
    try:
        model = FastSAM(filename)
        model_hot.loaded(model_key)

        try:
            model.export(format="openvino", half=True, dynamic=True)
        except Exception as e:
            print(f"OpenVINO export note: {e}")

    finally:
        model_hot.forget(model_key)

    result = f"{filename.replace('.pt', '')}_openvino_model"
    if not Path(result).is_dir():
        raise FileNotFoundError(f"OpenVINO export did not produce {result}")
    _openvino_model_cache[cache_key] = result
    return result


@_serialized
def get_runtime_model(model_path: str, *, keep_warm: bool = False, model_id: str = "efficient-sam-vitt", device: str = "GPU"):
    from app import model_hot
    keep_warm = keep_warm or model_hot.enabled('fastsam')
    cache_key = f"{model_id}:{model_path}:{device}"
    if keep_warm and cache_key in _runtime_model_cache:
        return _runtime_model_cache[cache_key]

    if is_yoloe(model_id):
        from ultralytics import YOLO
        from ultralytics.utils import SETTINGS
        SETTINGS.update({'weights_dir': str(_yoloe_weights_dir())})
        model = YOLO(model_path)
    elif is_efficient_sam(model_id):
        import openvino as ov
        core = ov.Core()
        target_device = device or "GPU"
        if target_device.startswith("intel:"):
            target_device = target_device.split(":", 1)[1].upper()
        if target_device not in core.available_devices:
            target_device = "CPU"
        compiled = core.compile_model(model_path, target_device)
        model = EfficientSAMPredictor(compiled, model_id, model_path)
    else:
        from ultralytics import FastSAM
        model = FastSAM(model_path)

    if keep_warm:
        _runtime_model_cache[cache_key] = model
    return model


@_serialized
def predict_runtime(model, image, *, model_id, model_path, **kwargs):
    from app import model_hot
    if is_yoloe(model_id):
        text_prompt = kwargs.get("text_prompt", "")
        conf = float(kwargs.get("conf", 0.4))
        iou = float(kwargs.get("iou", 0.9))
        if text_prompt:
            classes = [c.strip() for c in str(text_prompt).split(",") if c.strip()]
            if classes:
                model.set_classes(classes)
        with model_hot.loading('fastsam', model_id, [model_path]):
            return model(image, conf=conf, iou=iou, verbose=False)

    predictor = getattr(model, 'predictor', None)
    if predictor is None or getattr(predictor, 'model', True) is None:
        with model_hot.loading('fastsam', model_id, [model_path]):
            return model(image, **kwargs)
    return model(image, **kwargs)


def get_target_mask(results_obj, img_shape, mode: str, target_x: float, target_y: float):
    if results_obj is None:
        return None

    if isinstance(results_obj, EfficientSAMResult):
        if mode == "everything":
            return results_obj.everything_masks or ([results_obj.mask] if results_obj.mask is not None else [])
        return results_obj.mask

    if not hasattr(results_obj, "masks") or results_obj.masks is None:
        return None

    if mode == "everything":
        masks = []
        for segment in results_obj.masks.xy:
            mask = np.zeros((img_shape[0], img_shape[1]), dtype=np.uint8)
            cv2.fillPoly(mask, [segment.astype(np.int32)], 1)
            masks.append(mask)
        return masks

    tx = int(target_x * img_shape[1])
    ty = int(target_y * img_shape[0])

    best_mask_idx = 0
    best_dist = float('inf')

    for i, segment in enumerate(results_obj.masks.xy):
        if len(segment) == 0:
            continue
        dist = cv2.pointPolygonTest(segment, (tx, ty), measureDist=True)
        if dist >= 0:
            area = cv2.contourArea(segment)
            score = area - 1e9
        else:
            score = -dist

        if score < best_dist:
            best_dist = score
            best_mask_idx = i

    if len(results_obj.masks.xy) == 0 or len(results_obj.masks.xy[best_mask_idx]) == 0:
        return None

    best_segment = results_obj.masks.xy[best_mask_idx]
    mask = np.zeros((img_shape[0], img_shape[1]), dtype=np.uint8)
    cv2.fillPoly(mask, [best_segment.astype(np.int32)], 1)
    return mask


async def make_fastsam_directory(
    conf: float = 0.4,
    iou: float = 0.9,
    device: str = "GPU",
    mode: str = "target",
    target_x: float = 0.5,
    target_y: float = 0.5,
    model_id: str = "efficient-sam-vitt",
    text_prompt: str = "",
    keep_model_warm: bool = False,
    **kwargs,
):
    ov_model_path = await asyncio.to_thread(ensure_openvino_model, model_id=model_id, device=device)
    model = await asyncio.to_thread(get_runtime_model, ov_model_path, keep_warm=keep_model_warm, model_id=model_id, device=device)
    print(f"[fastsam] using {model_id} on {device}")

    async def fastsam_directory(src_dir: Path, dst_dir: Path) -> dict:
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

            results = await asyncio.to_thread(
                predict_runtime, model, img,
                model_id=model_id, model_path=ov_model_path, device=ov_device,
                conf=conf, iou=iou, target_x=target_x, target_y=target_y, mode=mode,
                text_prompt=text_prompt,
            )

            if results and len(results) > 0 and getattr(results[0], "masks", None) is not None:
                actual_mode = mode if mode == "target" else "target"
                mask = get_target_mask(results[0], img.shape, actual_mode, target_x, target_y)

                if mask is not None:
                    b, g, r = cv2.split(img)
                    alpha = (mask * 255).astype(np.uint8)
                    transparent_img = cv2.merge([b, g, r, alpha])

                    out_path = dst_dir / frame_path.name
                    cv2.imwrite(str(out_path), transparent_img)
                else:
                    import shutil
                    shutil.copy(frame_path, dst_dir / frame_path.name)
            else:
                import shutil
                shutil.copy(frame_path, dst_dir / frame_path.name)

            report_progress(
                f"fastsam {idx + 1}/{total}",
                phase="fastsam",
                current=idx + 1,
                total=total,
                unit="frames",
                latest_frame=str(dst_dir / frame_path.name),
            )

        return {"frame_count_in": total, "frame_count_out": total}

    fastsam_directory.kind = "directory"
    return fastsam_directory

from . import register_stage
register_stage('fastsam', make_fastsam_directory)
