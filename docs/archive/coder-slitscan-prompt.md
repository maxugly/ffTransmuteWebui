# Coder Prompt — Slit-Scan (`slitscan`)

> **Target**: ffTransmuteWebui — new standalone operation + new WebUI tab
> **Spec reference**: `docs/slitscan-spec.md` (same directory)

---

## MISSION
Implement a "Slit-Scan / Time Displacement" operation that uses `tmix`, `tblend`, or a complex `split`/`crop`/`vstack` filtergraph to create eerie temporal motion effects.

## PHASE 1 — BACKEND: `slitscan_ops.py`
Create `mtapi-project/app/operations/slitscan_ops.py`.
Define Pydantic schema `SlitscanParams` with `preset` (light_trails, dark_trails, difference, slit_scan_4) and `frames` (3-30, default 10).

**Logic for Filter Generation:**
Generate weights string based on `frames` count. e.g. decreasing from 1 down to 0.1 over N frames.
- `light_trails`: `-vf "format=rgba,tmix=frames={frames}:weights='{weights}',tblend=all_mode=lighten,format=yuv420p"`
- `dark_trails`: `-vf "format=rgba,tmix=frames={frames}:weights='{weights}',tblend=all_mode=darken,format=yuv420p"`
- `difference`: `-vf "format=rgba,tmix=frames={frames}:weights='{weights}',tblend=all_mode=difference,format=yuv420p"`
- `slit_scan_4`: Use `-filter_complex` as defined in the spec.

**Audio**: Copy if present. The delay in slit_scan_4 might desync video, that is acceptable for glitch aesthetics.

Register the operation. Import in `__init__.py`.

## PHASE 2 — FRONTEND: app.js + index.html
- Add `slitscan` tab under "Glitch / FX".
- Form: Preset dropdown, and a Continuous Knob for `frames` (hide if `preset` is slit_scan_4).
- Add routing and execution logic.
