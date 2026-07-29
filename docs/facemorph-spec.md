# Face Morph

> **Status:** Implemented (`facemorph_ops.py` / `facemorph_engine.py`)

## Overview
Chains a series of face images into a smooth transition video using dlib's 68-point facial landmarks. Optionally applies DeepDream to the resulting video, or dreams the faces *before* morphing.

## Pipeline Architecture
- **Engine**: `dlib` landmark detection + Delaunay triangulation morphing.
- **Pattern**: Ordered images → Morph pairs → Frame generation → FFmpeg encode.
- **Cancel Support**: Yes, checked between face pairs.

## Knobs & Parameters
- `duration`: Seconds per face transition.
- `fps`: Output video framerate.
- `dream_mode`: `none`, `after` (morph then dream video), `faces_first` (dream stills then morph).

## Integration Notes
- Relies heavily on Dlib shape predictors.
- The `faces_first` and `after` modes explicitly import and call the `deepdream_engine`. This tight coupling is an anti-pattern that the upcoming `Pipeline Engine` (Dynamic Mixing) will solve natively.
