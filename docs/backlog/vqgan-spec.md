# VQGAN+CLIP (`vqgan`)

## Concept
Text-to-Surreal-Image generation using VQGAN (decoder) and CLIP. Because it relies on iterative backpropagation to optimize the latent vector, it produces organic, dream-like hallucinations as it morphs over hundreds of steps.

## Architecture & Hardware Guardrails
- **Backend**: IPEX (`intel_extension_for_pytorch`). OpenVINO is purely for forward-inference, so we cannot use it here because VQGAN+CLIP relies on autograd to update the `z` vector.
- **Hardware Target**: Intel Iris Xe iGPU. We must set `device="xpu"` and wrap the forward loop in `torch.xpu.amp.autocast(dtype=torch.float16)` to execute natively on the Intel iGPU using mixed precision.
- **Resolution Constraint**: `256x256` max to fit comfortably in the 16GB shared RAM alongside the CLIP and VQGAN weights. The VQGAN latent space is `16x16` (factor `f=16`).

## Implementation Design (Pipeline)
1. User provides a Text Prompt.
2. Initialize latent `z` of shape `(1, 256, 16, 16)` as `requires_grad=True`.
3. Loop 150-300 times:
   - Decode `z` with VQGAN to image `X`.
   - Take 16 random cutouts (crops/rotations) of `X`.
   - Encode cutouts with CLIP Image Encoder.
   - Compute Cosine Distance loss between image embeddings and text embedding.
   - Backpropagate loss to update `z`.
4. Return final image `X`. (Optional: save intermediate frames as a video showing the hallucination process).

## Parameter Schema
- `prompt` (string): The text target (e.g. "a surreal digital painting of a cosmic eye").
- `steps` (int): Number of iterations. Default 150.

## UI Requirements
- Found under "Hallucination" tab.
- Text input for prompt.
- Slider for iterations.
