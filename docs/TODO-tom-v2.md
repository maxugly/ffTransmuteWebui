# TODO-tom-v2 — The Working Plan

> tom.714 · 2026-07-27
>
> This is the plan codewhale follows. It incorporates agy's good ideas (track
> parallelism, Media Facade, CSS :root first) and grok's safety emphasis, but
> keeps our proven attack order: easy wins → frontend → backend → engines.
>
> **Rule zero:** the master TODO.md in the repo root is the single source of
> truth. This document explains WHY each phase is where it is. When the two
> conflict, TODO.md wins.

---

## Phase 1 — Dead Code & Easy Wins

> 30 minutes. Zero risk. Build momentum.
>
> **Agy agreement:** not in his plan, but he doesn't object to cleanup.
> **Grok validation:** pending.

| # | what | approach | verify |
|---|------|----------|--------|
| 1.1 | delete `app/static/app.js.bak` | 290KB backup from before module switchover. `rm` it. | browser loads, no change |
| 1.2 | melt.js twins | byte-identical 76-line scripts. point shell.py at root copy, delete `bin/melt.js` | curl datamosh_melt dry_run → ok:True |
| 1.3 | no_keyframe.js twins | same as melt. 4-line scripts. | curl datamosh_classic dry_run → ok:True |

---

## Phase 2 — Global Inputs Verification

> Complete the global inputs backend. The UI bar is built, the primitives exist
> (parse_path_list, verify_paths_exist, output_dir_ctx). Now harden them.
>
> **Agy agreement:** not in his plan. These are our "finish what we started" items.
> They're quick and catch bugs that would bite us during the frontend split.

| # | what | approach | verify |
|---|------|----------|--------|
| 2.1 | stop audit | verify `check_cancelled()` is in ALL multi-file op loops (withoutbg, facemorph, styletransfer) | start multi-file run, hit Stop → current finishes, next does NOT start |
| 2.2 | file existence verify | wire `verify_paths_exist()` into top of each multi-file handler. all-or-nothing — bail before processing any if one is missing | curl withoutbg with nonexistent path → ok:False with file list |

---

## Phase 3 — Frontend Modularization: style.css

> Why first: CSS split is mechanical — extract sections into files, add `<link>`
> tags. No logic changes, no imports, no dependency graph. Easier than app.js.
>
> **Agy contribution:** CSS Base Extraction (0.3) — extract `:root` variables
> and resets to `base.css` first. Preserves the cascade. Added as step 3.1.
>
> **Agy contribution:** Nested Static Routing (0.1) — `routes/static.py` must
> serve `/css/*` and `/js/*` paths before we create those directories. Added as
> prerequisite 3.0.

| # | what | approach | verify |
|---|------|----------|--------|
| 3.0 | nested static routing | extend `routes/static.py` to serve `/css/<path>` and `/js/<path>`. mount StaticFiles or add wildcard routes | `curl localhost:24590/css/_ping.css` → 200 |
| 3.1 | extract `:root` variables | pull custom properties and resets from style.css → `css/base.css`. add `<link>` to index.html BEFORE other CSS files | browser → colors, fonts, spacing identical |
| 3.2 | extract layout.css | nav, header, sidebar, main area → `css/layout.css` | browser → page structure intact, every tab renders |
| 3.3 | extract forms.css | input rows, knobs, binary toggles, selects → `css/forms.css` | browser → all knobs and inputs render correctly |
| 3.4 | extract pool.css | media pool grid, thumbnails, playback → `css/pool.css` | browser → pool tab loads, grid intact |
| 3.5 | extract console.css | terminal output, log styling → `css/console.css` | browser → console panel renders |
| 3.6 | extract modals.css | file browser overlay, picker overlay → `css/modals.css` | browser → Browse button opens modal correctly |
| 3.7 | extract responsive.css | media queries → `css/responsive.css` | browser → responsive breakpoints work |
| 3.8 | delete old style.css | after all component CSS verified | browser → full reload → styling identical |

---

## Phase 4 — Frontend Modularization: app.js

> 7,620 lines. The mother of all monoliths. Same elephant buffet pattern that
> worked on July 25 — extract one module, verify, commit, next.
>
> **Agy contribution:** ES Module Strategy (0.2) — establish global state
> sharing BEFORE splitting. `window.state` and `window.elements` are the
> shared surface. Each module imports what it needs, exports what others need.
>
> **Note:** agy suggested Track F (frontend modules) could run parallel to
> Tracks M and D. We disagree — Track M (media_store) is too risky to do
> before the frontend is clean. The frontend IS the verification surface for
> media_store changes.

### 4.0 Module Strategy (do first, before any splits)

| what | approach |
|------|----------|
| convert index.html | replace `<script src="/app.js">` with `<script type="module" src="/js/main.js">`. create empty `js/main.js` that imports everything from app.js for now |
| establish shared state | `window.state` (from existing state object), `window.elements` (DOM refs), `window.globalInputs` (already exists) |

### 4.1-4.17 Module Extraction (easiest first)

| order | module | lines | risk | verify |
|-------|--------|-------|------|--------|
| 1 | elements.js | ~25 | zero | page loads, no errors |
| 2 | state.js | ~165 | zero | tabs switch, state persists |
| 3 | shared.js | ~200 | low | knobs render on deepdream tab |
| 4 | global-inputs.js | ~150 | low | global bar renders, indicators update |
| 5 | api.js | ~100 | low | health check green, ops nav populated |
| 6 | filebrowser.js | ~500 | medium | Browse button opens modal |
| 7 | ui/rife.js | ~300 | medium | rife tab renders |
| 8 | ui/vectors.js | ~300 | medium | vectors tab renders |
| 9 | ui/watcher.js | ~300 | medium | watcher tab renders |
| 10 | ui/styletransfer.js | ~300 | medium | styletransfer tab renders |
| 11 | ui/withoutbg.js | ~300 | medium | withoutbg tab renders |
| 12 | ui/facemorph.js | ~300 | medium | facemorph tab renders |
| 13 | ui/deepdream.js | ~300 | medium | deepdream tab renders |
| 14 | ui/transmute.js | ~300 | medium | transmute tab renders |
| 15 | ui/mosh.js | ~300 | medium | mosh tab renders |
| 16 | ui/multi.js + ui/quick.js + ui/advanced.js | ~300 | medium | each renders |
| 17 | ui/pool.js | ~3,000 | high | pool tab loads, thumbnails, drag-drop, export all work. LAST for a reason |

**After each:** browser → click tab → form renders → zero console errors.

---

## Phase 5 — Backend Modularization: datamosh_ops.py

> 796 lines, 5 mosh modes. Each mode is self-contained. Agy and I agree on the
> approach: extract shared helpers → split per mode. This is Track D from agy's
> plan, reordered to after the frontend split (we verify through the WebUI).

| # | what | approach | verify |
|---|------|----------|--------|
| 5.1 | extract common.py | `_execute_mosh_pipeline`, `_trim_and_mosh`, shared helpers. add cancel hooks | curl any mosh mode dry_run → ok:True |
| 5.2 | split melt.py | params + handler + register → `operations/datamosh/melt.py` | curl datamosh_melt → ok:True. browser → mosh tab → melt renders |
| 5.3 | split classic.py | same pattern | curl datamosh_classic → ok:True |
| 5.4 | split hijack.py | same pattern | curl datamosh_hijack → ok:True |
| 5.5 | split destruct.py | same pattern | curl datamosh_destruct → ok:True |
| 5.6 | split mv_hack.py | same pattern | curl datamosh_mv_hack → ok:True |
| 5.7 | wire __init__.py | import all modes, populate REGISTRY | browser → mosh tab → all 5 modes in dropdown, each renders |

---

## Phase 6 — Backend Modularization: media_store.py

> 1,324 lines. The hardest split. Four concerns tangled: cache, thumbnails,
> pool, projects. This is Track M from agy's plan.
>
> **Agy contribution (critical):** Media Store Facade. Split internally but
> maintain `app/media/__init__.py` as a facade that re-exports the current
> API. Routes import from `app.media` and don't know the implementation split.
> Without this, every route that imports from media_store breaks.
>
> **Agy contribution:** `open_media` must NOT live in `cache.py`. It belongs
> in a separate `open.py` or stays in the facade.

| # | what | content | verify |
|---|------|---------|--------|
| 6.0 | create facade | `app/media/__init__.py` re-exports all of media_store's current public API. routes unchanged. | health → ok. pool tab → loads |
| 6.1 | split cache.py | content hashing, media index, file serving, cache info | pool tab → media items load. thumbnail endpoint → returns image |
| 6.2 | split thumbnails.py | thumbnail generation, frame extraction, export_frame | pool tab → thumbnails render |
| 6.3 | split pool.py | pool state load/save, pool match, pool scan, workspace media | pool tab → state persists. add clip → appears |
| 6.4 | split projects.py | project save, load, last, auto-restore | save project → load project → clips restored |
| 6.5 | split open.py | `open_media` and any other standalone utilities | as above |

---

## Phase 7 — Engine Refactoring

> Only after the infrastructure is clean. Agy's Phases 2-4, condensed.
>
> **Agy and I agree:** this is the right destination. We disagree on timing —
> he wants it sooner (his Phase 2), I want it after frontend + backend splits
> (my Phase 7). Compromise: frontend + datamosh split first (Phase 3-5),
> then media_store can run parallel to VideoPipeline (Phase 6-7).

### 7.1 JobWorkspace

Standardize temp directory structure. Replace `mktemp` in all ops.
```
/tmp/mtapi_jobs/{job_id}/
├── audio.aac
├── frames_in/
├── frames_out/
└── metadata.json
```

### 7.2 VideoPipeline Core

Build `app/media/pipeline.py`. Probes video, dumps to JobWorkspace, runs
execution loop hook, re-encodes, muxes audio. This is the evolution of
`PngFramePipeline` — same concept, deeper integration.

### 7.3 Op-to-Filter Conversion

Migrate ops one at a time. Each becomes a filter: `process_frame(array) → array`.
Old engines coexist until all are migrated.

| order | op | risk | reason |
|-------|-----|------|--------|
| 1 | rife_ops | low | already uses PngFramePipeline — closest to the target |
| 2 | withoutbg_engine | low | pure image processing, no temporal logic |
| 3 | styletransfer_engine | low | pure image processing |
| 4 | facemorph_engine | medium | dlib integration |
| 5 | deepdream_engine | high | temporal blending, optical flow, ouroboros — most complex |

### 7.4 Model Manager

LRU cache for PyTorch/TF/dlib weights. Operations request from manager.
Prevents OOM when chaining. Only needed when multiple ops share a pipeline.

### 7.5 Dynamic Mixing

`POST /ops/pipeline` — JSON array of filters. VideoPipeline decodes once,
streams through chain, encodes once. Multi-Pass UI tab for queuing.

---

## Phase 8 — New Features

| # | what | blocked by |
|---|------|------------|
| 8.1 | CivitAI integration | Phase 6 (stable media cache) |
| 8.2 | ASCII render | Phase 7.2 (VideoPipeline) |
| 8.3 | FFglitch scripts | Phase 6 (stable routes) |
| 8.4 | Speed ramp end-to-end | optical-flow interpolation |
| 8.5 | Rubberband audio v2 | — |

---

## Dependency Graph

```
Phase 1 (dead code) ────┐
Phase 2 (inputs verify) ─┤
                         ├─→ Phase 3 (style.css) ─→ Phase 4 (app.js)
                         │                                │
                         │                                └─→ Phase 5 (datamosh)
                         │                                      │
                         │                                      ├─→ Phase 6 (media_store)
                         │                                      │        │
                         │                                      │        └─→ Phase 8 (CivitAI)
                         │                                      │
                         │                                      └─→ Phase 7 (engines)
                         │                                               │
                         │                                               └─→ Phase 8 (ASCII, mixing)
                         │
                         └─→ (grok review runs in parallel with Phase 1-2)
```

---

## Where Agy and I Agree

- Media Store Facade: split internally, unified API surface
- CSS :root extraction before layout split
- Nested static routing prerequisite
- Track-based parallelism (frontend, datamosh, media can run in parallel)
- VideoPipeline + Op-to-Filter is the destination
- Old engines coexist during migration
- Dead code / easy wins are worth doing

## Where We Differ

| issue | agy | tom | compromise |
|-------|-----|-----|------------|
| media_store timing | Phase 1, parallel with frontend | Phase 6, after frontend | media_store starts after Phase 5 (datamosh), overlaps with Phase 7 (engines) |
| VideoPipeline timing | Phase 2, before op conversion | Phase 7, after frontend | Phase 7, after datamosh split — frontend must be clean first |
| missing easy wins | not in plan | Phase 1 | added to Phase 1 |
| verification specificity | general | per-item | kept per-item verification from master plan |
