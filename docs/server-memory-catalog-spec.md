# Server-Resident Catalog Index

> **Status:** **Implemented** `000.000.5.38`
> **Scope:** `mtapi-project` media catalog and thumbnail serving
> **Priority:** Shipped after `5.37` virtualization
> **Review:** Architecture-review acceptance rules locked 2026-08-15.
>   §11–12 I/O counters, restart, process lock, warmer, and browser checks
>   accepted on `main`. `ram_evicted` is monotonic for the
>   warmer epoch and can rise after later disk-fallback puts.
>
> **Locked decisions (do not reopen during implementation):**
> - Await full metadata hydration in the FastAPI startup hook before serving.
>   Log progress. Thumbnail warming starts after `catalog_ready` and is
>   non-blocking.
> - Size change: immediately clear old-size RAM entries; never delete disk JPEGs.
> - `thumbnailsToRam=false`: immediately clear the RAM thumbnail cache and
>   cancel the warmer.
> - RAM budget: hardcoded 64 MiB, reported in diagnostics; no user setting yet.
> - No thumbnail-quality control in this task.
> - `thumbnail_warm_complete` = all eligible thumbs were **considered**, not
>   that all remain resident.

## 1. Purpose

The media catalog currently has several partial caches, but it does not have one
authoritative server-resident catalog. The path-to-hash index is cached, while
full `record.json` files and some thumbnail information can still be read from
disk during ordinary requests. Thumbnail bytes are also populated reactively
and are limited by a small LRU.

At catalog scale, display and project switching must not repeatedly parse JSON,
walk indexes, or rediscover information that has already been paid for.

This specification establishes one long-lived in-memory catalog index. Startup
hydrates it once from the persistent cache. Display requests read the index;
background repair and explicit user actions are the only operations allowed to
inspect or change media on disk.

## 2. Core invariant

After startup hydration completes **and** `catalog_ready` is published:

> Ordinary catalog display, project switching, pool restoration, variant
> badges, search, filtering, selection, hover, and cached thumbnail serving
> MUST NOT parse `index.json`, parse `record.json`, scan cache directories, run
> `stat()` on source media, invoke ffprobe/ffmpeg, hash a source, or enqueue
> repair work.

Those operations may use the already-hydrated RAM index. Missing or stale data
is represented as state and handled only by the bounded repair queue or an
explicit repair command.

The following helpers are display-forbidden after `catalog_ready` because the
current tree uses them to touch disk:

- `load_record`, `_load_index`, `resolve_hash`, `lookup_cached_hash`
- `open_media`, `get_thumb_file` (generates), `source_path_for_hash`
- `existing_thumb_file` candidate walks (H/M/L/legacy)
- `get_variants` existence checks (`Path.exists()` on parent or variant files)
- pool/project normalize with `require_exists=True` (source `is_file()` /
  `resolve()` on every membership path)

Display code must read the RAM index instead.

## 3. What lives in RAM

### 3.1 Always-resident catalog data

The server index must contain, at minimum:

- canonical path → media record;
- content hash → media record;
- content hash → all known paths, including moved/duplicate paths;
- path identity: size and the persisted signature fields;
- normalized metadata and `metaError`;
- first/last thumbnail availability for L/M/H;
- thumbnail file locations and stable cache keys;
- variants, including RIFE density and file paths;
- pHash availability and values when already persisted;
- history/open **counters** needed by the UI;
- resource states strictly mirroring the canonical schema defined in `catalog-interaction-virtualization-spec.md` (i.e., `identity`, `hash_state`, `signature_state`, `metadata_state`, `variants_state`, `thumbnails_state`, `repair_errors`).

Full `history[]` event lists are **not** required to be RAM-resident. Persist
them on disk as today; serve counters (and an on-demand detail fetch on the
repair/history path if needed). Unbounded per-record history must not sit in
the always-resident set.

The index is a read-optimized view of the persistent cache. It is not a second
user-visible source of truth.

`phash_to_ram` remains a separate tiny cache. Persisted pHash values may be
copied into the catalog record; this spec does not change that setting.

### 3.2 Optional thumbnail bytes

The existing `thumbnailsToRam` setting becomes explicit:

- `true`: the server maintains a strict LRU byte-bounded RAM cache for
  **compressed on-disk thumbnail bytes** (today: JPEG). Startup does NOT block
  waiting for preloads. A low-priority background warmer must eventually
  **consider** every already-available thumbnail at the selected UI size,
  populate the bounded RAM cache, expose progress, and report completion or
  eviction state. Considering every available thumb does **not** require every
  thumb to remain resident when the catalog exceeds the byte budget.
- `false`: cancel any warmer, immediately clear the RAM thumbnail cache, and
  do not start a new pass. `thumbnail_warm_complete` is immediate / not
  applicable. Hash-based serving uses the stored JPEG path (FileResponse or a
  single stored-path read). RAM hit/miss/eviction/resident counters are zero.
  Tests MUST NOT wait forever for a warm-complete signal when the setting is
  false.

Do not introduce WebP (or any new codec) as part of this work. Serve the file
that is already on disk.

The background warmer MUST NEVER generate missing thumbnails; a missing
thumbnail remains `missing` or `queued` and is generated only by the repair
queue or explicit user repair.

`viewportLazyThumbnails` controls browser DOM `src` assignment only. It MUST
NOT prevent, delay, cancel, or restart the backend RAM warmer.

Thumbnail **cache identity** for this task is content hash + position
(`first`/`last`) + size (`L`/`M`/`H`). Do **not** add JPEG quality control,
quality query params, or quality path suffixes in this work. A later quality
setting must extend this identity; until then a thumbnail produced under one
hash/which/size must never be served as another.

Shipped display rule (`5.21`): an L or M request may display an existing H
file. That fallback is decided **at hydration or repair**, not by walking
candidates on the GET. Store the exact file path that will be served for the
selected size. Display reads that one path.

If the user changes the UI thumbnail size (e.g., `M` to `H`), see §8.

Byte budget:

- Hardcoded **64 MiB** this task, matching the existing `ByteLRU` default.
- Always reported in the status payload as `budget_bytes`.
- Do **not** add a user-facing budget setting in this work. A later settings
  control may change the budget; until then the value is fixed.
- This cache holds compressed server bytes, NOT decoded browser image pixels.
  The implementation must not pretend decoded browser pixels can be permanently
  pinned in physical RAM.

`thumbnail_warm_complete` means the current warmer epoch **considered** every
eligible already-available thumbnail at the selected UI size. It does **not**
mean every considered thumbnail remains resident. Over-budget eviction after
consideration is success.

## 4. Startup hydration

Add one explicit catalog-hydration phase to server startup.

### 4.1 Load set (complete global catalog)

Hydrate the **union** of:

1. every `by_hash/<hash>/record.json` (content-addressed records);
2. `index.json` path → hash identity mappings;
3. session `pool_state.json` and the last/active named project snapshot,
   **for visible membership and UI state only**.

The active project must not limit which records are loaded. Orphan
`record.json` files that are absent from `index.json` are still hydrated.

Ignore `record.tmp`, `index.tmp`, and any other `*.tmp` sibling. Do not promote
a `.tmp` file to a record automatically.

### 4.2 Deterministic precedence

At startup there is no in-memory catalog yet. “Newer than in-memory” does not
apply. Use this table:

| Field class | Authoritative source | Timestamp / version |
|-------------|----------------------|---------------------|
| Content-addressed media (meta, variants, thumbs state, pHash, history, `thumb_failed`, open/history counters) | `by_hash/<hash>/record.json` | `updated_at` on that record (existing float epoch seconds) |
| Path → hash identity | `index.json` `paths[path]` | entry `updated_at` |
| Visible membership, selection, sequence order, layout, desk UI | pool / project snapshot | snapshot `updated_at` |
| Global settings (`thumbnailsToRam`, thumbnail size, …) | server `settings.json` + browser settings precedence already shipped | never from a named project |

Conflict rules:

- If `index.json` maps path P → hash A, and record B also lists P, **index
  wins** for path identity. Display-by-path uses A. B remains in the catalog
  by hash; P is not a resolution key for B.
- If two well-formed `record.json` files claim the same hash, keep the one
  with the greater `updated_at`; if equal, keep the first completed parse and
  isolate the other as a duplicate/failed record.
- Project/session embedded `meta`, thumbs, variants, hashes, and pHashes MUST
  NOT overwrite a hydrated catalog record. If the catalog has no record for
  that hash, membership still appears and the resource states are `missing`
  (repair later). Current `enrich_items_from_records` “fill empty item fields
  from disk, but keep item.meta when present” is the wrong direction for this
  spec: catalog record wins for content-addressed fields.
- A malformed source never overwrites a valid one. A valid record is never
  replaced by an empty fallback.

After `catalog_ready`, the in-memory catalog always wins over disk until an
explicit reload/rescan. Incoming project loads cannot clobber RAM catalog
fields.

### 4.3 Malformed, missing, duplicate, partial

- One bad `record.json` (missing, empty, truncated, non-object, wrong hash
  field): isolate it, increment `malformed_record_count`, continue.
- Malformed `index.json`: do **not** replace it with `{"version":1,"paths":{}}`
  and later persist that empty document. Set `index_load_failed`, hydrate path
  maps from record `paths[]` as a read-only fallback, and **refuse to persist
  `index.json` until an explicit rebuild/reload succeeds**. The current
  `_load_index` empty-on-error behavior is unsafe if a later save runs.
- Duplicate path keys in `index.json`: last well-formed entry in file order
  wins; log the duplicate.
- Missing thumbnail files: state `missing`; do not generate.
- Dead membership paths (moved/offline files): **keep** them in the visible
  set. Do not `stat()` them during hydration of membership. Do not drop them
  from the snapshot.

### 4.4 Hydration steps

1. Acquire the exclusive process lock (§7). Fail closed if it is held.
2. Load `settings.json` (selected thumbnail size, `thumbnailsToRam`). The RAM
   thumbnail budget is the hardcoded 64 MiB from §3.2.
3. Load and normalize `index.json` once, with the malformed-index rule above.
4. Enumerate `by_hash/*/record.json` only. Parse each; isolate failures.
5. Build path and hash maps. Apply the precedence table.
6. Load pool/project snapshots for membership/UI only. Do not `require_exists`.
7. Derive thumbnail and variant **states** from the hydrated records plus
   `exists()`/`stat()` on **already-known thumbnail/variant filenames stored
   in those records** (or the deterministic `_thumb_path` for L/M/H). This
   startup-only existence check is allowed. It is not a `by_hash` directory
   scan on the request path, and it must not run again after `catalog_ready`
   for display.
8. Publish `catalog_ready` only when steps 3–7 have finished for the entire
   load set (every record either resident or isolated).
9. If `thumbnailsToRam` is true, start the background warmer **after**
   `catalog_ready`. The warmer must not start earlier and must not generate.

### 4.5 `catalog_ready` is not “partially usable”

`catalog_ready` means the metadata index is **complete and safe to serve**:

- every discovered record is loaded or isolated;
- path/hash maps are built;
- thumbnail/variant states are assigned;
- display routes will not 404 a known hash merely because hydration has not
  reached it yet.

Publishing `catalog_ready` after `index.json` alone, or after the active
project subset, is a spec violation.

**Startup mechanism (mandatory):** await the full metadata hydration inside
the FastAPI startup hook before that handler returns. Uvicorn must not serve
requests until hydration has finished and `catalog_ready` is published.
Do not bind-and-503 as a first implementation. Do not serve a partial
catalog. Do not fall through to `load_record` / `resolve_hash` because the
index is not ready.

Log hydration progress (`records_loaded` / `records_total`, phase,
`index_load_failed`) so a long hydrate is visible in the server log.
Thumbnail-byte warming starts only after `catalog_ready` and remains
non-blocking. After the port is serving, the status payload reports both
phases. The UI must distinguish `catalog ready` from `thumbnail warm
complete`.

## 5. Request behavior

### 5.1 Display path

Display endpoints after `catalog_ready` resolve hash, metadata, thumbnail
status, variants, and known paths from the in-memory index only.

**Display routes** (non-exhaustive; anything the desk uses for known cards):

- `GET /api/thumbnail?hash=…` for `which=first|last`
- `GET /api/media/{hash}`
- `GET /api/variants` and `POST /api/variants/batch` for already-indexed paths
- `GET /api/pool/state` and named-project load membership overlay
- catalog/status diagnostics

Invariants for those routes:

- zero `index.json` or `record.json` reads after hydration;
- zero cache-directory scans (`iterdir` / glob of `by_hash`);
- zero source-media `stat()` / `is_file()` / `resolve()` that touches the
  original video or still;
- zero probe / hash / repair enqueue;
- zero `exists()` walks across L/M/H/legacy thumbnail candidates.

Allowed I/O on a hash thumbnail GET:

1. RAM LRU lookup by the stored cache identity.
2. On RAM miss **and** `thumbnails_state` is `available`: read the **single
   stored JPEG path** (disk fallback). That read/stat of the known cache file
   is a disk fallback, not a source stat and not a scan.
3. On RAM miss **and** state is `missing` / `failed`: return 404. Do not
   touch disk. Do not generate. Do not enqueue repair.

If the stored JPEG path is gone (disk 404 after state said `available`):
return 404, set that slot to `missing`, increment `disk_fallbacks` and a
missing/transition counter, and do **not** enqueue repair from the GET.

### 5.2 Compatibility / repair routes (isolated)

These are **not** display routes. Pool cards, sequence tokens, and virtualized
grids MUST NOT use them for known hashes:

| Route | Class | May stat / hash / generate |
|-------|--------|----------------------------|
| `GET /api/thumbnail?path=…` | compatibility / repair | yes (source stat; may resolve hash) |
| `GET /api/thumbnail?hash=…&frame=N` | Cut / scrub, not pool cards | may load range-thumb state; generation stays on ensure/repair |
| `GET /api/media_info`, `POST /api/thumbnails/ensure` | repair | yes |
| `GET /api/media_hash`, `/api/media_signature(s)` | repair / validation | source stat or hash |
| `POST /api/media/recover` | repair | targeted recovery |
| `POST /api/variants/gc` | repair / GC | yes |

A hash-based first/last thumbnail GET must never fall through into
`resolve_hash`, `load_record`, `get_thumb_file`, or `open_media`. The current
`frame=` branch that calls `load_record` must not be reachable from the
first/last display path.

### 5.3 Cache-busting URLs

Pool/sequence display URLs MUST be hash-based once the hash is known:

```
/api/thumbnail?hash=<content_hash>&which=first|last&s=<L|M|H>&v=<thumb_rev>
```

`thumb_rev` is a **content-based** revision stored in the catalog when the
JPEG is first observed or regenerated (JPEG mtime_ns at write time, or a
hash of the JPEG bytes). It is not the source file mtime, not a request
nonce, and not the global `FRAME_EXTRACT_VERSION` unless that version bump
actually rewrote this JPEG.

`v` changes only when those thumbnail bytes change. `Cache-Control: immutable`
is allowed only on URLs that include `hash`, `which`, `s`, and `v`.

### 5.4 Repair path

Repair is separate from display. It may:

- stat a source file;
- recover a moved file by hash;
- calculate a missing hash;
- probe metadata;
- generate thumbnails;
- discover or validate variants.

On successful completion, repair updates the in-memory index first, then
persists the affected record/index atomically. Other requests must immediately
see the updated RAM state without waiting for a reload.

If persistence fails after the RAM mutation: see §6.2.

### 5.5 Project switching and cache preservation

Opening another project changes **only** visible membership and desk UI state
(pools, sequence, selection, layout, form state per
`universal-persistence-spec.md`).

It MUST NOT:

- discard or rebuild the global media index;
- clear or restart the thumbnail-byte warmer (same `warmer_epoch` unless
  settings changed);
- drop variants, pHashes, thumbnail bytes, or records;
- `stat()` membership or variant files;
- prune missing/moved paths from the incoming snapshot;
- copy project-embedded meta/thumbs/variants onto hydrated records;
- enqueue repair, or treat known records as missing, merely because a project
  opened;
- call `save_pool_state` in a way that writes an existence-pruned membership
  list back to disk (that is how offline items disappear).

Project load may schedule the existing **idle** repair queue only for items
whose catalog state is already `missing` / `failed`, and only after the
virtualization idle gate
(`catalog-interaction-virtualization-spec.md` §2). That is not a warmer
restart and not a whole-catalog rescan.

`GET /api/pool/state` after `catalog_ready` is a RAM membership overlay, not
`require_exists=True` + `load_record` + `existing_thumb_file`.

## 6. Mutation and persistence

All catalog mutations must go through one index service rather than modifying
individual module globals.

### 6.1 Locks and ordering

Dual-level concurrency:

- **per-record lock** (keyed by content hash): mutate that record’s RAM
  fields and write that `record.json`;
- **global catalog/index writer lock**: mutate shared path/hash maps, rewrite
  `index.json`, publish `catalog_ready`, run explicit reload, swap
  `warmer_epoch`.

**Lock order is global → per-record. Never the reverse.**

- Field-only updates that do not change maps: per-record lock only.
- Map / `index.json` updates: take global first, then any needed record locks.
- Do not hold a record lock and then wait for global.

`asyncio.Lock` is sufficient only if every catalog mutation runs on the event
loop. Code that mutates maps from `asyncio.to_thread` must use a
`threading.Lock` that the event-loop paths also honor, or must not mutate.

After hydration, persist `index.json` from the **in-memory** map. Do not
re-read `index.json` to merge (that is the current `_update_index_entry`
pattern and loses updates).

### 6.2 Memory first; persist failure is visible

Memory is the serving view. Persistent JSON remains the restart/recovery view.

Writes use the existing atomic temporary-file replacement pattern and must
not clear unrelated records, thumbnails, pHashes, variants, or RAM cache
entries.

If persist fails after the RAM mutation:

1. Keep serving the RAM state (do not silently roll back display).
2. Mark the record (or the index) `persist_failed`.
3. Increment `persist_failed_count`.
4. Retry on the next mutation of that object and on shutdown flush.
5. Do not un-publish `catalog_ready`.
6. A process crash or restart hydrates the last successful disk write. That
   durability hole is accepted only because it is observable.

A test that kills persist (disk full / injected `OSError` on replace) MUST
show RAM updated, `persist_failed` set, and a subsequent restart **not**
silently presenting the failed write as success.

Allowed mutations (same list as before):

- add or update path mapping;
- attach a recovered path to a hash;
- update metadata/signature state;
- register a thumbnail;
- register or remove a variant;
- mark a repair failure;
- remove a record only through an explicit destructive cache operation.

If an external process changes the cache files, the server must not perform a
per-request mtime check. Provide an explicit reload/rescan action or a clearly
bounded administrative invalidation path. Reload re-runs §4 without dropping
the process lock; it increments `warmer_epoch` only if thumbnail settings
changed or the reload is a full rescan.

## 7. Process model

This architecture is a single shared in-memory catalog. Redis/Memcached are
out of scope. Multi-worker uvicorn is structurally incompatible.

### 7.1 Enforce single writer

Documentation is not enough.

1. `run.py` must pass `workers=1` (and not honor `WEB_CONCURRENCY` /
   `UVICORN_WORKERS` > 1).
2. At startup the process MUST take an exclusive lock file under the media
   cache parent (e.g. `~/.cache/mtapi/catalog.lock`). If the lock is held,
   exit non-zero with an error that names the existing process. Do not serve.
3. A second `uvicorn app.main:app --workers 4` (or two `python run.py`) must
   fail closed rather than silently fork four catalogs that last-write-wins
   on `index.json`.

### 7.2 Reload, shutdown, cancel, restart

- `uvicorn --reload` is a **dev** parent/child setup: one serving worker.
  File-change restart discards RAM and must re-hydrate from disk. That is a
  process restart, not a project switch, and it may restart the warmer.
- SIGTERM / FastAPI shutdown: cancel the warmer and in-flight repair; attempt
  a persist flush of `persist_failed` objects; release the lock. Do not write
  an empty index.
- Cancelled warmer tasks must not `put()` after their epoch is dead (§8).
- Restart always hydrates from the last successful atomic writes.

## 8. Settings changes while warming

Keep a monotonic `warmer_epoch` (integer). Each warmer task captures the
epoch at start. `put()` and progress updates from a task whose epoch is not
current are ignored.

| Change | Disk JPEGs | RAM LRU | Warmer |
|--------|------------|---------|--------|
| Thumbnail size L/M/H | **never delete** | **immediately clear** every RAM entry whose size is not the new selected size | increment epoch; cancel previous task; start a new pass for the new size |
| `thumbnailsToRam` true → false | never delete | **immediately clear** the entire RAM thumbnail cache | increment epoch; cancel; do not start a new pass |
| `thumbnailsToRam` false → true | never delete | cache is already empty | increment epoch; start a pass |
| Byte budget | not user-changeable this task (fixed 64 MiB) | — | — |
| `viewportLazyThumbnails` | none | none | **no** cancel, restart, or delay |

`POST /api/settings/clear-cache` remains an explicit user destructive action:
it may clear the RAM LRU. It must not delete disk thumbnails or records.

## 9. Suggested implementation boundaries

Create a backend catalog service/module responsible for:

- hydration and readiness state;
- normalized in-memory records;
- path/hash indexes;
- thumbnail-byte cache integration;
- mutation and persistence hooks;
- diagnostic counters;
- process lock and warmer epoch.

Refactor media routes and cache helpers to consume this service. Do not add
another independent cache in each route. Existing `cache.py` and
`performance.py` behavior should be migrated or wrapped so there is one
authoritative path.

The frontend should consume the existing catalog payload and a pollable
status document (`GET /api/catalog/status` or an extension of
`/api/media_cache`). It must not implement a second authoritative copy of
server metadata; its `globalMediaIndex` remains a display-side mirror.
WebSocket is not required.

Pool cards and sequence tokens write hash URLs at render for known hashes.
Path-based thumbnail URLs stay on Cut/scrub/compat surfaces only.

## 10. Diagnostics

Expose a development/status payload containing:

- `catalog_ready`, hydration phase, duration, `records_loaded`,
  `records_total`, `index_load_failed`;
- record count, path count, and hash count;
- malformed/failed/duplicate record count;
- `persist_failed_count`;
- `warmer_epoch`, `thumbnail_warm_complete` (all eligible thumbs
  **considered**, not all resident), selected size;
- thumbnail byte-cache: `budget_bytes`, `resident_entries`, `resident_bytes`,
  `warm_considered`, `ram_hits`, `ram_misses`, `ram_evicted` (lifetime
  evictions this process/epoch), `disk_fallbacks`;
- number of disk `record.json` reads after hydration;
- number of `index.json` reads after hydration;
- number of source `stat()` / `is_file()` calls from display requests;
- repair queue counts.

Counter identities (tests must use these, not invent synonyms):

| Name | Meaning |
|------|---------|
| `warm_considered` | available selected-size (or stored fallback) thumbs the current warmer epoch examined |
| `resident_entries` / `resident_bytes` | current LRU contents |
| `ram_evicted` | monotonic LRU evictions this epoch |
| `ram_hits` / `ram_misses` | hash-thumbnail GET LRU lookups after `catalog_ready` |
| `disk_fallbacks` | RAM misses that attempted the stored JPEG path |

Reconcile after warm-complete (catalog may exceed budget):

- `warm_considered` == number of available selected-size thumbs
- `resident_bytes` ≤ `budget_bytes`
- `resident_entries` ≤ `warm_considered`
- if `warm_considered` bytes > budget: `resident_entries` < `warm_considered`
  and `ram_evicted` ≥ `warm_considered - resident_entries`
- `ram_hits + ram_misses` == hash-thumbnail GETs in the measurement window
- a `missing` GET adds a miss and **zero** disk fallbacks

The expected post-hydration values for ordinary display traffic are zero for
disk record reads, index reads, source stats, probes, hashes, and repair
enqueues.

## 11. Verification

The builder must provide automated backend checks and a real browser test.
Checks must count real I/O (wrapped `read_text` / `json.loads` on
`index.json` and `record.json`, source `stat`/`is_file`, HTTP requests, RAM
hits, disk fallbacks). Inspecting a Python dict is not sufficient.

Use both synthetic fixtures **and**, when `~/.cache/mtapi/media` already
contains a saved catalog, a restart-against-real-data pass.

### Backend checks

1. Hydrate a fixture with at least 1,000 records and verify all path/hash maps
   are populated, including records absent from the active project snapshot.
2. After `catalog_ready`, repeated display lookups perform zero additional
   `index.json` / `record.json` reads.
3. Display lookups perform zero source stats. Pool-state GET and
   variants/batch for known paths also perform zero source stats.
4. Mutate one record through the repair path; RAM changes immediately;
   persistent files update atomically.
5. Restart and verify the same state hydrates again.
6. Enable `thumbnailsToRam` on a catalog **larger than the budget**. Assert
   §10 identities: all available selected-size thumbs were considered; not
   all remain resident; a RAM miss on an evicted available thumb is a disk
   fallback, not a test failure.
7. Missing thumbnails stay missing and do not generate during hydration or
   display.
8. Project switching preserves global records, thumbnail bytes, pHashes,
   variants, and `warmer_epoch`; membership-only overlay; no prune of
   offline paths; no warmer restart.
9. Malformed `record.json` is isolated; malformed `index.json` does not
   persist an empty index.
10. Injected persist failure after RAM mutation sets `persist_failed`;
    restart does not claim the failed write succeeded.
11. Size change mid-warm: epoch increments, old task puts are ignored, old-size
    RAM entries are cleared immediately, disk JPEGs of the old size still
    exist. `thumbnailsToRam=false` mid-warm cancels the warmer and clears RAM.
12. Hash first/last GET never calls `load_record` / `resolve_hash` /
    `get_thumb_file`.
13. Two processes / `workers>1`: the second fails closed on the lock.

### Browser checks

Against the actual saved pool when available:

1. Open the application and wait for the `catalog_ready` indicator. Display
   routes must not have been 200-served as a partial catalog before that.
2. If `thumbnailsToRam` is false, do **not** wait for warm-complete. If it is
   true, wait for `thumbnail_warm_complete` (**all eligible considered**, not
   all resident) and assert the §10 identities. Over-budget is not a failure.
3. Switch projects repeatedly. Warmer epoch and resident bytes do not reset.
   No repair/hash/signature storm. Offline items remain listed.
4. Hover, scroll, select, filter, search, open sequence, and return to both
   pools.
5. Network: allow `GET /api/thumbnail?hash=…` and catalog status polls.
   Forbid metadata, hash, signature, recover, `media_info`,
   `POST /api/thumbnails/ensure`, and path-based thumbnail GETs for known
   records during those display interactions.
6. Resident → RAM hit; evicted-available → disk fallback; missing → 404,
   zero disk fallback, zero generation. Counts reconcile per §10.
7. Missing thumbnails are repaired only by the bounded background queue or
   explicit Repair Metadata.
8. Zero unexpected console errors.
9. Change thumbnail size while cards are visible: no disk deletes; old-size
   RAM entries are gone; new hash URLs use the new `s=` and a `v` that still
   only changes when bytes change. Toggle `thumbnailsToRam` off: RAM cache
   empties and warm-complete is not waited on.

## 12. Completion rules

This work is complete only when:

- the server has one authoritative hydrated catalog index;
- `catalog_ready` is published only after the full load set is safe;
- ordinary display traffic performs no catalog JSON reads or source stats;
- project switching does not clear global catalog or thumbnail caches and
  does not stat/prune membership;
- RAM thumbnail behavior is observable and bounded;
- repair remains separate and bounded;
- persist failure is visible; successful persistence survives restart;
- single-writer lock is enforced;
- the backend and browser verification above pass.

Do not mark this complete merely because a Python dictionary exists. The
request-path counters and browser network test must demonstrate that the old
disk-scan behavior is actually gone.
