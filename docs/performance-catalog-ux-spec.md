# Performance: Catalog UX & McMaster-Carr Scale

> **Status:** **Spec Only**  
> **Audience:** Builder Agents (Implementation)  
> **Goal:** Evolve the pool persistence and rendering architecture to flawlessly handle massive datasets (1,000+ items). Inspired by industrial "McMaster-Carr" catalog UX: instant interaction, heavy indexing, batch API processing, and virtualized scrolling.

---

## 1. Problem Statement & Motivation

While `universal-persistence-spec` bounded the backend "Thundering Herd" via signature validation, large projects still suffer from severe frontend friction:
1. **Network Thrashing:** Fast scrolling triggers hundreds of individual `/api/media_signature` requests. 
2. **DOM Bloat:** 1,000 `<div class="pool-item">` elements in the DOM cause severe layout recalculation and rendering lag.
3. **Synchronous Sequence Freezes:** Rebuilding a 500-clip sequence fires 500 individual `/api/variants` requests.
4. **Iterative Search Lockups:** Filtering a large pool currently iterates over every item and performs string regex matching on every keystroke.

We must decouple interaction from validation, batch network traffic, and virtualize the presentation layer.

---

## 2. Phase 1: The Batching Fast-Paths (Priority)

### A. Batch Signature Endpoint (`POST /api/media_signatures`)

**Backend (`mtapi-project/app/routes/media.py`):**
* Implement a new route accepting a JSON payload of absolute paths.
* **Constraints:** Enforce max 100 paths per request. Validate absolute paths. Strip duplicates.
* **Request Schema:** `{"paths": ["/path/1.mp4", "/path/2.mp4"]}`
* **Response Schema:** A dictionary mapping paths to their signatures. Missing or inaccessible files return `null`.
  ```json
  {
    "/path/1.mp4": {"size": 1048576, "mtime_ns": 1691234567890},
    "/path/2.mp4": null 
  }
  ```
* **Implementation:** Use `os.stat()` directly. Do NOT invoke `ffmpeg` or `ffprobe`.

**Frontend (`lazy-loader.js`):**
* The Intersection Observer pushes `item.path` into a `pendingSignatureQueue`.
* An in-page async idle queue (e.g., `setInterval` running every 100ms) drains the queue, fires a single `POST /api/media_signatures` request (respecting max 100 limit), and dispatches the results to the card callbacks.

### B. Batch Variant Lookup (`POST /api/variants/batch`)

**Backend (`mtapi-project/app/routes/meta.py`):**
* Implement a new route accepting a JSON payload of base paths.
* **Constraints:** Enforce max 100 paths per request. Validate absolute paths. Strip duplicates.
* **Request Schema:** `{"paths": ["/path/1.mp4", "/path/2.mp4"]}`
* **Response Schema:** Must perfectly match existing `/api/variants` nested structure.
  ```json
  {
    "/path/1.mp4": {
      "original": [...],
      "rifed": [
        {
          "path": "/path/1_4x.mp4",
          "detail": { "multiplier": 4 }
        }
      ]
    },
    "/path/2.mp4": null
  }
  ```

**Frontend (`sequence.js`):**
* Fast-Path Rule: Only append paths to the batch request if the sequence clip is actively missing a variant, missing a multiplier, or is below the globally required RIFE multiplier. If it already satisfies the requirement, DO NOT query the backend for it.
* Extract unique base paths, execute `POST /api/variants/batch`, and populate a local variant map before calculating timeline durations.
* All variant-cache and local-map keys MUST use the normalized absolute base path (`Path.resolve()` semantics), so results from the batch endpoint, existing `_variantsCache`, badges, menus, and Instant RIFE lookups address the same entry regardless of equivalent path spelling.

### C. Global Media Index (RAM Cache)

* Create a global singleton `window.globalMediaIndex = new Map()` in `app.js`.
* **Safe Keys:** Use `content_hash` as the primary key. If hash is unknown, use `absolute_path + "_" + size + "_" + mtime_ns` as the fallback key.
* **TTL Rules:** 
  * Known hash: reuse metadata directly.
  * Unknown hash: validate size/mtime via batch API before reuse.
  * Changed signature: immediately invalidate global index entry and re-probe.

---

## 3. Phase 2: Decoupled Startup & Transparency

### A. Decoupled Startup Sync
* Do NOT block the initial pool render waiting for metadata validation.
* **Flow:**
  1. Hydrate `state.pool.items` instantly.
  2. Immediately trigger `renderPoolGrid()`.
  3. Spin up an in-page asynchronous idle queue (`requestIdleCallback` or chunking loop) — NOT a web worker.
  4. The idle queue quietly validates signatures via the batch API in chunks.

### B. Visible Loading Metrics
* Inject a sticky status badge in the pool header (`pool-header.js`).
* **Format:** `Pool restored: 812 | Verifying metadata: 50/812 | Thumbnails: 12`
* Fade out 3 seconds after validation completes.

---

## 4. Phase 3: The McMaster-Carr DOM (Virtualization)

### A. Virtualized Scroll Container (`grid.js`)
* **WARNING: High Risk.** Implement only after Phase 1 and 2 are fully stable.
* Replace static DOM nodes with a dynamically recycled absolute-positioned `.pool-scroll-canvas`.
* **Acceptance Criteria:** Virtualization MUST perfectly preserve:
  - Drag & drop reordering.
  - Multi-select.
  - Keyboard navigation (arrows).
  - Context menus.
  - Sequence Stitch actions.
  - Lazy thumbnail loading callbacks.
  - Instant filtering.
  - `scrollTo` focused card.

### B. Persistent Search Index
* Pre-compute an inverted index string on load: 
  `item._searchString = ((item.name || '') + ' ' + (item.path || '') + ' ' + (item.tags || []).join(' ')).toLowerCase();`
* **Behavior Change:** Filtering transitions from fuzzy regex matching to strict substring inclusion (`.includes()`).
* This eliminates iterative regex compilation and allows sub-millisecond filtering across thousands of items in memory.

---

## 5. Implementation Roadmap (Approved Plan)

Implement **Phase 1 exclusively** first:
1. Batch Signatures (`POST /api/media_signatures` in `media.py`).
2. Batch Variants (`POST /api/variants/batch` in `meta.py`).
3. Global Media Index (`window.globalMediaIndex` in `app.js` with composite key TTLs).
4. Persisted-variant sequence fast path (skip lookup if variant density satisfied).
5. Request/concurrency instrumentation in frontend batch queues.

**Phase 1 Acceptance Tests & Sequence Invariants:**
* **Global Rule:** All sequence variant consumers—including variant badges, titles, menus, and Instant RIFE scanning—MUST use the shared local variant map or the batch endpoint. No hidden per-clip `GET /api/variants` calls may remain.
* **Cache Population:** When a batch lookup does occur, its result MUST populate the existing `_variantsCache` / local variant map so badge rendering does not immediately repeat the work.

**Verification Criteria:**
1. A payload with 101 paths is safely rejected (or chunked correctly by the frontend).
2. Duplicate paths in the batch request produce a single backend lookup/result.
3. Missing or inaccessible files return `null` without failing the entire batch request.
4. Batch variants perfectly preserve `original`, `rifed`, `path`, and `detail` schemas.
5. For an already-dense sequence, verification must show:
   - exactly zero individual `GET /api/variants` requests.
   - exactly zero batch variant requests when persisted data already satisfies the requirement.
6. A browser stress test with 1,000 synthetic items produces strictly bounded batch traffic chunks rather than 1,000 individual requests.
