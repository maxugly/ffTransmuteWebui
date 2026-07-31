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
| Display | `#giTotalFrames` = **selected** count (`end−start+1`); title has full clip length |
| Body | `withFrameRange()` / collectors attach `start_frame`/`end_frame` |
| Models | Fields on RIFE, DeepDream, styletransfer, withoutbg, convert, pipeline, speed_ramp |
| Dump | `video_pipeline.dump(..., start_frame=, end_frame=)` — ffmpeg `select=between(n,…)` + trimmed audio |

**Convention (1-based inclusive, same as datamosh):**

- `start_frame=1`, `end_frame=999999` → full clip  
- Output dump always renumbered from `frame_000000.png`

---

## Tabs with range row

`mosh`, `deepdream`, `rife`, `convert`, `transmute`, `styletransfer`, `withoutbg`, `facemorph`, `multi`, `advanced`

(Not pool/sequence/watcher/quick.)

---

## Verification

```text
dump(ws, /tmp/teste.mp4, start_frame=1, end_frame=12) → 12 PNGs
rife start=1 end=8 multiplier=2 → 8→16 frames
convert h264 start=5 end=16 → 12 frames encoded
```

UI: open RIFE/DeepDream/Convert → frame row visible; drag range → selected count updates.
