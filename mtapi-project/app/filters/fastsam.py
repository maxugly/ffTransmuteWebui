import cv2
import numpy as np
from pathlib import Path
from typing import Dict, Any

from app.job_control import report_progress, check_cancelled

_openvino_model_cache: dict[str, str] = {}

def ensure_openvino_model(model_id: str = "FastSAM-s.pt", device: str = "GPU") -> str:
    from ultralytics import FastSAM
    
    cache_key = f"{model_id}:{device}"
    if cache_key in _openvino_model_cache:
        return _openvino_model_cache[cache_key]
    
    model = FastSAM(model_id)
    
    try:
        model.export(format="openvino", half=True, dynamic=True)
    except Exception as e:
        print(f"OpenVINO export note: {e}")
        
    result = f"{model_id.replace('.pt', '')}_openvino_model"
    _openvino_model_cache[cache_key] = result
    return result


async def make_fastsam_directory(conf: float = 0.4, iou: float = 0.9, device: str = "GPU", **kwargs):
    from ultralytics import FastSAM
    
    ov_model_path = ensure_openvino_model(device=device)
    model = FastSAM(ov_model_path)

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
                mask = results[0].masks.data[0].cpu().numpy()
                mask = cv2.resize(mask, (img.shape[1], img.shape[0]))
                
                b, g, r = cv2.split(img)
                alpha = (mask * 255).astype(np.uint8)
                transparent_img = cv2.merge([b, g, r, alpha])
                
                out_path = dst_dir / frame_path.name
                cv2.imwrite(str(out_path), transparent_img)
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
