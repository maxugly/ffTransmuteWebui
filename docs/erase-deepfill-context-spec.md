# Inpainting Model Options for Erase Tab: DeepFill & Context Encoders Spec

> **Status:** Draft / Specification  
> **Audience:** Builders expanding inpainting backends in the Erase tab on Intel iGPU  
> **Related:** `erase-tab-spec.md`, `filter-platform-spec.md`, `intel_gpu_5d_bug_workaround.md`  
> **Upstream:**
> - DeepFill v2: [JiahuiYu/generative_inpainting (ICCV 2019)](https://github.com/JiahuiYu/generative_inpainting) (Free-Form Inpainting with Gated Convolutions)
> - DeepFill v1: [JiahuiYu/generative_inpainting (CVPR 2018)](https://github.com/JiahuiYu/generative_inpainting) (Contextual Attention)
> - Context Encoders: [pathak22/context-encoder (CVPR 2016)](https://github.com/pathak22/context-encoder) (Feature Learning by Inpainting)

---

## 1. Goal

Provide additional inpainting model options in the existing **Erase Tab** (`app/filters/erase.py` and `js/tabs/erase.js`) alongside LaMa (`Carve/LaMa-ONNX`).

While LaMa excels at large structural completions due to its Fast Fourier Convolutions (FFC), alternative architectures offer unique strengths and distinct filling styles:
1. **DeepFill v2 (Gated Convolutions)**: Outstanding on organic textures, blemishes, scratches, text removal, and complex non-periodic backgrounds. Uses learnable gating channels instead of vanilla convolutions, naturally handling irregular free-form masks without edge artifacts.
2. **DeepFill v1 (Contextual Attention)**: Explicitly copies known background patches into the missing hole via a contextual attention cosine similarity matrix. Ideal for repetitive patterned scenes (brick walls, fences, foliage).
3. **Context Encoders**: Compact, classical convolutional encoder-decoder with a channel-wise bottleneck. Ultra-fast, low-parameter model ideal for quick fills and tiny blemishes on low-power devices.

All models will reuse the Erase tab's existing canvas overlay, mask drawing tools, 25% area cap, and iopaint HD cropping strategies (`Original`, `Crop`, `Resize`).

---

## 2. Architecture Comparison & Capabilities

| Feature | LaMa (Shipped) | DeepFill v2 (Gated Conv) | DeepFill v1 (Contextual Attn) | Context Encoders |
|---|---|---|---|---|
| **Core Mechanism** | Fast Fourier Convolutions (FFC) | Gated 2D Convolutions + SN-PatchGAN | Two-Stage (Coarse + Contextual Attention) | Encoder-Decoder + Bottleneck |
| **Mask Type** | Rectangular & free-form | Arbitrary free-form brush strokes | Free-form / Rectangular | Rectangular / Bounding box |
| **Hole Specialization** | Large structural & repetitive objects | Irregular organic scratches, text, marks | Pattern replication from distant pixels | Small central/local holes |
| **Intel iGPU Precision** | Required `inference_precision=f32` (FFC 5D MatMul) | **Native FP16** (standard Conv2d) | **Native FP16** | **Native FP16** |
| **Input Shape** | Fixed 512×512 (dynamic breaks irfft) | Dynamic `[1, 4, H, W]` or 512×512 | Fixed 256×256 or 512×512 | Fixed 256×256 |
| **Latency on Iris Xe** | ~80–120ms / crop | ~60–90ms / crop | ~100–140ms / crop | ~15–30ms / crop |

---

## 3. OpenVINO Conversion Workflow

### 3.1 DeepFill v2 (Gated Convolution)
DeepFill v2 takes a 4-channel input: 3 RGB channels (with masked area zeroed or mean-filled) + 1 binary mask channel ($0.0 = \text{keep}, 1.0 = \text{hole}$).

1. **PyTorch to ONNX**:
   ```python
   import torch

   model = load_deepfillv2_generator("deepfillv2_wgan.pth")
   model.eval()

   # 4-channel input: [batch, 4, H, W]
   dummy_input = torch.randn(1, 4, 512, 512)
   torch.onnx.export(
       model,
       dummy_input,
       "deepfill_v2.onnx",
       opset_version=14,
       input_names=["image_and_mask"],
       output_names=["completed_image"],
       dynamic_axes={"image_and_mask": {2: "height", 3: "width"}},
   )
   ```
2. **ONNX to OpenVINO IR**:
   ```python
   import openvino as ov

   core = ov.Core()
   ov_model = ov.convert_model("deepfill_v2.onnx")
   ov.save_model(ov_model, "deepfill_v2_fp16.xml", compress_to_fp16=True)
   ```
   *Note: Because DeepFill v2 uses standard gated 2D convolutions without spectral Fourier transforms, it compiles cleanly in FP16 on Intel Iris Xe without the 5D MatMul precision issues experienced with LaMa.*

### 3.2 Context Encoders
Context Encoders take a 3-channel input `[1, 3, 256, 256]` with the masked region initialized to the channel mean (or zero), returning the predicted complete image `[1, 3, 256, 256]`.
- Converted directly to OpenVINO IR (`context_encoder_fp16.xml`).
- Runs at ~30ms per pass on Iris Xe.

### 3.3 Weight Storage (Invariant 8)
- DeepFill v2: `mtapi-project/junk/models/deepfill_v2/` (`deepfill_v2_fp16.xml`, `deepfill_v2_fp16.bin`).
- Context Encoder: `mtapi-project/junk/models/context_encoder/` (`context_encoder_fp16.xml`).

---

## 4. Integration with Shipped Erase Tab

The Erase tab architecture already provides the ideal harness:

```text
User Mask (Paint Canvas or Rect) -> Area Cap (<= 25%)
                                            │
                                            ▼
                    HD Strategy (Original / Crop / Resize)
                                            │
                                            ▼
            Model Dispatcher: [LaMa | DeepFill v2 | Context Encoder]
                                            │
                                            ▼
            Inference on Intel iGPU (OpenVINO IR)
                                            │
                                            ▼
            Composite: Paste masked area only (mask < 127 keep original)
```

### 4.1 Backend Dispatch (`app/filters/erase.py`)
Extend `erase.py` to support multiple model backends:

```python
EraseModelBackend = Literal["lama", "deepfill_v2", "context_encoder"]

def get_compiled(
    model_dir: Path | str,
    device: str = "GPU",
    backend: EraseModelBackend = "lama",
) -> tuple[Any, str]:
    ...
```

- When `backend == "lama"`: Forces `hint.inference_precision=f32` on GPU (protects spectral MatMul chains).
- When `backend in ("deepfill_v2", "context_encoder")`: Uses native FP16 execution on GPU.
- Normalization & Mask Formatting:
  - DeepFill v2 receives concatenated 4D tensor `cat([img_norm, mask_bin], dim=1)`.
  - Output is un-normalized and composited into the destination crop using the exact same `mask < 127` blend rule.

### 4.2 HTTP Op Contract (`app/operations/erase_ops.py`)
- Op parameter `model`: `"lama"` (default), `"deepfill_v2"`, or `"context_encoder"`.
- All other contracts (staged video run, single image execution, `dry_run`, HTTP 200 + `ok:false` on failure) remain strictly preserved.

---

## 5. WebUI & Frontend Integration

- **Tab**: `js/tabs/erase.js`.
- **New Control**: Model Selector dropdown placed in the Erase settings card:
  - `LaMa (Default - Structural & Large)`
  - `DeepFill v2 (Gated Conv - Textures & Text)`
  - `Context Encoder (Fast - Small Holes)`
- **HD Strategy & Brush Parity**: Works identically across all models. The user paints the mask, selects the model, and clicks Run.

---

## 6. Verification Plan

1. **Parity Tests (`tests/test_erase.py`)**:
   - Verify all backends respect the 25% mask area cap (`check_mask_area`).
   - Verify unmasked pixels are preserved bit-identically across all backends.
2. **GPU vs CPU Bit-Check**:
   - Run DeepFill v2 on Iris Xe GPU and CPU.
   - Confirm mean absolute difference $\le 1.0$ (no spectral explosion).
3. **End-to-End Test**:
   - Erase watermarks/text from test frames using DeepFill v2.
   - Verify `./check-gate.sh` passes 5/5 green.
