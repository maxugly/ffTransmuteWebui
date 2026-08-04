# Prompt Library (Save / Load) — Spec

> **Status:** **Implemented** `000.000.4.61`  
> **Date:** 2026-08-04  
> **Audience:** Builders  
> **Builder prompt:** [coder-prompt-library-prompt.md](coder-prompt-library-prompt.md)  
> **Related:** `STATUS.md`, `universal-persistence-spec.md`, img2img / txt2img / riferecohere tabs  
> **Kickoff (agy):** `coder-agy-prompt-library-prompt.md`

---

## 1. Problem

Users type long **positive** and **negative** prompts for OpenVINO/SD tools. Text is ephemeral: lost on tab switch (DOM destroyed), often not in project JSON, and tedious to retype. Agent “Prompt from image” fills a field but has no **save this pair** affordance.

## 2. Goals / non-goals

**Goals**

* Global **Prompt Library** shared across SD-style tabs.  
* Save / load **positive + negative as a pair** (load replaces both fields).  
* Survive **F5** / browser restart via `localStorage`.  
* Stay **orthogonal** to named projects / autosave (no writes into `*.ffproject.json`).

**Non-goals (v1)**

* Job-run prompt history, cloud / CivitAI, embeddings / scoring.  
* Tags, folders, export/import JSON (→ v1.1).  
* DeepDream / style free-text (unless later same pair model).

## 3. Locked decisions

| Decision | Selection | Notes |
|----------|-----------|--------|
| **Storage** | `localStorage` key `mtapi_prompt_library` | No backend v1; independent of projects |
| **Data scope** | Positive + negative **pair** | Load always replaces **both** fields |
| **One side empty** | Allowed | Empty side on load **clears** that input |
| **Both empty** | **Reject save** | `alert` — nothing useful to store |
| **Name empty / whitespace** | **Reject save** | Require non-empty trimmed name |
| **Duplicates** | Case-sensitive name match → `confirm()` overwrite | Keep same `id` on overwrite; bump `updated_at` |
| **Delete** | **In v1** via Manage / delete on selected entry | Library is useless without delete |
| **Component** | `app/static/js/ui/prompt-library.js` | `attachPromptLibrary(...)` per tab render |
| **Field types** | `HTMLInputElement` **or** textarea | Today tabs use `<input type="text">` — accept both via `.value` |
| **List order** | Newest `updated_at` first | Simple; no user sort UI |
| **Export/Import** | v1.1 | Out of MVP |
| **Emoji in labels** | Optional; prefer plain text **Prompts** / **Save** for a11y | Use existing `.btn` styles |

## 4. Data model

Serialized **JSON array** at `localStorage['mtapi_prompt_library']`.

```json
[
  {
    "id": "e4b3c2a1-1234-5678-9abc-def012345678",
    "name": "Universal Recoherence",
    "positive": "a single coherent object, well-composed scene, centered, sharp focus, highly detailed, intricate details, volumetric lighting, masterpiece, best quality, photorealistic",
    "negative": "blurry, lowres, duplicate, double image, two images, split screen, collage, double exposure, ghosting, transparent, deformed, messy, incoherent, watermark, text",
    "created_at": "2026-08-04T00:00:00.000Z",
    "updated_at": "2026-08-04T00:00:00.000Z",
    "source_tab": "riferecohere"
  }
]
```

| Field | Rule |
|-------|------|
| `id` | Stable string; `crypto.randomUUID()` if available, else `pl_${Date.now()}_${random}` |
| `name` | Trimmed; 1–80 chars |
| `positive` / `negative` | Strings; max **4000** chars each (truncate with `alert` warn **or** reject save if over — prefer **reject** with message) |
| `created_at` / `updated_at` | ISO-8601 |
| `source_tab` | Last tab that saved this entry; optional on load |

Corrupt JSON → treat as empty and re-seed (or recover `[]` without wiping if parse fails after user data existed — prefer: backup key not required; if parse fails, `console.warn` and start `[]`, then seed only if truly first run — **if key missing only**, seed; if key present but corrupt, `[]` without re-seed to avoid surprise duplicates).

**Clarified seed rule:** Seed **only** when `getItem` returns `null` / `undefined` (key never set). Empty array `[]` after user deleted everything = **do not** re-seed.

## 5. Storage & limits

| Limit | Value | On exceed |
|-------|-------|-----------|
| Max entries | **200** | Block new saves (not overwrites); `alert` to delete some |
| Max name | 80 chars | Reject or trim |
| Max field | 4000 chars | Reject save with message |
| Quota / private mode | — | `try/catch` on `setItem`; `alert` failure |

**Seeds** (only on first-ever missing key):

1. **Universal Recoherence** — pair from `rife-recoherence-spec.md` (`source_tab`: `riferecohere`).  
2. **Clean photoreal** — short generic positive + common negative (`source_tab`: `seed`).

## 6. UX

**Placement:** On img2img, txt2img, riferecohere — a compact toolbar **immediately above** the positive prompt row (or one row spanning both fields):

```text
[ Prompts ▾ ]  [ Save ]  [ Delete ]   active: Universal Recoherence | (unsaved)
```

Minimal acceptable v1: **Save** + **`<select>`** for load (first option “— Load prompt —”) + **Delete** (deletes currently selected library entry, with `confirm`).

**Interactions**

| Action | Behavior |
|--------|----------|
| **Save** | `prompt('Name')` defaulting to current active name if matched; validate; overwrite `confirm` if name exists; write pair from current inputs; refresh select |
| **Load** | On select change: set both inputs from entry; set active label; reset select placeholder optional |
| **Delete** | If an entry is selected in the dropdown (or active matched entry), `confirm` then remove; clear active label |
| **Active label** | If both field values **exactly** equal some entry’s positive+negative, show that `name`; else show empty / “unsaved” |
| **Dirty** | Any `input` on either field → if no longer exact match, clear active name |

Use existing button classes (`btn`). Small CSS in `forms.css` only if needed (e.g. `.prompt-library-bar { display:flex; gap:…; align-items:center; flex-wrap:wrap; }`).

## 7. Shared module API

`mtapi-project/app/static/js/ui/prompt-library.js`:

```javascript
/**
 * @param {object} options
 * @param {HTMLElement} options.containerEl - inject toolbar here (empty div in tab HTML)
 * @param {HTMLInputElement|HTMLTextAreaElement} options.positiveEl
 * @param {HTMLInputElement|HTMLTextAreaElement} options.negativeEl
 * @param {string} options.sourceTab - 'img2img' | 'txt2img' | 'riferecohere'
 */
export function attachPromptLibrary({ containerEl, positiveEl, negativeEl, sourceTab }) {}
```

Internal helpers (not necessarily exported): `loadStore`, `saveStore`, `ensureSeeded`, `listEntries`, `upsertByName`, `removeById`.

**Idempotency:** If `containerEl` already has the bar, replace or no-op cleanly (tab re-render creates fresh container — OK to always build).

## 8. Tab integration (v1 locked)

| Tab | File | Positive | Negative | `sourceTab` | Container |
|-----|------|----------|----------|-------------|-----------|
| Img2img | `tabs/img2img.js` | `#i2iPrompt` | `#i2iNeg` | `img2img` | e.g. `#i2iPromptLib` |
| Txt2img | `tabs/txt2img.js` | `#t2iPrompt` | `#t2iNeg` | `txt2img` | `#t2iPromptLib` |
| RIFE Recohere | `tabs/riferecohere.js` | `#rrPrompt` | `#rrNeg` | `riferecohere` | `#rrPromptLib` |

Each tab: add empty `<div id="…PromptLib" class="prompt-library-bar"></div>` in the form HTML, then after DOM insert:

```javascript
import { attachPromptLibrary } from '/js/ui/prompt-library.js';
attachPromptLibrary({
  containerEl: document.getElementById('t2iPromptLib'),
  positiveEl: document.getElementById('t2iPrompt'),
  negativeEl: document.getElementById('t2iNeg'),
  sourceTab: 'txt2img',
});
```

Call **every** form render (tab switch destroys panel).

## 9. Backend API

**None for v1.**

## 10. Files to touch

| Path | Action |
|------|--------|
| `mtapi-project/app/static/js/ui/prompt-library.js` | **NEW** |
| `mtapi-project/app/static/js/tabs/img2img.js` | container + attach |
| `mtapi-project/app/static/js/tabs/txt2img.js` | container + attach |
| `mtapi-project/app/static/js/tabs/riferecohere.js` | container + attach |
| `mtapi-project/app/static/css/forms.css` | optional bar styles |
| `docs/STATUS.md` | Spec → Partial/Implemented on ship |
| Root `VERSION` | Bump DD on ship |

No Python / no OpenAPI changes.

## 11. Edge cases

| Case | Behavior |
|------|----------|
| Empty positive **or** negative | Save OK |
| Both empty | Save rejected |
| Tab destroy/recreate | Re-`attachPromptLibrary` on render |
| Newlines / unicode | JSON strings; preserve exact `.value` |
| Active entry edited | Clear active name (dirty) |
| Overwrite | Same `id`, new `updated_at`, new texts, `source_tab` = current tab |
| 200 entries + new name | Reject; overwrite of existing still OK |
| localStorage throws | Alert; do not crash tab |
| Prompt from image | Does **not** auto-save; user must Save |

## 12. Verification (WebUI)

1. Txt2img: type pair → Save as `Test` → appears in select.  
2. Img2img: Load `Test` → both fields match.  
3. Edit negative → Save as `Test` → confirm overwrite.  
4. F5 → Txt2img → Load `Test` → edited negative present.  
5. Delete `Test` → confirm → gone from all tabs’ lists.  
6. Both fields empty → Save → rejected.  
7. Console: **zero** errors.  
8. Optional: first-ever browser profile / cleared key → two seeds appear.

**Claim DONE only after WebUI path** (root `AGENTS.md` §D). No backend to curl.

## 13. Conflicts with other docs

None. Library is global UI utility; must **not** be written into named projects via autosave. Compatible with future `universal-persistence-spec` (optional later snapshot).

## 14. Out of scope / later

* JSON export/import, tags/folders, custom sort UI.  
* Agent chat as library source (unless explicit pair UI).  
* Server-backed library / multi-device sync.  
* DeepDream / styletransfer attachment.
