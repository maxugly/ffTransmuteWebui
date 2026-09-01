import cv2
import numpy as np
from pathlib import Path
from typing import Dict, Any

from app.job_control import report_progress, check_cancelled

_openvino_model_cache: dict[str, str] = {}
_runtime_model_cache: dict[str, object] = {}

MODEL_REGISTRY = {
    "FastSAM-s": "FastSAM-s.pt",
    "FastSAM-x": "FastSAM-x.pt",
}

def _resolve_model_id(model_id: str) -> str:
    return MODEL_REGISTRY.get(model_id, model_id)


def ensure_openvino_model(model_id: str = "FastSAM-s", device: str = "GPU") -> str:
    from ultralytics import FastSAM

    filename = _resolve_model_id(model_id)
    cache_key = f"{model_id}:{device}"
    if cache_key in _openvino_model_cache:
        cached = _openvino_model_cache[cache_key]
        if Path(cached).is_dir():
            return cached
        del _openvino_model_cache[cache_key]

    print(f"[fastsam] exporting {filename} for device={device}")
    model = FastSAM(filename)

    try:
        model.export(format="openvino", half=True, dynamic=True)
    except Exception as e:
        print(f"OpenVINO export note: {e}")

    result = f"{filename.replace('.pt', '')}_openvino_model"
    if not Path(result).is_dir():
        raise FileNotFoundError(f"OpenVINO export did not produce {result}")
    _openvino_model_cache[cache_key] = result
    return result


def get_runtime_model(model_path: str, *, keep_warm: bool = False, model_id: str = "FastSAM-s"):
    from ultralytics import FastSAM
    cache_key = f"{model_id}:{model_path}"
    if keep_warm and cache_key in _runtime_model_cache:
        return _runtime_model_cache[cache_key]
    model = FastSAM(model_path)
    if keep_warm:
        _runtime_model_cache[cache_key] = model
    return model


def get_target_mask(results_obj, img_shape, mode: str, target_x: float, target_y: float):
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
    model_id: str = "FastSAM-s",
    keep_model_warm: bool = False,
    **kwargs,
):
    ov_model_path = ensure_openvino_model(model_id=model_id, device=device)
    model = get_runtime_model(ov_model_path, keep_warm=keep_model_warm, model_id=model_id)
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

            results = model(img, device=ov_device, conf=conf, iou=iou)

            if results and len(results) > 0 and results[0].masks is not None:
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
