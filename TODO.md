# TODO — Detailed Implementation Path

> Last updated: 2026-07-27 · Review: pending grok
>
> Master plan. Every item has a reason, approach, verification, and dependencies.
> **Do not write to this file without checking git status first.**

---

## Phase 1 — Dead Code & Easy Wins (zero risk)

### 1.1 Delete dead static files
- **what:** delete `app/static/app.js.bak` (290KB backup from before module switchover) and old `style.css` if split CSS exists
- **verify:** browser → page loads with styling intact → zero console errors

### 1.2 melt.js twins
- **what:** root `melt.js` and `mtapi-project/bin/melt.js` — byte-for-byte identical 76-line scripts. point API at root copy, delete bin/ copy
- **files:** `shell.py` — add MELT_JS constant. delete `bin/melt.js`
- **verify:** curl datamosh_melt dry_run → ok:True. browser → datamosh tab → zero errors

### 1.3 no_keyframe.js twins
- **what:** root `no_keyframe.js` and `mtapi-project/bin/no_keyframe.js` — identical 4-line scripts. same pattern
- **verify:** curl datamosh_classic dry_run → ok:True

---

## Phase 2 — Backend Verification Hooks

### 2.1 Global inputs: stop audit
- **what:** verify `job_control.check_cancelled()` is in ALL multi-file op loops
- **files:** withoutbg_ops, facemorph_ops, styletransfer_ops
- **verify:** start multi-file run, hit Stop → current file finishes, next does NOT start

---

## Phase 3 — Frontend Modularization: style.css

> Why first: mechanical — extract sections, add link tags. no logic changes. easier than app.js.

### 3.1 Audit style.css
- **what:** read full 3,646-line file. identify sections: layout, nav, forms, knobs, pool, console, modals, responsive. output section map with line ranges.

### 3.2 Extract layout.css
- **what:** nav, header, sidebar, main area styles → `css/layout.css`
- **verify:** browser → page structure intact → every tab renders

### 3.3 Extract forms.css
- **what:** input rows, knobs, binary toggles, selects → `css/forms.css`
- **verify:** browser → forms on every tab render correctly

### 3.4 Extract pool.css
- **what:** media pool grid, thumbnails, playback → `css/pool.css`
- **verify:** browser → pool tab loads correctly

### 3.5 Extract console.css
- **what:** terminal output, log styling → `css/console.css`
- **verify:** browser → console panel renders

### 3.6 Extract modals.css + responsive.css
- **what:** file browser overlay, picker overlay, media queries
- **verify:** browser → Browse button opens modal correctly

### 3.7 Delete old style.css
- **when:** after all component CSS files verified
- **verify:** browser → full reload → styling identical

---

## Phase 4 — Frontend Modularization: app.js

> 7,620 lines. The mother of all monoliths. Same elephant buffet pattern from July 25.

### 4.1 Extract elements.js (~25 lines)
- **what:** DOM element references only. no logic. no state.
- **verify:** browser → page loads → zero errors

### 4.2 Extract state.js (~165 lines)
- **what:** state object, defaults. no functions.
- **verify:** browser → tabs switch → state persists

### 4.3 Extract shared.js (~200 lines)
- **what:** knobUnitHtml, setupBinaryKnob, setupContinuousKnob, logConsole
- **verify:** browser → knobs render on deepdream tab

### 4.4 Extract global-inputs.js (~150 lines)
- **what:** global input bar state, status indicators. newest code, cleanest.
- **verify:** browser → global bar renders, indicators update

### 4.5 Extract api.js (~100 lines)
- **what:** fetchOperations, checkHealth, executeOp, stopActiveOperation
- **verify:** browser → health check green, ops fetch populates nav

### 4.6 Extract filebrowser.js (~500 lines)
- **what:** openFileBrowser, closeFbModal, navigateUpFb, confirmFbSelection
- **verify:** browser → Browse button opens modal, shows directory

### 4.7-4.16 Extract ui/*.js (one tab per commit)
- **order:** rife (newest, cleanest) → vectors → watcher → styletransfer → withoutbg → facemorph → deepdream → transmute → mosh → multi → quick → advanced → pool (LAST — 3,000 lines)
- **verify after each:** browser → click tab → form renders → zero errors

### 4.17 Switch index.html to module mode
- **what:** replace `<script src="/app.js">` with `<script type="module" src="/js/main.js">`
- **verify:** browser → full reload → every tab works → zero console errors

---

## Phase 5 — Backend Modularization

### 5.1 Split datamosh_ops.py (796 lines)
- **what:** 5 mosh modes → `app/operations/datamosh/` with melt.py, classic.py, hijack.py, destruct.py, mv_hack.py. shared helpers in common.py.
- **order:** melt → classic → hijack → destruct → mv_hack (one per commit)
- **verify after each:** curl that mode dry_run → ok:True. browser → datamosh tab → select mode → renders

### 5.2 Split media_store.py (1,324 lines)
- **target:** `app/media/cache.py` (hashing, index, serving) → `app/media/thumbnails.py` (generation, extraction) → `app/media/pool.py` (state load/save, match, scan) → `app/media/projects.py` (save, load, last, restore)
- **order:** cache → thumbnails → pool → projects (dependency order)
- **verify after each:** pool tab loads, thumbnails render, state persists, projects save/load

---

## Phase 6 — Deep Cleanup

### 6.1 Split deepdream_engine.py (1,069 lines)
- **target:** `app/operations/deepdream/model.py` (loading, presets) → `ascent.py` (gradient loop) → `temporal.py` (blending, flow) → `ouroboros.py` (self-feeding) → `engine.py` (orchestrator)
- **note:** only after phases 1-5. engine is complex, needs stable infrastructure.

### 6.2 Consolidate speed ramp scripts
- **what:** speedramp_png.py (290), speed_ramp.py (147), speedramp_ops.py (187), dream_ramp.py (181), poc_ramp.py (53) → one `app/operations/speedramp/` directory
- **note:** archive or delete proof-of-concept scripts

---

## Phase 7 — New Features (post-cleanup)

### 7.1 CivitAI integration
- **spec:** `docs/civitai-spec.md` (agy — in progress)
- **blocked by:** Phase 5 (needs stable media cache and routes)

### 7.2 Speed ramp end-to-end (M4)
- **blocked by:** optical-flow frame interpolation

### 7.3 QA review pass (M5)

### 7.4 Rubberband audio v2 (M6)

---

## Dependency Graph

```
Phase 1 (dead code) ─────────────────────┐
Phase 2 (verification hooks) ────────────┤
                                          ├─→ Phase 3 (style.css) ─→ Phase 4 (app.js)
                                          │
                                          └─→ Phase 5 (datamosh → media_store)
                                                   │
                                                   └─→ Phase 6 (deepdream, speedramp)
                                                            │
                                                            └─→ Phase 7 (CivitAI, new features)
```

Phases 1+2 can run in parallel with Phase 3. Phase 4 depends on Phase 3. Phase 5 depends on Phase 2. Phase 6 depends on Phase 5. Phase 7 depends on Phase 6.

---

## Rules

1. One commit per item. Bisectable history.
2. Verify after every commit: browser for frontend (Playwright — zero console errors), curl for backend (ok:True).
3. Stop and ask if stuck more than 10 minutes.
4. Don't touch engines until infrastructure around them is clean.
5. Grok reviews this plan before code is written.
6. **Check git status before writing to this file.** Two writers kill the plan.
