# Automation Envelope Spec — Freehand Parameter Modulation

> **Status:** UI brainstorm / historical  
> **Author:** m (Max) via tom  
> **Date:** 2026-07-31  
> **Implementation source of truth:** [`parameter-automation-spec.md`](./parameter-automation-spec.md) (grok rewrite — filter-platform aligned)  
> **Related:** filter-platform-spec.md, pool/persistence layer  
>  
> Keep this doc for freehand UX intent. Do **not** implement against this file alone —  
> param names, FilterFn signature, and “every float is automatable” conflict with the live stack.

---

## 1. Concept

A **destructive, per-clip, per-operation parameter envelope**. Not playback automation
— a curve you draw before running an operation. The filter reads one value per frame
from the envelope during processing.

Think: Reaper freehand automation draw (hold mouse, paint values) applied to a
render pass. FL Studio automation clip workflow — draw it, map it, run it —
but for video frames instead of DAW timeline.

The original file is never touched. The envelope is a **setting** on the operation.

---

## 2. User Workflow

```
1. Load clip in pool
2. Navigate to an operation tab (deepdream, rife, styletransfer, etc.)
3. Right-click any knob → "Automate"
4. Canvas overlay opens:
   - X axis = frames (or time, togglable)
   - Y axis = parameter range (min → max from the knob)
   - Dropdown at top: selects which automatable parameter (pre-filled to clicked knob)
5. Hold mouse button, draw the curve freehand
6. Release. Curve is stored.
7. Close overlay. Knob shows automation indicator (e.g. colored dot)
8. Run operation. Each frame reads interpolated value from envelope.
```

---

## 3. Drawing Model

### 3.1 Freehand draw only

- Mouse down → start recording cursor Y position per pixel-X movement
- Mouse up → stop
- No click-to-add-points. No bezier handles. No segment editing.
- **Every pixel column on the canvas maps to a frame.** 1px = 1 frame unless zoomed.
- Cursor Y is clamped to parameter min/max range.

### 3.2 Value resolution

Internally stored as an array of `{frame_index, value}` pairs at keyframes.
Between keyframes: linear interpolation during render.

Keyframe reduction: consecutive frames with identical values collapse to
start/end markers. Gradual slopes get sampled at reasonable density (every
N frames based on canvas resolution).

### 3.3 Drawing tools (minimal)

| Tool | Behavior |
|------|----------|
| **Freehand (default)** | Hold left mouse, paint values |
| **Line** | Hold shift while drawing = horizontal line at current Y (flat value) |
| **Clear** | Button — wipes envelope to default/identity value |
| **Invert** | Button — flips Y (high→low, low→high) |

No: eraser, brush size, undo stack (v1). Just draw, clear, invert.

---

## 4. Auto-Scaling

When an automation envelope is applied to a **different** parameter or clip, it
auto-scales:

### 4.1 Time scaling

Curve stored as percentage positions (0.0 → 1.0 of clip duration) rather than
absolute frame numbers. On application, scaled to actual frame count of target clip.

```
30-frame curve applied to 300-frame clip:
  curve position 0.5 → target frame 150

300-frame curve applied to 30-frame clip:
  curve position 0.5 → target frame 15
```

### 4.2 Amplitude scaling

Curve stored as 0.0 → 1.0 (normalized to parameter range). On application,
remapped to target parameter's min→max.

```
curve drawn for dream_strength (0.0–2.0):
  value 0.5 in curve → dream_strength 1.0

same curve applied to rife_factor (0.0–1.0):
  value 0.5 in curve → rife_factor 0.5
```

### 4.3 Default identity

Unset envelope = flat value at knob's current setting. The knob value IS the
identity line. Drawing overrides it per-frame.

---

## 5. Data Format

### 5.1 Envelope storage

```json
{
  "version": 1,
  "parameter": "dream_strength",
  "parameter_range": [0.0, 2.0],
  "clip_duration_frames": 240,
  "keyframes": [
    {"t": 0.0, "v": 0.5},
    {"t": 0.25, "v": 0.5},
    {"t": 0.26, "v": 0.8},
    {"t": 0.5, "v": 1.5},
    {"t": 0.75, "v": 1.5},
    {"t": 0.76, "v": 0.3},
    {"t": 1.0, "v": 0.3}
  ]
}
```

- `t`: normalized time 0.0–1.0 (percentage of clip duration)
- `v`: normalized value 0.0–1.0 (remapped to param range at render time)
- `parameter_range`: informational — the range this envelope was drawn against
- `clip_duration_frames`: informational — the frame count this was drawn for

### 5.2 Persistence

Envelopes stored per-clip, per-operation in the project/pool persistence layer.
Saved with project files. Also exportable/importable as standalone `.automation.json`
files for reuse across projects.

```
project.json
  clips:
    - id: "clip_abc"
      operations:
        deepdream:
          params: { ... }
          envelopes:
            dream_strength: { ...envelope... }
            dream_octaves: { ...envelope... }
```

---

## 6. UI Specification

### 6.1 Canvas overlay

A full-viewport modal/overlay that takes over the screen when opened (user's
explicit preference: "I am low on real estate on screen so I think it just
takes over").

```
┌─────────────────────────────────────────────────────┐
│  Automation: deepdream / dream_strength    [×]      │
│  ┌──────────────┐  [Draw] [Line] [Clear] [Invert]  │
│  │ Parameter ▼  │  [Save Preset] [Load Preset]      │
│  └──────────────┘                                    │
├─────────────────────────────────────────────────────┤
│  2.0 ┤                                              │
│      │         ╭────╮                               │
│  1.5 ┤        ╱      ╲                              │
│      │       ╱        ╲      ╭───╮                 │
│  1.0 ┤──────╱          ╲────╯   ╰────              │
│      │     ╱                                       │
│  0.5 ┤    ╱                                        │
│      │   ╱                                         │
│  0.0 ┤──╱────────────────────────────────────      │
│      └──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──      │
│      0s              2s             4s             │
├─────────────────────────────────────────────────────┤
│  [Apply] [Cancel]                                   │
└─────────────────────────────────────────────────────┘
```

### 6.2 Controls

| Element | Behavior |
|---------|----------|
| **Parameter dropdown** | Lists all numeric parameters for current filter |
| **Draw tool** | Freehand cursor — hold left mouse to paint |
| **Line tool** | Hold shift while drawing for flat horizontal line |
| **Clear button** | Resets envelope to flat identity at knob's current value |
| **Invert button** | Flips all values (0.0→1.0, 1.0→0.0) |
| **Save Preset** | Exports envelope as `.automation.json` |
| **Load Preset** | Imports envelope, auto-scales to current param+clip |
| **Apply** | Saves envelope, closes overlay, knob shows indicator |
| **Cancel** | Discards, closes overlay |

### 6.3 Knob indicator

When an envelope is active on a knob:
- Small colored dot appears next to knob label (e.g. green)
- Knob still shows its base value (used as fallback for unset frames)
- Right-click → "Remove automation" clears the envelope

### 6.4 Canvas rendering

- **Background**: dark grid (minor lines at 10% intervals, major at 25%)
- **X axis**: time labels (seconds or frames, togglable)
- **Y axis**: parameter range labels (actual values, not 0–1)
- **Curve**: colored line (green for active, red for inverted preview)
- **Cursor**: crosshair showing current frame + value on hover
- **No zoom (v1)**. Scroll/pinch zoom added later if needed.

---

## 7. Backend Integration

### 7.1 Filter contract change

Current per_frame signature:
```python
async def filter_fn(input_png: Path, output_png: Path, index: int) -> None:
```

With automation, the pipeline chain resolves envelopes per-frame and passes them:
```python
async def filter_fn(input_png: Path, output_png: Path, index: int, params: dict) -> None:
```

Where `params` is the resolved dict for this frame — a mix of static values
(from the operation form) and interpolated values (from envelopes). The filter
doesn't know which is which.

### 7.2 Pipeline chain envelope resolution

`pipeline_chain.py` gains an envelope resolver. Before processing frames:
1. Collect envelopes from the operation request
2. For each frame, interpolate envelope values at `frame / total_frames`
3. Merge with static params → `resolved_params`
4. Pass to stage factory

### 7.3 Operation request format

`POST /ops/deepdream` (or `/ops/pipeline`) accepts optional `envelopes`:

```json
{
  "input_path": "/pool/clip.mp4",
  "params": {
    "dream_strength": 1.0,
    "dream_octaves": 4
  },
  "envelopes": {
    "dream_strength": {
      "keyframes": [
        {"t": 0.0, "v": 0.25},
        {"t": 0.5, "v": 0.75},
        {"t": 1.0, "v": 0.25}
      ]
    }
  }
}
```

Static `params` values serve as defaults for parameters without envelopes
AND as fallback for envelope parameters (knob base value). If `dream_strength`
has both a static value (1.0) and an envelope, the envelope wins per-frame.

### 7.4 Interpolation

Linear interpolation between keyframes. No easing curves (v1). If frame falls
exactly on a keyframe, use that value. Between keyframes, lerp.

---

## 8. Parameter Discovery

### 8.1 Automatable parameters

Any numeric parameter on a filter stage is automatable. Discovered from the
operation's Pydantic model:

```python
class DeepDreamParams(BaseModel):
    dream_strength: float = 1.0     # automatable (float)
    dream_octaves: int = 4          # automatable (int → treated as float)
    dream_scale: float = 1.2        # automatable (float)
    dream_iterations: int = 10      # automatable (int)
    model_name: str = "default"     # NOT automatable (string/enum)
    enable_preview: bool = True     # NOT automatable (bool)
```

`int` and `float` fields → automatable. Everything else → static.

### 8.2 API endpoint

`GET /ops/{op_id}/parameters` — returns automatable parameters with their
types, ranges, and defaults.

```json
{
  "op_id": "deepdream",
  "parameters": [
    {"name": "dream_strength", "type": "float", "default": 1.0, "min": 0.0, "max": 2.0},
    {"name": "dream_octaves", "type": "int", "default": 4, "min": 1, "max": 8},
    ...
  ]
}
```

---

## 9. Files Touched

| File | Change |
|------|--------|
| `docs/automation-spec.md` | This spec |
| `app/static/js/automation.js` | Canvas overlay, drawing, presets (NEW) |
| `app/static/css/automation.css` | Overlay styles (NEW) |
| `app/static/js/tabs/*.js` | Right-click context menu on knobs |
| `app/static/css/forms.css` | Knob automation indicator styles |
| `app/static/js/pool/persistence.js` | Envelope save/load in projects |
| `app/pipeline_chain.py` | Envelope interpolation per-frame |
| `app/operations/*_ops.py` | Accept + forward envelopes to pipeline |
| `app/contract.py` | Envelope schema in OperationSpec |
| `app/media/*.py` | Parameter discovery endpoint |
| `app/filters/*.py` | Stage factories accept per-frame params |

---

## 10. Open Questions

1. **Erase tool?** Freehand draw is paint-only. To change a segment you
   redraw over it. Is that sufficient or do we need an erase/undo?
   
2. **Snap to grid?** Y-axis snapping to parameter increments (0.1, 0.25)?
   Useful for precise values but fights freehand flow.

3. **Preview render?** Before committing, render a short segment with
   the envelope applied and show it? Expensive — maybe deferred.

4. **Multi-parameter view?** Show multiple envelopes overlaid on same
   canvas (different colors)? Useful when parameters interact. Deferred.

5. **Envelope per pipeline step?** If pipeline chain has deepdream + rife,
   can each step have its own automation? Yes — envelopes scoped to
   filter stage, not the whole operation.

---

## 11. Implementation Order

1. **Spec** (this document) — done
2. **Parameter discovery** — `GET /ops/{op_id}/parameters` endpoint
3. **Canvas UI** — freehand draw overlay with dropdown + load/save preset
4. **Right-click context menu** — wire to knobs
5. **Envelope data format + persistence** — project save/load
6. **Backend interpolation** — pipeline chain resolves per-frame
7. **Filter contract update** — per_frame stages accept params dict
8. **Auto-scale** — time + amplitude when loading preset against different clip
