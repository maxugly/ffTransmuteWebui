# Project status — agent & human source of truth

> **Updated:** 2026-08-03  
> **VERSION:** `000.000.4.59`  
> **Branch:** `main` (local may be ahead of origin — check `git status`)  
> **Purpose:** Where we are. What is shipped, partial, or spec-only. Agents **must** read this before inventing features or re-speccing shipped work.

**Also read:** `AGENTS.md` (root) · `mtapi-project/AGENTS.md` · this folder’s [README.md](README.md) doc index · [SESSION-STOPPING-STATE.md](SESSION-STOPPING-STATE.md) for last handoff narrative.

---

## 1. Product in one paragraph

**ffTransmuteWebui** = bash `transmute` / datamosh + **mtapi** FastAPI (`:24590`) + vanilla SPA. Frame effects use the **filter platform** (`dump → app/filters/* → encode`). Dual media libraries: **Video Pool** (`items[]`) and **Image Pool** (`images[]`). Long jobs use `/tmp/mtapi_jobs/{id}/` and `job_control` progress.

---

## 2. How agents must behave

| Role | May edit | Deliverable |
|------|----------|-------------|
| **Spec writer** (agy, grok, bones) | `docs/**` only | Specs / status / research — **no** app code |
| **Builder** (codewhale, codex, opencode) | code + docs as needed | Working op/UI; WebUI smoke on `/tmp/teste.mp4` or `.png` |
| **Reviewer** | reports only | Diff vs spec; do not “fix while reviewing” unless asked |

**Rules of engagement**

1. Prefer **STATUS + as-built specs** over backlog drafts and Gemini one-shots.  
2. Do **not** reimplement dump/encode inside new ops — filter platform only.  
3. Do **not** claim DONE without WebUI verification when UI was touched (see root `AGENTS.md` §D).  
4. Specs marked **Implemented** are law for behavior; change code + bump status together.  
5. Specs marked **Spec / research** are not code. Build only when human prioritizes.  
6. Sibling project **tilagup** lives at `/home/m/snc/cod/tilagup` — port via `tilagup-mtapi-mode-spec.md`, do not silently merge.  
7. VERSION: far-right `DD` per feature; third segment for significant releases.

---

## 3. Shipped (stable — leave alone unless bugs)

| Area | Notes | Spec / code |
|------|--------|-------------|
| Filter platform | dump / stages / encode | `filter-platform-spec.md`, `video_pipeline.py`, `filters/*` |
| Convert / Export | codecs, frames_*, GIF | `convert_ops.py`, `convert_presets.py` |
| Transmute geometry | CLI wrapper | `transmute_ops.py`, root `transmute` |
| Datamosh | melt, classic, … | `operations/datamosh/` |
| DeepDream / withoutBG / style / facemorph | neural / multi-source | respective `*_ops` + filters |
| RIFE directory stage | shared by RIFE tab + pipeline + Image Sort | `filters/rife.py` |
| Speed change + ramp | optional RIFE | `speedchange_ops.py`, `speedramp_ops.py` |
| Zoompan | still → video | `zoompan_ops.py` |
| Dual pools + Cut basics | Video/Image Pool, sequence, global-range Cut | `video-image-pools-spec.md` |
| Image Sort → Video | list, rank, conform, optional RIFE, encode | `image-sort-rife-spec.md` |
| Image Sort **chain** strategy | radial \| **closest next** | `image_sort/rank.py`, UI Strategy select |
| Image Sort **bottom docs** | `.tool-docs` About block (pilot) | `tool-bottom-docs-spec.md` (pilot **shipped**) |
| RIFE multiplier **2–128** | knobs + API (not list length — list was never capped) | imagesort / rife / speed / ramp |
| **Img2img (OpenVINO)** | Pipeline stage + `/ops/img2img` + **WebUI tab** | `filters/img2img.py` |
| **Txt2img (OpenVINO)** | `/ops/txt2img` + **WebUI tab** generate stills | `txt2img_ops.py`, `txt2img_ov_worker.py` |
| **Agent tab** | Chat + images; CLI + **DeepSeek/OpenRouter/xAI/… API** from `~/.secrets` | `agent_ops.py`, `agents/http_api.py`, `agents/secrets.py` |
| Job progress core | phase-local rate/ETA, history, cancel | `job_control.py` |
| RIFE **dir watch** | counts `frames_out` while binary runs | `start_dir_watch` in `filters/rife.py` |
| Pre-run summary | Image Sort, RIFE, Speed, Face Morph | `ui/pre-run-summary.js` |
| Run-button elapsed | sticky `● m:ss` — **keep** | `job-control.js` |
| list-keys (partial) | Image Sort, Face Morph, withoutBG, Style | `ui/list-keys.js` |

---

## 4. Partial / in progress

| Area | Status | Next |
|------|--------|------|
| Workspace progress | Core + RIFE watch **in tree**; dump watch & multi-phase remaining ETA open | Finish `workspace-progress-spec.md` checklist |
| Tool bottom docs | **Image Sort only**; pattern for other tabs | Roll out per `tool-bottom-docs-spec.md` |
| UI list / sequence keys | Partial; sequence L/R + scroll-into-view open | `ui-list-nav-timer-spec.md` |
| Universal desk persistence | Spec only — autosave can clobber projects | `universal-persistence-spec.md` |
| Cut encode | Not implemented | filter-platform dump+encode when built |
| Image Sort zones-class path | N/A in mtapi; chain is greedy only | true TSP out of scope |

---

## 5. Spec-only / next build

### 5.0 Recently shipped (was BUILD NEXT)

| Spec | Status |
|------|--------|
| [img2img-openvino-spec.md](img2img-openvino-spec.md) | **Implemented** `000.000.4.55` — stage + op; UI tab optional follow-up |

### 5.0b Recently shipped (agent)

| Spec | Status |
|------|--------|
| [agent-vision-tab-spec.md](agent-vision-tab-spec.md) | **Implemented** Phase A `000.000.4.58` — Agent tab + agy/grok/stub + image_to_prompt |

### 5.1 Other specs (do not build unless prioritized)

| Spec | Intent |
|------|--------|
| [job-queue-spec.md](job-queue-spec.md) | FIFO op queue + Jobs tab |
| [tilagup-mtapi-mode-spec.md](tilagup-mtapi-mode-spec.md) | Multi-step agent tiled SD (after agent + img2img) |
| [image-quality-rating-spec.md](image-quality-rating-spec.md) | Pool tech/aesthetic quality scores |
| [fastsdcpu-upscalers-spec.md](fastsdcpu-upscalers-spec.md) | Research: FastSD upscale catalog |
| [backlog/upscale-spec.md](backlog/upscale-spec.md) | Real-ESRGAN / SRMD NCNN |
| [backlog/sd-tiled-upscale-spec.md](backlog/sd-tiled-upscale-spec.md) | **Legacy** → prefer tilagup-mtapi |
| [backlog/swinir-spec.md](backlog/swinir-spec.md) | Denoise/deblur |
| Most of `docs/backlog/*` + `coder-*-prompt.md` | Future ops |
| Universal persistence | Full desk save redesign |

---

## 6. Known bugs / product debt

1. **Autosave can overwrite named projects** (sequence clear / Save As) — persistence spec.  
2. **List reorder** often jumps scroll to top.  
3. **Arrows** scroll page outside well-wired list tabs.  
4. **Inactive tab knobs** not in project JSON (DOM destroyed on tab switch).  
5. **High RIFE M** (e.g. 128) on large K or long video = huge jobs — intentional for 2-still morphs; no soft warn yet.  
6. Pool **normalize strips unknown fields** (`path/name/hash/size` only) — quality rating must fix this first.

---

## 7. VERSION & tree notes

- Current: **`000.000.4.59`** (Agent HTTP/DeepSeek + prior).  
- Secrets: `~/.secrets` (`export DEEPSEEK_API_KEY=…`) loaded at startup (key names only in logs).  
- Uncommitted tree likely includes img2img + earlier session work — **`git status`**.  
- Server: `cd mtapi-project && .venv/bin/python run.py` → `http://localhost:24590/`  
- Jobs: `/tmp/mtapi_jobs/`  
- Img2img needs FastSD env: `MTAPI_FASTSD_ROOT` default `…/scratch/fastsdcpu`

---

## 8. Suggested build order (human priority; agents wait for assignment)

1. Agent polish (streaming, Image Pool send-to, Ollama) if desired.  
2. Finish workspace progress polish if still gappy.  
3. UX: sequence keys + scroll retention.  
4. Job queue — `job-queue-spec.md`.  
5. Universal persistence.  
6. Tilagup mode / NCNN upscale / quality rating (product choice).  
7. Roll `.tool-docs` to more tabs.

---

## 9. Doc maintenance rule

When shipping a feature:

1. Bump `VERSION` (DD).  
2. Update **this file** (STATUS) shipped/partial tables.  
3. Set the feature spec banner to **Implemented** or **Partial** with version.  
4. Touch `SESSION-STOPPING-STATE.md` on meaningful stops.  
5. Keep root `AGENTS.md` op registry in sync for new ops.

**Agents:** if STATUS and a backlog spec disagree, **STATUS wins** until a human updates one of them.
