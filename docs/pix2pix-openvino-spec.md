# pix2pix OpenVINO Filter Spec

> **Status:** Draft / Specification  
> **Audience:** Builders implementing paired image-to-image translation on Intel iGPU  
> **Related:** `filter-platform-spec.md`, `img2img-openvino-spec.md`, `styletransfer-spec.md`  
> **Upstream:** [phillipi/pix2pix](https://github.com/phillipi/pix2pix) · [junyanz/pytorch-CycleGAN-and-pix2pix](https://github.com/junyanz/pytorch-CycleGAN-and-pix2pix) (Torch/PyTorch, BSD-2-Clause)

---

## 1. Goal

Implement a fast, deterministic conditional image-to-image translation stage using **pix2pix** (Isola et al., CVPR 2017) running natively via **OpenVINO** on Intel integrated GPUs (Iris Xe 80 EU / Arc) and CPU.

pix2pix operates as a paired image translation generator $G: X \to Y$. Common practical presets and custom models include:
- Edge/Sketch to Photo (`edges2shoes`, `edges2handbags`, line art rendering)
- Day to Night and Night to Day transformation
- Facades & architectural rendering
- Thermal / Infrared to RGB synthesis
- Semantic segmentation map to photorealistic scene
- Custom trained paired checkpoint weights (`.pth`)

The feature integrates into the `ffTransmuteWebui` filter platform for single stills and frame-by-frame video sequences, preserving audio and timing.

---

## 2. Technical Requirements & Model Strategy

### 2.1 Model Architecture
The canonical pix2pix generator is a **U-Net 256** (8 downsamplings and 8 upsamplings with skip connections) or a **ResNet 9-block** feed-forward generator.
- **Input:** RGB tensor `[1, 3, H, W]`, float32 normalized to $[-1.0, 1.0]$.
- **Output:** RGB tensor `[1, 3, H, W]`, float32 with Tanh activation in $[-1.0, 1.0]$, de-normalized back to $[0, 255]$ uint8.
- **Spatial Geometry:** Fixed 256×256 or 512×512 native canvas, or dynamic shape `[1, 3, -1, -1]` where spatial dimensions are multiples of 32 (to satisfy downsampling strides).

### 2.2 OpenVINO Conversion Workflow
1. **PyTorch to ONNX**:
   ```python
   import torch

   model = load_pix2pix_generator(checkpoint_path)
   model.eval()
   dummy_input = torch.randn(1, 3, 256, 256)
   torch.onnx.export(
       model,
       dummy_input,
       "pix2pix_generator.onnx",
       opset_version=14,
       input_names=["input_image"],
       output_names=["output_image"],
       dynamic_axes={"input_image": {2: "height", 3: "width"},
                     "output_image": {2: "height", 3: "width"}},
   )
   ```
2. **ONNX to OpenVINO IR**:
   ```python
   import openvino as ov

   core = ov.Core()
   model = ov.convert_model("pix2pix_generator.onnx")
   # FP16 half precision for iGPU execution
   ov.save_model(model, "pix2pix_fp16.xml", compress_to_fp16=True)
   ```
3. **Weight Storage (Invariant 8)**:
   - Weights stored under `mtapi-project/junk/models/pix2pix/<preset>/`.
   - Setup op (`/ops/pix2pix_setup`) manages download of standard presets and conversion to IR.

### 2.3 Hardware & iGPU Target
- **Primary Device**: `GPU` (Intel Iris Xe / Arc).
- **Fallback**: `CPU` if GPU initialization fails or memory is constrained.
- **Compilation Cache**: Set `core.set_property("cache_dir", ...)` to avoid re-compilation delays on subsequent runs.
- **Precision**: FP16 IR works cleanly with standard Conv2d/BatchNorm/ReLU/LeakyReLU/Tanh blocks without spectral precision degradation.

---

## 3. System Architecture & Filter Platform Contract

Following Invariant 1 (`dump -> app/filters/* -> encode`):

```text
Input Media (Video/Image Pool)
         │
         ▼
`app/operations/pix2pix_ops.py` (HTTP endpoint POST /ops/pix2pix)
         │
         ▼
`video_pipeline.dump_frames` -> `JobWorkspace.frames_in` (`frame_%06d.png`, start 0)
         │
         ▼
`app/filters/pix2pix.py` (Kind: directory, OpenVINO inference on GPU)
         │
         ▼
`video_pipeline.encode` <- `JobWorkspace.frames_out` (audio preserved)
         │
         ▼
Final Output Media (Registered to Output / Pools)
```

### 3.1 Stage Specification (`app/filters/pix2pix.py`)
- **Stage Kind**: `directory` (loads compiled OpenVINO model once, executes frame by frame with `report_progress()`).
- **Processing Signature**:
  ```python
  async def pix2pix_directory_stage(
      src_dir: Path,
      dst_dir: Path,
      *,
      preset: str = "edges2shoes",
      device: str = "GPU",
      tile_size: int = 512,
      blend: float = 1.0,
      custom_model_path: str | None = None,
  ) -> dict[str, Any]:
      ...
  ```
- **Frame Sizing & Tiling**:
  - For small resolutions ($\le 512\times 512$): Direct dynamic inference or letterbox/crop.
  - For high resolutions ($> 512\times 512$): Option between sliding-window overlapping tiles (with Hann window edge blending) or scaling down to native model canvas and scaling back up.
  - `blend` parameter: Alpha mix between original input and pix2pix output:
    $$\text{Out} = (1.0 - \alpha) \cdot \text{In} + \alpha \cdot \text{Pix2Pix}$$

### 3.2 HTTP Operations Contract
- `POST /ops/pix2pix`:
  - Request body:
    - `input_path`: Absolute path to source image or video.
    - `preset`: Preset identifier or path to custom `.xml` / `.pth`.
    - `device`: `"GPU"` (default), `"CPU"`, or `"AUTO"`.
    - `blend`: Float 0.0 to 1.0 (default 1.0).
    - `dry_run`: Boolean (returns planned commands/parameters without running).
  - Response: Follows Invariant 10 (`HTTP 200` + `{"ok": true/false, ...}`).
- `POST /ops/pix2pix_setup`:
  - Downloads preset checkpoints and compiles IR for the chosen device.
- `GET /api/pix2pix/status`:
  - Returns installed presets, OpenVINO device availability, and compilation cache status.

---

## 4. Frontend & WebUI Integration

- **Tab**: "pix2pix" in Transform / AI section (`js/tabs/pix2pix.js`, `css/pix2pix.css`).
- **Controls**:
  - Preset select (`edges2shoes`, `facades`, `day2night`, `custom`).
  - Custom model picker (browse for `.xml` or `.pth`).
  - Device select (`GPU`, `CPU`, `AUTO`).
  - Blend slider (0.0 to 1.0 with real-time percentage badge).
  - Dry run toggle + Run button wired to `runOpWithCancel`.
- **Progress**: Monitored via standard job drawer; calls `job_control.report_progress()` every frame.

---

## 5. Verification Plan

1. **Unit Tests (`tests/test_pix2pix.py`)**:
   - Verification of tensor preprocessing and normalization ($[-1, 1]$ clamp).
   - Mocked OpenVINO inference returning expected spatial shapes.
   - Dry run contract verification.
   - Blend interpolation math correctness.
2. **Device Hardware Verification**:
   - Intel Iris Xe GPU execution test on synthetic 256×256 fixture.
   - Bit-level check that GPU output matches CPU within standard FP16 delta ($\Delta < 0.01$).
3. **End-to-End WebUI Verification**:
   - Gate check `./check-gate.sh` must be 5/5 green.
   - Playwright run: Load image/video from Pool -> Run pix2pix -> Confirm output registered and playable.
