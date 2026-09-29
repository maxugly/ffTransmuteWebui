# Frame Peek (Global Frame Range Picker)

> **Status:** Implemented
> **Category:** Frontend / Operation
> **Supersedes:** the original "Frame Scrubber" design in this file. See §0.

## 0. What changed and why

The original spec here described a **hover popup below the picker**, gated behind
a mandatory `[+]` extraction, serving 120px stills. Shipped as written it could
not work:

- The popup was only shown on `mouseenter` of a thumb, so stepper clicks, the
  blue-window drag and keyboard nudges never showed it.
- `POST /media/frame-strip` hard-refused clips over **500 frames**
  (`FRAME_LIMIT`), which is most real media — so the whole feature was dead on
  exactly the clips that need it.
- Strip invalidation was bound to `#giVideo`, deleted by the unified Media In
  bar in `8.098`, so the strip never reset when the clip changed.
- The `#giTimelineRange` window drag writes `.value` + `sync()` without
  dispatching `input`, so any `input`-driven still was blind during that drag.
- 120px stills stretched over a full-size preview panel looked soft.

**The new contract: the media preview seeks, exactly like a video player.**
`/api/video` is a Starlette `FileResponse` (honours `Range` → 206), so
`video.currentTime = (frame - 1) / fps` is ordinary scrubbing: no ffmpeg, no
server work, and it is the video's own resolution. Extraction is now a fallback
and an accelerator, never a gate.

## 1. Overview

Drag, step, or type the In / Out point of the global frame range and the media
preview shows that exact frame. The setting `globalFramePeek` (default **on**)
gates the whole behaviour; `framePeekSize` picks the resolution of any *stills*
that have to be extracted.

## 2. Trigger surface

One event covers every path that moves a set-point: `mtapi:frame-range`, fired
synchronously from `sync()` in `js/timeline.js`. It therefore covers thumb
input, the blue-window drag, the `[‹][›]` steppers (including hold-repeat) and
text commit.

The peek is **armed** by any `pointerdown` inside `#giFramesRow`, or by
`focusin` / `keydown` on a control in it, and **disarmed** on `pointerup`,
`pointercancel`, `blur`, or 1.2s of keyboard/stepper idle. A held pointer keeps
it open regardless of elapsed time — a press focuses the control, which arms the
idle grace, and a slow drag must not outlive it.

## 3. Frame source resolution (first match wins)

| # | Source | Condition | Cost |
|---|---|---|---|
| 1 | **Player seek** | `#mediaViewer video` exists **and** `#mediaPath` equals the active clip **and** it is not `state.pool.playback.video` | free |
| 2 | **Auto-load, then seek** | the panel holds no media (`video, img, audio` absent) | one `FileResponse` |
| 3 | **Strip still** | `[+]` extracted this clip at the current size and the frame index is in range | 0 (cached) |
| 4 | **Frame extract** | fallback | one cheap `-ss` + `-frames:v 1`, disk-cached |
| 5 | Nothing | no clip, or non-video media | no-op |

- **Never fight the sequence transport.** Pausing `state.pool.playback.video`
  fires its `onpause` handler and desyncs auto-advance, so it is excluded and
  the peek falls through to a still.
- **Never scrub the wrong file.** The preview is overwritten by pool cards,
  phash matches and op results, so `#mediaPath` must match the clip being
  trimmed or the peek falls through to a still.
- **Never clobber a running job.** Auto-load is refused while `state.previewLive`
  is on or a job token is active.
- `img.src` is assigned once per URL and **never cleared** (invariant 6).
- On release the player path **stays seeked and paused** — the frame you just
  set remains on screen to judge. The still overlay is a stand-in for that
  video, so it hides when you let go.

## 4. Frame maths

`/api/probe` returns both `fps` (the container's **nominal** `r_frame_rate`) and
`fps_avg` (the real average from frame timestamps). The nominal rate is what
every op uses, but it lies on VFR and badly tagged files — a 577-frame clip
tagged `r_frame_rate=60` that actually plays at 24.02 — and a seek computed from
it lands the frame 2.5× away. So the peek prefers `fps_avg` when the two differ
by more than 1%, then `frames / duration`, then `fps`, then 24.

`frameToSeconds()` uses `n0 = n - 1; t = n0 / fps`, the same formula as
`app/media/thumbnails.py`, so a seek and an extracted still of one frame agree.

## 5. Settings

Both live in the **Performance / "Pool & cache"** card, beside Thumbnail size and
Mute videos.

| Key | Wire | Default | Meaning |
|---|---|---|---|
| `globalFramePeek` | `global_frame_peek` | `true` | Master switch. Off = the frame range behaves exactly as before. |
| `framePeekSize` | `frame_peek_size` | `"M"` | Still width: Quarter `L`=120, Half `M`=240, Full `H`=480. Reuses `THUMBNAIL_SIZES`; also sizes the optional `[+]` strip. |

Both are plumbed through all four layers (`app.js` seed + `SETTINGS_DEFAULTS` +
`mapServerSettings`; `js/tabs/settings.js` `settingsSnapshot` + POST body;
`app/media/performance.py` `DEFAULT_SETTINGS` + `_normalize_settings`, which is an
**allow-list that silently drops unknown keys**). An unknown size token falls
back to `M`, not the global `H` default.

## 6. Backend

- `POST /media/frame-strip` takes `s` (`L|M|H`, default `L`) and scales with
  `THUMBNAIL_SIZES`. It is **one** ffmpeg run for the whole strip, not per frame.
- Strip filenames are `frame_%06d_<size>.jpg` so one cache dir holds every class.
- `GET /media/frame-strip/{hash}/{filename:path}` MUST reject paths that escape
  the strip directory.
- The 500-frame limit stays (disk safety) but is no longer load-bearing: the
  error now says the player preview still scrubs the full clip.

## 7. Files

- **NEW** `app/static/js/media-urls.js` — the 1-based-frame and size-class
  conventions, in one place.
- `app/static/js/frame-peek.js` (was `frame-scrubber.js`) — arm/disarm, source
  resolution, `[+]` strip.
- `app/static/index.html` — `#scrubPopupCap` caption, `[+]` help text.
- `app/static/css/layout.css` — `.scrub-popup-cap`.
- `app/static/js/tabs/{cut,erase}.js` — frame URL builders delegate to
  `media-urls.js` and pass the peek size.
- `app/static/js/tabs/settings.js` — the two controls.
- `app/routes/media.py`, `app/media/{config,performance}.py`, `app/probe.py`,
  `app/main.py`.
- `tests/test_frame_peek_settings.py`.

## 8. Acceptance criteria

- **AC-1** Given a clip of any length, when the In thumb is dragged, then the
  media preview shows that frame, paused, and no ffmpeg frame extraction runs.
- **AC-2** Given a clip over 500 frames, when the In thumb is dragged, then the
  preview still scrubs (the strip is optional).
- **AC-3** Given the preview is showing a different file, when a set-point moves,
  then that video is **not** scrubbed and a captioned still (`In · frame N`) is
  shown instead.
- **AC-4** Given the preview is empty, when a set-point moves, then the clip is
  loaded and seeked.
- **AC-5** Given a running job, when a set-point moves, then the panel is not
  replaced.
- **AC-6** Given `globalFramePeek` off, when a set-point moves, then the range
  updates and the preview is untouched.
- **AC-7** Given `framePeekSize` Full, when a still must be extracted, then the
  served image is 480px wide and the `[+]` strip is extracted at 480px.
- **AC-8** Given the same clip and two different size classes, then the two
  strips do not collide in the cache.
- **AC-9** Given a frame number and the probed rate, then `currentTime` maps to
  that frame within 0.5 frames on CFR and on mis-tagged media.
- **AC-10** Given the session is reloaded, then both settings persist.
