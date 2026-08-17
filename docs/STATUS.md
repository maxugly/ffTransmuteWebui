# Project status — agent & human source of truth

> **Updated:** 2026-08-17  \
> **VERSION:** root `VERSION` file (do not copy the digits here)  \
> **Branch:** `wip`  
> **Purpose:** Where we are. **Shipped / partial / remaining roadmap.** Agents **must** read this before inventing features or re-speccing shipped work.

**Also read:** `AGENTS.md` (root) · [README.md](README.md)

---

## Shipped this stretch / Next assignment

| Area | Notes | Spec / code |
|------|--------|-------------|
| **Docs slim pass 3** | Prompts, legacy renaming, and sequence spec cleanup. | **`7.004`** |
| **Docs STATUS diet** | STATUS is now a map; diary moved to changelog. | **`7.006`** |
| **Live VERSION** | One file (`VERSION`). WebUI brand reads `/health`. STATUS does not restate the digits. | **`7.007`** |
| **Settings chrome** | No page title / knob how-to. Cards start immediately. | **`7.008`** |
| **FastSAM multimodel** | Phase 1 (FastSAM-s/x) shipped in `ac25a60`. Phase 2 (SAM ViT-L/H) still deferred. | `fastsam-sam-multimodel-spec.md` · **`7.002` Partial** |

**Next:** human names the next job.

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
| Neural / frame ops | deepdream, withoutbg, style, facemorph, img2img, txt2img, upscale, qr_art, FastSAM-s/x (Phase 1) | `*_ops` + `filters/` |
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
| [audio-analysis-spec.md](audio-analysis-spec.md) | BPM / key / analysis |
| [automation-spec-legacy.md](automation-spec-legacy.md) / [parameter-automation-spec.md](parameter-automation-spec.md) | Parameter envelopes |
| [dynamic-mixing-spec.md](dynamic-mixing-spec.md) | Dynamic mix |
| [model-manager-spec.md](model-manager-spec.md) | Model manager UI |
| [frame-scrubber-spec.md](frame-scrubber-spec.md) / [frame-range-spec.md](frame-range-spec.md) | Scrubber / range (partial surface exists) |
| [sequencer-mvp-spec.md](sequencer-mvp-spec.md) / [seq-proportional-spec.md](seq-proportional-spec.md) | Sequencer |
| [pool-toggle-spec.md](pool-toggle-spec.md) | Pool toggles |


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
