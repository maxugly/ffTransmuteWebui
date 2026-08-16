# docs/ — index

> **Start here:** [STATUS.md](STATUS.md) — **shipped / partial / full roadmap**  
> **Handoff:** [SESSION-STOPPING-STATE.md](SESSION-STOPPING-STATE.md)  
> **Law:** `../AGENTS.md` · `../mtapi-project/AGENTS.md`

| Banner | Meaning |
|--------|---------|
| **Implemented** | Code is truth; update code + doc together |
| **Partial** | In tree but not done — do not claim DONE |
| **Spec** | Design only — need human priority |
| **Research** | Notes — not a build ticket alone |
| **Legacy** | Do not build from this file |
| **Backlog** | Future op under `backlog/` |

---

## Canonical as-built

| Doc | Topic |
|-----|--------|
| [STATUS.md](STATUS.md) | **Where we are + roadmap** |
| [filter-platform-spec.md](filter-platform-spec.md) | dump → filters → encode |
| [video-image-pools-spec.md](video-image-pools-spec.md) | Dual pools / Cut |
| [resolve-transcode-spec.md](resolve-transcode-spec.md) | Convert / bookends |
| [file-to-file-transcode-spec.md](file-to-file-transcode-spec.md) | Direct ffmpeg transcode |
| [image-sort-rife-spec.md](image-sort-rife-spec.md) | Image Sort + chain |
| [img2img-openvino-spec.md](img2img-openvino-spec.md) | Img2img OpenVINO |
| [agent-vision-tab-spec.md](agent-vision-tab-spec.md) | Agent + vision APIs |
| [rife-recoherence-spec.md](rife-recoherence-spec.md) | RIFE mid recohere |
| [prompt-library-spec.md](prompt-library-spec.md) | Prompt save/load library |
| [deepdream-evolve-video-spec.md](deepdream-evolve-video-spec.md) | Evolve capture + dedupe + RIFE |
| [styletransfer-spec.md](styletransfer-spec.md) | Style stills/video + strength Evolve |
| [architecture.md](architecture.md) | High-level map |
| [settings-card-layout-spec.md](settings-card-layout-spec.md) | **Settings cards** — tight one-page house style |
| [pool-wall-preview-spec.md](pool-wall-preview-spec.md) | Pool wall: one 120px preview, stable img |
| [pool-deadcode-cleanup-spec.md](pool-deadcode-cleanup-spec.md) | Pre-7.000: delete recycle/lazy leftovers only |

**Shared code:** `mtapi-project/app/evolve_video.py` — strip → optional dedupe → optional RIFE → encode.

---

## At a glance — `000.000.7.000` (2026-08-16)

### Shipped recently
| Doc / feature | Ver |
|---------------|-----|
| Join preset transcode, Job workspace on disk, Jobs tab live desk | **4.98–5.00** |
| Instant RIFE densest-wins, Single-flight restore, Instant re-render fixes | **4.90–4.97** |
| Join codec export, RIFE in Join, Unified Join Frontend, Clip variants | **4.81–4.89** |
| FastSAM OpenVINO, Dead-code passes, Evolve DRY cleanup | **4.75–4.80** |
| Style/DeepDream Evolve, max_loss, live mid-ascent preview | **4.70–4.74** |
| Nav collapse, Image Compare, bottom input preview | **4.66–4.69** |

### Partial / in progress
| Doc | Status |
|-----|--------|
| [workspace-progress-spec.md](workspace-progress-spec.md) | RIFE/dump watch; multi-phase ETA polish |
| [tool-bottom-docs-spec.md](tool-bottom-docs-spec.md) | Several tabs; not all |
| [ui-list-nav-timer-spec.md](ui-list-nav-timer-spec.md) | Timer/pre-run; some list edges |
| Evolve multi/video/ouro | Spec phases C–E only |
| RIFE evolve **UI** DRY | Backend shared; JS still per-tab |

### Roadmap (priority cleaned specs)
| Doc | Intent |
|-----|--------|
| [universal-persistence-spec.md](universal-persistence-spec.md) | **Implemented `5.06`** — desk snapshot / metadata / lazy-load |
| [performance-catalog-ux-spec.md](performance-catalog-ux-spec.md) | **Implemented Phase 1 `5.14`** — cache-first restore + batch APIs |
| [catalog-interaction-virtualization-spec.md](catalog-interaction-virtualization-spec.md) | **Partial `5.37`** — hover/queues/virt in tree; 16.6ms compositor p95 not claimed |
| [server-memory-catalog-spec.md](server-memory-catalog-spec.md) | **Implemented `5.38`** — one server-resident catalog index + 64 MiB JPEG warmer |
| [tilagup-mtapi-mode-spec.md](tilagup-mtapi-mode-spec.md) | Agent tiled SD |
| [image-quality-rating-spec.md](image-quality-rating-spec.md) | Pool quality scores |
| [fastsam-sam-multimodel-spec.md](fastsam-sam-multimodel-spec.md) | **FastSAM + SAM multimodel selector** — stronger backends on Intel OpenVINO |
| [performance-settings-spec.md](performance-settings-spec.md) | Pool performance, thumbnail resolution, and RAM cache prefs |

Full backlog: **[STATUS.md §5](STATUS.md)**. Build order: **[STATUS.md §8](STATUS.md)**.

### Research
| Doc | Note |
|-----|------|
| [fastsdcpu-upscalers-spec.md](fastsdcpu-upscalers-spec.md) | FastSD upscale catalog |
| [amused-openvino-spec.md](amused-openvino-spec.md) | aMUSEd OpenVINO proposed |

### Kickoffs (historical / builder)
| Doc | Role |
|-----|------|
| [coder-nav-collapse-prompt.md](coder-nav-collapse-prompt.md) | Nav collapse (shipped `4.69`) |
| [coder-prompt-library-prompt.md](coder-prompt-library-prompt.md) | Prompt library (shipped) |
| [coder-rife-recoherence-prompt.md](coder-rife-recoherence-prompt.md) | Recohere (shipped) |
| [coder-dry-platform-prompt.md](coder-dry-platform-prompt.md) | staged_job + Run/Queue DRY |

---

## UX / persistence inventories

| Doc | Topic |
|-----|--------|
| [ui-state-map.md](ui-state-map.md) | UI state keys |
| [persistence-inventory.md](persistence-inventory.md) | What saves today |
| [nav-collapse-spec.md](nav-collapse-spec.md) | **Implemented** — collapsible nav categories |
| [deepdream-evolve-video-spec.md](deepdream-evolve-video-spec.md) | **Implemented** — DeepDream evolve + bookend |
| [styletransfer-spec.md](styletransfer-spec.md) | **Implemented** — style + Evolve |
| [media-persistence-spec.md](media-persistence-spec.md) | Media cache |
| [style-css-map.md](style-css-map.md) | CSS map |

---

## Implemented ops (check STATUS)

transmute, convert, pipeline, datamosh, deepdream (+ **evolve**), facemorph, withoutbg, style (+ **evolve**), rife, **rife_recohere**, speed, ramp, zoompan, image sort, img2img, txt2img, agent, **prompt library (UI)**, upscale, cut, job queue, **qr_art**.

---

## Backlog (`backlog/`)

~28 draft ops (swinir, depthmap, glitch, audio-reactive, …). Prefer STATUS + cleaned specs. Legacy sd-tiled → tilagup-mtapi.

---

## External

| Path | Role |
|------|------|
| `/home/m/snc/cod/tilagup` | Agent tiled upscale CLI |
| [external-design-brief.md](external-design-brief.md) | Outside agents |

[spec_registry.json](spec_registry.json) is a partial machine index — **STATUS is authoritative**.
