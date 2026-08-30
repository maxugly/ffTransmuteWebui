# Spec — Images in the Sequencer

> **Status**: Candidate (design agreed in chat; not shipped).
> **Owner**: Spec writer.
> **Build target**: one confirming build pass, then ship (bump `VERSION`, STATUS top box).

## 1. Goal

Let the Sequencer (Sequence panel in the Pool tab) build and stitch a mix of
**videos and still images**. Per-clip **duration** is simple: enter either
**time (seconds)** or **number of frames**. Each clip's send dropdown gets a
**Sequence** target. Two toggles on the sequencer control whether video and/or
image cards are shown in the pool grids, so one, neither, or both can show up
as available.

Non-goal: no zoom/pan on stills, no crossfades, no audio from images, no
Ken Burns, no second dump/encode stack.

## 2. Agreed decisions (from chat)

| # | Question | Decision |
|---|----------|----------|
| D1 | Toggle semantics | **Filter pool grids only.** The toggles hide the cards of the off kind in the pool grid. Drop/send handlers stay unchanged (you cannot click what is not shown). |
| D2 | Image with no duration | **Default 4s** shown on the token, editable via the same control. |
| D3 | Frames→seconds conversion | Use **effective sequence output fps** (RIFE target fps if set, else max native fps in the sequence, else 30). Store frames raw so the value round-trips across reloads; the chip/label shows computed seconds. |
| D4 | RIFE + image tokens | Stills are **never RIFE-densified**. Image tokens show an **IMG badge**, no ORIG/VARIANT button, no duration-stretch colors. |

## 3. Current state (explored)

- Video cards already reach the sequence twice:
  - right-click context menu `Add to sequence` → `chrome.js:199` (`data-act="sequence"`),
  - "Send to ▾" dropdown `Sequence` → `grid.js:1144` (`data-send="sequence"`),
  - both funnel into `sendPoolPathTo(path, 'sequence')` → `addPathToSequence(path)` (`items.js:352`).
- Image cards only have a "Send to ▾" dropdown (`image-pool.js:871` `_showImageSendMenu`,
  items at `image-pool.js:876–891`) → `sendImagePathTo(path, target)` (`image-pool.js:394`);
  **it has no Sequence option today**.
- Sequence entry shape (`sequence.js:1430` `addPathToSequence`): `{id, path, name,
  targetDuration(seconds|null), _hadTarget, variantPath, _rifeStatus}`.
  Gate at `sequence.js:1431`: `if (!path || !isVideoPath(path)) return;`
- Drop zone `setupSequenceDropZone` (`sequence.js:1371`) also gates on `isVideoPath`
  (`sequence.js:1424`).
- Per-clip duration UI today: single seconds input `seqClipDuration` (`grid.js:678`),
  handled by `onSeqClipDurationChange` (`sequence.js:1925`), "Native" clear button
  (`btnSeqClipDurClear`, `grid.js:603`). No frames concept.
- Persistence: sequence serialized at `persistence.js:285` (fields `path, name,
  target_duration, _had_target, variant_path, rife_multiplier, variant_hash,
  rife_need`); hydrated at `persistence.js:372`. No `kind` field.
- Backend: GUI stitch → `/ops/join` (`transmute_ops.py:500`) → `durations` per clip
  (seconds, `null` = native) → `concat_clips` (`video_pipeline.py:799`) full
  filter-graph concat. Bash parity path: `transmute -j` (root `transmute` `:396–540`,
  `:461` area) with `-T` time factors.
- Shared Python image set: `IMAGE_EXTS` in `app/convert_presets.py:248`.
- Frontend image set: `IMAGE_EXTS` in `app/static/js/pool/constants.js`;
  `isImagePath()` exported from `utils.js:9`.
- `findPoolItem` only searches videos (`sequence.js:25`); image metadata lives in
  the image pool (`state.imagePool.items`, `loadImageItemMeta`).

## 4. Behavior spec

### 4.1 Sequence accepts images

- `addPathToSequence(path)` accepts video **or** image paths. Detection:
  `isImagePath(path)` (`utils.js:9`). Entry gets a new `kind: 'video' | 'image'`
  field (persisted as `kind`).
- Image entries are created with:
  - `kind: 'image'`
  - `targetDuration: 4` (default per D2; `null`? No — images always carry explicit
    duration), `_hadTarget: true`
  - `variantPath: null`, `_rifeStatus: 'skipped'` (D4)
- Drop zone: images drop into the sequence and insert at position (D1 means we
  don't block, but the gate must no longer exclude images).
- `findPoolItem`-style lookups: image entries do **not** resolve native duration
  (no `meta.duration`); `seqEntryPlayDuration` (`sequence.js:30`) must treat image
  entries by `targetDuration` only (already does, since native is `undefined`).
  Guard `findPoolItem` already returns `null` safely (`sequence.js:25`).

### 4.2 Send dropdown gets Sequence for clips

- **Image cards** (`image-pool.js:876–891`): add
  `<button type="button" data-t="sequence">Sequence</button>`.
- `sendImagePathTo` (`image-pool.js:394`): add a `sequence` branch →
  `addPathToSequence(path)` (dynamic import of `pool/sequence.js` — same pattern
  as other `import('/js/pool/...')` branches in the file).
- **Video cards**: already covered (context menu + send dropdown). No change.
- Invariant 5 (dual pools): pools stay separate; only the *sequence ingest* is shared.

### 4.3 Sequencer toggles — Videos / Images

- Two toggles in the Sequence panel header (next to the `Sequence` title,
  `grid.js:641`), persisted in pool state:
  - `state.pool.showVideos` (default `true`)
  - `state.pool.showImages` (default `true`)
  - serialized as `show_videos` / `show_images` (`persistence.js` around `:285`).
- Effect (D1 — filter pool grids only):
  - `showVideos === false` → video pool grid `poolGrid` hides video cards
    (`renderPoolGrid`, `grid.js:1225` treats it as an empty result with an
    informational empty-state message).
  - `showImages === false` → image pool grid hides image cards (`renderImagePoolGrid`,
    `image-pool.js`).
  - Both off → both grids show their empty/info state. Nothing else changes:
    drag-drop, context menu, send dropdowns still accept a hidden clip if the
    user somehow invokes them (D1).
- Toolbar counts (`refreshPoolToolbarCounts`) reflect the filtered grids.

### 4.4 Duration — time or frames

Replace the single "Time (s)" input with a compact control on the selected-clip
settings (`seqClipSettings`, `grid.js:674`):

- **Unit selector** (`Time` / `Frames`) + **value input** (`seqClipDuration` kept,
  repurposed; label follows the unit).
- **Time mode** (seconds): behaves exactly like today; `targetDuration` = seconds.
- **Frames mode**: user enters integer frames. Conversion to seconds happens with
  the **effective sequence output fps** (D3):
  `state.pool.targetFps` if set, else max native fps across current video
  entries in the sequence, else `30`.
- Entry storage: keep `targetDuration` (seconds) as the canonical field **plus**
  `durationMode: 'time' | 'frames'` and, when frames, a raw `durationFrames`
  integer (persisted as `duration_mode` / `duration_frames`) so reload shows the
  same control state (D3). Changing the unit re-converts and clears the other field.
- "Native" clear button only makes sense for videos (back to `targetDuration:
  null`). For images it resets to the 4s default (D2).
- Labels: token and total-time readouts use the seconds (`seqEntryPlayDuration`),
  so frames-resolved times display correctly. Token tooltip may show `N frames`
  when `durationMode === 'frames'`.
- Validation: positive number; frames must be positive integers.

## 5. Backend spec

### 5.1 `/ops/join` must accept image inputs

GUI stitch always calls `/ops/join` (`transmute_ops.py:500`). Images are valid
inputs now. The join handlers (`join`, `_join_with_preset`, and `_run_transmute`
bash fallback) are backend-only changes:

- **Pre-process stills before concat** (mirrors the RIFE preprocess pattern —
  no new dump/encode stack):
  - for each input `p` where `Path(p).suffix.lower() in IMAGE_EXTS`
    (`convert_presets.py:248`), synthesize a still clip in the job workspace:
    `ffmpeg -loop 1 -i p -t <dur> -r <fps> -c:v libx264 -pix_fmt yuv420p <still.mp4>`
    (near-lossless intermediate, consistent with `concat_clips` `:870`).
  - `dur` = the `durations[i]` value (frontend always sends one for images; D2
    default 4). If the frontend somehow sends `null`, use 4s as a safety default.
  - `fps` = `p.target_fps` or the max native fps of the video inputs, else 30 (D3 parity).
- `concat_clips` (`video_pipeline.py:799`) already consumes plain `-i` files and
  probes width/height/duration; a synthesized still.mp4 flows through the existing
  pad/crop/stretch reconcile unchanged. No audio fragments for stills.
- `durations` validation: URL/FS safety as usual (`check_path`), count aligned to
  `input_paths` (+ fill or truncate like bash `-T`).
- `recoverSequenceVariants`/RIFE paths (`_rife_preprocess`, `transmute_ops.py:512`)
  skip image entries (D4: no fps to interpolate).

### 5.2 Bash parity (`transmute -j`)

`bin/transmute` and root `transmute` join mode canonicalize inputs into an INPUTS
list and probe width/height/duration per file (root `transmute`:396–430). Images
have no duration stream. Parity rule:

- When an INPUTS member has an image extension, emit a looped-still temp clip the
  same way (`ffmpeg -loop 1 -t DUR -r FPS -c:v ...`) before the per-clip probe,
  so the existing canvas/factor math still sees a real clip. `-T` already handles
  per-clip durations (empty field = native → but images have no native, so use
  the `-T` value or default 4s).
- Keep `bin/transmute` and root `transmute` identical for this behavior.

## 6. Persistence spec

- Serialize per sequence entry (`persistence.js:285`): add `kind`,
  `duration_mode`, `duration_frames`. `target_duration` already exists.
- Hydrate (`persistence.js:372`): read the new fields; default `kind: 'video'`,
  `duration_mode` from `duration_frames != null ? 'frames' : 'time'` for
  backward compat (old saves have neither — treat as video/time as today).
- Old saves without `kind` load as videos; sequences keep stitching unchanged.

## 7. RIFE / densify interplay (D4)

- Images: `_maybeAutoRifeEntry` (`sequence.js:1081`) returns early for
  `entry.kind === 'image'`.
- `ensureSequenceMetaAndInstantScan` (`sequence.js:1110`) probes only video
  entries (skip images for fps/duration).
- Image tokens render an **IMG badge**; the ORIG/VARIANT button
  (`seq-token-var`, `sequence.js:1607`) and RIFE host
  (`seq-token-rife-host`, `sequence.js:1608`) are hidden in the token for images.
- `seqClipSpeedInfo` (`sequence.js:2036`): image entries skip stretch coloring
  (no native → target is the plain duration).

## 8. UI/UX specifics

- Toggles in the Sequence panel head (`grid.js:641`): compact checkboxes or a
  segmented "Videos · Images" switch. Placeholders reflect state; tooltips say
  "Show video clips in pool" / "Show images in pool".
- Empty-state text (`sequence.js:1547`): "Drop **videos or images** here to build
  a stitch sequence…". Filtered-out grid message: e.g. "Videos hidden (toggle on
  the sequencer)".
- Image token: `<span class="seq-token-img-badge">IMG</span>`, no var button,
  duration label uses resolved seconds.
- Duration control (`grid.js:674–682`): unit select + value input + Native/Reset.
  For images the label reads "Duration"; for videos it continues to read "Time (s) / Frames".

## 9. Files touched (build estimate)

Frontend:
- `app/static/js/pool/sequence.js` — gate, `kind`, duration mode, token render, RIFE skips, drop zone, img-badge CSS hook.
- `app/static/js/pool/items.js` — none (sendPoolPathTo already routes to sequence).
- `app/static/js/pool/image-pool.js` — menu item + `sendImagePathTo` branch.
- `app/static/js/pool/grid.js` — toggles in panel head, duration UI, filtered grid rendering, empty states.
- `app/static/js/pool/persistence.js` — serialize/hydrate new fields.
- `app/static/js/pool/constants.js` / css — badge/toggle styles.
- Tests: `mtapi-project/tests/` Playwright pool spec additions.

Backend:
- `app/operations/transmute_ops.py` — join still-preprocess, durations handling, rife skip.
- `app/video_pipeline.py` — optional helper for still-clip synthesis (or inline in ops).
- `transmute` and `bin/transmute` — image→still before probe in join mode.
- Tests: `tests/test_transmute.py` / join API tests for video+image mix.

## 10. Test plan

1. Playwright: add video + image to sequence via Send→Sequence on an image card;
   token shows IMG badge, no ORIG button; both cards present.
2. Frames mode: set 30 frames @ 30fps → token shows 1.0s; reload session → control
   still shows "30 frames".
3. Toggles: Images off → image grid empty w/ info message; Videos off → video grid
   empty; both off → both empty. Video dropdown/ctx entries still present (D1).
4. Stitch: `v + img + v` with img at 4s → output duration ≈ sum. `-T`/join honors
   image duration; still survives reload.
5. RIFE on + images in sequence → images stay `skipped`, only videos densify.
6. Curveball: image-only sequence (2 images) stitches without RIFE/video inputs.
7. Bash: `transmute -j pad img.png vid.mp4 -T 4,` produces same canvas/durations.

## 11. Open risks

- Frame→seconds drift if fps changes between set and stitch: mitigated by storing
  both resolved seconds and raw frames (rule: resolved `targetDuration` is what
  the stitch uses; frames is display/re-entry only).
- Backward-compat saves: old entries default to videos (no `kind`) — safe.
- Image in a sequence that is then moved between projects: image path rules stay
  identical to video path rules (absolute I/O, invariant 3).