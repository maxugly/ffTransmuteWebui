# Spec: Unified Speed & Time Tab (v3 — Final)

> **Status:** Shipped as-built (VERSION `7.015`). Live readout == backend
> `resolve_speed_plan` 1:1, Playwright-proven (trim / fps / length keep +
> Control·Auto toggles + FPS-raise disabled under Auto·Match).
> **Code targets:** `app/operations/speedchange_ops.py` → `POST /ops/speedchange` ·
> `app/static/js/tabs/speedchange.js` · `tests/test_speedchange.py`
> **Supersedes:** the amending "Keep the Change" draft. This is the agreed final
> model: **two control slots** (one of {Multiplier, Length} **plus** Output FPS),
> Snap-by-default RIFE, and an explicit "Keep the Change" extras policy.

## 1. Degrees of freedom (the whole thing in one paragraph)

A video has three user-relevant quantities: **Speed S**, **Length T**, **Output
FPS F′**. They are tied by `T = D / S` (D = source duration) and `R = T × F′`
(frames on disk). Because `T = D/S` links Speed and Length into one dimension,
the user gets **exactly two chosen variables at a time**:

- one of {**Speed Multiplier**, **Target Length**} — the other derives
  automatically, they can never both be chosen;
- **Output FPS** — independent, defaults to *Match source*.

Five legal combos: fps-only · multiplier-only · length-only ·
multiplier+fps · length+fps. No other state is reachable, so the controls can
never contradict the math.

## 2. UI layout: per-variable Control / Auto toggles

Each selectable variable is a row with an explicit **Control / Auto** switch.
`Auto` means "derive it" (its read-only value is still shown in the readout).

```
[ Speed & Time Tab ]

Multiplier  (● Control ── Auto)   [knob] 0.3×          ← only one of the
Target Length  (─ Control ● Auto) [knob] 8.0s          ←  top two rows is Control
Output FPS  (● Auto=Match ── Control)                  ← Control → [Custom FPS knob]

RIFE Interpolation: [ ON ]          (off ⇒ pure setpts/atempo)
RIFE Mode:  (* Snap   ) Free (extra frames)
Keep the Change:  (* Off [Trim] )  FPS [raise rate]  Length [keep 4:3]
RIFE Model: [ rife-v4.6 ]

------------------------------------------------
READOUT — Original: 4.00s @ 30 FPS (120 frames)
Exact Speed: 0.3×          Final Duration: 13.33s
Final FPS: 30 FPS          Target Total Frames: 400
RIFE Multiplier: 4×        Generated Total Frames: 480
Extra Frames: (Dropping 80 extra frames)
------------------------------------------------
```

**Auto-exclusivity rules (why it can't get goofy):**
- Setting **Multiplier = Control** flips **Length = Auto** and vice-versa.
- Setting **Output FPS = Control** reveals the Custom FPS knob; `Auto` hides it
  and pins F′ = source F.
- When Output FPS is *Control* (F′ pinned), the **Keep the Change: FPS** branch is
  disabled — it would have to override the fps you chose, which is the only
  "silent takeover" this design forbids.

## 3. Deterministic math (UI readout mirrors backend 1:1)

```
T = D / S                      final duration          [from target mode + chosen var]
R = T × F′                     exact frames on disk
ratio = F′ / F                 magnification per source frame needed      (F = source fps)
K = ratio / S                  effective RIFE demand
```

- **RIFE OFF:** ffmpeg `setpts=(1/S)*PTS,fps=F′` re-times in one pass. No M/G.
- **RIFE ON — Snap (default):** M = nearest valid step (2,4,8,…) to K, then the
  multiplier is re-derived to `S = ratio / M` (⇒ `T = D/S`) so
  `G = N×M = R` exactly. **Zero extra frames, zero waste.** Readout labels the
  derived multiplier `(snapped)`.
- **RIFE ON — Free:** keep both chosen variables; M = smallest valid step with
  `M ≥ K` ⇒ `G = N×M ≥ R`, extra ` = G − R`. Explorer decides what happens to
  the extra frames (below).

**Keep the Change (Free mode only — how extras are spent):**
- **Off / Trim (default):** drop `G − R` frames at the conforming encode. The
  file has exactly `R` frames at F′ — duration `T` and fps `F′` match the chosen
  values to the frame. Readout: `(Dropping N extra frames)`.
- **FPS (raise the rate):** keep all `G` frames inside duration `T` ⇒ final FPS
  = `G / T` (shown in readout). Only available while Output FPS = **Auto**
  (with a pinned F′ this branch is disabled, since the fps is already yours).
- **Length (keep them all at F′):** encode all `G` frames at `F′` ⇒ final
  duration = `G / F′`; the *effective* speed becomes `D / (G / F′ )`
  (shown in readout). Available always.

## 4. Readout (Source of Truth)

Always: Original `D s @ F FPS (N frames)` · Exact Speed (incl. `(snapped)`) ·
Final Duration · Final FPS (annotates `(source F)` when F′ ≠ F) · Target Total
Frames `R`.

RIFE ON only: Required RIFE Multiplier `M×` · Generated Total Frames `G` ·
Extra Frames action `(Dropping N extra frames)` / `(Encode FPS G/T)` /
`(Encode Length G/F′)`. Every field is computed by the same pure function the
backend runs, so the encode can never drift from the panel.

## 5. Worked examples (4s @ 30fps, N=120)

**0.3× at source fps** (Output FPS = Auto, RIFE ON):

| Mode | Encoded frames | Final Duration | Final FPS | Exact Speed |
|---|---|---|---|---|
| Snap (default) | 480 | 16.00s | 30 | 0.25× (snapped) |
| Free + Keep: Trim | 400 (+80 dropped) | 13.33s | 30 | 0.30× |
| Free + Keep: FPS | 480 | 13.33s | 36 | 0.30× |
| Free + Keep: Length | 480 | 16.00s | 30 | 0.25× |

**1.00× at custom 60fps** (Output FPS = Control 60, RIFE ON): ratio 2, K = 2.
Snap → M=2, S stays 1.00×, T=4.00s, R=G=240, extra 0.
Free → M=2, R=240, extra 0. Output is 4.00s @ 60 FPS (240 frames).

**0.3× at custom 60fps** (F′ pinned): ratio 2, K = 6.667.
- Snap → M=8, S re-derived to 0.25×, T=16.00s, R=G=960, extra 0 `(snapped)`.
- Free → M=8, R=800, G=960, extra 160. Keep the Change:
  - **Trim:** 800 frames @ 60 → 13.33s, S = 0.30× (exact, drops 160).
  - **Length:** 960 frames @ 60 → 16.00s, effective S = 0.25×.
  - **FPS: disabled** (fps is pinned; the branch cannot raise it).

## 6. API

`POST /ops/speedchange` — body adds two fields on top of the current shape:
`target_fps` (float|null; null = match source) and `keep_extra`
(`"trim" | "fps" | "length"`). `meta` already carries the full plan
(src_duration / src_fps / exact_speed / final_duration / final_fps /
target_frames / rife_multiplier / generated_frames / extra_frames / snapped)
and must stay byte-identical to the JS readout plan.