# Spec: Time-Lapse / Frame Sampling (`timelapse`)

> **Status**: Approved — ready for implementation
> **Scope**: New operation — `timelapse_ops.py` + WebUI tab integration (or sub-tab)
> **Depends on**: `ffmpeg` (already on PATH)

---

## 1. What It Does

Two related effects that both work by decimating frames:

**Mode A — Time-Lapse (speedup):** Compresses a long video into a short one. A 60s clip becomes a 6s clip at normal frame rate. Content plays 10× faster. Audio is dropped or sped up. This is what a security camera time-lapse looks like.

**Mode B — Stop-Motion (frame rate reduction):** Keeps the original duration but reduces the frame rate. A 60s clip stays 60s but shows only 1 frame per second instead of 30. Audio is preserved at full duration. This looks like choppy stop-motion or a slideshow.

Both modes are a single `ffmpeg` invocation. No external tools, no frame dumps, no temp dirs.

---

## 2. FFmpeg Pipelines

### Mode A — Time-Lapse (speedup by factor N)

```bash
ffmpeg -i <input> \
       -vf "setpts=PTS/<N>" \
       -r <output_fps> \
       -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p \
       -an \
       -y <output>
```

How it works:
- `setpts=PTS/N` divides every frame's presentation timestamp by N, compressing time.
- `-r <output_fps>` sets the output frame rate (default: probe the input's fps and keep it).
- ffmpeg automatically drops the excess frames that pile up at the compressed timestamps.
- Audio is dropped (`-an`) by default — sped-up audio is chipmunk noise. Optionally keep it with an `atempo` chain.

**Duration math:** `output_duration = input_duration / speed_factor`

### Mode B — Stop-Motion (reduce fps, keep duration)

```bash
ffmpeg -i <input> \
       -vf "fps=<target_fps>" \
       -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p \
       -c:a copy \
       -y <output>
```

How it works:
- `fps=N` resamples to N frames per second using nearest-neighbor timestamp selection.
- Duration is preserved — a 60s video stays 60s.
- Audio passes through untouched (`-c:a copy`).

**Frame math:** `output_frames = input_duration × target_fps`

### Audio speedup chain (optional, Mode A only)

For keeping sped-up audio instead of dropping it, `atempo` has a max of 100.0 per instance. For factors > 100×, chain them:

```python
def atempo_chain(speed: float) -> str:
    parts = []
    remaining = speed
    while remaining > 100.0:
        parts.append("atempo=100.0")
        remaining /= 100.0
    if remaining != 1.0:
        parts.append(f"atempo={remaining}")
    return ",".join(parts) if parts else "atempo=1.0"
```

When audio is kept, the pipeline adds `-af "<atempo_chain>"` and replaces `-an` with `-c:a aac -b:a 128k`.

---

## 3. Backend: `timelapse_ops.py`

### 3.1 File location

```
mtapi-project/app/operations/timelapse_ops.py
```

### 3.2 Imports

```python
from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

from ..contract import OperationResult, OperationSpec, register
from ..pathutil import finalize_output_path
from ..shell import run_command, probe_duration
```

No temp dirs, no frame dumps, no engine files.

### 3.3 Types

```python
TimelapseMode = Literal["timelapse", "stopmotion"]
AudioMode = Literal["drop", "keep", "speed"]
```

### 3.4 Pydantic model: `TimelapseParams`

| Field | Type | Default | Constraints | Description |
|---|---|---|---|---|
| `input_path` | `str` | _required_ | — | Absolute path to source video. |
| `output_path` | `str \| None` | `None` | — | Output path; auto-named if omitted. |
| `mode` | `TimelapseMode` | `"timelapse"` | — | `"timelapse"` = speedup (shorter output), `"stopmotion"` = reduce fps (same duration). |
| `speed_factor` | `float` | `10.0` | `ge=1.5, le=1000` | Speed multiplier for timelapse mode. 10 = 10× faster. Ignored in stopmotion mode. |
| `target_fps` | `float` | `1.0` | `ge=0.1, le=30` | Target frame rate for stopmotion mode. Ignored in timelapse mode. |
| `audio` | `AudioMode` | `"drop"` | — | `"drop"` = strip audio, `"keep"` = preserve (stopmotion only), `"speed"` = speed up audio with atempo (timelapse only). |
| `dry_run` | `bool` | `False` | — | Show the command without executing. |

#### Design notes

- **`speed_factor`** and **`target_fps`** are both always present in the model but each is only used by its respective mode. The handler ignores the irrelevant field. The UI conditionally shows the relevant control.
- **`speed_factor` range**: 1.5–1000. Below 1.5 is barely noticeable. Above 1000 produces near-empty files.
- **`target_fps` range**: 0.1–30. Below 0.1 (one frame per 10 seconds) is too sparse. Above 30 is a no-op for most inputs.
- **`audio="keep"`** is only meaningful in stopmotion mode (duration unchanged). In timelapse mode, `"keep"` is silently treated as `"drop"` because unsynchronized audio is worse than no audio.
- **`audio="speed"`** chains `atempo` filters to match the speed factor. Only meaningful in timelapse mode. In stopmotion mode, `"speed"` is silently treated as `"keep"`.

### 3.5 Allowed output extensions

```python
VIDEO_EXTS = {".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi"}
```

### 3.6 Helper: `_build_atempo_chain`

```python
def _build_atempo_chain(speed: float) -> str:
    parts: list[str] = []
    remaining = speed
    while remaining > 100.0:
        parts.append("atempo=100.0")
        remaining /= 100.0
    if abs(remaining - 1.0) > 0.001:
        parts.append(f"atempo={remaining}")
    return ",".join(parts) if parts else "atempo=1.0"
```

### 3.7 Handler: `async def timelapse(p: TimelapseParams) -> OperationResult`

Pseudocode:

```
1. Resolve input_path → Path, check exists.
2. Probe input fps:
     code, out, _ = await run_command(["ffprobe", ...r_frame_rate...])
     input_fps = parse (e.g. "30000/1001" → 29.97)
3. Resolve output path:
     suffix = "_timelapse" if mode == "timelapse" else "_stopmotion"
     out = finalize_output_path(p.output_path, source=input_path,
         default_suffix=suffix, default_ext=".mp4", allowed_exts=VIDEO_EXTS)
4. Branch on mode:

   MODE A — timelapse:
     vf = f"setpts=PTS/{p.speed_factor}"
     argv = [
         "ffmpeg",
         "-i", str(input_path),
         "-vf", vf,
         "-r", str(input_fps),          # preserve original fps in output
         "-c:v", "libx264", "-preset", "fast", "-crf", "18",
         "-pix_fmt", "yuv420p",
     ]
     if p.audio == "speed":
         atempo = _build_atempo_chain(p.speed_factor)
         argv.extend(["-af", atempo, "-c:a", "aac", "-b:a", "128k"])
     else:
         argv.append("-an")
     argv.extend(["-y", str(out)])

   MODE B — stopmotion:
     vf = f"fps={p.target_fps}"
     argv = [
         "ffmpeg",
         "-i", str(input_path),
         "-vf", vf,
         "-c:v", "libx264", "-preset", "fast", "-crf", "18",
         "-pix_fmt", "yuv420p",
     ]
     if p.audio in ("keep", "speed"):
         argv.extend(["-c:a", "copy"])
     else:
         argv.append("-an")
     argv.extend(["-y", str(out)])

5. Build summary string.
6. If dry_run: return OperationResult with command= but no execution.
7. code, stdout, stderr = await run_command(argv)
8. Return OperationResult(ok=code==0, output_path=str(out), ...).
```

### 3.8 Registration

```python
register(OperationSpec(
    id="timelapse",
    summary="Time-Lapse / Stop-Motion frame sampling",
    description=(
        "Two modes: Time-Lapse compresses a long video into a short fast-forward "
        "(10× speedup → 60s becomes 6s). Stop-Motion keeps the original duration "
        "but reduces frame rate for a choppy slideshow effect (30fps → 1fps). "
        "Pure ffmpeg — no external tools."
    ),
    params_model=TimelapseParams,
    handler=timelapse,
    tags=["timelapse", "speed", "frame-sampling"],
))
```

### 3.9 Import registration

Add `timelapse_ops` to `app/operations/__init__.py`.

---

## 4. Frontend: WebUI Integration

### 4.1 Decision: New tab or sub-mode of existing tab?

**New tab** named **"Time-Lapse"** under the Moshing/Glitch nav category, after the Vectors tab. Rationale: this is a standalone ffmpeg filter operation with its own parameter set. It doesn't belong in Transmute (which wraps the bash transmute script) or any other existing tab.

### 4.2 Nav item in `index.html`

Insert after the Vectors nav-item (which is after Mosh):

```html
<div class="nav-item" data-tab="timelapse">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
       stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="10"/>
    <polyline points="12 6 12 12 16 14"/>
  </svg>
  Time-Lapse
</div>
```

> The SVG is the standard "clock" icon — a circle with clock hands.

### 4.3 State key

```javascript
timelapse: { inputPath: null }
```

### 4.4 Form layout

The form has two visual states depending on the mode toggle:

```
┌──────────────────────────────────────────────┐
│ Time-Lapse · Frame Sampling                  │
│ Speed up video or reduce frame rate for      │
│ stop-motion effects. Pure ffmpeg.            │
├──────────────────────────────────────────────┤
│ Input video          [_______________][Browse]│
│ Output path (blank = auto) [______________]  │
│                                              │
│ KNOB BANK:                                   │
│  [Mode: Time-Lapse ←→ Stop-Motion]           │
│                                              │
│ ── when Mode = Time-Lapse: ──────────────    │
│  Speed (continuous knob): 10.0×              │
│  min=1.5  max=100  step=0.5                  │
│                                              │
│ ── when Mode = Stop-Motion: ─────────────    │
│  Target FPS (continuous knob): 1.0           │
│  min=0.1  max=15  step=0.1                   │
│                                              │
│ KNOB BANK:                                   │
│  [Audio: Drop ←→ Keep/Speed]  [Dry: Run]     │
│                                              │
│ Time-Lapse: compresses duration (60s → 6s)   │
│ Stop-Motion: keeps duration, reduces fps     │
│ Audio: Drop removes audio, Keep preserves,   │
│ Speed pitches audio to match (chipmunk!)     │
└──────────────────────────────────────────────┘
```

### 4.5 Element IDs

| Purpose | Element ID | Type | Initial |
|---------|-----------|------|---------|
| Input path | `tlInput` | `<input text>` | `''` |
| Browse button | `btnTlBrowse` | `<button>` | — |
| Output path | `tlOutput` | `<input text>` | `''` |
| Mode toggle | `tlMode` | binary knob hidden | `'timelapse'` |
| Speed factor | `tlSpeed` | continuous knob hidden | `'10.0'` |
| Target fps | `tlFps` | continuous knob hidden | `'1.0'` |
| Audio mode | `tlAudio` | `<select>` | `'drop'` |
| Dry run | `tlDryRun` | binary knob hidden | `'0'` |

### 4.6 Conditional visibility

When mode toggles, show/hide the speed vs fps knob:
- **timelapse** → show `tlSpeed` knob, hide `tlFps` knob, audio dropdown shows "Drop" and "Speed" options
- **stopmotion** → show `tlFps` knob, hide `tlSpeed` knob, audio dropdown shows "Drop" and "Keep" options

Implementation: wrap each conditional knob in a `<div>` with an ID (`tlSpeedGroup` / `tlFpsGroup`) and toggle `display: none` on the mode change event. Or simpler: re-render the knob bank when mode changes (matches how the mosh tab swaps between melt/classic/hijack mode panels).

### 4.7 Payload collector: `collectTimelapseBody()`

```javascript
function collectTimelapseBody() {
  const input = (document.getElementById('tlInput')?.value
    || state.timelapse?.inputPath || '').trim();
  if (!input) {
    alert('Pick a video.');
    return null;
  }
  const mode = document.getElementById('tlMode')?.value || 'timelapse';
  return {
    input_path: input,
    output_path: document.getElementById('tlOutput')?.value?.trim() || null,
    mode: mode,
    speed_factor: parseFloat(document.getElementById('tlSpeed')?.value) || 10.0,
    target_fps:   parseFloat(document.getElementById('tlFps')?.value) || 1.0,
    audio: document.getElementById('tlAudio')?.value || 'drop',
    dry_run: document.getElementById('tlDryRun')?.value === '1',
  };
}
```

### 4.8 Routing wiring (3 touch-points in app.js)

1. `renderTabForm(tab)` → `else if (tab === 'timelapse') { renderTimelapseForm(); }`
2. `runActiveOperation()` → `else if (tab === 'timelapse') { body = collectTimelapseBody(); if (!body) return; opId = 'timelapse'; }`
3. `switchTab(tab)` title → `'timelapse'` → `'Time-Lapse'`

---

## 5. Edge Cases

| Condition | Behavior |
|---|---|
| Input < 1 second + timelapse 10× | Output is ~0.1s. ffmpeg handles it but result is near-empty. No special handling — user gets what they asked for. |
| speed_factor = 1.5 (barely noticeable) | Allowed. Lower bound is 1.5 to prevent no-ops. |
| speed_factor = 1000 (extreme) | Allowed but produces very short output. A 60s clip → 0.06s. |
| target_fps >= input fps (e.g. 30fps input, target 30) | `fps=30` on a 30fps input is a no-op (re-encode only). Allowed — not harmful, just pointless. |
| target_fps = 0.1 (one frame per 10 seconds) | Valid. 60s input → 6 frames over 60s. Slideshow. |
| VFR input | `fps=N` normalizes to CFR. `setpts=PTS/N` works correctly on VFR. |
| Audio = "speed" in stopmotion mode | Silently treated as "keep" (duration unchanged, no speedup needed). |
| Audio = "keep" in timelapse mode | Silently treated as "drop" (unsynchronized audio is worse than none). |
| ProRes/MJPEG/other intra-only | Works fine — no motion vector dependency. Any codec decodes, filter applies, re-encodes. |

---

## 6. Files Touched

| File | Action | Est. Lines |
|---|---|---|
| `app/operations/timelapse_ops.py` | **CREATE** | ~100 |
| `app/operations/__init__.py` | **EDIT** (add import) | +1 |
| `app/static/index.html` | **EDIT** (add nav-item) | +8 |
| `app/static/app.js` | **EDIT** (state + form + collector + routing) | ~110 |
| Root `AGENTS.md` | **EDIT** (ops registry table) | +1 |

No new dependencies. No new CSS. No engine files. No temp directories.

---

## 7. Why This Design

1. **One operation, two modes.** Time-lapse and stop-motion are conceptually the same thing (frame decimation) with different timestamp handling. A mode toggle is cleaner than two separate operations that share 80% of their code.

2. **`setpts=PTS/N` for timelapse, not `select`.** The `select='not(mod(n,N))'` approach requires `-vsync vfr` and produces variable frame rate output that some players handle poorly. `setpts=PTS/N` is simpler, produces CFR output, and lets ffmpeg handle frame selection internally.

3. **`fps=N` for stopmotion, not `select`.** Same reasoning — `fps=N` produces clean CFR output with proper timestamps. `select` with `-vsync vfr` creates VFR output that's harder to edit downstream.

4. **Audio as a three-way select, not a knob.** "Drop/Keep/Speed" are three distinct behaviors, not a binary toggle. A `<select>` dropdown is more appropriate than a binary knob, and it avoids the awkward "what does the middle position mean?" question.

5. **Mode-dependent visibility.** Speed factor is meaningless in stopmotion mode; target fps is meaningless in timelapse mode. Showing both would confuse. The UI hides the irrelevant control based on mode selection.

6. **Generous ranges.** `speed_factor` up to 1000× and `target_fps` down to 0.1 cover extreme use cases. Edge cases at the boundaries are handled gracefully (very short or very sparse output is valid, just unusual).
