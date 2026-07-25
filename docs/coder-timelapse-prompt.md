# Coder Prompt — Time-Lapse / Frame Sampling (`timelapse`)

> **Target**: ffTransmuteWebui — new standalone operation + new WebUI tab
> **Spec reference**: `docs/timelapse-spec.md` (same directory)

---

## MISSION

Implement a "Time-Lapse / Frame Sampling" operation with two modes:
- **Time-Lapse**: compress a long video into a short fast-forward (60s → 6s at 10× speed)
- **Stop-Motion**: keep the original duration but reduce frame rate (30fps → 1fps choppy slideshow)

Both modes are a single `ffmpeg` invocation. No external tools, no frame dumps, no temp dirs.

The spec is at `docs/timelapse-spec.md`. Read it first.

---

## PHASE 0 — SCOUT: Read Everything First

Before ANY code is written, read these files in full:

| File | Why |
|------|-----|
| `docs/timelapse-spec.md` | The spec. All design decisions live here. |
| `mtapi-project/app/operations/rife_ops.py` | **Primary pattern to follow**: simplest ops module. |
| `mtapi-project/app/operations/codecview_ops.py` | If already implemented — another single-command filter op for reference. |
| `mtapi-project/app/operations/__init__.py` | Import pattern. |
| `mtapi-project/app/contract.py` | `OperationSpec`, `OperationResult`, `REGISTRY`. |
| `mtapi-project/app/shell.py` | `run_command()`, `probe_duration()`. |
| `mtapi-project/app/pathutil.py` | `finalize_output_path()`. |
| `mtapi-project/app/static/app.js` lines 1010–1095 | `renderRifeForm()` — UI pattern to follow. |
| `mtapi-project/app/static/app.js` lines 320–348 | `renderTabForm()` — routing. |
| `mtapi-project/app/static/app.js` lines 6913–7110 | `runActiveOperation()` — dispatch. |

Report back: confirm every file path is reachable, flag anything that would block implementation.

---

## PHASE 1 — BACKEND: `timelapse_ops.py`

### 1.1 File: `mtapi-project/app/operations/timelapse_ops.py` (NEW)

#### Pydantic model

```python
TimelapseMode = Literal["timelapse", "stopmotion"]
AudioMode = Literal["drop", "keep", "speed"]


class TimelapseParams(BaseModel):
    input_path: str = Field(..., description="Source video path")
    output_path: str | None = Field(None, description="Output path; auto-named if omitted")
    mode: TimelapseMode = Field("timelapse",
        description="'timelapse' = speedup (shorter output), 'stopmotion' = reduce fps (same duration)")
    speed_factor: float = Field(10.0, ge=1.5, le=1000,
        description="Speed multiplier for timelapse mode (10 = 10x faster). Ignored in stopmotion.")
    target_fps: float = Field(1.0, ge=0.1, le=30,
        description="Target frame rate for stopmotion mode. Ignored in timelapse.")
    audio: AudioMode = Field("drop",
        description="'drop' = strip audio, 'keep' = preserve (stopmotion only), "
                    "'speed' = pitch-shift audio to match speed (timelapse only)")
    dry_run: bool = Field(False, description="Print command only")
```

#### Helper: atempo chain builder

```python
def _build_atempo_chain(speed: float) -> str:
    """Build chained atempo filters for arbitrary speedup factors."""
    parts: list[str] = []
    remaining = speed
    while remaining > 100.0:
        parts.append("atempo=100.0")
        remaining /= 100.0
    if abs(remaining - 1.0) > 0.001:
        parts.append(f"atempo={remaining}")
    return ",".join(parts) if parts else "atempo=1.0"
```

#### Helper: probe input fps

```python
async def _probe_fps(path: str) -> float:
    """Probe the video frame rate, returning fps as a float (0.0 on failure)."""
    code, out, _ = await run_command([
        "ffprobe", "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=r_frame_rate",
        "-of", "csv=p=0", path,
    ])
    try:
        num_s, den_s = out.strip().split("/")
        return float(num_s) / float(den_s)
    except (ValueError, ZeroDivisionError):
        return 0.0
```

#### Handler logic

```python
VIDEO_EXTS = {".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi"}


async def timelapse(p: TimelapseParams) -> OperationResult:
    input_path = Path(p.input_path).expanduser().resolve()
    if not input_path.is_file():
        return OperationResult(
            ok=False, operation="timelapse",
            error=f"Input not found: {input_path}", dry_run=p.dry_run,
        )

    # Probe input fps (needed for timelapse mode output -r flag)
    input_fps = await _probe_fps(str(input_path))
    if input_fps <= 0:
        input_fps = 30.0  # safe fallback

    # Resolve output path
    suffix = "_timelapse" if p.mode == "timelapse" else "_stopmotion"
    out = finalize_output_path(
        p.output_path,
        source=input_path,
        default_suffix=suffix,
        default_ext=".mp4",
        allowed_exts=VIDEO_EXTS,
    )

    if p.mode == "timelapse":
        # ── Time-Lapse: setpts=PTS/N, drop or speed audio ──
        vf = f"setpts=PTS/{p.speed_factor}"
        argv = [
            "ffmpeg",
            "-i", str(input_path),
            "-vf", vf,
            "-r", str(input_fps),
            "-c:v", "libx264", "-preset", "fast", "-crf", "18",
            "-pix_fmt", "yuv420p",
        ]
        if p.audio == "speed":
            atempo = _build_atempo_chain(p.speed_factor)
            argv.extend(["-af", atempo, "-c:a", "aac", "-b:a", "128k"])
        else:
            argv.append("-an")
        argv.extend(["-y", str(out)])

        summary = f"timelapse {input_path.name} {p.speed_factor}x"
        if p.audio == "speed":
            summary += " +audio"

    else:
        # ── Stop-Motion: fps=N, keep or drop audio ──
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

        summary = f"stopmotion {input_path.name} {p.target_fps}fps"
        if p.audio != "drop":
            summary += " +audio"

    if p.dry_run:
        return OperationResult(
            ok=True, operation="timelapse", output_path=str(out),
            dry_run=True, command=summary,
            stdout=" ".join(argv),
        )

    code, stdout, stderr = await run_command(argv)
    return OperationResult(
        ok=(code == 0), operation="timelapse",
        output_path=str(out) if code == 0 else None,
        dry_run=False, command=summary,
        stdout=stdout, stderr=stderr,
        error=None if code == 0 else (stderr.strip()[:200] or f"ffmpeg exited {code}"),
    )
```

#### Registration

```python
register(OperationSpec(
    id="timelapse",
    summary="Time-Lapse / Stop-Motion frame sampling",
    description=(
        "Two modes: Time-Lapse compresses a long video into a short fast-forward "
        "(10x speedup → 60s becomes 6s). Stop-Motion keeps the original duration "
        "but reduces frame rate for a choppy slideshow effect (30fps → 1fps). "
        "Pure ffmpeg — no external tools."
    ),
    params_model=TimelapseParams,
    handler=timelapse,
    tags=["timelapse", "speed", "frame-sampling"],
))
```

### 1.2 File: `mtapi-project/app/operations/__init__.py` (EDIT)

Add one line inside the existing `from . import (...)` block:

```python
    timelapse_ops,
```

---

## PHASE 2 — FRONTEND: app.js + index.html

### 2.1 Nav item in `index.html`

Insert after the Vectors nav-item (or after Mosh if Vectors isn't implemented yet), inside the Moshing nav-header:

```html
      <div class="nav-item" data-tab="timelapse">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <polyline points="12 6 12 12 16 14"/>
        </svg>
        Time-Lapse
      </div>
```

### 2.2 State initialization in `app.js`

Add to `let state = { ... }`:

```javascript
  timelapse: { inputPath: null },
```

### 2.3 Form renderer in `app.js`

```javascript
function renderTimelapseForm() {
  const st = state.timelapse || { inputPath: null };
  const inputName = st.inputPath ? basename(st.inputPath) : '';

  const html = `
    <div class="panel-title-desc">
      <h3>Time-Lapse &middot; Frame Sampling</h3>
      <p class="dream-hint">
        Speed up video or reduce frame rate for stop-motion effects. Pure ffmpeg.
      </p>
    </div>

    <div class="form-group">
      <label>Input video</label>
      <div class="input-row">
        <input type="text" id="tlInput" placeholder="/path/to/video.mp4" value="${escapeHtml(st.inputPath || '')}">
        <button type="button" class="btn" id="btnTlBrowse">Browse</button>
      </div>
      ${inputName ? '<span class="field-desc">' + escapeHtml(inputName) + '</span>' : ''}
    </div>

    <div class="form-group">
      <label>Output path (blank = auto-name next to source)</label>
      <input type="text" id="tlOutput" placeholder="optional override">
    </div>

    <div class="knob-bank">
      ${knobUnitHtml({ id: 'tlMode', label: 'Mode', value: 'timelapse', binary: true, leftCap: 'Time-Lapse', rightCap: 'Stop-Motion' })}
    </div>

    <div id="tlSpeedGroup">
      <div class="knob-bank">
        ${knobUnitHtml({ id: 'tlSpeed', label: 'Speed ×', value: '10.0' })}
      </div>
    </div>

    <div id="tlFpsGroup" style="display:none;">
      <div class="knob-bank">
        ${knobUnitHtml({ id: 'tlFps', label: 'Target FPS', value: '1.0' })}
      </div>
    </div>

    <div class="form-group">
      <label>Audio</label>
      <select id="tlAudio">
        <option value="drop" selected>Drop (silent)</option>
        <option value="speed">Speed up (pitch-shifted)</option>
      </select>
    </div>

    <div class="knob-bank">
      ${knobUnitHtml({ id: 'tlDryRun', label: 'Dry run', value: '0', binary: true, leftCap: 'Run', rightCap: 'Dry' })}
    </div>

    <p class="dream-hint">
      <strong>Time-Lapse</strong>: compresses duration (60s &rarr; 6s at 10&times;). Audio dropped or sped up.<br>
      <strong>Stop-Motion</strong>: keeps duration, reduces fps (30fps &rarr; 1fps). Audio preserved.<br>
    </p>
  `;
  elements.actionPanel.innerHTML = html;

  // Mode toggle (binary knob)
  setupBinaryKnob({
    knobId: 'tlModeKnob', indicatorId: 'tlModeKnobInd', hiddenId: 'tlMode',
    leftValue: 'timelapse', rightValue: 'stopmotion', initial: 'timelapse',
  });

  // Speed knob (continuous)
  setupKnob({
    knobId: 'tlSpeedKnob', indicatorId: 'tlSpeedKnobInd',
    valueId: 'tlSpeedVal', hiddenId: 'tlSpeed',
    min: 1.5, max: 100, step: 0.5, decimals: 1,
  });

  // FPS knob (continuous)
  setupKnob({
    knobId: 'tlFpsKnob', indicatorId: 'tlFpsKnobInd',
    valueId: 'tlFpsVal', hiddenId: 'tlFps',
    min: 0.1, max: 15, step: 0.1, decimals: 1,
  });

  // Dry run toggle
  setupBinaryKnob({
    knobId: 'tlDryRunKnob', indicatorId: 'tlDryRunKnobInd', hiddenId: 'tlDryRun',
    leftValue: '0', rightValue: '1', initial: '0',
  });

  // Mode change: swap visible knob + update audio options
  document.getElementById('tlMode')?.addEventListener('change', function() {
    const mode = this.value;
    const speedGroup = document.getElementById('tlSpeedGroup');
    const fpsGroup = document.getElementById('tlFpsGroup');
    const audioSel = document.getElementById('tlAudio');
    if (mode === 'timelapse') {
      if (speedGroup) speedGroup.style.display = '';
      if (fpsGroup)   fpsGroup.style.display = 'none';
      if (audioSel) {
        audioSel.innerHTML = `
          <option value="drop" selected>Drop (silent)</option>
          <option value="speed">Speed up (pitch-shifted)</option>
        `;
      }
    } else {
      if (speedGroup) speedGroup.style.display = 'none';
      if (fpsGroup)   fpsGroup.style.display = '';
      if (audioSel) {
        audioSel.innerHTML = `
          <option value="drop">Drop (silent)</option>
          <option value="keep" selected>Keep (original)</option>
        `;
      }
    }
  });

  // File browser
  document.getElementById('btnTlBrowse')?.addEventListener('click', function() {
    openFileBrowser('tlInput', false, 'file', 'video');
  });
  document.getElementById('tlInput')?.addEventListener('change', function() {
    var val = (document.getElementById('tlInput')?.value || '').trim();
    if (val) state.timelapse.inputPath = val;
  });
}
```

**NOTE**: The `setupKnob` function name may be `setupContinuousKnob` in the codebase — check the actual function name by searching for how `renderDeepDreamForm()` or `renderStyleTransferForm()` sets up continuous knobs. Use whichever name exists.

### 2.4 Payload collector

```javascript
function collectTimelapseBody() {
  var input = (document.getElementById('tlInput')?.value || state.timelapse?.inputPath || '').trim();
  if (!input) {
    alert('Pick a video.');
    return null;
  }
  var mode = document.getElementById('tlMode')?.value || 'timelapse';
  return {
    input_path: input,
    output_path: document.getElementById('tlOutput')?.value?.trim() || null,
    mode: mode,
    speed_factor: parseFloat(document.getElementById('tlSpeed')?.value) || 10.0,
    target_fps:   parseFloat(document.getElementById('tlFps')?.value) || 1.0,
    audio:        document.getElementById('tlAudio')?.value || 'drop',
    dry_run:      document.getElementById('tlDryRun')?.value === '1',
  };
}
```

### 2.5 Tab routing wiring (3 edits in `app.js`)

**Edit 1** — In `renderTabForm(tab)`:
```javascript
  } else if (tab === 'timelapse') {
    renderTimelapseForm();
  }
```

**Edit 2** — In `runActiveOperation()`:
```javascript
  } else if (tab === 'timelapse') {
    const tlBody = collectTimelapseBody();
    if (!tlBody) return;
    opId = 'timelapse';
    body = tlBody;
  }
```

**Edit 3** — In `switchTab(tab)` title:
```javascript
  if (tab === 'timelapse') title = 'Time-Lapse';
```

---

## PHASE 3 — REVIEW: Sanity Checks

1. **Import chain works**: `__init__.py` imports `timelapse_ops` →
   `register()` populates `REGISTRY` → `main.py` auto-creates
   `POST /ops/timelapse`.

2. **Timelapse argv is correct**: `-vf "setpts=PTS/10"` with `-r` and `-an`.

3. **Stopmotion argv is correct**: `-vf "fps=1"` with `-c:a copy`.

4. **Audio mode coercion**: `keep` in timelapse → `drop`. `speed` in stopmotion → `keep`.

5. **Dry run doesn't create files.**

6. **Atempo chain math**: For speed=10, chain should be `atempo=10.0` (single filter, within 100.0 limit). For speed=200, chain should be `atempo=100.0,atempo=2.0`.

7. **Mode toggle swaps visible controls** and updates audio dropdown options.

8. **No regression**: All existing ops still work.

---

## PHASE 4 — VERIFY: End-to-End Test

```bash
# Dry run — timelapse 10x
curl -s -X POST http://localhost:24590/ops/timelapse \
  -H "Content-Type: application/json" \
  -d '{
    "input_path": "/path/to/any/video.mp4",
    "mode": "timelapse",
    "speed_factor": 10.0,
    "audio": "drop",
    "dry_run": true
  }' | python3 -m json.tool

# Real run — timelapse 5x with sped-up audio
curl -s -X POST http://localhost:24590/ops/timelapse \
  -H "Content-Type: application/json" \
  -d '{
    "input_path": "/path/to/any/video.mp4",
    "mode": "timelapse",
    "speed_factor": 5.0,
    "audio": "speed",
    "dry_run": false
  }' | python3 -m json.tool

# Real run — stopmotion at 2fps with audio kept
curl -s -X POST http://localhost:24590/ops/timelapse \
  -H "Content-Type: application/json" \
  -d '{
    "input_path": "/path/to/any/video.mp4",
    "mode": "stopmotion",
    "target_fps": 2.0,
    "audio": "keep",
    "dry_run": false
  }' | python3 -m json.tool
```

Checks:
- Timelapse 10×: `ok=true`, output duration ≈ input_duration / 10, no audio track
- Timelapse 5× + speed audio: output has audio at higher pitch, duration ≈ input / 5
- Stopmotion 2fps: output duration ≈ input duration, video is choppy, audio intact

---

## PITFALLS

1. **`setpts=PTS/N` uses the forward slash.** Not `setpts=PTS*N` or
   `setpts=N*PTS`. Division makes timestamps earlier → video plays faster.

2. **`-r` flag for timelapse output.** Without `-r <input_fps>`, ffmpeg
   may choose a different output frame rate, producing unexpected results.
   Probe the input fps and pass it explicitly.

3. **`atempo` range.** Modern ffmpeg supports up to 100.0 per instance.
   But chain for safety on extreme factors. The `_build_atempo_chain`
   helper handles this.

4. **`fps=N` preserves duration.** This is the whole point of stopmotion
   mode. Do NOT add `setpts` in stopmotion — it would break the timing.

5. **Audio coercion is silent.** `audio="keep"` in timelapse mode should
   silently become "drop" rather than raising an error. Same for
   `audio="speed"` in stopmotion → silently becomes "keep".

6. **`from __future__ import annotations`** is fine in `timelapse_ops.py`.
   Do NOT add it to `main.py`.

---

## FILES TOUCHED (checklist)

- [ ] `mtapi-project/app/operations/timelapse_ops.py` — **CREATE** (~100 lines)
- [ ] `mtapi-project/app/operations/__init__.py` — **EDIT** (add 1 import line)
- [ ] `mtapi-project/app/static/index.html` — **EDIT** (add nav-item, ~8 lines)
- [ ] `mtapi-project/app/static/app.js` — **EDIT** (state key, form renderer, payload collector, 3 routing lines, ~110 lines)
- [ ] Root `AGENTS.md` — **EDIT** (add row to Operation Registry table)

No changes to `contract.py`, `shell.py`, `main.py`, `pathutil.py`, or `style.css`.

---

## HANDOFF

When done, produce:
1. Summary of files and lines changed
2. Deviations from this prompt (and why)
3. Exact `curl` commands to test both modes
4. Unresolved issues or follow-up tasks
