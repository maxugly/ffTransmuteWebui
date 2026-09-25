# DeepDream V3 Engine (Spec & Post-Mortem)

**Status:** Implemented — `gpu_v3` dynamic weighted ascent + `turbo` forward-only mode
**Intent:** Implement a dynamic multi-layer, fixed-shape GPU DeepDream engine using OpenVINO.

The V3 runtime lives in `mtapi-project/app/operations/deepdream_ov_engine_v3.py`.
The exporter is `mtapi-project/tools/export_v3.py`; build-only dependencies are listed in
`mtapi-project/tools/requirements-v3-export.txt`. Exported artifacts are written to
`mtapi-project/junk/models/deepdream_ov_v3/`.

## 1. Goal

The V3 engine was designed to overcome the limitations of the V1 and V2 OpenVINO GPU engines:
- **V1/V2 Limitations:** They rely on a single, statically baked target layer (typically `Mixed_6c`). They cannot respond to the UI's `layer_weights` dictionary, so the user cannot mix layers (e.g., combining fine geometric noise from `mixed4` with large slugs from `mixed6`).
- **V3 Solution:** Export a PyTorch graph that exposes the weighting coefficients for `5b`, `5c`, `6a`, `6b`, and `6c` as OpenVINO model inputs. The Python backend then passes the UI's `layer_weights` dictionary into the IR at runtime.
- **Turbo Mode:** A forward-only saliency stamping hack that skips the expensive backward pass. It paints the blown-up activation map directly onto the pixels, yielding a 3x speedup at the cost of fractal depth.

## 2. Architecture & Pipeline

### PyTorch Export (`export_v3.py`)
- The network blocks are manually isolated from `torchvision.models.inception_v3`.
- The loss function is a weighted sum: `loss = (w_5b * feats['5b'].mean() + ...)`.
- The gradient is computed natively in the graph: `grad = torch.autograd.grad(...)`.
- **Gradient Normalization:** The gradient is normalized by its standard deviation: `grad = grad / (grad.std() + 1e-8)`.
- **Step:** `new_image = image_tensor + learning_rate * grad`.

### Python Backend (`deepdream_ov_engine_v3.py`)
- Uses a fixed 512x512 pyramid (like V1/V2).
- Maps the UI's classic DeepDream layer names (`mixed4`, `mixed5`) to the PyTorch export's block names (`5b`, `5c`).
- Re-injects high-frequency detail at the very end of the script using a "Final Laplacian blend" (subtracting the upscaled low-frequency base from the original 1080p image, and superimposing those details onto the 512x512 neural output).

## 3. Post-Mortem: Why it was Nuked

The V3 prototype was structurally sound but mathematically unstable in practice, resulting in a "crazy wall of change" (blown-out pixels) or a "milky" loss of contrast. 

The core issues discovered during prototyping:

1. **Input Normalization Mismatch:** 
   By isolating the PyTorch `Inception3` blocks in the export script, the built-in `_transform_input` step (which normally maps `[-1, 1]` or ImageNet distributions internally) was bypassed. The network was fed raw `[0, 1]` pixels, causing massive, out-of-distribution forward activations. Attempts to correct this in Python (mapping to `[-1, 1]`) shifted the contrast too aggressively and produced a milky output.

2. **Aggressive Gradient Normalization:**
   The V3 IR normalized the gradient by `grad.std()`. Classic DeepDream (and presumably V1) scales the gradient by the absolute mean or max. Normalizing by standard deviation means that extreme "spikes" in the gradient can be 5x to 10x larger than the step size. Even with a small step (e.g., `0.025`), these spikes would quickly slam into the `1.0` pixel ceiling after just 3 or 4 iterations, creating a flat, blown-out wall of white noise instead of coherent fractals.

3. **Complex Interplay:**
   Balancing the input normalization, the `std()` gradient scale, and the learning rate scaling required too many fragile heuristics. When tuning one aspect (e.g., lowering the learning rate to stop blowouts), it destroyed another (e.g., losing all contrast).

## 4. Implemented V3 Technical Architecture

When we rebuild V3, it will follow this precise architecture to ensure stability while providing dynamic layer weighting and Turbo support.

### 4.1 PyTorch Export Graph (`export_v3.py`)

The graph will be exported as an OpenVINO static IR with the following properties:

**Inputs:**
- `image_tensor`: Shape `[1, 3, H, W]`, FP32, values in `[0.0, 1.0]`. The network *must* include its own internal `transform_input` layer (mapping to `[-1, 1]` or ImageNet norm) within the graph so the Python caller does not have to manage pixel math.
- `learning_rate`: Shape `[1]`, FP32.
- `layer_weights`: 5 individual FP32 inputs (or a shape `[5]` tensor) representing the UI's weights for `5b`, `5c`, `6a`, `6b`, and `6c`.

**Graph Logic:**
1. **Forward Pass:** The image passes through the standard InceptionV3 blocks. The activations of `5b`, `5c`, `6a`, `6b`, and `6c` are captured.
2. **Loss Calculation:** `loss = (w_5b * 5b.mean()) + (w_5c * 5c.mean()) + ...`
3. **Gradient Ascent:** 
   - `grad = torch.autograd.grad(loss, image_tensor)`
   - **Crucial Fix:** The gradient will be normalized using the classic absolute mean (or max), NOT standard deviation. `grad = grad / (grad.abs().mean() + 1e-8)`
4. **Step:** `new_image = image_tensor + (learning_rate * grad)`

**Outputs:**
- `dreamed_image`: Shape `[1, 3, H, W]`.

### 4.2 Python Engine (`deepdream_ov_engine_v3.py`)

The python side will act as a thin wrapper around the IR, just like V1, but with multi-weight support:

- **Shape Pyramid:** It will use the V2 512px pyramid approach to handle arbitrary input resolutions without recompiling the graph.
- **Layer Mapping:** The frontend UI sends weights using classic TF layer names (`mixed4`, `mixed5`, `mixed6`). The Python wrapper will map these dynamically to the OpenVINO IR inputs:
  - `mixed4` → `w_5b`
  - `mixed5` → `w_5c`
  - `mixed6` (default) → `w_6c`
- **Final Laplacian Blend:** To preserve the original high-frequency detail of a 1080p input image while dreaming at 512px, the engine will extract the high frequencies (`high = base - downscaled_upscaled_base`) and add them back to the final upscaled dreamed image before returning it.

### 4.3 Turbo Mode (Forward-Only Saliency)

Turbo mode will use a completely separate, simplified IR:
- **Graph:** Runs forward pass only. Captures the activation map of the chosen layer(s), normalizes it to `[0, 1]`, and returns it directly without calculating a gradient.
- **Python Side:** The Python wrapper scales the activation map up to the image resolution and uses a blend mode (e.g., overlay or add) to "stamp" it onto the original pixels.
- **Result:** A 3x speedup, sacrificing recursive fractal depth for a flatter, textured look.

### 4.4 Artifact and build contract

The exporter produces one ascent and one Turbo IR for each native shape in the fixed
512/1.4 pyramid:

```text
static_deepdream_v3_186x186_fp16.xml/.bin
static_deepdream_v3_261x261_fp16.xml/.bin
static_deepdream_v3_365x365_fp16.xml/.bin
static_deepdream_v3_512x512_fp16.xml/.bin
static_deepdream_v3_turbo_<shape>_fp16.xml/.bin
```

Build all artifacts from the project environment:

```bash
cd mtapi-project
uv pip install --python .venv/bin/python -r tools/requirements-v3-export.txt
.venv/bin/python tools/export_v3.py --kind both --octaves 4 \
  --out-dir junk/models/deepdream_ov_v3
```

The runtime resolves `$OVS_DD_V3_DIR`, then `junk/models/deepdream_ov_v3/`.
The V3 graph keeps ImageNet normalization and the weighted objective inside the IR,
uses absolute-mean gradient normalization, clamps to `[0, 1]`, and applies a final
Laplacian detail reinjection after the pyramid is resized back to the source dimensions.
Turbo uses the separate forward-only graph and performs its saliency stamp on the host.
