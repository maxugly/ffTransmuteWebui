# Sequence Conform and Copy Stitch Spec — v1.0

> **Status:** Shipped (`8.068`, 2026-09-15) — implemented as specified; see STATUS top box.
> **Scope:** Pool Sequence / Stitch only. Cut, Single-Clip Ops, and the global
> Video/Image pool semantics are unchanged.
> **Related:** `sequence_rife_interpolation_spec.md`,
> `sequence_codec_export_spec_2.0.md`, `sequence_clip_variant_registry_spec.md`,
> `file-to-file-transcode-spec.md`, `workspace-progress-spec.md`.

## 1. Goal

Add an opt-in Sequence **Conform** path that normalizes each active clip before
stitching. When every normalized clip is stream-compatible, Stitch may use the
ffmpeg concat demuxer with `-c copy`. When any condition is unsafe, Stitch must
fall back automatically to the existing filtered file-to-file re-encode path.

Conform is a cache-fill operation. It must never alter, replace, or delete the
original source. New conformed clips are written beside their originals and are
registered as separate `conformed` variants.

The feature is an optimization and cache, not a new frame-processing platform.
Geometry and timing conforming use direct file-to-file ffmpeg filters. RIFE
continues to use the existing dump → `app/filters/rife.py` → encode pipeline.

## 2. Resolved product decisions

| Decision | Resolution |
|---|---|
| Conform scope | Stitch/Sequence only. Cut never consumes or creates conformed Sequence variants. |
| Conform default | OFF, preserving current Stitch behavior. |
| Automatic conform | When enabled, follows Instant RIFE/AutoRIFE arming, queue, restore, and new-clip behavior. |
| Project restore | Opening/restoring a project performs no conform work and no media reads solely because Conform is enabled. The feature remains disarmed until an existing AutoRIFE arming event occurs. |
| New clips | A newly added Sequence clip is eligible for the same armed queue scan as AutoRIFE. The original remains in the Sequence and pool; the conformed file is a sibling variant. |
| Storage | Conformed files are written beside their source originals with collision-safe, signature-bearing names. |
| Stale files | Keep stale files; mark them invalid and ignore them until regenerated. Deletion/GC is a later feature. |
| Copy mode | Strict optimization only. Any uncertain or unsupported condition falls back to re-encode. |
| Copy output | The requested output preset must equal the conform preset. Otherwise re-encode. |
| Audio smoothing | Copy is not allowed when rubberband, fades, mixing, volume processing, or generated silence is still required at Stitch time. Such processing must be baked into conform or use fallback. |
| RIFE ordering | RIFE first on native pixels; geometry, timing, and audio conform afterward. |
| RIFE automation | Auto-conform may follow a completed AutoRIFE item, using the same bounded queue and explicit armed gate. |

## 3. Non-negotiable invariants

1. Neural/frame operations remain dump → `app/filters/*` → encode, with
   `frame_%06d.png` beginning at frame `0`.
2. Conform itself is non-neural direct ffmpeg file-to-file processing; it must
   not invent a second dump/encode stack.
3. All subprocesses use `shell.run_command` with argv lists. No `shell=True`.
4. All I/O paths are absolute. `transmute` and `bin/transmute` remain in parity.
5. Default geometry preserves pixels with crop or letterbox. Stretch is explicit.
6. Video `items[]` and Image `images[]` remain separate. Conform is Video
   Sequence-only.
7. A named project save persists both pools and Sequence conformed paths;
   session autosave does not overwrite a named project by itself.
8. Every item reports progress. Directory writers use `start_dir_watch`.
9. RIFE multiplier remains `2..128`.
10. Operation failures remain HTTP 200 with `{"ok": false}`.
11. `main.py` receives no subprocess implementation and no
    `from __future__ import annotations`.
12. Completion requires Playwright proof using real controls; curl is not UI proof.

## 4. User-facing controls

Add a Sequence-local Conform block:

- **Conform:** Off / On; default Off.
- **Conform mode:** Pad, Crop, Stretch; default follows current Sequence
  reconcile mode and is persisted.
- **Conform aspect:** current Sequence aspect selector, including custom aspect.
- **Conform preset:** initial allow-list below; default `h264_avc_hq`.
- **Target FPS:** Auto or explicit positive FPS.
- **Auto-conform after RIFE:** On when Conform is enabled, following AutoRIFE’s
  armed behavior; no independent load-time scan.

The Stitch control must expose the expected path:

- `Stitch (copy)` when the current local state predicts a valid copy path.
- `Stitch (re-encode)` otherwise.
- `Conforming…` while missing/stale conform files are being generated.

The backend is authoritative. The UI prediction must never prevent fallback.

## 5. Preset allow-list

Add an explicit `CONFORM_PRESETS` registry in `app/convert_presets.py`.

Initial allow-list:

```text
h264_avc_hq
h265_hevc
dnxhr_hq
prores_hq
```

The default is `h264_avc_hq`.

Initially exclude WebM/VP9, AV1, FFV1, and proxy presets. They may be added only
after codec-specific probe and concat-copy tests prove stable stream metadata.

The selected conform preset controls codec, pixel format, audio codec, container,
profile, tag, and container-specific flags through the existing
`EncodePreset`. Join must not fork codec recipes or hardcode libx264.

## 6. Conform identity and variant record

Every conform result has a complete signature. At minimum:

```json
{
  "kind": "conformed",
  "parent_path": "/absolute/source.mp4",
  "variant_path": "/absolute/source_conformed_pad_1920x1080_h264_avc_hq_<sig>.mp4",
  "source_size": 123456,
  "source_mtime": 123.45,
  "source_variant": "original",
  "mode": "pad",
  "aspect": "16:9",
  "width": 1920,
  "height": 1080,
  "target_fps": 24,
  "time_factor": 1.0,
  "preset": "h264_avc_hq",
  "audio_policy": "encoded",
  "rife_multiplier": null
}
```

The source identity must include the selected source variant. A RIFE-derived
input and the original input are different conform parents.

A cached conform is valid only when every signature field matches current
Sequence state and the output exists and is non-empty. Changing mode, aspect,
canvas, target FPS, duration, RIFE source/multiplier, audio policy, or preset
invalidates it.

`sequence[]` entries persist:

```js
{
  path,
  variantPath,
  conformedPath,
  conformSignature,
  conformStatus
}
```

`conformedPath` is not a replacement for `path` or `variantPath`.

## 7. Timing and audio contract

Conform bakes timing when needed so copy can remain possible:

- Native duration: no `setpts` or rubberband.
- Requested duration: video `setpts` and audio tempo processing are both baked.
- Target FPS: `fps` is applied during conform when explicitly required.
- Audio filters, fades, volume changes, silence generation, and mixing are
  either baked into the conform file or force Stitch re-encode.

If `abs(time_factor - 1.0) < 1e-3`, omit rubberband.

Audio is encoded in the same ffmpeg operation as the conform video. RIFE must
not encode a video-only intermediate and then encode the video again merely to
mux audio.

Copy is rejected when the current Sequence still requires an audio operation
that is not represented in the conformed file.

## 8. RIFE + conform ordering

For a clip requiring RIFE:

```text
source or selected DNxHR source
→ dump to frame_%06d.png, start 0
→ app/filters/rife.py, multiplier 2..128
→ one encode using conform preset
→ geometry/timing filters
→ audio encoded/muxed in the same operation
→ register conformed variant on the original parent
```

Padding or cropping before RIFE is prohibited because artificial borders can
be interpolated into visible smearing.

The RIFE multiplier is selected from the existing density rules. The conform
signature records it so changing the target FPS invalidates the conformed file.

## 9. Strict concat-copy gate

Add to `app/video_pipeline.py`:

```python
def can_concat_copy(
    infos: list[dict[str, Any]],
    *,
    preset_id: str,
    conform_signatures: list[dict[str, Any]],
    audio_policy: str,
) -> tuple[bool, str]:
    """Return (True, reason) or (False, precise reason)."""
```

All clips must match the first clip on:

### Video

- codec name and codec tag
- profile and level
- width and height
- pixel format
- sample aspect ratio
- field order
- `r_frame_rate` and `avg_frame_rate`
- time base
- color range, space, transfer, primaries, and chroma location
- codec extradata/configuration
- rotation/display matrix
- relevant stream disposition and timecode metadata

### Audio

- audio presence
- codec name and codec tag
- sample rate
- channel count and channel layout
- sample format
- time base
- codec extradata/configuration
- relevant disposition and start/edit-list metadata

### Sequence policy

Reject copy for missing/stale conformed files, signature mismatch, unequal
preset identity, unbaked durations, unsupported cuts, VFR uncertainty,
unbaked audio processing, or unsupported container/codec combinations.

The reason must identify the first failing clip and field, for example:

```text
audio channel layout mismatch at clip 17: stereo != 5.1
```

False negatives are acceptable. False positives are not.

## 10. Backend files and responsibilities

### `app/convert_presets.py`

- Add explicit `CONFORM_PRESETS`.
- Keep `ENCODE_PRESETS` as the sole codec recipe registry.

### `app/video_pipeline.py`

- Extend `probe()` with copy-gate metadata.
- Add `can_concat_copy()`.
- Add direct file-to-file `conform_clip()`.
- Parameterize `_run_concat_single()` by output preset.
- Add concat-demuxer copy execution using an absolute escaped list file.
- Extend shared `encode()` only as needed for one-pass RIFE/conform audio.

### `app/operations/conform_ops.py`

- Add validated `ConformParams`.
- Resolve absolute input/source variant.
- Compute canvas and time factor using shared pipeline helpers.
- Run conform with job cancellation/progress.
- Register `kind="conformed"`.
- Return HTTP-200-compatible `OperationResult` failures.

### `app/operations/transmute_ops.py`

- Add conform fields to `JoinParams`.
- Resolve RIFE/original input before conform.
- Generate missing/stale conforms when enabled.
- Call `can_concat_copy()`.
- Run copy or preset-driven filtered re-encode.
- Never introduce an additional lossy chunk re-encode in the copy path.

### `app/media/cache.py`

- Persist conformed variants.
- Include `conformedPath` in referenced media collection.
- Normalize all variant paths absolutely.

### `app/static/js/pool/persistence.js`

- Persist conform settings and entry metadata.
- Send conform fields in `/ops/join`.
- Preserve synchronous click feedback before awaits.

### `app/static/js/pool/sequence-composer.js`

- Add valid/stale/pending conform badges.
- Keep source, RIFE, and conformed variants visibly distinct.

### `app/static/js/pool/sequence-variants.js`

- Maintain conformed records in the shared variant map.
- Never treat a conformed file as a RIFE replacement.

### `app/static/js/pool/sequence-rife.js`

- Share AutoRIFE’s armed gate, queue semantics, restore behavior, and new-clip
  triggers.
- Auto-conform a completed RIFE item only when Conform is enabled.
- Do not scan or conform the whole project on open.

### `app/static/js/job-control.js`

- Render `conform`, `stitch copy`, and `stitch re-encode` phases.
- Preserve Stop/cancel behavior.

## 11. Progress contract

Required messages:

```text
probe 0/N clips
probe K/N clips
rife probe K/N
rife K/N <basename>
conform 0/N
conform K/N <basename>
checking concat compatibility
stitch copy 0/N clips
stitch copy N/N clips
stitch re-encode 0/N clips
stitch re-encode chunk K/M
stitch re-encode N/N clips
```

Every conform item reports progress. Directory RIFE output uses
`start_dir_watch`. Phase changes reset progress timing as required by the
workspace-progress contract.

## 12. Fallback and output contract

The join result includes:

```json
{
  "ok": true,
  "output_path": "/absolute/output.mp4",
  "stitch_mode": "copy",
  "copy_reason": "all streams match",
  "conformed": 12,
  "reencoded": false
}
```

Fallback returns success if re-encode succeeds:

```json
{
  "ok": true,
  "stitch_mode": "re-encode",
  "copy_reason": "video time_base mismatch at clip 4",
  "reencoded": true
}
```

Copy failure after the gate passes must be retried once through the filtered
re-encode path, with the copy error retained as the fallback reason. Do not
silently return a partial output.

## 13. Tests

### `tests/test_encode.py`

- pad, crop, and stretch dimensions
- `setsar=1`
- target FPS
- duration/time-factor behavior
- rubberband omitted at factor 1
- preset codec/audio arguments
- one-pass RIFE/conform encode; no second video encode
- audio codec selection for AAC and PCM presets
- conform registration and complete signature

### `tests/test_join_comma.py`

- comma-containing paths remain intact
- identical streams select concat copy
- codec, tag, time-base, SAR, color, pixel-format, and audio mismatches fall
  back with precise reasons
- missing audio versus present audio falls back
- unbaked duration falls back
- requested target preset is used by fallback, not hardcoded libx264
- absolute escaped concat list
- output extension follows preset

### New `tests/test_concat_copy_gate.py`

Unit-test `can_concat_copy()` using synthetic probe dictionaries for every gate
field and every policy rejection.

### New `tests/test_conform_ops.py`

- preset allow-list
- invalid mode/aspect/FPS/duration
- relative and missing paths
- HTTP 200 with `ok:false`
- variant registration
- stale signature rejection
- original and RIFE source-variant distinction

### Playwright acceptance

Use real controls to prove:

1. Conform defaults Off and current Stitch behavior remains unchanged.
2. Enabling Conform exposes mode/aspect/preset controls.
3. Adding a new clip while AutoRIFE/Conform is armed queues the original once,
   creates a sibling conformed file, and leaves the original Sequence entry.
4. Reload/project open performs no conform storm and leaves the feature
   disarmed, matching AutoRIFE.
5. A fully compatible sequence displays and executes `Stitch (copy)`.
6. A duration change invalidates the badge and executes `Stitch (re-encode)` or
   regenerates conform first.
7. A deliberately incompatible audio/video stream falls back with a visible
   reason and succeeds.
8. Stop cancels RIFE, conform, and stitch jobs.
9. Named-project save/load preserves both original paths and conformed paths.
10. No new console errors or hidden per-clip request storm appears.

## 14. Performance expectations

Cached conform plus copy is expected to be fast on SSD, but no universal
sub-five-second promise is made. First-time conform may take minutes for a large
Sequence, especially with RIFE. The UI must distinguish cache preparation from
the final copy stitch.

The feature is successful when it provides a safe copy fast path without making
the ordinary one-off Stitch slower or changing its output semantics.

## 15. Deferred work

- Managed central conform cache instead of beside-source files.
- Automatic stale-file garbage collection.
- Smart-rendering of arbitrary non-keyframe cuts.
- WebM/AV1/FFV1 conform support.
- Crossfades or boundary-fade preservation in copy mode.
- Guaranteed benchmark targets across HDD/NVMe and heterogeneous codecs.
