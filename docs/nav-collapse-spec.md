# Nav Category Collapse — Spec

> **Status:** **Implemented** — `000.000.4.69`  
> **Audience:** Builder (codewhale / codex / opencode)  
> **Kickoff:** [coder-nav-collapse-prompt.md](coder-nav-collapse-prompt.md)  
> **Related:** `STATUS.md`, `ui-state-map.md`, `persistence-inventory.md`, `style-css-map.md`  
> **Not this:** Whole-sidebar icon mode (`body.sidebar-collapsed` + `#btnSidebarCollapse`) — **already shipped**.  
> **Not this:** Pool section collapse (`state.pool.layout.collapsed.*`) — different feature.

---

## 1. Problem

The left `.nav-menu` lists **many** tools under category headers:

| Header (as of `000.000.4.68`) | Tabs (approx.) |
|-------------------------------|----------------|
| Video Moshing | mosh |
| Neural FX | deepdream, facemorph, withoutbg, styletransfer, agent, txt2img, img2img, upscale, riferecohere, rife, speedchange, imagesort |
| Transmutations | transmute, multi, quick, convert |
| Library | pool, images, sequence, cut, imgcompare, zoompan, watcher |
| Workspace | jobs, notes |
| Advanced | advanced |

The list is long enough to force constant scroll. Users want to **collapse categories** they rarely use, keep the rest, and have that preference **survive reload**.

**Today:** headers are plain labels. Only the **entire** sidebar can collapse to icons. Category collapse is **not** implemented (no `.nav-section`, no chevrons, no localStorage for section state).

---

## 2. Goal

1. Click a **category header** → hide/show that category’s tool rows.  
2. Persist each category’s expanded/collapsed state in **`localStorage`**.  
3. If the **active tab** lives in a collapsed section (reload, send-to, `switchTab`), **auto-expand** that section so the active item is visible.  
4. Play nice with existing **whole-sidebar** icon mode (`sidebar-collapsed`).  
5. Zero backend / ops changes.

---

## 3. Locked decisions

| # | Decision | Lock |
|---|----------|------|
| 1 | Structure | **Category collapse only** (not redesign nav labels, not reorder tools, not search) |
| 2 | DOM | Wrap each header + its items in `.nav-section` + `.nav-section-items` |
| 3 | Section ids | Stable `data-section` keys below (not free-form display strings) |
| 4 | Persistence key | `mtapi_nav_sections` (JSON object) — match `mtapi_sidebar_collapsed` / `mtapi_*` convention. **Not** `ffTransmute_navState` |
| 5 | Value shape | `{ [sectionId]: boolean }` where **`true` = collapsed** |
| 6 | Default | All sections **expanded** if key missing / corrupt |
| 7 | Active tab | `switchTab(tab)` **must** expand the section that contains `[data-tab="<tab>"]` |
| 8 | Whole-sidebar mode | When `body.sidebar-collapsed`, category collapse still applies if useful; chevron/header text already hidden by existing CSS — keep items as icons only. Do **not** break icon-only mode |
| 9 | Animation | v1: `display: none` on collapsed items (no max-height animation required) |
| 10 | Watcher placement | Keep **Watcher** under **Library** (current HTML). Do not invent a new “Automation” group this pass |
| 11 | VERSION | Bump far-right `DD` once on ship |
| 12 | Git | Commit when working; push only if human asked |

### Section id map (locked)

| `data-section` | Header label | `data-tab` children (order as in HTML today) |
|----------------|--------------|-----------------------------------------------|
| `mosh` | Video Moshing | `mosh` |
| `neural` | Neural FX | `deepdream`, `facemorph`, `withoutbg`, `styletransfer`, `agent`, `txt2img`, `img2img`, `upscale`, `riferecohere`, `rife`, `speedchange`, `imagesort` |
| `transmute` | Transmutations | `transmute`, `multi`, `quick`, `convert` |
| `library` | Library | `pool`, `images`, `sequence`, `cut`, `imgcompare`, `zoompan`, `watcher` |
| `workspace` | Workspace | `jobs`, `notes` |
| `advanced` | Advanced | `advanced` |

If HTML gains a tab later, put it under the nearest existing section; update this table when shipping that tab.

---

## 4. DOM (`index.html`)

Restructure `.nav-menu` from flat siblings to:

```html
<div class="nav-menu">
  <div class="nav-section" data-section="neural">
    <div class="nav-header" role="button" tabindex="0"
         aria-expanded="true" aria-controls="nav-items-neural">
      <svg class="nav-chevron" viewBox="0 0 24 24" aria-hidden="true"
           fill="none" stroke="currentColor" stroke-width="2"
           stroke-linecap="round" stroke-linejoin="round">
        <polyline points="6 9 12 15 18 9"/>
      </svg>
      <span class="nav-header-label">Neural FX</span>
    </div>
    <div class="nav-section-items" id="nav-items-neural">
      <div class="nav-item" data-tab="deepdream">…</div>
      …
    </div>
  </div>
  …
</div>
```

Rules:

- Every existing `.nav-item` and its SVG/label content **unchanged** except parent wrapper.  
- `.nav-header` gets chevron + label span.  
- Prefer `role="button"` + keyboard Enter/Space (accessibility cheap win).  
- Do **not** put the whole-sidebar collapse button inside a section.

---

## 5. CSS (`layout.css`)

Extend (do not remove) existing `.nav-header` / `.nav-item` / `body.sidebar-collapsed` rules.

```css
.nav-header {
  cursor: pointer;
  user-select: none;
  display: flex;
  align-items: center;
  gap: 6px;
}
.nav-header:hover {
  color: var(--text-main); /* or existing muted → slightly brighter */
}
.nav-chevron {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  pointer-events: none;
  transition: transform 0.15s ease;
  opacity: 0.75;
}
.nav-section.collapsed .nav-chevron {
  transform: rotate(-90deg);
}
.nav-section.collapsed .nav-section-items {
  display: none;
}
/* First header: avoid double top margin if gap already on .nav-menu */
.nav-section:first-child .nav-header {
  margin-top: 0;
}
```

**Whole-sidebar mode** (already exists):

```css
body.sidebar-collapsed .nav-header { display: none; }
```

Keep that. Category collapse still hides `.nav-section-items` when collapsed so icon-only list can drop unused groups.

Optional polish (not required): collapsed section could show a tiny count badge — **skip v1**.

---

## 6. JavaScript (`app.js` or small `js/ui/nav-sections.js`)

Prefer a small module `mtapi-project/app/static/js/ui/nav-sections.js` imported from `app.js` so `app.js` stays thinner — **either is fine**.

### 6.1 API

| Function | Role |
|----------|------|
| `saveNavSectionState()` | Read all `.nav-section` → write `localStorage.mtapi_nav_sections` |
| `loadNavSectionState()` | Apply collapsed classes + `aria-expanded` |
| `setupNavSectionCollapse()` | Bind click + keyboard on headers; call load |
| `ensureNavSectionForTab(tab)` | Expand section containing `[data-tab=tab]`; save if changed |

### 6.2 Persistence

```js
// true = collapsed
// localStorage key: mtapi_nav_sections
// example: {"neural":true,"advanced":true}
```

Corrupt JSON → treat as `{}` (all expanded).

### 6.3 Events

- Click on `.nav-header` → `toggle('collapsed')` on closest `.nav-section` → update `aria-expanded` → `saveNavSectionState()`.  
- Enter/Space on focused header → same.  
- Do **not** stop propagation in a way that breaks future nested controls (there are none on the header).

### 6.4 `switchTab(tab)`

After setting `.nav-item.active`:

```js
ensureNavSectionForTab(tab);
```

Implementation sketch:

```js
function ensureNavSectionForTab(tab) {
  const item = document.querySelector(`.nav-item[data-tab="${CSS.escape(tab)}"]`);
  const sec = item?.closest('.nav-section');
  if (sec?.classList.contains('collapsed')) {
    sec.classList.remove('collapsed');
    const h = sec.querySelector('.nav-header');
    if (h) h.setAttribute('aria-expanded', 'true');
    saveNavSectionState();
  }
}
```

Also call once at end of `loadNavSectionState()` for `state.activeTab` **after** first `switchTab` in `init`, or simply rely on `switchTab` always calling ensure (preferred).

### 6.5 Boot

In `init()` / `setupEventListeners()`:

1. `setupNavSectionCollapse()` (binds + `loadNavSectionState()`).  
2. Existing `loadSavedCollapseState()` for whole-sidebar/preview **unchanged**.

---

## 7. Non-goals

- Reordering tabs or renaming categories.  
- Per-tab “favorites” pin.  
- Collapsing the brand / status indicator.  
- Moving Watcher / Compare / Jobs to new groups (unless already correct in HTML).  
- Project-file persistence of nav collapse (session/browser only — `localStorage`).  
- Changing `body.sidebar-collapsed` behavior.

---

## 8. Files to touch

| File | Change |
|------|--------|
| `mtapi-project/app/static/index.html` | Wrap sections; chevrons |
| `mtapi-project/app/static/css/layout.css` | Header interactivity + collapsed rules |
| `mtapi-project/app/static/app.js` | Wire setup + `switchTab` ensure; or import module |
| `mtapi-project/app/static/js/ui/nav-sections.js` | **Optional** new module (recommended) |
| `docs/persistence-inventory.md` | Add `mtapi_nav_sections` row when shipping |
| `docs/STATUS.md` | Banner → Implemented; VERSION note |
| `VERSION` | Far-right `DD` bump |

---

## 9. Pitfalls

| Risk | Mitigation |
|------|------------|
| Active tab invisible after F5 | `ensureNavSectionForTab` in `switchTab` |
| `sidebar-collapsed` hides headers | Existing CSS; do not put critical controls only on header text for icon mode — items remain |
| Click on chevron steals events | `pointer-events: none` on SVG |
| Typo in `data-section` breaks persistence | Use locked id table |
| `querySelector` injection | Use `CSS.escape(tab)` |
| Indent / invalid HTML after wrap | Validate: every `nav-item` still under `.nav-menu` and exactly one section |
| Double-bind on hot reload | Guard with a `_navSectionsBound` flag if needed |

---

## 10. Verification (mandatory)

WebUI (Playwright or manual browser):

1. Open `http://localhost:24590/`.  
2. Click **Neural FX** header → items hide; chevron rotates.  
3. F5 → Neural FX still collapsed.  
4. Expand Neural FX → items return.  
5. Collapse **Advanced**, switch to DeepDream via nav → Neural expanded if needed; Advanced stays collapsed.  
6. From Image Pool or any send-to that calls `switchTab('cut')` while Library collapsed → Library **opens**.  
7. Toggle **whole-sidebar** collapse (icon mode) → no layout explosion; tools still clickable by icon.  
8. Console: no JS errors.  
9. `localStorage.mtapi_nav_sections` is valid JSON after toggles.

**Done when:** all of the above pass + VERSION + STATUS banner **Implemented**.

---

## 11. Acceptance checklist

- [ ] Six sections wrapped with locked `data-section` ids  
- [ ] Click + keyboard toggle  
- [ ] Persist / restore via `mtapi_nav_sections`  
- [ ] `switchTab` expands host section  
- [ ] Whole-sidebar icon mode still works  
- [ ] No ops/backend changes  
- [ ] VERSION DD + STATUS + persistence-inventory note  
