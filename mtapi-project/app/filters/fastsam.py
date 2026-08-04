import cv2
import numpy as np
from pathlib import Path
from typing import Dict, Any

from app.job_control import report_progress, check_cancelled

def ensure_openvino_model(model_id: str = "FastSAM-s.pt", device: str = "GPU") -> str:
    from ultralytics import FastSAM
    # Load PyTorch model (downloads if not present)
    model = FastSAM(model_id)
    
    # Export to OpenVINO IR in FP16 format for Intel GPUs
    # This creates a folder named {model_id_without_ext}_openvino_model
    try:
        model.export(format="openvino", half=True, dynamic=True)
    except Exception as e:
        # Sometimes export fails if already exported or other reasons, log it
        print(f"OpenVINO export note: {e}")
        
    return f"{model_id.replace('.pt', '')}_openvino_model"


async def make_fastsam_directory(conf: float = 0.4, iou: float = 0.9, device: str = "GPU", **kwargs):
    from ultralytics import FastSAM
    
    # Run in a thread or async if downloading takes time? 
    # For now, do it synchronously to ensure the model is ready.
    ov_model_path = ensure_openvino_model(device=device)
    
    # Initialize model
    model = FastSAM(ov_model_path)

    async def fastsam_directory(src_dir: Path, dst_dir: Path) -> dict:
        frames = sorted(list(src_dir.glob("frame_*.png")))
        total = len(frames)
        
        for idx, frame_path in enumerate(frames):
            check_cancelled()
            
            img = cv2.imread(str(frame_path))
            if img is None:
                continue
            
            # Run inference
            results = model(img, device=device, conf=conf, iou=iou)
            
            # Post-process: extract largest mask
            if results and len(results) > 0 and results[0].masks is not None:
                mask = results[0].masks.data[0].cpu().numpy()
                mask = cv2.resize(mask, (img.shape[1], img.shape[0]))
                
                # Apply mask to alpha channel
                b, g, r = cv2.split(img)
                alpha = (mask * 255).astype(np.uint8)
                transparent_img = cv2.merge([b, g, r, alpha])
                
                out_path = dst_dir / frame_path.name
                cv2.imwrite(str(out_path), transparent_img)
            else:
                # Fallback: copy original with full opacity
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
            
        return {"frame_count": total}

    fastsam_directory.kind = "directory"
    return fastsam_directory

from . import register_stage
register_stage('fastsam', make_fastsam_directory)
