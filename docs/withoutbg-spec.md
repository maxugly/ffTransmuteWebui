# WithoutBG (Background Removal)

> **Status:** Implemented (`withoutbg_ops.py` / `withoutbg_engine.py`)

## Overview
Removes backgrounds from image batches using either local open weights or the withoutbg.com Cloud API.

## Pipeline Architecture
- **Engine**: Local open weights (ONNX/Torch) or Cloud API.
- **Pattern**: Pure image processing (batch loop).
- **Cancel Support**: `job_control.check_cancelled()` between images.

## Knobs & Parameters
- `backend`: `local` or `api`.
- `save_cutout`: RGBA PNG with transparent BG.
- `save_mask`: Grayscale alpha mask.
- `save_background`: Original RGB with inverted alpha (leftover background).
- `fmt`: Output format (`png` or `webp`).

## Integration Notes
- Can process single images or whole directories.
- Easy to convert to a pure Filter for the dynamic mixing pipeline since it already operates on a frame-by-frame basis without complex temporal dependencies.
