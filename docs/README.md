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
| [image-sort-rife-spec.md](image-sort-rife-spec.md) | Image Sort + chain |
| [img2img-openvino-spec.md](img2img-openvino-spec.md) | Img2img OpenVINO |
| [agent-vision-tab-spec.md](agent-vision-tab-spec.md) | Agent + vision APIs |
| [rife-recoherence-spec.md](rife-recoherence-spec.md) | RIFE mid recohere |
| [prompt-library-spec.md](prompt-library-spec.md) | Prompt save/load library |
| [architecture.md](architecture.md) | High-level map |

---

## At a glance — `000.000.4.61` (2026-08-04)

### Shipped recently
| Doc / feature | Ver |
|---------------|-----|
| [prompt-library-spec.md](prompt-library-spec.md) | **4.61** |
| [rife-recoherence-spec.md](rife-recoherence-spec.md) | **4.60** |
| [agent-vision-tab-spec.md](agent-vision-tab-spec.md) | **4.59** Phase A+API |
| [img2img-openvino-spec.md](img2img-openvino-spec.md) | **4.55** + tab |
| Txt2img OpenVINO | In tree |

### Partial / in progress
| Doc | Status |
|-----|--------|
| [workspace-progress-spec.md](workspace-progress-spec.md) | RIFE watch + ETA; dump watch open |
| [tool-bottom-docs-spec.md](tool-bottom-docs-spec.md) | Several tabs; not all |
| [ui-list-nav-timer-spec.md](ui-list-nav-timer-spec.md) | Timer/pre-run; sequence keys open |
| [backlog/upscale-spec.md](backlog/upscale-spec.md) | Code in tree — verify/ship |

### Roadmap (priority cleaned specs)
| Doc | Intent |
|-----|--------|
| [job-queue-spec.md](job-queue-spec.md) | FIFO queue + Jobs tab |
| [universal-persistence-spec.md](universal-persistence-spec.md) | Desk save / autosave safety |
| [tilagup-mtapi-mode-spec.md](tilagup-mtapi-mode-spec.md) | Agent tiled SD |
| [image-quality-rating-spec.md](image-quality-rating-spec.md) | Pool quality scores |

Full backlog + open product specs: **[STATUS.md §5](STATUS.md)**. Build order: **[STATUS.md §8](STATUS.md)**.

### Research
| Doc | Note |
|-----|------|
| [fastsdcpu-upscalers-spec.md](fastsdcpu-upscalers-spec.md) | FastSD upscale catalog |
| [amused-openvino-spec.md](amused-openvino-spec.md) | aMUSEd OpenVINO proposed |

### Kickoffs (historical / builder)
| Doc | Role |
|-----|------|
| [coder-prompt-library-prompt.md](coder-prompt-library-prompt.md) | Prompt library builder (shipped) |
| [coder-agy-prompt-library-prompt.md](coder-agy-prompt-library-prompt.md) | Agy → prompt-library-spec |
| [coder-rife-recoherence-prompt.md](coder-rife-recoherence-prompt.md) | Recohere builder (shipped) |

---

## UX / persistence inventories

| Doc | Topic |
|-----|--------|
| [ui-state-map.md](ui-state-map.md) | UI state keys |
| [persistence-inventory.md](persistence-inventory.md) | What saves today |
| [media-persistence-spec.md](media-persistence-spec.md) | Media cache |
| [style-css-map.md](style-css-map.md) | CSS map |

---

## Implemented ops (check STATUS)

transmute, convert, pipeline, datamosh, deepdream, facemorph, withoutbg, style, rife, **rife_recohere**, speed, ramp, zoompan, image sort, img2img, txt2img, agent, **prompt library (UI)**; upscale **partial in tree**.

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
