# Speed Ramp Spec — Spin Up / Spin Down

> **Status**: spec (no code)
> **Target**: Single-Clip Ops tab in ffTransmuteWebui
> **Date**: 2026-07-25

---

## 1. Problem

User wants to take one clip and apply a continuous speed ramp — like a
record spinning up from silence or winding down to a stop. The ramp is
exponential: speed changes continuously from a start multiplier to an
end multiplier over a target output duration.

**Example**: a 2-second clip stretched to 5 seconds, starting at 4× speed
and decelerating to ⅓× speed, like a turntable with the plug pulled.

This doesn't exist in the current toolset. The `transmute -T` flag does
*per-clip fixed* time stretch (setpts+rubberband at a constant rate), but
there's no variable-speed ramp anywhere in the current UI or CLI.

What we tried: a hand-rolled ffmpeg one-liner with `-stream_loop` and
`setpts='0.4545*(exp(0.550*PTS*TB)-1)/TB'`. It *mostly* worked but had
two problems:

1. **Visible loop seams** — ffmpeg's `-stream_loop` concatenates raw
   copies. At 4× speed you fly through 3 loops and see the jump cuts.
2. **Wrong pacing feel** — the exponential spent too long near 4× and
   the slowdown only kicked in at the very end. Result: 4 seconds of
   chipmunk, then a half-second wheeze.

The spec below addresses both.

---

## 2. Where It Goes

### UI: Single-Clip Ops dropdown

The existing `transmuteOpsDetails` dict in `app.js` gets a new entry:

```
speed_ramp: { summary: "Speed ramp (spin-up / spin-down)", fields: [...] }
```

It lives alongside `first_frame`, `reverse`, `crop_16x9`, etc. in the
"Single-Clip Transmutations" tab. Same input-file → output-file pattern,
same dry-run knob, same Run button.

### Backend: new operation

Speed ramp is **pure ffmpeg** — it doesn't go through the `transmute`
bash script at all. Either:

- **Option A (preferred)**: new file `speedramp_ops.py` in
  `mtapi-project/app/operations/`, registered in
  `operations/__init__.py`, calling `ffmpeg` directly via
  `shell.run_command`.
- **Option B**: add a `-R` flag to the `transmute` bash script. More
  work, ties speed-ramp to the transmute CLI forever. Skip this.

Go with Option A. It follows the same contract (`OperationSpec` →
Pydantic params → `OperationResult`) as every other op.

---

## 3. Parameters

### 3.1 Core

| Param         | Type    | Default | Description |
|---------------|---------|---------|-------------|
| `input_path`  | `str`   | *required* | Source video |
| `output_path` | `str?`  | `None`  | Auto-named next to input if omitted |
| `direction`   | `enum`  | `"spin_down"` | `"spin_up"` or `"spin_down"` |
| `duration`    | `float` | `5.0`   | Target output duration in seconds |
| `start_speed` | `float` | `4.0` (down) / `0.25` (up) | Speed multiplier at t=0 |
| `end_speed`   | `float` | `0.333` (down) / `4.0` (up) | Speed multiplier at t=duration |
| `curve_shape` | `enum`  | `"exponential"` | `"linear"`, `"exponential"`, `"logarithmic"`, `"power"` |
| `curve_power` | `float` | `2.0`   | Exponent when `curve_shape` is `"power"` (1.0 = linear) |
| `loop_mode`   | `enum`  | `"auto"` | `"auto"`, `"none"`, `"crossfade"` |
| `crossfade_dur`| `float`| `0.15`  | Seconds of overlap when `loop_mode="crossfade"` |
| `dry_run`     | `bool`  | `false` | Print command, don't execute |

### 3.2 Derived / computed

| Value | Formula |
|-------|---------|
| `k` (decay rate) | `ln(start_speed / end_speed) / T_input` |
| `A` (scale factor) | `start_speed / k` |
| `T_input` needed | `duration × (start_speed - end_speed) / ln(start_speed / end_speed)` |
| Loops required | `ceil(T_input / input_duration)` |

Where `T_input` is how much source footage the ramp consumes, and
`input_duration` comes from `ffprobe`.

### 3.3 Speed semantics

- `start_speed = 4.0` means "4× normal speed" at the beginning.
  For spin_down: starts fast, ends slow.
  For spin_up: starts slow, ends fast.
- `end_speed = 0.333` means "⅓× normal speed" at the end.
- Values > 1 = chipmunk. Values < 1 = slo-mo.
- `start_speed` and `end_speed` swap defaults when direction flips.

---

## 4. Curve Math

### 4.1 Mapping input time → output time

The speed curve defines `v(t_out) = d(t_in) / d(t_out)` — the
instantaneous speed multiplier at output time `t_out`.

For **exponential**: `v(t) = start_speed × exp(−k × t)`
  where `k = ln(start_speed / end_speed) / duration`.

For **spin_up**: same formula but `start_speed` and `end_speed` swapped.

Input time as a function of output time (what `setpts` needs):

```
T_in = A × (exp(k × T_out) − 1)           # spin_up (accelerating)
T_in = A × (1 − exp(−k × T_out))          # spin_down (decelerating)
```

where:
```
k = ln(start_speed / end_speed) / duration
A = start_speed / k
```

These are chosen so that:
- `d(T_in)/d(T_out)` at `t=0` equals `start_speed` ✓
- `d(T_in)/d(T_out)` at `t=duration` equals `end_speed` ✓
- `T_in(duration)` equals the total input consumed ✓

### 4.2 Other curve shapes

| Shape          | Speed function `v(t)` | Notes |
|----------------|-----------------------|-------|
| **linear**     | `start + (end − start) × t / D` | Constant acceleration. Simplest, least natural. |
| **exponential**| `start × (end/start)^(t/D)` | Natural for physical deceleration. Default. |
| **logarithmic**| TBD | Inverse of exponential — sharp change early, flattens. |
| **power**      | `start + (end − start) × (t/D)^p` | `p > 1`: late ramp. `p < 1`: early ramp. |

For **power** curves: `p` is the `curve_power` parameter.
- `p = 1.0` = linear
- `p = 2.0` = quadratic (stays fast longer, slams into slow at the end)
- `p = 0.5` = square root (drops speed fast, then levels off)

### 4.3 ffmpeg expression

For exponential spin_down:
```
setpts='A*(1-exp(-k*PTS*TB))/TB'
asetpts='A*(1-exp(-k*PTS*TB))/TB'
```

Where `A` and `k` are computed as above and substituted as float
literals into the filter string. `PTS*TB` gives input time in seconds;
dividing the result by `TB` converts back to PTS units.

For audio: same expression works — the pitch drops with speed, which
is *exactly* the record-spin-down effect we want.

---

## 5. Input Handling & Looping

### 5.1 The problem

If the ramp needs more source footage than the clip contains (e.g., a
2-second clip stretched to 5 seconds with an exponential 4×→⅓× curve
needs ~4.5 seconds of input), we must loop the input.

Naive `-stream_loop` in ffmpeg creates visible seams — the clip jumps
from the last frame back to the first. At 4× speed you see this happen
several times.

### 5.2 `loop_mode` options

| Mode        | Behavior |
|-------------|----------|
| `"auto"`    | Compute loops needed. If ≤ 1 loop: no looping. If > 1: use crossfade. |
| `"none"`    | Never loop. If input is too short, output will be shorter than `duration`. Warn in the result. |
| `"crossfade"`| Pre-generate a seamless-looped version via ffmpeg concat filter with short crossfade at each seam, THEN apply the speed ramp to the looped intermediate. |

### 5.3 Crossfade loop implementation

Two-pass approach:

**Pass 1 — build seamless loop:**
```bash
ffmpeg -i input.mp4 \
  -filter_complex "[0:v]split[va][vb];[va]trim=end=0.15,setpts=PTS-STARTPTS[head];[vb][head]concat=n=2:v=1[looped]" \
  ...repeat...
```

Actually, the cleanest approach for N loops with crossfade:

```bash
# Build an N×-looped intermediate with crossfade at each boundary
ffmpeg -stream_loop N-1 -i input.mp4 \
  -filter_complex "[0:v][0:v]xfade=transition=fade:duration=0.15:offset=$(bc <<< "dur-0.15")" \
  ...repeat per seam...
  -c:v libx264 -preset ultrafast -crf 18 looped_intermediate.mp4
```

Then **Pass 2** — apply the speed ramp to the intermediate:
```bash
ffmpeg -i looped_intermediate.mp4 \
  -filter:v "setpts='A*(1-exp(-k*PTS*TB))/TB'" \
  -filter:a "asetpts='A*(1-exp(-k*PTS*TB))/TB'" \
  -t $duration output.mp4
```

Trade-offs:
- Crossfade hides the seam but adds ~0.15s of blended frames per loop
  boundary. At 4× speed you won't notice. At ⅓× speed you might see a
  brief ghost. Acceptable.
- Two-pass encoding means a quality hit on the intermediate. Use
  `-preset ultrafast -crf 16` on pass 1 to minimize generation loss.
- The intermediate file is temporary; clean it up after pass 2.

### 5.4 Edge case: input shorter than crossfade duration

If input is < 0.3 seconds, crossfade is impossible (need at least 2×
the crossfade duration). Fall back to `"none"` mode with a warning.

---

## 6. UI Controls

### 6.1 Layout in the transmute form

Below the operation dropdown and input/output fields, in the
`#transmuteExtras` div:

```
┌─────────────────────────────────────────────┐
│ Speed Ramp                                   │
│                                               │
│  Direction:  [◀ Spin Up] [● Spin Down ▶]     │
│                                               │
│  ┌─────────┐  ┌─────────┐  ┌──────────┐     │
│  │ Duration │  │ Start × │  │  End ×   │     │
│  │   5.0s   │  │   4.00  │  │   0.33   │     │
│  └─────────┘  └─────────┘  └──────────┘     │
│                                               │
│  Curve: [exponential ▾]                      │
│                                               │
│  ┌─────────┐  ┌──────────┐                   │
│  │  Power  │  │ Loop     │                   │
│  │   2.0   │  │  auto ▾  │  (only if power) │
│  └─────────┘  └──────────┘                   │
│                                               │
│  ┌──────────────────────────────────────┐    │
│  │   ████░░░░░░░░░░░░░░░░░░░░░░░░░░░░  │    │
│  │   4×                         → ⅓×    │    │
│  │   speed curve preview (tiny sparkline) │    │
│  └──────────────────────────────────────┘    │
│                                               │
│  Input: 2.01s  →  Needs 4.52s (3 loops)     │
│  ── info line, computed live ──────────────  │
└─────────────────────────────────────────────┘
```

### 6.2 Controls detail

| Control | Widget | Range | Default |
|---------|--------|-------|---------|
| Direction | Binary toggle knob (spin_up / spin_down) | — | spin_down |
| Duration | Continuous knob | 0.5 – 60s, step 0.1 | 5.0 |
| Start speed | Continuous knob | 0.1 – 20×, step 0.05 | 4.00 (down) |
| End speed | Continuous knob | 0.1 – 20×, step 0.05 | 0.33 (down) |
| Curve shape | Select dropdown | linear, exponential, logarithmic, power | exponential |
| Curve power | Continuous knob (shown only when shape=power) | 0.25 – 4.0, step 0.05 | 2.0 |
| Loop mode | Select dropdown | auto, none, crossfade | auto |
| Dry run | Binary toggle knob | Run / Dry | Run |

### 6.3 Info / feedback line

Below the knobs, a computed line (updated on any parameter change):

> Input: 2.01s → Needs 4.52s of source (3 loops with 0.15s crossfade)

This tells the user immediately whether looping will happen and how
many loops. If `loop_mode=none` and input is too short:

> ⚠ Input too short. Output will be ~3.1s instead of 5.0s.

### 6.4 Mini sparkline

A tiny ASCII or canvas sparkline showing the speed curve shape. Not
interactive — just a visual confirmation. Can be a simple `█░░` bar
that updates as knobs move.

---

## 7. Backend Implementation Notes

### 7.1 New module: `speedramp_ops.py`

Follows the same pattern as `transmute_ops.py`:

```python
class SpeedRampParams(BaseModel):
    input_path: str
    output_path: str | None
    direction: Literal["spin_up", "spin_down"]
    duration: float = Field(5.0, gt=0, le=300)
    start_speed: float = Field(..., gt=0, le=50)
    end_speed: float = Field(..., gt=0, le=50)
    curve_shape: Literal["linear", "exponential", "logarithmic", "power"]
    curve_power: float = Field(2.0, gt=0, le=10)
    loop_mode: Literal["auto", "none", "crossfade"]
    crossfade_dur: float = Field(0.15, ge=0.05, le=1.0)
    dry_run: bool = False

async def speed_ramp(p: SpeedRampParams) -> OperationResult:
    # 1. ffprobe input for duration
    # 2. compute curve parameters (k, A, T_input, loops)
    # 3. decide loop strategy
    # 4. build ffmpeg argv (with or without intermediate loop)
    # 5. run_command
    # 6. parse result, return OperationResult
```

### 7.2 ffprobe helper

Need a small helper to get video duration. Could add to `shell.py`:

```python
async def probe_duration(path: str) -> float:
    argv = ["ffprobe", "-v", "error", "-show_entries",
            "format=duration", "-of", "csv=p=0", path]
    code, out, _ = await run_command(argv)
    return float(out.strip()) if code == 0 else 0.0
```

### 7.3 Curve computation

Pure Python math, no ffmpeg involvement:

```python
import math

def compute_curve_params(
    start_speed: float,
    end_speed: float,
    duration: float,
    curve_shape: str,
    curve_power: float,
) -> dict:
    """Return k, A, T_input, and the setpts expression."""
    if curve_shape == "exponential":
        k = math.log(start_speed / end_speed) / duration
        A = start_speed / k
        expr_v = f"{A}*(1-exp({-k}*PTS*TB))/TB"
        expr_a = f"{A}*(1-exp({-k}*PTS*TB))/TB"
        T_input = A * (1 - math.exp(-k * duration))
    elif curve_shape == "linear":
        # v(t) = start + (end-start)*t/D
        # T_in = start*t + (end-start)*t²/(2D)
        T_input = start_speed * duration + 0.5 * (end_speed - start_speed) * duration
        # setpts for linear: T_in(t) = start*t + (end-start)*t²/(2*D)
        expr_v = f"({start_speed}*PTS*TB + ({end_speed - start_speed})*PTS*TB*PTS*TB/(2*{duration}))/TB"
        expr_a = expr_v
    elif curve_shape == "power":
        # v(t) = start + (end-start)*(t/D)^p
        # T_in = start*t + (end-start)*t^(p+1)/(D^p*(p+1))
        p = curve_power
        T_input = (start_speed * duration +
                   (end_speed - start_speed) * duration / (p + 1))
        # Too complex to inline — compute numerically or use integral
        ...
    # ...
    return {"k": k, "A": A, "T_input": T_input,
            "expr_v": expr_v, "expr_a": expr_a}

def loops_needed(T_input: float, clip_duration: float) -> int:
    if clip_duration <= 0:
        return 1
    return max(1, math.ceil(T_input / clip_duration))
```

### 7.4 The exponential case is the MVP

Ship exponential first. It covers 90% of real use (spin-up, spin-down).
Add linear/power curves in a follow-up — they're nice-to-have but the
math gets messier for `setpts` expressions.

---

## 8. Pitfalls & Lessons from the Prototype

### 8.1 Don't use `-stream_loop` raw

The prototype used `-stream_loop 2` which creates visible jump cuts at
loop boundaries. Always use crossfade looping (two-pass) when more than
1 loop is needed.

### 8.2 Frame drops at high speed

At 4× speed, ffmpeg drops frames because the output frame rate can't
keep up. The prototype dropped 108 out of 579 input frames. This is
*expected* and acceptable — you can't show 4 seconds of source in 1
second of output without dropping 75% of frames. The dropped frames are
distributed evenly, so the motion stays smooth.

### 8.3 Output duration rounding

`-t 5` in ffmpeg truncates at the nearest frame boundary, so actual
output might be 4.92s instead of 5.00s. This is fine — call it 5s.

### 8.4 Audio pitch shift

`asetpts` with the same curve as `setpts` produces pitch-shifted
audio. For spin_down, the pitch drops with speed — this is *desired*
for the "record winding down" effect. For spin_up, pitch rises — also
desired.

If pitch-preserving speed ramp is wanted later, use `rubberband`
filter for audio instead of `asetpts`. But that's a different mode
("tempo ramp" vs "speed ramp"). Keep it simple: speed ramp = pitch
changes. Add tempo ramp as a separate mode later if needed.

### 8.5 Start/end speed validation

Enforce `start_speed != end_speed` (no-op ramp). Enforce both > 0
(no negative or zero speed). Warn if either is > 20× (quality
degrades fast at extreme speeds).

---

## 9. Verification

After implementation, verify with the same clip that started this:

```bash
curl -s -X POST http://localhost:24590/ops/speed_ramp \
  -H "Content-Type: application/json" \
  -d '{
    "input_path": "/home/m/snc/img/gen/otherworld/ZGE6E285C90395BKHNVEHFY8X0.mp4",
    "direction": "spin_down",
    "duration": 5.0,
    "start_speed": 4.0,
    "end_speed": 0.333,
    "curve_shape": "exponential",
    "loop_mode": "auto",
    "dry_run": false
  }' | jq .
```

Checks:
- [ ] Output exists and is ~5 seconds
- [ ] No visible loop seams (crossfade worked)
- [ ] Starts fast (first ~0.5s covers ~2s of source)
- [ ] Ends slow (last ~1.5s crawls through ~0.5s of source)
- [ ] Audio pitch follows the speed curve
- [ ] `ok: true`, `output_path` points to a real file

---

## 10. Future Ideas (out of scope for v1)

- **Speed keyframes**: drag points on a timeline to set custom
  speed at specific moments. Bigger feature, needs a graph editor.
- **Pitch-preserving mode**: use `rubberband` instead of `asetpts`
  so tempo changes but pitch stays the same.
- **Reverse ramp**: `spin_down` then `spin_up` in one pass.
- **Bounce**: oscillating speed curve (tremolo effect).
- **Audio-only ramp**: apply speed curve to audio, keep video normal.

---

## 11. Files to Touch

| File | Change |
|------|--------|
| `mtapi-project/app/operations/speedramp_ops.py` | **New** — params model, handler, register() |
| `mtapi-project/app/operations/__init__.py` | Add `from . import speedramp_ops` |
| `mtapi-project/app/static/app.js` | Add `speed_ramp` to `transmuteOpsDetails`; add extras rendering for the curve knobs; add `runSpeedRamp()` handler |
| `mtapi-project/app/shell.py` | Add `probe_duration()` helper (optional — could inline in speedramp_ops) |

No changes to the `transmute` bash script. No changes to `index.html`
(single-clip ops tab is already there). No changes to `contract.py`.

---

## 12. Why Not Just Use the `transmute` Bash Script

- The `transmute` script wraps ffmpeg for discrete operations (crop,
  pad, reverse, join). Speed ramp needs math that's awkward in bash
  (floating-point exponentiation, conditional looping logic).
- Computing the curve parameters in Python then substituting them into
  a pre-built ffmpeg command string is cleaner and testable.
- The `transmute` script's stdout contract (`Output:`, `Command:`) is
  easy to replicate from the Python handler — just `print()` the
  ffmpeg command as `Command:` and the output path as `Output:`.
- If speed ramp ever needs to go into the standalone CLI, that's a
  separate `./speedramp.sh` script, not a flag on `transmute`.
