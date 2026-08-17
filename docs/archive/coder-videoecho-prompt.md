# Coder Prompt — Video Echo (`videoecho`)

> **Target**: ffTransmuteWebui — new standalone operation + new WebUI tab
> **Spec reference**: `docs/videoecho-spec.md` (same directory)

---

## MISSION
Implement a "Video Echo" operation that uses the FFmpeg `lagfun` filter to create persistent temporal feedback and light trails.

## PHASE 1 — BACKEND: `videoecho_ops.py`
Create `mtapi-project/app/operations/videoecho_ops.py`.
Define Pydantic schema `VideoEchoParams` with `preset` (crt_ghost, liquid_motion, chromatic_split) and `decay` (0.5 to 0.99, default 0.95).

**Logic for Filter Generation:**
- `crt_ghost`: `-vf "lagfun=decay={decay}:planes=1,eq=contrast=1.15:brightness=0.01"`
- `liquid_motion`: `-vf "lagfun=decay={decay}:planes=7,gblur=sigma=2.0,eq=saturation=1.3"`
- `chromatic_split`: 
  ```python
  d_g = max(0.5, decay - 0.03)
  d_b = max(0.5, decay - 0.08)
  vf = f"format=gbrp,split=3[r][g][b];[r]lagfun=decay={decay}:planes=1[ro];[g]lagfun=decay={d_g}:planes=2[go];[b]lagfun=decay={d_b}:planes=4[bo];[ro][go][bo]mergeplanes=0x000102:gbrp,format=yuv420p"
  ```
  Note: This uses `-filter_complex` instead of `-vf`.

**Audio**: Copy if present.

Register the operation. Import in `__init__.py`.

## PHASE 2 — FRONTEND: app.js + index.html
- Add `videoecho` tab under "Glitch / FX".
- Form: Preset dropdown, and a Continuous Knob for `decay` (step=0.01, decimals=2, max=0.99).
- Add routing and execution logic.
