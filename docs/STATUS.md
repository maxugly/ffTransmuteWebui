# Project status — agent & human source of truth

> **Updated:** 2026-08-14  \
> **VERSION:** `000.000.5.17`  \
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
| **Upscale (NCNN)** | Real-ESRGAN / SRMD + tab + bins | `upscale_ops.py`, `filters/upscale.py` · `4.64` |
| **Cut encode** | Global range dump→encode | `cut_ops.py`, Cut tab · `4.64` |
| **Job queue (v1)** | FIFO in-memory + Jobs tab + Add to Queue | `job_queue.py`, `op_runner.py` · `4.64` |
| **QR & Illusion Art** | QR/Pattern + ControlNet + IP-Adapter | `qr_ops.py`, `qr_art_ov_worker.py`, `js/tabs/qr.js` · `5.05` |
| **Prompt Library** | Save/load ± pairs; img2img / txt2img / recohere | `prompt-library-spec.md` · `js/ui/prompt-library.js` · `4.61` |
| Job progress core | phase rate/ETA, cancel | `job_control.py` |
| RIFE dir watch | `frames_out` while binary runs | `filters/rife.py` |
| **Live preview (all ops)** | `latest_frame` on frame writers; **DeepDream mid-ascent** snapshots to `/tmp/mtapi_live/{token}.png` | `4.70`+`4.71` |
| Pre-run summary | Image Sort, RIFE, Speed, Face Morph | `ui/pre-run-summary.js` |
| Run-button elapsed | sticky `● m:ss` | `job-control.js` |
| list-keys (partial ship) | several list tabs | `ui/list-keys.js` |
| Bottom docs (partial ship) | Image Sort pilot + img2img / txt2img / agent / upscale / recohere / **deepdream** | `tool-bottom-docs-spec.md` |
| **DRY staged job** | `run_staged_job` shared bookend runner; rife / cut / upscale-video / speedramp migrated | `app/staged_job.py`, `coder-dry-platform-prompt.md` · `4.65` |
| **Run/Queue collect unified** | Single `resolveActiveOpAndBody()` shared by Run + Add to Queue | `js/job-control.js` · `4.65` |
| **Bottom input preview** | Every op tab shows input thumb(s) at panel bottom (after docs); dual for style/recohere/guide | `js/ui/input-preview.js` · `4.66` |
| **DeepDream bottom docs** | Full noob-friendly story + every knob + recipes | `js/tabs/deepdream.js` · `4.67` |
| **DeepDream Evolve video** | Mid-ascent capture → Image Sort dedupe → optional RIFE → `*_evolve.mp4` (stills) | `deepdream-evolve-video-spec.md` · `4.73` |
| **Style Evolve + shared bookend** | Strength ramp (1 neural pass) → `app/evolve_video.py` RIFE/encode DRY | `styletransfer` · `4.74` |
| **Evolve DRY cleanup** | Shared `EvolveRifeParams` + `js/ui/evolve-rife.js` (DeepDream + Style tabs) | `evolve_video.py`, `evolve-rife.js` · `4.75` |
| **DeepDream dead-path scrub** | Removed unused sync `dream_video`/`dream_ouroboros`; shared RIFE model select across tabs | `dream.py`, `evolve-rife.js` · `4.76` |
| **Dead-code pass 3** | Dropped unused helpers/shims; wired `frame_range` fields across video ops | `shell`, engines, `*_ops` · `4.77` |
| **Image Compare tab** | Two stills · separate/overlay/A/B (shared module) · rate via `imagesort_rank` | `js/tabs/imgcompare.js` · `4.68` |
| **Nav category collapse** | Collapsible sidebar categories + localStorage persist + auto-expand active | `nav-collapse-spec.md` · `js/ui/nav-sections.js` · `4.69` |
| **Join codec export** | `target` preset id from `/api/presets`; Python `concat_clips` stitch → codec preset encode (DNxHR/ProRes/H.264/HEVC/AV1/FFV1) | `concat_clips` (`video_pipeline.py`), `JoinParams.target`, `/api/presets` · `4.81` |
| **RIFE in Join** | `use_rife` + `target_fps`; smallest 2^k overshoot + exact resample (no 72/96 leak); mux original audio; registers `rifed` variant | `transmute_ops._rife_preprocess`, `sequence_rife_interpolation_spec.md` · `4.81` |
| **Clip variant registry** | `register_variant` / `get_variants` + `/api/variants`; kinds original/rifed/export; association in central cache (no sidecar) | `cache.py`, `sequence_clip_variant_registry_spec.md` · `4.81` |
| **Unified Join Frontend** | Format dropdown (populated from `/api/presets`) + RIFE toggle/fps + variant nodes under pool cards | `js/pool/grid.js`, `js/pool/persistence.js`, `sequence_join_unified_frontend_spec.md` · `4.81` |
| **Simplify pass** | 3-agent review; collapsed per-clip triple-probe → single `probe()`; `asyncio.gather` on probe/hash; shared `RECENT_CAP`; dropped datamosh import | `simplify-code` skill · `4.81` |
| **/api/variants hardening** | Index-only lookup (`lookup_cached_hash`), never hashes caller input on GET (closes CPU/IO amplification) | `sequence_api_variants_security_spec.md` · `4.81` |
| **FastSAM fixes** | Accurate unpadded coordinate clicks (`cv2.pointPolygonTest` on `masks.xy`); 'Everything' mode outputs clean `_assets` directory; native system folder opener `/api/open-folder` | `fastsam_ops.py`, `fastsam.py` · `4.82` |
| **Seq Instant RIFE fix** | Correct slow-mo effective-fps (content density); Instant job progress | `sequence.js`, `transmute_ops._rife_preprocess` · `4.83` |
| **Instant RIFE queue + Stop** | FIFO client queue (no frame skip); main Run busy for whole batch; Stop cancels current + drops queue; Stitch via same path | `sequence.js`, `job-control.js`, `persistence.js` · `4.84` |
| **Instant RIFE badges/strip** | Token badges NEED/Q#/RUN/OK/FAIL + ORIG/RIFED file control; status strip above sequence | `sequence.js`, `pool.css` · `4.85` |
| **Job Stop pulse** | Main Stop pulses + shows elapsed whenever any job/Instant batch is busy | `job-control.js`, `forms.css` · `4.86` |
| **Instant RIFE auto-kick** | Meta-on-Sequence-tab, Time input debounce, post-render scan, Instant enables RIFE | `sequence.js`, `items.js`, `grid.js` · `4.87` |
| **Instant RIFE force probe** | Turning Instant ON probes all seq clips then queues densify; explicit empty-state strip | `ensureSequenceMetaAndInstantScan` · `4.88` |
| **Instant RIFE crash fix** | Fixed missing `_updateSeqVariantBadges` (broke all sequence render + Instant) | `sequence.js` · `4.89` |
| **Instant RIFE densest-wins** | Mid-flight Time/target raise soft-aborts and re-densifies; keep highest M (drop frames later) | `sequence.js`, `abortMainJob soft` · `4.90` |
| **Join preset = file→file transcode** | No dump→PNG for DNxHR/ProRes stitch; normal ffmpeg re-encode | `transcode_with_preset`, `_join_with_preset` · `5.00` |
| **Job workspace on disk** | Default `~/.cache/mtapi/jobs` (not /tmp tmpfs); override `MTAPI_JOBS_ROOT` | `job_workspace.py` · `4.99` |
| **Jobs tab live desk** | Read-only: live server ops + FIFO + Instant queue + done | `jobs.js`, `job_control.list_live_and_recent`, queue snapshot · `4.98` |
| **Sequence token size + layout** | Two-row chips; W/H ± size; min-width stops badge spill | `sequence.js`, `pool.css` · `4.97` |
| **Match click selects pool card** | Clear filter, uncollapse pool, re-render + scroll on match row/Select | `grid.js` · `4.96` |
| **Select RIFED sets multiplier** | Variant menu writes `_rifeMultiplier`; badge uses haveM so NEED does not stick after pick | `sequence.js` · `4.95` |
| **QR Art Generator** | Scannable QR + ControlNet QR Monster (OpenVINO img2img) + optional IP-Adapter (PyTorch ControlNet+IP-Adapter). Scannability badge via pyzbar. | `qr_ops.py`, `qr_art_ov_worker.py`, `js/tabs/qr.js` · **`5.04`** |
| **State tracking / popup spam** | Hydration-complete gate prevents Instant RIFE re-queue on project load; busy-block alerts replaced with logConsole | `sequence.js`, `job-control.js`, `pool/persistence.js` · **`5.02`** |
| **Sequence Audio Engines** | Rubberband DAW flags + 48kHz sample-rate fix + 10ms micro-fade; engine dropdown UI | `sequence-audio-engines-spec.md`, `video_pipeline.py`, `grid.js`, `persistence.js` · **`5.01`** |
| **Instant reuses existing densify** | Hydrate from /api/variants + persist rife_multiplier; NEED only if M insufficient | `sequence.js`, `persistence.js`, `cache.get_variants` · `4.94` |
| **Single-flight restore** | Soft-cancel must not abort fetch (orphaned server job); server rejects concurrent /ops/* | `job-control.js`, `job_queue.py`, `main.py` · `4.93` |
| **Instant re-render storm fix** | Queue no-op no longer re-renders; variants cache; failed no tight-retry; dual RIFE killed | `sequence.js`, `grid.js` · `4.92` |
| **Settings tab (blank)** | Workspace · bare chrome (no global/preview/Run); scaffold for perf prefs | `js/tabs/settings.js`, `css/settings.css` · `4.91` |
| **Universal persistence** | Full desk snapshot: metadata + signatures round-trip, `/api/media_signature`, shared lazy-loader (100px margin, max-5 fallback), settings precedence (project loads never overwrite globals), schema v2 migration, inactive-tab formState | `universal-persistence-spec.md` · **`5.06`** |
| **Settings layout polish** | Tight one-page cards hug content width; Neural FX blurb wraps after “Default is off” | `settings.js`, `settings.css` · **`5.12`** |
| **Settings card layout spec** | House style so new Settings cards ship tight (one-line head, packed controls, max-content width) | `settings-card-layout-spec.md` · **`5.13`** |
| **Catalog UX Phase 1** | Cache-first eager restore; `POST /api/media_signatures` + `POST /api/variants/batch` (max 100); `window.globalMediaIndex`; persisted-variant fast path (zero variant requests when dense enough); Instant RIFE COW + hash recovery + unreferenced lower-density GC | `performance-catalog-ux-spec.md` · **`5.14`** |
| **Hash-only thumbnail 500** | Hash URLs resolve a recorded source path, skip `thumb_failed` extracts, return 404 not 500; thumb `onerror` no longer POSTs `/api/media/recover` | `thumbnails.py`, `freshness.js` · **`5.15`** |
| **Thumbnail load speed** | Hash-only serve of an existing JPEG does not parse `record.json` or scan `index.json`; browser assigns at most 8 in-flight thumb `src`s | `media.py`, `lazy-loader.js` · **`5.16`** |
| **Eager-thumb regression** | Default is viewport-lazy again. `preloadAllThumbnails` is opt-in. Restored meta still paints without re-probe. | `lazy-loader.js` · **`5.17`** |

**Active ops (registry):** transmute, convert, pipeline, datamosh, deepdream, facemorph, withoutbg, fastsam, style, rife, **rife_recohere**, speedchange, speedramp, zoompan, imagesort, img2img, txt2img, agent, upscale, **qr_art** *(in tree — see §4)*. Root `AGENTS.md`.

---

## 4. Partial / in progress (do not mark done)

| Area | Status | Next |
|------|--------|------|
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
| 1 | Finish §4 partials | Daily UX + verify upscale | High leverage |
| 2 | [job-queue-spec.md](job-queue-spec.md) | **Implemented v1 `4.64`** — memory FIFO + Jobs tab | Persist pending = later |
| 3 | [universal-persistence-spec.md](universal-persistence-spec.md) | **Implemented `5.06`** — desk snapshot + metadata + lazy-load | Bug #1 closed |
| 4 | [tilagup-mtapi-mode-spec.md](tilagup-mtapi-mode-spec.md) | Multi-step agent tiled SD | Sibling `/home/m/snc/cod/tilagup` |
| 5 | [image-quality-rating-spec.md](image-quality-rating-spec.md) | Pool tech/aesthetic scores | **Fix pool normalize first** |
| 6 | [fastsam-sam-multimodel-spec.md](fastsam-sam-multimodel-spec.md) | **FastSAM + SAM multimodel selector** — stronger backends (FastSAM-x, SAM ViT-L/H) on OpenVINO/Intel, AUTO device fallback | **`4.82`+ proposed** |
| 7 | [performance-settings-spec.md](performance-settings-spec.md) | Performance settings tab, thumbnail resolution, and RAM cache prefs | **Proposed** |

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
| [image-compare-spec.md](image-compare-spec.md) | Shared module + **Compare tab `4.68`** |
| [frame-scrubber-spec.md](frame-scrubber-spec.md) / [frame-range-spec.md](frame-range-spec.md) | Scrubber / range (partial surface exists) |
| [sequencer-mvp-spec.md](sequencer-mvp-spec.md) / [seq-proportional-spec.md](seq-proportional-spec.md) | Sequencer |
| [pool-toggle-spec.md](pool-toggle-spec.md) | Pool toggles |
| [nav-collapse-spec.md](nav-collapse-spec.md) | **Sidebar category collapse** (headers) — **Implemented `4.69`** |
| [deepdream-evolve-video-spec.md](deepdream-evolve-video-spec.md) | **DeepDream Evolve** — **Implemented `4.73`** (stills A+B); multi/video later |

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

1. ~~**Autosave can overwrite named projects**~~ → **fixed `4.63`** (session-only autosave; named file only on explicit Save). Full desk snapshot **`5.06`**.  
2. **List reorder** jumps scroll to top.  
3. **Arrows** scroll page outside wired list tabs.  
4. ~~**Inactive tab knobs** not in project JSON~~ → **fixed `5.06`** (formState + continuous desk bindings).  
5. **High RIFE M** × large K = huge jobs; no soft warn.  
6. Pool **normalize strips unknown fields** — blocks quality rating.  
7. Large **uncommitted** tree risk — `git status` before ship/push.

---

## 7. VERSION & runtime

- **Current:** `000.000.5.17` (Viewport-lazy thumbs are the default again. Preload-all is optional.)
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
2. ~~**Universal persistence**~~ — **shipped `5.06`**. Catalog Phase 1 **`5.14`**.  
3. **Product choice:** quality rating *or* tilagup mode.  
4. Agent polish (streaming / Ollama) when vision UX needs it.  
5. Explicit backlog picks only (depth, flow, facerestore, …).

---

## 9. Doc maintenance

On ship: bump VERSION → update **this file** → spec banner → handoff on stops → root `AGENTS.md` registry for new ops.

**STATUS wins** when it disagrees with a stale backlog draft.
