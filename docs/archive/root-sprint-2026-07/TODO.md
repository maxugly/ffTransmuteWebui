# TODO-final — The Filter Graph Execution Plan

> **Author**: tom (final arbiter) · **Originally**: 2026-07-27  
> **Updated**: 2026-07-31 — phases 3–5 largely **done**; see **Current status** below  
> **Rule**: One commit per item. Verify before proceeding. Tree is truth for "done?".  
> **Live architecture**: `docs/filter-platform-spec.md`, `ROADMAP.md`, root `AGENTS.md`

---

## ✅ Current status (2026-07-31)

| Area | State |
|------|--------|
| JobWorkspace + video_pipeline | ✅ |
| Filters: rife (directory), deepdream / withoutbg / styletransfer (per_frame) | ✅ |
| `POST /ops/pipeline` + PipelineChain | ✅ |
| Convert / Export (codecs, frames_*, GIF) | ✅ |
| `PngFramePipeline` | ✅ **removed** (stub raises) |
| Multi-Pass UI tab | ⏳ backend ready; UI queue still open |
| Model Manager | ⏳ deferred |
| Facemorph multi-source registry kind | ⏳ optional |

**Do next (suggested):** Multi-Pass UI → Model Manager when chaining heavy nets → backlog ops on filter platform.

Sections below retain the original plan as a **historical checklist**. Items marked ✅ were completed in later work even if the checkbox was not always updated in-line.

---

## 🛑 Phase 0: Infrastructure Safety (Do First or Everything Breaks)

- [x] **0.1 Nested Static Assets**: Extend `routes/static.py` to recursively serve `/css/*` and `/js/**`. Keep `/style.css` and `/app.js` alive until cutover. ✅  
  *Verify: `GET /css/_ping.css` → 200; `GET /js/_ping.js` → 200; remove pings.*

- [x] **0.2 ES Module Entry**: `index.html` → `<script type="module" src="/js/main.js">`. ✅  
  *Verify: Cold load → health green → all tabs render → zero console errors.*

- [x] **0.3 CSS Tokens**: Extract `:root` + dependent resets to `css/base.css`. Link it first. ✅  \n  *Verify: Hard reload → mosh + pool colors/spacing unchanged.*

**Phase 0 exit: nested assets work; app is a module; tokens in base.css.**

---

## 🧹 Phase 1: Easy Wins & Cleanups

- [x] **1.1 `app/static/app.js.bak`**: Skip. File not in tree. ✅

- [x] **1.2 Datamosh Twins**: Repoint `MELT_JS` and `NO_KEYFRAME_JS` in `datamosh_ops.py` to root directory copies FIRST. Verify melt + classic on `/tmp/teste.mp4` → ok. THEN delete `bin/melt.js` and `bin/no_keyframe.js`. Never delete before repointing — that leaves a window where deploys resolve missing scripts. ✅  \n  *(Constants live in datamosh_ops.py, not shell.py. Note: datamosh.sh was consolidated; melt.js and no_keyframe.js still have bin copies pending.)*

- [x] **1.3 Cancel Audit**: `check_cancelled()` added between ffgac → ffedit → encode in datamosh pipeline, plus trim segment boundaries. ✅  \n  *Verify: Stop during mosh → cancelled status.*

---

## 📦 Phase 2: Component Isolation

*(Single builder: F → D → M sequentially. Teams: parallel after Phase 0.)*

---

### Track F: Frontend Modularization

**F.CSS** — extract in this order:

| # | file | verify |
|---|------|--------|
| F.1 | Map line ranges (commit the map) | map committed |
| F.2 | `css/layout.css` | structure, all tabs |
| F.3 | `css/forms.css` (inputs, knobs, toggles) | knobs on deepdream |
| F.4 | `css/console.css` | terminal + stage |
| F.5 | `css/modals.css` | Browse modal |
| F.6 | `css/pool.css` (including pool `@media`) | pool grid + dock |
| F.7 | `css/ops.css` (mosh timeline/compare, watcher, leftovers) | mosh timeline usable |
| F.8 | Delete empty `style.css` | full reload look-identical |

*Do not dump pool/ops `@media` into a global `responsive.css` — keep them with their component.*

**F.JS** — extract in this order:

| order | module | notes | verify |
|------:|--------|-------|--------|
| 1 | `js/state.js` | state + pool defaults | tab switch keeps globals |
| 2 | `js/elements.js` | static DOM refs | load clean |
| 3 | `js/shared/knobs.js` | daw knobs | deepdream knobs write values |
| 4 | `js/global-inputs.js` | bar + indicators | indicators flip by tab |
| 5 | `js/api.js` | health, ops, `runOpWithCancel`, stop, progress | health; Stop works |
| 6 | `js/filebrowser.js` | + window bridge | Browse works |
| 7 | `js/router.js` | switchTab, renderTabForm, init | every tab mounts |
| 8–16 | `js/ui/<tab>.js` | rife → watcher → styletransfer → withoutbg → facemorph → deepdream → transmute → mosh → multi → quick → advanced. **No vectors tab — it does not exist in index.html.** | each form renders |
| 17 | `js/ui/pool/*` | grid, sequence, playback, persist/projects, match, context | pool matrix below |
| 18 | `js/run.js` | `runActiveOperation` + collectors | Run mosh + one neural e2e |
| 19 | `js/preview.js` | AR viewer, console resize, displayOpResult | preview non-zero box |

**Pool matrix (item 17):** import → thumbs; reload → restore; sequence edit; project save/load; match results; Send-to other tab.

*After each JS commit: cold load → target tab → zero console errors.*  
*Track F exit: runtime is `js/main.js` only; monolith `app.js` no longer required.*

---

### Track D: Datamosh Split

| # | what | approach | verify |
|---|------|----------|--------|
| D.0 | Optional `dry_run` | Add to params; skip ffgac/ffedit when true | `dry_run` → ok, no output file |
| D.1 | `operations/datamosh/common.py` | `_execute_mosh_pipeline`, `_trim_and_mosh`, helpers; cancel between stages | Real melt on `/tmp/teste.mp4` → ok |
| D.2–D.6 | melt → classic → hijack → destruct → mv_hack | Thin handler + register per file | Each mode once + WebUI dropdown |
| D.7 | Package `__init__` + `operations/__init__.py` | REGISTRY lists all 5 ids | `GET /ops` contains all five |

---

### Track M: Media Facade + Split

*For single builders: do M after Track D. This is the hardest split. Verifying it through a half-modularized frontend increases risk. Wait until Track D is done — that proves the backend split pattern before you tackle the hard one.*

| # | what | content | verify |
|---|------|---------|--------|
| M.0 | Facade | `app/media/__init__.py` re-exports public API; all routes import from facade | health; pool loads; media_info works |
| M.1 | `cache.py` | hash, index, records, locks, `resolve_hash`, `record_operation`. **No thumb gen. No `open_media`.** | Same path → same hash; cached hit |
| M.2 | `thumbnails.py` | extract, ensure_thumbs, phash, get_thumb_file, export_frame | first+last JPEG; extract_v gate |
| M.3 | `open.py` | `open_media`, `public_payload` | `/api/media_info` ok |
| M.4 | `pool.py` | session state load/save/normalize only | persist across restart; missing filtered |
| M.5 | `match.py` | `match_frames` (cache+thumbs+pool) | two clips → distances |
| M.6 | `projects.py` | save/load/last; mirror to session pool_state on save | project round-trip + autosave updated |

*Invariant: on-disk `~/.cache/mtapi/media/` layout unchanged. Single source for locks — do not duplicate `_index_lock` / `_pool_state_lock`.*

---

## ⚙️ Phase 3: Unified Pipeline Core

- [x] **3.1 JobWorkspace** — `app/job_workspace.py` ✅  
- [x] **3.2 VideoPipeline** — `app/video_pipeline.py` (probe/dump/process/encode + sync helpers). **Not** an evolution that keeps PngFramePipeline; that class was **removed**. ✅  
- [x] **3.3 Dual-path doc** — superseded by filter-platform + ops AGENTS (filter path is default). ✅  

---

## 🔄 Phase 4: Op-to-Filter Conversion

| # | op | status |
|---|-----|--------|
| 4.1 | `rife` | ✅ directory stage `app/filters/rife.py` |
| 4.2 | `withoutbg` | ✅ video per_frame `app/filters/withoutbg.py` |
| 4.3 | `styletransfer` | ✅ video per_frame `app/filters/styletransfer.py` |
| 4.4 | `facemorph` | ⚠️ multi-source morph + encode; dream_after → filters.deepdream (not a 1:1 video filter) |
| 4.5 | `deepdream` | ✅ video per_frame `app/filters/deepdream.py`; image/ouroboros special bookends |

*Model Manager: still deferred until two heavy models share a chain.*  
*PngFramePipeline: removed 2026-07-31.*

---

## 🧠 Phase 5: Dynamic Mixing

- [x] **5.1 `POST /ops/pipeline`** — `pipeline_ops` + `PipelineChain` (disk cascade; per_frame + directory). ✅  
  *Note: disk-based stages, not full-video RAM arrays (see dynamic-mixing-spec).*  
- [ ] **5.2 Multi-Pass UI** — Frontend queue to stack filters and POST pipeline. **Open.**

---

## ✨ Phase 6: New Features (Build on the Bedrock)

| # | what | blocked by | spec |
|---|------|------------|------|
| 6.1 | CivitAI cloud generation suite | Track M facade (M.0 only) | `civitai-spec.md` |
| 6.2 | ASCII render | Phase 3.2 pipeline | `ascii-spec.md` |
| 6.3 | FFglitch pixel sort + MV pan | Track D patterns helpful | `ffglitch-spec.md` |
| 6.4 | Speed ramp E2E | optical-flow / product | speedramp specs |
| 6.5 | Rubberband audio v2 | — | TBD |

---

## Anti-Patterns (Instant Fail)

1. Classic multi-`<script>` split with top-level `let state`.
2. `open_media` or `get_thumb` inside `cache.py`.
3. `curl datamosh dry_run` before D.0 is implemented.
4. Inventing a vectors tab extract — it does not exist in `index.html`.
5. Trusting root `TODO.md` "next" column without opening the routes file.
6. One-commit conversion of all engines to Filters.
7. Changing on-disk media cache layout without migration.

---

## What All Three Plans Agree On

- Phase 0 before any CSS/JS extraction — mandatory
- Facade before media_store guts move — mandatory
- `open_media` stays out of `cache.py` — mandatory
- Datamosh: common pipeline first, then thin modes — mandatory
- Old engines coexist during Filter migration — mandatory
- One commit per item; verify before next — mandatory
- Destination: JobWorkspace → VideoPipeline → Filters → Model Manager → `/ops/pipeline` + Multi-Pass  
  (**largely reached** except Model Manager + Multi-Pass UI)

---

## Single-Builder Default Schedule (updated)

```
✅ Phase 0–4 core + filter peels + pipeline backend + Convert
→ 5.2 Multi-Pass UI
→ Model Manager (when needed)
→ Phase 6 backlog features (on filter platform)
```
