# Upscale & Re-Grain (`upscale`)

## Concept
Upscale images or video frames using AI. We offer two modes: 
1. **Real-ESRGAN**: Aggressively cleans and upscales, perfect for digital/clean sources.
2. **SRMD (Noise-Aware)**: Upscales while preserving or enhancing existing grain/texture, perfect for analog film or old DVD rips.

After upscaling, the AI models naturally eliminate organic film grain. A **Re-Grain** module using FFmpeg injects temporal analog grain back into the footage to prevent the "plastic AI" look.

## Architecture & Hardware Guardrails
- **Backend**: NCNN Vulkan is strictly preferred over OpenVINO here. Real-ESRGAN and SRMD have highly optimized NCNN Vulkan compute shaders that run brilliantly on Intel Xe. SRMD in particular builds its degradation map dynamically in C++, which is tedious in Python/OpenVINO.
- **Tiling & Resolution Limit**: Built-in to the NCNN binaries. Set tile size to 256 for 16GB RAM constraints. (Note: Empirical testing on Intel 1335U shows the hardware sweet spot for the final output target is ~1024x1024. Pushing significantly beyond this risks aggressive memory swapping).
- **Re-Grain**: FFmpeg `noise` filter (`allf=t+g` for temporal gaussian).

## Implementation Design (Pipeline)
1. **Model Executable**: Use Python `asyncio.create_subprocess_exec` to call pre-compiled NCNN binaries (e.g. `realesrgan-ncnn-vulkan` or `srmd-ncnn-vulkan`).
2. **Execution**:
   - Save current frame/video chunk.
   - Run upscaler CLI.
     - *Real-ESRGAN*: `realesrgan-ncnn-vulkan -i in.png -o out.png -s 4 -t 256 -m models-real -n realesrgan-x4plus`
     - *SRMD*: `srmd-ncnn-vulkan -i in.png -o out.png -s 4 -t 256 -n {noise_scale}`
3. **Re-Grain (Post-processing)**:
   - For video, pipe the output through FFmpeg:
   - `-vf "noise=c0s={grain_luma}:c1s={grain_chroma}:c2s={grain_chroma}:allf=t+g"`
   - If user wants a clean look, `grain_luma = 0`. For analog film, `grain_luma = 12-18`.

## Parameter Schema
- `engine` (enum): `realesrgan`, `srmd`
- `scale` (int): 2 or 4. Default 4.
- `srmd_noise` (int): -1 to 10 (SRMD only. -1 = preserve native grain, 10 = heavy denoise). Default 3.
- `grain_strength` (int): 0 to 24 (0 = off). Default 0 for ESRGAN, 12 for analog looks.

## UI Requirements
- Found under "Image AI" tab.
- Engine selector (Digital Clean vs Analog Preserve).
- Sliders for Scale, SRMD Denoise, and Output Grain Strength.
