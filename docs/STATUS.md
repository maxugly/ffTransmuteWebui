# Project status — agent & human source of truth

> **Updated:** 2026-08-04  
> **VERSION:** `000.000.4.63`  
> **Branch:** `main` (local tree often uncommitted — `git status`)  
> **Purpose:** Where we are. **Shipped / partial / remaining roadmap.** Agents **must** read this before inventing features or re-speccing shipped work.

**Also read:** `AGENTS.md` (root) · `mtapi-project/AGENTS.md` · [README.md](README.md) · [SESSION-STOPPING-STATE.md](SESSION-STOPPING-STATE.md)

---

## 1. Product in one paragraph

**ffTransmuteWebui** = bash `transmute` / datamosh + **mtapi** FastAPI (`:24590`) + vanilla SPA. Frame effects: **filter platform** (`dump → app/filters/* → encode`). Dual pools: **Video** (`items[]`) + **Image** (`images[]`). Jobs: `/tmp/mtapi_jobs/{id}/` + `job_control`. OpenVINO (FastSD GPU): img2img, txt2img, agent vision/prompts, RIFE recoherence. **Prompt Library** saves ± pairs in `localStorage` across SD tabs.

---

## 2. Agent roles (short)

| Role | Edits | Deliverable |
|------|-------|-------------|
| Spec writer (agy, grok, bones) | `docs/**` only | Specs / STATUS — **no** app code |
| Builder (codewhale, codex, opencode) | code + docs | Working feature; WebUI smoke |
| Reviewer | reports | Diff vs spec |

Prefer **STATUS + as-built specs** over backlog drafts. Filter platform only for frame effects. VERSION: far-right `DD` per feature.

---

## 3. Shipped (stable)

| Area | Notes | Spec / code |
|------|--------|-------------|
| Filter platform | dump / stages / encode | `filter-platform-spec.md` |
| Convert / Export | codecs, frames_*, GIF | `convert_ops.py`, `convert_presets.py` |
| Transmute geometry | CLI wrapper | `transmute_ops.py` |
| Datamosh | melt, classic, … | `operations/datamosh/` |
| DeepDream / withoutBG / style / facemorph | neural / multi-source | `*_ops` + filters |
| RIFE directory | RIFE tab + pipeline + Image Sort | `filters/rife.py` |
| Speed change + ramp | optional RIFE | `speedchange_ops`, `speedramp_ops` |
| Zoompan | still → video | `zoompan_ops.py` |
| Dual pools + Cut UI | encode still open | `video-image-pools-spec.md` |
| Image Sort → Video | rank, conform, RIFE, encode | `image-sort-rife-spec.md` |
| Image Sort chain | radial \| closest next | `image_sort/rank.py` |
| RIFE multiplier **2–128** | knobs + API | imagesort / rife / speed / ramp |
| Img2img OpenVINO | stage + op + tab + mark frames | `img2img-openvino-spec.md` |
| Txt2img OpenVINO | op + tab | `txt2img_ops.py` |
| Agent tab (Phase A+API) | CLI + HTTP via `~/.secrets` | `agent-vision-tab-spec.md` · `4.59` |
| **RIFE Recoherence** | 2 stills → RIFE M=2 → **img2img every mid** (keep all; no discard) → .mp4 | `rife-recoherence-spec.md` · `4.62` |
| **Prompt Library** | Save/load ± pairs; img2img / txt2img / recohere | `prompt-library-spec.md` · `js/ui/prompt-library.js` · `4.61` |
| Job progress core | phase rate/ETA, cancel | `job_control.py` |
| RIFE dir watch | `frames_out` while binary runs | `filters/rife.py` |
| Pre-run summary | Image Sort, RIFE, Speed, Face Morph | `ui/pre-run-summary.js` |
| Run-button elapsed | sticky `● m:ss` | `job-control.js` |
| list-keys (partial ship) | several list tabs | `ui/list-keys.js` |
| Bottom docs (partial ship) | Image Sort pilot + img2img / txt2img / agent / upscale / recohere | `tool-bottom-docs-spec.md` |

**Active ops (registry):** transmute, convert, pipeline, datamosh, deepdream, facemorph, withoutbg, style, rife, **rife_recohere**, speedchange, speedramp, zoompan, imagesort, img2img, txt2img, agent, upscale *(in tree — see §4)*. Root `AGENTS.md`.

---

## 4. Partial / in progress (do not mark done)

| Area | Status | Next |
|------|--------|------|
| **Workspace progress** | Core + RIFE watch in tree | Dump watch; multi-phase ETA — `workspace-progress-spec.md` |
| **Tool bottom docs** | Several tabs have blocks; not universal | Finish roll-out — `tool-bottom-docs-spec.md` |
| **UI list / sequence keys** | Timer + pre-run done | Sequence L/R, scroll-into-view, page-scroll — `ui-list-nav-timer-spec.md` |
| **NCNN Upscale** | Ops + filter + tab + `bin/*-ncnn-vulkan` **in tree** | WebUI verify → ship STATUS + AGENTS row, or fix gaps — `backlog/upscale-spec.md` |
| **Agent polish** | Phase A+API shipped | Streaming, Image Pool send-to, Ollama, multi-tool loop |
| **Cut encode** | UI only | filter-platform dump+encode |
| **Universal persistence** | **Sacred named-project autosave fixed `4.63`**; full desk snapshot still open | `universal-persistence-spec.md` |
| Image Sort true TSP | Out of scope | Chain is greedy only |

---

## 5. Roadmap — specs still to implement

Build **only when human prioritizes.** Suggested order in §8.

### 5.1 Priority queue (cleaned specs)

| # | Spec | Intent | Notes |
|---|------|--------|--------|
| 1 | Finish §4 partials | Daily UX + verify upscale | High leverage |
| 2 | [job-queue-spec.md](job-queue-spec.md) | FIFO op queue + Jobs tab | Long-job UX |
| 3 | [universal-persistence-spec.md](universal-persistence-spec.md) | Stop autosave clobbering named projects | Bug #1 |
| 4 | [tilagup-mtapi-mode-spec.md](tilagup-mtapi-mode-spec.md) | Multi-step agent tiled SD | Sibling `/home/m/snc/cod/tilagup` |
| 5 | [image-quality-rating-spec.md](image-quality-rating-spec.md) | Pool tech/aesthetic scores | **Fix pool normalize first** |

### 5.2 Recently shipped (orientation)

| Spec | Version |
|------|---------|
| [prompt-library-spec.md](prompt-library-spec.md) | **`000.000.4.61`** |
| [rife-recoherence-spec.md](rife-recoherence-spec.md) | **`000.000.4.60`** |
| [agent-vision-tab-spec.md](agent-vision-tab-spec.md) | Phase A+API **`4.59`** |
| [img2img-openvino-spec.md](img2img-openvino-spec.md) | **`4.55`** + UI tab |
| Txt2img OpenVINO | In tree (op + tab) |
| Image Sort chain, RIFE×128, progress core | ~`4.54` era |

### 5.3 Research (not a solo build ticket)

| Spec | Intent |
|------|--------|
| [fastsdcpu-upscalers-spec.md](fastsdcpu-upscalers-spec.md) | FastSD upscale catalog (Intel) |
| [amused-openvino-spec.md](amused-openvino-spec.md) | aMUSEd txt2img OpenVINO (proposed) |

### 5.4 Other open product specs (top-level)

| Spec | Intent |
|------|--------|
| [audio-analysis-spec.md](audio-analysis-spec.md) | BPM / key / analysis |
| [automation-spec.md](automation-spec.md) / [parameter-automation-spec.md](parameter-automation-spec.md) | Parameter envelopes |
| [dynamic-mixing-spec.md](dynamic-mixing-spec.md) | Dynamic mix |
| [model-manager-spec.md](model-manager-spec.md) | Model manager UI |
| [image-compare-spec.md](image-compare-spec.md) | Image compare |
| [frame-scrubber-spec.md](frame-scrubber-spec.md) / [frame-range-spec.md](frame-range-spec.md) | Scrubber / range (partial surface exists) |
| [sequencer-mvp-spec.md](sequencer-mvp-spec.md) / [seq-proportional-spec.md](seq-proportional-spec.md) | Sequencer |
| [pool-toggle-spec.md](pool-toggle-spec.md) | Pool toggles |

### 5.5 Backlog ops (`docs/backlog/*`) — not implemented

~28 draft ops. Prefer cleaned top-level specs when both exist. **Human priority only.**

| Spec | Intent |
|------|--------|
| [upscale-spec.md](backlog/upscale-spec.md) | NCNN Real-ESRGAN / SRMD — **code may be partial in tree** |
| [swinir-spec.md](backlog/swinir-spec.md) | Denoise/deblur |
| [sd-tiled-upscale-spec.md](backlog/sd-tiled-upscale-spec.md) | **Legacy** → tilagup-mtapi |
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
| [global-inputs-spec.md](backlog/global-inputs-spec.md) / [global-media-ui-spec.md](backlog/global-media-ui-spec.md) | Mostly superseded by dual pools |

`coder-*-prompt.md` files = kickoff text only.

---

## 6. Known bugs / product debt

1. ~~**Autosave can overwrite named projects**~~ → **fixed `4.63`** (session-only autosave; named file only on explicit Save). Full desk snapshot still partial (`universal-persistence-spec.md`).  
2. **List reorder** jumps scroll to top.  
3. **Arrows** scroll page outside wired list tabs.  
4. **Inactive tab knobs** not in project JSON (DOM destroyed on tab switch).  
5. **High RIFE M** × large K = huge jobs; no soft warn.  
6. Pool **normalize strips unknown fields** — blocks quality rating.  
7. Large **uncommitted** tree risk — `git status` before ship/push.

---

## 7. VERSION & runtime

- **Current:** `000.000.4.63` (named-project sacred autosave fix; recohere all-mids `4.62`).  
- Secrets: `~/.secrets` at startup.  
- Server: `cd mtapi-project && .venv/bin/python run.py` → `http://localhost:24590/`  
- Jobs: `/tmp/mtapi_jobs/`  
- FastSD: `MTAPI_FASTSD_ROOT` (img2img / txt2img / recohere)  
- RIFE: `rife-ncnn-vulkan` on PATH  
- Prompt library: browser `localStorage` key `mtapi_prompt_library`  
- NCNN bins: may live under `mtapi-project/bin/`

---

## 8. Suggested build order (roadmap)

Agents wait for human assignment.

1. **Close partials:** list/sequence keys, progress polish, tool-docs gaps.  
2. **Verify / ship NCNN upscale** (code already present).  
3. **Job queue** — line up long ops.  
4. **Universal persistence** — fix sacred named projects.  
5. **Cut encode** — small filter-platform win.  
6. **Product choice:** quality rating *or* tilagup mode.  
7. Agent polish (streaming / Ollama) when vision UX needs it.  
8. Explicit backlog picks only (depth, flow, facerestore, …).

---

## 9. Doc maintenance

On ship: bump VERSION → update **this file** → spec banner → handoff on stops → root `AGENTS.md` registry for new ops.

**STATUS wins** when it disagrees with a stale backlog draft.
