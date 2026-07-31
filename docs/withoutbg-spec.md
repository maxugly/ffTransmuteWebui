# WithoutBG (Background Removal)

> **Status:** Implemented — video is a **per_frame** stage (`app/filters/withoutbg.py`)  
> **Platform:** `filter-platform-spec.md`

## Overview

Removes backgrounds via local open weights or withoutbg.com Cloud API. Images (batch) and video (frame sequence).

## Architecture

| Mode | Path |
|------|------|
| **Video** | `dump` → `filters.withoutbg` → `encode` (cutout → WebM VP9+yuva420p; mask/bg → MP4) |
| **Image** | `withoutbg_engine.process_many` batch (not a video pipeline stage) |

Pipeline filter name: `withoutbg` (params: `backend`, `api_key`, `mode` or save_* knobs).

## Knobs

- `backend`: `local` \| `api`
- `save_cutout` / `save_mask` / `save_background`
- `fmt`: png \| webp (image mode)

## Integration

- Model loaded once per stage factory.
- Mid-chain PNG for video; alpha cutout encodes to WebM with alpha.
