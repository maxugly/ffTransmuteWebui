# Sequence Timeline Export (EDL & FCPXML) + DaVinci Media Preparation — Spec

> **Status:** Specified (ready for Builder)  
> **Hat:** Spec writer (`docs/` only — no app code in this turn)  
> **Scope:** Video Pool **Sequence** composer (`state.pool.sequence`), pure timeline generators (`app/timeline_export.py`), DaVinci-compatible intermediate resolution/generation (`app/operations/timeline_export_ops.py`), and Sequence export UI (`app/static/js/pool/grid.js`, `app/static/js/pool/sequence-export.js`).  
> **Related specs:** `docs/video-image-pools-spec.md` (§2.5 render range), `docs/sequence-conform-copy-spec.md`, `docs/resolve-transcode-spec.md` (§3.1 DaVinci intermediates), `docs/sequence_clip_variant_registry_spec.md`, `docs/file-to-file-transcode-spec.md`, `docs/fast-check-gate-spec.md`.

---

## 1. Goal & Program Context

The Sequence composer (`data-tab="sequence"`) lets users order video clips, set per-clip target durations (`entry.targetDuration`), optionally interpolate with RIFE (`entry.variantPath`), optionally conform (`entry.conformedPath`), and scope renders to a sub-range (`state.pool.renderRange`, `Clips [from] – [to]`). Currently, its only output action is **Stitch Sequence** (`POST /ops/join`), which renders a single concatenated video file via `ffmpeg`.

This spec adds **CMX 3600 EDL (`.edl`)** and **FCPXML (`.xml` / `.fcpxml`)** timeline export to the Sequence composer so users can import their arranged sequence into **DaVinci Resolve** (`File → Import → Timeline…`) as an editable multi-clip timeline in the exact UI order.

### 1.1 Why DaVinci-Compatible Media Mode Is Required Here

As documented in `docs/resolve-transcode-spec.md` §1 & §3.1, **DaVinci Resolve Free on Linux cannot decode H.264 (AVC) or H.265 (HEVC) video or AAC audio** in `.mp4` / `.mkv` containers. Importing an EDL or FCPXML that references H.264 `.mp4` pool clips into Resolve on Linux results in "Media Offline" clips or missing audio.

Therefore, Timeline Export includes a **DaVinci-compatible files only** mode:
- When enabled, every clip in the exported sequence window must reference a DaVinci Resolve–compatible intermediate file (`.mov` with `dnxhd` DNxHR or `prores_ks` ProRes video and `pcm_s16le` uncompressed audio, using the existing `ENCODE_PRESETS` in `app/convert_presets.py`).
- If a clip is already DaVinci-compatible or already has a valid registered DaVinci intermediate variant on disk (from Folder Watcher `dnxhr`, Sequence `conformed`, Convert `export`, or a prior timeline export), it is **reused immediately without re-encoding**.
- If a clip does not yet have a DaVinci-compatible file on disk, the export job **generates it automatically** beside the source file via the existing direct file-to-file transcode pipeline (`app/video_pipeline.py::transcode_with_preset` or `conform_clip` when time-stretched), registers it in the central variant registry (`app/media/cache.py::register_variant`), and points the EDL / FCPXML at the generated `.mov` file.

---

## 2. Non-Negotiable System Invariants (`AGENTS.md`)

1. **No PNG dump for codec transcode (Invariant 1 & `docs/file-to-file-transcode-spec.md`):** Generating missing DaVinci-compatible `.mov` files is a file-to-file ffmpeg operation (`transcode_with_preset` / `conform_clip`) using `ENCODE_PRESETS` from `app/convert_presets.py`. Never dump PNG frames just to transcode to DNxHR or ProRes.
2. **Subprocesses (Invariant 2):** All `ffmpeg` / `ffprobe` calls use `app.shell.run_command` with argv lists (`shell=False`). No subprocess code in `app/main.py`.
3. **Absolute paths (Invariant 3):** All backend input/output paths are absolute (`Path(p).expanduser().resolve()`).
4. **Pixel integrity (Invariant 4):** Generated DaVinci intermediates preserve native resolution and aspect ratio via `transcode_with_preset` unless `entry.targetDuration` or active Sequence Conform explicitly requests geometry/timing normalization.
5. **Dual pools & strict pool normalizer (Invariant 5):**
   - Sequence timeline export is Video Sequence–only (`state.pool.sequence`).
   - `app/media/pool.py::_normalize_pool_payload` is a **strict known-keys normalizer** (unknown keys are pruned on save). Every new persisted pool setting (`export_fps`, `export_resolve_only`, `export_resolve_preset`) **must** be added to `_default_pool_state()` and `_normalize_pool_payload()` in `app/media/pool.py` as well as `buildPoolStatePayload()`, `applyPoolData()`, and `projectNew()` in `app/static/js/pool/persistence.js`.
   - Session autosave (`savePoolStateNow()`) never overwrites a named `*.ffproject.json` on its own.
6. **Vanilla SPA & HelpStrip law (Invariant 7):**
   - Vanilla ES6 modules, HTML5, CSS3. No frameworks or npm libraries.
   - Every new interactive control in the UI must carry `data-help-title` (and optional `data-help-text`) for `HelpStrip`. **Never use native `title=` attributes** (`HelpStrip.audit()` must return 0).
   - Bump `?v=N` cache-busters on modified ES module imports (checked by `tests/test_agent_invariants.py`).
7. **Progress & cancellation (Invariant 9):** When generating missing DaVinci-compatible files, report per-clip progress via `job_control.report_progress()` and check `job_control.check_cancelled()` between clips so the main **Stop** button aborts cleanly.
8. **HTTP 200 errors (Invariant 10):** All operation failures return HTTP 200 with `{"ok": false, "error": "..."}`.
9. **`main.py` untouched (Invariant 11):** Register the backend operation via `contract.register(OperationSpec(...))` in `app/operations/timeline_export_ops.py` (and import it in `app/operations/__init__.py`). Do not add `from __future__ import annotations` or subprocesses to `app/main.py`.
10. **Verification gate (Invariant 12 & 13):** Run `./check-gate.sh` (must be 5/5 green) before running `pytest` (`PYTHONPATH=.venv/lib/python3.11/site-packages .venv/bin/python -m pytest`) and Playwright browser proof (`mtapi-project/junk/prove_timeline_export.mjs`).

---

## 3. Pure Timeline Generators (`mtapi-project/app/timeline_export.py`)

Create a pure-Python module `mtapi-project/app/timeline_export.py` with **zero filesystem or subprocess I/O** so it can be unit-tested in isolation.

### 3.1 Timecode Math (`HH:MM:SS:FF`)

- **Frame rate (`fps`):** Configurable positive number, default `30` (supports standard rates `23.976`, `24`, `25`, `29.97`, `30`, `50`, `60`, etc.).
- **Nominal timebase (`tc_fps`):** `max(1, int(round(float(fps))))` (e.g. `23.976 → 24`, `29.97 → 30`, `30 → 30`). Non-drop-frame (`FCM: NON-DROP FRAME`).
- **Duration to frames:**
  ```python
  def duration_to_frames(duration_seconds: float, fps: float = 30.0) -> int:
      """Convert clip duration in seconds to integer frame count (>= 1 for positive durations)."""
      tc_fps = max(1, int(round(float(fps))))
      if duration_seconds <= 0:
          return 0
      return max(1, int(round(float(duration_seconds) * tc_fps)))
  ```
- **Frames to `HH:MM:SS:FF`:**
  ```python
  def frames_to_tc(total_frames: int, fps: float = 30.0) -> str:
      """Format integer frame count as HH:MM:SS:FF at nominal integer frame rate."""
      tc_fps = max(1, int(round(float(fps))))
      f = max(0, int(total_frames))
      ff = f % tc_fps
      total_seconds = f // tc_fps
      ss = total_seconds % 60
      mm = (total_seconds // 60) % 60
      hh = total_seconds // 3600
      return f"{hh:02d}:{mm:02d}:{ss:02d}:{ff:02d}"
  ```
- **Timeline start timecode:** `01:00:00:00` (`start_frames = 3600 * tc_fps`), standard broadcast/NLE record start expected by DaVinci Resolve.
- **Cumulative record math:** Compute each clip's `clip_frames = duration_to_frames(duration_seconds, fps)` once, then advance `rec_cursor_frames` by `clip_frames`:
  - `src_in = frames_to_tc(0, fps)` → `"00:00:00:00"`
  - `src_out = frames_to_tc(clip_frames, fps)`
  - `rec_in = frames_to_tc(rec_cursor_frames, fps)` (starts at `"01:00:00:00"`)
  - `rec_out = frames_to_tc(rec_cursor_frames + clip_frames, fps)`
  - `rec_cursor_frames += clip_frames`
  This guarantees `rec_out` of clip $i$ is bit-for-bit identical to `rec_in` of clip $i+1$ with zero floating-point drift.

### 3.2 Pure EDL Generator (CMX 3600)

Signature:

```python
def generate_edl(
    clips: list[tuple[str, float]],
    *,
    fps: float = 30.0,
    title: str = "Untitled",
) -> str:
    """Pure function: list[(filename_or_path, duration_seconds)] -> CMX 3600 EDL string."""
```

Format rules:
1. **Header:**
   ```text
   TITLE: <sequence name or "Untitled">
   FCM: NON-DROP FRAME
   ```
   (Followed by a blank line.)
2. **Event lines (1-based `001`, `002`, …):**
   - `reel_name`: filename without directory path and without extension (`Path(filename).stem`), sanitized of whitespace (spaces replaced with `_`).
   - `track`: `V` (video only).
   - `transition`: `C` (linear cut).
   - Fixed-width, space-padded CMX 3600 columns with the **4 standard timecodes** (`src_in`, `src_out`, `rec_in`, `rec_out`):
     ```text
     001  clip1     V     C        00:00:00:00 00:00:05:00 01:00:00:00 01:00:05:00
     * FROM CLIP NAME: clip1.mov
     ```
   - **Note on CMX 3600 & `edl` PyPI parser compatibility:** Standard CMX 3600 (and Python's `edl.Parser` plus DaVinci Resolve's EDL importer) requires exactly 4 timecodes (`src_in`, `src_out`, `rec_in`, `rec_out`) after the `C` transition column — never a 5th timecode column. The clip duration is represented by `src_in` (`00:00:00:00`) → `src_out` (`<duration_tc>`), and `* FROM CLIP NAME: <basename_with_ext>` (plus `* SOURCE FILE: <full_path>` when an absolute path was passed) immediately follows each event line so DaVinci Resolve auto-relinks filenames of any length.

### 3.3 Pure FCPXML Generator

Signature:

```python
def generate_fcpxml(
    clips: list[tuple[str, float]],
    *,
    fps: float = 30.0,
    title: str = "Untitled",
) -> str:
    """Pure function: list[(filename_or_path, duration_seconds)] -> FCPXML string."""
```

Format rules:
- Uses `xml.etree.ElementTree` / `xml.sax.saxutils.escape` so special characters (`&`, `<`, `"`, `'`) in filenames or project titles always produce well-formed UTF-8 XML.
- Uses the exact same frame and timecode math (`duration_to_frames`, `frames_to_tc`) as `generate_edl`.
- Document structure:
  ```xml
  <?xml version="1.0" encoding="UTF-8"?>
  <fcpxml version="1.10.0">
    <assets>
      <asset id="asset-1" name="clip1.mov" src="file:///abs/path/clip1.mov" duration="00:00:05:00" frames="150" tc="00:00:00:00"/>
      <!-- one per clip (src attribute included when input has a path, omitted or basename when bare filename) -->
    </assets>
    <sequence id="seq-1" tc="01:00:00:00" duration="00:00:15:00" fps="30" name="Untitled">
      <spine>
        <clip ref="asset-1" name="clip1.mov" offset="01:00:00:00" duration="00:00:05:00" in="00:00:00:00" out="00:00:05:00"/>
        <!-- one per clip, in exact sequence order -->
      </spine>
    </sequence>
  </fcpxml>
  ```
- **Asset deduplication vs per-slot IDs:** Each `<asset id="asset-{i}">` corresponds 1-to-1 with clip slot $i$ (`1..N`) as specified in the prompt (`<!-- one per clip -->`), with `name` set to `Path(filename).name` (preserving extension so DaVinci Resolve auto-relinks by filename), `duration` as timecode `HH:MM:SS:FF`, `frames` as integer frame count, and `tc="00:00:00:00"`.
- On `<clip>`, `in="00:00:00:00"` and `out="<clip_duration_tc>"` give the source clip range, while `offset="<rec_in_tc>"` and `duration="<clip_duration_tc>"` record the timeline placement.

---

## 4. DaVinci-Compatible Media Mode (Check, Reuse, or Generate)

### 4.1 Supported DaVinci Presets

In `app/convert_presets.py`, the intermediate group already defines the 5 DaVinci Resolve–compatible presets:

```python
DAVINCI_PRESETS: tuple[str, ...] = (
    "dnxhr_hq",
    "dnxhr_sq",
    "dnxhr_lb",
    "prores_hq",
    "prores_proxy",
)
DAVINCI_PRESET_DEFAULT = "dnxhr_hq"
```

All five output `.mov` containers with intra-frame video (`dnxhd` or `prores_ks`) and uncompressed `pcm_s16le` audio, which decode natively in both DaVinci Resolve Free and Studio on Linux, macOS, and Windows.

### 4.2 Determining If a File Is Already DaVinci-Compatible

A media file on disk is considered **natively DaVinci-compatible** (`is_davinci_compatible(path, info)`) when all of the following hold:
1. Container suffix is `.mov` (case-insensitive).
2. Video codec (`video_codec` / `codec_name` from cached `meta` or `probe_copy_info`/`probe`) is in `{"dnxhd", "prores", "prores_ks", "prores_aw", "prores_videotoolbox"}`.
3. Audio stream is either absent (`has_audio == False`) or uses uncompressed PCM (`audio_codec` starts with `"pcm_"`).

### 4.3 Per-Clip Resolution & Generation Pipeline (`resolve_only=True`)

For each clip entry in the effective sequence window (after applying `render_range`):

1. **Resolve base active source path:**
   - If Sequence Conform is enabled and `entry.conformedPath` exists on disk with `entry.conformStatus == "valid"`, start from `entry.conformedPath`.
   - Else if `entry.variantPath` is set and exists on disk, start from `entry.variantPath`.
   - Else if `state.pool.selectedVariantPaths[entry.path]` exists on disk, start from that variant.
   - Else if `entry.cleanPath` exists on disk, start from `entry.cleanPath`.
   - Else start from `entry.path`.
2. **Check if time-stretch is required:**
   - Compute `time_factor = entry.targetDuration / native_duration` when `entry.targetDuration` is set (`> 0`). If `abs(time_factor - 1.0) < 1e-3`, `time_factor = 1.0` (no stretch).
   - Note: If the base active source is already a valid `conformedPath`, its `time_factor` is already baked in (`effective_factor = 1.0`).
3. **Check if base active source is already DaVinci-compatible:**
   - If `effective_factor == 1.0` and `is_davinci_compatible(active_src, info)` is `True`, **reuse `active_src` directly** (0 encodes).
4. **Search existing registered variants & deterministic siblings (Reuse before Generate):**
   - Query `app/media/cache.py::get_variants(active_src, include_missing=False)` (and `get_variants(entry.path)` if `active_src != entry.path`).
   - Check `variants.get("dnxhr")`, `variants.get("conformed")`, and `variants.get("export")`:
     - If `effective_factor == 1.0`: any existing non-empty `.mov` variant whose `detail.get("preset")` matches the requested `resolve_preset` (or any preset in `DAVINCI_PRESETS` if preset is `"auto"`) and whose `detail.get("time_factor", 1.0)` is `1.0` is reused immediately.
     - If `effective_factor != 1.0`: any existing non-empty `.mov` variant whose `detail.get("preset") == resolve_preset` and `abs(float(detail.get("time_factor") or 1.0) - effective_factor) < 1e-3` is reused immediately.
   - Also check deterministic sibling path beside `active_src`:
     - When `effective_factor == 1.0`: `<active_src.stem>_<resolve_preset>.mov` in `active_src.parent`. If it exists on disk, is non-empty (`stat().st_size > 0`), and passes `is_davinci_compatible()`, register it if not yet registered and reuse it.
5. **Generate missing DaVinci-compatible `.mov` file:**
   - If no existing compatible file was found:
     - Report progress: `job_control.report_progress(f"davinci {i+1}/{n} {active_src.name}", phase="davinci", current=i, total=n, unit="clips", token=token)` and call `job_control.check_cancelled()`.
     - Load preset recipe `ep = ENCODE_PRESETS[resolve_preset]`.
     - **Case A (`effective_factor == 1.0`, native speed):**
       - Target path: `out_path = active_src.parent / f"{active_src.stem}_{resolve_preset}.mov"` (if a non-compatible file somehow occupies that name, use `unique_output_path(out_path)`).
       - Run `await transcode_with_preset(active_src, out_path, ep, copy_audio=True)` (file-to-file ffmpeg, converts video to DNxHR/ProRes and audio to `pcm_s16le` per `ep`).
     - **Case B (`effective_factor != 1.0`, time-stretched sequence clip):**
       - Target path: `out_path = active_src.parent / f"{active_src.stem}_{resolve_preset}_t{int(round(entry.targetDuration * 1000))}ms.mov"`.
       - Run `await conform_clip(active_src, out_path, mode="pad", width=info["width"], height=info["height"], target_fps=None, time_factor=effective_factor, encode_preset=ep, duration=native_dur, has_audio=info["has_audio"])` so the sequence clip's stretched duration and pitch-preserved rubberband audio are baked into the `.mov` file at the exact duration declared in the EDL/FCPXML!
     - Register the new file in `app/media/cache.py`:
       ```python
       await register_variant(
           str(Path(entry.path).resolve()),
           kind="dnxhr",
           variant_path=out_path.resolve(),
           detail={
               "preset": resolve_preset,
               "source_path": str(active_src.resolve()),
               "time_factor": float(effective_factor),
               "source_size": int(active_src.stat().st_size),
               "source_mtime": float(active_src.stat().st_mtime),
           },
       )
       ```
     - Use `out_path` (and its probed/baked duration) as the clip's entry in the EDL / FCPXML export.

---

## 5. Backend Operation (`mtapi-project/app/operations/timeline_export_ops.py`)

Register a new operation `sequence_timeline_export` (`POST /ops/sequence_timeline_export`) via `contract.register(OperationSpec(...))` and import `timeline_export_ops` in `app/operations/__init__.py`.

### 5.1 Request Model (`TimelineExportParams`)

```python
class TimelineClipInput(BaseModel):
    path: str = Field(..., description="Original pool clip absolute path")
    active_path: str | None = Field(
        None,
        description="Active variant/conformed/clean path selected for this sequence slot",
    )
    duration: float | None = Field(
        None,
        gt=0,
        description="Known native duration in seconds (optional; probed if omitted)",
    )
    target_duration: float | None = Field(
        None,
        gt=0,
        description="Per-clip sequence time-stretch target duration in seconds (null = native)",
    )


class TimelineExportParams(BaseModel):
    clips: list[TimelineClipInput] = Field(
        ..., min_length=1, description="Ordered clips in the active sequence window"
    )
    format: Literal["edl", "fcpxml"] = Field(
        "edl", description="Timeline export format: 'edl' (CMX 3600) or 'fcpxml' (FCPXML 1.10)"
    )
    fps: float = Field(
        30.0, gt=0, le=240.0, description="Project timeline frame rate (default 30)"
    )
    title: str = Field(
        "Untitled", description="Sequence / project title"
    )
    resolve_only: bool = Field(
        False,
        description="Tie timeline to DaVinci-compatible (.mov DNxHR/ProRes + PCM) files only, generating missing ones beside their sources",
    )
    resolve_preset: str = Field(
        "dnxhr_hq",
        description="Intermediate preset from DAVINCI_PRESETS when resolve_only=True",
    )
    output_path: str | None = Field(
        None,
        description="Optional explicit output file path (.edl or .xml/.fcpxml); auto-named beside first clip or project if omitted",
    )
    dry_run: bool = False
```

### 5.2 Handler Behavior (`sequence_timeline_export`)

1. Validate all clip paths are absolute and exist on disk; return `OperationResult(ok=False, operation="sequence_timeline_export", error=...)` (HTTP 200) on any bad path or unsupported `resolve_preset`.
2. For each clip slot $i \in [0, N)$:
   - Determine `active_src = Path(clip.active_path or clip.path).expanduser().resolve()`.
   - Determine native duration: reuse `clip.duration` if provided and `resolve_only` is False; otherwise check cached record metadata (`media.load_record`) or run `video_pipeline.probe(active_src)`.
   - Determine effective timeline duration: `clip.target_duration` if set (`> 0`), else native duration.
   - If `p.resolve_only` is `True`:
     - Run the §4.3 Check → Reuse → Generate pipeline for this clip.
     - Track `reused_count` and `generated_count`.
     - Update the clip's export path to the resolved/generated `.mov` path.
3. Call `generate_edl(resolved_clips, fps=p.fps, title=clean_title)` or `generate_fcpxml(resolved_clips, fps=p.fps, title=clean_title)`.
4. Write the generated document UTF-8 to `out_file` (defaulting to `<first_clip_dir>/<safe_title>.edl` or `<first_clip_dir>/<safe_title>.xml`, or alongside `p.output_path` if given).
5. Return `OperationResult`:
   ```json
   {
     "ok": true,
     "operation": "sequence_timeline_export",
     "output_path": "/abs/path/Untitled.edl",
     "command": "sequence_timeline_export edl (3 clips @ 30fps)",
     "stdout": "...",
     "meta": {
       "format": "edl",
       "filename": "Untitled.edl",
       "content": "TITLE: Untitled\nFCM: NON-DROP FRAME\n...",
       "fps": 30.0,
       "clip_count": 3,
       "resolve_only": true,
       "resolve_preset": "dnxhr_hq",
       "generated_count": 2,
       "reused_count": 1,
       "resolved_paths": [
         "/abs/path/clip1_dnxhr_hq.mov",
         "/abs/path/clip2_dnxhr_hq.mov",
         "/abs/path/clip3_dnxhr_hq.mov"
       ]
     }
   }
   ```

---

## 6. Frontend UI & State Persistence

### 6.1 Sequence Composer Controls (`mtapi-project/app/static/js/pool/grid.js`)

In `_composeHtml()` inside `.pool-sequence-bar` (after the existing Stitch / Erase buttons or in a dedicated `.seq-export-group` row inside `.pool-sequence-bar`):

```html
<div class="seq-export-group" id="seqExportGroup">
  <label class="pool-opt-label" data-help-title="Timeline frame rate for EDL and FCPXML timecode math (HH:MM:SS:FF). Default 30 fps.">
    TC fps
    <input type="number" id="poolExportFps" min="1" max="240" step="any"
      placeholder="30" class="seq-clip-dur-input"
      value="${state.pool.exportFps || 30}"
      data-help-title="Project frame rate for EDL / FCPXML export (e.g. 24, 25, 30, 60)">
  </label>
  <label class="checkbox-label" data-help-title="Tie exported timeline to DaVinci Resolve-compatible .mov files (DNxHR / ProRes + PCM audio). Reuses existing .mov variants or generates missing ones automatically before exporting.">
    <input type="checkbox" id="poolExportResolveOnly" ${state.pool.exportResolveOnly ? 'checked' : ''}> DaVinci media
  </label>
  <label class="pool-opt-label" data-help-title="Intermediate codec preset used when generating missing DaVinci-compatible .mov files">
    NLE codec
    <select id="poolExportResolvePreset" data-help-title="DaVinci Resolve intermediate format (.mov + PCM audio)">
      <option value="dnxhr_hq" ${(state.pool.exportResolvePreset || 'dnxhr_hq') === 'dnxhr_hq' ? 'selected' : ''}>DNxHR HQ (.mov)</option>
      <option value="dnxhr_sq" ${state.pool.exportResolvePreset === 'dnxhr_sq' ? 'selected' : ''}>DNxHR SQ (.mov)</option>
      <option value="dnxhr_lb" ${state.pool.exportResolvePreset === 'dnxhr_lb' ? 'selected' : ''}>DNxHR LB (.mov)</option>
      <option value="prores_hq" ${state.pool.exportResolvePreset === 'prores_hq' ? 'selected' : ''}>ProRes 422 HQ (.mov)</option>
      <option value="prores_proxy" ${state.pool.exportResolvePreset === 'prores_proxy' ? 'selected' : ''}>ProRes Proxy (.mov)</option>
    </select>
  </label>
  <button class="btn seq-export-btn" id="btnExportEdl" type="button"
    ${seqCount < 1 ? 'disabled' : ''}
    data-help-title="Export the current sequence (or active Clips range) as a CMX 3600 .edl timeline for DaVinci Resolve">
    Export EDL
  </button>
  <button class="btn seq-export-btn" id="btnExportFcpxml" type="button"
    ${seqCount < 1 ? 'disabled' : ''}
    data-help-title="Export the current sequence (or active Clips range) as an FCPXML .xml timeline for DaVinci Resolve">
    Export FCPXML
  </button>
  <span class="seq-export-hint" id="seqExportHint"
    data-help-title="In DaVinci Resolve: File → Import → Timeline… and choose the downloaded .edl or .xml file.">
    Import via File → Import Timeline in DaVinci Resolve.
  </span>
</div>
```

### 6.2 Frontend Export Module (`mtapi-project/app/static/js/pool/sequence-export.js`)

Create `mtapi-project/app/static/js/pool/sequence-export.js`:
1. **Pure browser-side mirrors (`generateEdlString`, `generateFcpxmlString`)** or direct consumption of `data.meta.content` from `POST /ops/sequence_timeline_export`:
   - Calling `runOpWithCancel('sequence_timeline_export', body, { label })` ensures that:
     - Any clip missing cached duration is probed by `ffprobe` on the backend.
     - When **DaVinci media** (`resolve_only`) is checked, missing `.mov` intermediates are generated with live progress (`davinci K/N`) and **Stop** button support.
     - The timeline file is both written to disk (`data.output_path`) **and** immediately downloaded in the browser via a `Blob` + temporary `<a download="...edl|.xml">` click!
2. **Range-aware clip selection:**
   - Use `resolveRange(state.pool.renderRange, state.pool.sequence.length)` and `sliceRange(state.pool.renderRange, state.pool.sequence)` from `app/static/js/pool/sequence-range.js`.
   - Update `#btnExportEdl` and `#btnExportFcpxml` disabled states whenever the sequence or `renderRange` changes (disabled when `rangeClipCount(resolved) < 1`).
3. **Active path & duration assembly:**
   - For each entry in `seqEntries`:
     - `active_path`: if `state.pool.conformEnabled` and `entry.conformedPath` and `entry.conformStatus === 'valid'`, use `entry.conformedPath`; else if `entry.variantPath && entry.variantPath !== entry.path`, use `entry.variantPath`; else if `state.pool.selectedVariantPaths?.[entry.path]`, use that; else if `entry.cleanPath`, use `entry.cleanPath`; else `entry.path`.
     - `duration`: `findPoolItem(entry.path)?.meta?.duration || null`.
     - `target_duration`: `(entry.targetDuration != null && entry.targetDuration > 0) ? Number(entry.targetDuration) : null`.
4. **Sequence title:**
   - `state.project?.name || 'Untitled'`.
5. **Download trigger:**
   - On `data.ok && data.meta?.content`:
     - Create `new Blob([data.meta.content], { type: format === 'fcpxml' ? 'application/xml' : 'text/plain' })`.
     - Trigger `<a download="${data.meta.filename}">` download (`<title>.edl` for EDL, `<title>.xml` for FCPXML).
     - Log to console: `[EXPORT]: Downloaded ${data.meta.filename} (${data.meta.clip_count} clips @ ${data.meta.fps}fps)` plus DaVinci generation/reuse counts when `resolve_only` is active.

### 6.3 Persistence (`app/media/pool.py` & `app/static/js/pool/persistence.js`)

Add these 3 keys to the pool state contract:

| Backend key (`pool.py`) | Frontend key (`state.pool`) | Default | Validation |
|---|---|---|---|
| `export_fps` | `exportFps` | `30` | `_opt_float(v)`, `1 <= fps <= 240`, fallback `30` |
| `export_resolve_only` | `exportResolveOnly` | `False` | `bool(v)` |
| `export_resolve_preset` | `exportResolvePreset` | `"dnxhr_hq"` | `v if v in DAVINCI_PRESETS else "dnxhr_hq"` |

---

## 7. Files to Create / Modify

| File | Action | Purpose |
|---|---|---|
| `mtapi-project/app/timeline_export.py` | **Create** | Pure `generate_edl`, `generate_fcpxml`, `duration_to_frames`, `frames_to_tc` functions |
| `mtapi-project/app/convert_presets.py` | **Modify** | Add `DAVINCI_PRESETS` tuple and `is_davinci_preset()` helper |
| `mtapi-project/app/operations/timeline_export_ops.py` | **Create** | `TimelineExportParams`, `is_davinci_compatible()`, Check/Reuse/Generate DaVinci `.mov` pipeline, `sequence_timeline_export` op registration |
| `mtapi-project/app/operations/__init__.py` | **Modify** | Import `timeline_export_ops` so `POST /ops/sequence_timeline_export` registers |
| `mtapi-project/app/media/pool.py` | **Modify** | Add `export_fps`, `export_resolve_only`, `export_resolve_preset` to `_default_pool_state` and `_normalize_pool_payload` |
| `mtapi-project/app/static/js/pool/sequence-export.js` | **Create** | `exportSequenceTimeline('edl' \| 'fcpxml')`, `updateExportButtons()`, Blob download trigger |
| `mtapi-project/app/static/js/pool/grid.js` | **Modify** | Render `.seq-export-group` controls + hint in `_composeHtml()`, bind events in `_bindSequencePanel()`, bump `?v=` cache-busters |
| `mtapi-project/app/static/js/pool/sequence-composer.js` | **Modify** | Call `updateExportButtons()` in `renderSequenceBox()` |
| `mtapi-project/app/static/js/pool/sequence-range-ui.js` | **Modify** | Call `updateExportButtons()` in `updateSeqRangeUI()` when clip range changes |
| `mtapi-project/app/static/js/pool/persistence.js` | **Modify** | Persist/restore `exportFps`, `exportResolveOnly`, `exportResolvePreset` |
| `mtapi-project/app/static/css/pool.css` | **Modify** | Style `.seq-export-group`, `.seq-export-btn`, `.seq-export-hint` |
| `mtapi-project/tests/test_timeline_export.py` | **Create** | Unit & integration tests for pure EDL/FCPXML generators, parser validation, and DaVinci `.mov` generation + reuse |
| `mtapi-project/junk/prove_timeline_export.mjs` | **Create** | Playwright end-to-end browser proof on isolated server instance |

---

## 8. Acceptance Criteria & Verification Plan

1. **Fast Gate:**
   - `./check-gate.sh` passes 5/5 (ESM syntax, import resolution, HTML balance, Python compile).
2. **Unit Tests (`mtapi-project/tests/test_timeline_export.py`):**
   - **Pure EDL 3-clip test:** Pass a 3-clip sequence `[("clip1.mp4", 2.0), ("/path/to/clip2.mov", 3.5), ("clip3.mp4", 1.0)]` at `30` fps (and `24` fps) to `generate_edl()`. Verify:
     - `TITLE:` and `FCM: NON-DROP FRAME` headers.
     - Event numbers `001`, `002`, `003`.
     - Reel names stripped of path and extension (`clip1`, `clip2`, `clip3`).
     - Transition `V` and `C` on all events.
     - Source in/out `00:00:00:00` → clip duration (`00:00:02:00`, `00:00:03:15`, `00:00:01:00`).
     - Cumulative record in/out (`01:00:00:00` → `01:00:02:00`, `01:00:02:00` → `01:00:05:15`, `01:00:05:15` → `01:00:06:15`).
     - Validate parsing via the `edl` PyPI package if installed (`import edl; parser = edl.Parser("30"); ...`) plus strict CMX 3600 line-format assertions.
   - **Pure FCPXML 3-clip test:** Pass the same 3-clip sequence to `generate_fcpxml()`. Verify:
     - Parses cleanly with `xml.etree.ElementTree.fromstring()`.
     - Root `<fcpxml version="1.10.0">`, `<assets>` with 3 `<asset>` elements (`id="asset-1".."asset-3"`, `name="clip1.mp4"`, etc.), `<sequence tc="01:00:00:00">` with `<spine>` containing 3 `<clip>` elements in exact order with matching `ref`, `in`, `out`, `offset`, and `duration`.
   - **DaVinci-compatible media generation & reuse test:**
     - Create 3 H.264 `.mp4` test clips via ffmpeg.
     - Call `POST /ops/sequence_timeline_export` with `resolve_only=True, resolve_preset="dnxhr_hq"`.
     - Verify 3 `<stem>_dnxhr_hq.mov` files are generated on disk (`generated_count == 3`, `reused_count == 0`), registered in `get_variants(src)["dnxhr"]`, probed as `codec_name == "dnxhd"` with `pcm_s16le` audio, and referenced by `.mov` filename in the exported EDL and FCPXML.
     - Call `POST /ops/sequence_timeline_export` a second time with `resolve_only=True` and verify **zero** new encodes run (`generated_count == 0`, `reused_count == 3`).
   - **Invariant 10 test:** Missing file or invalid preset returns HTTP 200 with `{"ok": false}`.
3. **Playwright Real-Browser Proof (`mtapi-project/junk/prove_timeline_export.mjs`):**
   - Launch an isolated server on `:24591` with a 3-clip sequence in the UI.
   - Verify `#poolExportFps`, `#poolExportResolveOnly`, `#poolExportResolvePreset`, `#btnExportEdl`, `#btnExportFcpxml`, and `#seqExportHint` ("Import via File → Import Timeline in DaVinci Resolve.") are visible on the Sequence tab.
   - Click `#btnExportEdl` → verify `.edl` download triggers and file contents match the 3-clip sequence order.
   - Click `#btnExportFcpxml` → verify `.xml` download triggers and XML parses with all 3 clips in order.
   - Check `#poolExportResolveOnly` (`DaVinci media`), click `#btnExportEdl` / `#btnExportFcpxml` → verify missing `.mov` intermediates are generated on disk, subsequent export reuses them without re-encoding, and the downloaded timeline references the `.mov` files.
   - Verify `HelpStrip.audit()` returns `0` (no native `title=` attributes) and zero console/page errors occur.
