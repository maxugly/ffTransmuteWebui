# Coder Prompt — Inpaint & Scratch Removal (`inpaint`)

> **Target**: ffTransmuteWebui — new standalone operation + new WebUI tab
> **Spec reference**: `docs/inpaint-spec.md` (same directory)

---

## MISSION
Implement an "Inpaint" operation using LaMa (OpenVINO FP16) to remove objects manually via a mask, or automatically via a scratch-detection pre-pass for old photo restoration.

## PHASE 1 — BACKEND: `inpaint_ops.py`
Create `mtapi-project/app/operations/inpaint_ops.py`.
Define Pydantic schema `InpaintParams` with `mode` ('manual', 'auto_scratch'), and optional `mask_path`.

**Requirements:**
1. **Dependencies**: `openvino`, `opencv-python`.
2. **Model Loading**: Obtain/convert `big-lama.onnx` to OpenVINO FP16 (`models/lama_fp16.xml`). Compile for `"GPU"` with `INFERENCE_PRECISION_HINT: f16`.
3. **Auto-Scratch Logic**:
   - If mode is `auto_scratch`, generate the mask programmatically.
   - Convert to grayscale, apply `cv2.morphologyEx` (Top-Hat) with a 9x9 kernel, threshold, and dilate with a 3x3 kernel.
4. **Padding**:
   - Implement `pad_to_modulo(img, mod=8)` using `np.pad(..., mode="reflect")`.
   - Apply to both image (RGB) and mask (binary `[0.0, 1.0]`).
5. **Inference**:
   - Format Image: `[1, 3, H, W]` float32 in `[0.0, 1.0]`.
   - Format Mask: `[1, 1, H, W]` float32 (1.0 = remove).
   - Run OpenVINO model.
6. **Post-processing**:
   - Convert output tensor to BGR uint8.
   - Crop padded regions back to original width/height.

Register the operation. Import in `__init__.py`.

## PHASE 2 — FRONTEND: app.js + index.html
- Add `inpaint` tab under "Image AI".
- Form: Dropdown for Mode, Image Input, Mask Input (hide Mask if Auto-Scratch).
- Add routing and execution logic.
