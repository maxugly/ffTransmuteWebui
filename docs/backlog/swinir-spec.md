# SwinIR-Light Denoise/Deblur (`swinir`)

## Concept
Use the lightweight SwinIR transformer model to denoise and deblur images without hallucinating details (unlike ESRGAN or Diffusion). It is designed to preserve original content while cleaning up heavy compression artifacts or motion blur.

## Architecture & Hardware Guardrails
- **Model**: `SwinIR-Light` (Denoising or Deblurring weights).
- **Backend**: OpenVINO (`openvino.runtime`).
- **Precision**: FP16.
- **Tiling**: **Mandatory.** SwinIR's self-attention layers will OOM a 16GB system on images >1024x1024. Images must be split into overlapping 512x512 tiles, processed, and blended using a 2D cosine window.

## Implementation Design (Pipeline)
1. **Model Loader**: Convert PyTorch `SwinIR` model (upscale=1) to OpenVINO FP16 (`swinir_light_fp16.xml`) using a static dummy input size of 512x512 (which is a multiple of window_size=8).
2. **Tiling Logic**:
   - Pad the input image using `cv2.BORDER_REFLECT` to ensure it divides perfectly into overlapping 512x512 tiles with a 32px overlap padding.
   - Iterate over the grid, extracting 512x512 crops.
3. **Inference**: Pass each 512x512 BGR crop through the OpenVINO model (normalize to 0..1 RGB first).
4. **Cosine Blending**: Accumulate the output tiles onto an output canvas and a weight canvas. The blending weight matrix uses a 1D cosine ramp on the overlapping edges. Divide the output canvas by the weight canvas to seamlessly stitch the tiles.
5. **Crop**: Crop the padded regions to restore the original image dimensions.

## Parameter Schema
- `input_path` (string): Source image/video.
- `output_path` (string, optional): Target output path.
- `task` (enum): `denoise` or `deblur`.

## UI Requirements
- Found under "Image AI" tab.
- Dropdown for Task (Denoise vs Deblur).
