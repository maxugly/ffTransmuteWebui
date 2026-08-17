# FastSAM OpenVINO Asset Extraction Spec

> **Status:** Implemented (000.000.7.002)
> **Audience:** Builders integrating FastSAM via OpenVINO for Intel iGPU
> **Related:** `filter-platform-spec.md`, `withoutbg-spec.md`

> **Note (2026-08-09):** The shipped implementation uses polygon-contour mask extraction (`results_obj.masks.xy` + `cv2.fillPoly`) with `cv2.pointPolygonTest` for target-mode selection, rather than the original tensor-resize path in §4.2 below. When masks are not detected, the original frame is copied unchanged instead of writing a blank/transparent output.

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
        if len(segment) == 0: continue
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


async def make_fastsam_directory(conf: float = 0.4, iou: float = 0.9, device: str = "GPU", mode: str = "target", target_x: float = 0.5, target_y: float = 0.5, **kwargs):
    ov_model_path = ensure_openvino_model(device=device)
    model = FastSAM(ov_model_path)

    async def fastsam_directory(src_dir: Path, dst_dir: Path) -> dict:
        frames = sorted(list(src_dir.glob("frame_*.png")))
        total = len(frames)

        for idx, frame_path in enumerate(frames):
            img = cv2.imread(str(frame_path))

            results = model(img, device=device, conf=conf, iou=iou)

            if results and len(results) > 0 and results[0].masks is not None:
                mask = get_target_mask(results[0], img.shape, mode, target_x, target_y)

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
from app.staged_job import StageSpec, run_staged_job
from app.filters.fastsam import make_fastsam_directory
from app.pathutil import finalize_output_path

router = APIRouter()

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".gif"}
VIDEO_EXTS = {".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi"}

class FastSAMParams(BaseModel):
    input_path: str
    output_dir: str | None = None
    conf: float = 0.4
    iou: float = 0.9
    device: Literal["GPU", "CPU", "AUTO"] = "GPU"
    mode: Literal["everything", "target"] = "target"
    target_x: float = 0.5
    target_y: float = 0.5
    start_frame: int = 1
    end_frame: int = 999999
    dry_run: bool = False

@router.post("/fastsam", response_model=OperationResult)
async def op_fastsam(p: FastSAMParams):
    input_path = Path(p.input_path).expanduser().resolve()
    if not input_path.is_file():
        return OperationResult(ok=False, operation="fastsam", error=f"Input not found: {input_path}", dry_run=p.dry_run)

    ext = input_path.suffix.lower()
    is_image = ext in IMAGE_EXTS

    if is_image:
        out = finalize_output_path(None, source=input_path, default_suffix="_fastsam", default_ext=input_path.suffix or ".png", allowed_exts=IMAGE_EXTS, output_dir=p.output_dir or None)
    else:
        out = finalize_output_path(None, source=input_path, default_suffix="_fastsam", default_ext=".mov", allowed_exts=VIDEO_EXTS, output_dir=p.output_dir or None)

    summary = f"fastsam {input_path.name}"

    if p.dry_run:
        dry = (
            f"# {'image' if is_image else 'dump'}\n"
            + (f"  direct image inference\n" if is_image else f"  ffmpeg -i {input_path} → frames_in/frame_%06d.png\n")
            + f"# fastsam stage\n"
            + f"  conf={p.conf} iou={p.iou} device={p.device} mode={p.mode}\n"
            + (f"\n# output\n  {out}" if is_image else f"\n# encode\n  ffmpeg -framerate <fps> -i frames_out/frame_%06d.png {out}")
        )
        return OperationResult(ok=True, operation="fastsam", output_path=str(out), dry_run=True, command=summary, stdout=dry)

    if is_image:
        import cv2
        from app.filters.fastsam import ensure_openvino_model, get_target_mask
        from ultralytics import FastSAM

        ov_model_path = ensure_openvino_model(device=p.device)
        model = FastSAM(ov_model_path)

        ov_device = p.device
        if ov_device and not ov_device.lower().startswith("intel:") and ov_device.upper() != "CPU":
            ov_device = f"intel:{ov_device.lower()}"

        img = cv2.imread(str(input_path))
        if img is None:
            return OperationResult(ok=False, operation="fastsam", error=f"Failed to read image: {input_path}")

        results = model(img, device=ov_device, conf=p.conf, iou=p.iou)

        if results and len(results) > 0 and results[0].masks is not None:
            mask_result = get_target_mask(results[0], img.shape, p.mode, p.target_x, p.target_y)

            if p.mode == "everything" and isinstance(mask_result, list):
                out_dir = Path(out).parent / f"{Path(out).stem}_assets"
                out_dir.mkdir(parents=True, exist_ok=True)
                b, g, r = cv2.split(img)

                for i, mask in enumerate(mask_result):
                    alpha = (mask * 255).astype(np.uint8)
                    transparent_img = cv2.merge([b, g, r, alpha])

                    y_idx, x_idx = np.nonzero(mask)
                    if len(y_idx) > 0:
                        y1, y2 = np.min(y_idx), np.max(y_idx)
                        x1, x2 = np.min(x_idx), np.max(x_idx)
                        cropped = transparent_img[y1:y2+1, x1:x2+1]

                        asset_name = f"asset_{i:03d}.png"
                        asset_path = out_dir / asset_name
                        cv2.imwrite(str(asset_path), cropped)

                out = out_dir
            else:
                mask = mask_result
                if mask is not None:
                    b, g, r = cv2.split(img)
                    alpha = (mask * 255).astype(np.uint8)
                    transparent_img = cv2.merge([b, g, r, alpha])
                    cv2.imwrite(str(out), transparent_img)
                else:
                    import shutil
                    shutil.copy(input_path, out)
        else:
            import shutil
            shutil.copy(input_path, out)

        from app import job_control
        token = job_control.current_token()
        if token:
            job_control.report_progress("fastsam done", phase="done", current=1, total=1, unit="pass", latest_frame=str(out), token=token)

        return OperationResult(ok=True, operation="fastsam", output_path=str(out), dry_run=False, command=summary)

    from app.filters.fastsam import make_fastsam_directory
    stage_fn = await make_fastsam_directory(conf=p.conf, iou=p.iou, device=p.device, mode=p.mode, target_x=p.target_x, target_y=p.target_y)

    return await run_staged_job(
        op_id="fastsam",
        prefix="fastsam_",
        input_path=input_path,
        output_path=str(out),
        dry_run=p.dry_run,
        dump_kwargs={"start_frame": p.start_frame, "end_frame": p.end_frame},
        stages=[StageSpec("fastsam", "directory", stage_fn)],
        encode_kwargs={"codec": "prores", "pix_fmt": "yuva444p10le"},
        summary=summary,
    )

register(OperationSpec(
    id="fastsam",
    summary="FastSAM object extraction via OpenVINO",
    description="Extracts main subjects from video or images using Fast Segment Anything Model (Intel Iris Xe FP16 optimized). Output is transparent.",
    params_model=FastSAMParams,
    handler=op_fastsam,
    tags=["fastsam", "openvino", "matting", "video", "image", "filter"],
))
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
7. For `target` mode, confirm that clicking near a subject selects that mask rather than a random segment.
8. For `everything` mode, confirm that an `_assets/` folder is created with cropped transparent PNGs.
9. For frames where no mask is detected, confirm the original frame is copied unchanged rather than producing a black/transparent output.
