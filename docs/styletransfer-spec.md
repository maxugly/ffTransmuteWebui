# Neural Style Transfer

> **Status:** Implemented — video is a **per_frame** stage (`app/filters/styletransfer.py`)  
> **Platform:** `filter-platform-spec.md`

## Overview

Magenta TF-Hub arbitrary stylization: content image(s) or video + one style reference.

## Architecture

| Mode | Path |
|------|------|
| **Video** | `dump` → `filters.styletransfer` → `encode` (model + style loaded once in factory) |
| **Image** | `styletransfer_engine.stylize_batch` |

Pipeline filter name: `styletransfer` (requires `style_path`; optional `strength`, `max_side`, `style_size`).

## Knobs

- `style_path`, `strength` (0–1), `max_side`, `style_size`

## Integration

- Blocking TF inference runs in `asyncio.to_thread` inside the filter.
- ModelManager still future work for multi-neural chains / VRAM.
