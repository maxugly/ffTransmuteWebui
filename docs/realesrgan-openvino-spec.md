# Real-ESRGAN OpenVINO Intel GPU Upscaler Spec

> **Status:** Draft / Specification  
> **Audience:** Builders implementing super-resolution on Intel iGPU / Arc  
> **Related:** `filter-platform-spec.md`, `fastsdcpu-upscalers-spec.md`, `intel_gpu_5d_bug_workaround.md`  
> **Upstream:** [nekofoo/Real-ESRGAN-For-Intel-GPU](https://github.com/nekofoo/Real-ESRGAN-For-Intel-GPU) · [xinntao/Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) (BSD-3-Clause)

---

## 1. Goal

Integrate a high-performance **Real-ESRGAN** super-resolution engine accelerated natively via **OpenVINO** on Intel Integrated Graphics (Iris Xe 80 EU) and Intel Arc discrete GPUs.

### 1.1 Why OpenVINO over NCNN Vulkan on Intel?
The existing upscale stage (`app/filters/upscale.py`) relies on `realesrgan-ncnn-vulkan`. On Intel iGPUs:
1. Vulkan shader compilation on Mesa/Intel compute drivers encounters driver overhead and periodic pipeline stalls.
2. The `nekofoo/Real-ESRGAN-For-Intel-GPU` benchmark demonstrates that OpenVINO's native oneDNN / OpenCL GPU plugin runs **up to 5x faster** on Intel hardware than NCNN Vulkan.
3. OpenVINO runs directly in-process via Python (`import openvino as ov`), eliminating external binary shelling, sub-process leaks, and brittle PATH searches.

---

## 2. Technical Requirements & Model Architecture

### 2.1 Model Variants
Support standard Real-ESRGAN architectures:
- **`RealESRGAN_x4plus`** (RRDBNet, 64 features, 23 blocks): Maximum photorealistic detail, 4x scale.
- **`RealESRNet_x4plus`** (RRDBNet): Less perceptual hallucination, smoother gradients.
- **`RealESRGAN_x4plus_anime_6B`** (Compact RRDBNet, 6 blocks): Faster, optimized for 2D animation.
- **`realesr-animevideov3`** (SRVGGNetCompact): Ultra-lightweight feed-forward video model (ideal for 60fps anime/cartoon footage on iGPU).
- **Scale Factors**: 4x (native) and 2x (via bicubic downscale or native 2x model).

### 2.2 Conversion & Intermediate Representation (IR)
1. **Dynamic Shapes with Spatial Upper Bound**:
   To avoid memory exhaustion on systems with shared unified memory (16GB RAM):
   - Export ONNX with dynamic spatial dimensions: `[1, 3, H, W]`.
   - Convert to OpenVINO IR (`FP16`):
     ```python
     import openvino as ov

     ov_model = ov.convert_model("realesrgan_x4plus.onnx")
     ov.save_model(ov_model, "realesrgan_x4plus_fp16.xml", compress_to_fp16=True)
     ```
2. **Model Caching**:
   Enable OpenVINO persistent compilation cache:
   ```python
   core.set_property("cache_dir", "mtapi-project/junk/models/realesrgan/cache")
   ```
   First compile takes ~5-10s; subsequent boots load in <100ms.
3. **Weight Location (Invariant 8)**:
   Weights and IR files live in `mtapi-project/junk/models/realesrgan/`.

---

## 3. Memory & Tiling Strategy for Intel Iris Xe

On Intel Iris Xe (80 EU, shared system memory), allocating a single gigantic 4K intermediate tensor during RRDBNet forward pass can trigger kernel driver resets.

### 3.1 Dual Execution Modes
1. **Direct Mode (for input $\le 1280\times 1280$)**:
   - Matches the strategy in `nekofoo/Real-ESRGAN-For-Intel-GPU`.
   - Single forward pass on the dynamic shape tensor. Extremely fast because zero tile assembly overhead is incurred.
2. **Tiled Mode (for input $> 1280\times 1280$ or low-VRAM settings)**:
   - Split input into tiles of size $T \times T$ (default $400\times 400$ or $512\times 512$).
   - Overlap margin $M = 32$ pixels.
   - Upscale each tile with padding.
   - Blend overlapping seams using linear cosine/triangular weighting to prevent visible grid boundaries.
   - Reassemble the output canvas.

---

## 4. Filter Platform Contract

Integrates into the existing upscale architecture without breaking existing workflows:

### 4.1 Filter Stage (`app/filters/upscale.py`)
Add `engine="openvino"` as a first-class choice alongside `"realesrgan"` (NCNN) and `"srmd"`:

```python
async def run_upscale_openvino_directory(
    src_dir: Path,
    dst_dir: Path,
    *,
    model_name: str = "RealESRGAN_x4plus",
    scale: int = 4,
    device: str = "GPU",
    tile_size: int = 400,
    max_direct_size: int = 1280,
) -> dict[str, Any]:
    ...
```

- **Stage Kind**: `directory`.
- Reads `frame_%06d.png` from `src_dir`.
- Performs in-process OpenVINO inference.
- Writes upscaled `frame_%06d.png` to `dst_dir`.
- Reports real-time progress via `job_control.report_progress(i, total, phase="Upscaling (OpenVINO iGPU)")`.

### 4.2 HTTP Op (`app/operations/upscale_ops.py`)
- Op parameter `engine`: Defaults to `"openvino"` on Linux systems when Intel GPU is detected via `ov.Core().available_devices`.
- Parameters:
  - `model`: Model name / variant.
  - `scale`: 2 or 4.
  - `device`: `"GPU"` (Iris Xe), `"CPU"`, or `"AUTO"`.
  - `tile_size`: Tile size in pixels (0 for un-tiled direct mode).
- Staged execution: Handled via `run_staged_job` (dump -> upscale directory stage -> encode to output codec).

---

## 5. WebUI & Settings Integration

- **Tab**: "Upscale" tab (`js/tabs/upscale.js`).
- **Engine Selector**: Dropdown offering:
  - `OpenVINO (Intel iGPU / Arc)` — Recommended.
  - `NCNN Vulkan (Real-ESRGAN)` — Legacy fallback.
- **Hardware Pill**: Displays real-time detected device status: `Intel Iris Xe Graphics (GPU: v12.3.0)`.
- **Tile Slider**: Auto / 256 / 400 / 512 / Off.

---

## 6. Verification Plan

1. **Benchmarking & Parity**:
   - Verify 4x upscale on standard $640\times 360$ and $1280\times 720$ test images.
   - Compare throughput (fps) between NCNN Vulkan and OpenVINO on the Iris Xe iGPU.
2. **Seamless Tiling Verification**:
   - Upscale a high-resolution frame ($1920\times 1080 \to 7680\times 4320$) using tiled mode.
   - Inspect tile overlap seams for discoloration or discontinuity (gradient diff < 1 LSB).
3. **Safety & Guard Rails**:
   - Out of bounds protection on extreme image sizes.
   - Verify HTTP 200 + `{"ok": false}` error response on invalid weights or corrupt images (Invariant 10).
   - `./check-gate.sh` must remain 5/5 green.
