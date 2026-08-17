# Coder Prompt — VQGAN+CLIP (`vqgan`)

> **Target**: ffTransmuteWebui — new standalone operation + new WebUI tab
> **Spec reference**: `docs/vqgan-spec.md` (same directory)

---

## MISSION
Implement a "VQGAN+CLIP" operation that generates surreal images from a text prompt using PyTorch IPEX (`xpu`) for Intel Xe hardware acceleration.

## PHASE 1 — BACKEND: `vqgan_ops.py`
Create `mtapi-project/app/operations/vqgan_ops.py`.
Define Pydantic schema `VQGANParams` with `prompt` (str) and `steps` (int).

**Requirements:**
1. **Dependencies**: `torch`, `torchvision`, `intel_extension_for_pytorch` (IPEX), `transformers` (for CLIP).
2. **Device**: Explicitly use `device = torch.device("xpu")` to target the iGPU.
3. **Execution Loop**:
   - Wrap the forward/loss passes in `with torch.xpu.amp.autocast(enabled=True, dtype=torch.float16):`
   - Use standard Adam optimizer on the latent `z` tensor.
   - Use `CLIP` (e.g., `openai/clip-vit-base-patch32`) to encode the prompt and the random image cutouts.
4. **Resolution**: Lock generation resolution to `256x256`.

Register the operation. Import in `__init__.py`.

## PHASE 2 — FRONTEND: app.js + index.html
- Add `vqgan` tab under "Hallucination".
- Form: Text input for the prompt, number slider for steps (10-500).
- Add routing and execution logic.
