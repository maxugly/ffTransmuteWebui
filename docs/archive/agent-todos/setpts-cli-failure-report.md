# Session Report: FFmpeg setpts Variable Speed Ramping Failure

> **Date:** 2026-07-25
> **Author:** max (CLI testing)
> **Source clip:** tester96fps_960x960.mp4 (~10s, 960×960, 96fps CFR)

---

## Goal

Create a smooth speed ramp — variable acceleration/deceleration — on a 96fps clip.
Desired effect: start slow (~0.2×), accelerate to fast (~5.0×) smoothly over the clip duration.

---

## What Was Tested

### 1. Uniform speed — WORKS
```
setpts=0.5*PTS
```
Result: Speed changed uniformly. Proves setpts works at constant ratios. No ramp.

### 2. Linear ramp — FAILED
```
setpts='(0.5 + 0.0036*N)*PTS'
```
Intended: Start 0.5×, end ~4.0×.
Result: Output appeared constant speed. Ramp invisible.

### 3. Quadratic ramp — FAILED
```
setpts='(0.2 + 0.00005*N*N)*PTS'
```
Intended: Start slow, accelerate aggressively.
Result: Constant speed or heavy stutter. Some tests cut off early.

### 4. minterpolate added — NO HELP
```
setpts=EXPR,minterpolate=fps=96:mi_mode=mci
```
Result: Reduced stutter in slow sections but did not fix the "constant speed" problem. Processing time increased significantly.

### 5. Keyframe/CFR adjustments — NO HELP
```
-g 96 -keyint_min 96, fps=96
```
Result: Fixed playback stutter in players but the mathematical ramp still rendered as constant speed.

---

## Hypotheses

1. **Expression evaluation bug:** ffmpeg build may not evaluate `N` (frame number) correctly in setpts, defaulting to a constant.
2. **Timestamp quantization:** Calculated timestamps being rounded by muxer/encoder, flattening the curve.
3. **Player smoothing:** mpv may smooth variable timestamps, making the ramp look linear.
4. **VFR/CFR conflict:** fps filter forcing CFR may average out speed changes from setpts VFR output.

---

## Last Attempt: `-fps_mode passthrough`

```bash
ffmpeg -i tester96fps_960x960.mp4 \
  -vf "setpts='(0.2 + 0.00005*N*N)*PTS'" \
  -an -fps_mode passthrough -c:v libx264 -crf 18 \
  output_final_attempt.mp4
```

- `-fps_mode passthrough`: Tells ffmpeg NOT to force CFR. Allows VFR timestamps to survive.
- No `fps=96` filter: Prevents averaging of speed changes.
- Output will be VFR — if mpv plays it smoothly, the CFR conversion was the problem.

If this STILL fails → ffmpeg build likely has a setpts expression bug → fall back to segment/concat method.

---

## Implications for speedramp_ops.py

The codewhale fleet's current approach uses `PTS*TB` in the setpts expression, NOT the `N` variable. This may explain why Tom's inverse-log formula (`-log(1-PTS*TB/A)/(k*TB)`) works with the frame-counter test while the user's `N`-based expressions fail.

**Key insight:** `PTS*TB`-based expressions may be more reliable than `N`-based expressions across ffmpeg builds. The fleet's current code uses `PTS*TB` — this is correct and should be preserved.

**If passthrough mode works:** The speedramp_ops.py should use `-fps_mode passthrough` instead of chaining `,fps=N` after setpts. Let the curve produce VFR output, and trust the player to handle it.
