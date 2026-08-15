# Session stopping state — handoff

> **Date:** 2026-08-14  
> **VERSION:** `000.000.5.20`  
> **Branch:** `main`  
> **Authoritative live status / roadmap:** [STATUS.md](STATUS.md)  
> **Purpose:** Human + next-agent handoff — what shipped, what is open, how to resume.

---

## 1. Shipped this stretch (through 5.20)

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
| **QR & Illusion Art Generator** | Dual-mode (text QR or custom pattern) + ControlNet QR Monster + optional IP-Adapter | `qr_illusion_ops.py`, `js/tabs/qr_illusion.js` · **`5.05`** |
| **State tracking / popup spam** | Removed post-load auto-RIFE scan; project load no longer triggers Instant densify; backend restores variant_path + rife_multiplier; already-rifed clips never re-encoded; alert() replaced with logConsole | `pool.py`, `persistence.js`, `items.js`, `sequence.js`, `job-control.js` · **`5.03`** |
| **Universal persistence** | Metadata + `meta_signature` round-trip; `/api/media_signature`; shared `lazy-loader.js` (100px margin, max-5 fallback); settings precedence (named projects never overwrite globals); schema v2 migration; inactive-tab formState | `universal-persistence-spec.md` · **`5.06`** |
| **Settings layout polish** | Tight one-page cards hug content; Neural FX blurb wraps after “Default is off” | `settings.js`, `settings.css` · **`5.12`** |
| **Settings card layout spec** | House style for new Settings cards — one-line head, packed controls, max-content | `settings-card-layout-spec.md` · **`5.13`** |
| **Catalog UX Phase 1** | Cache-first eager restore (no signature/hash/probe on existing records); batch `/api/media_signatures` + `/api/variants/batch`; `window.globalMediaIndex`; already-dense Instant RIFE is zero variant requests; moved RIFE recovered by hash; lower-density GC only after promote + unreferenced | `performance-catalog-ux-spec.md` · **`5.14`** |
| **Hash-only thumb 500** | Hash-only `/api/thumbnail` uses recorded source / 404s; no recover-on-error loop | `thumbnails.py` · **`5.15`** |
| **Thumbnail load speed** | Existing JPEG served without record/index scan; 8-wide in-flight img queue | `media.py`, `lazy-loader.js` · **`5.16`** |
| **Eager-thumb regression** | Viewport-lazy is default again; preload-all is opt-in | `lazy-loader.js` · **`5.17`** |
| **Thumb queue coverage** | Settings size refresh uses the same 8-fetch cap | `freshness.js` · **`5.18`** |
| **Pay-once thumbs** | Display is cache-only; missing thumbs generate in background; work starts immediately | `5.19` |
| **No redo** | Same path+size never re-hashes; cache-hit open does not rewrite; failed thumbs not retried | `5.20` |

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
| Universal persistence | **Shipped `5.06`** — `universal-persistence-spec.md` |
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
4. ~~Inactive tab knobs not in project JSON~~ — fixed `5.06`.  
5. Pool normalize strips unknown fields (blocks quality rating).  
6. Extreme RIFE M × large K — no soft warn.  
7. Long POST can die under heavy DeepDream (browser “Failed to fetch”) — server crash/OOM; evolve/async-job polish later.  
8. **Docs:** keep SESSION + feature banners in sync on ship (this file was long stale at 4.63).

---

## 4. Active investigation — state tracking / Instant RIFE (5.02)

**Problem reported:** On project load, the sequence auto-queues RIFE for clips that already have a rifed variant. Not all clips — only a suffix of the sequence. CPU pegged; multiple encodes running in parallel; popup spam ("Operation failed: A job is already running") blocks UI.

**Root causes identified so far:**

| Symptom | Root cause | Status |
|---------|-----------|--------|
| Popup hell | `alert()` in `runActiveOperation()` and `stitchPoolSequence()` blocks UI thread; while user dismisses one, in-flight RIFE POST completes, next op starts, server rejects with "already running", next alert queues | **Fixed in branch** |
| Already-rifed clips re-encode | `_maybeAutoRifeAll` scans sequence and queues any entry where `_rifeStatus !== 'done'`; `_hydrateEntryFromVariants` is async but `ensureSequenceMetaAndInstantScan` does not await it before scan, so status can be stale `null` when scan runs | **Fix in progress** |
| CPU pegged / parallel encodes | `_drainInstantRifeQueue` holds `clientBusyLabel` but `runOpWithCancel` with `allowDuringClientBusy: true` still allows the POST through; if one encode hangs or server-side single-flight is loose, multiple can overlap | Needs backend audit |

**Files touched / to touch:**

| File | What |
|------|------|
| `mtapi-project/app/static/js/job-control.js` | Replace busy-block `alert()` with `logConsole` + status text |
| `mtapi-project/app/static/js/pool/persistence.js` | Same for Stitch busy-block |
| `mtapi-project/app/static/js/pool/sequence.js` | Ensure hydration completes before scan; hard-stop queue if entry already has adequate variant; remove debug `console.log` after verified |
| `mtapi-project/app/operations/rife_ops.py` | Review single-flight / job token enforcement |
| `mtapi-project/app/job_queue.py` | Verify FIFO + reject duplicates |

**Next agent should:**
1. Complete the RIFE re-encode fix in `sequence.js` — make `_maybeAutoRifeAll` and `_drainInstantRifeQueue` respect existing `variantPath` + `_rifeMultiplier` even when `_rifeStatus` is stale.
2. Verify backend single-flight in `job_queue.py` / `run_staged_job` so only one RIFE runs at a time.
3. Run Playwright smoke: load project, verify no auto-RIFE on reload unless user changes Time/FPS, verify Stop cancels batch, verify only clips that truly need densify get `Q#` badges.
4. Bump VERSION to `5.02` once fixed, update STATUS.md, push.

---

## 5. Doc map

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
cd <workspace-root>
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
