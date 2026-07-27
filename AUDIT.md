# Project Audit — 2026-07-27

> 21,382 lines of project source (excluding .venv, .git, __pycache__)

---

## Backend Core (`mtapi-project/app/`)

| file                | lines | purpose                                                      | depends on                       | monolith                                    |
|---------------------|-------|--------------------------------------------------------------|----------------------------------|---------------------------------------------|
| media_store.py      | 1,324 | media cache, thumbnails, pool state, project persistence     | pathutil, shell                  | **9/10** — four concerns in one file        |
| watcher.py          |   424 | folder watcher daemon                                        | media_store                      | 5/10 — single purpose, moderate size       |
| pathutil.py         |   346 | output path naming, collision avoidance, path list parsing   | —                                | 3/10 — utility, clean                       |
| main.py             |   299 | app creation, middleware, ops loop, startup                  | routes, operations, media_store  | 3/10 — was 700, now thin                    |
| job_control.py      |   232 | cancel tokens, progress reporting                            | —                                | 3/10 — single concern                       |
| png_pipeline.py     |   208 | shared dump/encode/cleanup for neural ops                    | shell                            | 3/10 — clean abstraction                    |
| probe.py            |   119 | unified ffprobe (fps, duration, dims, frames)                | shell                            | 2/10 — four functions, one job              |
| shell.py            |   114 | subprocess runner, stdout streaming, tool checks             | —                                | 2/10 — thin wrapper                         |
| contract.py         |    51 | OperationResult, OperationSpec, registry                     | —                                | 1/10 — tiny                                 |
| output_dir_ctx.py   |    13 | request-scoped output dir ContextVar                         | —                                | 1/10 — one job                              |

## Operations (`mtapi-project/app/operations/`)

| file                  | lines | purpose                                               | depends on          | monolith                                                |
|-----------------------|-------|-------------------------------------------------------|---------------------|---------------------------------------------------------|
| deepdream_engine.py   | 1,069 | gradient ascent, temporal blending, ouroboros, models | TF, PIL, pipeline   | **8/10** — pipeline extracted, still 1K lines of logic  |
| datamosh_ops.py       |   796 | melt, classic, hijack, destruct, mv_hack — 5 modes    | shell, bin/         | **7/10** — five handlers, could split per mode          |
| deepdream_ops.py      |   392 | deepdream handler, param model, UI wiring             | deepdream_engine    | 4/10 — handler is fine, engine is the problem           |
| transmute_ops.py      |   352 | crop, stretch, extract, join, grid, fit, raw — 8 ops  | shell, pathutil     | 5/10 — many sub-ops but each is small                   |
| styletransfer_ops.py  |   345 | handler, content collection, output naming            | styletransfer_engine| 3/10 — thin handler                                     |
| withoutbg_engine.py   |   344 | background removal, frame processing                  | PIL, withoutbg      | 4/10 — moderate                                         |
| facemorph_ops.py      |   331 | handler, UI wiring, param model                       | facemorph_engine    | 3/10 — thin handler                                     |
| facemorph_engine.py   |   295 | dlib landmarks, delaunay, batch morph                 | dlib, PIL, pipeline | 4/10 — pipeline extracted                               |
| styletransfer_engine.py|  294 | TF-Hub model loading, image stylization               | TF, PIL             | 4/10 — pure image processing, no ffmpeg                 |
| withoutbg_ops.py      |   281 | handler, multi-file support, output modes             | withoutbg_engine    | 4/10 — moderate                                         |
| rife_ops.py           |   201 | handler, ffprobe, rife-ncnn-vulkan subprocess         | shell, pipeline     | 2/10 — pipeline extracted, thin                         |
| speedramp_ops.py      |   187 | handler, curve math                                   | pathutil            | 3/10 — thin                                             |

## Routes (`mtapi-project/app/routes/`)

| file       | lines | endpoints                                               | monolith                               |
|------------|-------|---------------------------------------------------------|----------------------------------------|
| picker.py  |   188 | 1 (kdialog / zenity / tkinter)                          | 4/10 — three backends, one purpose     |
| media.py   |   106 | 8 (video, image, probe, media_info, thumbnail, …)       | 3/10 — grouped well                    |
| pool.py    |    91 | 6 (state, save, load, last, match, scan)                | 2/10 — tight                           |
| meta.py    |    89 | 7 (watcher, cancel, facemorph list, job, ops, health)   | 3/10 — misc but small                  |
| browse.py  |    56 | 1                                                       | 1/10 — one endpoint                    |
| static.py  |    29 | 3 (/, /style.css, /app.js)                              | 1/10 — trivial                         |

## Frontend (`mtapi-project/app/static/`)

| file       | lines | purpose                                            | monolith                                |
|------------|-------|----------------------------------------------------|-----------------------------------------|
| app.js     | 7,620 | ALL UI logic — tabs, forms, pool, file browser, API| **10/10** — the mother of all monoliths |
| style.css  | 3,646 | ALL styling — layout, components, operations, pool | **9/10** — one file, 3,600 lines       |
| index.html |   285 | page structure, nav, global input bar               | 2/10 — fine                             |

## Root Scripts

| file             | lines | purpose                         | monolith                |
|------------------|-------|---------------------------------|-------------------------|
| speedramp_png.py |   290 | PNG frame remap for speed ramps | 3/10 — standalone       |
| speed_ramp.py    |   147 | speed ramp CLI                  | 3/10 — standalone       |
| datamosh.sh      |   102 | datamosh CLI                    | 2/10 — bash script      |
| melt.js          |    76 | ffglitch melt hook              | 1/10 — single purpose    |
| poc_ramp.py      |    53 | proof-of-concept ramp           | 1/10 — throwaway         |

---

## Summary

**Critical monoliths (9-10/10):**
- app.js (7,620) — UI needs ES6 module split
- style.css (3,646) — CSS needs component files
- media_store.py (1,324) — four concerns: cache, thumbnails, pool, projects

**Significant (7-8/10):**
- deepdream_engine.py (1,069) — dream logic could split: model, ascent, temporal, ouroboros
- datamosh_ops.py (796) — five mosh modes could each be their own file

**Fine as-is (1-6/10):** everything else — already modularized or single-purpose.

**Attack order:** media_store.py → app.js → style.css → deepdream_engine → datamosh_ops
