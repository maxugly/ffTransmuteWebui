# Global Frame Range — Wire-up Spec

> **Status:** Implemented (2026-07-31)  
> **From:** Tom’s frame-range audit  
> **Related:** filter-platform-spec.md, datamosh common trim

---

## Problem (audit)

Three gaps:

1. **UI** — frame row only shown for `mosh`
2. **Params** — neural/convert/pipeline ignored extra `start_frame`/`end_frame`
3. **Pipeline** — `dump()` always dumped the full clip

Datamosh already honored range via its own trim path.

---

## Solution

| Layer | Change |
|-------|--------|
| UI | `FRAME_RANGE_TABS` in `app.js`; show row + probe video on those tabs |
| Display | Layout: `[‹][start][›]` track `[‹][end][›]` `/ selected` `[+]`. `#giTotalFrames` = **selected** count (`end−start+1`); title has full clip length. Steppers ±1 with hold-to-repeat. |
| Body | `withFrameRange()` / collectors attach `start_frame`/`end_frame` |
| Models | Fields on RIFE, DeepDream, styletransfer, withoutbg, convert, pipeline, speed_ramp |
| Dump | `video_pipeline.dump(..., start_frame=, end_frame=)` — ffmpeg `select=between(n,…)` + trimmed audio |

**Convention (1-based inclusive, same as datamosh):**

- `start_frame=1`, `end_frame=999999` → full clip  
- Output dump always renumbered from `frame_000000.png`

---

## Tabs with range row

`mosh`, `deepdream`, `rife`, `convert`, `transmute`, `styletransfer`, `withoutbg`, `facemorph`, `multi`, `advanced`, **`cut`**

(Not: `pool` / Video Pool, `images` / Image Pool, `sequence`, `watcher`, `quick`.)

Source of truth for the set: `FRAME_RANGE_TABS` in `mtapi-project/app/static/app.js`.

---

## Probe + events (frontend)

| Piece | Location |
|-------|----------|
| Probe | `GET /api/probe` → `true_frames` |
| Client | `js/timeline.js` → `probeGlobalVideo(path, { force? })` |
| State | `window.globalInputs.frameStart/frameEnd/totalFrames`, `_probeOk` |
| Events | `mtapi:frame-range` on slider move; `mtapi:video-probed` after probe |
| Default trap | Until probe succeeds, UI defaults look like **100** frames — not real |

Changing the first line of global Video invalidates probe cache (`updateGlobalInputs` in `app.js`).

### Cut / range previews

Cut In/Out images use **working range**, not absolute file endpoints:

```text
GET /api/thumbnail?path=…&frame=N   # 1-based; see video-image-pools-spec.md
```

Absolute first/last (`which=first|last`) remain for Video Pool dual-frame cards only.

---

## Verification

```text
dump(ws, /tmp/teste.mp4, start_frame=1, end_frame=12) → 12 PNGs
rife start=1 end=8 multiplier=2 → 8→16 frames
convert h264 start=5 end=16 → 12 frames encoded
```

UI:

1. Open RIFE/DeepDream/Convert/Cut → frame row visible.  
2. Set global Video to `/tmp/teste.mp4` → probe → max ≈ 48 (not stuck at 100).  
3. Drag range → selected count updates; on Cut, In/Out thumbs follow `frame=N`.
