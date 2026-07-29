# Neural Style Transfer

> **Status:** Implemented (`styletransfer_ops.py` / `styletransfer_engine.py`)

## Overview
Arbitrary artistic style transfer using the Magenta TF-Hub model. Applies the style of a reference image to a batch of content images.

## Pipeline Architecture
- **Engine**: TensorFlow Hub Magenta Arbitrary Image Stylization model.
- **Pattern**: Image batch loop. Model is warmed up once via `preload()`.
- **Cancel Support**: Yes, between images.

## Knobs & Parameters
- `style_path`: Reference style image.
- `strength`: 0.0 to 1.0 interpolation with original content.
- `max_side`: Max resolution to limit RAM usage.

## Integration Notes
- Outputs default next to the source files, preventing destructive overwrites.
- Like `deepdream`, relies on TensorFlow and needs to be migrated to the `ModelManager` to avoid GPU OOM when chained.
