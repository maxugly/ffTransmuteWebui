# TODO-grok-v2 — Working Plan (next iteration)

> grok · 2026-07-27 · **v2**  
> Inputs: `docs/TODO-agy-v2.md`, `docs/TODO-tom-v2.md`, `docs/TODO-grok.md` (v1), tree  
> Role: Spec Writer — plan only (`docs/`)

---

## 0. What this document is

The **builder-facing attack plan** after reconciling three v2-ish directions:

| source | keep | drop / correct |
|--------|------|----------------|
| **agy-v2** | Phase 0 footguns; parallel Tracks M/D/F; facade; `open_media` out of cache; JobWorkspace → VideoPipeline → Filters → mix; CivitAI after Track M | Engine conversion before isolation is already fixed in agy-v2 — good |
| **tom-v2** | Per-item verify tables; CSS before deep JS; datamosh common→modes; easy-wins phase; rife-first filter order; explicit agree/diff | Still-wrong facts (below); “frontend must finish before media_store / pipeline core”; `window.state` as *only* module strategy; “root TODO.md always wins” while root is stale |
| **grok-v1** | Code-verified Done; track parallelism; media layering; pool/run.js sub-splits; anti-patterns; real-run not fake dry_run | Over-claimed “canonical” vs human root list — v2 clarifies authority |

**Authority:** the **tree** is truth for “is it done?”. This file is truth for **order and verify**. Root `TODO.md` is a short human checklist — **sync it from this plan**, do not let a stale root line resurrect finished work. When root and this conflict on *status*, open the file. When they conflict on *order*, prefer this plan unless max says otherwise.

---

## 1. Tom-v2 corrections (must fix before codewhale runs that doc)

These are still wrong in `TODO-tom-v2.md` against the tree **today**:

| tom-v2 item | reality | v2 plan does instead |
|-------------|---------|----------------------|
| 1.1 delete `app.js.bak` | **File does not exist** | Skip. Do not run `tools/rename_appjs.py` (creates bak by renaming live app.js) |
| 1.2–1.3 point **shell.py** at root melt/no_keyframe | Constants are in **`datamosh_ops.py`** (`MELT_JS`, `NO_KEYFRAME_JS`) | Edit datamosh_ops (or future package common) |
| curl datamosh `dry_run` | **No dry_run** on any datamosh params model | Real short run on `/tmp/teste.mp4`, **or** add dry_run first (item D.0) |
| 2.1 implement cancel in multi-file loops | **Already present** (withoutbg / facemorph / styletransfer) | Verify-only; expand cancel to **datamosh pipeline** |
| 2.2 wire `verify_paths_exist` | **Already wired** in those multi-file handlers | Verify-only curl with missing path |
| 4.x `ui/vectors.js` | **No vectors tab** in `index.html` / app.js | Drop. Mosh owns pad UI |
| 6.1 cache includes “file serving” / thumbs endpoint as cache proof | Serving thumbs needs **thumbnails** layer; `open_media` not cache | cache = hash/index/records only |
| Phase 4 requires Phase 3 complete | Only share `index.html` link list | CSS ∥ JS after nested static (0.1) |
| media_store only after full frontend | Frontend is a *convenient* verify surface, not a hard dep for facade | Facade+M can start after Phase 0; single builder may still serialise F→D→M |
| root TODO.md always wins | Root still lists pool routes / watcher split as open — **false** | Sync root from §2 Done |

---

## 2. Done (do not re-implement)

Code-verified 2026-07-27:

- [x] PNG pipeline paths for neural ops; `app/probe.py`
- [x] `datamosh.sh` root via `shell.py`; route split (static, browse, media, picker, **pool**, **meta**)
- [x] Pool API (state, project, match, scan); watcher/cancel/job/ops/health
- [x] Global inputs bar; multi-file withoutbg/facemorph/styletransfer
- [x] `check_cancelled` between images (those three + deepdream loops)
- [x] `parse_path_list` / `verify_paths_exist` / `scan_input_dir`; pathOut → `X-MTAPI-Output-Dir`
- [x] Tab status indicators for global video/image
- [x] Specs under `docs/*-spec.md` (implement later)

---

## 3. Design principles (consensus)

1. **Phase 0 before any CSS/JS extract** (agy + grok + tom 3.0/4.0).
2. **Facade before media_store guts move** (agy + tom + grok).
3. **`open_media` ∉ cache.py** (agy + grok; tom 6.5 agrees).
4. **Datamosh: common pipeline first, then thin modes** (all three).
5. **Old engines coexist during Filter migration** (all three).
6. **One commit per item; verify before next** (tom emphasis, keep).
7. **Destination:** JobWorkspace → VideoPipeline → Filters → Model Manager → `/ops/pipeline` + Multi-Pass (agy architecture, tom Phase 7, grok Phases 5–7).
8. **Modules, not classic multi-script** for app.js (all agree; implementation detail in 4.0).

---

## 4. Dependency graph (v2 compromise)

```
Phase 0  footguns (static + module entry + base.css)
    │
    ├─ Phase 1  easy wins (twins, footgun scripts)     ─┐
    ├─ Phase 2  inputs VERIFY-only (cancel/paths)      ─┤  quick; parallel OK
    │                                                   │
    │         ┌─────────────────────────────────────────┘
    │         ▼
    │    ┌─ Track F: CSS then JS modules ─────────────┐
    │    ├─ Track D: datamosh package + pipeline cancel┤  parallel OK after Phase 0
    │    └─ Track M: media facade → layered split ─────┘  (single builder: F → D → M)
    │                        │
    │                        ▼
    │              Phase 5  JobWorkspace → VideoPipeline core
    │                        │
    │              Phase 6  Op→Filter (rife first) + Model Manager when chaining
    │                        │
    │              Phase 7  POST /ops/pipeline + Multi-Pass UI
    │                        │
    │              Phase 8  Features (CivitAI after Track M; ASCII after pipeline)
```

| claim | v2 ruling |
|-------|-----------|
| CSS before deep JS extracts | **Yes** for single builder (tom) — lower risk; after 0.1 both *may* parallel |
| Full Track F before Track M | **No hard dep.** Soft: single builder may finish F first so WebUI verify is less painful |
| Full Track F before VideoPipeline *core* | **No.** Core is server-side (agy timing for pipeline after isolation, not after UI polish) |
| Full Track F before Op→Filter + Multi-Pass UI | **Yes for Multi-Pass UI.** Soft for pure filter backend tests via curl |
| Track M before CivitAI | **Yes** |
| Track D before ffglitch-style ops | **Helpful, not absolute** |

---

## Phase 0 — Infrastructure safety (do first)

> Shared by agy-v2 §0, tom-v2 3.0/4.0, grok-v1 Phase 0.

| # | what | approach | verify |
|---|------|----------|--------|
| **0.1** | Nested static routing | Extend `routes/static.py` (StaticFiles or wildcards) for `/css/*`, `/js/**`. Keep `/`, `/style.css`, `/app.js` until cutover | `GET /css/_ping.css` → 200; `GET /js/_ping.js` → 200; remove pings |
| **0.2** | ES module entry | `index.html` → `<script type="module" src="/js/main.js">`. `main.js` imports current app as one module first. Prefer **ES `export`/`import`** for `state`/`elements`; attach **bridges** on `window` only for inline handlers (`openFileBrowser`, `removeMultiClip`, `moveMultiClip`). Tom’s `window.state` is acceptable transitional glue if exports fight you — don’t rely on classic multi-`<script>` + top-level `let` | Cold load → health green → all tabs render → zero console errors → mosh Browse opens modal |
| **0.3** | CSS `base.css` | Extract `:root` + dependent resets → `css/base.css`; link **before** other CSS | Hard reload → mosh + pool colors/spacing unchanged |

**Exit:** nested assets work; app is a module; tokens in base.css.

---

## Phase 1 — Easy wins (tom Phase 1, corrected)

| # | what | approach | verify |
|---|------|----------|--------|
| **1.1** | ~~app.js.bak~~ | **No-op** — file absent. Optional: delete or quarantine `tools/rename_appjs.py` | n/a |
| **1.2** | melt.js twins | Root ≡ bin (byte-identical). Point **`datamosh_ops.py` `MELT_JS`** at repo-root `melt.js`. Delete `bin/melt.js`. Update bin README/AGENTS | Real melt on `/tmp/teste.mp4` → ok (or D.0 dry_run if added). **Not** shell.py |
| **1.3** | no_keyframe twins | Same for `NO_KEYFRAME_JS`; delete `bin/no_keyframe.js`. Leave `custom_glitch.js` in bin | Real classic on `/tmp/teste.mp4` → ok |
| **1.4** | Sync root `TODO.md` | Move false “next” items (pool routes, watcher split, etc.) to done or delete | Root matches §2 |

---

## Phase 2 — Global inputs (verify-only + residual polish)

> Tom Phase 2 as *implementation* is largely already done. Do not re-wire.

| # | what | approach | verify |
|---|------|----------|--------|
| **2.1** | Cancel audit (image batches) | Confirm `check_cancelled` in withoutbg/facemorph/styletransfer loops | Multi-image run → Stop → next file does not start |
| **2.2** | Existence verify audit | Confirm `verify_paths_exist` at handler tops | withoutbg with missing path → `ok:false` + paths named |
| **2.3** | Datamosh/long-op cancel | Add checks between pipeline stages in datamosh common (pair with Track D) | Stop during mosh → cancelled status; document if child ffmpeg can’t die mid-process |
| **2.4** | Path-in / pathOut polish | Only if product gaps remain: pathIn scan into list ops; pathOut already sends header — verify all Run paths | pathOut set → outputs under dir; pathIn dir feeds at least one multi-image op |

---

## Track F — Frontend modularization

> After Phase 0. Tom Phase 3–4 structure + grok module list + agy “pool/run last”.

### F.CSS (tom 3.1–3.8, pool media queries stay with pool)

| # | what | verify |
|---|------|--------|
| F.1 | Section map (line ranges) | map committed |
| F.2 | `layout.css` | structure, all tabs |
| F.3 | `forms.css` (inputs, knobs, toggles) | knobs on deepdream |
| F.4 | `console.css` | terminal + stage |
| F.5 | `modals.css` | Browse modal |
| F.6 | `pool.css` **including pool `@media`** | pool grid + dock |
| F.7 | `ops.css` (mosh timeline/compare, watcher, quick leftovers) | mosh timeline usable |
| F.8 | Drop empty `style.css` | full reload look-identical |

Do **not** dump all `@media` into a final `responsive.css` if they belong to pool/ops — tom 3.7 is optional only for true globals.

### F.JS (modules only)

| order | module | notes | verify |
|------:|--------|-------|--------|
| 1 | `js/state.js` | state + pool default helpers (not “no functions”) | tab switch keeps globals |
| 2 | `js/elements.js` | static DOM refs | load clean |
| 3 | `js/shared/knobs.js` | daw knobs | deepdream knobs write values |
| 4 | `js/global-inputs.js` | bar + indicators | indicators flip by tab |
| 5 | `js/api.js` | health, ops, **runOpWithCancel**, stop, progress | health; Stop works |
| 6 | `js/filebrowser.js` | + window bridge | Browse works |
| 7 | `js/router.js` | switchTab, renderTabForm, init | every tab mounts |
| 8–16 | `js/ui/<tab>.js` | **rife → watcher → styletransfer → withoutbg → facemorph → deepdream → transmute → mosh → multi → quick → advanced**. **No vectors tab** | each form renders |
| 17 | `js/ui/pool/*` | sub-split: grid, sequence, playback, persist/projects, match, context | **pool matrix** below |
| 18 | `js/run.js` | `runActiveOperation` + collectors | Run mosh + one neural e2e |
| 19 | `js/preview.js` | AR viewer, console resize, displayOpResult | preview non-zero box |

**After each JS commit:** cold load → target tab → zero console errors.  
**Not enough for pool/run:** form paint only.

**Pool matrix (item 17):** import → thumbs; reload → restore; sequence edit; project save/load; match results; Send-to other tab.

**Track F exit:** runtime is `js/main.js` only; no required monolith `app.js`.

---

## Track D — Datamosh package (tom Phase 5 + agy Track D)

| # | what | approach | verify |
|---|------|----------|--------|
| **D.0** | Optional dry_run | Add to params; skip ffgac/ffedit when true | dry_run → ok, no output file |
| **D.1** | `common.py` | `_execute_mosh_pipeline`, `_trim_and_mosh`, helpers; cancel between stages (2.3) | real melt `/tmp/teste.mp4` → ok |
| **D.2–D.6** | melt → classic → hijack → destruct → mv_hack | thin handler + register per file | each mode once + WebUI dropdown |
| **D.7** | package `__init__` + `operations/__init__.py` | REGISTRY lists 5 ids | `GET /ops` contains all five |

---

## Track M — Media facade + split (tom Phase 6 + agy Track M + grok layering)

| # | what | content | verify |
|---|------|---------|--------|
| **M.0** | Facade | `app/media/__init__.py` re-exports public API; `media_store.py` shim or migrate imports | health; pool loads; media_info works |
| **M.1** | `cache.py` | hash, index, records, locks, `resolve_hash`, `record_operation` — **no** thumb gen, **no** open_media | same path → same hash; cached hit |
| **M.2** | `thumbnails.py` | extract, ensure_thumbs, phash, get_thumb_file, export_frame | first+last JPEG; extract_v gate |
| **M.3** | `open.py` | `open_media`, `public_payload` (stop private `_public_payload` in routes) | `/api/media_info` ok |
| **M.4** | `pool.py` | session state load/save/normalize only | persist across restart; missing filtered |
| **M.5** | `match.py` | `match_frames` (cache+thumbs+pool) | two clips → distances |
| **M.6** | `projects.py` | save/load/last; **mirror to session pool_state** on save | project round-trip + autosave updated |

**Invariant:** on-disk `~/.cache/mtapi/media/` layout unchanged.  
**Locks:** single source — do not duplicate `_index_lock` / `_pool_state_lock`.

---

## Phase 5 — Unified pipeline core (agy-v2 Phase 2 / tom 7.1–7.2)

> After Track M facade is stable enough to build on. **Does not require Track F complete.** Prefer Track D done if you will mosh through pipeline later; not a hard gate for identity pipeline.

| # | what | approach | verify |
|---|------|----------|--------|
| **5.1** | JobWorkspace | `/tmp/mtapi_jobs/{job_id}/{frames_in,frames_out,audio*,metadata.json}`; pilot one op | failure keeps workspace when flagged; success cleans (configurable) |
| **5.2** | VideoPipeline core | evolve `PngFramePipeline` → probe, dump, loop hook, encode, mux | **identity** pass on `/tmp/teste.mp4` playable (+ audio if present) |
| **5.3** | Dual-path doc | old loops remain until Phase 6 migrates | note in ops README |

---

## Phase 6 — Op→Filter + Model Manager (tom 7.3–7.4 / agy-v2 Phase 3–4)

**Filter order (tom wins — better than withoutbg-first for pipeline fit):**

| order | op | risk | why |
|------:|-----|------|-----|
| 1 | rife_ops | low | already PngFramePipeline-shaped |
| 2 | withoutbg | low | pure image |
| 3 | styletransfer | low | pure image |
| 4 | facemorph | medium | dlib |
| 5 | deepdream | high | temporal / ouroboros |

- One engine per commit series; old path until cutover.  
- **Model Manager** only when two heavy models share a process chain.  
- Optional: deepdream file split and speedramp script consolidate after dream filter or as pure moves with zero behavior change.

**Verify per engine:** WebUI or curl test asset green; cancel mid-batch still works.

---

## Phase 7 — Dynamic mixing (tom 7.5 / agy-v2 Phase 4)

| # | what | verify |
|---|------|--------|
| **7.1** | `POST /ops/pipeline` JSON steps | `[identity]` and one real filter on test clip |
| **7.2** | Multi-Pass UI | needs Track F far enough for a new tab (`run.js` modular) — two-step queue runs, zero console errors |
| **7.3** | Node editor | **someday** — out of near-term scope |

---

## Phase 8 — New features

| # | what | blocked by | spec |
|---|------|------------|------|
| 8.1 | CivitAI | **Track M** (not full Phase 6 engines) | `civitai-spec.md` |
| 8.2 | ASCII | Phase 5.2 pipeline | `ascii-spec.md` |
| 8.3 | FFglitch pixel sort / MV pan | Track D patterns helpful | `ffglitch-spec.md` |
| 8.4 | Speed ramp E2E | optical-flow / product | speedramp specs |
| 8.5 | Rubberband audio v2 | — | TBD |
| 8.6 | QA pass | after a feature wave | checklist |

---

## Single-builder default schedule (tom risk appetite + grok deps)

If **one** person (codewhale) and low thrash is the goal:

1. Phase 0 → Phase 1 → Phase 2 (verify)  
2. Track F full (CSS then JS)  
3. Track D  
4. Track M  
5. Phase 5 → 6 → 7 → 8  

If **two+** builders:

- After Phase 0: **F ∥ D ∥ M** (agy/grok).  
- Pipeline core can start when M.0–M.3 are green, even if F incomplete.  
- Multi-Pass UI waits on F.

---

## Agree / differ matrix (updated)

| topic | agy-v2 | tom-v2 | **grok-v2** |
|-------|--------|--------|-------------|
| Phase 0 footguns | yes | yes (as 3.0/4.0) | **yes — mandatory first** |
| Parallel M/D/F | yes | says yes then serialises M after F | **parallel allowed; serial default for one builder** |
| media after full frontend | no | yes | **no hard gate** |
| pipeline after full frontend | no (after isolation) | yes | **core after isolation; UI Multi-Pass after F** |
| open_media location | open.py | open.py (6.5) | **open.py** |
| rife-first filters | withoutbg-first in v1; v2 lists withoutbg first | rife first | **rife first (tom)** |
| easy wins / twins | thin | Phase 1 | **Phase 1 corrected** |
| dry_run datamosh | — | assumes exists | **add or real-run** |
| vectors tab | — | listed | **does not exist** |
| root TODO authority | — | root wins | **tree + this plan; sync root** |

---

## Anti-patterns (instant fail)

1. Classic multi-`<script>` split with top-level `let state`.  
2. `open_media` / get_thumb inside pure `cache.py`.  
3. “curl datamosh dry_run” before dry_run exists.  
4. Deleting nonexistent `app.js.bak` or running `rename_appjs.py` as cleanup.  
5. Trusting root `TODO.md` “next” without opening routes/.  
6. One-commit conversion of all engines to Filters.  
7. Changing on-disk media cache layout without migration.  
8. Inventing a vectors tab extract that isn’t in the HTML.

---

## Related docs

| doc | role |
|-----|------|
| `docs/TODO-agy-v2.md` | filter-graph destination, short form |
| `docs/TODO-tom-v2.md` | builder serial plan — **apply §1 corrections** |
| `docs/TODO-grok.md` | v1 long form |
| `docs/todo-review.md` | original ruthless review |
| `ROADMAP.md` | long-term vision |
| root `TODO.md` | short checklist — keep synced via 1.4 |
| `AGENTS.md` | roles, `/tmp/teste.*`, WebUI verify |

---

## Bottom line

**v2 = agy destination + tom verify discipline + grok tree truth.**

```
0 footguns → 1 easy wins → 2 verify inputs
    → (F ∥ D ∥ M)  [or F then D then M if alone]
    → Workspace → Pipeline → Filters (rife→…) → Mix → Features
```

Do not ship tom-v2 Phase 1–2 as written without the §1 fact fixes. Do not delay media facade or pipeline *core* on a finished CSS split. Do delay Multi-Pass UI and “frontend is the only verify surface for media” mythology until the facade has its own curl matrix.
