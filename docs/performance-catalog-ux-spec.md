# Performance: Catalog UX & McMaster-Carr Scale

> **Status:** **Implemented (Phase 1)** `000.000.5.14` — batch signatures, batch variants, global media index, persisted-variant fast path, eager cache-first restore, Instant RIFE COW/recovery/GC. Phase 2 (startup metrics / background validation scan) and Phase 3 (virtualization / search index) are **not** implemented.  
> **Audience:** Builder Agents (Implementation)  
> **Goal:** Evolve the pool persistence and rendering architecture to flawlessly handle massive datasets (1,000+ items). Inspired by industrial "McMaster-Carr" catalog UX: instant interaction, heavy indexing, batch API processing, and virtualized scrolling.

## Core Performance Rule: Pay Once, Reuse Always

* Every time-consuming operation is a cache-fill operation. Hashing, probing, pHash generation, thumbnail extraction, and Instant RIFE generation must happen once as early as practical, then be reused by every later pool render, project switch, and session.
* No ordinary render, tab switch, project load, or startup restore may repeat completed work. It must load the persisted result by stable identity and move on.
* Stable identity is the saved content hash when available, with path + filename + filesize as the cheap initial lookup. If that identity fails because a file is new, moved, changed, missing, or explicitly retried, perform only the minimum targeted repair and then persist the result.
* Instant RIFE follows the same rule: a persisted variant and sufficient multiplier are final reusable output. Never re-encode or re-scan it merely because the project, tab, or browser was reopened.
* Any exception to this rule must be an explicit repair, retry, cache-clear, changed-file response, or user-requested higher-quality/higher-density operation—not an implicit side effect of display.

### Instant RIFE Variant Lifecycle & Recovery

* The original source file is immutable and MUST never be deleted or replaced by RIFE processing.
* RIFE writes each new output using copy-on-write semantics: encode to a new temporary/output path, verify successful completion, register the new variant and multiplier, persist the updated reference, and only then consider cleanup.
* The highest successfully completed multiplier is the preferred reusable variant. Lower-density RIFE variants may be removed only after successful promotion and only when they are not referenced by another saved project/session; otherwise they remain available until safe garbage collection.
* If a persisted RIFE path is missing, the system MUST attempt identity recovery before re-encoding:
  1. look up the variant by its stored content hash in the global media/variant index;
  2. if a matching moved file is found, update the stored path and reuse its metadata without re-encoding;
  3. only if no matching file exists anywhere may the system regenerate that RIFE variant.
* A missing path is not proof that the media is gone. Re-encoding is the final recovery step, never the first response to a stale path.

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

### Startup Restore Invariant — Load Existing Records, Do Not Re-Validate

* On startup or project switch, the pool MUST load existing media records from the persistent media database/cache directly. This is a restore operation, not a validation pass.
* For an existing record, use the persisted path, filename, file size, content hash, metadata, pHash, and thumbnail references as already-known state. Do NOT call `/api/media_signature`, hash the file, invoke ffmpeg/ffprobe, or regenerate thumbnails merely because the pool or project was opened.
* The normal fast identity is the persisted path + filename + file size. If that identity no longer matches because a file moved or changed, only then may the system perform a targeted hash lookup/check to recover the existing content-hash record. A moved file that matches the known hash reuses its metadata and thumbnails without extraction or re-probing.
* Missing cache records or genuinely new/changed files may be repaired in a separate, explicitly reported background queue. That repair path must never be confused with ordinary startup restore and must not delay pool display.
* Existing disk thumbnails must be assigned to the pool for display at startup. Thumbnail generation is only for records whose thumbnails are actually absent or invalid; it is never part of ordinary project switching.
* The application MUST NOT turn every project switch into a whole-pool signature, hash, probe, or thumbnail-generation scan.
* The normal pool display mode is eager preload: once the pool is restored, all existing thumbnail URLs are queued for browser loading with a bounded concurrency limit. Scrolling must not be the event that first requests an already-cached thumbnail. Viewport-lazy loading may exist only as an explicit optional mode, not as an implicit default.

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
