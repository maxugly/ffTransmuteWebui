# Coder Prompt — Codec Motion Vector Overlay (`codecview`)

> **Target**: ffTransmuteWebui — new standalone operation + new WebUI tab
> **Spec reference**: `docs/codecview-spec.md` (same directory)
> **Version bump**: 000.000.2.25 → 000.000.2.26

---

## MISSION

Implement a "Codec Motion Vector Overlay" operation that draws H.264/MPEG-2/MPEG-4 decoder motion vectors as colored arrows over the video using ffmpeg's `codecview` filter. This is a single-command ffmpeg operation — the simplest possible ops module in the project.

The spec is at `docs/codecview-spec.md`. Read it first. This prompt is the concrete implementation companion.

---

## PHASE 0 — SCOUT: Read Everything First

Before ANY code is written, read these files in full:

| File | Why |
|------|-----|
| `docs/codecview-spec.md` | The spec. All design decisions live here. |
| `mtapi-project/app/operations/rife_ops.py` | **Primary pattern to follow**: Pydantic params → async handler → register(). Codecview is structurally identical but even simpler (no temp dirs, no frame dumps). |
| `mtapi-project/app/operations/__init__.py` | Import pattern for new ops modules. |
| `mtapi-project/app/contract.py` | `OperationSpec`, `OperationResult`, `REGISTRY`. |
| `mtapi-project/app/shell.py` | `run_command()` — the only subprocess helper you need. |
| `mtapi-project/app/pathutil.py` | `finalize_output_path()` — output path resolution. |
| `mtapi-project/app/static/app.js` lines 1010–1095 | `renderRifeForm()` — the exact UI pattern to replicate for the Vectors tab. |
| `mtapi-project/app/static/app.js` lines 1097–1115 | `collectRifeBody()` — the payload collector pattern. |
| `mtapi-project/app/static/app.js` lines 320–348 | `renderTabForm()` — where to add the routing branch. |
| `mtapi-project/app/static/app.js` lines 6913–7110 | `runActiveOperation()` — where to add the dispatch branch. |
| `mtapi-project/app/static/index.html` lines 27–36 | Existing Mosh nav-item — insert the Vectors nav-item right after it. |

The Scout reports back: confirm every file path is reachable, note any
differences between the spec's assumptions and reality, flag anything
that would block implementation. No code yet.

---

## PHASE 1 — BACKEND: `codecview_ops.py`

### 1.1 File: `mtapi-project/app/operations/codecview_ops.py` (NEW)

Follow the pattern from `rife_ops.py`. Same imports, same conventions.

#### Pydantic model

```python
class CodecviewParams(BaseModel):
    input_path: str = Field(..., description="Source video path")
    output_path: str | None = Field(None, description="Output path; auto-named if omitted")
    mv_pf: bool = Field(True, description="Show P-frame forward-predicted vectors (green arrows)")
    mv_bf: bool = Field(True, description="Show B-frame forward-predicted vectors (blue arrows)")
    mv_bb: bool = Field(True, description="Show B-frame backward-predicted vectors (red arrows)")
    show_block: bool = Field(False, description="Overlay macroblock partition boundaries as a grid")
    show_qp: bool = Field(False, description="Overlay quantization parameter heatmap")
    dry_run: bool = Field(False, description="Print command only")
```

#### Handler logic

```python
VIDEO_EXTS = {".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi"}


async def codecview(p: CodecviewParams) -> OperationResult:
    input_path = Path(p.input_path).expanduser().resolve()
    if not input_path.is_file():
        return OperationResult(
            ok=False, operation="codecview",
            error=f"Input not found: {input_path}", dry_run=p.dry_run,
        )

    # Build MV flags
    mv_parts = []
    if p.mv_pf: mv_parts.append("pf")
    if p.mv_bf: mv_parts.append("bf")
    if p.mv_bb: mv_parts.append("bb")
    if not mv_parts:
        return OperationResult(
            ok=False, operation="codecview",
            error="At least one motion vector type must be enabled (P-fwd, B-fwd, or B-back)",
            dry_run=p.dry_run,
        )

    # Build filter string
    vf = f"codecview=mv={'+'.join(mv_parts)}"
    if p.show_block:
        vf += ":block=1"
    if p.show_qp:
        vf += ":qp=1"

    # Resolve output path
    out = finalize_output_path(
        p.output_path,
        source=input_path,
        default_suffix="_codecview",
        default_ext=".mp4",
        allowed_exts=VIDEO_EXTS,
    )

    # Build argv — CRITICAL: -flags2 +export_mvs MUST come BEFORE -i
    argv = [
        "ffmpeg",
        "-flags2", "+export_mvs",
        "-i", str(input_path),
        "-vf", vf,
        "-c:v", "libx264", "-preset", "fast", "-crf", "18",
        "-pix_fmt", "yuv420p",
        "-c:a", "copy",
        "-y", str(out),
    ]

    summary = f"codecview {input_path.name} mv={'+'.join(mv_parts)}"
    if p.show_block: summary += " +block"
    if p.show_qp: summary += " +qp"

    if p.dry_run:
        return OperationResult(
            ok=True, operation="codecview", output_path=str(out),
            dry_run=True, command=summary,
            stdout=" ".join(argv),
        )

    code, stdout, stderr = await run_command(argv)
    return OperationResult(
        ok=(code == 0), operation="codecview",
        output_path=str(out) if code == 0 else None,
        dry_run=False, command=summary,
        stdout=stdout, stderr=stderr,
        error=None if code == 0 else (stderr.strip()[:200] or f"ffmpeg exited {code}"),
    )
```

#### Registration (bottom of file)

```python
register(OperationSpec(
    id="codecview",
    summary="Codec Motion Vector Overlay (diagnostic HUD)",
    description=(
        "Draws the raw motion vectors from H.264/MPEG-2/MPEG-4 decoding "
        "as colored arrows over the video, with optional macroblock grid "
        "and QP heatmap overlays. Pure ffmpeg — no external tools."
    ),
    params_model=CodecviewParams,
    handler=codecview,
    tags=["codecview", "diagnostic", "motion-vectors"],
))
```

### 1.2 File: `mtapi-project/app/operations/__init__.py` (EDIT)

Add one line inside the existing `from . import (...)` block:

```python
    codecview_ops,
```

---

## PHASE 2 — FRONTEND: app.js + index.html

### 2.1 Nav item in `index.html`

Insert this block **after** the Mosh nav-item (the one with `data-tab="mosh"`, around line 36), inside the same nav-header section:

```html
      <div class="nav-item" data-tab="codecview">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
        </svg>
        Vectors
      </div>
```

### 2.2 State initialization in `app.js`

Add to the `let state = { ... }` object:

```javascript
  codecview: { inputPath: null },
```

### 2.3 Form renderer in `app.js`

Add `renderCodecviewForm()` — follow the `renderRifeForm()` pattern exactly:

```javascript
function renderCodecviewForm() {
  const st = state.codecview || { inputPath: null };
  const inputName = st.inputPath ? basename(st.inputPath) : '';

  const html = `
    <div class="panel-title-desc">
      <h3>Vectors &middot; Codec Motion Vector Overlay</h3>
      <p class="dream-hint">
        Draw H.264/MPEG motion vectors as colored arrows over the video.
        Pure ffmpeg &mdash; no external tools.
      </p>
    </div>

    <div class="form-group">
      <label>Input video</label>
      <div class="input-row">
        <input type="text" id="cvInput" placeholder="/path/to/video.mp4" value="${escapeHtml(st.inputPath || '')}">
        <button type="button" class="btn" id="btnCvBrowse">Browse</button>
      </div>
      ${inputName ? '<span class="field-desc">' + escapeHtml(inputName) + '</span>' : ''}
    </div>

    <div class="form-group">
      <label>Output path (blank = auto-name next to source)</label>
      <input type="text" id="cvOutput" placeholder="optional override">
    </div>

    <div class="knob-bank">
      ${knobUnitHtml({ id: 'cvMvPf', label: 'P-fwd', value: '1', binary: true, leftCap: 'Off', rightCap: 'On' })}
      ${knobUnitHtml({ id: 'cvMvBf', label: 'B-fwd', value: '1', binary: true, leftCap: 'Off', rightCap: 'On' })}
      ${knobUnitHtml({ id: 'cvMvBb', label: 'B-back', value: '1', binary: true, leftCap: 'Off', rightCap: 'On' })}
    </div>
    <div class="knob-bank">
      ${knobUnitHtml({ id: 'cvBlock', label: 'Block', value: '0', binary: true, leftCap: 'Off', rightCap: 'On' })}
      ${knobUnitHtml({ id: 'cvQp', label: 'QP', value: '0', binary: true, leftCap: 'Off', rightCap: 'On' })}
      ${knobUnitHtml({ id: 'cvDryRun', label: 'Dry run', value: '0', binary: true, leftCap: 'Run', rightCap: 'Dry' })}
    </div>
    <p class="dream-hint">
      <strong>P-fwd</strong> = green arrows (P-frame forward vectors)<br>
      <strong>B-fwd</strong> = blue arrows (B-frame forward vectors)<br>
      <strong>B-back</strong> = red arrows (B-frame backward vectors)<br>
      <strong>Block</strong> = macroblock boundary grid<br>
      <strong>QP</strong> = quantization parameter heatmap<br>
      Works with H.264, MPEG-2, MPEG-4. Other codecs produce no overlay.
    </p>
  `;
  elements.actionPanel.innerHTML = html;

  // Wire up binary knobs
  setupBinaryKnob({ knobId: 'cvMvPfKnob', indicatorId: 'cvMvPfKnobInd', hiddenId: 'cvMvPf', leftValue: '0', rightValue: '1', initial: '1' });
  setupBinaryKnob({ knobId: 'cvMvBfKnob', indicatorId: 'cvMvBfKnobInd', hiddenId: 'cvMvBf', leftValue: '0', rightValue: '1', initial: '1' });
  setupBinaryKnob({ knobId: 'cvMvBbKnob', indicatorId: 'cvMvBbKnobInd', hiddenId: 'cvMvBb', leftValue: '0', rightValue: '1', initial: '1' });
  setupBinaryKnob({ knobId: 'cvBlockKnob', indicatorId: 'cvBlockKnobInd', hiddenId: 'cvBlock', leftValue: '0', rightValue: '1', initial: '0' });
  setupBinaryKnob({ knobId: 'cvQpKnob', indicatorId: 'cvQpKnobInd', hiddenId: 'cvQp', leftValue: '0', rightValue: '1', initial: '0' });
  setupBinaryKnob({ knobId: 'cvDryRunKnob', indicatorId: 'cvDryRunKnobInd', hiddenId: 'cvDryRun', leftValue: '0', rightValue: '1', initial: '0' });

  // File browser
  document.getElementById('btnCvBrowse')?.addEventListener('click', function() {
    openFileBrowser('cvInput', false, 'file', 'video');
  });
  document.getElementById('cvInput')?.addEventListener('change', function() {
    var val = (document.getElementById('cvInput')?.value || '').trim();
    if (val) state.codecview.inputPath = val;
  });
}
```

### 2.4 Payload collector in `app.js`

```javascript
function collectCodecviewBody() {
  var input = (document.getElementById('cvInput')?.value || state.codecview?.inputPath || '').trim();
  if (!input) {
    alert('Pick a video to visualize.');
    return null;
  }
  return {
    input_path: input,
    output_path: document.getElementById('cvOutput')?.value?.trim() || null,
    mv_pf:      document.getElementById('cvMvPf')?.value === '1',
    mv_bf:      document.getElementById('cvMvBf')?.value === '1',
    mv_bb:      document.getElementById('cvMvBb')?.value === '1',
    show_block: document.getElementById('cvBlock')?.value === '1',
    show_qp:    document.getElementById('cvQp')?.value === '1',
    dry_run:    document.getElementById('cvDryRun')?.value === '1',
  };
}
```

### 2.5 Tab routing wiring (3 edits in `app.js`)

**Edit 1** — In `renderTabForm(tab)` (around line 335), add a branch:

```javascript
  } else if (tab === 'codecview') {
    renderCodecviewForm();
  }
```

Insert it after the `rife` branch and before `transmute`.

**Edit 2** — In `runActiveOperation()` (around line 7070), add a branch:

```javascript
  } else if (tab === 'codecview') {
    const cvBody = collectCodecviewBody();
    if (!cvBody) return;
    opId = 'codecview';
    body = cvBody;
  }
```

Insert it after the `rife` branch and before `advanced`.

**Edit 3** — In `switchTab(tab)` where the title is set (search for `tabTitle` assignments), add:

```javascript
  if (tab === 'codecview') title = 'Vectors';
```

Use the same pattern as the existing title assignments.

---

## PHASE 3 — REVIEW: Sanity Checks

The Reviewer should verify:

1. **Import chain works**: `__init__.py` imports `codecview_ops` →
   `register()` populates `REGISTRY` → `main.py` auto-creates
   `POST /ops/codecview`.

2. **Argv order is correct**: `-flags2 +export_mvs` appears BEFORE `-i`
   in the constructed command. This is the #1 source of silent failure.

3. **MV flag string is well-formed**: At least one of `pf`/`bf`/`bb` is
   present, joined by `+`, no trailing `+`, no empty string.

4. **Dry run doesn't create files**: When `dry_run=True`, the handler
   returns `ok=True` with the command string but does NOT execute it.

5. **Audio passthrough**: The command uses `-c:a copy`, not re-encoding.

6. **Error handling**: Missing input file → `ok=False` with message.
   At least one MV type required → `ok=False` with message. ffmpeg
   crash → `ok=False` with stderr.

7. **No regression**: All existing operations still work.
   ```bash
   curl http://localhost:24590/ops | python3 -c "import sys,json; d=json.load(sys.stdin); print('codecview' in d)"
   ```
   Should print `True`.

8. **Nav item placement**: The Vectors tab appears right after Mosh in
   the sidebar, within the same category header.

---

## PHASE 4 — VERIFY: End-to-End Test

After implementation, test with any H.264 MP4:

```bash
# Dry run — should return command string without executing
curl -s -X POST http://localhost:24590/ops/codecview \
  -H "Content-Type: application/json" \
  -d '{
    "input_path": "/path/to/any/h264/video.mp4",
    "mv_pf": true,
    "mv_bf": true,
    "mv_bb": true,
    "show_block": false,
    "show_qp": false,
    "dry_run": true
  }' | python3 -m json.tool

# Real run — all vectors + block grid
curl -s -X POST http://localhost:24590/ops/codecview \
  -H "Content-Type: application/json" \
  -d '{
    "input_path": "/path/to/any/h264/video.mp4",
    "mv_pf": true,
    "mv_bf": true,
    "mv_bb": true,
    "show_block": true,
    "show_qp": false,
    "dry_run": false
  }' | python3 -m json.tool
```

Checks:
- Dry run: `ok=true`, `dry_run=true`, `command` contains the ffmpeg invocation, no file created
- Real run: `ok=true`, `output_path` points to a real `.mp4` file
- Playing the output: colored arrows visible over the video, original audio intact
- The arrows are green (P-fwd), blue (B-fwd), and red (B-back)

---

## PITFALLS

1. **`-flags2 +export_mvs` MUST come before `-i`.** If placed after,
   ffmpeg exits 0 but draws no arrows. Silent failure. The handler
   hardcodes argv order — do not rearrange it.

2. **VP9/AV1/ProRes inputs produce no overlay.** ffmpeg exits 0 but
   the codecview filter has no MV data to draw. This is expected and
   documented in the UI hint text. Do not try to detect this.

3. **Re-encoding is mandatory.** `-c:v copy` is impossible with any
   `-vf` filter. Always use `-c:v libx264 -preset fast -crf 18`.

4. **`from __future__ import annotations`** — it's fine in
   `codecview_ops.py` (operations modules use it), but do NOT add it
   to `main.py` (breaks FastAPI route generation).

5. **No temp dirs needed.** This is a single-pass ffmpeg filter, not a
   dump-process-re-encode pipeline. Do not create temp directories.

---

## FILES TOUCHED (checklist)

- [ ] `mtapi-project/app/operations/codecview_ops.py` — **CREATE** (~85 lines)
- [ ] `mtapi-project/app/operations/__init__.py` — **EDIT** (add 1 import line)
- [ ] `mtapi-project/app/static/index.html` — **EDIT** (add nav-item, ~8 lines)
- [ ] `mtapi-project/app/static/app.js` — **EDIT** (4 changes: state key, form renderer, payload collector, 3 routing lines)
- [ ] Root `AGENTS.md` — **EDIT** (add row to Operation Registry table)
- [ ] `VERSION` — **BUMP** to `000.000.2.26`

That's it. Five files modified, one file created. No changes to
`contract.py`, `shell.py`, `main.py`, `pathutil.py`, or `style.css`.

---

## HANDOFF

When done, produce:
1. A summary of what was built (files, lines changed)
2. Any decisions that deviated from this prompt (and why)
3. The exact `curl` command to test the endpoint
4. Any unresolved issues or follow-up tasks
