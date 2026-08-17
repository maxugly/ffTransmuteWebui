# Coder Prompt — SD Tiled Agent Upscale (`sd_tiled_upscale`)

> **Target**: ffTransmuteWebui — new standalone operation + new WebUI tab
> **Spec reference**: `docs/sd-tiled-upscale-spec.md` (same directory)

---

## MISSION
Implement a "Stable Diffusion Tiled Upscale" operation that uses `optimum-intel` and OpenVINO to run SD img2img on overlapping tiles, hallucinating prompt-driven details into the image on Intel Xe iGPU.

## PHASE 1 — BACKEND: `sd_upscale_ops.py`
Create `mtapi-project/app/operations/sd_upscale_ops.py`.
Define Pydantic schema `SDUpscaleParams` with `base_prompt` (str), `strength` (float), and `scale` (int, default 2).

**Requirements:**
1. **Dependencies**: `diffusers`, `optimum-intel`, `openvino`.
2. **Model Loading**: 
   - Ensure the environment variable `DEVICE="gpu"` is respected.
   - Use `OVStableDiffusionImg2ImgPipeline` from `optimum.intel`.
   - Compile the pipeline for the `"GPU"` device (Intel Xe) to leverage FP16 vector units.
3. **Tiling Logic**:
   - Upscale the base image using a standard Lanczos resize by `scale`.
   - Slice the upscaled image into 512x512 tiles with a 64px overlap.
   - Run the OpenVINO SD pipeline on each tile using the `base_prompt` and `strength` (e.g. 0.35).
   - Feather/blend the edges of the tiles back into the main canvas using a 2D cosine or Hanning window to prevent grid lines.
4. **Execution**: Use `asyncio` to run the blocking SD pipeline in a threadpool so it doesn't lock the FastAPI server.

Register the operation. Import in `__init__.py`.

## PHASE 2 — FRONTEND: app.js + index.html
- Add `SD Tiled Upscale` tab under "Hallucination".
- Form: Base Prompt textarea, Denoise Strength slider (0.1 - 0.7), Scale dropdown (2x, 4x).
- Add routing and execution logic.
