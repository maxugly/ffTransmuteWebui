# Spec: Palette & Media Export (`mediaexport`)

> **Version**: 000.000.2.27 (next bump)
> **Status**: Approved — ready for implementation
> **Author**: Spec agent
> **Scope**: New operation — `mediaexport_ops.py` + WebUI "Export" tab

---

## 1. What It Does

Converts video to GIF, WebP, or APNG with quality controls. These formats are widely used for web, social media, and chat applications. The operation strips audio and provides fine-grained controls for dimensions, framerate, and palette/compression quality.

No external tools. No Python engine. Pure `ffmpeg`.

---

## 2. FFmpeg Pipeline

### GIF Pipeline (two-pass palette via filter_complex)

```bash
ffmpeg -i <input> -filter_complex "fps=<fps>,scale=<width>:-2:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=<stats_mode>:max_colors=256[p];[s1][p]paletteuse=dither=<dither>:diff_mode=rectangle" -loop <loop> -an -y <output>.gif
```

- `palettegen` stats_mode: `full`, `diff`, `single`
- `paletteuse` dither: `sierra2_4a`, `floyd_steinberg`, `bayer`, `none`
- `-loop 0` = infinite, `-loop -1` = no loop, `-loop N` = N times
- Audio is stripped automatically for GIF, but `-an` makes it explicit.

### Animated WebP Pipeline

```bash
ffmpeg -i <input> -vf "fps=<fps>,scale=<width>:-2:flags=lanczos" -c:v libwebp -lossless <lossless_bool> -q:v <quality> -compression_level 4 -loop <loop> -an -y <output>.webp
```

- Use `-c:v libwebp`
- `-q:v 0-100` quality
- `-lossless 1` for lossless, `0` for lossy
- `-loop 0` for infinite

### APNG Pipeline

```bash
ffmpeg -i <input> -vf "fps=<fps>,scale=<width>:-2:flags=lanczos" -c:v apng -plays <loop> -an -y <output>.apng
```

- `-plays 0` for infinite (Note APNG uses `-plays` instead of `-loop`)

### Common pre-processing

- FPS reduction FIRST, then scale.
- `scale=W:-2:flags=lanczos` ensures even height.

---

## 3. Backend: `mediaexport_ops.py`

### 3.1 File location

```
mtapi-project/app/operations/mediaexport_ops.py
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

### 3.3 Pydantic model: `MediaExportParams`

```python
class MediaExportParams(BaseModel):
    input_path: str = Field(..., description="Source video path")
    output_path: str | None = Field(None, description="Output path; auto-named if omitted")
    format: Literal["gif", "webp", "apng"] = Field("gif", description="Output format")
    fps: float = Field(10.0, ge=1, le=30, description="Output frame rate")
    width: int = Field(480, ge=64, le=3840, description="Output width in pixels (-2 height auto)")
    quality: int = Field(75, ge=1, le=100, description="WebP quality (1-100). Ignored for GIF/APNG.")
    dither: Literal["sierra2_4a", "floyd_steinberg", "bayer", "none"] = Field("sierra2_4a", description="GIF dithering algorithm. Ignored for WebP/APNG.")
    stats_mode: Literal["full", "diff", "single"] = Field("diff", description="GIF palette sampling mode. Ignored for WebP/APNG.")
    loop: int = Field(0, ge=-1, le=100, description="Loop count: 0=infinite, -1=none, N=N times")
    lossless: bool = Field(False, description="WebP lossless mode. Ignored for GIF/APNG.")
    dry_run: bool = Field(False, description="Show command only")
```

### 3.4 Handler Logic

```python
# Output ext validation
if p.format == "gif":
    ext = ".gif"
elif p.format == "webp":
    ext = ".webp"
elif p.format == "apng":
    ext = ".apng"

# Build filters and format-specific arguments
base_vf = f"fps={p.fps},scale={p.width}:-2:flags=lanczos"

format_args = []
if p.format == "gif":
    fc = f"{base_vf},split[s0][s1];[s0]palettegen=stats_mode={p.stats_mode}:max_colors=256[p];[s1][p]paletteuse=dither={p.dither}:diff_mode=rectangle"
    format_args = ["-filter_complex", fc, "-loop", str(p.loop)]
elif p.format == "webp":
    format_args = ["-vf", base_vf, "-c:v", "libwebp", "-lossless", "1" if p.lossless else "0", "-q:v", str(p.quality), "-compression_level", "4", "-loop", str(p.loop)]
elif p.format == "apng":
    plays = 0 if p.loop <= 0 else p.loop
    format_args = ["-vf", base_vf, "-c:v", "apng", "-plays", str(plays)]
```

### 3.5 Registration

```python
register(OperationSpec(
    id="mediaexport",
    summary="Palette & Media Export",
    description="Converts video to animated GIF, WebP, or APNG with fine-grained controls.",
    params_model=MediaExportParams,
    handler=mediaexport,
    tags=["export", "gif", "webp", "utility"],
))
```

---

## 4. Frontend: WebUI Integration

### 4.1 Tab placement

New tab named **"Export"** under a new **"Utility"** nav category in the sidebar. Uses a download/share SVG icon.
`data-tab="mediaexport"`

### 4.2 State key

```javascript
mediaexport: { inputPath: null }
```

### 4.3 Element IDs

Prefix: `me`

| Purpose | Element ID |
|---------|-----------|
| Input path text | `meInput` |
| Browse button | `btnMeBrowse` |
| Output path text | `meOutput` |
| Format select | `meFormat` |
| FPS knob | `meFps` |
| Width knob | `meWidth` |
| Quality knob | `meQuality` |
| Loop knob | `meLoop` |
| Lossless knob | `meLossless` |
| Dither select | `meDither` |
| Stats Mode select | `meStatsMode` |
| Dry run knob | `meDryRun` |

---

## 5. Files Touched

| File | Action |
|---|---|
| `app/operations/mediaexport_ops.py` | **CREATE** |
| `app/operations/__init__.py` | **EDIT** (add import) |
| `app/static/index.html` | **EDIT** (add Utility category & nav-item) |
| `app/static/app.js` | **EDIT** (state + form + collector + routing) |
| Root `AGENTS.md` | **EDIT** (ops registry table) |
