# Catalog Interaction & Virtualization Redesign

> **Status:** **Spec Only**
> **Audience:** Builder Agents (Implementation & Architecture)
> **Goal:** Re-architect catalog rendering and interaction to flawlessly support massive datasets (1,000+ items). Eliminate all synchronous and hover-driven network requests, introduce robust DOM virtualization, and decouple display logic from metadata repair.

---

## 1. Central Catalog State Invariants

**Core Invariant:**
> Hovering, scrolling, or merely displaying a catalog card must never trigger `/api/media_info`, hashing, probing, signature validation, thumbnail generation, or variant lookup.

To support this invariant, the frontend requires a single, authoritative in-memory index:
* **The Media Index:** Replace ad-hoc DOM state with a centralized memory dictionary (e.g., `window.globalMediaIndex`) tracking every file.
* **Fields:** Must consistently represent hash, absolute path, file size, OS `mtime_ns`, decoded metadata, thumbnail paths, and discovered variants.
* **State Confidence:** Every record must definitively mark its data as either *known*, *missing*, *stale*, or *queued for repair*. Operations must act strictly on these labels rather than checking the disk synchronously.

---

## 2. Display Versus Repair

**Separation of Concerns:**
* **Render Loop:** Card rendering, focus panels, and sequence selection menus MUST consume only the *already-known* state from the central index. They are strictly prohibited from initiating network work.
* **Missing State:** If an item lacks metadata (e.g., after an import or when loading a legacy project without persisted data), the UI MUST render the card in a clearly marked "unknown" or "pending" visual state (e.g., disabled badges, grayed-out duration text). It must not block display.
* **Repair Queue:** "Repairing" (fetching missing `/api/media_info`, variant data, or computing hashes) is an entirely separate operation. It occurs exclusively through a bounded, low-priority background/idle queue, or when the user explicitly clicks a "Repair Metadata" button. *Never* trigger a repair because a user hovered over a card.

---

## 3. Thumbnail Behavior & Caching

**Cache Preservation & Fast-Paths:**
* **Serve Only:** Render loops request thumbnails directly from the fast server path. 
* **No Re-requesting:** If a thumbnail is already loaded in the DOM or cached in memory, it must not be needlessly re-requested on scroll or focus.
* **Size Toggles:** Changing the visual thumbnail size via UI knobs MUST NOT clear or destroy the underlying disk/RAM cache files. It should only alter CSS presentation or request a differently sized variant from the existing cache.
* **Bounded Fallback:** Missing thumbnails are queued for generation in the background, utilizing a strictly bounded concurrency limit (e.g., max 8 in-flight requests) independent of the display render cycle.

---

## 4. DOM Virtualization

**Windowed Rendering (The McMaster-Carr DOM):**
* Rendering 1,000+ static `<div class="pool-item">` nodes crashes the browser layout engine. The catalog MUST implement a recycled DOM virtualization container (windowing).
* **Overscan:** Define a strict rendered card window (e.g., exactly the number of visible cards in the viewport + an overscan margin of 2 rows above and below).
* **Acceptance Criteria:** Virtualization cannot break existing catalog UX. Implementation is strictly rejected unless it flawlessly preserves:
  1. Drag/drop reordering.
  2. Multi-selection.
  3. Context menus.
  4. Pool-to-sequence Stitch linking.
  5. Keyboard navigation (arrows and shift-select).
  6. Instant filtering.
  7. Scroll position restoration.

---

## 5. Event Architecture & Debouncing

**UI-Only Interaction:**
* DOM events such as `mouseenter`, `mousemove`, and `scroll` MUST NOT execute expensive synchronous work, layout thrashing, or network fetch cascades.
* Specifically, the hover sequence (`setPoolHover()` → `updatePoolFocusFrame()` → `loadPoolItemMeta()`) must be entirely dismantled. Hovering updates a visual focus frame using *existing* data only.
* **Selection & State Updates:** Ordinary selection or metadata updates MUST mutate the specific card/element in place. They must avoid triggering a full grid rebuild (`renderPoolGrid()`), which destroys scroll position and forces complete DOM teardown.
* Intentional user actions that require recalculation must be debounced or batched.

---

## 6. Frontend Architecture Evolution

**Framework Assessment:**
* **Current State:** The application utilizes vanilla JavaScript.
* **Recommendation:** A complete migration to React, Vue, or Svelte carries an extreme risk of breaking deeply integrated ffmpeg/sequence DOM interactions and requires massive rewrites.
* **Target Architecture:** Implement a focused vanilla JS refactor. Utilize a lightweight, purpose-built vanilla virtualization library (e.g., `virtual-scroller` or a custom absolute-positioned `translateY` recycling loop) rather than introducing a massive VDOM framework. This provides the exact performance required with minimum migration surface area.

---

## 7. Loading / Status UX

**Background Transparency:**
* Users must never guess whether a blank field means "no data exists" or "currently fetching data."
* **Status Badges:** Implement a persistent, unobtrusive catalog status bar (e.g., in the pool header):
  > *Restored: 1,024 | Known: 800 | Queued: 200 | Repairing...*
* The UI MUST remain fully interactive and scrollable while the background repair queue ticks.

---

## 8. Persistence and Project Behavior

**Zero-Destruction Rule:**
* Changing projects, reloading the page, or executing Save/Save As/Autosave MUST NOT delete the underlying disk thumbnails, variant caches, `thumbnails_to_ram`, pHashes, or stored metadata signatures.
* **Load Semantics:** Loading a new project must rapidly hydrate the central catalog state with persisted metadata. It must *not* trigger a whole-catalog repair pass. Signatures are trusted unless explicitly invalidated.

---

## 9. Required Verification & Acceptance Tests

Before claiming implementation is complete, the builder MUST execute and pass the following tests:

1. **Stress Test:** Load a browser with a minimum of 1,000 synthetic pool cards.
2. **Network Silence on Interaction:** Record the Network tab. Scrolling slowly, scrolling rapidly, hovering over 50+ cards, selecting items, filtering the view, and switching projects must produce exactly ZERO `/api/media_info`, hash, or signature requests.
3. **Cache Silence:** Verify that already-known cards produce zero hash/probe requests upon render.
4. **Repair Isolation:** Prove that `/api/media_info` requests are ONLY created by a deliberate user action ("Repair") or the bounded background queue, never by mouse hover.
5. **Bounded Concurrency:** Monitor thumbnail generation to assert a strict max concurrency limit (e.g., no more than 8 active image fetches).
6. **No Full-Grid Rebuild:** Selecting a card or updating a single item's metadata must update that specific node in the DOM without destroying and rebuilding the entire grid array.
7. **UX Integrity:** Manually verify that keyboard navigation (arrows), drag/drop, context menus, selection bounds, sequence insertion, and instant filtering remain functional inside the virtualized container.
8. **Performance Targets:**
   * **First Paint:** < 200ms for pool hydration.
   * **Scroll Responsiveness:** Maintain 60fps while dragging the scrollbar from top to bottom.
   * **Memory:** DOM node count inside the pool container must never exceed the viewport + overscan limit, regardless of dataset size.

---

**Migration Risks:**
* `grid.js` and `image-pool.js`: The shift to absolute positioning for virtualization may break existing CSS Flexbox/Grid layouts and drag/drop offset calculations.
* `sequence.js`: Must ensure timeline references do not break when pool DOM nodes are recycled.
* `lazy-loader.js`: Intersection Observers may need recalibration to work alongside a virtualized scroll container.
