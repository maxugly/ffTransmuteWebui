# docs/ — index

> **Start here:** [STATUS.md](STATUS.md) — **shipped / partial / full roadmap**  
> **Law:** `../AGENTS.md`  

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
| [archive/changelog.md](archive/changelog.md) | **Version diary (historical STATUS)** |

**Shared code:** `mtapi-project/app/evolve_video.py` — strip → optional dedupe → optional RIFE → encode.

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
