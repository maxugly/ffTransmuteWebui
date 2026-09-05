# Project status — agent & human source of truth

> **Updated:** 2026-09-01  \
> **VERSION:** root `VERSION` file (do not copy the digits here)  \
> **Branch:** `wip`  
> **Purpose:** Where we are. **Shipped / partial / remaining roadmap.** Agents **must** read this before inventing features or re-speccing shipped work.

**Also read:** `AGENTS.md` (root) · [README.md](README.md)

---

## Shipped this stretch / Next assignment

| Area | Notes | Spec / code |
|------|--------|-------------|
| **References: Video Models sub-tab** | References now has two real sub-tabs, synced both ways: left nav (`YT Footage` / `Video Models`) + top segmented bar. The 5 dead decorative buttons are gone; YT cards unchanged under `refs`, new Big Chart (18 rows, one card/one table, no h-scroll at desktop width, amber LTX oversize warning, green `Your current model` / `wall crash debris` badges) under `refs-models`. Table defaults to Model A→Z, every column header click-sorts asc/desc (numeric-aware, empties last). Playwright-proven with real clicks, zero JS errors. | `index.html` · `app.js` · `js/tabs/references.js` · `css/references.css` · **`8.004`** |
| **References: Image Models sub-tab** | Third sub-tab under References (`refs-images`), exact same treatment as Video: one card/one table (24 rows: Company / Model / Native Training Res / Optimal Gen Res / Buckets / Notes), defaults to Company A→Z with Model tiebreak, all headers click-sortable via shared generic sort helpers. Playwright-proven (default/sort/desc/nav-sync), zero JS errors, no h-scroll. | `index.html` · `app.js` · `js/tabs/references.js` · **`8.005`** |
| **References: Coding Models sub-tab** | Fourth sub-tab under References (`refs-code`): one card/one table (7 rows: Model / Provider-Base / Context / Strengths / Weaknesses / Best For), defaults to Model A→Z with Provider tiebreak, all headers click-sortable via the same shared helpers. Muse Spark 1.3 row highlighted with green `Primary daily driver` badge. Playwright-proven, zero JS errors, no h-scroll. | `index.html` · `app.js` · `js/tabs/references.js` · **`8.006`** |
| **References: Coding Models data refresh** | Replaced with new 19-model dataset and new columns (Model / Provider / Context / Key Strengths / Avail. / Notes-Best For). Weaknesses column dropped per new data; Avail. markers (`*`/`+`/`*+`) rendered verbatim with a "as published" legend (no local definition yet). Muse Spark 1.3 keeps the highlighted `Top overall free pick` badge. Playwright-proven, zero JS errors, no h-scroll. | `js/tabs/references.js` · **`8.007`** |
| **References: Coding legend + recommendations** | Avail. legend now defined (`*` = free in OpenCode Zen, `+` = free via Kilo Gateway / OpenRouter free router, `*+` = both). New Quick Recommendations card under the table (overall / pure-coding / speed / multimodal / tiny-local) plus free-tier caveats callout. Playwright-proven, zero JS errors. | `js/tabs/references.js` · **`8.008`** |
| **References: True FL2V column (Video)** | New centered `True FL2V` column on the Video Models chart (between Duration and Notes), click-sortable (Yes → ? → No). Badges: green Yes (start+end), gray No (start-frame/T2V only), amber ? (unconfirmed) + legend. Best-effort values: Yes = Seedance Pro/2.x, Kling 2.x/3.0, Luma Ray2/3; No = LTX-Video, Wan 1.3B; ? = LTX 2.x, Wan 14B/2.2, Seedance Lite, Hailuo, Vidu, Veo 3, Pixverse — needs human verify. Playwright-proven, zero JS errors, no h-scroll. | `js/tabs/references.js` · **`8.009`** |
| **Sequence split (god-file → 6 leaves + barrel)** | Former 2615-line `pool/sequence.js` is now a 10-line barrel re-exporting `sequence-model` (pool lookups/durations), `sequence-select` (hover/selection/focus frame), `sequence-variants` (TTL cache + static `fetchVariantsBatch` import + ORIG/RIFED menu), `sequence-rife` (density math + Instant queue/drain/hydrate + queue snapshot), `sequence-composer` (dropzone/CRUD/token render), `sequence-transport` (preview playback + clip time settings + list-keys). Deleted dead `_maybeAutoRifeForPath`; fixed mid-file + dynamic imports. All 6 existing importers (`app.js`, `grid.js`, `items.js`, `persistence.js`, `preview.js`, `jobs.js`) untouched. Playwright-proven with real clicks: Sequence nav, ▶ play (advanced 2/340), RIFED variant fetch, Jobs tab — zero new JS errors (only pre-existing thumb 404s). | `js/pool/sequence*.js` · **`8.011`** |
| **Tab scroll memory (session-only)** | Clicking away from any tab and back restores its scroll position — per-tab, in-memory. New vanilla module (`js/ui/tab-scroll.js`) saves outer `#actionPanel` + `#actionPanelForm` + pool grid wrap (`#poolGridWrap`/`#imgPoolGridWrap`) scrollTops on every scroll (capture-phase, rAF-throttled) and on `switchTab` leave, restores on return via double-rAF (falls back to desk `gridScrollTop` for pool tabs on first visit). Playwright-proven with real nav clicks: Sequence 600→away→600, Pool own 200, Speed outer 400→away→400; zero new JS errors. | `app.js` · `js/ui/tab-scroll.js` |
| **Comma-safe join/grid** | Fixed a delimiter collision: `/ops/join` + `/ops/grid` comma-joined multi-input and bash `collect_inputs()` split on `IFS=','`, so a clip whose own filename contained a comma got truncated → `No such file or directory`. Join target-less path now uses pure-Python `concat_clips` + remux; new pure-Python `grid_clips` (xstack) handles grid; both bash `transmute`+`bin/transmute` now detect comma-in-path and exit loudly. 6 new tests (`tests/test_join_comma.py`), 70 total green. | `transmute_ops.py` · `video_pipeline.py` · `transmute` · `bin/transmute` · `tests/test_join_comma.py` · **`8.002`** |
| **Final-encode fixes** | Shared final-render engine hardened (`app/video_pipeline.py` `encode`/`_build_encode_argv`). **1)** `encode()` now verifies the output file exists & is non-empty (`_ensure_output_file`) — no more "runs but makes nothing" on silent ffmpeg exit 0. **2)** Legacy frame-op encodes (RIFE/speed/recohere/cut) auto-pad odd chroma-subsampled dims (`yuv420p`) instead of crashing on "width not divisible by 2". **3)** `-shortest` no longer trims generated RIFE'd frames to the source-audio length by default; new `clamp_to_audio` opt-in keeps exact length-matched mux for `cut`. 9 new tests (`tests/test_encode.py`), 64 total green. | `app/video_pipeline.py` · `app/operations/cut_ops.py` · `tests/test_encode.py` · **`8.001`** |
| **8.000 release** | Full point release — every 7.x ship since `7.000` lands on `main`: **Flip / Rotate** (7.017), **Clearable inputs** (7.016), **Keep the Change** (7.015), **Unified Speed & Time** (7.014), **Visual Hijack + Mosh-ups** (7.013, `datamosh_hijack`), **Stable Fluids** (7.011), **QR Art Illusion** (7.009), **Settings chrome** (7.008), **Live VERSION** (7.007), **docs diet/slim** (7.006/7.004), **FastSAM multimodel Partial** (7.002). 55 reployed tests green; Playwright-proven on both new tabs. | `docs/archive/changelog.md` · **`8.000`** |
| **Flip / Rotate** | Lossless geometry on both the **Single-Clip Ops** dropdown and the **Image Edit** ops stack. One parameterized op (`flip_rotate`) with a shared 6-mode vocabulary (90°-step rotation cw/ccw, hflip/vflip, diagonal `hflip+rotate_90`) driven by one shared builder after the `FLIP_ROTATE_MODES` pattern — same modes on both tabs. Video: new `-R MODE` flag on `transmute` + `bin/transmute` (composes with -c/-b/-s/-S/-z/-x/-r, audio copy), new `/ops/flip_rotate`. ImageEdit: `flip_rotate` stack op implemented on all three engines (ffmpeg `transpose`/`hflip`/`vflip`, ImageMagick `-rotate`/`-flop`/`-flip`, Pillow `Image.Transpose`) — verified pixel-identical across engines. Playwright-proven on both tabs (real clip rotated+flipped, real image vflip through the UI). New `tests/test_fliprotate.py` (5 tests: CLI filter/suffix + dim swap + bad-mode, registry contract, all 3 image engines × all 6 modes). | `transmute` · `bin/transmute` · `transmute_ops.py` · `imageedit_ops.py` · `tabs/transmute.js` · `tabs/imageedit.js` · `utils.js` · `job-control.js` · **`7.017`** |
| **Clearable inputs** | A red ✕ now comes with any populated text box. Portable module (`js/ui/clearable.js` + `css/clearable.css`): drop `data-clearable` on an `<input>`/`<textarea>` and it auto-wires — one attribute, zero JS. ✕ appears only when the field holds content, clears on click (fires `input` + `change` so global sync / probe / form-state keep working), restores focus; values set programmatically (e.g. desk restore, file browser) are picked up via a 250 ms self-sync poller, and a MutationObserver upgrades dynamically rendered forms. Wired on the four global inputs (Video/Image/**Path in**/**Path out**) where the ✕ actually clears the box now; the old misleading ❌ “not used by this tab” status glyph (read as a dead clear button) is gone. Playwright-proven: ✕ appears⇄clears on real typed/picked values, panel un-populates, quick buttons deactivate. **Roll-out to every existing text box is a systematic follow-up.** | `app/static/js/ui/clearable.js` · `app/static/css/clearable.css` · **`7.016`** |
| **Unified Speed: Keep the Change** | RIFE **Free** overage is now spendable: `keep_extra` **trim** (drop `G−R`, exact — default), **fps** (encode all `G` inside target duration, rate rises to `G/T`), **length** (encode all at the output rate, duration stretches to `G/F`, effective speed recomputed). `keep_extra='fps'` is rejected when `target_fps` is pinned (validator + UI: the FPS raise button is disabled while Output FPS is Auto·Match). Speed tab rebuilt to per-variable **Control/Auto** (Multiplier ⇄ Length; auto row shows the derived value live and is inert), Keep the Change segmented row, and live readout notes (`dropping N → target`, `encode all @ FPS`, `encode all → duration`). Frontend `resolveUsPlan` mirrors backend 1:1 again. 5 new tests (16 speed plan/execute/validator); Playwright-proven on real clip: 0.3× Free ⇒ 140 generated / 117 target / drop 23; fps ⇒ `encode all @ 28.8 FPS`; length ⇒ `encode all → 5.83s`; dry-run payload carries `keep_extra` and backend accepts it. | `app/operations/speedchange_ops.py` · `app/static/js/tabs/speedchange.js` · `app/static/css/forms.css` · `unified-speed-tab-spec.md` · **`7.015`** |
| **Unified Speed & Time** | Speed factor is now a single deterministic model: per-frame FPS is locked to source, `T = D/S`, `R = T×F`. Target Mode = **Length** (exact output duration, speed derived) or **Multiplier** (exact speed factor). Optional RIFE with **Snap** (speed locks to `1/M`, zero extra frames) or **Free** (next M with `G=N×M ≥ R`, extra frames dropped by a conforming encode). Replaces the old Speed + RIFE Slo-Mo split and fixes the wrong final-duration estimate (e.g. 4s @ 0.5× now reports 8.00s, not 2.6s). UI readout mirrors backend `resolve_speed_plan` 1:1, live in Multiplier/Length/RIFE-Snap/Free. Fast path pure ffmpeg `setpts`+`fps`+`atempo`; RIFE path dump→×M→conform→encode@F. 13 backend unit tests; Playwright proof on real testsrc (RIFE 0.5× snap → exactly 4.000s / 96 frames @ 24fps; fast 2× → 24 frames; readout 0.3× Free ⇒ 400 target / 480 generated / overshoot 80). | `app/operations/speedchange_ops.py` · `app/static/js/tabs/speedchange.js` · `unified-speed-tab-spec.md` · **`7.014`** |
| **Visual Hijack / Mosh-up** | Motion-vector payload injection. Full pipeline in `app/operations/datamosh/common.py` (`_execute_hijack_pipeline`) + handler (`hijack.py`). Register `datamosh_hijack` op with `inject_mode` (file/frame/video/shuffle), `start_frame`, `end_frame`, `transition_style` (smear/freeze), `mv_multiplier`. CLI `-H IMG:START:END[:STYLE]` in both `transmute` and `bin/transmute`. `visualhijack` per_frame filter registered in `app/filters/`. 9 unit tests + 4 POC validation tests passing. Zero decoder errors, zero green pixels, frame count preserved. Mosh-ups implemented from Parker Higgins' multiple video sources technique. | `app/operations/datamosh/hijack.py` · `app/operations/datamosh/common.py` · `app/filters/visualhijack.py` · **`7.013`** |
| **FastSAM multimodel** | Phase 1 (FastSAM-s/x) shipped in `ac25a60`. Phase 2 (SAM ViT-L/H) still deferred. | `fastsam-sam-multimodel-spec.md` · **`7.002` Partial** |
| **Stable Fluids sim** | Phase 1 (self-host + iframe + Record) **+ Phase 2 pure WebGPU port** (advect / pressure / project) **+ Phase 3 seed-image injection** (dedicated path or first Image Pool still). Mode toggle in the tab; Record shared across modes. | `stablefluids-sim-spec.md` · **`7.011`** |
| **QR Art Illusion** | Two stills, no QR Data. Same worker. Mode switch on QR tab. | `qr-illusion-art-spec.md` · **`7.009`** |
| **Settings chrome** | No page title / knob how-to. Cards start immediately. | **`7.008`** |
| **Live VERSION** | One file (`VERSION`). WebUI brand reads `/health`. STATUS does not restate the digits. | **`7.007`** |
| **Docs STATUS diet** | STATUS is now a map; diary moved to changelog. | **`7.006`** |
| **Docs slim pass 3** | Prompts, legacy renaming, and sequence spec cleanup. | **`7.004`** |

**Next:** human names the next job.

**Ready to build (spec written, not shipped):**
- **Python Environment card (uv)** — Settings card listing every dependency (required vs installed, Missing/Update/Extra/Protected), checkboxes + mass **Install/Upgrade/Remove** via `uv` through the existing op/job machinery. Spec: `docs/venv-deps-card-spec.md`.

---

## 1. Product in one paragraph

**ffTransmuteWebui** = bash `transmute` / datamosh + **mtapi** FastAPI (`:24590`) + vanilla SPA. Frame effects: **filter platform** (`dump → app/filters/* → encode`). Dual pools: **Video** (`items[]`) + **Image** (`images[]`). Jobs: `/tmp/mtapi_jobs/{id}/` + `job_control`. OpenVINO (FastSD GPU): img2img, txt2img, agent vision/prompts, RIFE recoherence. **Prompt Library** saves ± pairs in `localStorage` across SD tabs.

---

## 2. Agent roles (short)

Hats for a turn. The human names the owner in the prompt — not a permanent roster.

| Role | Edits | Deliverable |
|------|-------|-------------|
| Spec writer | `docs/**` only | Specs / STATUS — **no** app code |
| Builder | code + docs | Working feature; WebUI smoke |
| Reviewer | reports | Diff vs spec |

Prefer **STATUS + as-built specs** over backlog drafts. Filter platform only for frame effects. VERSION: far-right `DD` per feature.

---

## 3. Shipped (stable)

| Area | Now | Spec / code |
|------|-----|-------------|
| Filter platform | dump → `app/filters/*` → encode. No second dump/encode stack. | `filter-platform-spec.md` |
| Convert / Export | codecs, `frames_*`, GIF | `convert_ops.py`, `convert_presets.py` |
| Transmute / datamosh | geometry CLI + file-level glitch | `transmute_ops.py`, `operations/datamosh/` |
| Neural / frame ops | deepdream, withoutbg, style, facemorph, img2img, txt2img, upscale, qr_art (QR + Illusion), FastSAM-s/x (Phase 1) | `*_ops` + `filters/` |
| RIFE | directory stage; multiplier **2–128**; recohere (2 stills → M=2 → img2img every mid, keep all) | `filters/rife.py`, `rife-recoherence-spec.md` |
| Speed | uniform + PNG ramp; optional RIFE | `speedchange_ops.py`, `speedramp_ops.py` |
| Dual pools + Cut | Video `items[]` vs Image `images[]`. Cut = global Video + frame range + encode. | `video-image-pools-spec.md` |
| Pool wall | one prepared JPEG (first\|last combo default); stable `<img>`; never clear `src` | `pool-wall-preview-spec.md` |
| Sequence / Join | stitch; codec export (file→file for DNxHR/ProRes); Instant RIFE; variants; total time | `sequence_*.md` under `docs/` |
| Catalog | server-resident index + virtualizer (chrome recycle; wall tenants stay) | `server-memory-catalog-spec.md` |
| Jobs / progress | in-memory FIFO; live preview; dir watch on frame writers | `job_queue.py`, `workspace-progress-spec.md` |
| Persistence | desk snapshot; if a named project is open, pool saves write that file too. Session autosave never overwrites a named file on its own | `universal-persistence-spec.md` |
| Agent + Prompt Library | CLI/HTTP vision; ± pairs in `localStorage` | `agent-vision-tab-spec.md`, `prompt-library-spec.md` |

**Active ops (registry):** transmute, convert, pipeline, datamosh, deepdream, facemorph, withoutbg, fastsam, style, rife, **rife_recohere**, speedchange, speedramp, zoompan, imagesort, img2img, txt2img, agent, upscale, **qr_art** *(in tree — see §4)*.
---

## 4. Partial / in progress (do not mark done)

| Area | Status | Next |
|------|--------|------|
| **Catalog virtualization** | Hover/queues/Image+Video virt in `5.37` | Headed vsync 16.6ms compositor p95 — `catalog-interaction-virtualization-spec.md` |
| **Workspace progress** | RIFE + **dump dir watch** in tree | multi-phase remaining ETA polish — `workspace-progress-spec.md` |
| **Tool bottom docs** | Several tabs have blocks; not universal | Finish roll-out — `tool-bottom-docs-spec.md` |
| **UI list / sequence keys** | Sequence L/R + scroll-into-view **shipped `4.64`**; some pool edge cases may remain | `ui-list-nav-timer-spec.md` |
| **Agent polish** | Phase A+API shipped | Streaming, Image Pool send-to, Ollama, multi-tool loop |
| Image Sort true TSP | Out of scope | Chain is greedy only |


---

## 5. Roadmap — specs still to implement

Build **only when human prioritizes.** Suggested order in §8.

### 5.1 Priority queue (cleaned specs)

| # | Spec | Intent | Notes |
|---|------|--------|--------|
| 1 | Finish remaining §4 partials | Daily UX + headed 16.6ms compositor p95 + verify upscale | Catalog index shipped `5.38` |
| 4 | [tilagup-mtapi-mode-spec.md](tilagup-mtapi-mode-spec.md) | Multi-step agent tiled SD | Sibling `/home/m/snc/cod/tilagup` |
| 5 | [image-quality-rating-spec.md](image-quality-rating-spec.md) | Pool tech/aesthetic scores | **Fix pool normalize first** |
| 6 | [fastsam-sam-multimodel-spec.md](fastsam-sam-multimodel-spec.md) | **FastSAM + SAM multimodel selector** — stronger backends (FastSAM-x, SAM ViT-L/H) | Phase 1 shipped, Phase 2 deferred (not ready for builder). |
| 7 | [performance-settings-spec.md](performance-settings-spec.md) | Performance settings tab, thumbnail resolution, and RAM cache prefs | **Proposed** — budget setting later |


### 5.2 Recently shipped (orientation)

Version diary: [archive/changelog.md](archive/changelog.md).

### 5.3 Research (not a solo build ticket)

| Spec | Intent |
|------|--------|
| [fastsdcpu-upscalers-spec.md](fastsdcpu-upscalers-spec.md) | FastSD upscale catalog (Intel) |
| [amused-openvino-spec.md](amused-openvino-spec.md) | aMUSEd txt2img OpenVINO (proposed) |

### 5.4 Other open product specs (top-level)

| Spec | Intent |
|------|--------|
| [unified-speed-tab-spec.md](unified-speed-tab-spec.md) | **Unified Speed & Time Tab** — UI redesign for deterministic time manipulation, consolidating Speed and RIFE. |
| [audio-analysis-spec.md](audio-analysis-spec.md) | BPM / key / analysis |
| [automation-spec-legacy.md](automation-spec-legacy.md) / [parameter-automation-spec.md](parameter-automation-spec.md) | Parameter envelopes |
| [dynamic-mixing-spec.md](dynamic-mixing-spec.md) | Dynamic mix |
| [model-manager-spec.md](model-manager-spec.md) | Model manager UI |
| [frame-scrubber-spec.md](frame-scrubber-spec.md) / [frame-range-spec.md](frame-range-spec.md) | Scrubber / range (partial surface exists) |
| [sequencer-mvp-spec.md](sequencer-mvp-spec.md) / [seq-proportional-spec.md](seq-proportional-spec.md) | Sequencer |
| [pool-toggle-spec.md](pool-toggle-spec.md) | Pool toggles |
| [qr-illusion-art-spec.md](qr-illusion-art-spec.md) §0 | **Illusion mode** — pattern still + appearance still; no QR Data. Spec locked. Builder: [coder-qr-illusion-prompt.md](coder-qr-illusion-prompt.md). |


### 5.5 Backlog ops (`docs/backlog/*`) — not implemented

~28 draft ops. Prefer cleaned top-level specs when both exist. **Human priority only.**

| Spec | Intent |
|------|--------|
| [upscale-spec.md](backlog/upscale-spec.md) | NCNN Real-ESRGAN / SRMD — **code may be partial in tree** |
| [swinir-spec.md](backlog/swinir-spec.md) | Denoise/deblur |
| [sd-tiled-upscale-spec-legacy.md](backlog/sd-tiled-upscale-spec-legacy.md) | **Legacy** → tilagup-mtapi |
| [depthmap-spec.md](backlog/depthmap-spec.md) | MiDaS depth |
| [opticalflow-spec.md](backlog/opticalflow-spec.md) | Flow maps |
| [facerestore-spec.md](backlog/facerestore-spec.md) | CodeFormer |
| [colorize-spec.md](backlog/colorize-spec.md) | DDColor |
| [inpaint-spec.md](backlog/inpaint-spec.md) | Generative inpaint |
| [latentmorph-spec.md](backlog/latentmorph-spec.md) | Latent interp |
| [lineart-spec.md](backlog/lineart-spec.md) | Line art |
| [slitscan-spec.md](backlog/slitscan-spec.md) | Slit-scan |
| [videoecho-spec.md](backlog/videoecho-spec.md) | Video echo |
| [glitch-spec.md](backlog/glitch-spec.md) / [ffglitch-spec.md](backlog/ffglitch-spec.md) | Databend / broader glitch |
| [codecview-spec.md](backlog/codecview-spec.md) | Codec MV overlay |
| [lut-spec.md](backlog/lut-spec.md) | LUT grade |
| [ascii-spec.md](backlog/ascii-spec.md) | ASCII render |
| [vqgan-spec.md](backlog/vqgan-spec.md) | VQGAN |
| [timelapse-spec.md](backlog/timelapse-spec.md) | Timelapse |
| [audioproc-spec.md](backlog/audioproc-spec.md) / [audiowave-spec.md](backlog/audiowave-spec.md) / [audio-reactive-spec.md](backlog/audio-reactive-spec.md) | Audio suite |
| [analyzetag-spec.md](backlog/analyzetag-spec.md) | Analyze tag songs |
| [mediaexport-spec.md](backlog/mediaexport-spec.md) | Palette / export |
| [civitai-spec.md](backlog/civitai-spec.md) | CivitAI cloud |
| [telemetry-spec.md](backlog/telemetry-spec.md) | Telemetry / WS |
| [global-inputs-spec-legacy.md](backlog/global-inputs-spec-legacy.md) / [global-media-ui-spec-legacy.md](backlog/global-media-ui-spec-legacy.md) | Mostly superseded by dual pools |

`coder-*-prompt.md` files = kickoff text only.

---

## 6. Known bugs / product debt

2. **List reorder** jumps scroll to top.  
3. **Arrows** scroll page outside wired list tabs.  
5. **High RIFE M** × large K = huge jobs; no soft warn.  
6. Pool **normalize strips unknown fields** — blocks quality rating.  
7. Large **uncommitted** tree risk — `git status` before ship/push.  
8. **Speed tab RIFE ≈10× slower than Sequence Instant RIFE** (unresolved). Same clip/workflow — 4–6 s, 720×720–1080×1080, TTA on, interpolate to 60 fps — normally ~2–3 min, Speed tab ~17 min. Both paths call the identical `run_rife_directory` (`rife_ops.py` vs `speedchange_ops.py`) with identical flags and matching multiplier math, so no code path found yet; candidates: real M/length mismatch between tabs, TTA path, or Sequence reusing cached variant, none confirmed. Troubleshooting deferred.


---

## 7. VERSION & runtime

- **Current:** root `VERSION` (FastAPI `/health` and the WebUI brand read it). Diary: `docs/archive/changelog.md`.
- Secrets: `~/.secrets` at startup.
- Server: `cd mtapi-project && .venv/bin/python run.py` → `http://localhost:24590/`
- Jobs: `~/.cache/mtapi/jobs` (override `MTAPI_JOBS_ROOT`)
- FastSD: `MTAPI_FASTSD_ROOT` (img2img / txt2img / recohere)
- RIFE: `rife-ncnn-vulkan` on PATH
- Prompt library: browser `localStorage` key `mtapi_prompt_library`
- NCNN bins: may live under `mtapi-project/bin/`

---

## 8. Suggested build order (roadmap)

1. Close remaining §4 partials (list/sequence keys, progress polish, tool-docs, headed 16.6ms compositor).  
3. **Product choice:** quality rating *or* tilagup mode.  
4. Agent polish (streaming / Ollama) when vision UX needs it.  
5. Explicit backlog picks only (depth, flow, facerestore, …).


---

## 9. Doc maintenance

On ship: bump root `VERSION` → update **this file** (top box + §3/§4 if the map changed) → update spec banner. Do not paste the version digits into this file.

**STATUS wins** when it disagrees with a stale backlog draft.
