# Coder Prompt — Audio Processing (`audioproc`)

> **Target**: ffTransmuteWebui — new standalone operation + new WebUI tab
> **Spec reference**: `docs/audioproc-spec.md` (same directory)
> **Version bump**: 000.000.2.26 → 000.000.2.27

---

## MISSION

Implement an "Audio Processing" operation that provides loudness normalization, muting/stripping, and adding silent audio tracks to videos. Pure ffmpeg, no re-encoding of video.

The spec is at `docs/audioproc-spec.md`. Read it first. This prompt is the concrete implementation companion.

---

## PHASE 0 — SCOUT: Read Everything First

Before ANY code is written, read these files in full:
- `docs/audioproc-spec.md`
- `mtapi-project/app/operations/rife_ops.py` (pattern reference)
- `mtapi-project/app/static/app.js` (UI patterns, `renderTabForm`, `runActiveOperation`)
- `mtapi-project/app/static/index.html`

---

## PHASE 1 — BACKEND: `audioproc_ops.py`

### 1.1 File: `mtapi-project/app/operations/audioproc_ops.py` (NEW)

#### Pydantic model

```python
from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

from ..contract import OperationResult, OperationSpec, register
from ..pathutil import finalize_output_path
from ..shell import run_command

VIDEO_EXTS = {".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi"}

class AudioProcParams(BaseModel):
    input_path: str = Field(..., description="Source video path")
    output_path: str | None = Field(None, description="Output path; auto-named if omitted")
    mode: Literal["normalize", "mute", "silence"] = Field("normalize", description="Audio operation mode")
    target_lufs: float = Field(-16.0, ge=-70, le=-5, description="Target integrated loudness (LUFS). Normalize mode only.")
    true_peak: float = Field(-1.5, ge=-9, le=0, description="Maximum true peak (dBTP). Normalize mode only.")
    loudness_range: float = Field(11.0, ge=1, le=50, description="Target loudness range (LU). Normalize mode only.")
    sample_rate: int = Field(48000, description="Silent track sample rate. Silence mode only.")
    channel_layout: Literal["stereo", "mono"] = Field("stereo", description="Silent track channel layout. Silence mode only.")
    dry_run: bool = Field(False, description="Show command only")
```

#### Handler logic

```python
async def audioproc(p: AudioProcParams) -> OperationResult:
    input_path = Path(p.input_path).expanduser().resolve()
    if not input_path.is_file():
        return OperationResult(
            ok=False, operation="audioproc",
            error=f"Input not found: {input_path}", dry_run=p.dry_run,
        )

    suffix_map = {
        "normalize": "_normalized",
        "mute": "_muted",
        "silence": "_silent"
    }

    out = finalize_output_path(
        p.output_path,
        source=input_path,
        default_suffix=suffix_map[p.mode],
        default_ext=".mp4",
        allowed_exts=VIDEO_EXTS,
    )

    argv = ["ffmpeg", "-i", str(input_path)]
    summary = f"audioproc {p.mode} {input_path.name}"

    if p.mode == "normalize":
        argv.extend([
            "-af", f"loudnorm=I={p.target_lufs}:TP={p.true_peak}:LRA={p.loudness_range}",
            "-c:v", "copy",
            "-c:a", "aac", "-b:a", "192k"
        ])
    elif p.mode == "mute":
        argv.extend([
            "-c:v", "copy",
            "-an"
        ])
    elif p.mode == "silence":
        argv = [
            "ffmpeg",
            "-i", str(input_path),
            "-f", "lavfi", "-i", f"anullsrc=r={p.sample_rate}:cl={p.channel_layout}",
            "-map", "0:v:0", "-map", "1:a:0",
            "-c:v", "copy",
            "-c:a", "aac", "-b:a", "128k",
            "-shortest"
        ]
    
    argv.extend(["-y", str(out)])

    if p.dry_run:
        return OperationResult(
            ok=True, operation="audioproc", output_path=str(out),
            dry_run=True, command=summary,
            stdout=" ".join(argv),
        )

    code, stdout, stderr = await run_command(argv)
    return OperationResult(
        ok=(code == 0), operation="audioproc",
        output_path=str(out) if code == 0 else None,
        dry_run=False, command=summary,
        stdout=stdout, stderr=stderr,
        error=None if code == 0 else (stderr.strip()[:200] or f"ffmpeg exited {code}"),
    )
```

#### Registration

```python
register(OperationSpec(
    id="audioproc",
    summary="Audio Processing",
    description=(
        "Normalize audio loudness (EBU R128), mute/strip audio streams, "
        "or add a silent audio track to a video."
    ),
    params_model=AudioProcParams,
    handler=audioproc,
    tags=["audio", "utility", "loudnorm"],
))
```

### 1.2 File: `mtapi-project/app/operations/__init__.py` (EDIT)

Add `audioproc_ops,` to the imports list.

---

## PHASE 2 — FRONTEND: app.js + index.html

### 2.1 Nav item in `index.html`

Add the nav item under the "Utility" section:

```html
      <div class="nav-item" data-tab="audioproc">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M11 5L6 9H2v6h4l5 4V5z"/>
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
        </svg>
        Audio
      </div>
```

### 2.2 State initialization in `app.js`

Add `audioproc: { inputPath: null, mode: 'normalize' },` to `state`.

### 2.3 Form renderer in `app.js`

Create `renderAudioprocForm()` which includes `<select id="apMode">` and conditionally displays parameters (LUFS, True Peak, LRA for `normalize`; sample rate and channel layout for `silence`). Use `setupContinuousKnob` for float params and `setupBinaryKnob` for dry run. Use `ap` prefix for element IDs. 

### 2.4 Payload collector in `app.js`

Create `collectAudioprocBody()` checking for `inputPath` and reading the parameters. Ensure numeric values are parsed correctly.

### 2.5 Tab routing wiring

Add routing in `renderTabForm(tab)`, `runActiveOperation()`, and `switchTab(tab)` title mapping (`'Audio'`).

---

## PHASE 3 — REVIEW & VERIFY

Check:
1. Video is never re-encoded (`-c:v copy` in all modes).
2. `-shortest` is present in `silence` mode.
3. Proper `ffmpeg` arguments.
4. UI conditional toggling works.

---

## HANDOFF
When done, summarize your work.
