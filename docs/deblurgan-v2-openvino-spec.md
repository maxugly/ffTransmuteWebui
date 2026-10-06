# DeblurGAN-v2 OpenVINO Motion Deblurring Spec

> **Status:** Draft / Specification  
> **Audience:** Builders implementing video motion deblurring on Intel iGPU  
> **Related:** `filter-platform-spec.md`, `realesrgan-openvino-spec.md`  
> **Upstream:** [DeblurGAN-v2 (Kupyn et al., ICCV 2019)](https://github.com/KupynOrest/DeblurGANv2) · [OpenVINO Model Zoo Image Processing Demo](https://docs.openvino.ai/2023.3/omz_demos_image_processing_demo_cpp.html)

---

## 1. Goal

Integrate **DeblurGAN-v2** for high-speed single-image and frame-by-frame video motion deblurring, targeting Intel Iris Xe Graphics via OpenVINO.

DeblurGAN-v2 is an efficient, feed-forward conditional GAN with a Feature Pyramid Network (FPN) architecture designed specifically for real-time deblurring of motion-blurred and defocus-blurred frames (e.g. handheld camera shake, fast action movement, sports sequences).

Because it uses a lightweight FPN backbone (MobileNet-v2 or Inception-ResNet-v2), it provides a very small memory and compute footprint, making it ideal for streaming video processing on Intel iGPUs.

---

## 2. Model Architecture & OpenVINO Availability

### 2.1 Backbones
DeblurGAN-v2 supports multiple encoder backbones:
1. **MobileNet-v2 (Lightweight / Real-time)**:
   - Designed for mobile and edge devices.
   - Minimal latency (~15–25ms per 720p frame on Iris Xe iGPU).
   - Recommended default for video sequence processing.
2. **Inception-ResNet-v2 (High Quality)**:
   - Higher capacity, deeper feature extraction.
   - Recommended for high-detail single stills and photography.

### 2.2 Model Zoo & Conversion Workflow
DeblurGAN-v2 is directly supported in the OpenVINO Model Zoo (OMZ):
1. **Download via OpenVINO OMZ Tools**:
   ```bash
   omz_downloader --name deblurgan-v2 --output_dir mtapi-project/junk/models/deblurgan/
   omz_converter --name deblurgan-v2 --download_dir mtapi-project/junk/models/deblurgan/
   ```
2. **Direct ONNX to OpenVINO IR Export**:
   If converting from PyTorch weights (`deblurgan_v2.pth`):
   ```python
   import torch
   import openvino as ov

   model = load_deblurgan_v2(backbone="mobilenetv2")
   model.eval()
   dummy_input = torch.randn(1, 3, 720, 1280)
   torch.onnx.export(
       model,
       dummy_input,
       "deblurgan_v2_mobilenetv2.onnx",
       opset_version=14,
       input_names=["image"],
       output_names=["deblurred_image"],
       dynamic_axes={"image": {2: "height", 3: "width"},
                     "deblurred_image": {2: "height", 3: "width"}},
   )

   ov_model = ov.convert_model("deblurgan_v2_mobilenetv2.onnx")
   ov.save_model(ov_model, "deblurgan_v2_mobilenetv2_fp16.xml", compress_to_fp16=True)
   ```
3. **Storage**:
   Weights reside in `mtapi-project/junk/models/deblurgan/` (Invariant 8).

---

## 3. Hardware & iGPU Execution

- **Target Device**: `GPU` (Intel Iris Xe) with `CPU` fallback.
- **Precision**: `FP16` IR. DeblurGAN-v2 uses standard convolutions, depthwise convolutions, and FPN lateral additions, executing with zero precision instability under FP16 on Iris Xe.
- **Padding Requirements**: FPN downsampling requires input height and width to be divisible by 32 (or 16).
  - Preprocessing pads dimensions to the nearest multiple of 32 (reflect padding or edge replication).
  - Postprocessing un-pads the output back to the original frame dimensions.
- **Normalization**:
  - Input: RGB normalized to $[-1.0, 1.0]$ or $[0.0, 1.0]$ depending on backbone checkpoint.
  - Output: Clamped to $[0, 255]$ uint8.

---

## 4. Filter Platform Contract

Following Invariant 1 and `filter-platform-spec.md`:

### 4.1 Filter Stage (`app/filters/deblur.py`)
- **Stage Kind**: `directory` (loads compiled OpenVINO IR once, processes sequence of `frame_%06d.png`, writes output frames).
- **Signature**:
  ```python
  async def run_deblur_directory(
      src_dir: Path,
      dst_dir: Path,
      *,
      backbone: str = "mobilenetv2",
      device: str = "GPU",
      strength: float = 1.0,
  ) -> dict[str, Any]:
      ...
  ```
- **Strength Parameter**:
  Enables continuous blending between original blurred frame and deblurred result:
  $$\text{Out} = (1.0 - s) \cdot \text{In} + s \cdot \text{DeblurGAN}$$
  This avoids over-sharpening or unnatural edge halos when mild deblurring is desired.
- **Progress Reporting**: Calls `job_control.report_progress(i, total, phase="Deblurring")` every frame (Invariant 9).

### 4.2 HTTP Op (`app/operations/deblur_ops.py`)
- Endpoint: `POST /ops/deblur`
- Input parameters:
  - `input_path`: Source video or image path.
  - `backbone`: `"mobilenetv2"` (default) or `"inception_resnet_v2"`.
  - `strength`: Float between 0.0 and 1.0 (default 1.0).
  - `device`: `"GPU"`, `"CPU"`, or `"AUTO"`.
  - `dry_run`: Returns planned execution pipeline.
- Uses `run_staged_job` (dump -> `deblur` directory stage -> encode).
- Errors return HTTP 200 + `{"ok": false, ...}` (Invariant 10).

---

## 5. WebUI Integration

- **Tab**: "Deblur" in the Clean / Enhance category (`js/tabs/deblur.js`, `css/deblur.css`).
- **UI Elements**:
  - Backbone selector (`MobileNet-v2 (Fast)` / `Inception-ResNet-v2 (Quality)`).
  - Deblur Strength slider (0% to 100%).
  - Device pill (GPU / CPU indicator).
  - Compare A/B preview support (viewing blurred input vs restored frame).
  - Standard Run and Dry Run dispatch buttons.

---

## 6. Verification Plan

1. **Synthetic Motion Blur Test**:
   - Apply artificial linear motion blur kernel (e.g. 15px at 45°) to a sharp test image.
   - Run OpenVINO DeblurGAN-v2 stage on Intel Iris Xe GPU.
   - Measure PSNR / SSIM improvement (SSIM should increase by $\ge 0.15$).
2. **Video Sequence Test**:
   - Process a 5-second 1080p24 video clip.
   - Confirm frame counts match exactly, PTS and audio sync are preserved.
   - Ensure zero memory growth across 120 frames.
3. **Hardware Parity**:
   - Confirm GPU output matches CPU output within FP16 numerical tolerance.
   - `./check-gate.sh` must remain 5/5 green.
