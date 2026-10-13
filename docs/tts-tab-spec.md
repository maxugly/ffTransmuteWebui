# Local TTS and reusable audio export

Implemented under Neural FX as **TTS** (`tts`), separate from References → TTS.
The tab uses the full action workspace, with no video input or preview frame.

## Basic controls

- Text box: 1–10,000 characters. English input; US/UK voices where supplied.
- Voice dropdown: selections persist per model. Piper exposes 23 single-speaker
  English voices (US/GB); Kokoro exposes 28 English US/UK voices; DECtalk nine;
  Supertonic 3 ten; KittenTTS eight. `＋` marks voices with no installed profile.
- Quality / model size dropdown: per-voice available profiles, with `＋` on missing
  profiles. Piper low/medium/high select different trained checkpoints; only
  levels actually published for that voice appear. Lessac and Ryan offer all
  three. Kitten Nano/Micro/Mini select 15M/40M/80M models, not a guarantee that
  larger always sounds better. Supertonic Fast/Balanced/High select 5/8/12 steps
  using one shared set of weights. Kokoro and DECtalk expose Standard only.
  Selection persists per model/voice, carries the current level to a new voice
  where available, and is validated before installation or synthesis.
- Model dropdown: `＋` prefix for an unavailable default recipe; adjacent `+`
  downloads **the selected voice and quality**, not the whole voice library.
  Voice/quality prefixes provide the exact profile's status. The button hides
  only when the selected profile is ready. Refresh rechecks pinned model and
  runtime versions. Updates mean a verified recipe change, not an automatic
  upgrade to arbitrary latest packages.
- Absolute output filename, default `mtapi-project/outbox/speech.flac`.
  Format changes adjust its extension. Existing files get a unique suffix.
- Save audio and Speaker are independent. Speaker plays each new result once through the browser; completed-job restoration
  preserves the existing audio element and never restarts playback. Turning
  Speaker changes control autoplay of future results and do not pause current playback.
  autoplay rejection produces an explicit Play instruction. Manual playback is
  always available. Save off produces only a temporary playback file.
- FLAC (default), WAV, MP3, Opus, AAC/M4A. All use the shared FFmpeg exporter.
- Gear: centered native modal dialog, content-sized in both directions, bounded
  only by the visible viewport. Apply commits settings; Cancel/Escape discard.
  Settings persist separately per codec. Channels and sample rate are common;
  depth appears for WAV/FLAC, bitrate for lossy codecs, compression for FLAC.
  Stereo duplicates the currently mono source; it does not create spatial audio.

## Validated model adapters

1. Piper Lessac medium: `piper-tts==1.8.0`, CPU ONNX, US English, source sample
   rate 22,050 Hz. Model/config pinned to Piper voices revision
   `c10ece1aade47bb51c153c893d14e5bf8e5b7117` with SHA-256 and size checks.
   Runtime GPL-3.0; the voice's dataset license is separate—see its model card.
2. Kokoro v1.0: `kokoro-onnx==0.6.1`, standard full-precision CPU ONNX and
   matching `voices-v1.0.bin`, voice `af_heart`, English US. Release
   `model-files-v1.0`; both artifact hashes and sizes are pinned after a real
   button download and runtime/model pairing check. The Chinese v1.1 variant,
   GPU-only conversion and unrelated voice banks are not substituted.

Upstream recipes:
[Piper Python API](https://github.com/OHF-Voice/piper1-gpl/blob/main/docs/API_PYTHON.md),
[Lessac model card](https://huggingface.co/rhasspy/piper-voices/blob/c10ece1aade47bb51c153c893d14e5bf8e5b7117/en/en_US/lessac/medium/MODEL_CARD),
[Kokoro runtime](https://github.com/thewh1teagle/kokoro-onnx),
[Kokoro model files](https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.0).

3. Piper English library: 23 single-speaker voices / 31 checkpoints from the
   same pinned upstream revision. Names include Amy, Ryan, Alan, Alba, Cori,
   Jenny Dioco, LJSpeech, Joe, John, Mike and others. Multi-speaker corpus banks
   are excluded from this selector. Each checkpoint retains its model card.
   Existing Lessac-medium installation and legacy API model ID `piper-lessac`
   remain compatible. Real button installs and speech checks cover Lessac at
   all three levels, Amy medium, Ryan high and UK Alan low. The other published
   checkpoints are available on demand and are not claimed as locally tested.
4. Supertonic 3: `supertonic==1.3.1`, pinned HF revision
   `3cadd1ee6394adea1bd021217a0e650ede09a323`, ~401 MB, four matching ONNX
   components/config/indexer and ten F1–F5/M1–M5 voice styles. Model OpenRAIL-M;
   runtime MIT. Local worker uses explicit model directory, disables implicit
   downloads, limits ONNX threads, flattens mono output and exports at the
   model sample rate. English is selected explicitly; a language selector is
   not yet provided. [Official model](https://huggingface.co/Supertone/supertonic-3),
   [Python runtime](https://pypi.org/project/supertonic/).
5. KittenTTS 0.8: release wheel `kittentts==0.8.1`; Nano/Micro/Mini ONNX profiles
   pinned separately in `app/audio/tts_catalog.json`, ~60/42/82 MB including
   the matching eight-voice bank. Apache-2.0. Uses the pinned runtime's local
   ONNX class directly, so it cannot silently fetch a different HF revision.
   Source rate 24 kHz. All three profiles downloaded via the real button and
   generated speech (Bella Mini, Jasper Micro, Luna Nano). This is the small
   CPU-oriented 0.8 family; the newer, larger Kitten 2 architecture is not
   substituted under the same name. [Official runtime/releases](https://github.com/KittenML/KittenTTS).
6. DECtalk: existing native engine, nine voices, unchanged by this expansion.

Model artifacts are listed in `app/audio/tts_catalog.json`. Large HF LFS
artifacts use upstream SHA-256; small repository files use upstream Git blob
SHA-1 (header + contents), all with exact size checks and pinned commit URLs.
The original Piper/Kokoro recipes retain their existing SHA-256 checks. Receipts
record SHA-256 for every downloaded file plus selected model/voice/quality.

## Model-specific synthesis controls

The compact Synthesis controls section derives entirely from server capability
metadata. Advanced controls wrap horizontally and collapse when not needed;
there is no inner height cap. Only settings usable by the installed model appear.
The quality row hides for engines with only one fixed quality. Controls persist
per model, separately from voice/quality and output encoding. Reset affects only
that model. Blank optional variation/voice-shape values retain the native voice
default; speed values use × (higher is faster). Control edits mark the draft as changed while preserving
current playback. Generation snapshots the live numeric/select/checkbox controls
before awaiting any network request, including changes without an input event.

| Engine | Exposed synthesis controls |
|---|---|
| Piper | Speed (inverse native length scale relative to the selected voice), volume, per-sentence normalization; advanced audio noise and duration noise. |
| Kokoro | Speed, sentence/clause pauses, voice-following or US/UK pronunciation, silence trim, direct phoneme input. Pronunciation hides for phoneme input. |
| Supertonic 3 | Speed, all 31 supported language codes plus unknown-language fallback, chunk silence; custom 1–100 steps (0 follows quality preset), chunk character limit (0 uses language default). |
| KittenTTS | Speed, native text normalization. Voice speed priors remain active. |
| DECtalk | 75–600 words/min, comma/period pause offsets, punctuation policy; optional native pitch/range, assertiveness, breathiness, richness, smoothness, head size, creakiness, lax breathiness, quickness, baseline/phrase/stress pitch changes, pitch tilt, fixed glottal samples, usable cascade/parallel formant controls, sound-source/resonator gains, voice loudness and vocal tract. |

There are no native emotion-preset parameters in these five installed adapters;
variation and DECtalk voice shaping are labelled for what they do. Kokoro
`continuous` exists in the runtime API but requires duration outputs absent from
our pinned standard model: a real browser generation caught this, so it is
excluded and rejected server-side. DECtalk's device volume command has no effect
on WAV output and is excluded. Native sample-level checks exercised every
presented DECtalk voice-shaping field. Six accepted legacy parameters showed no
audio effect in this build (f8, ago, agvo, aguo, chink, oq) and are excluded.
DECtalk's `g5` voice loudness does affect generated samples and remains available.

`app/audio/tts_controls.py` owns the capability schema, strict validation and
DECtalk command serialization. The API and inference worker share this validator.
Unknown controls, wrong types, nonfinite numbers, out-of-range values and
fractional integer settings fail with `ok:false`; incompatible formant pairs
are rejected. Safe argv JSON transports only validated model controls; output
export settings retain their separate contract. Job results include the actual
synthesis controls used.

Control contracts were checked against the installed pinned runtime signatures
and source, [Piper's Python API](https://github.com/OHF-Voice/piper1-gpl/blob/main/docs/API_PYTHON.md),
[Kokoro runtime source](https://github.com/thewh1teagle/kokoro-onnx),
[Supertonic runtime](https://pypi.org/project/supertonic/),
[Kitten runtime](https://github.com/KittenML/KittenTTS), and
[DECtalk Design Voice](https://dectalk.github.io/dectalk/idh_sdk_3_design_voice_dv.htm),
[rate](https://dectalk.github.io/dectalk/idh_ref_1_rate_selection_rate.htm),
[volume/WAV restriction](https://dectalk.github.io/dectalk/idh_ref_1_volume_volume.htm).

`junk/tts-controls/prove.mjs` clicks controls and Generate speech across all five
engines. Actual faster settings shorten decoded speech; Piper quarter-volume
produces a peak near 0.25 after export resampling. Kokoro phonemes, Supertonic
Spanish/custom steps/chunking, Kitten cleanup and DECtalk pitch/pause changes
produce playable audio. It checks edit invalidation, persistence across models
and reload, scoped Reset, live-value snapshots, clean console and 760px layout.
`junk/tts-controls/check_dectalk.py` records native per-field waveform effects.
Desktop/narrow screenshots are inspected. Gate 5/5; 37 TTS/DECbars unit tests,
plus the existing no-repeat/fresh-audio browser regressions.

## Backend and download lifecycle

`app/audio/tts.py`: versioned recipes and status; one TTS job at a time.
`app/routes/tts.py`: `/api/tts/status`, POST `/install`, POST `/generate`,
GET `/job/{token}`, GET/DELETE `/preview/{token}`. Operational errors are HTTP
200 + `ok:false`; job failures show their actual error in the tab.

Downloads stream into a revision-specific `.partial` directory under
`mtapi-project/junk/tts-models/`, report byte progress, reject wrong sizes or
hashes, then use `uv pip --python <project interpreter>` (pip fallback when uv
is absent) to install the pinned inference package. A separate worker loads the
model with its runtime before activation. Only then is a receipt written and the
staged directory renamed into place. Previous artifact directories remain until
a new one passes; failed staging is removed. These compatible ONNX runtime packages share the project
venv; the selected package version is pinned, while compatible dependencies use
package constraints. Failed pip dependency changes are not transactionally rolled
back. Existing numpy/ONNX Runtime versions satisfy the added recipes too. Incompatible
future Torch/Transformers engines must not downgrade the shared environment.
Artifact readiness verifies hashes, cached by file metadata, and runtime version.

Inference runs via `shell.run_command` argv in `tools/tts_worker.py`; no shell
interpolation or subprocess code in `main.py`. The process exits after synthesis,
releasing model memory. No frame dump/encode pipeline is involved in audio-only
synthesis. Progress uses `report_progress()` per artifact/phase.

Preview intermediates live under `junk/tts-preview/`. Source WAV and text are
removed after the operation. Playback copies are removed on Discard, next
synthesis, after one hour, or API restart. Saved files survive preview removal.
Jobs can be reattached by revisiting the tab; only the latest 64 jobs are kept in
memory. Jobs do not survive API restarts and are not part of the global queue.

## Reuse for Stems and Music

`app/audio/export.py` exposes `FORMATS`, `export_args()` and async
`convert_audio(source, destination, format, settings)` with absolute paths,
validated codec-specific settings and explicit no-overwrite checks.
`js/ui/audio-export.js` exports
`openAudioExportDialog(format, capabilities, settings, apply)`; the same module
and CSS can be mounted beside any tab's format selector. Controls derive from
`FORMATS`, so adding a codec extends its own supported fields. Stems and Music
have not yet switched their existing output contracts; their future integration
should call this exporter once per completed source/stem and reuse this dialog.

## Verification

Gate 5/5; 37 combined TTS/DECbars tests pass. `tests/test_tts.py` checks codec rejection, real five-format FFmpeg
conversions, no overwrite, preview cleanup, inference failure cleanup, busy-job
exclusion, readiness and download hash-failure preservation.
`junk/tts-prove.mjs` clicks Neural → TTS, downloads both real models with `+`,
generates/decodes both, applies centered FLAC stereo/24-bit settings, changes
codec fields, generates unsaved MP3, and deletes its playback copy. Additional
browser checks cover speaker playback, dialog cancel/Escape, persisted settings,
returning during a job and responsive workspace containment.

### Playback/voice regression checks

`junk/tts-voice-playback-prove.mjs` generates real DECtalk Paul/Betty and Kokoro
Bella/Heart outputs, verifies selected voice in worker job results and distinct
audio hashes, waits for playback to finish and revisits the tab three times
without another automatic Play call. Historically checked Speaker-off pause (superseded below), all installed
voice options, per-model selections and reload persistence.

## Editable generation and uninterrupted playback

Text, model, voice, quality, format, export settings, save and output-path edits
leave the current player and playback untouched. A compact **Generate & Play**
notice indicates that edits apply to the next generation. Generation snapshots
all live controls before the request; edits during inference remain in the form
as the next draft and never change the submitted job. Empty live text is rejected
without falling back to stored text.

All fields, Reset, Refresh and the export gear remain usable during a job. Only
job-start buttons are disabled to prevent duplicate jobs. Starting synthesis
preserves the old clip; successful replacement stops it and deletes its temporary
preview. Failed requests preserve the existing player. Native Pause and explicit
Discard remain effective. Speaker controls future autoplay only. Completed-job
restoration preserves the existing audio element and never replays a result.

`junk/tts-controls/nonblocking-prove.mjs` clicks real DECtalk and Kokoro generation,
checks editable controls during inference, continuous old-clip playback across
edits and job submission, immutable submitted voice/speed, preservation of the
next draft, replacement audio, Pause, Generate & Play and tab restoration. Zero
browser errors; screenshot inspected. This supersedes the edit-removal and
Speaker-off-pause assertions in the earlier fresh-result/voice proof scripts.

### Expanded model / quality proof

`junk/tts-models-prove.mjs` uses real selects and `+` / Generate speech clicks,
checks posted voice/quality, successful job revision, nonempty audio and browser
playable duration, and records differing audio hashes. It covers Piper Lessac
low/medium/high plus Amy/Ryan/Alan; Kitten Mini/Micro/Nano; Supertonic steps and
voices and selection persistence. Quality edits now preserve playback as described above.
Screenshots are inspected, including compact selectors with text clear of arrows.
The current nonblocking browser proof covers playback and fresh requests. Unit tests additionally cover exact variant routing, unavailable levels,
selected-checkpoint readiness, config corruption and scoped update indicators.

## Input, playback and current-clip cards

Compact full-width responsive workspace: input and playback cards on the left,
current-clip information on the right. At narrower viewport widths the cards
stack. Cards have no height cap or nested scrolling area. The read-only playback
script expands to its content; the editable input remains resizable.

Current clip displays the completed job’s model, voice, quality, revision, format,
filename, save status, full script, every validated synthesis setting and effective
codec settings (including defaults). This metadata comes from the job result,
never from the changing draft. Editing inputs preserves it and current audio;
replacement updates both together. Discard clears the metadata. Tab restoration
recovers the same job metadata and reuses its audio element.

Verification: gate 5/5, 33 TTS tests. `junk/tts-controls/cards-prove.mjs`
clicks real DECtalk Betty generation with stereo/24-bit FLAC, checks metadata
and unchanged script/settings/playback while switching the draft to Piper,
restores the tab and verifies wide side-by-side/narrow stacked containment.
Zero browser errors; both screenshots inspected.

## Generate a highlighted passage

Generate speech and Generate & Play use the selected range in the speech input
textarea when its selection is nonempty. With no selection they use the entire
live textarea. Whitespace-only selections fail normal empty-text validation;
they do not fall back to the full script. The full draft remains intact in the
textarea and saved preferences, while the completed clip’s Playback script
shows only the submitted passage. Selection is snapshotted before network awaits.

`junk/tts-controls/selection-prove.mjs` selects with actual keyboard input and
clicks both Generate actions: real DECtalk output, exact selected request/script,
full-text fallback, draft persistence and tab restoration, zero browser errors.
Gate 5/5 and screenshot inspected.

## Shared hot-model mode and timing

The top-right shared toggle now retains the last Piper/Kokoro/Supertonic/Kitten
checkpoint in an isolated worker, avoiding repeated model loads. Off retains
one-shot behavior; changes during a job defer release until completion and do
not interrupt playback. DECtalk remains a native command. The bottom-left box
shows phase, elapsed time, words and a learned estimate based on observed load,
inference and export timings. See [shared as-built](model-hot-status-spec.md).
