# Coder Prompt — B&W Colorization (`colorize`)

> **Target**: ffTransmuteWebui — new standalone operation + new WebUI tab
> **Spec reference**: `docs/colorize-spec.md` (same directory)

---

## MISSION
Implement a "Colorize" operation that uses DDColor-Tiny (OpenVINO FP16) to semantically colorize B&W media while preserving exact original luminance sharpness.

## PHASE 1 — BACKEND: `colorize_ops.py`
Create `mtapi-project/app/operations/colorize_ops.py`.
Define Pydantic schema `ColorizeParams`.

**Requirements:**
1. **Dependencies**: `openvino`, `opencv-python`.
2. **Model Loading**: Obtain/convert DDColor-Tiny to OpenVINO FP16 (`models/ddcolor_tiny_fp16.xml`). Compile for `"GPU"` (Intel Xe).
3. **Pre-processing**:
   - Convert BGR to Lab. Extract $L$ channel.
   - Resize $L$ to 512x512. Scale values to `[0, 100]`. Stack into `(1, 3, 512, 512)`.
4. **Inference**: Run OpenVINO model. Get $a$ and $b$ outputs.
5. **Post-processing**:
   - Resize $a$ and $b$ to original image dimensions.
   - Add 128 to shift into `[0, 255]` and convert to `uint8`.
   - Merge original $L$ with predicted $a, b$.
   - Convert Lab to BGR.
6. **Support Images & Video**: Process frame by frame if input is video.

Register the operation. Import in `__init__.py`.

## PHASE 2 — FRONTEND: app.js + index.html
- Add `colorize` tab under "Image AI".
- Form: File input, Output path, Dry Run toggle. (No extra knobs needed).
- Add routing and execution logic.
