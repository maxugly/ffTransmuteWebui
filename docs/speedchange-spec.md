# Spec: Speed Change (`speedchange`)

> **Status:** Implemented (as-built) — see also Speed tab + optional RIFE  
> **Code:** `mtapi-project/app/operations/speedchange_ops.py`, `js/tabs/speedchange.js`  
> **Note:** This original draft was pure `setpts`+`atempo`. Shipped code adds **target FPS**, **frame-budget warn**, and **optional RIFE** (dump→RIFE→encode) when density is short. Prefer the as-built op + UI over this file for builder truth; keep §2 ffmpeg math for the fast path.

---

## 1. What It Does

Uniform speed change — speed up or slow down a video with pitch-preserved audio (fast path).
No ramp, no acceleration curve. One factor applied to the entire clip.

This fills the gap between:
- **Speed Ramp** (`speed_ramp`): Variable speed over time (optional RIFE before remap).
- **Time-Lapse** (backlog): Extreme speedup with audio dropped.

**As-built:** speed factor + optional target FPS + optional RIFE when frame budget is short.
Fast path remains pure `ffmpeg` setpts + atempo; RIFE path uses filter-platform dump/encode.

---

## 2. FFmpeg Pipeline

### Core Math

Given a speed factor `S`:
- **Video**: `setpts=(1/S)*PTS`
  - S=2.0 → `setpts=0.5*PTS` (2× faster, halves duration)
  - S=0.5 → `setpts=2.0*PTS` (2× slower, doubles duration)
- **Audio**: `atempo=S` (pitch-preserved time-stretch)
  - S=2.0 → `atempo=2.0` (audio 2× faster, same pitch)
  - S=0.5 → `atempo=0.5` (audio 2× slower, same pitch)

### atempo Chaining

`atempo` accepts values in the range **[0.5, 100.0]** per instance.
For factors outside this range, chain multiple instances:

| Speed Factor | atempo Chain |
|---|---|
| 0.25 | `atempo=0.5,atempo=0.5` |
| 0.125 | `atempo=0.5,atempo=0.5,atempo=0.5` |
| 3.0 | `atempo=3.0` |
| 4.0 | `atempo=4.0` |

### Audio Mode

Three audio strategies:
1. **`preserve`** (default): Use `atempo` — pitch stays the same, speed changes.
   Best for speech, music, general content.
2. **`pitch`**: Use `asetpts` — pitch shifts proportionally.
   Chipmunk (fast) or deep/slowed (slow). Zero CPU cost. Creative effect.
3. **`drop`**: Strip audio entirely (`-an`). Useful above 4× where atempo degrades.

### Complete Commands

**Speed up 2× (pitch-preserved audio):**
```bash
ffmpeg -i input.mp4 \
  -vf "setpts=0.5*PTS" \
  -af "atempo=2.0" \
  -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p \
  -c:a aac -b:a 192k \
  -y output.mp4
```

**Slow down 0.5× (pitch-preserved audio):**
```bash
ffmpeg -i input.mp4 \
  -vf "setpts=2.0*PTS" \
  -af "atempo=0.5" \
  -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p \
  -c:a aac -b:a 192k \
  -y output.mp4
```

**Slow down 0.25× (chained atempo):**
```bash
ffmpeg -i input.mp4 \
  -vf "setpts=4.0*PTS" \
  -af "atempo=0.5,atempo=0.5" \
  -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p \
  -c:a aac -b:a 192k \
  -y output.mp4
```

**Speed up 3× (drop audio):**
```bash
ffmpeg -i input.mp4 \
  -vf "setpts=PTS/3" \
  -an \
  -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p \
  -y output.mp4
```

**Speed up 2× (pitch-shifted audio — chipmunk):**
```bash
ffmpeg -i input.mp4 \
  -vf "setpts=0.5*PTS" \
  -af "asetpts=PTS/2" \
  -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p \
  -c:a aac -b:a 192k \
  -y output.mp4
```

### Audio Detection

If the input has no audio streams, the handler MUST skip `-af` and use `-an`.
Running `atempo` on a file with no audio produces an ffmpeg error.

Detect via ffprobe:
```bash
ffprobe -v error -select_streams a -show_entries stream=codec_type -of csv=p=0 input.mp4
```
If output is empty → no audio → use `-an`.

---

## 3. Backend: `speedchange_ops.py`

### 3.1 File location

```
mtapi-project/app/operations/speedchange_ops.py
```

### 3.2 Pydantic model: `SpeedChangeParams`

```python
class SpeedChangeParams(BaseModel):
    input_path: str = Field(..., description="Source video path")
    output_path: str | None = Field(None, description="Output path; auto-named if omitted")
    speed: float = Field(2.0, gt=0.0, le=100.0,
        description="Speed factor: 2.0 = 2× faster, 0.5 = 2× slower")
    audio_mode: Literal["preserve", "pitch", "drop"] = Field(
        "preserve",
        description="Audio handling: preserve (atempo, same pitch), "
                    "pitch (shifted proportionally), drop (strip audio)")
    dry_run: bool = Field(False, description="Print command only")
```

### 3.3 atempo Chain Builder

```python
def _build_atempo_chain(speed: float) -> str:
    """Build chained atempo filters for arbitrary speed factors."""
    parts: list[str] = []
    remaining = speed
    while remaining < 0.5:
        parts.append("atempo=0.5")
        remaining /= 0.5
    while remaining > 100.0:
        parts.append("atempo=100.0")
        remaining /= 100.0
    if abs(remaining - 1.0) > 0.001:
        parts.append(f"atempo={remaining:.6f}")
    return ",".join(parts) if parts else "atempo=1.0"
```

### 3.4 Handler Logic

```python
async def speedchange(p: SpeedChangeParams) -> OperationResult:
    inp = Path(p.input_path).expanduser().resolve()
    if not inp.is_file():
        return OperationResult(ok=False, ...)

    if abs(p.speed - 1.0) < 0.001:
        return OperationResult(ok=False, error="Speed is already 1.0 — nothing to do.")

    out = finalize_output_path(p.output_path, source=inp,
        default_suffix="_speed", default_ext=".mp4")

    setpts_factor = 1.0 / p.speed
    vf = f"setpts={setpts_factor:.6f}*PTS"

    argv = ["ffmpeg", "-i", str(inp), "-vf", vf]

    # Check for audio streams (ffprobe)
    has_audio = await _probe_has_audio(inp)

    if not has_audio or p.audio_mode == "drop":
        argv.append("-an")
    elif p.audio_mode == "preserve":
        chain = _build_atempo_chain(p.speed)
        argv.extend(["-af", chain])
        argv.extend(["-c:a", "aac", "-b:a", "192k"])
    elif p.audio_mode == "pitch":
        af_pts = f"asetpts={setpts_factor:.6f}*PTS"
        argv.extend(["-af", af_pts])
        argv.extend(["-c:a", "aac", "-b:a", "192k"])

    argv.extend(["-c:v", "libx264", "-preset", "fast", "-crf", "18",
                 "-pix_fmt", "yuv420p", "-y", str(out)])

    ...  # dry_run check, run_command, return OperationResult
```

### 3.5 Audio Probe Helper

```python
async def _probe_has_audio(path: Path) -> bool:
    code, stdout, _ = await run_command([
        "ffprobe", "-v", "error",
        "-select_streams", "a",
        "-show_entries", "stream=codec_type",
        "-of", "csv=p=0",
        str(path),
    ])
    return bool(stdout.strip())
```

### 3.6 Registration

```python
register(OperationSpec(
    id="speedchange",
    summary="Speed Change (Uniform)",
    description=(
        "Uniform speed up or slow down with pitch-preserved audio. "
        "0.25×–100× range. Pure ffmpeg setpts + atempo."
    ),
    params_model=SpeedChangeParams,
    handler=speedchange,
    tags=["speed", "time", "utility"],
))
```

---

## 4. Frontend: WebUI Integration

### 4.1 Tab placement

New tab named **"Speed"** under the **"Utility"** nav category.
`data-tab="speedchange"`

Uses a fast-forward/play-speed SVG icon.

### 4.2 State key

```javascript
speedchange: { inputPath: null },
```

### 4.3 Element IDs

Prefix: `sc`

| Purpose | Element ID |
|---------|-----------|
| Input path text | `scInput` |
| Browse button | `btnScBrowse` |
| Output path text | `scOutput` |
| Speed knob | `scSpeed` |
| Audio mode select | `scAudioMode` |
| Dry run knob | `scDryRun` |

### 4.4 UI Layout

Simple form:
1. Input file browser (text + Browse button)
2. Output path (optional override)
3. **Speed knob**: Continuous, 0.25–4.0, step 0.05, default 2.0
   - Display: "0.25× (4× slower)" … "1.0× (original)" … "4.0× (4× faster)"
   - The knob label should show the human-readable multiplier
4. **Audio mode select**: `<select>` with three options:
   - "Preserve pitch (atempo)" — default
   - "Shift pitch (chipmunk/deep)"
   - "Drop audio"
5. Dry run binary knob

### 4.5 Hint text

```
Speed < 1.0 = slow motion. Speed > 1.0 = fast forward.
"Preserve pitch" keeps voices natural. "Shift pitch" gives chipmunk (fast) or deep (slow) effects.
Slowdown below 0.5× may produce choppy video — use RIFE for smooth slow-mo.
```

---

## 5. Edge Cases & Gotchas

1. **Speed = 1.0**: Reject with error "Speed is already 1.0". Prevents
   pointless re-encode.

2. **No audio in input**: Must detect via ffprobe. If no audio, skip `-af`
   and use `-an`. Running `atempo` on audio-less input crashes ffmpeg.

3. **Slowdown choppy frames**: At 0.5× of 30fps, effective output is 15fps
   (each frame displayed twice). At 0.25× → 7.5fps (very choppy). This is
   inherent to frame duplication. For smooth slow-mo, users should use RIFE.
   Document this in the UI hint.

4. **atempo chain for extreme values**: Speed=0.25 requires
   `atempo=0.5,atempo=0.5`. The builder function handles this automatically.

5. **atempo quality degrades above ~4×**: Above 4×, audio sounds robotic.
   UI hint: "Consider 'Drop audio' above 4×."

6. **pitch mode + slowdown**: `asetpts=2.0*PTS` produces deep/slow audio.
   This is intentional — it's a creative effect (vaporwave aesthetic).

7. **`from __future__ import annotations`**: Fine in `speedchange_ops.py`.
   Do NOT add to `main.py`.

---

## 6. Comparison with Existing Ops

| Op | Range | Audio | Use Case |
|---|---|---|---|
| **Speed Change** (this) | 0.25×–4.0× | atempo (pitch-preserved) | Everyday editing |
| **Time-Lapse** | 1.5×–1000× | Dropped | Extreme speedup |
| **Speed Ramp** | Variable | Complex | Acceleration curves |

No overlap. Each covers a distinct speed regime.

---

## 7. Files Touched

| File | Action |
|---|---|
| `app/operations/speedchange_ops.py` | **CREATE** (~100 lines) |
| `app/operations/__init__.py` | **EDIT** (add import) |
| `app/static/index.html` | **EDIT** (add Speed nav-item under Utility) |
| `app/static/app.js` | **EDIT** (state + form + collector + 3 routing lines) |
| Root `AGENTS.md` | **EDIT** (ops registry table) |
