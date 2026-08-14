# Universal Persistence Spec

> **Status:** **Partial** — core “named project sacred” (pool/session isolation) shipped `000.000.4.63`.  
> **Remaining Open (Not Implemented):** Full desk snapshot, inactive-tab capture, schema v2 migration, server-side force overwrite checks, and RIFE variant round-trip.
> **Audience:** Builder Agents (Implementation)  
> **Related handoff:** `docs/SESSION-STOPPING-STATE.md`, `docs/coder-agy-universal-persistence-prompt.md`  
> **Goal:** Redesign save / load / autosave so that user project files are isolated from session autosaves, preventing the bug where named projects are overwritten unintentionally.

---

## 1. Problem Statement

**Incident 1 (Named Project Overwrite):** 
1. User builds a Sequence and Saves a named project (`A.ffproject.json`).
2. User clears the sequence to start a new one.
3. User uses Save As to a new name (`B.ffproject.json`).
4. **Bug:** The old named file `A` was still written to or emptied, leaving the user with an empty sequence.

**Incident 2 (The Thundering Herd Freeze):**
1. User imports a massive folder or accumulates 800+ clips in the Video Pool.
2. User refreshes the page.
3. **Bug:** The frontend loops over all 800+ items and fires `loadPoolItemMeta()` concurrently. This creates an un-paginated thundering herd of 800+ HTTP requests to `/api/media_info`, which freezes the DOM and crashes the browser tab.

**The Fix (Implemented):** 
We explicitly isolated session autosave from explicit project saves. Autosaves NEVER overwrite the named project path `A` unless the user explicitly chose Save/Save As for that path in the current UI session.

---

## 2. Target Architecture

The persistence model is split into three layers:

### A. Session Autosave (Automatic)
* **Path:** `~/.cache/mtapi/pool_state.json`
* **Written on:** Debounced UI changes, window unload, interval.
* **Restored on:** Cold start. (If `pool_state.json` is missing or invalid, it automatically falls back to `last_project_path.txt`).
* **Rule:** Never overwrites the last named project.

### B. Named Project (User Explicit)
* **Path:** User-chosen `*.ffproject.json`.
* **Written on:** Explicit Save or Save As actions only.
* **Payload:** Full desk snapshot.
* **Rule:** After Save As to `B`, the active `project.path` becomes `B`. The session autosave stays on the session file. Project `A` is frozen and no longer written to.

### C. Media Cache (Unchanged)
* **Path:** `~/.cache/mtapi/media/by_hash/...`
* **Role:** Stores thumbs, phash, strips, etc.
* **Rule:** Project JSON stores paths/hashes, not binary media.

---

## 3. Schema (Full Desk JSON)

Both the session and project files should represent a complete snapshot of the workspace.

**Must-save Categories:**
1. **Libraries:** Video Pool (`items[]`), Image Pool (`images[]`), selected paths.
2. **Sequence:** Ordered `sequence[]` with per-clip durations/ids.
3. **Global inputs:** `video` (paths), `image` (paths), `pathIn`, `pathOut`, `frameStart`, `frameEnd`.
4. **Active Tab:** `activeTab`.
5. **Layout:** Pool/sequence panel sizes, collapsed sections, tile zoom, `tileInfo` flags.
6. **Form State (All Ops):** 
   - `facemorph` (images, folder)
   - `withoutbg` (images, folder)
   - `styletransfer` (contents, stylePath)
   - `quick` transmute (reconcile, aspect, custom)
   - `watcher` (enabled, in_dir, out_dir, target_width, target_height, resize_mode)
   - New tabs: `imagesort` (sort mode, multiplier, images list, base image), `speedchange` (settings), etc.
7. **Cut Tab:** `refA`, `refB`, `mode`, `overlayOpacity`, `abPosition`.
8. **Pan & Zoom:** Boxes, aspect, duration, compare state.
9. **Project Meta:** `name`, `created_at`, `updated_at`, `project_version` (bump to 2).

**Explicit Non-Goals / Transient (Do Not Save):**
* `health`, `operations` registry (fetched on load).
* Live job tokens / progress / sticky timers.
* Modal file-browser cursor (`state.fb`).
* `_lastProbedPath`, `_probeOk`.
* `loading` and `matchLoading` states.
* Hover states (`hoverPath`).
* Transient references like `_cutPendingRef`.

---

## 4. Coverage Matrix (`ui-state-map` checklist)

| State Key | Session | Project | Load Restore | Notes |
|-----------|---------|---------|--------------|-------|
| `window.globalInputs.*` | ✅ | ✅ | ✅ | Re-probe `totalFrames` on load |
| `state.activeTab` | ✅ | ✅ | ✅ | |
| `state.project.*` | ✅ | ✅ | ✅ | |
| `state.pool.items` | ✅ | ✅ | ✅ | |
| `state.pool.sequence` | ✅ | ✅ | ✅ | |
| `state.pool.layout` | ✅ | ✅ | ✅ | |
| `state.imagePool.items` | ✅ | ✅ | ✅ | |
| `state.facemorph.*` | ✅ | ✅ | ✅ | Capture inactive tab state |
| `state.withoutbg.*` | ✅ | ✅ | ✅ | Capture inactive tab state |
| `state.styletransfer.*` | ✅ | ✅ | ✅ | Capture inactive tab state |
| `state.quick.*` | ✅ | ✅ | ✅ | Capture inactive tab state |
| `state.cut.*` | ✅ | ✅ | ✅ | Capture inactive tab state |
| `state.zoompan.*` | ✅ | ✅ | ✅ | Capture inactive tab state |
| `state.watcher.enabled` | ✅ | ✅ | ✅ | Must sync with backend watcher |
| `state.fb` | ❌ | ❌ | ❌ | Transient |
| `state.health` | ❌ | ❌ | ❌ | Transient |
| `state.pool.loading` | ❌ | ❌ | ❌ | Transient |

---

## 5. Write Policies

**Save (named)**
```text
on Project Save:
  if path is null → invoke Save As picker
  snapshot = buildFullDeskSnapshot()
  if snapshot.sequence is empty AND disk file has content:
    confirm("Overwrite non-empty project with empty sequence?")
  write ONLY snapshot to path
  set project.path = path, dirty=false
  do NOT rewrite session autosave here.
```

**Save As**
```text
on Save As:
  pick new path B
  snapshot = buildFullDeskSnapshot()
  write ONLY to B
  project.path = B
  dirty = false
```

**Autosave (session)**
```text
on debounced change:
  write buildFullDeskSnapshot() → SESSION_AUTOSAVE_PATH only
  never write to project.path here
```

**Open Project**
```text
load A → applyFullDeskSnapshot
project.path = A, dirty = false
```

**New Project**
```text
if dirty, confirm loss of unsaved changes
clear desk
project.path = null
autosave continues to session file only
```

---

## 6. Empty / Overwrite Safeguards
* Clearing a sequence sets `dirty=true` and autosaves to the **session file**. It must NOT auto-flush to the named project.
* When executing a manual "Save", if the current sequence is empty but the project on disk has a non-empty sequence, the UI MUST prompt the user for confirmation before overwriting.

---

## 7. Versioning & Migration
* Increment the project JSON schema version to 2 (e.g. `project_version: 2`).
* When loading older projects that lack the extended tab state keys, initialize them using defaults from `ui-state-map`.

---

## 8. Inactive-Tab State Capture
* All form values must be bound to the global `state` object.
* When serializing `buildFullDeskSnapshot()`, read values directly from the `state` object rather than querying the DOM, as inactive tabs may have unmounted their DOM nodes.

---

## 9. API Changes
* `/api/project/save` should take an optional `force` boolean to bypass backend checks for empty overwrites.
* Ensure all paths provided to the backend are absolute.

---

## 10. Files to Touch (Builder List)
* `mtapi-project/app/static/js/pool/persistence.js` (Major refactor of `savePoolStateNow`, `projectSave`, `projectOpen`)
* `mtapi-project/app/static/app.js` (Expand `state` initialization and serialization logic)
* `mtapi-project/app/static/js/tabs/*.js` (Ensure all tabs sync form changes to `state` on edit, not just on submit)
* `mtapi-project/app/media/pool.py` or equivalent backend state handler (to respect separation of project vs session).

---

## 11. Conflicts with Existing Docs
* **Conflict:** `video-image-pools-spec.md` mentions a "quiet dual-save project with session".
* **Resolution:** This is the root cause of the incident and MUST be removed. The session and project are now strictly isolated.

---

## 12. Verification / Regression Tests
1. **Preserve RIFE metadata on load (Implemented):** `app/media/projects.py`'s `load_project_file` was updated to map `variant_path` and `rife_multiplier` for sequence items. Prior to this, `Save As` -> `Load` would clear all sequence clips back to their un-RIFE'd base file.
2. Autosave after clearing a sequence does not empty `A`.
3. Save As `B` then edit → autosave never touches `A`.
4. Open `A` after restart restores sequence + pools + last tab + sample knobs (e.g., RIFE multiplier).
5. Empty overwrite of a non-empty project requires explicit confirmation.
6. Cut refs / Image Sort list / Face Morph list round-trip successfully.
7. Image Pool + Video Pool both survive a page refresh (F5).
