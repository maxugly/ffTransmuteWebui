# Speed Ramp Spec — Spin Up / Spin Down

> **Status:** Implemented — PNG frame remap via `app/filters/speedramp.py` + thin `speedramp_ops.py`  
> **Date:** 2026-07-25 · **Updated:** 2026-07-31  
> **UI:** Single-Clip Ops → Speed ramp (spin-up / spin-down)

---

## 1. Problem

Continuous exponential speed ramp (record spin-up / wind-down) on a single clip.

**ffmpeg setpts / asetpts** proved unreliable (see `docs/setpts-cli-failure-report.md`).  
**Working approach:** dump frames → remap (skip/dup) by curve → encode at constant FPS.

---

## 2. Architecture (filter platform)

```text
dump (video_pipeline) → run_speedramp_directory (filters.speedramp)
                      → encode (video_pipeline, mux_audio=False)
```

| Piece | Role |
|-------|------|
| `app/filters/speedramp.py` | `compute_curve`, `remap_frames`, directory stage factory |
| `app/operations/speedramp_ops.py` | Thin HTTP op |
| `speedramp_png.py` (root CLI) | Same curve/remap; offline convenience |

**Not** a 1:1 per_frame filter — output frame count is `duration × fps` (directory stage).

**Audio:** dropped in v1 (timeline remapped; rubberband pitch-follow is future work).

---

## 3. Parameters

| param | default | notes |
|-------|---------|--------|
| `direction` | `spin_down` | UI defaults for knobs; math uses start→end speeds |
| `duration` | 5.0 s | Target output length |
| `start_speed` | 4.0 | Multiplier at t=0 |
| `end_speed` | 0.333 | Multiplier at t=duration |
| `spin_down` | start > end | Fast → slow |
| `spin_up` | start < end | Slow → fast (UI swaps defaults) |

If source is too short for the absolute curve, the whole curve is **scaled** so shape/ratio survive and the last output frame maps to the last source frame.

---

## 4. Curve (conceptual)

For decelerating (`start > end`):

\[
t_{in} = A (1 - e^{-k t_{out}}),\quad k = \ln(S/E)/D,\quad A = S/k
\]

For accelerating (`start < end`):

\[
t_{in} = A (e^{k t_{out}} - 1),\quad k = \ln(E/S)/D,\quad A = S/k
\]

Output frame `n` samples `t_out = n/(N-1) * D`, maps to source frame `round(t_in * fps)`.

---

## 5. Verification

```bash
# API / op
# dry_run then real on /tmp/teste.mp4 with duration=2, spin_down

# CLI
python speedramp_png.py /tmp/teste.mp4 /tmp/teste_ramp.mp4 \
  --direction spin_down --duration 2 --dry-run
```

Expect: ok, duration ≈ target (or scaled), no setpts in command log, “PNG remap” in summary.

---

## 6. Out of scope (later)

- Rubberband / pitch-preserving audio along the curve  
- Multi-Pass UI chip for `speedramp`  
- Looping short sources instead of scale-to-fit  
