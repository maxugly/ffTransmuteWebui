# Coder Prompt — Prompt Library (Save / Load)

> **Target:** ffTransmuteWebui WebUI only (vanilla JS)  
> **Spec (law):** [`docs/prompt-library-spec.md`](prompt-library-spec.md) — read it first; decisions are locked  
> **Role:** Builder (codewhale / codex / opencode). Implement working code. Do not re-open product questions.  
> **No Python / no new ops.** Frontend + optional CSS only.

---

## MISSION

Ship a **global Prompt Library** so users can **save** and **load** **positive + negative** prompt pairs across:

* **Txt2img** (`#t2iPrompt` / `#t2iNeg`)  
* **Img2img** (`#i2iPrompt` / `#i2iNeg`)  
* **RIFE Recohere** (`#rrPrompt` / `#rrNeg`)

Storage: **`localStorage`** key `mtapi_prompt_library`. Shared module: `js/ui/prompt-library.js` → `attachPromptLibrary(...)`.

---

## PHASE 0 — SCOUT

| File | Why |
|------|-----|
| `docs/prompt-library-spec.md` | Full law (data model, UX, limits, edge cases) |
| `docs/STATUS.md` | Status row on ship |
| `mtapi-project/app/static/js/tabs/notes.js` | localStorage try/catch pattern |
| `mtapi-project/app/static/js/tabs/txt2img.js` | Tab render + input ids |
| `mtapi-project/app/static/js/tabs/img2img.js` | Same + “Prompt from image” (must not auto-save) |
| `mtapi-project/app/static/js/tabs/riferecohere.js` | Defaults + ids |
| `mtapi-project/app/static/js/ui/knobs.js` | Import style from `/js/ui/…` |
| `mtapi-project/app/static/css/forms.css` | Optional bar styles |

**Invariants:** vanilla JS; no npm/React; no writes to `*.ffproject.json`; re-attach on every tab render.

---

## PHASE 1 — MODULE

### NEW `mtapi-project/app/static/js/ui/prompt-library.js`

Implement per spec §4–§7:

1. **`loadStore()` / `saveStore(entries)`** — parse array; corrupt → `[]` + warn (no re-seed if key existed).  
2. **`ensureSeeded()`** — only if `localStorage.getItem(KEY) === null`: write two seeds (Universal Recoherence + Clean photoreal).  
3. **`attachPromptLibrary({ containerEl, positiveEl, negativeEl, sourceTab })`**
   - Build toolbar into `containerEl`:
     - `<select>` load list (placeholder option “— Load prompt —”)
     - **Save** button
     - **Delete** button
     - Optional active-name `<span>`
   - Wire events; refresh select from store sorted by `updated_at` desc.
4. **Save:** `prompt('Name for this prompt pair:')` → trim → reject empty name → reject both fields empty → reject >4000 per field → if name exists `confirm` overwrite (keep `id`) else new id → persist → refresh UI.  
5. **Load:** on select change → set both `.value` → update active label → fire `input` events if other code listens (optional).  
6. **Delete:** need selected entry (select value = id) or active matched entry → `confirm` → remove → persist → refresh.  
7. **Active / dirty:** on `input` of either field, recompute exact match vs library; update label.  
8. **200 cap:** new names blocked; overwrites of existing OK.

Export only what tabs need (`attachPromptLibrary` is enough).

**Seed text** — copy from `rife-recoherence-spec.md` / spec §5; hardcode constants in the module.

---

## PHASE 2 — TABS

For **each** of `txt2img.js`, `img2img.js`, `riferecohere.js`:

1. In form HTML, insert before the positive prompt row:

```html
<div id="t2iPromptLib" class="prompt-library-bar" aria-label="Prompt library"></div>
```

(Use `i2iPromptLib` / `rrPromptLib` respectively.)

2. After `innerHTML` + knobs setup:

```javascript
import { attachPromptLibrary } from '/js/ui/prompt-library.js';

attachPromptLibrary({
  containerEl: document.getElementById('t2iPromptLib'),
  positiveEl: document.getElementById('t2iPrompt'),
  negativeEl: document.getElementById('t2iNeg'),
  sourceTab: 'txt2img',
});
```

3. Do **not** change submit payload field names.  
4. Img2img “Prompt from image” stays as-is (no auto-save).

---

## PHASE 3 — CSS (minimal)

`forms.css` if needed:

```css
.prompt-library-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem 0.6rem;
  margin: 0.25rem 0 0.5rem;
}
.prompt-library-bar select { min-width: 10rem; max-width: 18rem; }
.prompt-library-bar .prompt-lib-active {
  font-size: 0.85em;
  opacity: 0.85;
}
```

Match existing form density; do not invent a new design system.

---

## PHASE 4 — DOCS / VERSION

On ship:

1. Bump root `VERSION` far-right **DD**.  
2. `docs/STATUS.md` — move prompt library to **Shipped** (or Partial if only two tabs done — prefer all three).  
3. Spec banner → **Implemented** + version.  
4. `docs/README.md` at-a-glance if it lists the feature.

---

## PHASE 5 — VERIFY (mandatory)

Server optional (static UI), but normal path is full app:

```bash
cd mtapi-project && .venv/bin/python run.py
# http://localhost:24590/
```

Checklist from spec §12:

- [ ] Save on Txt2img → Load on Img2img  
- [ ] Overwrite confirm  
- [ ] F5 persistence  
- [ ] Delete  
- [ ] Both-empty save rejected  
- [ ] Recohere tab has bar too  
- [ ] Zero console errors  

**DONE = WebUI checklist green**, not “module exists.”

---

## ANTI-PATTERNS

* Per-tab copy-paste of store logic (must be one module).  
* Saving into project JSON / pool state.  
* Re-seeding after user wiped the library to `[]`.  
* Assuming `HTMLTextAreaElement` only — use `.value` on inputs.  
* Auto-save on every keystroke or on Run.  
* Backend routes “for later” in this ticket.

---

## DONE means

- [ ] `prompt-library.js` + three tabs wired  
- [ ] Seeds on first visit only  
- [ ] Save / load / delete / overwrite / F5 work  
- [ ] VERSION + STATUS + spec banner  
- [ ] WebUI verification with zero console errors  

**Spec wins on conflict with this prompt.**
