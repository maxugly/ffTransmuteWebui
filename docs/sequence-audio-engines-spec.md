# Sequence Audio Engines Spec

## 🎯 1. Problem & Goal
Currently, when a sequence of video clips is stitched together (`concat_clips`) and time-stretched (altered `targetDuration`), the audio is time-stretched using `rubberband`. While `rubberband` is unequivocally the best all-rounder for pitch-preserved high-quality stretching, we want to expose this choice to the user.

The goal is to introduce an "Audio Engine" dropdown to the Sequence global settings, allowing the user to select *how* audio is manipulated when sequence timings are altered.

For this MVP, we will only make **Rubberband** live (as it's already functioning and is the default), and provide the other engines as disabled/marked placeholders in the UI for future implementation. This MVP is scoped strictly to the `concat_clips` pipeline layer and does not interact with any broader audio frameworks.

## 🏗️ 2. Proposed Options

The Sequence UI will feature a new dropdown (e.g. `id="poolAudioEngine"`) in the Sequence tab's control panel, offering these options:

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
- *Legacy Behavior:* The legacy bash join path (`_run_transmute("join", ...)`, used when target=None) does not need to accept this parameter. It will continue its default CLI behavior.

### B. Backend (`mtapi-project/app/video_pipeline.py`)
- Update `concat_clips` signature to accept `audio_engine: str = "rubberband"`.
- Pass `audio_engine` down to `_join_audio_fragment(..., audio_engine)`.
- Inside `_join_audio_fragment`, fix the baseline audio format to explicitly include sample rate to prevent "random speed" chipmunking in `concat`:
  - Change `aformat=...` to `aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo`
  - Update `anullsrc` to explicitly match: `anullsrc=r=48000:cl=stereo`
- **Fix Zero-Crossing Pops:** Add a 10ms micro-fade to every clip's audio fragment to prevent clicking/popping at the hard cut boundaries.
  - Calculate `new_dur = dur * factor`
  - Append `,afade=t=in:st=0:d=0.01,afade=t=out:st={new_dur - 0.01}:d=0.01` to the fragment string.
- Inside `_join_audio_fragment`, add an `if/elif` block for the engine:
  - `if audio_engine == "rubberband":`
    - Use high-quality DAW-like flags: `return f"{base},rubberband=tempo={aspeed:.10f}:transients=crisp:formants=preserve:pitchq=quality[a{i}]"`
  - *For the placeholders, raise a `NotImplementedError` so backend calls explicitly fail if a placeholder engine is requested.*

### C. Frontend UI (`mtapi-project/app/static/js/`)
- **State (`app.js`):** Add `audioEngine: 'rubberband'` to the default `state.pool` object.
- **HTML (`pool/grid.js`):** Add a new `<select id="poolAudioEngine" class="pool-engine-select">` inside the `.pool-sequence-opts` div rendered by `_composeHtml()`.
  - Option 1: `<option value="rubberband" selected>Audio: Rubberband (Pitch-Preserved)</option>`
  - Option 2: `<option value="atempo" disabled>Audio: atempo (Standard) [Coming Soon]</option>`
  - Option 3: `<option value="pitch" disabled>Audio: Pitch-Shift (Vinyl) [Coming Soon]</option>`
  - Option 4: `<option value="mute" disabled>Audio: Mute [Coming Soon]</option>`
- **JS Binding (`pool/grid.js`):** Add event listeners to sync `poolAudioEngine` with `state.pool.audioEngine` and trigger `scheduleSavePoolState()`. Ensure the selected value populates correctly on render.
- **API Call (`pool/persistence.js`):** In `stitchPoolSequence()`, ensure `audio_engine: state.pool.audioEngine` is passed in the JSON payload to `/ops/join`.
- **Persistence (`pool/persistence.js`):** Ensure the `audioEngine` state is saved and restored:
  - Add `audio_engine: state.pool.audioEngine || 'rubberband',` to `buildPoolStatePayload()`.
  - Add `state.pool.audioEngine = data.audio_engine || 'rubberband';` to `applyPoolData()`.

## 🚨 4. System Invariants & Pitfalls
- **Default Integrity:** The default behavior MUST remain exactly as it is today (which uses rubberband under the hood), but with the new high-quality flags and anti-pop fades.
- **Backend Error Handling:** The backend must throw a `NotImplementedError` if a placeholder engine is submitted, rather than silently falling back. This prevents obscuring unimplemented features if triggered outside the UI.
- **Sample Rate Mismatches:** The `concat` filter is brutally unforgiving and expects decoded PCM audio with identical properties. Since the input bitrate or format (mp3 vs wav) doesn't matter (ffmpeg decodes it all to PCM `fltp`), what *does* matter is the sample rate. If one clip is 44.1kHz and another is 48kHz, `concat` plays the 44.1kHz clip at 48kHz (chipmunk speed). The `aresample=48000` node is strictly required before `concat`.

## 🧪 5. Verification (For the Builder)
1. **UI Load:** Open the UI, check the Sequence tab, and verify the dropdown is present, showing Rubberband as default and the others as disabled placeholders.
2. **Default Stitch:** Stitch a sequence with altered timings without touching the dropdown. Verify it succeeds and audio is pitch-preserved via Rubberband.
3. **Persistence:** Change the dropdown, refresh the page, and verify the UI remembers the selection (even if it's a placeholder you temporarily enabled to test persistence).
