# Coder Prompt — Depth Map Extraction (`depthmap`)

> **Target**: ffTransmuteWebui — new standalone operation + new WebUI tab
> **Spec reference**: `docs/depthmap-spec.md` (same directory)

---

## MISSION
Implement a "Depth Map" operation that extracts a per-frame grayscale depth map from a video using MiDaS (via OpenVINO).

## PHASE 1 — BACKEND: `depthmap_ops.py`
Create `mtapi-project/app/operations/depthmap_ops.py`.
Define Pydantic schema `DepthmapParams`.

**Requirements:**
1. **Dependencies**: `openvino`, `torch`, `torchvision`, `opencv-python`. Ensure these are in `requirements.txt`.
2. **Model Loading & Conversion**: Write a helper to download `intel-isl/MiDaS` `MiDaS_small` via `torch.hub.load`, convert it to OpenVINO FP16 using `ov.convert_model` and `ov.save_model`, and save it to `mtapi-project/models/MiDaS_small_fp16.xml`.
3. **Inference Loop**:
   - Compile model for `"GPU"` (Intel Xe) with `{"PERFORMANCE_HINT": "LATENCY"}`. Fallback to `"CPU"`.
   - Read video via OpenCV.
   - Resize frames to 256x256, normalize (mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]).
   - Run inference.
   - Resize depth map back to original dimensions.
   - Min-Max normalize to 0-255 uint8.
   - Write using OpenCV `VideoWriter` (isColor=False) or pipe to `ffmpeg`.

Register the operation. Import in `__init__.py`.

## PHASE 2 — FRONTEND: app.js + index.html
- Add `depthmap` tab under "Video AI".
- Form: File input, Output path.
- Add routing and execution logic.
