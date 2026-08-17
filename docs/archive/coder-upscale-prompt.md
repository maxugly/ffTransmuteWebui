# Coder Prompt — Upscale & Re-Grain (`upscale`)

> **Target**: ffTransmuteWebui — new standalone operation + new WebUI tab
> **Spec reference**: `docs/upscale-spec.md` (same directory)

---

## MISSION
Implement an "Upscale" operation that uses NCNN Vulkan binaries (Real-ESRGAN or SRMD) to upscale media, followed by an FFmpeg Re-Grain post-pass.

## PHASE 1 — BACKEND: `upscale_ops.py`
Create `mtapi-project/app/operations/upscale_ops.py`.
Define Pydantic schema `UpscaleParams` with `engine` ('realesrgan', 'srmd'), `scale` (2, 4), `srmd_noise` (-1 to 10), and `grain_strength` (0 to 24).

**Requirements:**
1. **Dependencies**: Requires the system to have `realesrgan-ncnn-vulkan` and `srmd-ncnn-vulkan` CLI binaries in the `PATH` or `bin/` directory.
2. **Upscaling Loop**:
   - If image: run the CLI directly on the image file.
   - If video: dump frames to a temp dir, or if the CLI supports video, use that. (Assuming frame-by-frame or CLI video support). The NCNN binaries usually process folders of images. Use `ffmpeg` to dump to PNGs, run the NCNN binary on the folder, then re-encode.
   - Use `-t 256` to force tiling and avoid Intel Xe OOM.
3. **Re-Grain (FFmpeg)**:
   - When encoding the upscaled frames back to video (or saving the image), append the FFmpeg `noise` filter if `grain_strength > 0`.
   - Filter string: `noise=c0s={grain}:c1s={grain//2}:c2s={grain//2}:allf=t+g`
4. **Execution**: Use `run_command` from `app.shell.py`.

Register the operation. Import in `__init__.py`.

## PHASE 2 — FRONTEND: app.js + index.html
- Add `upscale` tab under "Image AI".
- Form: Dropdown for Engine. Continuous Knobs for `scale`, `srmd_noise` (hide if engine != srmd), and `grain_strength`.
- Add routing and execution logic.
