# Universal Persistence Spec

> **Status:** **Implemented** `000.000.5.06` — metadata round-trip, `/api/media_signature`, shared lazy-loader, settings precedence, schema v2 migration, inactive-tab desk snapshot. Named-project isolation shipped earlier (`4.63`).
> **Audience:** Builder Agents (Implementation)  
> **Goal:** Redesign save/load to strictly isolate named projects, perfectly round-trip metadata to prevent eager API hammering, and elegantly lazy-load visual assets via a shared viewport observer.

---

## 1. Problem Statement

**Incident 1 (Named Project Overwrite):** 
Save As overwrote the old named file `A` because autosave leaked into it. Fix: Session autosaves are strictly isolated.

**Incident 2 (The Thundering Herd Freeze & Amnesia):**
1. The frontend (`buildPoolStatePayload`) and backend (`pool.py`, `projects.py`) strip `meta` fields during normalization.
2. Loading explicitly sets `meta: null`, forcing the UI to refetch everything.
3. Thumbnail `<img src="..."/>` elements are eagerly assigned in `grid.js` and `image-pool.js`, causing browser freezing on massive folders.
4. **Fix:** 1:1 Strict Metadata round-trip serialization and a shared Intersection Observer module with a concurrency-limited fallback.

---

## 2. Target Architecture

### A. Session Autosave (Automatic)
* **Path:** `~/.cache/mtapi/pool_state.json`
* **Restored on:** Cold start. Falls back to `last_project_path.txt`.

### B. Named Project (User Explicit)
* **Path:** User-chosen `*.ffproject.json`.
* **Payload:** Full desk snapshot.

---

## 3. Schema & Metadata Integrity

**Strict Metadata Preservation:**
* **Frontend:** `buildPoolStatePayload()` must serialize `meta`, `metaError`, `meta_signature`, `history_count`, and `open_count` for both pools.
* **Backend Normalization:** `pool.py` and `projects.py` MUST strictly validate and prune the payload to prevent unbound data. Unknown fields must be discarded.
  ```json
  {
    "meta": {
      "duration": "float", "fps": "float", "width": "int", "height": "int",
      "video_codec": "str", "audio_codec": "str", "frames": "int", "has_audio": "bool"
    } | null,
    "metaError": "string | null",
    "meta_signature": {"size": "integer", "mtime_ns": "integer"} | null,
    "history_count": "integer | null",
    "open_count": "integer | null"
  }
  ```

**Cache Preservation Invariant:**
* Project/session save, Save As, project load, migration, and autosave must never delete or clear media-cache records, disk thumbnails, pHashes, or the server RAM thumbnail cache (`thumbnails_to_ram`). 
* Pool entries must perfectly preserve their content hashes across all saves. 
* Cache invalidation is permitted ONLY after a changed file signature or an explicit user “Clear Cache” action.
* Thumbnail cache keys MUST include every output-affecting thumbnail setting, including resolution/size and JPEG quality. A thumbnail generated at one quality or size must never be served as another setting's result.

**Freshness & Validation (`/api/media_signature`):**
* `app/routes/media.py` adds `/api/media_signature`. It accepts `path`. If missing, returns 404.
* It returns `{ "size": 123, "mtime_ns": 456 }` via direct OS stat (zero ffmpeg).
* When a pool card intersects, the frontend fetches the signature. If `meta_signature` is null, or differs from the disk signature, `meta` is cleared, `/api/media_info` is queued, and the thumbnail `<img src>` is assigned with `?m=mtime_ns` to bust the browser cache.

**Error Recovery:**
* Failed probes persist via `metaError`. They are NOT retried endlessly unless the `meta_signature` changes on disk, or the user clicks an explicit "Retry Metadata" button on the UI.

---

## 4. UI Rendering & Shared Lazy Loading

**Shared Observer Lifecycle (`lazy-loader.js`):**
* Create a single globally instantiated observer module exporting `.observe(element, callback)` and `.unobserve(element)`.
* It handles multiple grids naturally via browser API.
* **Cleanup:** When cards are removed (or pools cleared), grids MUST call `.unobserve(element)` to avoid stale callbacks. Clearing a pool must also clear the observer's internal pending queue.
* **Observer Logic:** When a card enters the `100px 0px` prefetch margin:
  1. Validate signature.
  2. If valid, skip `loadPoolItemMeta`. If stale/null, queue it.
  3. Assign the thumbnail `<img src>`.

**Bounded Concurrency Fallback:**
* If `IntersectionObserver` is undefined on the browser, the helper MUST NOT eager-load infinitely. It must execute the callbacks through a bounded Promise queue (max 5 concurrent operations) to prevent freezing.

**Image Pool Explicit Rules:**
* `applyPoolData()` MUST restore `state.imagePool.items` metadata perfectly.
* `image-pool.js` MUST register cards to the shared observer and skip `loadImageItemMeta()` if valid metadata exists.

---

## 5. Coverage Matrix & V2 Migration

**State Coverage Matrix:**
| State Key | Session | Project | Load Restore | Notes |
|-----------|---------|---------|--------------|-------|
| `window.globalInputs.*` | ✅ | ✅ | ✅ | Re-probe `totalFrames` on load |
| `state.pool.items` | ✅ | ✅ | ✅ | Includes strict metadata round-trip |
| `state.imagePool.items`| ✅ | ✅ | ✅ | Includes strict metadata round-trip |
| `state.pool.sequence` | ✅ | ✅ | ✅ | Includes sequence durations & modes |
| `state.pool.layout` | ✅ | ✅ | ✅ | Panel sizes, zoom, flags |
| `state.activeTab` | ✅ | ✅ | ✅ | |
| `state.facemorph.*` | ✅ | ✅ | ✅ | Must bind continuously oninput/onchange |
| `state.cut.*` | ✅ | ✅ | ✅ | Must bind continuously oninput/onchange |
| `state.zoompan.*` | ✅ | ✅ | ✅ | Must bind continuously oninput/onchange |
| `state.imagesort.*` | ✅ | ✅ | ✅ | Must bind continuously oninput/onchange |
| `state.styletransfer.*` | ✅ | ✅ | ✅ | Must bind continuously oninput/onchange |
| `state.quick.*` | ✅ | ✅ | ✅ | Must bind continuously oninput/onchange |
| `state.watcher.*` | ✅ | ✅ | ✅ | Must bind continuously oninput/onchange |
| `state.notes.*` | ✅ | ✅ | ✅ | Notes survive restart and project round-trip |
| `state.settings` | ✅ | ❌ | ❌ | Projects MUST NOT overwrite global settings |

**Settings Precedence:**
* Precedence (startup): 1. Fetch `/api/settings` once. 2. Partial-merge with `localStorage` (local wins). 3. Fill missing keys with defaults.
* Restore Rule: Session loads MAY restore settings. Named Project loads MUST drop `data.desk.settings` entirely.
* Fallback Event: If `window.scheduleSavePoolState` is unavailable, `saveSettings()` dispatches a CustomEvent (`mtapi.saveSettings`) that `persistence.js` listens for to trigger a full snapshot.

**Settings Tab — Thumbnail Controls & Technical Tooltips:**
* Complete the existing placeholder Settings tab with these global preferences:
  - `thumbnailSize`: L/M/H resolution control. The UI must explain that resolution generally affects loading speed, browser decode cost, and memory more than JPEG quality does.
  - `thumbnailQuality`: JPEG quality control, using either a clearly labeled numeric range or Low/Medium/High mapping. Lower quality reduces bytes, while higher quality improves detail at the cost of storage, transfer/read time, and decode work.
  - `thumbnailsToRam`: Boolean toggle for the server-side RAM thumbnail cache.
  - `showTooltips`: Boolean toggle, default enabled, controlling technical hover/help messages.
* `thumbnailQuality` must be passed through thumbnail generation and included in the thumbnail cache key. Changing size or quality must refresh existing pool thumbnails or cause a full grid rerender.
* Technical hover messages must use one shared, disable-able tooltip mechanism for new and converted existing help text. When `showTooltips` is false, those messages must be suppressed without disabling the associated controls.
* Tooltips should describe the practical performance tradeoffs: request count/concurrency, resolution, JPEG quality, RAM use, browser decode cost, and cache reuse.

**Global UI Session Continuity:**
* Switching tabs MUST NOT clear or reset the previously configured tab. The Datamosh → DeepDream example is illustrative only: this rule applies to every operation and workspace tab.
* Session continuity includes, where applicable:
  - text and numeric inputs the user typed;
  - select values, toggles, checkboxes, radio buttons, and knobs;
  - selected or loaded file paths, image lists, folders, and references;
  - operation-specific options and preview/display choices.
* Every tab's persistent controls MUST have a canonical entry in `state`, updated on `input`/`change` or equivalent control events. Tab renderers must initialize from that state instead of replacing it with hard-coded defaults.
* Switching tabs is an in-session UI action, not a reset. Unmounting a tab's DOM must not destroy its state.
* Session autosave must capture this state in the full desk snapshot. Explicit named-project Save/Save As must capture it as project state, while global browser preferences such as thumbnail caching and tooltip visibility follow the settings precedence rules above.
* Notes are persistent workspace state, not an exception. `state.notes` (including both note areas and any future note fields) must be included in the session snapshot so notes survive browser restart, and in named projects when the desk is saved.
* Only explicitly designated transient values may be discarded: active job progress/tokens, loading flags, hover state, file-browser cursor state, and other values listed as transient in this specification.

**Future Per-Tab Reset Defaults:**
* The architecture must leave room for a future `Reset Defaults` action on every tab. A reset must restore only that tab's documented sane defaults, must not clear pools, notes, other tabs, or global settings, and must mark the desk dirty so the reset can be autosaved.
* Tab defaults should be defined as reusable state factories or reset functions rather than scattered only through renderer HTML literals. This future feature is not required for the current persistence implementation unless separately requested.

**Schema V2 Migration:**
* Missing/Malformed Version: Assume `project_version: 1`.
* Migration Steps: Map `target_duration` to `targetDuration`. Drop unknown top-level fields. Hydrate missing extended tab keys (`state.facemorph`, etc.) with safe defaults.
* Persistence: The migrated data is loaded into memory and rewritten to disk as V2 on the very next autosave tick.

---

## 6. Files to Touch (Builder List)

* `mtapi-project/app/static/js/pool/persistence.js` & `app.js`: Schema migrations, settings precedence execution, metadata serialization, global event listener.
* `mtapi-project/app/static/js/lazy-loader.js` (NEW): Centralized IntersectionObserver module with bounded concurrency fallback and lifecycle cleanup.
* `mtapi-project/app/static/js/pool/grid.js` & `image-pool.js`: Register/unregister cards to shared observer; skip fetching if metadata valid.
* `mtapi-project/app/static/js/tabs/settings.js`: Dispatch CustomEvent on save.
* `mtapi-project/app/media/pool.py` & `projects.py`: Strict schema normalization (pruning unknown fields).
* `mtapi-project/app/routes/media.py` (or `browse.py`): Implement `/api/media_signature`.

---

## 7. Verification / Regression Tests

1. **Metadata Fast-Path:** Reloading a saved project skips `/api/media_info` completely for valid items.
2. **Stale Signature:** Modifying a file on disk (via `touch`) forces the UI to hit `/api/media_signature`, clear the `meta`, hit `/api/media_info`, and cache-bust the thumbnail URL with `?m=`.
3. **Dual Pools:** Both Video and Image pools successfully lazy-load via the single shared observer.
4. **Observer Cleanup:** Toggling between views or clearing a pool logs zero duplicate or stale metadata requests.
5. **Settings Protection:** Loading an old `.ffproject.json` does NOT alter global browser preferences.
6. **V1 Migration:** Opening a legacy project successfully maps `target_duration` to `targetDuration` and hydrates extended tabs without crashing.
7. **Bounded Fallback:** Disabling `IntersectionObserver` in browser DevTools proves the fallback queue handles 800 items without freezing via max-concurrency limits.

**Cache Preservation Tests:**
8. Populate disk and RAM thumbnail caches (`thumbnails_to_ram`).
9. Save As to a new project.
10. Confirm the original cache files and records still exist untouched.
11. Confirm pool item hashes remain perfectly stable in the new project payload.
12. Confirm unchanged thumbnails are not regenerated or re-decoded.
13. Confirm server RAM cache remains populated and intact during the Save As operation.
14. Change thumbnail resolution and JPEG quality, then confirm the requested thumbnail URLs/cache keys differ and existing pool cards refresh.
15. Toggle `showTooltips` off and confirm technical hover messages are suppressed; toggle it on and confirm they return.
16. Confirm `thumbnailSize`, `thumbnailQuality`, `thumbnailsToRam`, and `showTooltips` survive the settings persistence flow without named project loads overwriting global preferences.
17. Configure a Datamosh tab with typed paths, toggles, selects, knobs, and loaded references; switch to DeepDream; then return to Datamosh and confirm every non-transient value is unchanged.
18. Repeat the tab-switch continuity test across representative tabs with inactive-tab DOM unmounting, then refresh and confirm the session snapshot restores the same values.
19. Enter text in both Notes areas, close/restart the browser, and confirm the notes return from session persistence; save and reopen a named project and confirm its notes round-trip.
