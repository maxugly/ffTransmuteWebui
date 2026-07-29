# Line Art Extraction

> **Status:** Spec Drafted (Not Implemented)

## Overview
A lightweight AI operation that pulls clean linework from photos or videos. Unlike simple Canny edge detection, neural edge detectors (like HED or DexiNed) understand context and produce clean, continuous lines suitable for coloring, anime-style filtering, or stylized glitch overlays. 

## Pipeline Architecture
- **Engine**: OpenVINO or ONNX Runtime (CPU/iGPU friendly).
- **Model Options**: HED (Holistically-Nested Edge Detection), DexiNed, or PiDiNet.
- **Pattern**: `PngFramePipeline` for video → Neural Inference per frame → Re-encode.

## Knobs & Parameters
- `model`: Choose between `hed` (softer, sketch-like), `dexined` (sharp, detailed), or `pidinet` (very fast).
- `invert`: Boolean (default `false`). If false, outputs black lines on white background. If true, outputs white lines on black background.
- `transparent_bg`: Boolean. If true, converts the background to alpha transparency (useful for compositing the lines over other footage in the dynamic mixer).
- `threshold`: Float. Cutoff for line confidence to remove noise.
- `thickness_boost`: Float. Dilation filter to thicken the resulting lines slightly.

## Integration Notes
- Since the models are extremely small (usually < 50MB), they can be loaded quickly into memory without fighting for VRAM.
- Can be chained perfectly in the Filter Graph: `Original Video -> Line Art Extract -> Chromatic Aberration -> Output`.
