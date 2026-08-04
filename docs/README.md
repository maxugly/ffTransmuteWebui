# docs/ — index

> **Start here for agents:** [STATUS.md](STATUS.md)  
> **Last stop handoff:** [SESSION-STOPPING-STATE.md](SESSION-STOPPING-STATE.md)  
> **Root law:** `../AGENTS.md` · **mtapi law:** `../mtapi-project/AGENTS.md`

Status labels used in specs:

| Banner | Meaning |
|--------|---------|
| **Implemented** / as-built | Code is source of truth; update code + doc together |
| **Partial** | Some of the spec is in tree |
| **Spec** | Design only — do not implement without priority |
| **Research** | Notes / comparison — not a build ticket alone |
| **Legacy** | Superseded; do not build from this file |
| **Backlog** | Future op under `backlog/` |

---

## Canonical as-built (read before coding)

| Doc | Topic |
|-----|--------|
| [STATUS.md](STATUS.md) | **Where we are** |
| [filter-platform-spec.md](filter-platform-spec.md) | dump → filters → encode |
| [video-image-pools-spec.md](video-image-pools-spec.md) | Video Pool / Image Pool / Cut |
| [resolve-transcode-spec.md](resolve-transcode-spec.md) | Convert / bookends |
| [image-sort-rife-spec.md](image-sort-rife-spec.md) | Image Sort + RIFE + chain strategy |
| [rife-spec.md](rife-spec.md) / [rife-filter-cleanup-spec.md](rife-filter-cleanup-spec.md) | RIFE stage |
| [architecture.md](architecture.md) | High-level map |

---

## Recently active specs (2026-08)

| Doc | Status |
|-----|--------|
| [tool-bottom-docs-spec.md](tool-bottom-docs-spec.md) | **Partial** — Image Sort pilot shipped |
| [workspace-progress-spec.md](workspace-progress-spec.md) | **Partial** — rate/ETA + RIFE dir watch in tree |
| [tilagup-mtapi-mode-spec.md](tilagup-mtapi-mode-spec.md) | Spec — multi-step agent tiled SD |
| [image-quality-rating-spec.md](image-quality-rating-spec.md) | Spec — pool quality scores |
| [img2img-openvino-spec.md](img2img-openvino-spec.md) | **Implemented** — pipeline/op img2img (OV GPU) + mark frames |
| [agent-vision-tab-spec.md](agent-vision-tab-spec.md) | **Spec / next** — Agent tab + image→SD1.5 prompt (agy/grok) |
| [job-queue-spec.md](job-queue-spec.md) | Spec — FIFO queue + Jobs tab |
| [fastsdcpu-upscalers-spec.md](fastsdcpu-upscalers-spec.md) | Research — FastSD upscale catalog |
| [ui-list-nav-timer-spec.md](ui-list-nav-timer-spec.md) | Partial UX (timer/pre-run; keys incomplete) |
| [universal-persistence-spec.md](universal-persistence-spec.md) | Spec — desk save redesign |

---

## UX / persistence inventories

| Doc | Topic |
|-----|--------|
| [ui-state-map.md](ui-state-map.md) | UI state keys |
| [persistence-inventory.md](persistence-inventory.md) | What saves today |
| [media-persistence-spec.md](media-persistence-spec.md) | Media cache |
| [style-css-map.md](style-css-map.md) | CSS map |
| [ui-list-nav-timer-spec.md](ui-list-nav-timer-spec.md) | Timer, lists, pre-run |

---

## Implemented ops (docs may lag code — check STATUS)

DeepDream, facemorph, withoutbg, styletransfer, RIFE, speed change, speed ramp, zoompan, image sort, convert, transmute, datamosh, pipeline — see root `AGENTS.md` registry.

---

## Backlog (`backlog/`)

Future operations (upscale, swinir, glitch, codecview, …). Many are Gemini-era drafts — **prefer STATUS + cleaned specs** over raw backlog when both exist.

Notable:

| Doc | Note |
|-----|------|
| [backlog/upscale-spec.md](backlog/upscale-spec.md) | NCNN Real-ESRGAN / SRMD |
| [backlog/sd-tiled-upscale-spec.md](backlog/sd-tiled-upscale-spec.md) | **Legacy** → [tilagup-mtapi-mode-spec.md](tilagup-mtapi-mode-spec.md) |
| [backlog/swinir-spec.md](backlog/swinir-spec.md) | Denoise/deblur |

Coder prompts (`coder-*-prompt.md`, `codewhale-*-prompt.md`) are agent kickoff text, not as-built docs.

---

## External / sibling

| Path | Role |
|------|------|
| `/home/m/snc/cod/tilagup` | Working agent tiled upscale CLI — port per tilagup-mtapi-mode-spec |
| [external-design-brief.md](external-design-brief.md) | Brief for outside feature-spec agents |

---

## Machine registry

[spec_registry.json](spec_registry.json) — partial machine index; **STATUS.md is authoritative** when they disagree. Rebuild registry when convenient; do not trust status fields blindly.
