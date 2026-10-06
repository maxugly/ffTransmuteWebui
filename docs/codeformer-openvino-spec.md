# CodeFormer OpenVINO Face Restoration Spec

> **Status:** Draft / Specification  
> **Audience:** Builders implementing face restoration on Intel iGPU  
> **Related:** `filter-platform-spec.md`, `realesrgan-openvino-spec.md`, `facemorph-spec.md`  
> **Upstream:** [sczhou/CodeFormer (NeurIPS 2022)](https://github.com/sczhou/CodeFormer) (S-T Chen et al., S-Lab, NTU, BSD-3-Clause)

---

## 1. Goal

Implement blind **face restoration and enhancement** using **CodeFormer** accelerated via **OpenVINO** on Intel Integrated Graphics (Iris Xe 80 EU) and CPU.

CodeFormer formulates face restoration as a Code Prediction task using discrete **Codebook Priors** (VQ-GAN codebook). It excels at recovering heavily degraded, blurry, noisy, or low-resolution faces while preserving natural facial identity. A continuous fidelity weight $w$ allows users to dynamically trade off between codebook quality (sharpness) and input fidelity (identity consistency).

---

## 2. Face Pipeline Architecture

Face restoration operates as a multi-step pipeline per frame:

```text
Full Frame (e.g. 1080p)
         │
         ▼
1. Face Detection & Landmark Extraction (RetinaFace / OpenVINO face detector)
         │
         ▼
2. 5-Point Affine Alignment & Normalization (Crop 512×512 face chips)
         │
         ▼
3. CodeFormer Neural Inference (OpenVINO IR on Intel iGPU)
   - Inputs: Aligned face [1, 3, 512, 512], fidelity weight w in [0.0, 1.0]
   - Output: Restored face [1, 3, 512, 512]
         │
         ▼
4. Inverse Affine Transform & Feathered Blending
   - Inverse warp restored 512×512 face back to original frame coordinates
   - Smooth alpha mask blending at boundary (no harsh seam cuts)
         │
         ▼
Restored Full Frame (Optional Real-ESRGAN background upsample pass)
```

---

## 3. OpenVINO Conversion Workflow

### 3.1 CodeFormer Model Export
The core CodeFormer network takes an aligned 512×512 face and an optional scalar fidelity weight $w \in [0.0, 1.0]$:

1. **PyTorch to ONNX**:
   ```python
   import torch

   model = load_codeformer_model("codeformer.pth")
   model.eval()

   dummy_img = torch.randn(1, 3, 512, 512)
   dummy_w = torch.tensor([0.7], dtype=torch.float32)

   torch.onnx.export(
       model,
       (dummy_img, dummy_w),
       "codeformer.onnx",
       opset_version=14,
       input_names=["face_image", "fidelity_weight"],
       output_names=["restored_face"],
       dynamic_axes={"face_image": {0: "batch_size"}},
   )
   ```
2. **ONNX to OpenVINO IR (`FP16`)**:
   ```python
   import openvino as ov

   core = ov.Core()
   model = ov.convert_model("codeformer.onnx")
   ov.save_model(model, "codeformer_fp16.xml", compress_to_fp16=True)
   ```

### 3.2 Face Detector Model
Use an OpenVINO-native face detection model to avoid foreign dependencies:
- **Option A (OMZ)**: `face-detection-retail-0005` or `face-detection-0205` (extremely lightweight, optimized for Intel hardware).
- **Option B (RetinaFace)**: `retinaface_resnet50` or `retinaface_mobilenet0.25` converted to OpenVINO IR for 5-point landmark extraction (`left_eye`, `right_eye`, `nose`, `left_mouth`, `right_mouth`).

### 3.3 Weight Storage (Invariant 8)
All models reside under:
`mtapi-project/junk/models/codeformer/` (`codeformer_fp16.xml`, `retinaface_fp16.xml`).

---

## 4. Hardware & iGPU Execution

- **Target Device**: `GPU` (Iris Xe) with `CPU` fallback.
- **Fixed Tensor Shapes**: Because CodeFormer operates on canonical 512×512 aligned chips, the model uses fixed input shapes `[1, 3, 512, 512]`. Fixed shapes allow OpenVINO to heavily optimize kernel execution and buffer reuse on Iris Xe.
- **Batching**: If multiple faces are detected in a single frame, infer them in a batch `[B, 3, 512, 512]` up to $B=4$, or sequentially.
- **Cache**: Persistent compilation cache enabled via `ov::cache_dir`.

---

## 5. Filter Platform Contract

Following Invariant 1 (`dump -> app/filters/* -> encode`):

### 5.1 Filter Stage (`app/filters/codeformer.py`)
- **Stage Kind**: `directory`.
- **Signature**:
  ```python
  async def run_codeformer_directory(
      src_dir: Path,
      dst_dir: Path,
      *,
      fidelity_weight: float = 0.7,
      face_upsample: bool = True,
      bg_upscale: bool = False,
      device: str = "GPU",
  ) -> dict[str, Any]:
      ...
  ```
- **Fidelity Weight ($w$)**:
  - $w = 0.0$: Maximum hallucination / sharpest features (best for extreme blur/destruction).
  - $w = 0.7$: Default balanced restoration (natural texture + identity preservation).
  - $w = 1.0$: Maximum identity adherence (best for mild blur / noise).
- **Background Upscale (`bg_upscale`)**:
  - If enabled, invokes the OpenVINO Real-ESRGAN stage on the background frame so the restored face does not look unnaturally sharp against a blurry body/background.
- **Progress**: Calls `job_control.report_progress(i, total, phase="Restoring Faces")` per frame.

### 5.2 HTTP Op (`app/operations/codeformer_ops.py`)
- Endpoint: `POST /ops/face_restore`
- Input parameters:
  - `input_path`: Path to video or still image.
  - `fidelity_weight`: Float 0.0 to 1.0 (default 0.7).
  - `face_upsample`: Boolean (default true).
  - `bg_upscale`: Boolean (default false).
  - `device`: `"GPU"`, `"CPU"`, `"AUTO"`.
  - `dry_run`: Returns planned pipeline description.
- Returns HTTP 200 + `{"ok": true/false, ...}` (Invariant 10).

---

## 6. WebUI Integration

- **Tab**: "Face Restore" in the Clean / Enhance section (`js/tabs/face_restore.js`).
- **Controls**:
  - Fidelity slider (0.0 to 1.0 with visual indicator: "Creative Restoration" $\leftrightarrow$ "Identity Preservation").
  - Background Enhance checkbox (chains Real-ESRGAN).
  - Device selector (`GPU`, `CPU`, `AUTO`).
  - Compare viewer: Interactive split slider comparing detected face chips before and after restoration.

---

## 7. Verification Plan

1. **Alignment & Landmark Guard**:
   - Verify alignment matrices match canonical FFHQ coordinate standards.
   - Verify non-face frames pass through unaltered without crashing.
2. **Quality & Artifact Guard**:
   - Test portrait with known heavy JPEG compression artifacts.
   - Confirm mouth and eyes show no ghosting or warp boundary lines.
3. **Hardware & Gate**:
   - Execute test run on Intel Iris Xe GPU.
   - Verify `./check-gate.sh` passes 5/5 green.
