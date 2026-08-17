# Coder Prompt — SwinIR-Light (`swinir`)

> **Target**: ffTransmuteWebui — new standalone operation + new WebUI tab
> **Spec reference**: `docs/swinir-spec.md` (same directory)

---

## MISSION
Implement a "SwinIR Cleanup" operation that uses SwinIR-Light (OpenVINO FP16) to denoise or deblur media using seamless cosine-blended tiling to prevent OOM errors.

## PHASE 1 — BACKEND: `swinir_ops.py`
Create `mtapi-project/app/operations/swinir_ops.py`.
Define Pydantic schema `SwinirParams` with `task` ('denoise', 'deblur').

**Requirements:**
1. **Dependencies**: `openvino`, `torch`, `opencv-python`.
2. **Model Conversion**: Write a helper to instantiate the SwinIR PyTorch class (upscale=1, window_size=8, embed_dim=60), load official weights for denoising or deblurring based on the `task` param, and convert it to OpenVINO FP16 using a **static 512x512 dummy input**. Save to `models/swinir_{task}_fp16.xml`.
3. **Tiling & Blending Engine**: 
   - Implement `build_blending_window(512, 512, pad=32)` using a cosine ramp.
   - Implement `process_tiled(image, infer_fn, tile_size=512, pad=32)`.
   - Ensure the image is padded with `cv2.BORDER_REFLECT` to perfectly fit the stride.
   - Accumulate inferenced tiles into an output canvas and divide by a weight canvas.
4. **Inference Loop**: Run compiled model on `"GPU"`. Converts BGR uint8 -> RGB float32 -> OpenVINO -> BGR uint8.
5. **Support Images & Video**: If input is video, process frame by frame.

Register the operation. Import in `__init__.py`.

## PHASE 2 — FRONTEND: app.js + index.html
- Add `swinir` tab under "Image AI".
- Form: Dropdown for `task` (Denoise / Deblur).
- Add routing and execution logic.
