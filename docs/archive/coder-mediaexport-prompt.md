# Coder Prompt — Palette & Media Export (`mediaexport`)

> **Target**: ffTransmuteWebui — new standalone operation + new WebUI tab
> **Spec reference**: `docs/mediaexport-spec.md` (same directory)

---

## MISSION

Implement a "Palette & Media Export" operation that converts video to GIF (two-pass palette), animated WebP, or APNG. Three output formats, one operation, format-specific controls. No external tools — pure ffmpeg.

The spec is at `docs/mediaexport-spec.md`. Read it first.

---

## PHASE 0 — SCOUT: Read Everything First

| File | Why |
|------|-----|
| `docs/mediaexport-spec.md` | The spec. All design decisions live here. |
| `mtapi-project/app/operations/rife_ops.py` | Primary pattern to follow. |
| `mtapi-project/app/operations/codecview_ops.py` | Another single-command filter op. |
| `mtapi-project/app/operations/__init__.py` | Import pattern. |
| `mtapi-project/app/contract.py` | `OperationSpec`, `OperationResult`, `REGISTRY`. |
| `mtapi-project/app/shell.py` | `run_command()`. |
| `mtapi-project/app/pathutil.py` | `finalize_output_path()`. |
| `mtapi-project/app/static/app.js` lines 1010–1095 | `renderRifeForm()` — UI pattern. |
| `mtapi-project/app/static/app.js` lines 320–348 | `renderTabForm()` — routing. |
| `mtapi-project/app/static/app.js` lines 6913–7110 | `runActiveOperation()` — dispatch. |

---

## PHASE 1 — BACKEND: `mediaexport_ops.py`

### 1.1 File: `mtapi-project/app/operations/mediaexport_ops.py` (NEW)

#### Pydantic model

```python
class MediaExportParams(BaseModel):
    input_path: str = Field(..., description="Source video path")
    output_path: str | None = Field(None, description="Output path; auto-named if omitted")
    format: Literal["gif", "webp", "apng"] = Field("gif", description="Output format")
    fps: float = Field(10.0, ge=1, le=30, description="Output frame rate")
    width: int = Field(480, ge=64, le=3840, description="Output width in pixels")
    quality: int = Field(75, ge=1, le=100, description="WebP quality (1-100). Ignored for GIF/APNG.")
    dither: Literal["sierra2_4a", "floyd_steinberg", "bayer", "none"] = Field(
        "sierra2_4a", description="GIF dithering algorithm. Ignored for WebP/APNG.")
    stats_mode: Literal["full", "diff", "single"] = Field(
        "diff", description="GIF palette sampling mode. Ignored for WebP/APNG.")
    loop: int = Field(0, ge=-1, le=100, description="Loop count: 0=infinite, -1=none, N=N times")
    lossless: bool = Field(False, description="WebP lossless mode. Ignored for GIF/APNG.")
    dry_run: bool = Field(False, description="Print command only")
```

#### Handler logic

```python
FORMAT_EXTS = {"gif": ".gif", "webp": ".webp", "apng": ".apng"}


async def mediaexport(p: MediaExportParams) -> OperationResult:
    input_path = Path(p.input_path).expanduser().resolve()
    if not input_path.is_file():
        return OperationResult(
            ok=False, operation="mediaexport",
            error=f"Input not found: {input_path}", dry_run=p.dry_run,
        )

    ext = FORMAT_EXTS[p.format]
    out = finalize_output_path(
        p.output_path, source=input_path,
        default_suffix=f"_{p.format}", default_ext=ext,
        allowed_exts={ext},
    )

    base_vf = f"fps={p.fps},scale={p.width}:-2:flags=lanczos"

    if p.format == "gif":
        # ── GIF: filter_complex with split+palettegen+paletteuse ──
        fc = (
            f"{base_vf},split[s0][s1];"
            f"[s0]palettegen=stats_mode={p.stats_mode}:max_colors=256[p];"
            f"[s1][p]paletteuse=dither={p.dither}:diff_mode=rectangle"
        )
        argv = [
            "ffmpeg",
            "-i", str(input_path),
            "-filter_complex", fc,
            "-loop", str(p.loop),
            "-an", "-y", str(out),
        ]
    elif p.format == "webp":
        # ── WebP: libwebp with quality/lossless controls ──
        argv = [
            "ffmpeg",
            "-i", str(input_path),
            "-vf", base_vf,
            "-c:v", "libwebp",
            "-lossless", "1" if p.lossless else "0",
            "-q:v", str(p.quality),
            "-compression_level", "4",
            "-loop", str(p.loop),
            "-an", "-y", str(out),
        ]
    else:
        # ── APNG: apng codec with -plays for loop ──
        plays = 0 if p.loop <= 0 else p.loop
        argv = [
            "ffmpeg",
            "-i", str(input_path),
            "-vf", base_vf,
            "-c:v", "apng",
            "-plays", str(plays),
            "-an", "-y", str(out),
        ]

    summary = f"mediaexport {input_path.name} → {p.format} {p.width}px {p.fps}fps"

    if p.dry_run:
        return OperationResult(
            ok=True, operation="mediaexport", output_path=str(out),
            dry_run=True, command=summary,
            stdout=" ".join(argv),
        )

    code, stdout, stderr = await run_command(argv)
    return OperationResult(
        ok=(code == 0), operation="mediaexport",
        output_path=str(out) if code == 0 else None,
        dry_run=False, command=summary,
        stdout=stdout, stderr=stderr,
        error=None if code == 0 else (stderr.strip()[:200] or f"ffmpeg exited {code}"),
    )
```

#### Registration

```python
register(OperationSpec(
    id="mediaexport",
    summary="Palette & Media Export (GIF / WebP / APNG)",
    description=(
        "Converts video to animated GIF (two-pass palette), WebP (lossy or lossless), "
        "or APNG with controls for frame rate, dimensions, dithering, and quality. "
        "Pure ffmpeg — no external tools."
    ),
    params_model=MediaExportParams,
    handler=mediaexport,
    tags=["export", "gif", "webp", "utility"],
))
```

### 1.2 File: `mtapi-project/app/operations/__init__.py` (EDIT)

Add one line:
```python
    mediaexport_ops,
```

---

## PHASE 2 — FRONTEND: app.js + index.html

### 2.1 Nav section in `index.html`

Add a **new** "Utility" nav-header section AFTER all existing categories, with the Export tab:

```html
      <div class="nav-header">Utility</div>
      <div class="nav-item" data-tab="mediaexport">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        Export
      </div>
```

### 2.2 State initialization

```javascript
  mediaexport: { inputPath: null },
```

### 2.3 Form renderer

```javascript
function renderMediaexportForm() {
  const st = state.mediaexport || { inputPath: null };
  const inputName = st.inputPath ? basename(st.inputPath) : '';

  const html = `
    <div class="panel-title-desc">
      <h3>Export &middot; GIF / WebP / APNG</h3>
      <p class="dream-hint">
        Convert video to animated GIF, WebP, or APNG with quality controls. Pure ffmpeg.
      </p>
    </div>

    <div class="form-group">
      <label>Input video</label>
      <div class="input-row">
        <input type="text" id="meInput" placeholder="/path/to/video.mp4" value="${escapeHtml(st.inputPath || '')}">
        <button type="button" class="btn" id="btnMeBrowse">Browse</button>
      </div>
      ${inputName ? '<span class="field-desc">' + escapeHtml(inputName) + '</span>' : ''}
    </div>

    <div class="form-group">
      <label>Output path (blank = auto-name next to source)</label>
      <input type="text" id="meOutput" placeholder="optional override">
    </div>

    <div class="form-group">
      <label>Format</label>
      <select id="meFormat">
        <option value="gif" selected>GIF (palette, 256 colors)</option>
        <option value="webp">WebP (lossy/lossless, millions of colors)</option>
        <option value="apng">APNG (lossless, full RGBA)</option>
      </select>
    </div>

    <div class="knob-bank">
      ${knobUnitHtml({ id: 'meFps', label: 'FPS', value: '10' })}
      ${knobUnitHtml({ id: 'meWidth', label: 'Width', value: '480' })}
      ${knobUnitHtml({ id: 'meLoop', label: 'Loop', value: '0' })}
    </div>

    <div id="meGifGroup">
      <div class="form-group">
        <label>Dither (GIF only)</label>
        <select id="meDither">
          <option value="sierra2_4a" selected>Sierra 2-4a (balanced)</option>
          <option value="floyd_steinberg">Floyd-Steinberg (sharp)</option>
          <option value="bayer">Bayer (crosshatch, small files)</option>
          <option value="none">None (posterized)</option>
        </select>
      </div>
      <div class="form-group">
        <label>Palette Mode (GIF only)</label>
        <select id="meStatsMode">
          <option value="diff" selected>Diff (motion-optimized)</option>
          <option value="full">Full (all pixels)</option>
          <option value="single">Per-frame (best quality, larger)</option>
        </select>
      </div>
    </div>

    <div id="meWebpGroup" style="display:none;">
      <div class="knob-bank">
        ${knobUnitHtml({ id: 'meQuality', label: 'Quality', value: '75' })}
      </div>
      <div class="knob-bank">
        ${knobUnitHtml({ id: 'meLossless', label: 'Lossless', value: '0', binary: true, leftCap: 'Lossy', rightCap: 'Lossless' })}
      </div>
    </div>

    <div class="knob-bank">
      ${knobUnitHtml({ id: 'meDryRun', label: 'Dry run', value: '0', binary: true, leftCap: 'Run', rightCap: 'Dry' })}
    </div>

    <p class="dream-hint">
      <strong>GIF</strong>: 256 colors, 1-bit transparency. Universal support.<br>
      <strong>WebP</strong>: Millions of colors, 8-bit alpha. 30-50% smaller than GIF.<br>
      <strong>APNG</strong>: Lossless, full RGBA. Larger files, perfect quality.
    </p>
  `;
  elements.actionPanel.innerHTML = html;

  // Continuous knobs
  setupContinuousKnob({ knobId: 'meFpsKnob', indicatorId: 'meFpsKnobInd', valueId: 'meFpsVal', hiddenId: 'meFps', min: 1, max: 30, step: 1, decimals: 0 });
  setupContinuousKnob({ knobId: 'meWidthKnob', indicatorId: 'meWidthKnobInd', valueId: 'meWidthVal', hiddenId: 'meWidth', min: 64, max: 1920, step: 16, decimals: 0 });
  setupContinuousKnob({ knobId: 'meLoopKnob', indicatorId: 'meLoopKnobInd', valueId: 'meLoopVal', hiddenId: 'meLoop', min: -1, max: 10, step: 1, decimals: 0 });
  setupContinuousKnob({ knobId: 'meQualityKnob', indicatorId: 'meQualityKnobInd', valueId: 'meQualityVal', hiddenId: 'meQuality', min: 1, max: 100, step: 1, decimals: 0 });

  // Binary knobs
  setupBinaryKnob({ knobId: 'meLosslessKnob', indicatorId: 'meLosslessKnobInd', hiddenId: 'meLossless', leftValue: '0', rightValue: '1', initial: '0' });
  setupBinaryKnob({ knobId: 'meDryRunKnob', indicatorId: 'meDryRunKnobInd', hiddenId: 'meDryRun', leftValue: '0', rightValue: '1', initial: '0' });

  // Format change: swap visible controls
  document.getElementById('meFormat')?.addEventListener('change', function() {
    const fmt = this.value;
    const gifGroup = document.getElementById('meGifGroup');
    const webpGroup = document.getElementById('meWebpGroup');
    if (gifGroup) gifGroup.style.display = fmt === 'gif' ? '' : 'none';
    if (webpGroup) webpGroup.style.display = fmt === 'webp' ? '' : 'none';
  });

  // File browser
  document.getElementById('btnMeBrowse')?.addEventListener('click', function() {
    openFileBrowser('meInput', false, 'file', 'video');
  });
  document.getElementById('meInput')?.addEventListener('change', function() {
    var val = (document.getElementById('meInput')?.value || '').trim();
    if (val) state.mediaexport.inputPath = val;
  });
}
```

**NOTE**: Check if `setupContinuousKnob` is the correct function name in the codebase. It may be `setupKnob` — search for how existing forms set up continuous knobs and use the same name.

### 2.4 Payload collector

```javascript
function collectMediaexportBody() {
  var input = (document.getElementById('meInput')?.value || state.mediaexport?.inputPath || '').trim();
  if (!input) {
    alert('Pick a video to export.');
    return null;
  }
  var fmt = document.getElementById('meFormat')?.value || 'gif';
  return {
    input_path: input,
    output_path: document.getElementById('meOutput')?.value?.trim() || null,
    format: fmt,
    fps: parseFloat(document.getElementById('meFps')?.value) || 10,
    width: parseInt(document.getElementById('meWidth')?.value) || 480,
    quality: parseInt(document.getElementById('meQuality')?.value) || 75,
    dither: document.getElementById('meDither')?.value || 'sierra2_4a',
    stats_mode: document.getElementById('meStatsMode')?.value || 'diff',
    loop: parseInt(document.getElementById('meLoop')?.value) || 0,
    lossless: document.getElementById('meLossless')?.value === '1',
    dry_run: document.getElementById('meDryRun')?.value === '1',
  };
}
```

### 2.5 Tab routing wiring (3 edits)

**Edit 1** — `renderTabForm(tab)`:
```javascript
  } else if (tab === 'mediaexport') {
    renderMediaexportForm();
  }
```

**Edit 2** — `runActiveOperation()`:
```javascript
  } else if (tab === 'mediaexport') {
    const meBody = collectMediaexportBody();
    if (!meBody) return;
    opId = 'mediaexport';
    body = meBody;
  }
```

**Edit 3** — `switchTab(tab)` title:
```javascript
  if (tab === 'mediaexport') title = 'Export';
```

---

## PHASE 3 — REVIEW: Sanity Checks

1. **Import chain works**: `POST /ops/mediaexport` is auto-created.

2. **GIF uses `-filter_complex`**, not `-vf`. The split+palettegen+paletteuse
   chain requires filter_complex because it has multiple filter graph outputs.

3. **WebP uses `-c:v libwebp`**, not `libwebp_anim`. Modern ffmpeg handles
   animation with plain `libwebp`.

4. **APNG uses `-plays`**, not `-loop`. Different flag name from GIF/WebP.

5. **All formats strip audio**: `-an` is present in every argv.

6. **Scale uses `-2`** for height (not `-1`) to ensure even dimensions.

7. **Format-specific controls**: GIF group shows dither + stats_mode.
   WebP group shows quality + lossless. Both hidden for APNG.

8. **Dry run works**, no regression on existing ops.

---

## PHASE 4 — VERIFY: End-to-End Test

```bash
# GIF export
curl -s -X POST http://localhost:24590/ops/mediaexport \
  -H "Content-Type: application/json" \
  -d '{
    "input_path": "/path/to/video.mp4",
    "format": "gif",
    "fps": 10,
    "width": 320,
    "dither": "sierra2_4a",
    "stats_mode": "diff",
    "loop": 0,
    "dry_run": false
  }' | python3 -m json.tool

# WebP export
curl -s -X POST http://localhost:24590/ops/mediaexport \
  -H "Content-Type: application/json" \
  -d '{
    "input_path": "/path/to/video.mp4",
    "format": "webp",
    "fps": 15,
    "width": 640,
    "quality": 80,
    "lossless": false,
    "dry_run": false
  }' | python3 -m json.tool

# APNG export
curl -s -X POST http://localhost:24590/ops/mediaexport \
  -H "Content-Type: application/json" \
  -d '{
    "input_path": "/path/to/video.mp4",
    "format": "apng",
    "fps": 15,
    "width": 480,
    "dry_run": false
  }' | python3 -m json.tool
```

Checks:
- GIF: output is `.gif`, plays in browser, colors look good (not banded)
- WebP: output is `.webp`, smaller than equivalent GIF, colors are accurate
- APNG: output is `.apng`, plays in browser, lossless quality
- All: no audio track in output

---

## PITFALLS

1. **GIF uses `-filter_complex`, not `-vf`.** The split/palettegen/paletteuse
   chain has multiple filter graph outputs — `-vf` can't handle this.
   If you use `-vf`, ffmpeg errors with "Filter split has 2 outputs but only 1 is connected."

2. **APNG loop flag is `-plays`, not `-loop`.** Using `-loop` on APNG is
   silently ignored and produces a non-looping file.

3. **`scale=W:-2`** not `scale=W:-1`. The `-2` ensures even height which
   some encoders require. `-1` can produce odd dimensions that crash libwebp.

4. **GIF `stats_mode=single`** produces per-frame palettes — highest quality
   but largest file size. Warn in UI but don't block.

5. **`from __future__ import annotations`** is fine in `mediaexport_ops.py`.
   Do NOT add to `main.py`.

---

## FILES TOUCHED

- [ ] `mtapi-project/app/operations/mediaexport_ops.py` — **CREATE** (~90 lines)
- [ ] `mtapi-project/app/operations/__init__.py` — **EDIT** (add 1 import)
- [ ] `mtapi-project/app/static/index.html` — **EDIT** (add Utility nav-header + Export nav-item)
- [ ] `mtapi-project/app/static/app.js` — **EDIT** (state, form, collector, 3 routing lines)
- [ ] Root `AGENTS.md` — **EDIT** (ops registry table)

---

## HANDOFF

When done, produce:
1. Summary of files and lines changed
2. Deviations from this prompt (and why)
3. Exact `curl` commands for all three formats
4. Unresolved issues or follow-up tasks
