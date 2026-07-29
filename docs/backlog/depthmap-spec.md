# Depth Map Extraction (`depthmap`)

## Concept
Extract a grayscale depth map from a video using the MiDaS monocular depth estimation network. The result is a video where white is near and black is far, useful for generating masks, 3D parallax effects, or displacement maps.

## Architecture & Hardware Guardrails
- **Model**: `MiDaS_small` (v2.1). Prioritized over DPT-Hybrid for its 50-90 FPS throughput on Intel Iris Xe.
- **Backend**: OpenVINO (`openvino.runtime`).
- **Precision**: FP16 (converts PyTorch on the fly if IR `.xml` doesn't exist).
- **Execution**: Batch size 1. Synchronous inference per frame to minimize memory buffers.
- **Resolution Constraint**: Inference must happen at $256 \times 256$ (MiDaS_small native). Output is then upscaled back to the original video dimensions using OpenCV `INTER_CUBIC`.

## Implementation Design (Pipeline)
1. **Model Loader**: `get_or_create_openvino_model(model_name="MiDaS_small")`. Downloads PyTorch hub model, converts to OpenVINO `fp16`, saves to `models/MiDaS_small_fp16.xml`.
2. **Estimator Class**: `OpenVINODepthEstimator` loads the compiled model with `{"PERFORMANCE_HINT": "LATENCY"}`.
3. **Frame Loop**: Use OpenCV `VideoCapture` to read frames.
   - Preprocess (resize to 256x256, normalize, transpose to NCHW).
   - Infer via OpenVINO.
   - Postprocess (resize to original width/height, min-max normalize to 0-255 uint8).
4. **Encoding**: Write the grayscale frames to an `mp4` using OpenCV `VideoWriter`, or pipe raw bytes into an `ffmpeg` subprocess for `libx264 -pix_fmt yuv420p` encoding.

## Parameter Schema
- `input_path` (string): Source video.
- `output_path` (string, optional): Target video path.

## UI Requirements
- Found under "Video AI" tab.
- Single file input for video.
- Note in UI: "First run will download and convert the MiDaS model (may take a minute)."
