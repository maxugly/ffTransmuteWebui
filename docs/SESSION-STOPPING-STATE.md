# Session stopping state — handoff

> **Date:** 2026-08-09  
> **VERSION:** `000.000.4.96`  
> **Branch:** `main`  
> **Authoritative live status / roadmap:** [STATUS.md](STATUS.md)  
> **Purpose:** Human + next-agent handoff — what shipped, what is open, how to resume.

---

## 1. Shipped this stretch (through 4.91)

| Area | Notes | Spec / code |
|------|--------|-------------|
| **Settings tab (blank)** | Workspace bare chrome (no global inputs / preview / Run); scaffold for pool perf prefs | `js/tabs/settings.js`, `css/settings.css` · **`4.91`** |
| **Instant RIFE densest-wins** | Mid-flight Time raise soft-aborts; keep highest M | `sequence.js`, `job-control` · **`4.90`** |
| **Instant RIFE queue + Stop** | Slow-mo eff fps = native/stretch; FIFO Instant queue; main Run busy + Stop cancels batch; Stitch via `runOpWithCancel` | `sequence.js`, `job-control.js`, `persistence.js`, `transmute_ops` · **`4.83`–`4.84`** |
| **FastSAM OpenVINO** | Implemented batch asset extraction filter using OpenVINO IR on Intel GPU | `fastsam.py`, `fastsam.js` · **`4.78`** |
| **Dead-code pass 3** | Removed `shell.probe_duration`, dead `stylize_batch` / `morph_directory` / watcher `_save_config` / `_needs_audio_for_preset` / `ensure_withoutbg_available` / `get_target_group`; unused imports; video ops use `start_frame_field`/`end_frame_field` | **`4.77`** |
| **DeepDream dead-path scrub** | Dropped unused sync `dream_video` / `dream_ouroboros` (~260 lines); ops only use filter + workspace paths; shared `rifeModelSelectHtml` on rife/imagesort/speed/recohere/transmute | `dream.py`, `evolve-rife.js` · **`4.76`** |
| **Evolve DRY cleanup** | Shared `EvolveRifeParams` (Pydantic) + `js/ui/evolve-rife.js` knobs/collect/master toggle | `evolve_video.py`, `evolve-rife.js` · **`4.75`** |
| **Style Evolve + shared bookend** | Strength ramp 0→full (1 Magenta pass) → optional RIFE → `*_styled_evolve.mp4` | `evolve_video.py`, `styletransfer_*` · **`4.74`** |
| **DeepDream Evolve** | Mid-ascent capture → Image Sort dedupe → optional RIFE → `*_dream_evolve.mp4` (stills) | `deepdream-evolve-video-spec.md` · **`4.73`** |
| **DeepDream fidelity** | Max loss default off; auto-ignore wrong-scale max_loss; VGG×40 / ResNet×120 step scale | `dream.py` / `models.py` · **`4.72`** |
| **Live mid-ascent preview** | `/tmp/mtapi_live/{token}.png` + `latest_frame` | **`4.71`** |
| **Live preview wiring** | Frame writers push `latest_frame` | **`4.70`** |
| **Nav category collapse** | Collapsible sidebar sections + `mtapi_nav_sections` | `nav-sections.js` · **`4.69`** |
| **Image Compare tab** | A/B + Image Sort metrics | `imgcompare.js` · **`4.68`** |
| **DeepDream bottom docs** | Full knob story | `deepdream.js` · **`4.67`** |
| **Bottom input preview** | Thumbs at panel bottom | `input-preview.js` · **`4.66`** |
| **DRY staged job + Run/Queue collect** | `run_staged_job`, `resolveActiveOpAndBody` | **`4.65`** |
| Upscale / Cut / Job queue | Earlier `4.64` | ops + Jobs tab |

Earlier stable: filter platform, dual pools, Convert, neural ops, Prompt Library, Recohere, Agent, OpenVINO stills.

**Shared evolve stack (DRY) — use this, do not fork:**

| Layer | Path | Role |
|-------|------|------|
| Bookend | `app/evolve_video.py` | `build_evolve_video`, `EvolveRifeOpts`, `rife_opts_from_evolve_params` |
| Params | `EvolveRifeParams` (same module) | Inherit on op models for RIFE/fps/stills fields |
| WebUI | `static/js/ui/evolve-rife.js` | HTML + knobs + `collectEvolveRifeFields` + master toggle |

Next strip→video ops: inherit params, import JS helper, call `build_evolve_video`.

---

## 2. Partial / open (do not claim done)

| Area | Next |
|------|------|
| Workspace progress | Multi-phase ETA polish — `workspace-progress-spec.md` |
| Tool bottom docs | Roll out remaining tabs |
| UI list keys | Edge cases — `ui-list-nav-timer-spec.md` |
| Universal persistence | Full desk snapshot — `universal-persistence-spec.md` |
| Evolve multi/video/ouro | Spec phases C–E — stills only shipped |
| Job queue persist | Memory FIFO only |
| Tilagup / quality rating | Specs; human priority |
| **FastSAM multimodel** | **Proposed** — `fastsam-sam-multimodel-spec.md` adds SAM ViT-L/H + AUTO device fallback |
| Full backlog | STATUS §5.5 |

---

## 3. Known bugs / product debt

1. ~~Autosave overwrites named projects~~ — fixed `4.63`.  
2. List reorder jumps scroll to top.  
3. Arrows scroll page outside wired lists.  
4. Inactive tab knobs not in project JSON.  
5. Pool normalize strips unknown fields (blocks quality rating).  
6. Extreme RIFE M × large K — no soft warn.  
7. Long POST can die under heavy DeepDream (browser “Failed to fetch”) — server crash/OOM; evolve/async-job polish later.  
8. **Docs:** keep SESSION + feature banners in sync on ship (this file was long stale at 4.63).

---

## 4. Doc map

| Doc | Role |
|------|------|
| **[STATUS.md](STATUS.md)** | Canonical shipped / partial / roadmap |
| [README.md](README.md) | Doc index |
| This file | Handoff narrative |
| [deepdream-evolve-video-spec.md](deepdream-evolve-video-spec.md) | Evolve as-built (DeepDream) + shared bookend note |
| [styletransfer-spec.md](styletransfer-spec.md) | Style stills/video + Evolve strength ramp |
| [filter-platform-spec.md](filter-platform-spec.md) / [video-image-pools-spec.md](video-image-pools-spec.md) | Core law |
| `prompt-library` / `rife-recoherence` / `agent-vision` / `img2img` | Earlier as-built |

Code: `mtapi-project/app/evolve_video.py` (shared).

---

## 5. Uncommitted risk

```bash
cd /home/m/snc/cod/ffTransmuteWebui
git status
git diff --stat
cat VERSION   # expect 000.000.4.74
```

Commit/push only when human asks.

---

## 6. How to resume

```bash
cat docs/STATUS.md
cat docs/SESSION-STOPPING-STATE.md
cd mtapi-project && .venv/bin/python run.py   # :24590
```

| Role | First read | Then |
|------|------------|------|
| Spec writer | STATUS §5 | Docs only |
| Builder (evolve UX DRY) | `evolve_video.py` + dream/style tabs | Shared RIFE knob fragment |
| Builder (progress) | `workspace-progress-spec.md` | ETA polish |
| Builder (persistence) | `universal-persistence-spec.md` | When prioritized |

**WebUI smoke:** DeepDream Evolve on still (Inception, Preview W 512, Max loss off); Style Evolve one still (Frames 16, Str 0→main, RIFE off).

**STATUS §8** = build order. No random backlog without human priority.
