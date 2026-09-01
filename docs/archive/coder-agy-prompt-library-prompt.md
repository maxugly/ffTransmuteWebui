# Prompt for Agy (Spec Writer) — Prompt Library (Save / Load Positive + Negative)

> **You are Spec Writer (agy).** Research + write a **spec only**.  
> **Do not** implement application code. **Do not** claim DONE as a builder.  
> **Deliverable:** `docs/prompt-library-spec.md` (exact path).  
> Optional: short **Conflicts** section vs existing docs; one-line STATUS note under “Spec only” if STATUS is missing the feature.  
> **Related product surface:** img2img, txt2img, RIFE Recohere (and any future tab with positive/negative prompts).

---

## 0. Why this exists

Users type long **positive** and **negative** prompts for OpenVINO / SD-style tools. Today those fields are ephemeral:

- Lost on tab switch (DOM destroyed) and often not in project JSON.  
- No named library of favorites / experiments.  
- Recopying negatives (ghosting, lowres, …) and recoherence / style phrases is tedious.  
- Agent “prompt from image” writes into a single field with no “save this pair” affordance.

**Goal:** a small **Prompt Library** so the user can **save** and **load** both **positive** and **negative** prompts (as a pair, and optionally individually).

---

## 1. Your mission

Write **`docs/prompt-library-spec.md`** that defines:

1. **Data model** — what a saved entry is (name, positive, negative, metadata).  
2. **Storage** — where library lives (session vs project vs dedicated file); how it survives F5 and project Open.  
3. **UX** — save / load / rename / delete / overwrite; which tabs get controls.  
4. **API** (if any) vs pure frontend persistence.  
5. **Integration points** — exact DOM ids / tabs today; shared component pattern.  
6. **Non-goals** for v1 and a **verification** checklist for a later builder.  
7. **Files to touch** for the builder (frontend-first; backend only if justified).

The spec must be **buildable** without re-asking the human for basic product shape. Where product choices are ambiguous, **pick a recommended default**, list alternatives briefly, and mark **Locked (recommended)** vs **Open**.

---

## 2. Read first (code + docs)

| Path | Why |
|------|-----|
| `docs/STATUS.md` | Where we are; do not re-spec shipped ops |
| `docs/persistence-inventory.md` | What already persists |
| `docs/ui-state-map.md` | Tab controls; note what is *not* persisted |
| `docs/universal-persistence-spec.md` | Desk save redesign — **do not conflict**; library may be orthogonal or nested |
| `docs/media-persistence-spec.md` | Content cache — not for prompt text |
| `mtapi-project/app/static/js/tabs/img2img.js` | `i2iPrompt`, `i2iNeg`, “Prompt from image” |
| `mtapi-project/app/static/js/tabs/txt2img.js` | `t2iPrompt`, `t2iNeg` |
| `mtapi-project/app/static/js/tabs/riferecohere.js` | `rrPrompt`, `rrNeg` + universal defaults |
| `mtapi-project/app/static/js/tabs/agent.js` | Cross-tab handoff of prompts to i2i/t2i |
| `mtapi-project/app/static/js/tabs/notes.js` | **Pattern:** localStorage JSON blob |
| `mtapi-project/app/static/js/tabs/quick.js` | **Pattern:** localStorage prefs |
| `mtapi-project/app/static/js/pool/persistence.js` | Project / session save — if library should ride along |
| `docs/tool-bottom-docs-spec.md` | Optional About blurb style |

**Invariants (from AGENTS.md):** vanilla JS only; no npm/React; absolute paths for media (prompts are text — fine in JSON); do not break dual-pool project dual-save.

---

## 3. Product requirements (must cover in the spec)

### 3.1 Entry shape (minimum)

Each library entry MUST support at least:

| Field | Required | Notes |
|-------|----------|--------|
| `id` | yes | Stable unique id (uuid or timestamp+slug) |
| `name` | yes | User-facing label (unique-or-allow-dupes — decide) |
| `positive` | yes | May be empty string only if policy allows; recommend min 1 char for save |
| `negative` | yes | May be empty (user has no negative) |
| `created_at` / `updated_at` | yes | ISO strings |
| `tags` or `folder` | optional v1 | Nice-to-have; can defer |
| `source_tab` | optional | e.g. `img2img` \| `txt2img` \| `riferecohere` \| `agent` — for filter, not lock-in |

**Critical:** Save/load is for **both** positive and negative as a **pair** by default.  
Also specify whether v1 allows:

- Save **positive only** / **negative only** (recommended: yes, with clear UI — empty side stays empty on load unless “merge” mode).  
- **Load mode:** replace both fields vs merge append (recommend **replace both** as default; optional “append positive” is v1.1).

### 3.2 Storage (decide and justify)

Recommend one primary design (agy should pick after reading code):

| Option | Pros | Cons |
|--------|------|------|
| **A. Dedicated JSON** under `~/.cache/mtapi/prompt_library.json` (API get/put) | Survives browser wipe if backed by server; multi-machine later | Needs small API |
| **B. `localStorage` only** (like Notes) | Fast, no backend | Per-browser; can be cleared |
| **C. Inside project file** only | Travels with project | Not a global “my negatives” library |
| **D. Hybrid** | Global library (A/B) + optional “embed used prompts in project” | Slightly more complex |

**Recommended default for the spec to argue for or against:**  
**Hybrid lite** — global library in **localStorage** (v1, Notes pattern) *or* server cache file if you find a clean `/api/…` pattern; **do not** block v1 on full universal-persistence redesign. Document how universal persistence later **may** include a snapshot of library ids used, without requiring it for v1.

Explicitly: library must **not** write into named `*.ffproject.json` via autosave bugs (reference universal-persistence rules).

### 3.3 UX (minimum)

Shared UI pattern (spec it as a **reusable control**, not three one-offs):

For every tab with positive + negative fields in scope:

1. **Save…** — opens name prompt (or inline name field); stores current positive + negative.  
2. **Load…** — picker (select / datalist / small modal list) → fills both fields.  
3. **Manage** (can be same modal): rename, delete, overwrite confirmation if name exists.  
4. Show **active entry name** if current fields still match a saved entry (optional polish).

**v1 tabs in scope (locked recommended):**

| Tab | Positive id | Negative id |
|-----|-------------|-------------|
| Img2img | `i2iPrompt` | `i2iNeg` |
| Txt2img | `t2iPrompt` | `t2iNeg` |
| RIFE Recohere | `rrPrompt` | `rrNeg` |

**Optional v1 / v1.1:** Agent tab (chat is not the same as SD pair — only if there is a clear “last SD prompt” pair).  
**Out of scope v1:** DeepDream / style / non-SD free-text unless the same pair model fits cleanly.

Keyboard / a11y: note basic focus and that list should be keyboard-navigable if modal.

### 3.4 Import / export (decide)

Recommend at least one of:

- **Export library** as JSON download  
- **Import** merge/replace  

Useful for backups; can be **v1.1** if it bloats MVP — say so explicitly.

### 3.5 Limits

Spec should define soft limits, e.g.:

- Max entries (e.g. 200)  
- Max chars per field (e.g. 4k / 4k)  
- Name max length  
- Behavior when quota / localStorage full  

### 3.6 Defaults & seed library

Optional **seed** entries (user can delete):

- Universal recoherence pair (from `rife-recoherence-spec.md`)  
- A short “clean photoreal” positive + common negative  

State whether seeds load only on empty library.

---

## 4. Architecture expectations (for the spec)

Prefer:

```text
app/static/js/ui/prompt-library.js   # store + save/load/list/delete + attachToTab({posId, negId, root})
```

- Vanilla ES module consistent with other `js/ui/*` helpers.  
- Tabs call `attachPromptLibrary({ positiveInput, negativeInput, toolbarEl })` once when form is rendered.  
- No React/Vue.  
- Backend only if storage option A is chosen — then small routes under existing media/meta patterns; **no** new heavy framework.

Do **not** invent a second global state system; if `state` in `app.js` is used, document keys.

---

## 5. Spec document structure (required sections)

```markdown
# Prompt Library (Save / Load) — Spec

> **Status:** Spec only
> **Date:** …
> **Audience:** Builders
> **Related:** STATUS, universal-persistence, img2img, txt2img, riferecohere

## 1. Problem
## 2. Goals / non-goals
## 3. Locked decisions (table)
## 4. Data model (JSON schema example)
## 5. Storage & migration
## 6. UX (wireframe in text + control placement)
## 7. Shared module API (JS function signatures)
## 8. Tab integration (table of ids)
## 9. Backend API (or “none for v1”)
## 10. Files to touch
## 11. Edge cases (empty name, overwrite, huge text, tab destroy/recreate)
## 12. Verification (WebUI checklist)
## 13. Conflicts with other docs
## 14. Out of scope / later
```

---

## 6. Edge cases the spec must answer

1. User saves with empty negative — allowed?  
2. User loads entry then edits fields — dirty vs still “named”?  
3. Same name saved twice — overwrite confirm or auto-suffix?  
4. Tab re-render destroys DOM — library module must re-bind without losing store.  
5. Two tabs open conceptually (only one panel live) — library is **global**, not per-tab silo (recommended).  
6. Special characters / newlines in prompts — preserve exactly; store as JSON strings.  
7. Interaction with “Prompt from image” — does not auto-save unless user clicks Save.  
8. Recohere universal defaults — loading a library entry replaces them; Save can capture recoherence pair.

---

## 7. Non-goals (v1)

- Full prompt **history** of every run (job log) — different feature.  
- Cloud sync / CivitAI prompt browser.  
- Embedding models or prompt scoring.  
- Replacing universal project persistence.  
- Backend generation of prompts (Agent already covers image→prompt).

---

## 8. After the spec is written

1. File exists at `docs/prompt-library-spec.md`.  
2. Optional: add one row under STATUS §5 “Spec only” pointing at it.  
3. Optional: one line in `docs/README.md` recently-active / remaining.  
4. **Do not** bump VERSION (no code).  
5. Tell the human the path and the **locked decisions** summary (5–10 bullets).

You may also add `docs/coder-prompt-library-prompt.md` as a short **builder** kickoff that only points at your spec — **optional**, only if it helps; primary deliverable is the **spec**.

---

## 9. Success criteria (for you as agy)

- Spec is specific enough that a builder can implement without design chat.  
- Positive **and** negative are first-class in save **and** load.  
- Shared control, not three divergent implementations.  
- Storage choice is explicit and safe w.r.t. named projects.  
- Verification section uses WebUI paths (img2img + txt2img at minimum).

**You never claim the feature is DONE in the verification sense — your deliverable is the spec document.**
