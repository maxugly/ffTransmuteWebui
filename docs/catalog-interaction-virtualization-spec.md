# Catalog Interaction & Virtualization Redesign

> **Status:** **Partial** `000.000.5.37` — hover invariant, queues, Video+Image virtualization, and JS scroll work are in tree. Headless rAF interval is not a vsync-locked DevTools 16.6ms compositor timeline; do not mark Implemented until that frame target is measured on a vsync display (or the spec is amended).
> **Audience:** Builder Agents (Implementation & Architecture)
> **Goal:** Re-architect catalog rendering and interaction to flawlessly support massive datasets (1,000+ items). Eliminate all synchronous and hover-driven network requests, introduce robust custom vanilla DOM virtualization, and decouple display logic from metadata repair.
> **Authority:** This document explicitly supersedes the `performance-catalog-ux-spec.md` rules regarding: thumbnail defaults, startup thumbnail behavior, Phase 2 background validation, Phase 3 virtualization, and search behavior. `viewportLazyThumbnails=true` is the authoritative default.

---

## 1. Central Catalog State & The Global Index

**Core Invariant:**
> Hovering, scrolling, or merely displaying a catalog card must never trigger `/api/media_info`, hashing, probing, signature validation, thumbnail generation, or variant lookup.

**`window.globalMediaIndex` Architecture:**
The builder MUST redesign the global index to treat the **canonical absolute path** as the primary item identity. 
* **Hash Mapping:** Maintain a separate `window.hashToPaths` index to resolve content hashes to multiple canonical paths (to support multiple copies of the same file).
* **Pre-Hash State:** Before a hash exists, the item is tracked exclusively by its canonical path.
* **Authoritative Record Schema:** Replace single flat states with independent readiness flags for every resource type, utilizing a strict normalized status vocabulary.
  ```json
  {
    "identity": {"canonical_path": "string"},
    "hash_state": {"hash": "string | null", "status": "known | missing | queued | repairing | failed"},
    "signature_state": {"size": "integer", "mtime_ns": "integer", "status": "known | missing | stale | queued | repairing | failed"},
    "metadata_state": {"meta": "dict | null", "status": "known | missing | queued | repairing | failed"},
    "variants_state": {"variants": "dict | null", "status": "known | missing | queued | repairing | failed"},
    "thumbnails_state": {
      "first": {
        "L": "available | missing | queued | repairing | failed",
        "M": "available | missing | queued | repairing | failed",
        "H": "available | missing | queued | repairing | failed"
      },
      "last": {
        "L": "available | missing | queued | repairing | failed",
        "M": "available | missing | queued | repairing | failed",
        "H": "available | missing | queued | repairing | failed"
      }
    },
    "repair_errors": ["string list of error messages"]
  }
  ```

---

## 2. Display Versus Repair Boundaries

**Separation of Concerns:**
* **Render Loop:** Card rendering consumes ONLY the *already-known* state from the index.
* **Focus Panel Fallback:** When metadata is absent, the focus panel MUST explicitly display "metadata unavailable". It is strictly prohibited from triggering `/api/media_info`.

**Measurable Background Repair Start Condition:**
Background repair MUST NOT begin immediately. It initiates only after:
1. Initial pool state hydration is 100% complete.
2. The first virtualized window of visible cards is fully rendered to the DOM.
3. There are zero pending render transactions.
4. A defined idle delay (e.g., `setTimeout(..., 2000)` or `requestIdleCallback`) elapses.

---

## 3. Concurrency Limits & Network Enforcements

Every layer of traffic must be independently capped by the application:

1. **Thumbnail Display GET Concurrency:** Enforced implicitly by DOM Virtualization. Because only the visible window plus overscan of `.pool-card` elements exist in the DOM, and each card may request up to two images (first and last), the browser's HTTP GET queue is naturally bounded by the DOM node count limit.
2. **Thumbnail-Generation Concurrency:** Enforced by `lazy-loader.js`. Max 8 concurrent `POST /api/thumbnails/ensure` generation requests. Ordinary cached thumbnail GETs are measured separately and are not subject to this limit.
3. **Metadata-Probe Concurrency:** Enforced by Background Repair Queue. Max 4 concurrent `/api/media_info` requests.
4. **Hashing Concurrency:** Enforced by Background Repair Queue. Max 2 concurrent hashing requests.
5. **Variant-Batch Payload Limit:** Enforced by sequence compiler. Max 100 paths per `POST /api/variants/batch`.
6. **Variant-Batch Request Concurrency:** Enforced by sequence compiler. Max 2 concurrent batch POST requests in flight simultaneously.

---

## 4. DOM Virtualization Identity Rules

**Windowed Rendering (Custom Vanilla JS):**
* Implement a custom vanilla JS absolute-positioned `translateY` recycling loop.
* **Overscan:** Dynamically calculate overscan (visible viewport + 1.5 screen-heights of offscreen buffer padding).
* **Stable Identity & Virtualization Behaviors:**
  * **Identity:** All operations use the canonical path or stable pool item ID, NEVER DOM indices.
  * **Unknown items:** Still render a blank/placeholder `.pool-card` box with accurate dimensions.
  * **Filtered items:** Removed entirely from the virtualized array mapping.
  * **Duplicate hashes:** Handled gracefully via the `hashToPaths` index mapping multiple identical DOM cards if needed.
  * **Drag/Drop Targets:** Drop coordinates calculate against the virtualized scroll offset, not static DOM elements.
  * **Selected Items Outside Window:** Selection state is maintained in a global `Set(canonical_paths)`, ensuring items remain selected even when their DOM nodes are recycled out of view.
  * **Scroll Restoration:** Loading a project explicitly restores the `scrollTop` value of the container.

---

## 5. Search & Filtering Behavior

**Final Search Decision:**
* The builder MUST implement a user-visible "Search Mode: Strict vs Fuzzy" UI toggle. Default to Fuzzy.
* **Terminology Correction:** When Strict mode is active, the engine utilizes a **precomputed search-string index** (concatenating all text into a single lowercase string property on the object and filtering via `.includes()`), rather than true inverted-index token mapping.

---

## 6. Loading / Status UX

**Precise Status Counters & Thumbnail Readiness:**
Implement a persistent catalog status bar mapping exactly to the schema states:
* **Restored:** Total items loaded.
* **Known metadata:** Items with `metadata_state.status === "known"`.
* **Known thumbnails:** Items where **both** `first` and `last` positions are `"available"` at the currently requested UI size (e.g., `M`). Partial readiness (e.g., first available, last missing) does NOT increment this counter.
* **Missing:** Items with any `"missing"` state across required hash, metadata, or currently selected thumbnail size.
* **Queued:** Items with any `"queued"` state.
* **Repairing:** Active in-flight requests (items with any `"repairing"` state).
* **Failed:** Items with `"failed"` states.

---

## 7. Performance Targets & Automated Acceptance Tests

Before claiming completion, the builder MUST execute and pass these explicit tests:

**A. Automated Performance Targets (4x CPU Throttled DevTools):**
* **First Paint:** `performance.mark('firstVisibleCard')` must fire < 200ms after data hydration.
* **View Dimensions:** 1920x1080 viewport, medium-sized thumbnail `.pool-card` elements.
* **Frame Time Measurement:** Recorded via DevTools Performance timeline while continuously scrolling top-to-bottom. 95th-percentile must remain < 16.6ms.
* **Long-Task Measurement:** Implemented via `new PerformanceObserver({entryTypes: ['longtask']})`. Must report 0 tasks > 50ms.
* **Exact DOM Count Query:** `document.querySelectorAll('.pool-scroll-canvas > .pool-card').length` must not exceed the calculated visible-window plus overscan limit. Datasets smaller than the window simply render their exact count. The image-element (`<img>`) request count may be up to two per card (first and last images).

**B. Core Invariant Regression Tests:**
* **Definition of Zero Network Requests:** Means exactly zero hover/scroll/render-triggered metadata, hash, signature, variant, or generation requests. Ordinary cached thumbnail display GETs are measured separately, are implicitly bounded by the `<img>` element count (up to two per rendered card), and are explicitly NOT confused with thumbnail-generation `POST` repair traffic.
1. **The Hover Bug Regression:** Disable the background repair queue via code flag. Load a project containing 50+ hash-known cards missing metadata. Hovering the mouse across all 50+ `.pool-card` elements MUST produce exactly zero `/api/media_info` requests in the Network tab. The focus panel MUST display “metadata unavailable”. 
2. **Stress Test Silence:** Load 1,000 synthetic pool cards. Scrolling rapidly, selecting items, and switching projects must produce exactly ZERO synchronous `/api/media_info`, hash, or signature requests.
3. **Concurrency Proof:** Throttle the network to 3G. Trigger full background repair. Assert via Network tab counting that the exact maximums (8 `POST /api/thumbnails/ensure` generations, 4 probes, 2 hashes) are strictly respected.
4. **UX Integrity:** Verify shift-selection bounds correctly span across recycled DOM nodes by maintaining the selected path `Set` independent of the DOM.

---

## 8. Implementation Notes

**Default Settings Migration:**
The current application code may still default `viewportLazyThumbnails` to `false` in the working tree. The builder MUST change the runtime default to `true` and safely migrate any old or conflicting setting names in user `localStorage` to ensure the correct default is universally applied upon launch.
