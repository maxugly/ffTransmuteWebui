# Coder Prompt — Scripts tab + digicam_2000s (first script)

> **Branch:** `wip` (not `main`)
> **Role:** Builder — assigned in this prompt.
> **Kind:** One-shot. Product is locked below. Spec: `docs/scripts-tab-spec.md` (tab mechanics) + this prompt (digicam decisions).
> **As-built:** No Scripts tab exists. No `scripts/` dir exists. Skills tab (`skills.js`, `routes/skills.py`, `operations/skills_ops.py`) is the closest shipped pattern for tab + routes + op.
> **Ideas, not code:** `mtapi-project/junk/customScripts/Digicam-2000s-Pro.py` (algorithm) + `Digicam-Webui.py` (knob ranges/groups). Port, don't copy — fix the listed bugs as you go. Junk stays untouched.
> **Verification:** `AGENTS.md` invariants + WebUI proof. Click the real Scripts nav item.

---

## MISSION

1. Ship the **Script Runner tab** per `docs/scripts-tab-spec.md`, with one deviation: frontend executes via `runOpWithCancel(opId, body)` (job machinery: progress/cancel/`displayOpResult`/auto-add), **not** raw `fetch(endpoint)`. Catalog carries both `op` (job id) and `endpoint` (spec compat; `op` = basename of `endpoint`).
2. Ship **`digicam_2000s`** as the tab's first and only entry — early-2000s cheap-camera photo look, works on **video and image**, every number a knob, every choice a toggle/select. No toy `example_trim` op.

Out-of-the-box promise: select script → Run with zero tweaks → cheap-camera photo. Defaults below ARE the look.

---

## READ FIRST (in this order)

1. `docs/scripts-tab-spec.md` §§1–5 (tab mechanics, catalog shape, render/collect flow).
2. `mtapi-project/junk/customScripts/Digicam-2000s-Pro.py` + `Digicam-Webui.py` (effect + knob ranges).
3. `app/operations/styletransfer_ops.py` `_styletransfer_video` (~lines 217–326): the video bookend to copy — `probe → JobWorkspace → dump(start/end) → process(filter_fn, progress_cb) → encode → cleanup`, `report_progress` per frame, `JobCancelled` handling.
4. `app/filters/withoutbg.py` (whole file, 71 lines): the `per_frame` factory + `register_stage` pattern.
5. `app/static/app.js`: `TAB_ACCEPTS`, `FRAME_RANGE_TABS`, `renderTabForm` branch, `runActiveOperation` dispatch, `bestInput`, form-state capture/apply.
6. `app/static/js/tabs/skills.js` + `app/static/js/tabs/cut.js`: `runOpWithCancel` call shape, `globalFrameRange()` import from `js/utils.js`.

---

## LOCKED

1. Nav: **new top-level `Scripts` section** in `index.html` (spec §1.1 markup), `data-tab="scripts"`. Not inside Transmutations, not Workspace.
2. `TAB_ACCEPTS.scripts = 'any'`. Global Run stays visible; global inputs stay visible. Do NOT add `scripts` to static `FRAME_RANGE_TABS` — toggle `#giFramesRow` per active script's `uses_frame_range` inside `updateScriptExtras()`.
3. One op `digicam_2000s`, image/video dispatch by input extension (styletransfer pattern). Video frame range supported; image ignores it.
4. `deterministic` binary **default on** + `noise_seed` knob default `2003`. Frame *i* seeds `seed+i`. Toggle off → fresh entropy per run.
5. Barrel distortion: one small knob in CCD defects, default 0. Nothing more. (Dead in prototype — implement cheap numpy radial remap, keep it quiet.)
6. No new dependencies. Pillow + numpy already in `requirements.txt`. Gradio file is UI-only — do not port.
7. Catalog is **read-only V1**: `GET /api/scripts/catalog` from `scripts/catalog.json`. No POST/DELETE, no in-browser editor.

---

## FILES

| File | Change |
|------|--------|
| `app/digicam_core.py` | **New.** Pure port of Pro `apply_*` + params dataclass (no FastAPI, no I/O except `process_image`). Sole owner of the algorithm. Includes fix list below. |
| `app/filters/digicam.py` | **New.** `make_digicam_filter(**params)` → `per_frame` fn over core; `register_stage("digicam", …)`; import in `filters/__init__.py`. |
| `app/operations/digicam_ops.py` | **New.** `DigicamParams` + `digicam_2000s` handler (image direct / video dump→process→encode). Import in `operations/__init__.py`. |
| `scripts/catalog.json` | **New.** Single `digicam_2000s` entry (all params below). |
| `app/routes/scripts.py` | **New.** `GET /api/scripts/catalog` via a small `scripts_catalog` loader (validate + cache; corrupt → `[]`, never crash). Register in `main.py`. |
| `app/static/js/tabs/scripts.js` | **New.** Generic runner: catalog fetch (sessionStorage 5-min TTL), `<optgroup>` dropdown, global-input reminder, dry-run binary knob, `updateScriptExtras` (knob/binary/select/text/file via shared `knobs.js`, `openFileBrowser`, `data-clearable`), `collectScriptBody` (spec §3.4 + `globalFrameRange()` when opted in), `runScript` via `runOpWithCancel`. `activeScriptId` in `state.formState.scripts`. `tool-docs` block at bottom. |
| `app/static/index.html` | Scripts nav section. |
| `app/static/app.js` | Import + `TAB_ACCEPTS` + title + render branch (+ `runActiveOperation` branch if that dispatch is per-tab). |
| `mtapi-project/tests/test_digicam.py` | **New.** ~8 tests (see DONE). |
| `mtapi-project/tests/test_scripts.py` | **New.** Catalog load/validate/recover, route shape, `REGISTRY` contains op. (Fold into test_digicam if simpler — one file is fine.) |
| `docs/STATUS.md`, `VERSION` | Top-box handoff + DD bump. Do not paste digits into STATUS. |

---

## CORE FIXES vs PROTOTYPE (do not skip)

1. `jpeg_passes`: prototype slices `[50,32][:passes]` so 3–5 silently do 2. V1 table `[60,50,42,34,28][:passes]`; final save at `final_quality`.
2. `grain_type: luma_only` = luma noise only, chroma terms forced 0 (prototype ignored it).
3. RNG: delete `random` module use; one `np.random.Generator` per frame drives grain + stuck pixels + focus jitter.
4. `tint_strength` exposed (was dataclass-only, no CLI flag).
5. `timestamp_color` as hex text (`#FFE600`), parsed backend-side. Font chain `DejaVuSans.ttf → PIL default`, never crash.
6. `vertical_banding` knob (was dataclass-only). `flash_falloff` knob (was fixed 1.8). `vignette_strength` knob (was fixed 0.6).
7. Stage order fixed: resolution → blur → color → noise → flash → defects → timestamp → interlace → compression.
8. Video: identical params every frame (consistent dims for encode); audio preserved via pipeline encode; `report_progress` every frame with `latest_frame`.
9. Outputs: image → `{stem}_digicam.jpg` (never overwrite, `unique_output_path`); video → `{stem}_digicam.mp4`. Absolute paths at API boundaries.

---

## CATALOG PARAMS (groups = accordions, mirrors Gradio file)

`knob min–max step default` · `binary default` · `select [opts] default` · `text default`

- **Resolution:** `preset` select [custom,144p,240p,320p,vga,1mp,720p] vga (frontend autofills w/h; custom keeps manual) · `width` 32–1280 1 640 · `height` 32–1024 1 480 · `downscale_method` [LANCZOS,BILINEAR,NEAREST,BICUBIC] LANCZOS · `pixelate` 0–16 1 0.
- **Lens:** `blur_type` [gaussian,box,none] gaussian · `blur_radius` 0–5 0.1 0.7 · `focus_jitter` 0–3 0.1 0.
- **Color/CCD:** `contrast` 0.2–2 0.01 0.65 · `brightness` 0.5–2 0.01 1.12 · `saturation` 0–2 0.01 0.8 · `gamma` 0.5–2.5 0.05 1.0 · `warm_r` −50–50 1 22 · `warm_g` −50–50 1 12 · `warm_b` −50–50 1 −8 · `tint_strength` 0–1 0.05 0.
- **Grain:** `noise_enabled` binary on · `noise_amount` 0–60 0.5 22 · `chroma_r_amount` 0–30 0.5 10 · `chroma_b_amount` −20–30 0.5 8 · `grain_type` [gaussian,uniform,luma_only] gaussian · `deterministic` binary on · `noise_seed` 0–999999 1 2003.
- **Flash:** `flash_enabled` binary on · `flash_strength` 0–200 1 95 · `flash_x` 0–1 0.01 0.48 · `flash_y` 0–1 0.01 0.32 · `flash_radius` 0.2–3 0.1 1.4 · `flash_falloff` 0.5–4 0.1 1.8 · `shadow_strength` 0–120 1 42 · `vignette_strength` 0–1.5 0.05 0.6.
- **CCD defects:** `chroma_aberration` 0–5 0.1 0 · `barrel_distortion` 0–0.5 0.01 0 · `stuck_pixels` 0–20 1 0 · `vertical_banding` 0–5 0.1 0.
- **JPEG:** `jpeg_passes` 1–5 1 2 · `final_quality` 5–95 1 38 · `subsampling` [0,1,2] 0.
- **Extras:** `timestamp_enabled` binary off · `timestamp_text` text `2003/10/12 21:42` · `timestamp_pos` [bottom_left,bottom_right,top_left] bottom_left · `timestamp_color` text `#FFE600` · `interlace` binary off · `scanline_strength` 0–0.5 0.01 0.15.

---

## BUILD ORDER

1. `digicam_core.py` + unit-test it first (determinism: same seed → identical bytes; seed+1 differs).
2. `filters/digicam.py` + op `digicam_ops.py` (image path, then video path).
3. `scripts/catalog.json` + `routes/scripts.py` + `main.py` wiring.
4. `js/tabs/scripts.js` + `index.html` + `app.js`.
5. pytest → Playwright proof → VERSION + STATUS.

---

## INVARIANTS (AGENTS.md — non-negotiable)

- Filter platform only: dump → `app/filters/*` → encode. No second dump/encode stack.
- `shell.run_command` + argv lists. NEVER `shell=True`. No subprocess in `main.py`. No `from __future__ import annotations` in `main.py`.
- Absolute I/O. HTTP failures = 200 + `{"ok": false}`.
- Vanilla JS, no npm/frameworks. Junk/screenshots → `mtapi-project/junk/` only.
- `report_progress()` every frame on video path.

---

## DO NOT

- Touch transmute CLI, Image Edit, or dump/encode bookends.
- Add catalog write APIs, script editor, chaining, presets, marketplace (spec §8 — later).
- Batch/multi-input in V1 (`input_mode:"single"`, global input only).
- Port the Gradio UI; build the native tab per spec §3/§6.
- Merge to `main` unless the human asked. Commit on `wip`.

---

## DONE

- [ ] `test_digicam.py` green: determinism, each `apply_*` smoke, filter 1:1 (`frame_%06d.png` in→out), op dry-run (no file), tiny-image run (JPEG exists), 3-frame video run (MP4 exists), corrupt catalog recovers, `REGISTRY` has `digicam_2000s`
- [ ] Full suite green
- [ ] Playwright, real clicks: Scripts nav → 8 groups render → preset fills w/h → dry run (command logged, no file) → real image run → real short video run → zero page errors
- [ ] Defaults-only run gives the cheap-camera photo (eyeball check on the screenshot)
- [ ] `VERSION` DD bump + `docs/STATUS.md` top box (shipped/next)
- [ ] Commit on `wip`
