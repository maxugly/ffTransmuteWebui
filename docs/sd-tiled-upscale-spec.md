# Stable Diffusion Tiled Agent Upscale (`sd_tiled_upscale`)

## Concept
Leverages Stable Diffusion (via OpenVINO `optimum-intel`) to not just upsample an image, but to *hallucinate* new fractal-like, complex details into specific regions. Instead of a dumb grid upscale, it uses semantic "zones" and local "tile" prompts to inject unique, prompt-driven details (e.g., "micro-clockworks" or "petrified crustaceans") into the image as it scales up.

## Architecture & Hardware Guardrails
- **Backend**: `diffusers` + `optimum-intel` (OpenVINO). This completely replaces the need for IPEX or PyTorch XPU for diffusion models.
- **Hardware Target**: Intel Iris Xe iGPU. Execution is triggered simply by exporting `DEVICE="gpu"` and loading the model through `optimum-intel`'s `OVStableDiffusionPipeline` or `OVStableDiffusionImg2ImgPipeline`.
- **Memory Optimization**: The pipeline inherently uses FP16 OpenVINO IR models, fitting SD1.5 or LCM (Latent Consistency Models) easily into the 16GB shared RAM limit.
- **Tiling**: Processes the image in overlapping 512x512 patches, using `diffusers` img2img.

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
