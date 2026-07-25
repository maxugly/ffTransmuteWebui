# Spec: LUT Color Grading (`lut`)

> **Version**: 000.000.2.27 (next bump)
> **Status**: Approved — ready for implementation
> **Author**: Spec agent
> **Scope**: New operation — `lut_ops.py` + WebUI "LUT" tab

---

## 1. What It Does

Applies 3D LUT (Look-Up Table) color grading to video files using ffmpeg's `lut3d` filter. Supports standard `.cube` files and other formats. Allows for a continuous strength parameter (0.0 to 1.0) to blend the LUT with the original video.

No external tools. Pure ffmpeg. Audio passthrough.

---

## 2. FFmpeg Pipeline

### Strength = 1.0 (Basic)

```bash
ffmpeg -i input.mp4 \
       -vf "lut3d=file='/path/to/look.cube':interp=tetrahedral" \
       -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p \
       -c:a copy \
       -y output.mp4
```

### Strength < 1.0 (Blend)

```bash
ffmpeg -i input.mp4 \
       -filter_complex "[0:v]split[orig][lut_in];[lut_in]lut3d=file='/path/to/look.cube':interp=tetrahedral[graded];[orig][graded]mix=inputs=2:weights='0.3 0.7'[out]" \
       -map "[out]" -map 0:a? \
       -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p \
       -c:a copy \
       -y output.mp4
```
Where weights are `(1.0 - strength) strength`. For example, strength 0.7 gives weights `0.3 0.7`.

### Interpolation Methods
`tetrahedral` (default, best quality), `trilinear`, `nearest`.

### Re-encoding is mandatory
Color grading alters pixel data, so re-encoding the video track is required. Audio is passed through.

---

## 3. Backend: `lut_ops.py`

### 3.1 File location

```
mtapi-project/app/operations/lut_ops.py
```

### 3.2 Imports

```python
from __future__ import annotations
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

from ..contract import OperationResult, OperationSpec, register
from ..pathutil import finalize_output_path
from ..shell import run_command
```

### 3.3 Pydantic model: `LutParams`

| Field | Type | Default | Constraints | Description |
|---|---|---|---|---|
| `input_path` | `str` | _required_ | — | Absolute path to source video. |
| `output_path` | `str \| None` | `None` | — | Output path; auto-named if omitted (uses `_lut` suffix). |
| `lut_path` | `str` | _required_ | — | Absolute path to `.cube` (or supported) LUT file. |
| `strength` | `float` | `1.0` | `0.0 <= x <= 1.0` | LUT blend strength (0=original, 1=full LUT). |
| `interp` | `Literal["tetrahedral", "trilinear", "nearest"]` | `"tetrahedral"` | — | LUT interpolation method. |
| `dry_run` | `bool` | `False` | — | Show the command without executing. |

**Validation**: Must ensure `lut_path` exists and has a supported extension (`.cube`, `.3dl`, `.dat`, `.m3d`, `.csp`).

### 3.4 Allowed output extensions

```python
VIDEO_EXTS = {".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi"}
LUT_EXTS = {".cube", ".3dl", ".dat", ".m3d", ".csp"}
```

### 3.5 Handler: `async def lut(p: LutParams) -> OperationResult`

Pseudocode:

```
1. Resolve input_path → Path, check exists.
2. Resolve lut_path → Path, check exists and extension in LUT_EXTS.
3. Resolve output path:
     out = finalize_output_path(
         p.output_path, source=input_path, default_suffix="_lut", default_ext=".mp4", allowed_exts=VIDEO_EXTS
     )
4. Build summary string for command log.
5. If dry_run: return OperationResult with command= but no execution.
6. Build argv:
     If p.strength >= 0.999:
         vf = f"lut3d=file='{lut_path.absolute()}':interp={p.interp}"
         argv = [ "ffmpeg", "-i", str(input_path), "-vf", vf, ... ]
     Else:
         w1, w2 = 1.0 - p.strength, p.strength
         fc = f"[0:v]split[orig][lut_in];[lut_in]lut3d=file='{lut_path.absolute()}':interp={p.interp}[graded];[orig][graded]mix=inputs=2:weights='{w1:.3f} {w2:.3f}'[out]"
         argv = [ "ffmpeg", "-i", str(input_path), "-filter_complex", fc, "-map", "[out]", "-map", "0:a?", ... ]
7. code, stdout, stderr = await run_command(argv)
8. Return OperationResult(ok=code==0, output_path=str(out), ...).
```

### 3.6 Registration

```python
register(OperationSpec(
    id="lut",
    summary="LUT Color Grading",
    description="Applies a 3D LUT (Look-Up Table) for color grading, with adjustable strength.",
    params_model=LutParams,
    handler=lut,
    tags=["lut", "color", "utility"],
))
```

---

## 4. Frontend: WebUI Integration

### 4.1 Tab placement

New tab named **"LUT"** under the "Utility" nav category in the sidebar. Uses a palette/color SVG icon.

`data-tab="lut"`

### 4.2 State key

```javascript
lut: { inputPath: null, lutPath: null }
```

### 4.3 Form layout

```
┌──────────────────────────────────────────────┐
│ LUT · Color Grading                          │
│ Apply 3D LUT files (.cube) for color grading.│
├──────────────────────────────────────────────┤
│ Input video          [_______________][Browse]│
│ LUT file (.cube)     [_______________][Browse]│
│ Output path (auto)   [______________]         │
│                                              │
│ Strength [-------O--] 1.0                    │
│                                              │
│ Interpolation: [Tetrahedral|v]               │
│                                              │
│ KNOB BANK:                                   │
│  [Dry:Run]                                   │
└──────────────────────────────────────────────┘
```

### 4.4 Element IDs

| Purpose | Element ID | Type | Initial |
|---------|-----------|------|---------|
| Input path text | `ltInput` | `<input text>` | `''` |
| Browse input | `btnLtBrowse` | `<button>` | — |
| LUT path text | `ltLutPath` | `<input text>` | `''` |
| Browse LUT | `btnLtLutBrowse` | `<button>` | — |
| Output path text | `ltOutput` | `<input text>` | `''` |
| Strength slider | `ltStrength` | continuous knob | `1.0` |
| Interpolation | `ltInterp` | `<select>` | `'tetrahedral'` |
| Dry run | `ltDryRun` | binary knob | `'0'` |

### 4.5 Routing wiring

1. `renderTabForm(tab)` → add `else if (tab === 'lut') { renderLutForm(); }`
2. `runActiveOperation()` → add `else if (tab === 'lut') { body = collectLutBody(); if (!body) return; opId = 'lut'; }`
3. `switchTab(tab)` title mapping → add `'lut'` → `'LUT'`

---

## 5. Files Touched

| File | Action | Est. Lines |
|---|---|---|
| `app/operations/lut_ops.py` | **CREATE** | ~100 |
| `app/operations/__init__.py` | **EDIT** (add import) | +1 |
| `app/static/index.html` | **EDIT** (add nav-item) | +8 |
| `app/static/app.js` | **EDIT** (state + form + collector + routing) | ~90 |
| Root `AGENTS.md` | **EDIT** (ops registry table) | +1 |
