> **LEGACY — do not build from this file. STATUS.md is law.**

# Stable Diffusion Tiled Agent Upscale (`sd_tiled_upscale`)

> **Status:** Legacy one-shot draft (Gemini-era). **Do not build from this alone.**  
> **Canonical product design:** [`docs/tilagup-mtapi-mode-spec.md`](../tilagup-mtapi-mode-spec.md)  
> **Working reference implementation:** `/home/m/snc/cod/tilagup`  
> **Engine catalog:** [`docs/fastsdcpu-upscalers-spec.md`](../fastsdcpu-upscalers-spec.md)

## Concept
Leverages Stable Diffusion to not just upsample an image, but to *hallucinate* new detail in regions. The **real** system is multi-stage (base → tiles → optional zones → upscale) with dry-run and archives — not a single POST with one base prompt.

**Keep below only as a rough OpenVINO engine sketch.** Prompt hierarchy, CLIP fit, archives, and WebUI pause points live in the tilagup-mtapi spec.

## Architecture & Hardware Guardrails
- **Backend**: `diffusers` + `optimum-intel` (OpenVINO). This completely replaces the need for IPEX or PyTorch XPU for diffusion models.
- **Hardware Target**: Intel Iris Xe iGPU. Execution is triggered simply by exporting `DEVICE="gpu"` and loading the model through `optimum-intel`'s `OVStableDiffusionPipeline` or `OVStableDiffusionImg2ImgPipeline`.
- **Memory Optimization**: The pipeline inherently uses FP16 OpenVINO IR models. While tiling theoretically allows infinite resolution, the hardware sweet spot for Intel 1335U (16GB RAM) is a maximum target resolution of ~1024x1024. Exceeding this often causes aggressive RAM swapping or OOM.
- **Tiling**: Processes the image in overlapping 512x512 patches, using `diffusers` img2img. Ensure the final upscaled target canvas does not significantly exceed 1024x1024.

## Implementation Design (Pipeline)
1. **Model Loading**:
   - Use `OVStableDiffusionImg2ImgPipeline.from_pretrained(..., export=True, compile=False)` to load and export the model to OpenVINO IR on the fly (or load pre-converted IRs).
   - `pipeline.to("gpu")` and `pipeline.compile()`.
2. **Zone & Tile Logic**:
   - The user provides a **Base Prompt** (the 'soul' of the image).
   - The image is sliced into a grid of overlapping tiles.
   - (Optional/Advanced) The LLM agent generates short, CLIP-safe (<75 tokens) sub-prompts for each tile based on semantic zones.
3. **Execution Loop**:
   - For each tile: Run OpenVINO SD `img2img` with the Base Prompt + Tile Sub-Prompt, using a low `strength` (e.g., 0.35) to preserve the original structure while hallucinating new textures.
   - Blend the resulting tiles back together using a cosine window to eliminate seams.

## Parameter Schema
- `image_path` (string): Source image.
- `base_prompt` (string): The overall structural prompt.
- `strength` (float): Img2Img noise strength (0.1 to 0.7). Default 0.35.
- `tile_prompts` (dict): Optional mapping of tile coordinates to specific hallucination sub-prompts.

## UI Requirements
- Found under "Hallucination" tab as "SD Tiled Upscale".
- Inputs for the base prompt and SD strength.
- (Future) Interactive grid to type sub-prompts for specific zones.

## Fast Generative Models (Text-to-Image)
These models are architecturally distinct from Stable Diffusion (often using GANs or distilled transformers) and are significantly lighter. 

- **FLUX.2 [klein] 4B**: Released in early 2026, this is a 4-billion parameter model explicitly designed for speed and low VRAM.
  - **Performance**: Can generate 1024px images in 3–5 seconds on modern hardware; on an iGPU with INT4/INT8 quantization, it is one of the few "high-quality" transformers feasible.
  - **Usage**: Available in GGUF format for llama.cpp-style image generators or via OpenVINO if converted.
- **PixArt-Sigma**: A lightweight diffusion transformer that often requires less VRAM (~6GB) than SDXL.
  - **Benefit**: Excellent prompt adherence with a smaller footprint. Look for the PixArt-Alpha or Sigma quantized versions.
- **LAFITE (Language-free GAN)**: A GAN-based model (~75M parameters) that is drastically smaller than diffusion models.
  - **Use Case**: Extremely fast generation (milliseconds to seconds) on CPU/iGPU. It doesn't require text prompts (uses random noise or simple class labels), making it perfect for "dreaming" random abstract concepts quickly.
