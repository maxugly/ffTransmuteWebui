# Sequence Audio Engines Spec

## 🎯 1. Problem & Goal
Currently, when a sequence of video clips is stitched together (`concat_clips`) and time-stretched (altered `targetDuration`), the audio is time-stretched using `rubberband`. While `rubberband` is unequivocally the best all-rounder for pitch-preserved high-quality stretching, we want to expose this choice to the user.

The goal is to introduce an "Audio Engine" dropdown to the Sequence global settings, allowing the user to select *how* audio is manipulated when sequence timings are altered.

For this initial MVP, we will only make **Rubberband** live (as it's already functioning and is the default), and provide the other engines as disabled/marked placeholders in the UI for future implementation.

## 🏗️ 2. Proposed Options

The Sequence UI will feature a new dropdown (e.g. `id="poolAudioEngine"`) in the top global tool bar of the Sequence tab, offering these options:

1. **Rubberband** `value="rubberband"` *(Default, LIVE)*: High-quality pitch-preserving stretch. Uses ffmpeg `rubberband=tempo=X` filter.
2. **Standard (atempo)** `value="atempo"` *(Placeholder)*: Fast WSOLA algorithm, pitch-preserving but can sound robotic on large stretches. Will use ffmpeg `atempo=X` filter.
3. **Vinyl / Pitch-Shift** `value="pitch"` *(Placeholder)*: Pitch shifts proportionally with speed (chipmunk / deep voice). Will use ffmpeg `asetpts` + `aresample`.
4. **Mute Audio** `value="mute"` *(Placeholder)*: Drops the audio track entirely for the stitch. Will use ffmpeg `-an` or `anullsrc`.

*Note: In the UI dropdown, options 2, 3, and 4 must be visually marked as `[Coming Soon]` or disabled so the user knows only Rubberband is fully wired up.*

## ⚙️ 3. Implementation Blueprint

### A. Backend (`mtapi-project/app/operations/transmute_ops.py`)
- Update `JoinParams` to accept a new field:
  ```python
  audio_engine: Literal["rubberband", "atempo", "pitch", "mute"] = Field(
      "rubberband",
      description="Audio time-stretching engine. Currently only 'rubberband' is fully wired."
  )
  ```
- Pass `p.audio_engine` down through `_join_with_preset()` and into `video_pipeline.concat_clips()`.

### B. Backend (`mtapi-project/app/video_pipeline.py`)
- Update `concat_clips` signature to accept `audio_engine: str = "rubberband"`.
- Pass `audio_engine` down to `_join_audio_fragment(..., audio_engine)`.
- Inside `_join_audio_fragment`, add a `match` or `if/elif` block:
  - `if audio_engine == "rubberband": return f"{base},rubberband=tempo={aspeed:.10f}[a{i}]"`
  - *For the placeholders, you may raise a `NotImplementedError` or fallback to rubberband for now until the builder implements the ffmpeg filter chains in a future milestone.*

### C. Frontend UI (`mtapi-project/app/static/index.html` & `js/pool/grid.js`)
- **HTML:** Add a new `<select id="poolAudioEngine" class="pool-engine-select">` near the `Target FPS` and `Reconcile Mode` inputs in the Sequence tab's `pool-toolbar-meta` area.
  - Option 1: `<option value="rubberband" selected>Audio: Rubberband (Pitch-Preserved)</option>`
  - Option 2: `<option value="atempo" disabled>Audio: atempo (Standard) [Coming Soon]</option>`
  - Option 3: `<option value="pitch" disabled>Audio: Pitch-Shift (Vinyl) [Coming Soon]</option>`
  - Option 4: `<option value="mute" disabled>Audio: Mute [Coming Soon]</option>`
- **State (`constants.js`):** Add `audioEngine: 'rubberband'` to the default `poolState` block.
- **JS Binding (`grid.js`):** Add event listeners to sync `poolAudioEngine` with `state.pool.audioEngine` and trigger `scheduleSavePoolState()`.
- **API Call (`grid.js`):** In `stitchPoolSequence()`, ensure `audio_engine: state.pool.audioEngine` is passed in the payload to `/ops/transmute`.

## 🚨 4. System Invariants & Pitfalls
- **Default Integrity:** The default behavior MUST remain exactly as it is today (which uses rubberband under the hood). If the user doesn't touch the dropdown, the API must receive `rubberband` and the backend must execute exactly what it executes today.
- **State Persistence:** Ensure the selected engine is saved to the pool's JSON state (`savePoolStateNow`) so the user's choice persists across reloads.

## 🧪 5. Verification (For the Builder)
1. **UI Load:** Open the UI, check the Sequence tab, and verify the dropdown is present, showing Rubberband as default and the others as disabled placeholders.
2. **Default Stitch:** Stitch a sequence with altered timings without touching the dropdown. Verify it succeeds and audio is pitch-preserved via Rubberband.
3. **Persistence:** Change the dropdown, refresh the page, and verify the UI remembers the selection (even if it's a placeholder you temporarily enabled to test persistence).
