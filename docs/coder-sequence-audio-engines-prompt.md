# Sequence Audio Engines Implementation

Please implement the sequence audio engines spec as outlined in `docs/sequence-audio-engines-spec.md`.

## The Goal
We need to add a global setting to the Sequence tab to allow the user to select the audio time-stretching engine when sequence timings are altered. Currently, the backend hardcodes `rubberband`, which is our high-quality default. We want to expose this choice in the UI and wire it through the API to the backend.

For this MVP, only `rubberband` will be active and functional. The other options (`atempo`, `pitch`, `mute`) should be added to the UI dropdown as `[Coming Soon]` disabled placeholders.

## Tasks

### 1. Update Backend API & Pydantic Schema
File: `mtapi-project/app/operations/transmute_ops.py`
- Modify `JoinParams` to add a new `audio_engine` field:
  ```python
  audio_engine: Literal["rubberband", "atempo", "pitch", "mute"] = Field(
      "rubberband",
      description="Audio time-stretching engine. Currently only 'rubberband' is fully wired."
  )
  ```
- Ensure `audio_engine` is passed from `p.audio_engine` into `_join_with_preset()` and subsequently down into `concat_clips()`.

### 2. Update Video Pipeline
File: `mtapi-project/app/video_pipeline.py`
- Update the `concat_clips` signature to accept `audio_engine: str = "rubberband"`.
- Pass this argument into `_join_audio_fragment(...)`.
- Inside `_join_audio_fragment`, add a branch to handle `audio_engine == "rubberband"`. The existing logic already returns the correct `rubberband=tempo={aspeed}` string. For the placeholders, you can raise `NotImplementedError` or fallback to rubberband for now.

### 3. Update Frontend UI & State
Files: `mtapi-project/app/static/index.html`, `js/pool/grid.js`, `js/pool/constants.js`
- **HTML**: In the `pool-toolbar-meta` area of the Sequence tab, add a new `<select id="poolAudioEngine" class="pool-engine-select">`. Add the 4 options, with the last 3 disabled and marked as `[Coming Soon]`.
- **State**: Add `audioEngine: 'rubberband'` to the default `poolState` in `constants.js`.
- **JS Binding**: In `grid.js`, bind the change event of the new select element to update `state.pool.audioEngine` and call `scheduleSavePoolState()`. Also ensure the select element is populated from the state when the UI initializes.
- **API Call**: In `stitchPoolSequence()`, ensure `audio_engine: state.pool.audioEngine` is included in the payload sent to `/ops/transmute`.

## Verification (Mandatory)
Before you claim this task is DONE, you must verify the following via Playwright UI testing:
1. Load the UI and verify the new dropdown exists in the Sequence tab.
2. Verify that `rubberband` is the selected default, and the other 3 options are disabled placeholders.
3. Build a sequence with altered timings, hit Stitch, and ensure the backend successfully executes the ffmpeg command with rubberband.
4. Verify that the UI remembers your dropdown selection upon a page refresh.
