# Automation Lanes — Future Spec

> Pinned 2026-07-23. Do not implement until explicitly requested.
> This is a design scratchpad, not a commitment.

## Concept

Every parameter knob in the WebUI can be automated over time via a curve
editor. One system, agnostic to which op or parameter.

## Data Model

```
automation: {
  paramId: string,        // "deepdream:intensity", "datamosh:tail", etc.
  curve: [{t: 0-1, value: number, easing: "linear"|"ease-in"|...}],
  min: number,
  max: number,
  enabled: boolean,
}
```

## Architecture

- **Curve renderer** — Canvas-based, draggable bezier/linear points (vanilla JS).
- **Interpolator** — Lerp between points at given `t`. ~15 lines.
- **Floating panel** — Togglable, travels between tabs. Mini preview + edit button.
  Could live as a collapsible bar above the terminal.
- **Server protocol** — Op handlers receive automation data alongside static params.
  Two approaches:
  a) N ffmpeg calls with incremental values (slow, ugly)
  b) Generate filter chains with animated parameters (complex, format-dependent)

## Easiest First Target

**DeepDream** — already processes frame-by-frame with optical flow. The engine
loop just samples the curve at each frame instead of reading one static value.
Zero ffmpeg complexity. Perfect proof-of-concept.

## What Exists Today

Nothing. Vanilla JS, no chart lib, no keyframe framework, no animation plumbing
on the server side. All parameters are static single-shot values.

## Rough Effort

| piece | difficulty | time |
|-------|-----------|------|
| curve data model + JSON | trivial | hour |
| curve editor (canvas) | medium | weekend |
| interpolator | trivial | 15 min |
| floating panel UI | medium | weekend |
| server: deep dream wiring | easy | hour |
| server: general op protocol | hard | weeks |

## Notes

- DAW metaphor already exists in the knob UI. Automation lanes extend it naturally.
- Could also automate datamosh tail length, style transfer strength, transmute flags.
- Stick to linear easing first. Bezier can come later.
