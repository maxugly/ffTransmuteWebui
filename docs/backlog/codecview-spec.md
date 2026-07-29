# Spec: Codec Motion Vector Overlay (`codecview`)

> **Version**: 000.000.2.26 (next bump)
> **Status**: Approved — ready for implementation
> **Author**: Spec agent
> **Scope**: New operation — `codecview_ops.py` + WebUI "Vectors" tab

---

## 1. What It Does

Draws the raw motion vectors that H.264/MPEG-2/MPEG-4 decoders compute internally directly over the video as colored arrows, optionally with macroblock boundaries and QP heatmaps. The result looks like a high-tech diagnostic HUD — pairs visually with the existing datamosh modes because it literally _shows_ the vectors that datamosh _corrupts_.

No external tools. No Python engine. No frame dumping. One `ffmpeg` invocation with a single `-vf` filter chain. Audio passthrough.

---

## 2. FFmpeg Pipeline

### The one command

```bash
ffmpeg -flags2 +export_mvs \
       -i <input> \
       -vf "codecview=mv=<mv_flags>:block=<0|1>:qp=<0|1>" \
       -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p \
       -c:a copy \
       -y <output>
```

### Critical ordering rule

`-flags2 +export_mvs` is an **input** option — it **must** appear before `-i`. If placed after, the decoder never exports motion vector side data, `codecview` receives nothing, and the output is a silent passthrough (no arrows, no error). The handler must construct the argv in this exact order.

### Re-encoding is mandatory

`codecview` draws on the pixel data, so `-c:v copy` is impossible. Output must be re-encoded. Audio is untouched → `-c:a copy`.

### Motion vector types

| Flag | Source | Color | Description |
|------|--------|-------|-------------|
| `pf` | P-frames | Green | Forward-predicted vectors |
| `bf` | B-frames | Blue | Forward-predicted vectors |
| `bb` | B-frames | Red | Backward-predicted vectors |

Flags are joined with `+`: `mv=pf+bf+bb`.

### Additional overlays

| Parameter | Type | Description |
|-----------|------|-------------|
| `block=1` | Boolean | Macroblock partition boundary grid |
| `qp=1` | Boolean | Quantization parameter heatmap on chroma planes |

---

## 3. Backend: `codecview_ops.py`

### 3.1 File location

```
mtapi-project/app/operations/codecview_ops.py
```

### 3.2 Imports

```python
from __future__ import annotations

from pathlib import Path

from pydantic import BaseModel, Field

from ..contract import OperationResult, OperationSpec, register
from ..pathutil import finalize_output_path
from ..shell import run_command
```

No temp dirs, no frame dumps, no engine files.

### 3.3 Pydantic model: `CodecviewParams`

| Field | Type | Default | Constraints | Description |
|---|---|---|---|---|
| `input_path` | `str` | _required_ | — | Absolute path to source video. |
| `output_path` | `str \| None` | `None` | — | Output path; auto-named if omitted (uses `_codecview` suffix). |
| `mv_pf` | `bool` | `True` | — | Show forward-predicted vectors from P-frames (green arrows). |
| `mv_bf` | `bool` | `True` | — | Show forward-predicted vectors from B-frames (blue arrows). |
| `mv_bb` | `bool` | `True` | — | Show backward-predicted vectors from B-frames (red arrows). |
| `show_block` | `bool` | `False` | — | Overlay macroblock partition boundaries as a grid. |
| `show_qp` | `bool` | `False` | — | Overlay quantization parameter heatmap on chroma planes. |
| `dry_run` | `bool` | `False` | — | Show the command without executing. |

**Design rationale**: Three separate booleans for MV types instead of a multi-select string, because the UI renders these naturally as three binary DAW knobs — consistent with how RIFE exposes TTA/UHD/dry_run.

**Validation**: At least one of `mv_pf`, `mv_bf`, `mv_bb` must be `True`. Validated in the handler (returns `OperationResult(ok=False)`) not as a Pydantic validator (avoids a 422).

### 3.4 Allowed output extensions

```python
VIDEO_EXTS = {".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi"}
```

### 3.5 Handler: `async def codecview(p: CodecviewParams) -> OperationResult`

Pseudocode:

```
1. Resolve input_path → Path, check exists.
2. Build mv_flags string:
     parts = []
     if p.mv_pf: parts.append("pf")
     if p.mv_bf: parts.append("bf")
     if p.mv_bb: parts.append("bb")
     if not parts:
         return OperationResult(ok=False, error="Select at least one MV type")
     mv_str = "+".join(parts)
3. Build filter string:
     vf = f"codecview=mv={mv_str}"
     if p.show_block: vf += ":block=1"
     if p.show_qp:    vf += ":qp=1"
4. Resolve output path:
     out = finalize_output_path(
         p.output_path,
         source=input_path,
         default_suffix="_codecview",
         default_ext=".mp4",
         allowed_exts=VIDEO_EXTS,
     )
5. Build summary string for command log.
6. If dry_run: return OperationResult with command= but no execution.
7. Build argv:
     [
         "ffmpeg",
         "-flags2", "+export_mvs",    # ← BEFORE -i
         "-i", str(input_path),
         "-vf", vf,
         "-c:v", "libx264", "-preset", "fast", "-crf", "18",
         "-pix_fmt", "yuv420p",
         "-c:a", "copy",
         "-y", str(out),
     ]
8. code, stdout, stderr = await run_command(argv)
9. Return OperationResult(ok=code==0, output_path=str(out), ...).
```

### 3.6 Registration

```python
register(OperationSpec(
    id="codecview",
    summary="Codec Motion Vector Overlay (diagnostic HUD)",
    description=(
        "Draws the raw motion vectors from H.264/MPEG-2/MPEG-4 decoding "
        "as colored arrows over the video, with optional macroblock grid "
        "and QP heatmap overlays. Pure ffmpeg — no external tools."
    ),
    params_model=CodecviewParams,
    handler=codecview,
    tags=["codecview", "diagnostic", "motion-vectors"],
))
```

### 3.7 Import registration

Add `codecview_ops` to `app/operations/__init__.py`:

```python
from . import (
    ...
    codecview_ops,
)
```

---

## 4. Frontend: WebUI Integration

### 4.1 Tab placement

New tab named **"Vectors"** under the Moshing nav category in the sidebar, inserted after the existing Mosh tab. Uses the "activity/pulse" SVG icon (zigzag line).

`data-tab="codecview"`

### 4.2 State key

```javascript
codecview: { inputPath: null }
```

### 4.3 Form layout

```
┌──────────────────────────────────────────────┐
│ Vectors · Codec Motion Vector Overlay        │
│ Draw H.264/MPEG motion vectors as colored    │
│ arrows over the video. Pure ffmpeg.          │
├──────────────────────────────────────────────┤
│ Input video          [_______________][Browse]│
│ Output path (blank = auto) [______________]  │
│                                              │
│ KNOB BANK:                                   │
│  [P-fwd:On] [B-fwd:On] [B-back:On]          │
│  [Block:Off] [QP:Off]  [Dry:Run]             │
│                                              │
│ P-fwd = green arrows (P-frames)              │
│ B-fwd = blue arrows (B-frames forward)       │
│ B-back = red arrows (B-frames backward)      │
│ Block = macroblock boundary grid              │
│ QP = quantization parameter heatmap           │
│                                              │
│ Works with H.264, MPEG-2, MPEG-4.            │
│ Other codecs produce no overlay.              │
└──────────────────────────────────────────────┘
```

### 4.4 Element IDs

| Purpose | Element ID | Type | Initial |
|---------|-----------|------|---------|
| Input path text | `cvInput` | `<input text>` | `''` |
| Browse button | `btnCvBrowse` | `<button>` | — |
| Output path text | `cvOutput` | `<input text>` | `''` |
| P-frame forward MV | `cvMvPf` | binary knob hidden | `'1'` |
| B-frame forward MV | `cvMvBf` | binary knob hidden | `'1'` |
| B-frame backward MV | `cvMvBb` | binary knob hidden | `'1'` |
| Block boundaries | `cvBlock` | binary knob hidden | `'0'` |
| QP heatmap | `cvQp` | binary knob hidden | `'0'` |
| Dry run | `cvDryRun` | binary knob hidden | `'0'` |

### 4.5 Routing wiring (3 touch-points in app.js)

1. `renderTabForm(tab)` → add `else if (tab === 'codecview') { renderCodecviewForm(); }`
2. `runActiveOperation()` → add `else if (tab === 'codecview') { body = collectCodecviewBody(); if (!body) return; opId = 'codecview'; }`
3. `switchTab(tab)` title mapping → add `'codecview'` → `'Vectors'`

### 4.6 Nav item in index.html

```html
<div class="nav-item" data-tab="codecview">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
       stroke-linecap="round" stroke-linejoin="round">
    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
  </svg>
  Vectors
</div>
```

Insert after the existing Mosh nav-item, inside the same nav-header category.

---

## 5. Codec Compatibility

| Codec | MV Export | Notes |
|---|---|---|
| H.264 (AVC) | ✅ Full | Most common. Best support. |
| MPEG-2 | ✅ Full | Works via `mpegvideo.c`. |
| MPEG-4 Part 2 | ✅ Full | DivX / Xvid. |
| HEVC (H.265) | ⚠️ Partial | Variable block sizes → sparser arrows. |
| VP8 / VP9 | ❌ | Decoder doesn't export MVs. |
| AV1 | ❌ | Not supported. |
| ProRes / MJPEG | ❌ N/A | Intra-only — no inter-frame vectors. |

**Undetectable failure**: When input is VP9/AV1/ProRes, ffmpeg exits 0 but draws no arrows. This is documented in the UI hint text rather than caught programmatically.

---

## 6. Files Touched

| File | Action | Est. Lines |
|---|---|---|
| `app/operations/codecview_ops.py` | **CREATE** | ~85 |
| `app/operations/__init__.py` | **EDIT** (add import) | +1 |
| `app/static/index.html` | **EDIT** (add nav-item) | +8 |
| `app/static/app.js` | **EDIT** (state + form + collector + routing) | ~80 |
| Root `AGENTS.md` | **EDIT** (ops registry table) | +1 |

No new dependencies. No new CSS. No engine files. No temp directories.
