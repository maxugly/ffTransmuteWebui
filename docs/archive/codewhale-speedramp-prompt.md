# Codewhale Fleet Prompt — Speed Ramp Operation

> **Target**: ffTransmuteWebui single-clip ops
> **Fleet**: scout → manager → builder → reviewer → verifier → synthesizer
> **Spec reference**: `docs/speed-ramp-spec.md` (same directory)
> **Constraint**: deepseek-v4-pro / deepseek-reasoner only. No grok, no codex, no claude.

---

## MISSION

Implement a "speed ramp" operation for the single-clip ops tab. The user
selects a direction (spin-up or spin-down), sets a target duration and
speed curve, and the backend applies a continuous variable-speed ramp
using ffmpeg's `setpts`/`asetpts` filters.

The spec is at `docs/speed-ramp-spec.md`. Read it. This prompt is the
implementation companion — it covers every concrete detail the spec
abstracts over.

---

## PHASE 0 — SCOUT: Read Everything First

Before ANY code is written, read these files in full:

| File | Why |
|------|-----|
| `docs/speed-ramp-spec.md` | The spec. All design decisions live here. |
| `mtapi-project/app/operations/transmute_ops.py` | Pattern to follow: Pydantic params → async handler → register() |
| `mtapi-project/app/operations/__init__.py` | Import pattern for new ops modules |
| `mtapi-project/app/contract.py` | OperationSpec, OperationResult, REGISTRY |
| `mtapi-project/app/shell.py` | run_command, TRANSMUTE path pattern |
| `mtapi-project/app/static/app.js` lines 2940–3094 | Existing transmute form renderer + extras |
| `mtapi-project/app/static/app.js` lines 1–200 | State pattern, init flow |
| `mtapi-project/app/main.py` | How routes are auto-generated from REGISTRY |

The Scout reports back: confirm every file path is reachable, note any
differences between the spec's assumptions and reality, flag anything
that would block implementation. No code yet.

---

## PHASE 1 — BACKEND: `speedramp_ops.py`

### 1.1 File: `mtapi-project/app/operations/speedramp_ops.py` (NEW)

Follow the pattern from `transmute_ops.py` exactly. Same imports, same
conventions.

#### Pydantic model

```python
class SpeedRampParams(BaseModel):
    input_path: str = Field(..., description="Source video path")
    output_path: str | None = Field(None, description="Output path; auto-named if omitted")
    direction: Literal["spin_up", "spin_down"] = Field("spin_down",
        description="spin_down = 4x→⅓x (winding down), spin_up = ⅓x→4x (winding up)")
    duration: float = Field(5.0, gt=0, le=300,
        description="Target output duration in seconds")
    start_speed: float = Field(4.0, gt=0.01, le=50,
        description="Speed multiplier at start of ramp")
    end_speed: float = Field(0.333, gt=0.01, le=50,
        description="Speed multiplier at end of ramp")
    curve_shape: Literal["exponential"] = Field("exponential",
        description="Curve family. Start with exponential only; linear/power are v2.")
    loop_mode: Literal["auto", "none", "crossfade"] = Field("auto",
        description="How to handle input shorter than required T_input")
    crossfade_dur: float = Field(0.15, ge=0.05, le=1.0,
        description="Crossfade seconds when loop_mode=crossfade or auto")
    dry_run: bool = Field(False, description="Print command only")
```

**Default overrides in handler**: When direction is "spin_up", swap
start_speed and end_speed defaults if the user didn't set them
explicitly. Simplest approach: if the user passes exactly 4.0 for
start_speed and 0.333 for end_speed with direction="spin_up", swap
them to 0.333 and 4.0 respectively. Don't overthink this — just detect
the defaults-and-swap case.

#### Curve math (exponential only for v1)

Given `start_speed` (S), `end_speed` (E), `duration` (D):

```
k = ln(S / E) / D
A = S / k
T_input = A * (1 - exp(-k * D))    # total input seconds consumed
```

The `setpts` expression for spin_down:
```
setpts='A*(1-exp(-k*PTS*TB))/TB'
asetpts='A*(1-exp(-k*PTS*TB))/TB'
```

For spin_up: swap S and E before computing k and A. The expression
becomes:
```
setpts='A*(exp(k*PTS*TB)-1)/TB'
asetpts='A*(exp(k*PTS*TB)-1)/TB'
```

**IMPORTANT**: Substitute A and k as float literals into the filter
string. Use Python's f-strings or str(float_value). Do NOT try to
reference Python variables inside the ffmpeg filter expression — ffmpeg
can't see them. The expression string is pure ffmpeg arithmetic with
hardcoded numbers.

Example for spin_down with S=4.0, E=0.333, D=5.0:
```python
k = math.log(4.0 / 0.333) / 5.0    # ≈ 0.497
A = 4.0 / k                          # ≈ 8.048
expr_v = f"{A}*(1-exp({-k}*PTS*TB))/TB"
# Result: "8.048*(1-exp(-0.497*PTS*TB))/TB"
```

#### Handler logic (pseudocode)

```python
async def speed_ramp(p: SpeedRampParams) -> OperationResult:
    # 1. Swap defaults for spin_up
    S, E = p.start_speed, p.end_speed
    if p.direction == "spin_up" and S == 4.0 and E == 0.333:
        S, E = 0.333, 4.0
    elif p.direction == "spin_up":
        S, E = p.end_speed, p.start_speed  # swap user-provided values

    # 2. Probe input duration
    dur = await probe_duration(p.input_path)
    if dur <= 0:
        return OperationResult(ok=False, operation="speed_ramp",
            error="Could not determine input duration")

    # 3. Compute curve
    k = math.log(S / E) / p.duration
    A = S / k
    T_input = A * (1 - math.exp(-k * p.duration))
    loops = max(1, math.ceil(T_input / dur))

    # 4. Build ffmpeg command
    if loops > 1 and p.loop_mode in ("auto", "crossfade"):
        # Two-pass: crossfade loop → speed ramp
        return await _speed_ramp_crossfade(p, dur, loops, A, k, p.direction)
    elif loops > 1 and p.loop_mode == "none":
        # Warn: output will be shorter
        actual_dur = A * (1 - math.exp(-k * loops * dur)) if p.direction == "spin_down" else ...
        # Or just run with -stream_loop and accept seams; flag a warning
        return await _speed_ramp_direct(p, loops, A, k, p.direction, warning="Input too short; loop seams visible")
    else:
        # One loop or less — direct ramp
        return await _speed_ramp_direct(p, 1, A, k, p.direction)

    # 5. Parse and return
```

#### Direct ramp (no looping needed)

```python
async def _speed_ramp_direct(p, loops, A, k, direction, warning=None):
    output = _resolve_output_path(p)
    stream_loop = loops - 1  # -stream_loop 0 means play once

    if direction == "spin_down":
        expr_v = f"{A}*(1-exp({-k}*PTS*TB))/TB"
        expr_a = f"{A}*(1-exp({-k}*PTS*TB))/TB"
    else:
        expr_v = f"{A}*(exp({k}*PTS*TB)-1)/TB"
        expr_a = f"{A}*(exp({k}*PTS*TB)-1)/TB"

    argv = [
        "ffmpeg", "-y",
        "-stream_loop", str(stream_loop),
        "-i", p.input_path,
        "-filter:v", f"setpts='{expr_v}'",
        "-filter:a", f"asetpts='{expr_a}'",
        "-t", str(p.duration),
        "-c:v", "libx264", "-preset", "fast", "-crf", "23",
        "-c:a", "aac", "-b:a", "128k",
        output,
    ]

    if p.dry_run:
        return OperationResult(ok=True, operation="speed_ramp",
            dry_run=True, command=" ".join(argv),
            output_path=output,
            stdout=f"Command: {' '.join(argv)}\nOutput: {output}")

    code, out, err = await run_command(argv)
    ok = code == 0
    return OperationResult(
        ok=ok, operation="speed_ramp",
        output_path=output if ok else None,
        dry_run=False,
        command=" ".join(argv),
        stdout=out, stderr=err,
        error=None if ok else (err.strip() or f"ffmpeg exited {code}"),
    )
```

#### Crossfade loop ramp (two-pass)

The two-pass approach for seamless looping:

**Pass 1** — Build an N× looped intermediate with crossfade at each
boundary. Use ffmpeg's `concat` filter with `xfade` transitions.

```python
async def _speed_ramp_crossfade(p, input_dur, loops, A, k, direction):
    import tempfile, os
    xfade = p.crossfade_dur

    # Build filter_complex for crossfade looping
    # Each loop segment: trim the input, then xfade into the next
    # ...

    # Simpler approach: use concat demuxer with a file list
    # Actually, the cleanest approach for N loops with crossfade:

    # Pass 1: seamless loop intermediate
    tmp = tempfile.mktemp(suffix=".mp4", dir=os.path.dirname(p.input_path))
    loop_filter = _build_crossfade_filter(loops, input_dur, xfade, p.input_path)
    
    argv1 = [
        "ffmpeg", "-y",
        "-i", p.input_path,
        "-filter_complex", loop_filter,
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "16",
        "-c:a", "aac", "-b:a", "128k",
        tmp,
    ]
    code1, out1, err1 = await run_command(argv1)
    if code1 != 0:
        return OperationResult(ok=False, operation="speed_ramp",
            error=f"Crossfade loop pass failed: {err1.strip() or 'exit ' + str(code1)}")

    # Pass 2: speed ramp on the looped intermediate
    result = await _speed_ramp_direct(
        replace(p, input_path=tmp), 1, A, k, direction)
    
    # Cleanup intermediate
    try: os.unlink(tmp)
    except OSError: pass
    
    return result
```

**Crossfade filter for N loops**:

```python
def _build_crossfade_filter(N, input_dur, xfade, input_path):
    """
    Build ffmpeg filter_complex for looping input N times with xfade at boundaries.

    For N=3 loops, the filter graph chains 3 copies of the input with
    2 crossfade transitions between them.
    """
    # offset for each xfade: the end of the previous segment minus xfade overlap
    parts = []
    for i in range(N):
        parts.append(f"[0:v]trim=0:{input_dur},setpts=PTS-STARTPTS[v{i}]")
        parts.append(f"[0:a]atrim=0:{input_dur},asetpts=PTS-STARTPTS[a{i}]")

    # Chain xfades: [v0][v1]xfade=dur→[x0], [x0][v2]xfade=dur→[x1], ...
    xfade_chains_v = []
    xfade_chains_a = []
    current_v = "[v0]"
    current_a = "[a0]"
    for i in range(1, N):
        next_v = f"[xfv{i}]"
        next_a = f"[xfa{i}]"
        offset = i * input_dur - i * xfade
        xfade_chains_v.append(f"{current_v}[v{i}]xfade=transition=fade:duration={xfade}:offset={offset}{next_v}")
        xfade_chains_a.append(f"{current_a}[a{i}]acrossfade=d={xfade}{next_a}")
        current_v = next_v
        current_a = next_a

    filter_parts = parts + xfade_chains_v + xfade_chains_a
    return ";".join(filter_parts)
```

**SIMPLIFICATION NOTE**: The crossfade filter is the most complex part.
For a true "cleanroom" implementation, consider shipping the direct
`-stream_loop` approach first (with a warning about visible seams),
then adding crossfade in a follow-up PR. The direct approach is 20 lines;
the crossfade approach is 80 lines and has more edge cases. The spec
recommends exponential-only for v1; the same logic applies here — ship
the simple path first, iterate.

#### ffprobe helper

Add to `speedramp_ops.py` (don't modify `shell.py` unless the Manager
decides it's cleaner):

```python
async def probe_duration(path: str) -> float:
    argv = ["ffprobe", "-v", "error", "-show_entries",
            "format=duration", "-of", "csv=p=0", path]
    code, out, _ = await run_command(argv)
    try:
        return float(out.strip()) if code == 0 else 0.0
    except ValueError:
        return 0.0
```

#### Registration

At the bottom of the file:

```python
register(OperationSpec(
    id="speed_ramp",
    summary="Speed ramp (spin-up / spin-down) with exponential curve",
    description=(
        "Applies a continuous variable-speed ramp to a single clip. "
        "Speed changes exponentially from start_speed to end_speed over "
        "the target duration. Spin-down = record winding down (4x→⅓x). "
        "Spin-up = record winding up (⅓x→4x). Audio pitch follows the speed curve."
    ),
    params_model=SpeedRampParams,
    handler=speed_ramp,
    tags=["transmute", "speed"],
))
```

#### Output path resolution

Follow the same pattern as `_run_transmute` in `transmute_ops.py`:
- Ensure `.mp4` extension via `_ensure_video_output_path`
- Use `unique_output_path` to avoid clobbering
- Auto-name as `<input_name>_ramp-<direction>_<dur>s.mp4` if output_path is None

### 1.2 File: `mtapi-project/app/operations/__init__.py` (EDIT)

Add one line:
```python
    speedramp_ops,
```

Inside the existing `from . import (...)` block. Follow alphabetical
order or put it after `transmute_ops`.

---

## PHASE 2 — FRONTEND: app.js

### 2.1 Add to `transmuteOpsDetails` (line ~2942)

```javascript
speed_ramp: { summary: "Speed ramp (spin-up / spin-down)", fields: ['speed_ramp'] },
```

The field name `'speed_ramp'` is a sentinel — it triggers the full
speed ramp extras panel rather than individual knobs.

### 2.2 Extras rendering

In `updateTransmuteExtras()` (line ~3023), add a branch:

```javascript
if (fields.includes('speed_ramp')) {
  html += `
    <div class="dream-section-title">Speed Ramp</div>

    <div class="knob-bank">
      ${knobUnitHtml({ id: 'rampDirection', label: 'Direction', value: 'spin_down', binary: true, leftCap: 'Spin Up', rightCap: 'Spin Down' })}
    </div>

    <div class="knob-bank">
      ${knobUnitHtml({ id: 'rampDuration', label: 'Duration (s)', value: '5.0' })}
      ${knobUnitHtml({ id: 'rampStartSpeed', label: 'Start ×', value: '4.0' })}
      ${knobUnitHtml({ id: 'rampEndSpeed', label: 'End ×', value: '0.33' })}
    </div>

    <div class="form-group">
      <label>Curve Shape</label>
      <select id="rampCurveShape">
        <option value="exponential">Exponential</option>
      </select>
    </div>

    <div class="form-group">
      <label>Loop Mode</label>
      <select id="rampLoopMode">
        <option value="auto">Auto (crossfade if needed)</option>
        <option value="none">None (clip short if needed)</option>
        <option value="crossfade">Crossfade (always)</option>
      </select>
    </div>

    <p class="dream-hint" id="rampInfoLine" style="margin-top: 8px;">
      Input: — → Needs — (— loops)
    </p>
  `;
}
```

Then wire up the knobs:

```javascript
// Inside updateTransmuteExtras, after the html injection:

if (fields.includes('speed_ramp')) {
  setupBinaryKnob({
    knobId: 'rampDirectionKnob', indicatorId: 'rampDirectionKnobInd',
    hiddenId: 'rampDirection',
    leftValue: 'spin_up', rightValue: 'spin_down', initial: 'spin_down',
  });
  setupContinuousKnob({
    knobId: 'rampDurationKnob', indicatorId: 'rampDurationKnobInd',
    valueId: 'rampDurationVal', hiddenId: 'rampDuration',
    min: 0.5, max: 60, step: 0.1, decimals: 1,
  });
  setupContinuousKnob({
    knobId: 'rampStartSpeedKnob', indicatorId: 'rampStartSpeedKnobInd',
    valueId: 'rampStartSpeedVal', hiddenId: 'rampStartSpeed',
    min: 0.1, max: 20, step: 0.05, decimals: 2,
  });
  setupContinuousKnob({
    knobId: 'rampEndSpeedKnob', indicatorId: 'rampEndSpeedKnobInd',
    valueId: 'rampEndSpeedVal', hiddenId: 'rampEndSpeed',
    min: 0.1, max: 20, step: 0.05, decimals: 2,
  });

  // Swap defaults when direction toggles
  document.getElementById('rampDirection').addEventListener('change', () => {
    const dir = document.getElementById('rampDirection').value;
    const startEl = document.getElementById('rampStartSpeed');
    const endEl = document.getElementById('rampEndSpeed');
    if (dir === 'spin_down') {
      startEl.value = '4.0'; endEl.value = '0.33';
    } else {
      startEl.value = '0.33'; endEl.value = '4.0';
    }
    updateRampInfoLine();
  });
}
```

### 2.3 Info line computation

```javascript
function updateRampInfoLine() {
  const line = document.getElementById('rampInfoLine');
  if (!line) return;
  const dur = parseFloat(document.getElementById('rampDuration')?.value) || 5;
  const S = parseFloat(document.getElementById('rampStartSpeed')?.value) || 4;
  const E = parseFloat(document.getElementById('rampEndSpeed')?.value) || 0.33;
  const k = Math.log(S / E) / dur;
  const A = S / k;
  const T_input = A * (1 - Math.exp(-k * dur));
  const inputDur = 2.0; // placeholder — real value comes from API after file selection
  const loops = Math.ceil(T_input / inputDur);
  line.textContent = `Input: ${inputDur.toFixed(2)}s → Needs ${T_input.toFixed(2)}s (${loops} loop${loops !== 1 ? 's' : ''})`;
}
```

### 2.4 Run handler

Find where `runActiveOperation` dispatches per-tab (search for
`activeTransmuteOp` in app.js). Add a case for `speed_ramp`:

```javascript
if (activeTransmuteOp === 'speed_ramp') {
  return runSpeedRamp();
}
```

```javascript
async function runSpeedRamp() {
  const input = document.getElementById('transmuteInput')?.value?.trim();
  const output = document.getElementById('transmuteOutput')?.value?.trim() || null;
  const direction = document.getElementById('rampDirection')?.value || 'spin_down';
  const duration = parseFloat(document.getElementById('rampDuration')?.value) || 5.0;
  const startSpeed = parseFloat(document.getElementById('rampStartSpeed')?.value) || 4.0;
  const endSpeed = parseFloat(document.getElementById('rampEndSpeed')?.value) || 0.333;
  const curveShape = document.getElementById('rampCurveShape')?.value || 'exponential';
  const loopMode = document.getElementById('rampLoopMode')?.value || 'auto';
  const dryRun = document.getElementById('transmuteDryRun')?.value === '1';

  if (!input) {
    logConsole('[ERROR]: Input file is required.');
    return;
  }

  const payload = {
    input_path: input,
    output_path: output,
    direction,
    duration,
    start_speed: startSpeed,
    end_speed: endSpeed,
    curve_shape: curveShape,
    loop_mode: loopMode,
    dry_run: dryRun,
  };

  await executeOp('speed_ramp', payload);
}
```

---

## PHASE 3 — REVIEW: Sanity Checks

The Reviewer should verify:

1. **Import chain works**: `__init__.py` imports `speedramp_ops` →
   `register()` populates `REGISTRY` → `main.py` auto-creates
   `POST /ops/speed_ramp`.

2. **Math is correct**: For S=4.0, E=0.333, D=5.0:
   - k ≈ 0.497
   - A ≈ 8.048
   - T_input ≈ 7.38s
   - For a 2-second clip: loops = 4

3. **setpts expression is well-formed**: No Python variables leak into
   the ffmpeg filter string. All float formatting uses enough precision
   (6+ decimal places) to avoid drift.

4. **Audio path works**: `asetpts` uses the same expression as `setpts`.
   The audio timebase (1/SR) is handled correctly by ffmpeg.

5. **Dry run doesn't create files**: When `dry_run=True`, the handler
   returns `ok=True` with the command string but does NOT execute it.

6. **Error handling**: Missing input file, invalid ffprobe output,
   ffmpeg crash — all return `ok=False` with a human-readable error.

7. **No regression**: All existing transmute operations still work.
   Run `curl http://localhost:24590/ops | jq '.speed_ramp'` to verify
   the new endpoint is registered.

---

## PHASE 4 — VERIFY: End-to-End Test

After implementation, use the same test clip that started this:

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
    "loop_mode": "none",
    "dry_run": false
  }' | jq .
```

Checks:
- `ok` is `true`
- `output_path` points to a real .mp4 file
- `ffprobe output_path` shows duration ~5s
- Video is h264, audio is aac
- Playing the file: starts fast, ends slow, audio pitch follows

---

## PITFALLS (from the prototype — do not repeat)

1. **`-stream_loop` creates visible seams.** When loops > 1, the
   crossfade mode is strongly preferred. The direct mode with
   `-stream_loop` is a fallback with a warning.

2. **Frame drops are expected.** At 4× speed, ffmpeg will drop ~75%
   of frames. This is correct behavior — the output frame rate stays
   at 96fps, it just can't show 4 seconds of source in 1 second of
   output without dropping frames.

3. **Output duration is approximate.** `-t N` truncates at the nearest
   frame boundary. A 5.0s target might produce 4.92s or 5.04s output.
   This is fine — don't try to force exact frame alignment.

4. **Audio pitch shift IS desired.** `asetpts` changes pitch with
   speed. For spin-down, pitch drops — this is the "record winding down"
   effect the user wants. Do NOT use `rubberband` or `atempo`.

5. **Float precision in setpts.** Use `str(float_value)` in Python
   to format numbers for the ffmpeg expression. Python's default float
   formatting includes enough digits. Do NOT use f-string with
   `:.2f` or any truncation — the exponential is sensitive to k.

6. **`from __future__ import annotations`** — it's fine in
   `speedramp_ops.py` (operations modules use it), but do NOT add it
   to `main.py` (breaks FastAPI route generation).

---

## FILES TOUCHED (checklist for the fleet)

- [ ] `mtapi-project/app/operations/speedramp_ops.py` — **CREATE**
- [ ] `mtapi-project/app/operations/__init__.py` — **EDIT** (add import)
- [ ] `mtapi-project/app/static/app.js` — **EDIT** (4 changes: ops list, extras, info line, run handler)

That's it. Three files. No changes to `contract.py`, `shell.py`,
`main.py`, `index.html`, or the `transmute` bash script.

---

## HANDOFF

The Synthesizer should produce:
1. A summary of what was built (files, lines changed)
2. Any decisions that deviated from this prompt (and why)
3. The exact `curl` command to test the endpoint
4. Any unresolved issues or follow-up tasks

The final handoff should be a single markdown block ready to paste
into the user's terminal or commit message.
