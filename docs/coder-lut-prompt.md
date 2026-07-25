# Coder Prompt — LUT Color Grading (`lut`)

> **Target**: ffTransmuteWebui — new standalone operation + new WebUI tab
> **Spec reference**: `docs/lut-spec.md` (same directory)
> **Version bump**: (next bump)

---

## MISSION

Implement a "LUT Color Grading" operation that applies a 3D LUT (like `.cube` files) to videos using ffmpeg's `lut3d` filter. It must support an adjustable strength parameter (via a split/mix filter graph).

The spec is at `docs/lut-spec.md`. Read it first. This prompt is the concrete implementation companion.

---

## PHASE 0 — SCOUT: Read Everything First

Before ANY code is written, read these files in full:

| File | Why |
|------|-----|
| `docs/lut-spec.md` | The spec. All design decisions live here. |
| `mtapi-project/app/operations/codecview_ops.py` | **Primary pattern to follow**: Pydantic params → async handler → register(). |
| `mtapi-project/app/operations/__init__.py` | Import pattern for new ops modules. |
| `mtapi-project/app/static/app.js` | UI rendering, file browser patterns, routing structure. |
| `mtapi-project/app/static/index.html` | Nav bar structure (to add the new Utility tab). |

---

## PHASE 1 — BACKEND: `lut_ops.py`

### 1.1 File: `mtapi-project/app/operations/lut_ops.py` (NEW)

Follow the standard ops pattern. Use `run_command` and lists for argv (never `shell=True`).

#### Code structure

```python
from __future__ import annotations
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

from ..contract import OperationResult, OperationSpec, register
from ..pathutil import finalize_output_path
from ..shell import run_command

VIDEO_EXTS = {".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi"}
LUT_EXTS = {".cube", ".3dl", ".dat", ".m3d", ".csp"}

class LutParams(BaseModel):
    input_path: str = Field(..., description="Source video path")
    output_path: str | None = Field(None, description="Output path; auto-named if omitted")
    lut_path: str = Field(..., description="Absolute path to .cube LUT file")
    strength: float = Field(1.0, ge=0.0, le=1.0, description="LUT blend strength (0=original, 1=full LUT)")
    interp: Literal["tetrahedral", "trilinear", "nearest"] = Field("tetrahedral", description="LUT interpolation method")
    dry_run: bool = Field(False, description="Show command only")

async def lut(p: LutParams) -> OperationResult:
    input_path = Path(p.input_path).expanduser().resolve()
    if not input_path.is_file():
        return OperationResult(ok=False, operation="lut", error=f"Input not found: {input_path}", dry_run=p.dry_run)

    lut_path = Path(p.lut_path).expanduser().resolve()
    if not lut_path.is_file():
        return OperationResult(ok=False, operation="lut", error=f"LUT not found: {lut_path}", dry_run=p.dry_run)
    if lut_path.suffix.lower() not in LUT_EXTS:
        return OperationResult(ok=False, operation="lut", error=f"Unsupported LUT format: {lut_path.suffix}", dry_run=p.dry_run)

    out = finalize_output_path(
        p.output_path,
        source=input_path,
        default_suffix="_lut",
        default_ext=".mp4",
        allowed_exts=VIDEO_EXTS,
    )

    lut_str = str(lut_path).replace("'", "'\\''") # escape single quotes for filter string

    argv = ["ffmpeg", "-i", str(input_path)]

    if p.strength >= 0.999:
        vf = f"lut3d=file='{lut_str}':interp={p.interp}"
        argv.extend(["-vf", vf])
    else:
        w1, w2 = 1.0 - p.strength, p.strength
        fc = f"[0:v]split[orig][lut_in];[lut_in]lut3d=file='{lut_str}':interp={p.interp}[graded];[orig][graded]mix=inputs=2:weights='{w1:.3f} {w2:.3f}'[out]"
        argv.extend(["-filter_complex", fc, "-map", "[out]", "-map", "0:a?"])

    argv.extend([
        "-c:v", "libx264", "-preset", "fast", "-crf", "18",
        "-pix_fmt", "yuv420p",
        "-c:a", "copy",
        "-y", str(out),
    ])

    summary = f"lut {input_path.name} lut={lut_path.name} strength={p.strength:.2f}"

    if p.dry_run:
        return OperationResult(ok=True, operation="lut", output_path=str(out), dry_run=True, command=summary, stdout=" ".join(argv))

    code, stdout, stderr = await run_command(argv)
    return OperationResult(
        ok=(code == 0), operation="lut",
        output_path=str(out) if code == 0 else None,
        dry_run=False, command=summary,
        stdout=stdout, stderr=stderr,
        error=None if code == 0 else (stderr.strip()[:200] or f"ffmpeg exited {code}"),
    )

register(OperationSpec(
    id="lut",
    summary="LUT Color Grading",
    description="Applies a 3D LUT (Look-Up Table) for color grading, with adjustable strength.",
    params_model=LutParams,
    handler=lut,
    tags=["lut", "color", "utility"],
))
```

### 1.2 File: `mtapi-project/app/operations/__init__.py` (EDIT)

Add `lut_ops,` to the import list.

---

## PHASE 2 — FRONTEND: app.js + index.html

### 2.1 Nav item in `index.html`

Find the "Utility" nav-header category (or create it if it doesn't exist, though typically there are headers like "Effects"). Create a new `<div class="nav-item" data-tab="lut">` under an appropriate header.

```html
      <div class="nav-item" data-tab="lut">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z" />
          <path d="M12 2a7 7 0 0 0-7 7c0 2 1 3 2 4a5 5 0 0 1 2 4c0 1 1 1 2 1" />
        </svg>
        LUT
      </div>
```

### 2.2 State initialization in `app.js`

```javascript
  lut: { inputPath: null, lutPath: null },
```

### 2.3 Form renderer in `app.js`

```javascript
function renderLutForm() {
  const st = state.lut || { inputPath: null, lutPath: null };
  const inputName = st.inputPath ? basename(st.inputPath) : '';
  const lutName = st.lutPath ? basename(st.lutPath) : '';

  const html = `
    <div class="panel-title-desc">
      <h3>LUT &middot; Color Grading</h3>
      <p class="dream-hint">
        Apply 3D LUT files (.cube) for color grading. Adjust strength to blend with the original video.
      </p>
    </div>

    <div class="form-group">
      <label>Input video</label>
      <div class="input-row">
        <input type="text" id="ltInput" placeholder="/path/to/video.mp4" value="${escapeHtml(st.inputPath || '')}">
        <button type="button" class="btn" id="btnLtBrowse">Browse</button>
      </div>
      ${inputName ? '<span class="field-desc">' + escapeHtml(inputName) + '</span>' : ''}
    </div>

    <div class="form-group">
      <label>LUT file (.cube)</label>
      <div class="input-row">
        <input type="text" id="ltLutPath" placeholder="/path/to/look.cube" value="${escapeHtml(st.lutPath || '')}">
        <button type="button" class="btn" id="btnLtLutBrowse">Browse</button>
      </div>
      ${lutName ? '<span class="field-desc">' + escapeHtml(lutName) + '</span>' : ''}
    </div>

    <div class="form-group">
      <label>Output path (blank = auto-name next to source)</label>
      <input type="text" id="ltOutput" placeholder="optional override">
    </div>

    <div class="form-group">
      <label>Interpolation</label>
      <select id="ltInterp">
        <option value="tetrahedral">Tetrahedral (Best Quality)</option>
        <option value="trilinear">Trilinear</option>
        <option value="nearest">Nearest (Fastest)</option>
      </select>
    </div>

    <div class="knob-bank">
      ${knobContinuousUnitHtml({ id: 'ltStrength', label: 'Strength', min: '0.0', max: '1.0', step: '0.01', defaultVal: '1.0' })}
      ${knobUnitHtml({ id: 'ltDryRun', label: 'Dry run', value: '0', binary: true, leftCap: 'Run', rightCap: 'Dry' })}
    </div>
  `;
  elements.actionPanel.innerHTML = html;

  setupContinuousKnob({
    containerId: 'ltStrengthContainer',
    hiddenId: 'ltStrength',
    labelId: 'ltStrengthLabel',
    baseLabel: 'Strength',
    min: 0.0, max: 1.0, step: 0.01, initial: 1.0,
    formatVal: v => v.toFixed(2)
  });
  setupBinaryKnob({ knobId: 'ltDryRunKnob', indicatorId: 'ltDryRunKnobInd', hiddenId: 'ltDryRun', leftValue: '0', rightValue: '1', initial: '0' });

  document.getElementById('btnLtBrowse')?.addEventListener('click', () => { openFileBrowser('ltInput', false, 'file', 'video'); });
  document.getElementById('ltInput')?.addEventListener('change', () => {
    var val = (document.getElementById('ltInput')?.value || '').trim();
    if (val) state.lut.inputPath = val;
  });

  document.getElementById('btnLtLutBrowse')?.addEventListener('click', () => { openFileBrowser('ltLutPath', false, 'file'); });
  document.getElementById('ltLutPath')?.addEventListener('change', () => {
    var val = (document.getElementById('ltLutPath')?.value || '').trim();
    if (val) state.lut.lutPath = val;
  });
}
```

### 2.4 Payload collector in `app.js`

```javascript
function collectLutBody() {
  var input = (document.getElementById('ltInput')?.value || state.lut?.inputPath || '').trim();
  var lut = (document.getElementById('ltLutPath')?.value || state.lut?.lutPath || '').trim();
  if (!input) { alert('Pick an input video.'); return null; }
  if (!lut) { alert('Pick a LUT file.'); return null; }

  return {
    input_path: input,
    output_path: document.getElementById('ltOutput')?.value?.trim() || null,
    lut_path: lut,
    strength: parseFloat(document.getElementById('ltStrength')?.value || '1.0'),
    interp: document.getElementById('ltInterp')?.value || 'tetrahedral',
    dry_run: document.getElementById('ltDryRun')?.value === '1',
  };
}
```

### 2.5 Tab routing wiring (3 edits in `app.js`)

**Edit 1** — `renderTabForm(tab)`:
```javascript
  } else if (tab === 'lut') {
    renderLutForm();
  }
```

**Edit 2** — `runActiveOperation()`:
```javascript
  } else if (tab === 'lut') {
    const ltBody = collectLutBody();
    if (!ltBody) return;
    opId = 'lut';
    body = ltBody;
  }
```

**Edit 3** — `switchTab(tab)`:
```javascript
  if (tab === 'lut') title = 'LUT';
```

---

## PHASE 3 — REVIEW: Sanity Checks

1. **Import chain**: `__init__.py` properly registers `lut_ops`.
2. **Path handling**: Spaces in `lut_path` must not break ffmpeg. Using `'` in `file='{lut_str}'` and replacing `'` with `'\''` in the string is essential.
3. **Filter graphs**: `-vf` used for strength=1.0, `-filter_complex` + split/mix used for strength < 1.0.
4. **No regression**: Existing tools load correctly.

---

## PHASE 4 — VERIFY: End-to-End Test

```bash
curl -s -X POST http://localhost:24590/ops/lut \
  -H "Content-Type: application/json" \
  -d '{
    "input_path": "/path/to/any/video.mp4",
    "lut_path": "/path/to/look.cube",
    "strength": 0.5,
    "interp": "tetrahedral",
    "dry_run": true
  }' | python3 -m json.tool
```
Should return `ok: true` with a `-filter_complex` graph showing `weights='0.500 0.500'`.

---

## PITFALLS

1. Do NOT use `shell=True` for ffmpeg. Use lists of args with `run_command(argv)`.
2. Single quotes in LUT filenames will break the ffmpeg filter string `file='path'`. That's why `.replace("'", "'\\''")` is critical.

---

## FILES TOUCHED

- `mtapi-project/app/operations/lut_ops.py` (CREATE)
- `mtapi-project/app/operations/__init__.py` (EDIT)
- `mtapi-project/app/static/index.html` (EDIT)
- `mtapi-project/app/static/app.js` (EDIT)
- `AGENTS.md` (EDIT)

---

## HANDOFF

When done, confirm file changes and list any test commands to verify.
