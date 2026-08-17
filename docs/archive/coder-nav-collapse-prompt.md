# Coder Prompt — Nav Category Collapse

> **Target:** ffTransmuteWebui / mtapi-project WebUI  
> **Role:** Builder (codewhale / codex / opencode)  
> **Kind:** **One-shot assignment** — product choices locked in the spec; implement without re-opening design.  
> **Authoritative spec:** [`docs/nav-collapse-spec.md`](nav-collapse-spec.md)  
> **Verification:** Browser smoke (Playwright if available; otherwise hard-refresh WebUI). Root `AGENTS.md` §D style.  
> **Spec writer cannot claim DONE** — you own implementation + verify + VERSION.

---

## Mission

Make left-nav **category headers collapsible** so the long tool list is manageable. Persist state in `localStorage`. Auto-expand the section that holds the **active tab** when `switchTab` runs.

This is **not** the whole-sidebar icon toggle (`#btnSidebarCollapse` / `body.sidebar-collapsed`) — that already works. Do not regress it.

---

## Locked decisions (do not re-ask)

| # | Lock |
|---|------|
| 1 | Spec table §3 section ids: `mosh`, `neural`, `transmute`, `library`, `workspace`, `advanced` |
| 2 | Storage key: **`mtapi_nav_sections`** — `{ sectionId: true }` means **collapsed** |
| 3 | Default: all **expanded** |
| 4 | `switchTab` → `ensureNavSectionForTab(tab)` always |
| 5 | v1 hide = `display: none` (no animation required) |
| 6 | Keep Watcher under Library (current HTML) |
| 7 | Optional module `js/ui/nav-sections.js` (recommended) |
| 8 | VERSION far-right **DD** once on ship; commit OK; **push only if human asked** |
| 9 | No backend / ops / Python changes |

Full detail: **`docs/nav-collapse-spec.md`**.

---

## Phases

### Phase 0 — Scout (read only)

| File | Why |
|------|-----|
| `docs/nav-collapse-spec.md` | Law |
| `mtapi-project/app/static/index.html` | Flat `.nav-header` / `.nav-item` list |
| `mtapi-project/app/static/css/layout.css` | `.nav-menu`, `body.sidebar-collapsed` |
| `mtapi-project/app/static/app.js` | `switchTab`, `setupEventListeners`, `loadSavedCollapseState` |

Confirm: no `.nav-section` in tree yet.

### Phase 1 — DOM wrap

Edit `index.html`:

- Wrap each category in `.nav-section[data-section="…"]`.  
- Header: chevron SVG (`.nav-chevron`, `pointer-events: none`) + label.  
- Items in `.nav-section-items`.  
- Preserve every `data-tab` and icon SVG content.

### Phase 2 — CSS

`layout.css`: clickable header, chevron rotate when collapsed, hide `.nav-section-items` when `.nav-section.collapsed`. Leave whole-sidebar rules intact.

### Phase 3 — JS

- Implement save/load/setup/ensure (module or inline in `app.js`).  
- Bind header click + Enter/Space.  
- Call setup from init.  
- Call `ensureNavSectionForTab` from `switchTab`.

### Phase 4 — Ship hygiene

- Bump `VERSION` far-right DD.  
- `docs/STATUS.md`: nav-collapse → **Implemented**; note version.  
- `docs/persistence-inventory.md`: add `mtapi_nav_sections`.  
- Spec banner → **Implemented**.  
- Spec writer handoff optional.

### Phase 5 — Verify (required before DONE)

1. Collapse **Neural FX** → F5 → still collapsed.  
2. Expand → items back.  
3. Collapse **Library**, then open Cut (nav or send-to) → Library expands; active Cut highlighted.  
4. Whole-sidebar icon collapse still works.  
5. No console errors.  
6. `localStorage.getItem('mtapi_nav_sections')` looks like `{"neural":true,…}`.

---

## Non-goals

- Favorites, search, reordering, new category names.  
- Project JSON persistence of nav state.  
- CSS height animations.  
- Changing tool set or moving Compare/Watcher.

---

## Done criteria

| Check | |
|-------|--|
| Spec §10 + §11 checklist green | required |
| Whole-sidebar collapse unbroken | required |
| VERSION + STATUS + persistence-inventory | required |
| No Python / ops churn | required |

**Claim DONE only after browser verification.**
