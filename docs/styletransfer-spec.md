# Neural Style Transfer

> **Status:** Implemented — stills + **video** via filter platform  
> **Platform:** `filter-platform-spec.md`  
> **Op:** `POST /ops/styletransfer` · UI tab `styletransfer`

## Overview

Magenta TF-Hub arbitrary stylization: content image(s) **or one video** + one style reference still.

## Architecture

| Mode | Path |
|------|------|
| **Video** | `dump` → `filters.styletransfer` (`kind=per_frame`) → `encode` — model + style loaded once in factory |
| **Image batch** | `styletransfer_engine.stylize_batch` / `stylize_pair` |

Pipeline filter name: `styletransfer` (requires `style_path`; optional `strength`, `max_side`, `style_size`).

### Video request shape

```json
{
  "content_path": "/abs/clip.mp4",
  "style_path": "/abs/style.jpg",
  "strength": 1.0,
  "max_side": 1280,
  "start_frame": 1,
  "end_frame": 48
}
```

UI: global **Video** bar or **+ Video** / content list (one clip). Global **Frame range** applies via `withFrameRange`.

### Image request shape

`content_paths: [...]` stills/folders + `style_path`. Do not mix videos and stills in one job.

## Knobs

- `style_path`, `strength` (0–1), `max_side`, `style_size`, frame range for video

## Integration

- Blocking TF inference runs in `asyncio.to_thread` inside the per_frame filter.
- Progress: per-frame via `video_pipeline.process` progress_cb.
- ModelManager still future work for multi-neural chains / VRAM.
