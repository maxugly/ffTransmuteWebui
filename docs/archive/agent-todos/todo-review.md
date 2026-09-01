# TODO.md Review — Ruthless Pass

> Reviewer: grok · Date: 2026-07-27  
> Scope: `TODO.md` master plan vs actual tree (`media_store.py`, `app.js`, `style.css`, `static.py`, `datamosh_ops.py`, cancel hooks, twins)  
> Role: Spec Writer — findings only; no code changes outside `docs/`.

---

## Summary verdict: **has gaps**

The phase *intent* is right (dead code → cancel audit → frontend split → backend split → engines → features). The dependency graph and several item definitions would actively mislead a builder into broken intermediate states or false-green verification.

Three plan-breaking issues:

1. **Phase 4 assumes progressive multi-file extraction before module mode (4.17), but classic multi-`<script>` cannot share `let`/`const` state.** Today `app.js` has ~17 top-level `let`/`const` bindings (`state`, `elements`, timers, constants) and only ~6 `window.*` attachments. Extracting `state.js` + `elements.js` as classic scripts leaves later scripts unable to see those bindings. Module mode must start at the *first* extract, not the last.
2. **`routes/static.py` only serves `/`, `/style.css`, and `/app.js`.** Phases 3–4 never mention extending static serving. Without `StaticFiles` (or per-path routes) for `css/*` and `js/*`, every extract 404s.
3. **`media_store` “cache → thumbnails” order is right only if “serving / open” is *not* parked in cache.** `open_media` and `get_thumb_file` call `ensure_thumbs` / `extract_frame`. Putting “serving” in `cache.py` creates `cache → thumbnails` while thumbs need cache paths/records → circular import risk the plan never addresses. Cross-cutting `match_frames` and `open_media` have no home in the four-box split.

Everything else is fixable (wrong file targets, already-done Phase 2, impossible dry_run checks, weak verification). Direction is salvageable; as written it is not safe to execute blindly.

---

## Per-phase findings

### Phase 1 — Dead Code & Easy Wins

| Item | Verdict | Evidence |
|------|---------|----------|
| 1.1 Delete `app.js.bak` | **Stale / no-op** | `mtapi-project/app/static/` has only `app.js`, `style.css`, `index.html`, docs. No `.bak`. `tools/rename_appjs.py` would *create* a bak by renaming live `app.js` — dangerous if someone runs it thinking cleanup. “Old style.css if split CSS exists” — split does **not** exist; only monolith `style.css` (3646 lines). |
| 1.2 melt.js twins | **Partially wrong target** | Twins are byte-identical (`cmp` clean). But `MELT_JS` / `NO_KEYFRAME_JS` live in **`datamosh_ops.py` lines 21–23**, not `shell.py`. `shell.py` only has `BIN_DIR`, `TRANSMUTE`, root `DATAMOSH`. Plan says “shell.py — add MELT_JS constant” — wrong file. |
| 1.3 no_keyframe twins | Same as 1.2 | Correct twin claim; same wrong ownership. |

**Verification failure (1.2 / 1.3 / later datamosh):**

- `datamosh_ops` has **no `dry_run` field** on any params model and no dry-run branch in handlers. `curl … dry_run` will either 422 or **run a full ffgac/ffedit pipeline**. Plan’s “dry_run → ok:True” cannot work as written.
- Even a real run only proves the *path string* resolves; it does not prove “root copy vs bin copy” policy is consistent with `bin/AGENTS.md` (“Scripts in `bin/` are for the API. Root scripts are the single source of truth”) — which currently means **API uses bin copies** for melt/no_keyframe while datamosh.sh already points root. Pointing JS at root is consistent with datamosh.sh; deleting bin copies without updating `bin/README.md` / agent docs leaves packagers blind. `custom_glitch.js` remains bin-only — plan never says what to do with that sibling.

**Missing Phase 1 items:**

- Delete or quarantine `tools/rename_appjs.py` (footgun: renames live app.js → bak).
- Align docs (`bin/README.md`, `bin/AGENTS.md`) when twins go.
- Optional: `shell.py` still has dead `probe_duration` TODO re-export — easy win, unlisted.

---

### Phase 2 — Backend Verification Hooks

**Status: largely already implemented; phase is mis-scoped as work.**

Cancel is already present in the three named multi-file ops:

| Op | Multi-file cancel location |
|----|----------------------------|
| `withoutbg` | `withoutbg_engine.process_many` loop `check_cancelled()` before each image; progress_cb also checks |
| `styletransfer` | explicit `check_cancelled()` at start of each content image in `styletransfer_ops` |
| `facemorph` | `check_cancelled()` in faces_first dream loop + progress_cb |
| `deepdream` | engine loops + ops (not even listed in Phase 2) |

What Phase 2 will actually find if someone “implements” it: **nothing to write**, unless they expand scope.

**Real cancel gaps the plan ignores:**

- `datamosh_ops._execute_mosh_pipeline` — multi-step ffgac/ffedit/ffmpeg, **zero** `check_cancelled`. Long moshes ignore Stop until process ends (unless outer layer kills — it doesn’t; cooperative only).
- `rife_ops` / `speedramp_ops` — no cancel hooks (single long subprocess; still worth token + kill strategy or at least check around phases).
- Verify wording: “current file finishes, next does NOT start” is correct for image batches; for video engines the failure mode is “stuck inside one frame for minutes” — different check.

**Ordering note:** Phase 2 is pure verification/small patches. Graph correctly allows parallel with Phase 3. It should **not** block Phase 5 datamosh split — unless you expand Phase 2 to add cancel inside the shared mosh pipeline *before* splitting that pipeline into `common.py` (actually better *while* touching common, not as a hard prerequisite).

---

### Phase 3 — style.css split

**Right idea, incomplete logistics, overstated sequential dependency on Phase 4.**

#### What the plan gets right

- Mechanical extract is lower risk than JS logic.
- Section map first (3.1) is correct — file has real comment islands (sidebar ~73, forms ~318, knobs ~1217, pool ~1698+, modals ~949, watcher ~3586).

#### Gaps

1. **No static serving work.** `routes/static.py` hardcodes two files. Plan jumps to `css/layout.css` without:
   - mounting `StaticFiles` on `/css` or `/static`, **or**
   - adding routes per file, **or**
   - changing `index.html` link tags *and* cache headers.
2. **No `base.css` / `:root` extraction.** Lines 3–40 define design tokens (`--bg-color`, `--primary`, …). Every later file depends on them. Plan’s first extract is “layout.css (nav, header…)” — if tokens stay only in dying `style.css` or get duplicated, cascade breaks.
3. **Section boundaries are not clean.**  
   - Timeline dual-range (~1480) is mosh-form, not generic “forms”.  
   - Pool `@media` blocks sit *inside* pool sections (2116, 2512, 3274) — “responsive.css” as a final dump will either miss them or double-define.  
   - `.pool-workspace` toggled from JS (`switchTab`) couples layout + pool CSS; split order matters for visual verify.
4. **Verification “styling identical / every tab renders” is weak.** CSS regressions hide in: dual-thumb timeline z-index, pool dock drag heights (`--sel-h`), knob banks, mosh compare slider, context menu stacking. Need a **checklist of interactive UI states**, not just tab click + zero console errors (console rarely reports CSS bugs).

#### Dependency on Phase 4

**False.** CSS and JS modularization share only `index.html` link/script tags. They can run in parallel on separate commits if one person owns index link list updates. Graph line `Phase 3 → Phase 4` should be removed or reduced to “don’t thrash index.html the same day without coordinating.”

---

### Phase 4 — app.js split

**Highest-risk phase; plan underestimates entanglement and picks a non-viable transitional strategy.**

#### Line budget reality (approx)

| Region | Lines | Notes |
|--------|-------|-------|
| state + pool defaults + helpers | 1–164 | Not “no functions” — `ensurePoolLayout`, `defaultTileInfo`, `ensureTileInfo` live here |
| elements | 165–190 | `getElementById` at load |
| global inputs | 192–286 | |
| init / listeners / health / tabs | 287–490 | **switchTab/renderTabForm is the router — unlisted as extract** |
| watcher | 491–719 | |
| knobs (shared) | 720–961 | |
| tab forms | 962–3698 | rife, wbg, facemorph, dream, quick, mosh, transmute, multi, advanced |
| **pool** | **3699–6915 (~3.2k)** | plan says 3,000 — close enough |
| job run / preview | 6916–end (~700) | **runActiveOperation is a giant switch over every tab — unlisted** |

#### Critical strategy flaw: 4.1–4.16 before 4.17 modules

Today:

```html
<script src="/app.js"></script>
```

Classic scripts: top-level `function` is global; top-level `let`/`const` is **not** shared across separate classic script files. Progressive extract without modules **breaks** unless every shared binding is moved to `window` (not planned) or files are concatenated (not planned).

**Required change:** treat 4.17 (module entry + static routes for `/js/*`) as **4.0**, then extract behind `import`/`export`. One commit that only switches to a single `main.js` re-exporting the old monolith is valid; then slice.

#### Element/state estimates are wrong

- **4.1 elements.js “~25 lines”** — actual block ~25 lines of keys, fine; but many tabs use `document.getElementById` ad hoc after render. Extracting “elements” does not capture dynamic nodes.
- **4.2 state.js “~165 lines, no functions”** — false. Pool layout/tile helpers are functions with side effects on `state`. Splitting “pure state” from “state helpers” needs a decision.
- **4.5 api.js** — plan lists `fetchOperations, checkHealth, executeOp, stopActiveOperation`. Actual job stack is larger: `runOpWithCancel`, progress poll, `setRunUiBusy`, `displayOpResult`, `newJobToken`. Partial extract leaves circular imports between api and UI.

#### Cross-tab coupling the extract order ignores

- **Inline `onclick="openFileBrowser(...)"`** in mosh/transmute/multi/advanced HTML strings. Only works because `window.openFileBrowser = …` (line 6683). Modules must keep that attachment or rewrite all templates to `addEventListener`.
- **`window.removeMultiClip` / `moveMultiClip`** same pattern.
- **`runActiveOperation`** (~7155+) hardcodes every tab’s body collection — extracting `ui/rife.js` without extracting/updating the run switch leaves a monolith choke point. Plan never mentions splitting `runActiveOperation` / collectors.
- **Pool ↔ Quick Transmute ↔ Send-to** — `sendPoolPathTo`, `runQuickTransmute` → `addPathsToPool`. Extracting “quick” before “pool” requires either late binding or pool API module.
- **Mosh** is not “just another tab”: vector pads, melt pad, DAW knobs, timeline slider (~2700–3260) share knob infrastructure and generate heavy DOM. Plan’s order puts mosh late-ish under “mosh” but after “vectors” — there is **no separate vectors tab code island** matching STATUS.md’s “Vectors tab”; mosh owns the pad UI.

#### Verification gaps for Phase 4

“Click tab → form renders → zero errors” misses:

| Failure mode | Needed check |
|--------------|--------------|
| `state` not shared | switch tab, set global input, switch back — path still filled |
| pool persistence race | reload page → sequence/items restore from `/api/pool` |
| project dirty/save | save project → load → compare payload keys |
| job cancel UI | run long op → Stop → button state + no double-run |
| file browser modes | dir-only vs multi-file vs save-as |
| inline handlers | Browse buttons on mosh/multi after module switch |
| preview AR | display result video → aspect box non-zero |
| knob → body | change deepdream knob → POST body reflects value (not just render) |

Pool-last is correct for size; it is **incorrect** to claim verification is the same as small tabs.

---

### Phase 5 — Backend modularization

#### 5.1 datamosh_ops split

**Underestimated shared core; overestimated per-mode files.**

Actual structure:

- `_execute_mosh_pipeline` (~370 lines) + `_trim_and_mosh` + helpers = **most of the file**
- Five registered handlers are thin wrappers (melt/classic via `_trim_and_mosh`; hijack/destruct/mv_hack via pipeline)

So “5 modes → 5 files” is packaging; risk is **`common.py` extract + import side effects**.

Must update `operations/__init__.py` (`from . import datamosh_ops` → package). Plan omits registry import path.

Order melt → classic → … is fine for commits **if** `common` is extracted first. Plan says “order: melt → classic…” without “extract shared pipeline first” — builder who extracts melt alone will duplicate or leave broken imports.

Cancel hooks belong in `common` pipeline when touching this file (tie to expanded Phase 2).

Verification: cannot use dry_run (none exists). Need either add dry_run to datamosh or verify with `/tmp/teste.mp4` real run + `ffgac`/`ffedit` on PATH.

#### 5.2 media_store split — **main complexity finding**

File is 1324 lines. Layer map from real call graph:

```
paths/constants (MEDIA_ROOT, BY_HASH_DIR, POOL_STATE_PATH, LAST_PROJECT_PATH)
    ↑
cache: hash, index, load/save_record, locks, resolve_hash, record_operation, media_cache_stats (partial)
    ↑
thumbnails: extract_frame, ensure_thumbs, phash, get_thumb_file, export_frame_png
    ↑
open_media / _public_payload   ← ORCHESTRATOR (cache + thumbs) — NOT in plan boxes
    ↑
pool state: load/save_pool_state, _normalize_pool_payload
    ↑
projects: save/load_project_file, get_last_project_path  (calls save_pool_state)
    
match_frames: resolve_hash + ensure_thumbs + ensure_phashes + load_pool_state
    ← spans cache + thumbs + pool  (plan shoves into pool.py — OK only if pool imports thumbs)
```

**Is cache → thumbnails → pool → projects the right order?**

| Step | OK? | Caveat |
|------|-----|--------|
| cache first | Yes | Keep path constants + hash/index/records only. **Do not put open_media/get_thumb here.** |
| thumbnails second | Yes | Needs public cache path/record API. `ensure_thumbs` already calls `ensure_phashes` and mutates records. |
| pool third | Yes | Only needs `POOL_STATE_PATH` (+ optionally hash on items). Almost **independent of thumbs** for load/save. |
| projects fourth | Yes | Depends on `_normalize_pool_payload` + `save_pool_state`. |

**Will splitting cache break thumbnails?**

Yes, if done naively:

1. Move `_hash_dir`, `_thumb_path`, locks, records to `cache.py` without re-export → thumbs still in `media_store.py` call missing privates.
2. Put `open_media` in cache → imports thumbs → if thumbs import cache for `load_record`, fine; if you also move phash invalidation into cache “serving”, cycle.
3. Routes import `media_store.get_thumb_file`, `media_store._public_payload` (media.py uses **private** `_public_payload`). Split without a **facade** (`media_store.py` or `media/__init__.py` re-exports) breaks routes and `main.py` `record_operation`.

**Plan missing pieces for 5.2:**

- Facade / stable import path (`from app import media_store` must keep working).
- Home for `open_media`, `export_frame_png`, `match_frames`, `media_cache_stats`.
- `media.py` currently reaches into `_public_payload` — either export publicly or stop.
- Concurrency: `_index_lock`, `_hash_locks`, `_pool_state_lock` must stay single-source (don’t duplicate locks across modules).
- On-disk layout must not change (`~/.cache/mtapi/media/…`, `pool_state.json` sibling) — unstated invariant.

**Verification “pool tab loads, thumbs render, state persists, projects save/load”** is necessary but insufficient:

| API / behavior | Check |
|----------------|-------|
| Hash stability | same file → same hash after split; rename file → same hash (content key) |
| Index mtime short-circuit | second `open_media` is fast / `cached: true` |
| Last-frame version gate | stale `last.extract_v` forces re-extract (`FRAME_EXTRACT_VERSION = 2`) |
| Thumb route | `GET` thumbnail endpoint returns JPEG for first+last |
| Match | `match_frames` next/prev with 2 pool items returns distances |
| Project mirror | `save_project_file` also updates session `pool_state.json` (lines 1188–1189) |
| Missing files | load pool with deleted path → filtered + `missing` list |
| Concurrent | two parallel `open_media` same path don’t corrupt record (lock) |

---

### Phase 6 — Deep cleanup

- **6.1 deepdream_engine:** “only after 1–5” is overly strict. Engine does not import media_store or frontend. Real dependency is “don’t refactor engines while PNG pipeline / job_control still thrash” — Phase 2 cancel + stable `png_pipeline` is enough. Waiting on CSS/JS split is cargo cult.
- **6.2 speedramp scripts:** independent of 6.1; can parallelize. Root `speedramp_png.py` is used by ops — consolidation must not break `speedramp_ops` subprocess/import path. Plan says “archive POC” without naming which entrypoint production uses.

---

### Phase 7 — New features

- **7.1 CivitAI blocked by Phase 5:** plausible if it needs media cache routes; **not** blocked by Phase 6 deepdream. Graph `Phase 7 depends on Phase 6` is too strong; use “Phase 5 media facade stable” for CivitAI only.
- **7.2 Speed ramp E2E blocked by optical-flow:** matches STATUS/ROADMAP; OK.
- **7.3 QA / 7.4 rubberband:** placeholders — fine, but don’t serialize them behind deepdream split.

---

## Dependency graph — corrected

Plan’s graph:

```
1+2 ─┬─→ 3 → 4
     └─→ 5 → 6 → 7
```

**Problems:**

| Claim | Reality |
|-------|---------|
| Phase 4 depends on Phase 3 | **False.** Parallelize; only coordinate `index.html`. |
| Phase 5 depends on Phase 2 | Weak. Only if Phase 2 expands to mosh cancel inside shared pipeline before split. |
| Phase 6 depends on Phase 5 | Partially. media_store split ≠ deepdream. datamosh split ≠ deepdream. |
| Phase 7 depends on Phase 6 | **False** for CivitAI; needs media API stability (5.2), not engine file layout. |
| Phases 1+2 parallel with 3 | True. |

**Proposed graph:**

```
Phase 0 (missing): static.py serves /css/* and /js/* ; decide module strategy

Phase 1 dead code ─────────────────────────────┐
Phase 2 cancel audit (expand: mosh pipeline) ──┤
                                               ├─→ Phase 3 CSS ──┐
                                               │                  ├─→ (optional polish)
                                               ├─→ Phase 4 JS  ──┘   [modules from first extract]
                                               │
                                               └─→ Phase 5a datamosh package
                                                   Phase 5b media package (cache→thumbs→facade→pool→projects)
                                                         │
                         ┌───────────────────────────────┼────────────────────────┐
                         ▼                               ▼                        ▼
                   Phase 6a deepdream              Phase 6b speedramp        Phase 7 CivitAI
                   (any time after job_control     (after speedramp_ops      (after 5b facade)
                    + png_pipeline stable)          entrypoint known)
```

---

## Missing items (will bite if skipped)

1. **Static asset pipeline** — `routes/static.py` multi-file CSS/JS (or `StaticFiles` mount). Blocks Phase 3–4 completely.
2. **ES module day-one strategy** for app.js — entry `main.js`, `import` graph, keep `window.openFileBrowser` bridge.
3. **media package facade** — re-exports so `main.py` / `routes/media.py` / `routes/pool.py` don’t churn every sub-split.
4. **Homes for cross-cutting media APIs** — `open_media`, `match_frames`, `export_frame_png`, `_public_payload`.
5. **`runActiveOperation` / collectors split plan** — otherwise Phase 4 leaves a 400-line switch monolith.
6. **`operations/__init__.py` + package layout** for datamosh.
7. **Datamosh dry_run or real-run verify protocol** — current verify is impossible.
8. **On-disk media layout invariant** + lock single-sourcing.
9. **CSS `base.css` tokens** + interactive visual checklist.
10. **Doc/status hygiene** — `STATUS.md` claims F1/F2/F3/M8 CSS+JS module split **done**; tree still has monoliths. Builders will skip Phase 3–4 if they trust STATUS. Plan should say “STATUS is stale; tree is source of truth” or Phase 0 reconciles STATUS.
11. **`tools/rename_appjs.py` footgun** near Phase 1.
12. **Cancel for long video ops** (datamosh pipeline at minimum).
13. **Import/test smoke** after each backend split: `python -c "from app.operations import …; from app import media_store"`.

---

## Complexity callouts (underestimated items)

| Item | Looks like | Actually |
|------|------------|----------|
| 4.x progressive app.js extract | file cuts | Module system + global bridges + run switch + pool 3.2k |
| 4.2 state.js | data bag | Pool helpers + defaults + init side effects |
| 3.x CSS sections | slice by comments | Shared tokens, mixed @media, specificity wars (timeline vs global range) |
| 5.1 five mosh files | 5 handlers | One fat pipeline + registry package move |
| 5.2 cache first | move hash functions | Must not move serving/orchestrators; facade required; match/open span layers |
| 1.2 melt path | change constant | Wrong file in plan; no dry_run verify; docs/bin policy |

---

## Verification gaps by phase (concise)

| Phase | Plan says | Misses |
|-------|-----------|--------|
| 1 | browser / dry_run | File existence check first; datamosh has no dry_run; prove resolved script path in logs/cmd |
| 2 | Stop between files | Already works for named ops; need multi-image **count** assertion; add mosh/rife |
| 3 | tab renders | Token cascade; pool dock resize; knobs; timeline; modal; no console≠visual OK |
| 4 | tab form + zero errors | state persistence; pool restore; project I/O; run+cancel; onclick bridges; POST body fields |
| 5.1 | dry_run + mode select | dry_run nonexistent; real `/tmp/teste.mp4`; registry lists all 5 ids |
| 5.2 | pool UI smoke | hash cache hit; last-frame version; match API; project mirrors pool_state; parallel open |
| 6 | (none specific) | import paths for speedramp_png; dream still cancels mid-ascent |
| 7 | (none) | out of scope |

---

## Specific recommended changes (priority order)

### P0 — Fix before any builder starts

1. **Insert Phase 0 / expand Phase 3.0+4.0:** change `routes/static.py` (or mount `StaticFiles`) so nested CSS/JS URLs work; document URL map.
2. **Rewrite Phase 4 ordering:** module entry (`type="module"` + `main.js`) **first**, then extract. Delete the implication that classic multi-script progressive split works with current `let state` / `const elements`.
3. **Rewrite 5.2 targets:**
   - `cache.py` = paths, hash, index, records, locks, `resolve_hash`, `record_operation` only  
   - `thumbnails.py` = extract, ensure_thumbs, phash, get_thumb_file, export  
   - `open.py` or package-level `open_media` + `_public_payload`  
   - `pool.py` = session state  
   - `match.py` or pool+match with explicit imports from cache+thumbs  
   - `projects.py` last  
   - Keep `media_store.py` or `media/__init__.py` as **facade** for routes
4. **Fix 1.2/1.3 file target:** `datamosh_ops.py` (or shared constants next to it), not `shell.py`.
5. **Fix datamosh verification:** add dry_run **or** mandate real short clip run; never claim dry_run works today.
6. **Strike or rewrite 1.1** — no `app.js.bak`; don’t delete live `style.css` until Phase 3.7; warn about `rename_appjs.py`.

### P1 — Ordering / graph

7. **Parallelize Phase 3 and Phase 4** (after Phase 0 static serving). Remove hard 3→4 edge.
8. **Don’t block deepdream (6.1) or CivitAI (7.1) on full Phase 3–4.** CivitAI ← media facade (5.2). Deepdream ← job_control + own file only.
9. **Extract datamosh `common` pipeline before per-mode files**; update `operations/__init__.py` in that commit.
10. **Expand Phase 2** to audit datamosh pipeline cancel (or fold cancel into 5.1 common extract); mark image-batch cancel as verify-only if already green.

### P2 — Completeness

11. **Add CSS `base.css` (`:root`)** as first extract; define visual regression checklist (pool dock, knobs, timeline, modal, watcher).
12. **Add Phase 4 items:** `router.js` (`switchTab`/`renderTabForm`), `run.js` (`runActiveOperation` + collectors), explicit `window.*` bridge list for inline handlers.
13. **Pool extract:** sub-split plan (grid / sequence / playback / persistence / match / context menu) — 3.2k lines is not one “item” with tab-click verify.
14. **media_store verify matrix** (hash, thumbs version, match, project mirror, locks) — replace single UI sentence.
15. **Reconcile STATUS.md** with tree (or note in TODO that STATUS is stale) so nobody skips 3–4.
16. **Phase 1:** document twin policy + `custom_glitch.js` stays in bin; update bin README when deleting melt/no_keyframe copies.

### P3 — Nice but real

17. Speedramp consolidate (6.2) can run parallel to deepdream (6.1).
18. Optional easy wins: remove `shell.probe_duration` shim; stop exporting `_public_payload` as private from routes.
19. After each Python package split: `python -c` import smoke + `/health` + one media_info curl — not only browser.

---

## What is fine as written

- Overall direction: clean infrastructure before new feature surface.
- Pool last in JS extract order (by size) — once module strategy is fixed.
- Projects after pool in media_store (real call: `save_project_file` → `save_pool_state`).
- Thumbnails after pure cache **if** serving/orchestrator is not stuffed into cache.
- One commit per item + stop-if-stuck rules.
- Not touching engines until surrounding I/O is stable — principle OK; phase numbering over-serializes it.
- CivitAI as post-cleanup feature — OK if blocked only on media API, not on CSS.

---

## Bottom line

Execute-as-written would fail at:

1. Phase 1 verify (fake dry_run; maybe no-op delete),  
2. Phase 3–4 first extract (404 from `static.py`; or JS `state is not defined` if multi classic scripts),  
3. Phase 5.2 mid-split (import cycles / broken thumbs if “serving” sits in cache without facade).

Fix P0 items in `TODO.md`, then the plan becomes **solid**. Until then: **has gaps**.
