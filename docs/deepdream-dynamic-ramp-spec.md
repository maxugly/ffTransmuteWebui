# DeepDream Dynamic Ramp (per-frame parameter interpolation)

> **Status:** Proposed — spec first, not yet built  \
> **Depends on:** `deepdream-spec.md`, `filter-platform-spec.md`  \
> **Owner:** tom (plumbing) · max (UI review)  \
> **Goal:** Smooth, seam-free parameter variation across a clip's duration from a
> single op call — no N-job segmentation, no keyframe director, no bezier UI.

## Why

Dreaming a whole clip with one fixed param set is flat. The user wants values to
*drift* over time (e.g. `step` 0.008 → 0.02 across the clip). The cheap hack
(split into N jobs, ramp the knob per segment) fails because each job is a fresh
`make_deepdream_filter` closure — `optical_flow` / `temporal_blend` lose their
`last_dream_arr` predecessor at every boundary, causing visible cold-reset pops.
The real fix is to keep ONE closure for the whole clip and resolve params *per
frame* from the frame index. That is this spec.

## Scope

- **In scope:** an optional "Dynamic" mode for the DeepDream video path. When on,
  ascent knobs carry a start (`*`) and end (`*_to`) value; the engine linearly
  interpolates each per frame across the dumped clip duration.
- **Not in scope (this pass):** keyframe director UI, arbitrary per-frame value
  arrays, bezier/automation curves, drawing. The engine takes exactly two
  endpoints per knob (`from` → `to`) and lerps. Other ramp shapes are future.

## Knobs eligible for ramp

All ramp-able knobs resolve per frame inside `filter_fn` (deepdream.py).

| Knob | Type | Ramp behavior | Notes |
|------|------|---------------|-------|
| `step` | float | lerp `from`→`to` | primary muscle; smooth |
| `iterations` | int | lerp, round per frame | more dream later; smooth |
| `num_octave` | int | lerp, round, per frame | **structural** — pyramid rebuilds on int crossing → tiny hop; acceptable |
| `octave_scale` | float | lerp | structural like octaves; subtle hop at crossings |
| `max_loss` | float | lerp; `0` = off | frame where it crosses 0 begins early-stopping |
| `blend` | float 0–1 | lerp, clamped in engine | 0.5→1.0 = dream strengthens over time |
- `custom_layer_weights` (dict[str,float]): lerp each key `from`→`to`. **Missing-key rule: a key absent on either side defaults to 0.0** (so `{"mixed4":1.0}` → `{"mixed5":2.0}` lerps mixed4 1.0→0.0 and mixed5 0.0→2.0). Builder must take the key-union of both dicts and lerp per key, defaulting absence to 0.0 — never crash on asymmetric dicts.

Single-image and Ouroboros runs ignore ramp (use the `from` value at t=0) — they
have no frame index to interpolate over.

## Backend changes (additive, low risk)

File: `app/filters/deepdream.py` — `make_deepdream_filter`:

- Accept optional `*_from` / `*_to` pairs for: `step`, `iterations`,
  `num_octave`, `octave_scale`, `max_loss`, `blend`, and
  `custom_layer_weights_from` / `custom_layer_weights_to` (dicts).
- **frame_count lifecycle (reviewer #1):** Do NOT pre-probe or require a
  `frame_count` argument at factory-build time. `_dream_video` already calls
  `dump()` *before* building the filter, so the actual frames list is in scope.
  Inside `filter_fn`, derive the denominator from the live frames list length
  captured by the closure: `total = len(frames_in_list)` (passed into the
  closure at build time, after dump). `t = total > 1 ? index / (total - 1) : 0`.
  This is robust to cut-range / frame_step / max_frames caps because it uses the
  real dumped count, not a pre-dump estimate. No mutable `meta` dict needed for
  this op.
- Inside `filter_fn(src, dst, index)`:
  - `t = total > 1 ? index / (total - 1) : 0`
  - `v = lerp(from_v, to_v, t)` for each ramp-able knob (rounded where int).
  - `layer_weights = lerp_dict(from_w, to_w, t)` when custom + both present.
  - Build `frame_kwargs` fresh each frame from resolved values.
- **TF retrace guard (reviewer #2 — CRITICAL):** Ramp-able params
  (`step`/`iterations`/`num_octave`/`octave_scale`/`max_loss`/`blend`) are
  consumed as **plain Python scalars** in `dream_image` / `gradient_ascent_loop`
  / `gradient_ascent_step`. These are NOT decorated with `@tf.function`, so
  varying them per frame is a Python float/int change — no graph retrace.
  **Hard rule for future builders: never wrap `gradient_ascent_step` or
  `gradient_ascent_loop` in `tf.function` while ramps exist — doing so would
  retrace + recompile the compute graph every frame (30-min renders).** The spec
  locks this; violate it knowingly.
- When no `*_to` is supplied for a knob, behavior is identical to today (constant).
  **UI path and every existing Run is unchanged.**

File: `app/operations/deepdream_ops.py` — `_dream_video`:

- After `dump`, capture `frames = sorted(ws.frames_in.glob("frame_*.png"))` (already
  done at line ~251) and pass `total_frames=len(frames)` into
  `make_deepdream_filter(...)`.
- Forward any populated `*_from` / `*_to` fields from `DeepDreamParams` to the factory.

File: `app/operations/deepdream_ops.py` — `DeepDreamParams` (pydantic):

- Add optional fields: `step_to`, `iterations_to`, `num_octave_to`,
  `octave_scale_to`, `max_loss_to`, `blend_to` (each `float | None = None`),
  and `custom_layer_weights_to: dict[str,float] | None = None`.
- Defaults `None` → engine treats as "not ramping this knob".

## Reviewer notes (external review of the broader parameter-automation concept)

Two of the four review points apply to this spec; two do not (they target a
richer keyframe/canvas spec, not our 2-point lerp). Recorded so they are not
re-litigated:

- **#1 frame_count lifecycle — APPLIES.** Resolved above: closure reads the real
  dumped frame count at `filter_fn` time (post-dump), not a pre-probe. Safe for
  this op. (A generic `meta` dict would be needed only if an op built the filter
  *before* dump — deepdream does not.)
- **#2 TF retrace — APPLIES (performance-critical).** Resolved above with an
  explicit non-`@tf.function` guarantee + a hard rule against decorating the
  ascent loop. Our `dream_image` is already safe; the spec now *forbids*
  introducing the regression.
- **#3 log-scaling of a UI canvas — NOT APPLICABLE.** v1 has no canvas / `v`/`t`
  axis. Endpoints are typed scalars (`0.008` → `0.02`); linear lerp between them
  is intended. Log feel is achieved by *choosing* log-spaced endpoints, not by
  axis scaling. No Y-axis rendering exists.
- **#4 spline/bezier keyframe smoothing — NOT APPLICABLE.** v1 is strictly
  **2-point linear** (exactly one segment). There are no >2 keyframes and no
  envelope, so "harsh angles between keyframes" cannot occur. Multi-keyframe /
  spline smoothing is explicitly OUT OF SCOPE (matches the no-director, no-bezier
  product decision).

## Frontend changes

File: `app/static/js/tabs/deepdream.js`:

1. **Toggle:** new binary knob `dreamDynamic` in the MEDIA…DRYRUN row (beside
   Dry run). `Off` = current behavior; `On` reveals ramp UI.
2. **Ramp row:** when Dynamic is On, render a second ascent-knob row directly
   under the originals: `Step→`, `Iters→`, `Octaves→`, `OctScale→`,
   `MaxLoss→`, `Blend→`. Originals stay the *start* values; new row is *end*.
3. **Custom weights:** when Dynamic + `layer_preset == "custom"` are both On,
   render a second custom-layer-weight bank under the first (end values).
4. **Visibility:** reuse `syncDreamUiVisibility` to toggle `.dream-dynamic-only`
   blocks (same pattern as `.dream-video-only` / `.dream-ouro-only`).
5. **Collector:** `collectDeepDreamBody` emits `*_to` fields only when Dynamic is
   On; otherwise omits them (keeps payload identical to current). Exported
   JSON thus carries `"step": 0.008, "step_to": 0.02` etc. when ramping.

No change to `app.js` routing, `main.py`, or the export button (already merged).

## Interpolation rules

- Linear only: `v(t) = from + (to - from) * t`, `t ∈ [0,1]`.
- `int` knobs (`iterations`, `num_octave`) rounded to nearest int per frame.
- `blend` clamped to [0,1]; `max_loss` <0 treated as off (0).
- `total_frames` from the dumped frame count after frame_step/max_frames caps.
- If `from` omitted but `to` present: `from` = the original constant knob value.

## Verification

1. Syntax: `node --check app/static/js/tabs/deepdream.js`.
2. Browser (Playwright/local Chromium, like AGENTS.md demands):
   - DeepDream tab → global video bar → Dynamic On → ramp row appears.
   - Set `step` 0.008, `step→` 0.02 → click **Export settings** → JSON contains
     both `step` and `step_to`.
   - Dry-run the exported body via `curl -X POST /ops/deepdream -d @file` →
     returns `ok:true` (param validation passes).
   - Short real clip (24 frames, `preview_width` 480): render with ramp, confirm
     no cold-reset pop at frame 0 and gradual intensity increase.
3. Regression: a normal (Dynamic Off) Run produces identical output to pre-spec.

## Risks / notes

- `num_octave` / `octave_scale` ramps cause a small visual hop at integer
  crossings (pyramid rebuild). Documented; user may leave them fixed.
- Ramp only applies to the **video** dream path. Image / Ouroboros ignore it.
- Additive only — existing flat-path code is untouched when `*_to` is absent.

## Version

Bump root `VERSION` DD on completion (e.g. `000.000.4.79` → `000.000.4.80`).
