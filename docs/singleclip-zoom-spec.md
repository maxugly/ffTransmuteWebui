# Single-Clip Ops: Zoom / Pan — Spec

> **Status:** Implemented · bump `VERSION` far-right DD on ship
> **Related:** `docs/zoompan-spec.md` (Pan & Zoom tab, Pillow lerp — untouched), `app/operations/zoompan_ops.py`
> **Scope:** one new `transmute` dropdown op (`zoom`) + one new `POST /ops/zoom`. No changes to the Pan & Zoom tab.

## 1. Purpose

Expose ffmpeg-style zoom/pan (the classic `scale → zoompan` still-loop command plus wild mutations: Ken Burns, easing, punch, spiral, glitch, hue-cycle) directly on the **Single-Clip Operations** page. Selecting `zoom` from the Op dropdown populates **all** zoom controls in `#transmuteExtras` — timing, optics, motion, FX, engine toggle.

Input auto-detect: still image → still path (`-loop 1`), video clip → filtered video path.

## 2. Frontend

### 2.1 Dropdown (`js/tabs/transmute.js`)

```
zoom: { summary: "Zoom / pan (still → video or video → video)", fields: ['zoom'] }
```

### 2.2 Extras (all rendered when `fields.includes('zoom')`)

- Engine binary knob `zoomEngine`: `stable` (Pillow lerp, default) | `raw` (ffmpeg zoompan expressions).
- Preset select `zoomPreset`: `custom|zoom_in|zoom_out|targeted|kenburns|ease_in|ease_out|punch|spiral|glitch|hue_cycle` (default `zoom_in`). Choosing a preset fills the knobs; any manual edit flips back to `custom`.
- Timing: `zoomDuration` knob 0.5–60s (3.0), `zoomFps` knob 1–120 (24), `zoomOutSize` select `source|960x960|1080x1080|1920x1080|720x1280|custom` + `zoomWidth`/`zoomHeight` knobs (even steps, visible only on `custom`).
- Optics: `zoomRate` 0.001–0.10 (0.02, **raw engine only** — Stable never reads it, the UI hides it there), `zoomCap` 0–10 (3.0, 0=none; labeled **End zoom (×)**, the size at the last frame), `zoomPanX`/`zoomPanY` −20…+20 px drift/frame (0), `zoomPrescale` select 2/4/8 (4, raw stills only).
- Legends: every knob row carries a plain-English line (no jargon): direction (in = grows toward you), pre-scale (bigger = smoother but slower, raw-only), Target X/Y (targeted preset only), wobble/Spin/Glitch (units + raw-only), easing (all four modes + both engines), Punch frame (both engines) + Hue rate (raw-only) + jitter caveat, Frame d (raw-only choppy scale).
- Readout `zoomInfoLine` states the trip, not the machinery: stable `72 frames · 3.00s @24fps · stable · 1× → 3×`; raw `… · raw · 1× → 2.42× (+0.02/frame)`; stretch `picture grows to 2× wider · 1× taller`. Any manual edit of rate/cap/pan/direction/engine flips the preset to `custom` (stretch X/Y tune the stretch preset itself).
- Motion: `zoomPanX`/`zoomPanY` −20…+20 px/frame (0), `zoomTargetX`/`zoomTargetY` text (targeted preset), `zoomOscAmp`/`zoomOscFreq` knobs (0 / 10), `zoomFrameD` knob 1–5 step 1 (1, raw only — choppy above 1, legend warns).
- FX (raw only, section hidden when stable): `zoomRotate` 0–1.0 (0), `zoomEasing` select none/accel/decel/punch, `zoomPunchFrame` knob 1–240 (20), `zoomGlitch` 0–0.5 (0), `zoomHue` binary off/on + `zoomHueRate` 0.5–20 (2.0).
- Stretch (preset `stretch` only): `zoomStretchX` knob 1–4 step 0.05 (1.0) + `zoomStretchY` knob 1–4 step 0.05 (1.0). Plain words: picture size = video size; X = how much wider, Y = how much taller, both if both. Row visible only when preset is `stretch`.
- Readout `zoomInfoLine`: `N frames · WxH @ FPS · engine` live (same pattern as `updateRampInfoLine`). In `stretch` preset appends `→ X… × Y…`.
- Raw zoompan jitter caveat in the legend (the Pan & Zoom tab stays Pillow for a reason).

### 2.3 Collector (`js/job-control.js`, `tab==='transmute'`, op `zoom`)

`opId='zoom'`, body carries every control above + global `start_frame`/`end_frame`, numeric parsing with the same defaults as the knobs. `input_path` from `transmuteInput`, `output_path` from `transmuteOutput` (blank = auto).

## 3. Backend (`app/operations/zoom_ops.py`, op id `zoom`)

Params (pydantic): `input_path, output_path, engine(stable|raw), preset, duration_sec(>0,≤600), fps(>0,≤120), output_width/height|None(even, 16…7680/4320), zoom_rate, direction(in|out), zoom_cap(≥0), prescale(2|4|8), pan_x, pan_y, target_x/y|None, osc_amp, osc_freq, rotate_rate, easing(none|accel|decel|punch), punch_frame, glitch_amt(0…0.5), hue_cycle, hue_rate, frame_d(1…5), stretch_x(0.25…8, 1.0), stretch_y(0.25…8, 1.0), dry_run`.

Behavior:

- Auto-detect by suffix: image exts → still path; video exts → video path; else `ok:false` (HTTP 200).
- Output: `finalize_output_path(... default_suffix="_zoom" ...)`, even dims, non-empty verify.
- `dry_run` → `ok:true`, `command` = argv preview, `stdout` = human plan. Writes nothing.
- **Raw still:** `ffmpeg -y -loop 1 -i IN -vf "scale=...,zoompan=..." -t DUR -frames:v N -c:v libx264 -pix_fmt yuv420p OUT` (argv list, never `shell=True`).
- **Raw video:** same vf without `-loop 1`/`-t`, plus `-preset medium -crf 18`, audio dropped v1 (`-an`) to keep A/V sync trivial.
- **Stable still:** Pillow box-lerp (import `_lerp_box`-style math from `zoompan_ops`, no copy): in = full → center `1/cap`; out = reverse; pan offsets end box; easing remaps `p` (`accel p^1.5`, `decel sqrt(p)`, `punch` hold-then-burst); `report_progress()` every frame; encode `frame_%06d.png` → libx264.
- **Stable video:** v1 returns `ok:false` ("stable engine is still-image only in v1 — switch Engine to raw"). Honest, no silent wrong output.
- Expression guard (raw): `z/x/y` may contain only `[0-9a-zA-Z_+\\-*/()., ]` + tokens `on in iw ih zoom random sin cos sqrt min max if lt`; anything else → `ok:false`.
- Preset map: zoom_in `1+R*on` centered; zoom_out `CAP-R*on`; targeted `TX-(iw/zoom/2)`; kenburns `1+0.005*on`, `on*2/on*1`; ease `R*(on/FPS)^1.5` / `R*sqrt(on)`; punch `if(lt(on,P),1,1+(on-P)*0.1)`; spiral prepends `rotate=on*V,`; glitch appends `+(random(1)-0.5)*A`; hue appends `,hue=h=on*R:s=1`. Drift composes onto centered x/y.
- **Stretch preset (stills-only v1):** `preset='stretch'` ignores zoom_rate/direction/pan/osc and lerps each axis on its own: frame 0 = picture as-is, last frame = X times wider and Y times taller, center-cropped so the overflow bleeds off the edges (picture size = video size, never any bars). Stable engine only — raw returns `ok:false` ("stretch is stable-engine only in v1"). Both knobs at 1.0 → `ok:false` (nothing to stretch). Raw-only FX (rotate/glitch/hue) with stretch → `ok:false`, same as other stable presets.

## 4. Verification

- `tests/test_zoom.py` ≥ 6 green (preset map, guard reject, dry-run still/video argv, stable still renders 2 frames, bad input `ok:false`).
- Playwright: open Single-Clip tab → select `Op=zoom` → `#transmuteExtras` contains preset/engine/duration → dry-run + real still run → zero new JS errors. Curl is not UI proof.
