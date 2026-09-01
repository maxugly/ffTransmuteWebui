# Coder Prompt — Face Restoration (`facerestore`)

> **Target**: ffTransmuteWebui — new standalone operation + new WebUI tab
> **Spec reference**: `docs/facerestore-spec.md` (same directory)

---

## MISSION
Implement a "Face Restore" operation that detects faces, crops them, runs CodeFormer (OpenVINO FP16), and blends them back into the image.

## PHASE 1 — BACKEND: `facerestore_ops.py`
Create `mtapi-project/app/operations/facerestore_ops.py`.
Define Pydantic schema `FaceRestoreParams` with `fidelity_weight` (0.0 to 1.0, default 0.5).

**Requirements:**
1. **Dependencies**: `openvino`, `torch`, `opencv-python`.
2. **Model Conversion Helpers**: Write functions to convert CodeFormer to ONNX (with dynamic weight `w`) and then to OpenVINO FP16, saving to `models/codeformer_fp16.xml`. Do the same for a lightweight RetinaFace ONNX model (`retinaface_fp16.xml`).
3. **Detection & Alignment**: Use RetinaFace to extract 5 landmarks. Use `cv2.estimateAffinePartial2D` against the standard FFHQ 512x512 landmark template to get the affine matrix. Use `cv2.warpAffine` to crop.
4. **CodeFormer Inference**: Run on `"GPU"` (Intel Xe) with `fidelity_weight` tensor.
5. **Inverse Blending**: 
   - Create a feathered elliptical mask (`cv2.ellipse` + `cv2.GaussianBlur`).
   - Use `cv2.invertAffineTransform` and `cv2.warpAffine` to project the restored face and mask back onto the original image.
   - Alpha blend.
6. **Support Images & Video**: If the input is a video, process frame by frame using OpenCV `VideoCapture` and `VideoWriter`.

Register the operation. Import in `__init__.py`.

## PHASE 2 — FRONTEND: app.js + index.html
- Add `facerestore` tab under "Image AI".
- Form: Continuous Knob for `fidelity` (0.0 to 1.0, step 0.05).
- Add routing and execution logic.
