# Speed Ramp — Diagnostic & Debugging Notes

> **Date**: 2026-07-25
> **Status**: broken — setpts expression produces incorrect output
> **File**: `mtapi-project/app/operations/speedramp_ops.py`

---

## 1. What the user wants

A "spin-down" speed ramp: video starts at 4× speed and continuously
decelerates to ⅓× speed over 5 seconds — like a turntable with the
plug pulled. Audio pitch follows the same curve (pitch drops with speed).

Input: a 92 fps interpolated clip (prepared specifically to have enough
frames for smooth slow motion at ⅓× speed).

---

## 2. What's happening instead

The output video plays at a **fast, apparently constant speed** then
**goes dark/black** while audio continues to play. The speed doesn't
perceptibly ramp — no visible deceleration.

In previous iterations the explanation was different (choppy output,
stuttering), but the current symptom suggests one of:

- The `setpts` expression isn't producing a ramp — speed is constant
- The video track ends before the audio track (black screen + audio)
- `-t` flag interaction with `setpts` is broken

---

## 3. The setpts approach

### 3.1 How setpts works

`setpts=EXPR` replaces each frame's presentation timestamp. If the
expression maps 1 second of input → 0.25 seconds of output, the
video plays at 4× speed (faster). If 1s input → 3s output, it plays
at ⅓× speed (slower).

### 3.2 The current formula (spin_down, start=4×, end=⅓×)

```
T_out = B * (exp(λ * T_in) - 1)

where:
  λ = (S/E - 1) / (S × D)
  B = D / (S/E - 1)
  S = start_speed (e.g. 4.0)
  E = end_speed   (e.g. 0.333)
  D = target duration (e.g. 5.0)
```

For S=4, E=0.333, D=5:
- λ ≈ 0.5506, B ≈ 0.4541
- `setpts='0.4541*(exp(0.5506*PTS*TB)-1)/TB'`
- dT_out/dT_in at t=0: B×λ = 0.25 → speed = 4× ✓
- dT_out/dT_in at T_in→∞: grows without bound → speed → 0

### 3.3 Why it doesn't work in practice

**Problem A — Input too short.** With S=4, E=0.333, D=5, the curve needs
~4.51 seconds of source footage. A 2-second clip produces only ~0.92s of
output. The ramp from 4× to ~1.3× happens in under a second — invisible.

**Problem B — `-t` may interact poorly.** The flag `-t 0.92` tells
ffmpeg to stop encoding at output time 0.92s, but with `setpts` and
`asetpts` on separate streams, one track may end before the other
(→ black screen + audio).

**Problem C — Speed change may be imperceptible.** Even with enough
source, a 4×→⅓× exponential spends most of its time near ⅓× (the
"long tail"). The visible portion at 4× is over in a fraction of a
second. The user may not see a ramp, just a fast blip then slow-mo.

**Problem D — VFR output.** `-vsync 0` produces variable frame rate.
Not all players handle VFR well. At ⅓× speed with 92 fps source,
there are only ~31 unique frames per output second, held for ~3
output frames each. This looks like 31 fps slow motion — inherently
choppy without optical-flow interpolation.

---

## 4. What was tried (history)

| Iteration | Approach | Result |
|-----------|----------|--------|
| v1 (spec) | `A*(1-exp(-k*PTS*TB))/TB` for spin_down | Expression was backwards — produced spin_up instead |
| v2 (fixed) | `B*(exp(λ*PTS*TB)-1)/TB` for spin_down | Math correct per test video, but real clip still broken |
| v1-v2 | `-stream_loop` for insufficient input | PTS resets at loop boundaries → choppy/stuttering |
| v3 | Concat demuxer instead of `-stream_loop` | Continuous PTS but still wrong expression |
| v4 (current) | v3 math + no looping + `-vsync 0` | Black screen + audio outlasting video |

---

## 5. Debugging steps for the next person

### 5.1 Reproduce with a test clip

Generate a frame-counter test video and apply the setpts filter directly:

```bash
# Generate a 3-second, 30 fps test clip with frame numbers
ffmpeg -y -f lavfi -i \
  "testsrc=duration=3:size=640x360:rate=30,drawtext=text='%{frame_num}':fontsize=48:fontcolor=white:x=(w-tw)/2:y=(h-th)/2" \
  -c:v libx264 -preset ultrafast -crf 18 -pix_fmt yuv420p -t 3 /tmp/test_src.mp4

# Apply setpts directly (spin_down, 4x→⅓x, 5s target)
ffmpeg -y -vsync 0 -i /tmp/test_src.mp4 \
  -filter:v "setpts='0.4541*(exp(0.5506*PTS*TB)-1)/TB'" \
  -t 5 -c:v libx264 -preset ultrafast -crf 18 /tmp/test_out.mp4

# Check frame timestamps — should see early frames tightly packed, later frames spread out
ffprobe -v error -select_streams v:0 -show_entries frame=pts_time \
  -of csv=p=0 /tmp/test_out.mp4 | head -20
ffprobe -v error -select_streams v:0 -show_entries frame=pts_time \
  -of csv=p=0 /tmp/test_out.mp4 | tail -20

# Known-good results (3s input = ~1.9s output):
# First frames: 0.000, 0.008, 0.017, 0.026, 0.034, ...  (tight = fast)
# Last frames:  ...1.733, 1.800, 1.867                     (spread = slow)
```

### 5.2 Verify the dry-run command

Hit the API with `dry_run: true` and inspect the `command` field:

```bash
curl -s -X POST http://localhost:24590/ops/speed_ramp \
  -H 'Content-Type: application/json' \
  -d '{"input_path":"/path/to/clip.mp4","direction":"spin_down","duration":5.0,"dry_run":true}' \
  | python3 -m json.tool
```

Check that:
- `setpts` uses `*(exp(` (growing exponential) for spin_down
- `setpts` uses `*(1-exp(` (decaying exponential) for spin_up
- No `-stream_loop`, no `-f concat`
- `-vsync 0` is present

### 5.3 Check the actual ffmpeg stderr

Run the operation normally, capture stderr, look for warnings about
PTS, frame drops, or duration mismatches:

```bash
curl -s -X POST http://localhost:24590/ops/speed_ramp \
  -H 'Content-Type: application/json' \
  -d '{"input_path":"/path/to/clip.mp4","direction":"spin_down","duration":5.0,"dry_run":false}' \
  | python3 -c "import sys,json; r=json.load(sys.stdin); print(r['stderr'][:2000])"
```

### 5.4 Check video vs audio duration in output

```bash
ffprobe -v error -show_entries stream=codec_type,duration \
  -of csv=p=0 /path/to/output.mp4
```

If video duration ≠ audio duration, the `-t` flag or setpts/asetpts
interaction is broken.

---

## 6. Alternative approaches to consider

### 6.1 Don't use setpts — use the `atempo` + `setpts` combination

The `atempo` filter handles audio speed changes more cleanly. Combined
with `setpts` for video, this may avoid sync issues:

```
-filter:v "setpts=EXPR" -filter:a "atempo=1/EXPR_DERIVATIVE"
```

But this is complex for variable-speed ramps (atempo is constant-rate).

### 6.2 Use `minterpolate` for frame generation

At slow speeds (⅓×), there aren't enough input frames for smooth output
at high frame rates. The `minterpolate` filter can generate in-between
frames using motion interpolation:

```
-filter:v "setpts=EXPR,minterpolate=fps=92:mi_mode=mci"
```

This would produce 92 fps output with interpolated frames at all speeds,
eliminating the "choppy slow-mo" problem.

### 6.3 Abandon setpts entirely — build a frame-server approach

Generate a list of exact output times for each frame, resample via
ffmpeg's `select` + `setpts` or a custom Python script that computes
per-frame PTS values and writes them directly. More control, more work.

### 6.4 Use the transmute bash script's `-T` flag pattern

The transmute script already does constant-rate time stretch with
`setpts` + `rubberband`. Extending it to variable-rate would mean
passing a curve definition instead of a fixed ratio.

---

## 7. Open questions

1. **Why does video go dark while audio continues?** This suggests the
   video and audio streams have different durations after filtering.
   The `-t` flag should truncate both, but something is misaligned.

2. **Does `-vsync 0` work correctly with libx264?** Some encoders
   override vsync. Check if the output is truly VFR.

3. **Is the server using the latest code?** Ensure no `.pyc` cache
   is stale: `find mtapi-project -name '*.pyc' -delete` before restart.

4. **What is the actual speed of the user's output?** Use
   `ffprobe -show_frames` on the output to compute per-frame speed
   (Δinput_time / Δoutput_time) and plot it — this would immediately
   show whether the ramp is being applied.

---

## 8. Files involved

| File | Role |
|------|------|
| `mtapi-project/app/operations/speedramp_ops.py` | Backend: params, curve math, ffmpeg command |
| `mtapi-project/app/static/app.js` | Frontend: knob controls, info line, run handler |
| `mtapi-project/app/shell.py` | Shared: `probe_duration`, `ensure_video_output_path` |
| `mtapi-project/app/operations/__init__.py` | Import registration |
| `docs/speed-ramp-spec.md` | Original specification (has known error: swapped expressions) |
