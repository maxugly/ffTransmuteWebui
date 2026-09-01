# Coder Prompt — Speed Change (`speedchange`)

> **Target**: ffTransmuteWebui — new standalone operation + new WebUI tab
> **Spec reference**: `docs/speedchange-spec.md` (same directory)

---

## MISSION

Implement a "Speed Change" operation that uniformly speeds up or slows down a video (0.25×–4.0×). It handles audio via `atempo` (pitch-preserved), `asetpts` (pitch-shifted), or drops it entirely. Pure ffmpeg, no external engines.

The spec is at `docs/speedchange-spec.md`. Read it first.

---

## PHASE 0 — SCOUT: Read Everything First

| File | Why |
|------|-----|
| `docs/speedchange-spec.md` | The spec. All design decisions and ffmpeg pipelines live here. |
| `mtapi-project/app/operations/rife_ops.py` | Primary pattern to follow. |
| `mtapi-project/app/operations/__init__.py` | Import pattern. |
| `mtapi-project/app/contract.py` | `OperationSpec`, `OperationResult`, `REGISTRY`. |
| `mtapi-project/app/shell.py` | `run_command()`. |
| `mtapi-project/app/pathutil.py` | `finalize_output_path()`. |
| `mtapi-project/app/static/app.js` | UI patterns (`setupContinuousKnob`, `setupBinaryKnob`, routing). |

---

## PHASE 1 — BACKEND: `speedchange_ops.py`

### 1.1 File: `mtapi-project/app/operations/speedchange_ops.py` (NEW)

#### Pydantic model and Imports

```python
from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

from ..contract import OperationResult, OperationSpec, register
from ..pathutil import finalize_output_path
from ..shell import run_command


class SpeedChangeParams(BaseModel):
    input_path: str = Field(..., description="Source video path")
    output_path: str | None = Field(None, description="Output path; auto-named if omitted")
    speed: float = Field(2.0, gt=0.0, le=100.0,
                         description="Speed factor: 2.0 = 2x faster, 0.5 = 2x slower")
    audio_mode: Literal["preserve", "pitch", "drop"] = Field(
        "preserve",
        description="Audio handling: preserve (atempo), pitch (asetpts), drop (-an)"
    )
    dry_run: bool = Field(False, description="Print command only")
```

#### Audio Helpers

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


async def _probe_has_audio(path: Path) -> bool:
    """Check if the video has an audio stream."""
    code, stdout, _ = await run_command([
        "ffprobe", "-v", "error",
        "-select_streams", "a",
        "-show_entries", "stream=codec_type",
        "-of", "csv=p=0",
        str(path),
    ])
    return bool(stdout.strip())
```

#### Handler Logic

```python
async def speedchange(p: SpeedChangeParams) -> OperationResult:
    inp = Path(p.input_path).expanduser().resolve()
    if not inp.is_file():
        return OperationResult(
            ok=False, operation="speedchange",
            error=f"Input not found: {inp}", dry_run=p.dry_run,
        )

    if abs(p.speed - 1.0) < 0.001:
        return OperationResult(
            ok=False, operation="speedchange",
            error="Speed is exactly 1.0 — nothing to do.", dry_run=p.dry_run,
        )

    out = finalize_output_path(
        p.output_path, source=inp,
        default_suffix="_speed", default_ext=".mp4",
        allowed_exts={".mp4", ".mov", ".mkv", ".webm"},
    )

    setpts_factor = 1.0 / p.speed
    vf = f"setpts={setpts_factor:.6f}*PTS"

    argv = ["ffmpeg", "-i", str(inp), "-vf", vf]

    # Handle Audio
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

    # Video encoding params
    argv.extend([
        "-c:v", "libx264", "-preset", "fast", "-crf", "18",
        "-pix_fmt", "yuv420p", "-y", str(out)
    ])

    summary = f"speedchange {inp.name} @ {p.speed}x (audio={p.audio_mode})"

    if p.dry_run:
        return OperationResult(
            ok=True, operation="speedchange", output_path=str(out),
            dry_run=True, command=summary,
            stdout=" ".join(argv),
        )

    code, stdout, stderr = await run_command(argv)
    return OperationResult(
        ok=(code == 0), operation="speedchange",
        output_path=str(out) if code == 0 else None,
        dry_run=False, command=summary,
        stdout=stdout, stderr=stderr,
        error=None if code == 0 else (stderr.strip()[:200] or f"ffmpeg exited {code}"),
    )
```

#### Registration

```python
register(OperationSpec(
    id="speedchange",
    summary="Speed Change (Uniform)",
    description=(
        "Uniform speed up or slow down with pitch-preserved audio. "
        "0.25x–4.0x range. Pure ffmpeg setpts + atempo."
    ),
    params_model=SpeedChangeParams,
    handler=speedchange,
    tags=["speed", "time", "utility"],
))
```

### 1.2 File: `mtapi-project/app/operations/__init__.py` (EDIT)

Add one line:
```python
    speedchange_ops,
```

---

## PHASE 2 — FRONTEND: app.js + index.html

### 2.1 Nav section in `index.html`

Add the Speed tab under the new "Utility" category:

```html
      <div class="nav-item" data-tab="speedchange">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="13 19 22 12 13 5 13 19"/>
          <polygon points="2 19 11 12 2 5 2 19"/>
        </svg>
        Speed
      </div>
```

### 2.2 State initialization

In `app.js`:
```javascript
  speedchange: { inputPath: null },
```

### 2.3 Form renderer

```javascript
function renderSpeedchangeForm() {
  const st = state.speedchange || { inputPath: null };
  const inputName = st.inputPath ? basename(st.inputPath) : '';

  const html = `
    <div class="panel-title-desc">
      <h3>Speed Change</h3>
      <p class="dream-hint">
        Uniform speed up or slow down. Covers everyday editing range (0.25x to 4.0x).
      </p>
    </div>

    <div class="form-group">
      <label>Input video</label>
      <div class="input-row">
        <input type="text" id="scInput" placeholder="/path/to/video.mp4" value="${escapeHtml(st.inputPath || '')}">
        <button type="button" class="btn" id="btnScBrowse">Browse</button>
      </div>
      ${inputName ? '<span class="field-desc">' + escapeHtml(inputName) + '</span>' : ''}
    </div>

    <div class="form-group">
      <label>Output path (blank = auto-name next to source)</label>
      <input type="text" id="scOutput" placeholder="optional override">
    </div>

    <div class="knob-bank">
      ${knobUnitHtml({ id: 'scSpeed', label: 'Speed', value: '2.0' })}
    </div>

    <div class="form-group">
      <label>Audio Handling</label>
      <select id="scAudioMode">
        <option value="preserve" selected>Preserve pitch (atempo)</option>
        <option value="pitch">Shift pitch (chipmunk/deep)</option>
        <option value="drop">Drop audio</option>
      </select>
    </div>

    <div class="knob-bank">
      ${knobUnitHtml({ id: 'scDryRun', label: 'Dry run', value: '0', binary: true, leftCap: 'Run', rightCap: 'Dry' })}
    </div>

    <p class="dream-hint">
      <strong>Speed &lt; 1.0</strong> = slow motion. <strong>Speed &gt; 1.0</strong> = fast forward.<br>
      "Preserve pitch" keeps voices natural. "Shift pitch" gives chipmunk (fast) or deep (slow) effects.<br>
      <em>Note: Slowdown below 0.5x may produce choppy video — use RIFE for smooth slow-mo.</em>
    </p>
  `;
  elements.actionPanel.innerHTML = html;

  // Continuous knob
  setupContinuousKnob({ knobId: 'scSpeedKnob', indicatorId: 'scSpeedKnobInd', valueId: 'scSpeedVal', hiddenId: 'scSpeed', min: 0.25, max: 4.0, step: 0.05, decimals: 2 });
  
  // Binary knob
  setupBinaryKnob({ knobId: 'scDryRunKnob', indicatorId: 'scDryRunKnobInd', hiddenId: 'scDryRun', leftValue: '0', rightValue: '1', initial: '0' });

  // File browser
  document.getElementById('btnScBrowse')?.addEventListener('click', function() {
    openFileBrowser('scInput', false, 'file', 'video');
  });
  document.getElementById('scInput')?.addEventListener('change', function() {
    var val = (document.getElementById('scInput')?.value || '').trim();
    if (val) state.speedchange.inputPath = val;
  });
}
```

### 2.4 Payload collector

```javascript
function collectSpeedchangeBody() {
  var input = (document.getElementById('scInput')?.value || state.speedchange?.inputPath || '').trim();
  if (!input) {
    alert('Pick a video to change speed.');
    return null;
  }
  return {
    input_path: input,
    output_path: document.getElementById('scOutput')?.value?.trim() || null,
    speed: parseFloat(document.getElementById('scSpeed')?.value) || 2.0,
    audio_mode: document.getElementById('scAudioMode')?.value || 'preserve',
    dry_run: document.getElementById('scDryRun')?.value === '1',
  };
}
```

### 2.5 Tab routing wiring (3 edits)

**Edit 1** — `renderTabForm(tab)`:
```javascript
  } else if (tab === 'speedchange') {
    renderSpeedchangeForm();
  }
```

**Edit 2** — `runActiveOperation()`:
```javascript
  } else if (tab === 'speedchange') {
    const scBody = collectSpeedchangeBody();
    if (!scBody) return;
    opId = 'speedchange';
    body = scBody;
  }
```

**Edit 3** — `switchTab(tab)` title:
```javascript
  if (tab === 'speedchange') title = 'Speed';
```

---

## PHASE 3 — REVIEW: Sanity Checks

1. **Import chain works**: `POST /ops/speedchange` is auto-created.
2. **Speed 1.0**: Handler rejects it with an error.
3. **atempo math**: A speed of 2.0 results in `setpts=0.5*PTS` and `atempo=2.0`.
4. **ffprobe**: Ensures no audio streams bypass `-af` and use `-an`.
5. **Dry run works**, no regression on existing ops.

---

## PHASE 4 — VERIFY: End-to-End Test

```bash
# Pitch preserved speedup
curl -s -X POST http://localhost:24590/ops/speedchange \
  -H "Content-Type: application/json" \
  -d '{
    "input_path": "/path/to/video.mp4",
    "speed": 2.0,
    "audio_mode": "preserve",
    "dry_run": false
  }' | python3 -m json.tool

# Pitch shifted slowdown
curl -s -X POST http://localhost:24590/ops/speedchange \
  -H "Content-Type: application/json" \
  -d '{
    "input_path": "/path/to/video.mp4",
    "speed": 0.5,
    "audio_mode": "pitch",
    "dry_run": false
  }' | python3 -m json.tool
```

Checks:
- `_speed.mp4` output generated successfully.
- Pitch preserved clip has normal voices.
- Pitch shifted clip has deep voices.

---

## PITFALLS

1. **Audio missing crash**: Running `-af atempo` on a clip with no audio stream will crash ffmpeg. The `_probe_has_audio` check is mandatory.
2. **`setpts` inversion**: To speed up by 2, `setpts` multiplies by 0.5. `setpts_factor = 1.0 / p.speed`.
3. **`from __future__ import annotations`**: Fine in `speedchange_ops.py`. Do NOT add to `main.py`.

---

## FILES TOUCHED

- [ ] `mtapi-project/app/operations/speedchange_ops.py` — **CREATE** (~90 lines)
- [ ] `mtapi-project/app/operations/__init__.py` — **EDIT** (add 1 import)
- [ ] `mtapi-project/app/static/index.html` — **EDIT** (add Speed nav-item)
- [ ] `mtapi-project/app/static/app.js` — **EDIT** (state, form, collector, 3 routing lines)
- [ ] Root `AGENTS.md` — **EDIT** (ops registry table)

---

## HANDOFF

When done, produce:
1. Summary of files and lines changed
2. Deviations from this prompt (and why)
3. Exact `curl` commands
4. Unresolved issues or follow-up tasks
