# Session stopping state — handoff

> **Date:** 2026-08-03  
> **VERSION:** `000.000.4.55`  
> **Branch:** `main`  
> **Authoritative live status:** [STATUS.md](STATUS.md) (prefer STATUS if this file drifts)  
> **Purpose:** Human + next-agent handoff — what shipped this stretch, what is open, how to resume.

---

## 1. Shipped this stretch (through 4.54)

| Area | Notes | Spec / code |
|------|--------|-------------|
| **Image Sort chain strategy** | `radial` (to base) + **`chain` (closest next)**; UI Strategy select; scores = step cost under chain | `image_sort/rank.py`, `imagesort_rife_ops.py`, `imagesort.js` |
| **Image Sort bottom docs** | `.tool-docs` About block (strategy, metrics, RIFE, TTA, UHD, CRF) | `tool-bottom-docs-spec.md` pilot **done** for Image Sort |
| **RIFE multiplier 2–128** | API + knobs (Image Sort, RIFE, Speed, ramp). **Image list length was never capped at 8** | `le=128` on ops; knob `max: 128` |
| **Workspace progress** | Phase-local rate/ETA samples; `start_dir_watch` on RIFE `frames_out` | `job_control.py`, `filters/rife.py` · `workspace-progress-spec.md` **partial** |
| **Doc cleanup** | FastSD upscalers research; image quality rating spec; tilagup→mtapi mode spec; STATUS + docs README | see §4 |
| **Img2img OpenVINO** | Stage `img2img` + `POST /ops/img2img`; mark frames; FastSD GPU worker | `filters/img2img.py`, `img2img_ops.py` |

Earlier stable (still true): filter platform, dual pools, Convert, neural ops, pre-run strips (IS/RIFE/Speed/FM), Run-button timer, partial list-keys.

---

## 2. Partial / open

| Area | Status | Next agent action |
|------|--------|-------------------|
| Progress | RIFE watch + smart ETA in tree; dump watch / UI rate polish may remain | `workspace-progress-spec.md` §6 |
| Tool bottom docs | Image Sort only | Copy pattern to RIFE / Convert / … |
| List UX | Sequence L/R, scroll-into-view, page-scroll steal | `ui-list-nav-timer-spec.md` |
| Universal persistence | Spec only | `universal-persistence-spec.md` |
| Tilagup mode | Spec only | `tilagup-mtapi-mode-spec.md` |
| Quality rating | Spec only | `image-quality-rating-spec.md` Phase A |
| **Img2img (OpenVINO)** | **Shipped** `4.55` | stage + `/ops/img2img`; WebUI tab still open |
| **Job queue** | Spec only | `job-queue-spec.md` |
| Upscale / NCNN | Backlog | `backlog/upscale-spec.md` |

---

## 3. Known bugs (do not forget)

1. Autosave can overwrite named projects.  
2. List reorder jumps to top.  
3. Arrows scroll page outside wired list tabs.  
4. Inactive tab knobs not persisted.  
5. Pool normalize drops extra fields (blocks quality scores until fixed).  
6. Extreme RIFE M × large K = huge jobs (no soft warn).

---

## 4. Doc map (current)

| Doc | Role |
|-----|------|
| **[STATUS.md](STATUS.md)** | **Canonical where-we-are** |
| **[README.md](README.md)** | Doc index |
| `SESSION-STOPPING-STATE.md` | This handoff |
| `image-sort-rife-spec.md` | Image Sort as-built + chain |
| `tool-bottom-docs-spec.md` | Bottom About blocks |
| `workspace-progress-spec.md` | Dir watch + ETA |
| `tilagup-mtapi-mode-spec.md` | Agent tiled SD mode (spec) |
| `image-quality-rating-spec.md` | Pool quality (spec) |
| `job-queue-spec.md` | FIFO job queue + Jobs tab (spec) |
| `fastsdcpu-upscalers-spec.md` | Upscale research |
| `ui-list-nav-timer-spec.md` | Timer / keys / pre-run |
| `universal-persistence-spec.md` | Desk save redesign |
| `filter-platform-spec.md` | Frame pipeline law |
| `video-image-pools-spec.md` | Dual pools |

Sibling code (not in this repo): `/home/m/snc/cod/tilagup`.

---

## 5. Uncommitted risk

As of handoff write, local tree may have **uncommitted** code + docs (chain, tool-docs, progress, mult 128, STATUS). Next agent:

```bash
cd /home/m/snc/cod/ffTransmuteWebui
git status
git diff --stat
cat VERSION   # expect 000.000.4.54
```

Commit/push only when human asks (or when builder policy says so).

---

## 6. How to resume

```bash
cd /home/m/snc/cod/ffTransmuteWebui
cat docs/STATUS.md
cat docs/SESSION-STOPPING-STATE.md
cat VERSION

# Server
cd mtapi-project && .venv/bin/python run.py
# UI http://localhost:24590/
```

| If you are… | Read first | Then |
|-------------|------------|------|
| Spec writer | STATUS, relevant `docs/*-spec.md` | Edit docs only |
| Builder (UX) | `ui-list-nav-timer-spec.md` | Finish keys/scroll; keep Run timer |
| Builder (progress) | `workspace-progress-spec.md` | Close remaining checklist |
| Builder (img2img UI) | `img2img-openvino-spec.md` | Optional WebUI tab; API already works |
| Builder (tilagup) | `tilagup-mtapi-mode-spec.md` + tilagup tree | After img2img basics |
| Builder (quality) | `image-quality-rating-spec.md` | Phase A tech only + fix normalize |

**Do not** start random backlog ops without human priority. **STATUS §8** has suggested order.
