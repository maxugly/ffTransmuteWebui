# Spec: Audio Processing (`audioproc`)

> **Version**: 000.000.2.27 (next bump)
> **Status**: Approved — ready for implementation
> **Author**: Spec agent
> **Scope**: New operation — `audioproc_ops.py` + WebUI "Audio" tab

---

## 1. What It Does

Provides three audio manipulation modes for video files:
1. **Loudness Normalization**: EBU R128 loudness normalization for broadcast/streaming standards (LUFS, True Peak, Loudness Range).
2. **Mute/Strip Audio**: Removes all audio streams.
3. **Add Silent Audio Track**: Adds a proper silent audio track to a video without audio, ensuring compatibility with operations like concat.

No external tools. No Python engine. Pure `ffmpeg`.

---

## 2. FFmpeg Pipeline

**Important**: Video is NEVER re-encoded in any mode. Always `-c:v copy`.

### Mode 1: EBU R128 Loudness Normalization (loudnorm)

```bash
ffmpeg -i input.mp4 -af "loudnorm=I=-16:TP=-1.5:LRA=11" -c:v copy -c:a aac -b:a 192k -y output.mp4
```

- Audio must be re-encoded since it uses a filter.
- Does NOT affect video timing or duration.

### Mode 2: Mute/Strip Audio

```bash
ffmpeg -i input.mp4 -c:v copy -an -y output.mp4
```

- Removes all audio streams (`-an`).
- If input has no audio, ffmpeg exits 0 (no-op, just copies video).

### Mode 3: Add Silent Audio Track

```bash
ffmpeg -f lavfi -i "anullsrc=r=48000:cl=stereo" -i input.mp4 -map 1:v:0 -map 0:a:0 -c:v copy -c:a aac -b:a 128k -shortest -y output.mp4
```
*Note*: `coder-audioproc-prompt.md` may use `-i input.mp4 -f lavfi -i "anullsrc..." -map 0:v:0 -map 1:a:0` instead, which is also correct. The order of `-i` determines the map index.

- `-shortest` is CRITICAL (anullsrc generates infinite silence).
- Must use explicit `-map` (lavfi input confuses auto-selection).
- Cannot use `-c:a copy` with anullsrc (raw PCM, must encode).

---

## 3. Backend: `audioproc_ops.py`

### 3.1 File location

```
mtapi-project/app/operations/audioproc_ops.py
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

### 3.3 Pydantic model: `AudioProcParams`

| Field | Type | Default | Constraints | Description |
|---|---|---|---|---|
| `input_path` | `str` | _required_ | — | Source video path |
| `output_path` | `str \| None` | `None` | — | Output path; auto-named if omitted |
| `mode` | `Literal["normalize", "mute", "silence"]` | `"normalize"` | — | Audio operation mode |
| `target_lufs` | `float` | `-16.0` | `-70` to `-5` | Target integrated loudness (LUFS). Normalize mode only. |
| `true_peak` | `float` | `-1.5` | `-9` to `0` | Maximum true peak (dBTP). Normalize mode only. |
| `loudness_range` | `float` | `11.0` | `1` to `50` | Target loudness range (LU). Normalize mode only. |
| `sample_rate` | `int` | `48000` | — | Silent track sample rate. Silence mode only. |
| `channel_layout` | `Literal["stereo", "mono"]` | `"stereo"` | — | Silent track channel layout. Silence mode only. |
| `dry_run` | `bool` | `False` | — | Show command only |

### 3.4 Allowed output extensions

```python
VIDEO_EXTS = {".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi"}
```

### 3.5 Handler logic overview

Branches on `p.mode`:
- `normalize`: `-af loudnorm=...` + `-c:v copy` + `-c:a aac -b:a 192k`
- `mute`: `-c:v copy -an`
- `silence`: `-f lavfi -i anullsrc=... -map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -b:a 128k -shortest` (assuming input is index 0)

Output suffix: `_normalized`, `_muted`, `_silent` depending on mode.

---

## 4. Frontend: WebUI Integration

### 4.1 Tab placement

New tab named **"Audio"** under the "Utility" nav-header. Uses a volume/waveform icon.

`data-tab="audioproc"`

### 4.2 State key

```javascript
audioproc: { inputPath: null, mode: 'normalize' }
```

### 4.3 Element IDs

Prefix: `ap`

| Purpose | Element ID | Type |
|---------|-----------|------|
| Input path text | `apInput` | `<input text>` |
| Browse button | `btnApBrowse` | `<button>` |
| Output path text | `apOutput` | `<input text>` |
| Mode | `apMode` | `<select>` |
| Target LUFS | `apLufs` | continuous knob |
| True Peak | `apTruePeak` | continuous knob |
| Loudness Range | `apLra` | continuous knob |
| Sample Rate | `apSampleRate` | `<select>` |
| Channel Layout | `apChannelLayout` | `<select>` |
| Dry run | `apDryRun` | binary knob hidden |

Conditional visibility based on `apMode`.

### 4.4 Routing wiring (3 touch-points in app.js)

1. `renderTabForm(tab)` → `else if (tab === 'audioproc') { renderAudioprocForm(); }`
2. `runActiveOperation()` → `else if (tab === 'audioproc') { body = collectAudioprocBody(); ... opId = 'audioproc'; }`
3. `switchTab(tab)` → `if (tab === 'audioproc') title = 'Audio';`

### 4.5 Nav item in index.html

Added under the "Utility" section.

---

## 5. Files Touched

| File | Action |
|---|---|
| `app/operations/audioproc_ops.py` | **CREATE** |
| `app/operations/__init__.py` | **EDIT** (add import) |
| `app/static/index.html` | **EDIT** (add nav-item) |
| `app/static/app.js` | **EDIT** (state + form + collector + routing) |
