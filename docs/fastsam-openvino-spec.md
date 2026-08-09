# FastSAM OpenVINO Asset Extraction Spec

> **Status:** Implemented
> **Audience:** Builders integrating FastSAM via OpenVINO for Intel iGPU
> **Related:** `filter-platform-spec.md`, `withoutbg-spec.md`

---

## 1. Goal

Implement a high-performance local asset extraction tool (foreground removal/masking) using **FastSAM** optimized via **OpenVINO**. This feature targets Intel Core i5-1335U processors with Iris Xe Graphics (80 EUs) and 16GB shared RAM, leveraging FP16 precision for maximum throughput.

This will be integrated into the existing `ffTransmuteWebui` filter platform, supporting both image batches and video frame sequences.

---

## 2. Technical Requirements & Model Strategy

1. **Inference Engine**: OpenVINO via the `ultralytics` package.
2. **Model Selection**: 
   - **Primary Model**: FastSAM (Fast Segment Anything Model).
   - **Precision**: FP16 (Half precision) to maximize throughput on the Iris Xe iGPU.
   - **Device Target**: `GPU` (Iris Xe) by default, falling back to `CPU` if necessary.
3. **Workflow**:
   - The model must first be exported to OpenVINO IR format: `model.export(format="openvino", half=True)`.
   - The extraction process generates a mask, applies it as an alpha channel to the original image, and saves transparent PNGs.
   - Configurable parameters: Confidence threshold (`conf`) and Intersection over Union (`iou`).

---

## 3. System Architecture & Integration

This feature integrates into the established `ffTransmuteWebui` **Filter Platform**:

```text
Upload/Pool File -> `operations/fastsam_ops.py` -> `job_workspace` (dump frames)
                                                   -> `filters/fastsam.py` (OpenVINO inference)
                                                   -> encode/export (transparent PNGs or video)
```

### 3.1 Backend Components

1. **Stage Factory (`app/filters/fastsam.py`)**:
   - Implements a `per_frame` or `directory` stage kind. A `directory` kind is preferred to load the OpenVINO model once and batch-process all frames efficiently without reloading overhead.
   
2. **Thin Op Wrapper (`app/operations/fastsam_ops.py`)**:
   - Exposes `POST /ops/fastsam`.
   - Uses `run_staged_job` (from `app.staged_job`) to handle dump, filter, and encode automatically.
   
3. **Dependencies**:
   - Requires `openvino`, `ultralytics`, `opencv-python`, `numpy`. (Ensure these are in `requirements.txt`).

### 3.2 WebUI / Frontend

- Add a "FastSAM" tool tab in `app/static/js/tabs/`.
- Use the standard `job_queue` UI for dispatching and tracking progress (`job_control.report_progress()` must be called during inference).
- Target input: `input_path` (from Video or Image Pool).
- Knobs: `conf` (slider 0.1 - 0.99), `iou` (slider 0.1 - 0.99), `device` (dropdown: `GPU`, `CPU`, `AUTO`), `mode` (dropdown: `target`, `everything`), `target_x` and `target_y` (coordinates 0.0 - 1.0).
- **Coordinate Mapping**: To properly map the unpadded UI clicks (0.0-1.0) to the original image dimensions, the backend must test against the unpadded polygon coordinates (`results[0].masks.xy`) using `cv2.pointPolygonTest`, rather than naive tensor masks.
- **Output Handling**: For `mode="everything"`, the API returns a directory path (e.g. `_assets`) containing all isolated transparent PNGs. The UI uses the native folder opener API (`/api/open-folder`) to reveal it in the system file manager (e.g., Dolphin).

---

## 4. Implementation Details

### 4.1 Model Export and Initialization

```python
from ultralytics import FastSAM

def ensure_openvino_model(model_id="FastSAM-s.pt", device="GPU"):
    # Load PyTorch model
    model = FastSAM(model_id)
    # Export to OpenVINO IR in FP16 format
    # This creates a '_openvino_model' directory
    model.export(format="openvino", half=True, dynamic=True)
    return f"{model_id.replace('.pt', '')}_openvino_model"
```

### 4.2 Inference Loop (`filters/fastsam.py`)

A `directory` stage processing frames:

```python
import cv2
import numpy as np
from pathlib import Path
from ultralytics import FastSAM
from app.staged_job import StageSpec
from app.job_control import report_progress

async def make_fastsam_directory(conf: float = 0.4, iou: float = 0.9, device: str = "GPU"):
    
    # Initialization happens here to run once per batch
    ov_model_path = ensure_openvino_model()
    # Ultralytics transparently handles OpenVINO models if path points to the exported dir
    model = FastSAM(ov_model_path)
    
    async def fastsam_directory(src_dir: Path, dst_dir: Path) -> dict:
        frames = sorted(list(src_dir.glob("frame_*.png")))
        total = len(frames)
        
        for idx, frame_path in enumerate(frames):
            img = cv2.imread(str(frame_path))
            
            # Run inference
            results = model(img, device=device, conf=conf, iou=iou)
            
            # Post-process: extract largest mask (assuming central object for asset)
            if results and results[0].masks is not None:
                mask = results[0].masks.data[0].cpu().numpy()
                mask = cv2.resize(mask, (img.shape[1], img.shape[0]))
                
                # Apply mask to alpha channel
                b, g, r = cv2.split(img)
                alpha = (mask * 255).astype(np.uint8)
                transparent_img = cv2.merge([b, g, r, alpha])
                
                out_path = dst_dir / frame_path.name
                cv2.imwrite(str(out_path), transparent_img)
            else:
                # Fallback: copy original or transparent blank
                import shutil
                shutil.copy(frame_path, dst_dir / frame_path.name)
            
            report_progress(
                phase="fastsam",
                current=idx + 1,
                total=total,
                unit="frames"
            )
            
        return {"frame_count": total}

    return fastsam_directory
```

### 4.3 API Endpoint (`operations/fastsam_ops.py`)

```python
from fastapi import APIRouter
from pydantic import BaseModel
from app.contract import OperationResult, ok
from app.staged_job import run_staged_job, StageSpec
from app.filters.fastsam import make_fastsam_directory

router = APIRouter()

class FastSAMParams(BaseModel):
    input_path: str
    conf: float = 0.4
    iou: float = 0.9
    device: str = "GPU"
    dry_run: bool = False

@router.post("/fastsam", response_model=OperationResult)
async def op_fastsam(p: FastSAMParams):
    out = generate_output_path(p.input_path, "_fastsam") # standard helper
    return await run_staged_job(
        op_id="fastsam",
        prefix="fastsam_",
        input_path=p.input_path,
        output_path=out,
        dry_run=p.dry_run,
        dump_kwargs={},
        stages=[StageSpec("fastsam", "directory", await make_fastsam_directory(p.conf, p.iou, p.device))],
        encode_kwargs={"codec": "prores_4444"} # or PNG sequence for images
    )
```

---

## 5. Optimization & Hardware Strategy

- **FP16 Enforcement**: Crucial for the Iris Xe 80 EU architecture to avoid memory bandwidth bottlenecks and double inference speed.
- **Memory Management (16GB Shared)**:
  - Do not keep full-resolution numpy arrays of the entire batch in RAM.
  - Process 1 image at a time (batch size = 1) in the `for` loop to prevent OOM errors, as the iGPU and CPU share the 16GB system RAM.
  - Call `gc.collect()` if memory creeping is observed across long video sequences.
- **OpenVINO dynamic batching**: Only utilize if testing reveals stable memory usage. Start with batch size = 1 for safety on 16GB.

---

## 6. Verification Steps (Definition of Done)

1. Verify `run.py` starts without crashing with `ultralytics` installed.
2. Using the WebUI, pass `/tmp/teste.png` (or a known subject image) to the FastSAM tab.
3. Ensure the OpenVINO model export successfully creates the optimized IR files.
4. Verify the output PNG contains a transparent background outlining the subject.
5. Check backend logs to ensure `GPU` (Iris Xe) was selected and utilized by OpenVINO.
6. Verify no JS errors in the browser console.
