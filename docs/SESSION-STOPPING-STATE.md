# Session stopping state — handoff

> **Date:** 2026-08-11  
> **VERSION:** `000.000.5.01`  
> **Branch:** `main`  
> **Authoritative live status / roadmap:** [STATUS.md](STATUS.md)  
> **Purpose:** Human + next-agent handoff — what shipped, what is open, how to resume.

---

## 1. Shipped this stretch (through 5.01)

| Area | Notes | Spec / code |
|------|--------|-------------|
| **Sequence Audio Engines** | Rubberband DAW flags + 48kHz sample-rate fix + 10ms micro-fade on every clip; engine dropdown UI (rubberband live; atempo/pitch/mute placeholders) | `sequence-audio-engines-spec.md`, `video_pipeline.py:770`, `grid.js`, `persistence.js` · **`5.01`** |
| **Join preset = transcode** | No dump→PNG for DNxHR/ProRes stitch; normal ffmpeg re-encode | `transcode_with_preset`, `_join_with_preset` · **`5.00`** |
| **Job workspace on disk** | Default `~/.cache/mtapi/jobs` | `job_workspace.py` · **`4.99`** |
| **Jobs tab live desk** | Read-only live server ops + FIFO + Instant queue + done | `jobs.js` · **`4.98`** |
| **Sequence token size + layout** | Two-row chips; min-width stops badge spill | `sequence.js`, `pool.css` · **`4.97`** |
| **Match click selects pool card** | Clear filter, uncollapse pool, scroll on match row/Select | `grid.js` · **`4.96`** |
| **Select RIFED sets multiplier** | Variant menu writes `_rifeMultiplier`; badge uses haveM | `sequence.js` · **`4.95`** |
| **Instant reuses densify** | Hydrate from /api/variants + persist rife_multiplier | `sequence.js`, `persistence.js` · **`4.94`** |
| **Single-flight restore** | Soft-cancel must not abort fetch; server rejects concurrent ops | `job-control.js`, `job_queue.py` · **`4.93`** |
| **Instant re-render fixes** | Queue no-op no re-render; variants cache; dual RIFE killed | `sequence.js`, `grid.js` · **`4.92`** |
| **Settings tab (blank)** | Workspace bare chrome; scaffold for pool perf prefs | `js/tabs/settings.js` · **`4.91`** |
| **Instant RIFE densest-wins** | Mid-flight Time raise soft-aborts; keep highest M | `sequence.js`, `job-control` · **`4.90`** |
| **Instant RIFE queue + Stop** | FIFO Instant queue; main Run busy + Stop cancels batch | `sequence.js`, `job-control.js` · **`4.83`–`4.89`** |
| **FastSAM OpenVINO / fixes** | Batch asset extraction filter on Intel GPU; coordinate fixes | `fastsam.py`, `fastsam.js` · **`4.78`–`4.82`** |
| **Join codec export & RIFE** | DNxHR/ProRes export; exact resample RIFE; UI dropdowns | `sequence_join_unified_frontend_spec.md` · **`4.81`** |
| **Dead-code pass & DRY** | Removed dead paths; shared `EvolveRifeParams` | **`4.75`–`4.77`** |
| **Style & DeepDream Evolve** | Mid-ascent capture, dedupe, optional RIFE, strength ramp | `evolve_video.py` · **`4.72`–`4.74`** |
| **Live mid-ascent preview** | `/tmp/mtapi_live/{token}.png` + `latest_frame` | **`4.70`–`4.71`** |
| **UI Polish** | Nav collapse, Image Compare A/B, Input previews | **`4.65`–`4.69`** |
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
