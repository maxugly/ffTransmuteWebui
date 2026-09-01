# Prompt for Agy (Spec Writer) — Universal UI Persistence

> **You are Spec Writer (agy).** Research + write a **spec only**.  
> **Do not** implement code. **Do not** claim DONE as a builder.  
> Deliverable: `docs/universal-persistence-spec.md` (name exact).  
> Optional: short conflict notes vs existing docs in the same file under **Conflicts**.

---

## 0. Why this exists (user incident — must fix in design)

Real failure mode today:

1. User built a **Sequence**, **Save**d a named project (e.g. `A.ffproject.json`).
2. User **cleared / deleted** sequence clips to start a **different** sequence.
3. User **Save As** under a **new** name (e.g. `B.ffproject.json`).
4. Somehow the **old named file `A` was still written / emptied** (autosave or dual-save path), and the sequence ended up **empty** in a place the user thought was protected.

**Non-negotiable product rules for the spec:**

| Rule | Meaning |
|------|---------|
| **Named project is sacred** | Autosave MUST NOT write to `state.project.path` unless the user explicitly chose Save / Save As for that path. |
| **Autosave is a side channel** | Session / crash recovery lives in a **separate** file (or set of files), never “quiet dual-save” into the open project without explicit policy. |
| **Save As creates a new identity** | After Save As → `B`, no background writer may still target `A`. |
| **Empty should not clobber good data** | Never overwrite a non-empty on-disk project with an empty pool/sequence unless the user confirms a deliberate “save empty project.” |
| **Everything user-visible should round-trip** | Knobs, tabs, paths, lists, notes, globals, ranges — if the user can set it, it belongs in the persistence model (or is explicitly listed as **transient** with reason). |

---

## 1. Your mission

Write **`docs/universal-persistence-spec.md`** that redesigns save / load / autosave so that:

1. **User project files** (`*.ffproject.json`) are complete snapshots of “the whole desk.”
2. **Session autosave** is automatic, frequent, and **isolated** from named projects.
3. **Open project pointer** is clear: dirty flag, last-saved path, last-autosave time.
4. The incident in §0 is **impossible** under the new rules (include a regression checklist).
5. Coverage is **universal** — not “pool only.” Use the inventories below as the seed checklist and **extend** them after reading live code.

---

## 2. Read first (code + existing docs)

### Authoritative inventories (already written — do not ignore)

| Doc | Use as |
|-----|--------|
| `docs/persistence-inventory.md` | What is *already* persisted (session, project, watcher, notes, …). |
| `docs/ui-state-map.md` | UI variables / controls per tab (many **not** persisted today). |
| `docs/media-persistence-spec.md` | Content-addressed **media cache** (hash dirs) — **orthogonal** to project JSON; do not conflate. |
| `docs/video-image-pools-spec.md` | Dual pools + sequence dual-save behavior (current as-built; likely **wrong** for named-project safety). |

### Code to reverse-engineer (persistence bugs live here)

| Area | Paths (start here) |
|------|-------------------|
| Frontend save/load | `mtapi-project/app/static/js/pool/persistence.js` — `savePoolStateNow`, project Save / Save As / Open / New, dirty flag, dual-write |
| Backend session | `mtapi-project/app/media/` pool state load/save, `~/.cache/mtapi/pool_state.json` |
| Backend project | `/api/project/save`, `/api/project/load`, `/api/project/last` |
| Notes | notes tab + any notes file under cache/data |
| Watcher | `mtapi-project/data/watcher.json` |
| App state | `mtapi-project/app/static/app.js` — `state`, `window.globalInputs` |
| Tab state | `mtapi-project/app/static/js/tabs/*.js` (especially new **Speed**, **Image Sort**, RIFE, DeepDream knobs) |
| Cut / compare | cut tab + `image-compare` state |

Document **exactly** how autosave currently can write a project file (function names + when). That is the bug report core.

---

## 3. Design the three-layer model

Spec must define **three** layers (names can vary; semantics cannot):

### A. Session autosave (automatic)

- Path example: `~/.cache/mtapi/session_autosave.json` (or keep `pool_state.json` but **rename role** in the spec).
- Written on: debounced UI changes, before unload if possible, interval.
- Restored on: cold start **when no project is forced open**, or “Restore session” explicit action.
- **Never** equals “overwrite last named project.”

### B. Named project (user Save / Save As)

- Path: user-chosen `*.ffproject.json`.
- Written **only** on explicit Save / Save As (and optional “Save copy”).
- Payload = **full desk snapshot** (schema §4).
- After Save As to `B`: `state.project.path = B` only; autosave stays on session file; **A is frozen** until user opens it again.

### C. Media cache (unchanged role)

- `~/.cache/mtapi/media/by_hash/...` — thumbs, phash, strips.
- Not a substitute for project JSON.
- Project JSON stores **paths** (+ optional hashes), not binary media.

Optional fourth: **last-opened project pointer** (`last_project.json` or key in session) — open policy must be specified (prefer last project vs prefer session; dual-save disaster often comes from “always write both”).

---

## 4. Full desk schema (coverage mandate)

### 4.1 Must-save categories

For **both** session and project (unless marked session-only), define fields for:

1. **Libraries** — Video Pool `items[]`, Image Pool `images[]`, selection paths.
2. **Sequence** — ordered `sequence[]` with per-clip durations / ids.
3. **Global inputs** — video paths, image paths, pathIn, pathOut, frameStart/frameEnd (and whether totalFrames is recomputed on load).
4. **Active tab** + any “last tab.”
5. **Layout** — pool/sequence panel sizes, collapsed sections, tile zoom, tile_info flags.
6. **Every op tab’s form state** — not just path strings:
   - All knobs / selects / checkboxes (RIFE mult, DeepDream model, Speed ×, target FPS, use_rife, mosh mode, convert target, etc.).
   - Multi-image lists (`faceMorph.images`, `withoutbg.images`, `styleTransfer.contents`, `imageSort.images` + selected index, etc.).
   - Text boxes / notes fields.
7. **Cut** — refA/refB, compare mode, overlay/ab (today often missing from project).
8. **Zoompan / compare** — boxes, aspect, duration, compare state.
9. **Quick Transmute** settings.
10. **Watcher** — either embedded or “pointer to watcher.json” with explicit merge rules (avoid double sources of truth).
11. **Project meta** — name, created_at, updated_at, schema version.

### 4.2 Explicit non-goals / transient (must list)

Examples that may stay transient (justify each):

- Live job token / progress / sticky timer.
- Modal file-browser cursor.
- Health warnings, OpenAPI registry cache.
- In-RAM Image() decode caches, crop URL caches.

If you leave a UI control out of the schema, it is a **bug** unless listed under transient with a reason.

### 4.3 Use `ui-state-map.md` as a checklist

Spec section **“Coverage matrix”**: table rows = every state key in `ui-state-map.md` (+ any new tabs: `speedchange`, `imagesort`, …).

| state key | session | project | load restore | notes |
|-----------|---------|---------|--------------|-------|

Mark ✅ / ❌ / N/A. Goal: **zero accidental ❌** for user-editable knobs.

---

## 5. Write / load policies (this kills the incident)

Specify precise algorithms:

### Save (named)

```
on Project Save:
  if path is null → Save As picker
  snapshot = buildFullDeskSnapshot()
  if snapshot.libraries_and_sequence_empty AND disk_file_has_content:
    confirm("Overwrite non-empty project with empty desk?")
  write ONLY snapshot to path
  set project.path, dirty=false
  do NOT also rewrite session unless we choose to (document choice)
```

### Save As

```
on Save As:
  pick new path B
  snapshot = buildFullDeskSnapshot()
  write ONLY to B
  project.path = B   # A never receives this write
  dirty=false
```

### Autosave (session)

```
on debounced change:
  write buildFullDeskSnapshot() → SESSION_AUTOSAVE_PATH only
  never write project.path here
```

### Open project

```
load A → applyFullDeskSnapshot
project.path = A, dirty=false
optional: write session copy as “mirror of open project” OR leave session alone
(document which — prefer not dual-writing A on every keystroke)
```

### New project

```
confirm if dirty
clear desk OR load blank template
project.path = null
autosave continues to session file only
```

### Empty-sequence edge cases

- Clearing sequence is a valid edit → dirty=true → autosave session OK.
- That edit must **not** auto-flush into last named project.
- If user later Save As B with empty sequence, B can be empty; A remains previous content.

### Race / order

- Debounce timers cancelled or path-locked when Save As changes target.
- In-flight autosave must not complete to an old project path (generation token / path at schedule time).

---

## 6. Versioning & migration

- Bump `project_version` (or schema version) for the expanded payload.
- Load path: old projects without new keys get **defaults** from `ui-state-map` / inventory.
- Session file version independent or shared — pick one and document.

---

## 7. Backend contract

Specify:

- Exact endpoints and payloads for session vs project.
- Whether `/api/project/save` should **reject** empty overwrite without `force: true`.
- Whether session save is client-only debounce or server-side too.
- Absolute paths only (project invariant).

---

## 8. Frontend architecture (guidance for builders later)

Recommend (do not implement):

- Single `buildDeskSnapshot()` / `applyDeskSnapshot()` used by Save, Save As, autosave, Open.
- One module owns “what is desk state” — tabs register slices or a central map from `ui-state-map`.
- Collect form values from **state objects**, not only from live DOM (DOM may not be mounted for inactive tabs — **critical**: inactive tab knobs must still serialize from `state.*` or last-known values).
- Document how inactive-tab state is kept when switching tabs (today many tabs destroy DOM on switch — state must live in `state` or be re-read on leave).

---

## 9. Verification (for the future builder — include in spec)

Minimum acceptance tests:

1. **Incident regression:** Save A with sequence of N clips → clear sequence → Save As B → open A → sequence still N clips; A file on disk unchanged during autosave after clear.
2. Autosave after clear does not empty A.
3. Save As B then edit → autosave never touches A.
4. Open A after restart restores sequence + pools + last tab + sample knobs (RIFE mult, Speed ×, notes text).
5. Empty overwrite of non-empty project requires confirm.
6. Image Pool + Video Pool both survive F5 (existing dual-pool bug must not return).
7. Global frame range survives project open.
8. Cut refs / Image Sort list / Face Morph list round-trip.

---

## 10. Spec document shape (required sections)

```markdown
# Universal Persistence Spec

## Status / audience / related docs
## Problem statement (include incident §0)
## Goals / non-goals
## Current as-built (with file:function citations)
## Target architecture (session vs project vs media cache)
## Schema (full desk JSON)
## Coverage matrix (ui-state-map checklist)
## Write policies (Save, Save As, Autosave, Open, New)
## Empty / overwrite safeguards
## Inactive-tab state capture
## Versioning & migration
## API changes
## Files to touch (builder list)
## Verification / regression tests
## Conflicts with existing docs
## Open questions for Human (max)
```

---

## 11. Conflicts to resolve in the spec

Call out explicitly:

- `video-image-pools-spec.md` “quiet dual-save project with session” — likely **root cause** of overwriting named projects; redesign must replace this.
- `media-persistence-spec.md` dual libraries mention vs full desk scope.
- Any “project preferred over session on F5” without images[] dual-save (known Image Pool F5 death).

Propose the single correct load priority on cold start.

---

## 12. Open questions (only if blocked)

Ask Human (max) only when product choice is required, e.g.:

- Cold start: restore **last project** vs **session autosave** vs ask?
- Should session mirror the open project continuously, or only when no project is open?

Default recommendation if max is AFK:  
**Cold start → last named project if path exists; else session autosave. Autosave never writes named project path.**

---

## 13. Out of scope for this spec

- Implementing the builder work.
- Redesigning media `by_hash` layout (already specified).
- New ops unrelated to persistence.

---

## 14. Done criteria for you (agy)

You are done when:

1. `docs/universal-persistence-spec.md` exists and is builder-ready.
2. Incident §0 has a clear “why it happened” + “why new rules prevent it.”
3. Coverage matrix is complete against `ui-state-map.md` + new tabs.
4. Autosave path and named project path are **never** the same file under any automatic path.
5. Builder file list and verification steps are explicit.

**Do not implement.** Hand off the spec only.
