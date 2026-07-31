# RIFE Frame Interpolation (AI Slow-Mo)

> **Status:** Implemented as **directory stage** (`app/filters/rife.py` + thin `rife_ops.py`)  
> **Platform:** See `filter-platform-spec.md`, cleanup notes in `rife-filter-cleanup-spec.md`

## Overview

RIFE (Real-Time Intermediate Flow Estimation) generates intermediate frames for smooth slow-motion / higher FPS. Engine: **`rife-ncnn-vulkan`**.

## Architecture

```text
dump (video_pipeline) → PNG frames_in/
        ↓
run_rife_directory  (one binary: -i indir -o outdir -n N*M)
        ↓
normalize to frame_%06d.png start 0
        ↓
encode (video_pipeline)  fps' = fps * (out_frames / in_frames)
```

- **Not** a 1:1 `per_frame` FilterFn.
- **Not** N subprocesses per intermediate step.
- Same factory used by `POST /ops/rife` and `POST /ops/pipeline` filter `"rife"`.

## Knobs

| param | notes |
|-------|--------|
| `input_path` | Source video |
| `multiplier` | 2–8 |
| `model` | `rife-v4.6` (default), `rife-v4`, `rife-v2.4`, `rife-v2.3` |
| `tta` | Spatial TTA (`-x`) |
| `uhd` | UHD mode (`-u`) |
| `dry_run` | Print plan only |

## Integration

- Mid-chain format: PNG `frame_%06d.png` start 0 (pipeline-native).
- Audio muxed when present; duration preserved via fps scale.
- Binary resolved via `PATH` or `/usr/bin/rife-ncnn-vulkan`.
