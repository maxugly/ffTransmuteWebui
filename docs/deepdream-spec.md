# DeepDream

> **Status:** Implemented (`deepdream_ops.py` / `deepdream_engine.py`)

## Overview
Google DeepDream implementation using InceptionV3, VGG16, or ResNet50. Supports images and videos. For videos, it supports temporal blending, optical flow (DeepDreamAnim-style), and Ouroboros (feedback loop transformations like zoom/spin/translate).

## Pipeline Architecture
- **Engine**: TensorFlow Keras models (ImageNet weights).
- **Pattern**: `PngFramePipeline` for video → Frame-by-Frame TensorFlow Gradient Ascent → Re-encode.
- **Cancel Support**: Yes, checked during ascent loops.

## Knobs & Parameters
- `model_name`: `inception_v3`, `vgg16`, `resnet50`.
- `layer_preset`: `shallow`, `mid`, `deep`, `classic`, `full`, `custom`.
- `step`, `iterations`, `num_octave`, `octave_scale`: Ascent parameters.
- `temporal_blend`, `optical_flow`, `layer_cycle`: Video temporal coherence.
- `ouroboros`, `ouroboros_length`, `frame_transform`: Geometric feedback loop generation.

## Integration Notes
- **High VRAM usage**. Currently instantiates models inside its own engine.
- Must be integrated with the upcoming `ModelManager` to share VRAM when chained in the Filter Graph.
