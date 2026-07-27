# Project Audit — 2026-07-27

> 21,400 lines of project source (excluding .venv, .git, __pycache__)
> Plan: TODO.md (Claude RC, final — 6 phases, F→D→M→pipeline→filters→features)

---

## Progress

| phase | what | status |
|-------|------|--------|
| 0.1 | nested static routes | ✅ done (66cf7a7) |
| 0.2 | ES module entry | next |
| 0.3 | CSS tokens | pending |
| 1.2 | datamosh twins | ✅ done (ad6f410) |
| 1.1 | app.js.bak | skip (not in tree) |
| 1.3 | cancel audit | pending |

---

## Backend Core (`mtapi-project/app/`)

| file | lines | purpose | depends on | monolith |
|---|---|---|---|---|
| media_store.py | 1,324 | media cache, thumbnails, pool state, project persistence | pathutil, shell | **9/10** — Phase 6 Track M |
| watcher.py | 424 | folder watcher daemon | media_store | 5/10 |
| pathutil.py | 346 | output path naming, collision avoidance, path list parsing, scan_input_dir | — | 3/10 |
| main.py | 299 | app creation, middleware, ops loop, startup | routes, operations, media_store | 3/10 |
| job_control.py | 232 | cancel tokens, progress reporting | — | 3/10 |
| png_pipeline.py | 208 | shared dump/encode/cleanup for neural ops | shell | 3/10 — evolves into VideoPipeline in Phase 3 |
| probe.py | 119 | unified ffprobe (fps, duration, dims, frames) | shell | 2/10 |
| shell.py | 114 | subprocess runner, stdout streaming, tool checks | — | 2/10 |
| contract.py | 51 | OperationResult, OperationSpec, registry | — | 1/10 |
| output_dir_ctx.py | 13 | request-scoped output dir ContextVar | — | 1/10 |

## Operations (`mtapi-project/app/operations/`)

| file | lines | purpose | depends on | monolith |
|---|---|---|---|---|
| deepdream_engine.py | 1,069 | gradient ascent, temporal blending, ouroboros | TF, PIL, pipeline | **8/10** — Phase 4.5 |
| datamosh_ops.py | 796 | melt, classic, hijack, destruct, mv_hack | shell, bin/ | **7/10** — Phase 2 Track D |
| deepdream_ops.py | 392 | deepdream handler | deepdream_engine | 4/10 |
| transmute_ops.py | 352 | crop, stretch, extract, join, grid, fit, raw | shell, pathutil | 5/10 |
| styletransfer_ops.py | 345 | handler | styletransfer_engine | 3/10 |
| withoutbg_engine.py | 344 | background removal | PIL, withoutbg | 4/10 |
| facemorph_ops.py | 331 | handler | facemorph_engine | 3/10 |
| facemorph_engine.py | 295 | dlib landmarks, delaunay | dlib, PIL, pipeline | 4/10 |
| styletransfer_engine.py | 294 | TF-Hub model loading | TF, PIL | 4/10 |
| withoutbg_ops.py | 281 | handler, multi-file support | withoutbg_engine | 4/10 |
| rife_ops.py | 201 | handler, rife-ncnn-vulkan | shell, pipeline | 2/10 |
| speedramp_ops.py | 187 | handler, curve math | pathutil | 3/10 |

## Routes (`mtapi-project/app/routes/`)

| file | lines | endpoints | monolith |
|---|---|---|---|
| picker.py | 188 | 1 (kdialog/zenity/tkinter) | 4/10 |
| media.py | 106 | 8 (video, image, probe, media_info, …) | 3/10 |
| pool.py | 91 | 6 (state, save, load, last, match, scan) | 2/10 |
| meta.py | 89 | 7 (watcher, cancel, facemorph list, job, ops, health) | 3/10 |
| browse.py | 56 | 1 | 1/10 |
| static.py | 47 | 5 (/, /style.css, /app.js, /css/{path}, /js/{path}) | 1/10 — Phase 0.1 done |

## Frontend (`mtapi-project/app/static/`)

| file | lines | purpose | monolith |
|---|---|---|---|
| app.js | 7,620 | ALL UI logic — tabs, forms, pool, file browser, API | **10/10** — Phase 2 Track F |
| style.css | 3,646 | ALL styling — layout, components, operations, pool | **9/10** — Phase 2 Track F |
| index.html | 285 | page structure, nav, global input bar | 2/10 |

## Root Scripts

| file | lines | purpose | monolith |
|---|---|---|---|
| speedramp_png.py | 290 | PNG frame remap | 3/10 |
| speed_ramp.py | 147 | speed ramp CLI | 3/10 |
| datamosh.sh | 102 | datamosh CLI | 2/10 |
| melt.js | 76 | ffglitch melt hook | 1/10 — Phase 1.2 in progress |
| poc_ramp.py | 53 | proof-of-concept | 1/10 |

---

## Summary

**Critical monoliths (9-10/10):**
- app.js (7,620) — Phase 2 Track F
- style.css (3,646) — Phase 2 Track F
- media_store.py (1,324) — Phase 2 Track M

**Significant (7-8/10):**
- deepdream_engine.py (1,069) — Phase 4.5
- datamosh_ops.py (796) — Phase 2 Track D

**Attack order (from final plan):**
Phase 0 (infrastructure) → Phase 1 (easy wins) → Track F (frontend) → Track D (datamosh) → Track M (media) → Phase 3 (pipeline) → Phase 4 (filters) → Phase 5 (mixing) → Phase 6 (features)
