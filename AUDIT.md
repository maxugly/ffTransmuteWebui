# Project Audit — 2026-07-29 (post-modularization)

> 21,487 lines of project source (excluding .venv, .git, __pycache__)
> 68 files total · 21,382 → 21,487 (+105: import/export boilerplate + UI fixes)

---

## Frontend Module Tree (`mtapi-project/app/static/js/`)

| file | lines | purpose | monolith |
|---|---|---|---|
| main.js | 10 | ES module entry shim — imports app.js | 1/10 |
| utils.js | 35 | basename, escapeHtml, formatDurationExact, isVideoPath | 1/10 |
| pool/constants.js | 34 | POOL_ZOOM, POOL_LAYOUT_DEFAULTS, TILE_INFO_FIELDS, VIDEO_EXTS | 1/10 |
| tabs/rife.js | 114 | RIFE interpolation UI | 1/10 |
| pool/layout.js | 183 | pool dock resize/collapse chrome | 2/10 |
| tabs/styletransfer.js | 200 | neural style transfer UI | 2/10 |
| tabs/withoutbg.js | 204 | background removal UI | 2/10 |
| preview.js | 207 | media viewer + console + resize handle | 2/10 |
| tabs/quick.js | 208 | right-click transmute UI | 2/10 |
| tabs/watcher.js | 234 | folder watcher UI + API calls | 2/10 |
| ui/knobs.js | 242 | continuous + binary rotary knob factories | 2/10 |
| tabs/facemorph.js | 285 | dlib landmark morph UI + deepdream chain | 2/10 |
| timeline.js | 384 | video probe + global frame range slider | 3/10 |
| pool/items.js | 419 | select/remove/clear/add/import/send/apply — all pool mutations | 3/10 |
| tabs/transmute.js | 461 | single-clip dropdown + multi join/grid + raw CLI | 3/10 |
| pool/chrome.js | 472 | tile zoom, info menu, context menu, file browser | 3/10 |
| tabs/deepdream.js | 477 | gradient ascent UI — knobs, ouroboros, temporal params | 3/10 |
| tabs/datamosh.js | 479 | 5 mosh modes + vector pad + melt pad + DAW knobs | 3/10 |
| job-control.js | 505 | run/stop/poll cycle, cancel tokens, result display | 3/10 |
| pool/persistence.js | 557 | project save/load/restore, pool state serialization | 3/10 |
| pool/grid.js | 825 | renderPoolForm + renderPoolGrid — the pool main view | **5/10** — single concern but large |
| pool/sequence.js | 854 | sequence composer + transport + playback | **5/10** — single concern but large |

## Frontend App Shell

| file | lines | purpose | monolith |
|---|---|---|---|
| app.js | 751 | state, init, global inputs sync, tab routing, export block | 2/10 — skeleton, was 7,677 |
| index.html | 309 | page structure, nav, global input bar | 2/10 |
| style.css | 3,767 | ALL styling — layout, components, operations, pool | **9/10** — 3,700 lines, one file |
| css/layout.css | 206 | global bar, app workspace, preview panel (extracted F.2) | 1/10 |

## Backend Core (`mtapi-project/app/`)

| file | lines | purpose | depends on | monolith |
|---|---|---|---|---|
| media_store.py | 1,324 | media cache, thumbnails, pool state, project persistence, frame extraction | pathutil, shell | **9/10** — four concerns, never touched |
| watcher.py | 424 | folder watcher daemon | media_store | 5/10 |
| pathutil.py | 346 | output path naming, collision avoidance, path list parsing | — | 3/10 |
| main.py | 299 | app creation, middleware, ops loop, startup | routes, operations, media_store | 3/10 |
| job_control.py | 232 | cancel tokens, progress reporting | — | 3/10 |
| png_pipeline.py | 208 | shared dump/encode/cleanup for neural ops | shell | 3/10 |
| probe.py | 119 | unified ffprobe (fps, duration, dims, frames) | shell | 2/10 |
| shell.py | 114 | subprocess runner, stdout streaming, tool checks | — | 2/10 |
| contract.py | 51 | OperationResult, OperationSpec, registry | — | 1/10 |
| output_dir_ctx.py | 13 | request-scoped output dir ContextVar | — | 1/10 |

## Operations (`mtapi-project/app/operations/`)

| file | lines | purpose | depends on | monolith |
|---|---|---|---|---|
| deepdream_engine.py | 1,069 | gradient ascent, temporal blending, ouroboros, model loading | TF, PIL, png_pipeline | **8/10** — pipeline extracted, still 1K lines of dream logic |
| datamosh_ops.py | 800 | melt, classic, hijack, destruct, mv_hack — 5 mosh modes | shell, bin/ | **7/10** — five handlers, shared helpers |
| deepdream_ops.py | 392 | deepdream handler, param model, UI wiring | deepdream_engine, contract | 4/10 |
| transmute_ops.py | 352 | crop, stretch, extract, join, grid, fit, raw — 8 sub-ops | shell, pathutil | 5/10 |
| facemorph_engine.py | 350 | dlib landmarks, delaunay, batch morph | dlib, PIL, png_pipeline | 4/10 |
| facemorph_ops.py | 350 | handler + UI wiring | facemorph_engine | 4/10 — mirror of engine |
| styletransfer_ops.py | 345 | handler, content collection, output naming | styletransfer_engine | 3/10 |
| withoutbg_engine.py | 344 | background removal, frame processing | PIL, withoutbg | 4/10 |
| styletransfer_engine.py | 294 | TF-Hub model loading, image stylization | TF, PIL | 4/10 |
| withoutbg_ops.py | 281 | handler, multi-file support, output modes | withoutbg_engine | 4/10 |
| rife_ops.py | 201 | handler, ffprobe, rife-ncnn-vulkan subprocess | shell, png_pipeline | 2/10 |
| speedramp_ops.py | 187 | handler, curve math | pathutil | 3/10 |

## Routes (`mtapi-project/app/routes/`)

| file | lines | endpoints | monolith |
|---|---|---|---|
| picker.py | 188 | 1 (kdialog/zenity/tkinter) | 4/10 |
| media.py | 106 | 8 (video, image, probe, media_info, thumbnail, hash, export, cache) | 3/10 |
| pool.py | 91 | 6 (state, save, load, last, match, scan) | 2/10 |
| meta.py | 89 | 7 (watcher, cancel, facemorph list, job, ops, health) | 3/10 |
| browse.py | 56 | 1 | 1/10 |
| static.py | 47 | 5 (/, /style.css, /app.js, /css/{path}, /js/{path}) | 1/10 |

## Root Scripts

| file | lines | purpose | monolith |
|---|---|---|---|
| bin/transmute | 572 | transmute CLI binary | 5/10 |
| dream_ramp.py | 181 | dream + speed ramp combo | 3/10 |
| bin/custom_glitch.js | 80 | ffglitch custom glitch JS | 1/10 |
| bin/melt.js | 76 | ffglitch melt hook | 1/10 |
| run.py | 33 | server startup (uvicorn :24590) | 1/10 |
| bin/no_keyframe.js | 4 | ffglitch no-keyframe JS | 1/10 |

---

## Summary

**Critical monoliths (7-10/10) — three remaining:**

| file | lines | rating | why |
|---|---|---|---|
| style.css | 3,767 | **9/10** | all styling in one file — next target |
| media_store.py | 1,324 | **9/10** | four concerns: cache, thumbnails, pool, projects |
| deepdream_engine.py | 1,069 | **8/10** | dream logic: model, ascent, temporal, ouroboros |
| datamosh_ops.py | 800 | **7/10** | five mosh modes — could split per mode |

**What changed (frontend):**

| metric | before | after |
|---|---|---|
| app.js | 7,677 lines (10/10 monolith) | 751 lines (2/10 skeleton) |
| JS modules | 0 files | 22 files (7,389 lines) |
| tab renderers | 0 | 9 files (2,662 lines) |
| pool logic | 0 | 7 files (3,344 lines) |
| shared utilities | 0 | 4 files (893 lines) |

**Attack order (next):**
1. style.css — CSS component split (F.3-F.??)
2. media_store.py — split cache from pool from projects (Phase 6 Track M)
3. deepdream_engine.py — split model loading, ascent loop, temporal blending, ouroboros (Phase 4.5)
4. datamosh_ops.py — split per mosh mode (Phase 2 Track D)
