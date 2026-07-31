# Parameter Automation — Filter-Platform Version

> **Status:** Spec ready for phased implementation  
> **Author:** grok (audit + rewrite of Max/tom automation-spec)  
> **Date:** 2026-07-31  
> **Supersedes for implementation:** `docs/automation-spec.md` (keep as UI brainstorm)  
> **Also replaces intent of:** `docs/docs-automation-lanes.md` (older lanes scratchpad)  
> **Depends on:** `docs/filter-platform-spec.md`, `app/filters/*`, `video_pipeline.process`

---

## 0. Verdict on the prior spec

The original `automation-spec.md` is a **strong product vision** (freehand envelope, full-screen canvas, destructive-per-render not live playback). It is **not** implementation-ready as written against the current stack.

| Strength | Problem for builders |
|----------|----------------------|
| Clear DAW metaphor | Assumes every knob maps 1:1 to a per-frame filter input |
| Normalized `t` / auto-scale | Mixes normalized `v` (0–1) with raw `v` examples inconsistently |
| Envelope JSON sketch | Param names like `dream_strength` / `rife_factor` **do not exist** on live ops |
| `filter_fn(..., params: dict)` | Current contract is `filter_fn(in, out, index)` with **params closed over at factory time** |
| Pipeline resolver | Named ops (`/ops/deepdream`) do **not** go through `pipeline_chain` today |
| “Any numeric field automatable” | Directory stages (RIFE, speedramp) and enums/bools cannot freehand-modulate the same way |
| Persistence in project tree | Pool/project JSON exists but has **no op-envelope slot** yet — must design carefully |
| Full file list | Touches almost everything at once — high thrash risk |

**This document** keeps the freehand UX, locks data math, and wires automation through the **filter platform** with a phased path that works for **one op first** (DeepDream video or styletransfer strength).

---

## 1. Concept (locked)

**Render-time parameter envelopes**, not transport/playback automation.

- You draw a curve **before** Run.  
- During processing, each **source frame index** samples the curve.  
- The **source media is never modified**; envelopes are settings on the job.  
- Output is a new file (same as every other op).

Mental model: Reaper freehand automation, applied to a **one-shot render**, not a DAW playhead.

---

## 2. What can be automated (honest)

### 2.1 Automatable (v1)

Numeric parameters that a **`per_frame` stage** can read **per frame** without reloading heavy weights mid-frame:

| Op / stage | Good first targets | Why |
|------------|--------------------|-----|
| **styletransfer** | `strength` | Already per-frame blend; cheap |
| **deepdream** (video) | `step`, `iterations`, `blend`, `temporal_blend`, `octave_scale` | Used inside `dream_image` / filter closure |
| **withoutbg** | (none great in v1) | Model call is whole-frame; mode is discrete |

### 2.2 Not automatable in v1 (document, do not fake)

| Kind | Examples | Why |
|------|----------|-----|
| **Directory stages** | RIFE `multiplier`, speedramp curve | One bulk tool pass; not per-frame params |
| **Enums / paths / bools** | `model_name`, `backend`, `optical_flow` | Discrete; freehand Y-axis meaningless |
| **Geometry CLI** | transmute crop flags | No frame loop |
| **Convert codecs** | ProRes profile | Bookend, not mid-chain |
| **Datamosh** | melt intensity | File-level bitstream; different design |

v1 rule: **only `per_frame` stages**, only fields marked `automatable=True` in a small allowlist (not “every float on the Pydantic model”).

---

## 3. Data model

### 3.1 Normalized envelope (source of truth)

```json
{
  "version": 1,
  "param": "strength",
  "unit": "normalized",
  "keyframes": [
    { "t": 0.0, "v": 0.0 },
    { "t": 0.5, "v": 1.0 },
    { "t": 1.0, "v": 0.25 }
  ]
}
```

| Field | Meaning |
|-------|---------|
| `t` | Position in **source** timeline, **0.0–1.0** inclusive |
| `v` | **Always 0.0–1.0** normalized to the parameter’s declared min/max at draw time |
| `param` | Stage/op parameter name (must match allowlist) |

**Never store display-range values in `v`.** Map at draw and at sample time:

```text
display = min + v * (max - min)
v = (display - min) / (max - min)
```

### 3.2 Sampling

Given `frame_index` (0-based) and `frame_count` (dumped source frames):

```text
t = frame_index / max(frame_count - 1, 1)
value = lerp_keyframes(envelope, t)   # linear between neighbors
display = min + value * (max - min)
```

- If no envelope: use static form value.  
- If envelope present: envelope wins for that param (static is only the identity/clear line when drawing).

Keyframe reduction (optional at Apply): collapse flat runs; cap density to e.g. one point per canvas pixel column or max ~2000 points.

### 3.3 Request shape (HTTP)

Keep existing flat op bodies. Add optional top-level:

```json
{
  "input_path": "/abs/clip.mp4",
  "strength": 1.0,
  "style_path": "/abs/style.png",
  "envelopes": {
    "strength": {
      "version": 1,
      "param": "strength",
      "unit": "normalized",
      "keyframes": [ {"t": 0.0, "v": 0.2}, {"t": 1.0, "v": 0.9} ]
    }
  }
}
```

Pipeline:

```json
{
  "input_path": "/abs/clip.mp4",
  "filters": [
    {
      "name": "styletransfer",
      "params": { "style_path": "...", "strength": 1.0 },
      "envelopes": { "strength": { "keyframes": [...] } }
    }
  ]
}
```

---

## 4. Backend integration (filter platform)

### 4.1 Do **not** change FilterFn to `(…, params: dict)` in v1

Factories already close over static params. Automation needs **per-frame mutation of those closed values**.

**Preferred pattern:**

```python
# Shared helper (new): app/automation.py
def sample_envelope(env: dict | None, index: int, frame_count: int,
                    lo: float, hi: float, default: float) -> float:
    ...

def make_styletransfer_filter(..., strength=1.0, envelopes=None):
    env_s = (envelopes or {}).get("strength")
    async def filter_fn(src, dst, index):
        # need frame_count: pass via closure from process() or factory kwargs
        s = sample_envelope(env_s, index, frame_count, 0.0, 1.0, strength)
        # use s for this frame
    ...
```

`video_pipeline.process` should pass **total frame count** into the filter (or set it on the workspace metadata before process). Minimal change:

```python
# Option A (minimal): factory receives frame_count after dump
filter_fn = make_...(**, frame_count=dump_info["frame_count"], envelopes=...)

# Option B: process sets workspace.metadata["frame_count"] and filters read it
```

**v1 implements Option A** in each thin op that supports envelopes (no global signature break).

### 4.2 Directory stages

No envelope sampling inside RIFE/speedramp for v1.  
UI: do not offer “Automate” on those knobs (or show disabled tooltip).

### 4.3 Named op path

`/ops/styletransfer` and `/ops/deepdream` already run their own dump→process→encode.  
Envelope support is added **there first**, not only in `pipeline_chain`.  
When pipeline is used, each step’s `envelopes` are passed into the same factory kwargs.

### 4.4 Parameter discovery

Do **not** invent `GET /ops/{id}/parameters` as a second schema source if avoidable.

**v1:** static allowlist per op in code + UI:

```python
# app/automation_params.py
AUTOMATABLE = {
  "styletransfer": {
    "strength": {"min": 0.0, "max": 1.0, "default": 1.0},
  },
  "deepdream": {
    "step": {"min": 0.0001, "max": 0.5, "default": 0.01},
    "iterations": {"min": 1, "max": 200, "default": 20},
    "blend": {"min": 0.0, "max": 1.0, "default": 1.0},
    "temporal_blend": {"min": 0.0, "max": 1.0, "default": 0.85},
  },
}
```

Optional later: generate from Pydantic Field metadata (`json_schema_extra={"automatable": True, "min": ...}`).

---

## 5. UI (keep freehand; align with real knobs)

### 5.1 Entry

- Right-click automatable knob → **Automate…**  
- Or small “A” button next to allowlisted knobs only.

### 5.2 Overlay

Full-viewport modal (user preference for screen real estate):

- Parameter dropdown = **allowlist for current op only**  
- X = normalized time (labels in seconds if clip duration known from pool/probe)  
- Y = **display range** of param (labels show real units; storage still 0–1)  
- Tools: freehand, shift=horizontal line, Clear, Invert  
- Apply / Cancel  
- Save/Load preset as `.automation.json` (normalized format)

### 5.3 Drawing model (v1)

- Freehand only: record `(t, v)` samples while pointer down  
- Map canvas X → t, canvas Y → v (0–1)  
- On Apply: simplify keyframes  
- **Redraw-over to edit** (no eraser/undo stack in v1)

### 5.4 Indicators

- Dot on knob when envelope attached  
- Right-click → Remove automation  
- Static knob value remains identity for Clear / drawing baseline

### 5.5 Clip length for X axis

Prefer probed frame count of the **current op input path** (global video field / pool selection).  
If unknown, use last known probe or disable Apply with “set an input video first”.

---

## 6. Persistence

### 6.1 Session (v1)

Hold envelopes in frontend state keyed by:

```text
`${opId}::${param}`  (+ optional input_path hash later)
```

Send on Run as `envelopes` in POST body.

### 6.2 Project (v1.1)

Extend project/pool JSON carefully — **do not** invent nested `clips[].operations.deepdream` unless pool already has that shape.

Safer slot:

```json
{
  "automation": {
    "by_op": {
      "styletransfer": {
        "strength": { "version": 1, "keyframes": [...] }
      }
    }
  }
}
```

Or attach to pool item metadata when a clip is selected. Spec detail in implementation PR once pool schema is read.

---

## 7. Implementation order (mandatory)

### Phase A — Core library (no UI)

1. `app/automation.py`: validate envelope, sample, lerp, simplify  
2. Unit-style smoke: sample mid-point values by hand  
3. Wire **styletransfer** filter + op only (`strength`)  
4. Curl `/tmp/teste_half.mp4` with envelope 0→1 strength; verify no crash  

### Phase B — UI for one op

5. `js/automation.js` + `css/automation.css` freehand overlay  
6. Wire styletransfer strength knob only  
7. Run from WebUI; zero console errors  

### Phase C — DeepDream video

8. Allowlist deepdream video params; sample inside `make_deepdream_filter`  
9. Note: changing `iterations` per frame is expensive — still valid  
10. WebUI Automate on those knobs  

### Phase D — Pipeline + persistence

11. Pass `envelopes` through `pipeline_ops` step params  
12. Project save/load slot  
13. Preset import/export polish  

**Do not** start with multi-op canvas, datamosh, or RIFE multiplier automation.

---

## 8. Files to touch (phased)

| Phase | Files |
|-------|--------|
| A | `app/automation.py` (new), `filters/styletransfer.py`, `operations/styletransfer_ops.py` |
| B | `static/js/automation.js`, `static/css/automation.css`, `tabs/styletransfer.js`, `index.html` link css, `app.js` if needed |
| C | `filters/deepdream.py`, `deepdream_ops.py`, `tabs/deepdream.js` |
| D | `pipeline_ops.py`, pool/project persistence modules |

Out of scope until later: `contract.py` OperationSpec surgery, new OpenAPI params endpoint, Convert, transmute, datamosh.

---

## 9. Verification

### Styletransfer strength ramp

```bash
# After Phase A
# POST /ops/styletransfer with envelopes.strength keyframes 0→1
# Input: /tmp/teste_half.mp4 + style image
# Expect: ok True; visual strength rises (spot-check frames if needed)
```

### UI

1. Open Style Transfer, set input + style  
2. Automate strength, draw rising curve, Apply  
3. Run — zero console errors; `ok: true`  
4. Remove automation — run uses static strength  

### Regression

- Styletransfer/deepdream without `envelopes` unchanged  
- RIFE / speedramp / convert unaffected  

---

## 10. Pitfalls

1. **Closing over static strength** and ignoring envelopes — sample every frame.  
2. **Wrong frame_count** (use dump count, not UI estimate).  
3. **Directory stage** + envelopes — refuse or ignore.  
4. **Storing raw display values** in JSON — breaks auto-scale across params.  
5. **Int params** — sample as float, round when calling engine if required.  
6. **Heavy TF per-frame param changes** — OK for strength; iterations per frame is slow (document).  
7. **Pipeline step isolation** — envelopes are per step, not global.  

---

## 11. Open questions (deferred, not blocking Phase A–B)

| Q | Recommendation |
|---|----------------|
| Eraser / undo | v2; redraw-over for v1 |
| Y snap | off by default |
| Preview segment | deferred (expensive) |
| Multi-envelope overlay | deferred |
| Bezier easing | linear only v1 |
| Automate speedramp | no — it *is* a curve already |

---

## 12. Relation to other docs

| Doc | Role |
|-----|------|
| `automation-spec.md` | Original freehand UX brainstorm (keep) |
| **This file** | Implementation source of truth |
| `docs-automation-lanes.md` | Older scratch; obsolete for builders |
| `filter-platform-spec.md` | Stage kinds / dump-encode rules |

---

## 13. Summary for builders

**Ship:** freehand envelope → normalized keyframes → sample in `per_frame` factory → styletransfer first.  
**Do not ship:** global FilterFn signature rewrite, “all floats automatable”, RIFE multiplier envelopes, setpts-era hacks.  
**Platform fit:** automation is a **per-frame override layer** on top of static factory params, not a second pipeline.
