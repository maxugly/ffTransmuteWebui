# Neural Style Transfer

> **Status:** Implemented — stills + **video** via filter platform · **Evolve strength ramp** `000.000.4.74` · shared UI/params DRY `4.75`  
> **Platform:** `filter-platform-spec.md`  
> **Op:** `POST /ops/styletransfer` · UI tab `styletransfer`  
> **Shared evolve stack:** `app/evolve_video.py` + `js/ui/evolve-rife.js` (same path as DeepDream Evolve)

---

## Overview

Magenta TF-Hub arbitrary stylization: content image(s) **or one video** + one style reference still.

Optional **Evolve:** ramp strength from start→end over N keyframes (one neural pass), then optional RIFE → `*_styled_evolve.mp4`.

---

## Architecture

| Mode | Path |
|------|------|
| **Video** | `dump` → `filters.styletransfer` (`kind=per_frame`) → `encode` — model + style loaded once in factory |
| **Image batch** | `styletransfer_ops` loop + `stylize_pair` (model preloaded once) |
| **Evolve (still)** | `stylize_strength_strip` (1× model, blend per strength) → `build_evolve_video` (optional RIFE + encode) |

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

### Evolve request shape (single still)

```json
{
  "content_path": "/abs/photo.png",
  "style_path": "/abs/style.jpg",
  "strength": 1.0,
  "max_side": 1280,
  "evolve_enabled": true,
  "evolve_frames": 16,
  "evolve_strength_start": 0.0,
  "evolve_strength_end": -1,
  "evolve_fps": 12,
  "evolve_use_rife": false,
  "evolve_rife_multiplier": 2
}
```

| Field | Meaning |
|-------|---------|
| `evolve_strength_end` | `< 0` → use main `strength` knob as end |
| `evolve_frames` | Linear keyframes from start→end (default **16**) |
| `evolve_dedupe` | Default **false** (each strength is intentional) |
| RIFE knobs | Same semantics as DeepDream / RIFE tab (M 2–128, model, TTA, UHD) |

**Outputs:** final still at end strength (`*_styled.png`); video `*_styled_evolve.mp4`.  
**`output_path`:** still (compat). Evolve path in stdout.

**v1 limits:** exactly one still content (no multi, no video evolve).

**Efficiency:** Magenta runs **once** at full stylization; each keyframe is a pixel blend of content vs that result (not N model runs).

---

## Knobs

- Core: `style_path`, `strength` (0–1), `max_side`, `style_size`, frame range for video  
- Evolve: `evolve_enabled`, `evolve_frames`, `evolve_strength_start` / `_end`, `evolve_fps`, RIFE suite, `evolve_save_stills`

---

## Integration

- Blocking TF inference runs in `asyncio.to_thread`.  
- Progress: per-frame via `video_pipeline.process` for video; strength index for evolve.  
- Live preview: `latest_frame` on finished stills / evolve frames.  
- ModelManager still future work for multi-neural chains / VRAM.  
- **Do not** reimplement RIFE/encode in this op — call `evolve_video.build_evolve_video`.

---

## Related

- [deepdream-evolve-video-spec.md](deepdream-evolve-video-spec.md) — capture/dedupe sibling; shared bookend note  
- [filter-platform-spec.md](filter-platform-spec.md)  
- Code: `app/evolve_video.py`, `operations/styletransfer_engine.py`, `static/js/tabs/styletransfer.js`, `static/js/ui/evolve-rife.js`
