# RIFE Frame Interpolation (AI Slow-Mo)

> **Status:** Implemented (`rife_ops.py`)

## Overview
RIFE (Real-Time Intermediate Flow Estimation) provides state-of-the-art AI-driven frame interpolation. It is used to generate slow-motion video by synthesizing intermediate frames between existing frames (e.g., doubling or quadrupling the frame rate) while preserving motion smoothness.

## Pipeline Architecture
- **Engine**: `rife-ncnn-vulkan` (external binary)
- **Pattern**: `ffmpeg dump` → `rife-ncnn-vulkan` (directory process) → `ffmpeg encode`
- **Class**: Uses `PngFramePipeline` for extraction and assembly.

## Knobs & Parameters
- `input_path`: Source video file.
- `multiplier`: Interpolation factor (2x to 8x).
- `model`: RIFE model variant (`rife-v4.6`, `rife-v4`, `rife-v2.4`, `rife-v2.3`).
- `tta`: Spatial TTA mode (cleaner but slower).
- `uhd`: UHD mode for high-res sources.

## Integration Notes
- Because it relies on `rife-ncnn-vulkan` which natively processes a directory of frames, this operation aligns perfectly with our standard `PngFramePipeline`.
- Future migration to `VideoPipeline` filter graphs will simply pass the dumped frames directory to the binary, bypassing internal FFmpeg calls.
