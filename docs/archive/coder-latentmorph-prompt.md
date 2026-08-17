# Coder Prompt — Latent Space Interpolation (`latentmorph`)

> **Target**: ffTransmuteWebui — new standalone operation + new WebUI tab
> **Spec reference**: `docs/latentmorph-spec.md` (same directory)

---

## MISSION
Implement a "Latent Morph" operation that takes two images, encodes them into StyleGAN2 latents via `e4e`, and generates a smooth transition video using OpenVINO FP16 on the Intel Xe iGPU.

## PHASE 1 — BACKEND: `latentmorph_ops.py`
Create `mtapi-project/app/operations/latentmorph_ops.py`.
Define Pydantic schema `LatentMorphParams` with `input_b_path` (str), `duration` (float), and `fps` (int).

**Requirements:**
1. **Dependencies**: `openvino`, `numpy`, `opencv-python`.
2. **Model Loading**: Load `e4e` and `StyleGAN2` ONNX/IR models via `ov.Core().compile_model(..., device_name="GPU", config={"INFERENCE_PRECISION_HINT": "f16"})`.
3. **Interpolation Math**: Implement `slerp(val, low, high)` using numpy (Spherical Linear Interpolation based on vector norm angles).
4. **Execution**:
   - Loop over `frames = duration * fps`.
   - Calculate `alpha = frame / frames`.
   - Slerp latents.
   - Run Generator OpenVINO inference.
   - Save output as a JPEG frame.
5. **Video Compilation**: Use `run_command` and `ffmpeg` to stitch the JPEGs into an H.264 MP4.

Register the operation. Import in `__init__.py`.

## PHASE 2 — FRONTEND: app.js + index.html
- Add `latentmorph` tab under "Hallucination".
- Form: Input 1 (global image input), Input 2 (secondary file picker), Duration slider.
- Add routing and execution logic.
