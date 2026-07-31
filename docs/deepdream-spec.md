# DeepDream

> **Status:** Implemented — video path is a **per_frame** stage (`app/filters/deepdream.py`)  
> **Platform:** `filter-platform-spec.md`

## Overview

Google DeepDream via TensorFlow Keras (InceptionV3 / VGG16 / ResNet50, ImageNet). Images, videos (temporal blend / optical flow / layer cycle), and Ouroboros feedback video from a still.

## Architecture

| Mode | Path |
|------|------|
| **Video** | `dump` → `filters.deepdream` per_frame → `encode` (same factory as pipeline `"deepdream"`) |
| **Image** | `dream_image` once (no sequence stage) |
| **Ouroboros** | Feedback loop writing `frames_out` then `encode` (not a source-video filter) |

Mid-chain: PNG `frame_%06d.png` start 0. Bookends: `video_pipeline`.

## Knobs

- `model_name`, `layer_preset`, ascent (`step`, `iterations`, `num_octave`, …)
- Video: `temporal_blend`, `optical_flow`, `layer_cycle`, `frame_step`, `max_frames`
- Ouroboros: `ouroboros_length`, `frame_transform`, zoom/spin/translate

## Integration

- Pipeline filter name: `deepdream` (params match factory kwargs; omit ouroboros-only fields).
- High VRAM — ModelManager still future work for chained neural stages.
- Cancel: `job_control` between frames / during ascent where checked.
