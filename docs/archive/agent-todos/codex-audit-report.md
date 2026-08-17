# Codex Documentation & Architecture Audit

> **Date:** 2026-08-13  
> **Scope:** `docs/` compared with the current WebUI and media implementation  
> **Method:** Read-only audit; no application code changed.

## Executive summary

The repository is internally consistent about the narrow 4.63 named-project
protection fix, but several documents describe a broader system than the code
currently implements. The most important distinction is:

* session/pool persistence is implemented;
* full-desk persistence and inactive-tab capture are not;
* the Performance Settings document is a proposal, while the Settings tab is
  still a blank scaffold;
* thumbnail storage has one fixed JPEG per hash/kind, so resolution-aware
  extraction and immutable browser caching need a versioned key before they can
  be safely added.

## Contradictions

### 1. Universal persistence is still pool-only

`universal-persistence-spec.md` requires a full snapshot containing the active
tab, global inputs, layout, Cut, Pan & Zoom, and every tab's form state. The
current `state` is initialized in `app.js:68-190`, but
`buildPoolStatePayload()` in `static/js/pool/persistence.js` serializes only the
video/image pools, sequence options, tile/layout fields, and project pointer.
There is no `activeTab`, `globalInputs`, Cut, Zoompan, neural-tab, watcher, or
operation-form serialization in that payload.

This is already acknowledged by `persistence-inventory.md`, whose “What is NOT
persisted” section lists those fields. Therefore the spec's coverage matrix
must remain marked open; it must not be treated as an implemented contract.

### 2. Project schema/version and path differ from the target spec

The target spec calls for project schema version 2 and a session file at
`~/.cache/mtapi/session_autosave.json`. The implementation uses
`PROJECT_VERSION = 1` in `app/media/projects.py:23`, and the session path is
`POOL_STATE_PATH` (`~/.cache/mtapi/pool_state.json`) from
`app/media/config.py:25`.

The path difference is not inherently wrong, but it is undocumented design
drift. The version difference is functional: project files currently contain a
`pool` object, not the proposed full-desk schema.

### 3. Named project load loses RIFE variant metadata

Session load preserves `variant_path` and `rife_multiplier` in
`app/media/pool.py:125-132`, and the browser serializes them in
`persistence.js:66-82`. Named project load in `app/media/projects.py:106-132`
only restores `path`, `name`, and `target_duration`. A Save → Open project
round-trip therefore loses the selected/generated RIFE variant and its
multiplier, despite the current shipped status describing those values as
persisted and the universal persistence spec requiring sequence state to
round-trip.

### 4. The Settings tab is not the Performance Settings proposal

`performance-settings-spec.md` proposes controls, localStorage state, backend
sync, dynamic thumbnail sizes, RAM caches, pHash caching, autosave intervals,
and model-warm toggles. `static/js/tabs/settings.js:1-43` explicitly renders a
blank “Coming soon” scaffold and says “Nothing wired yet.” There is no
`state.settings` in `app.js`, no `/api/settings` route, and no settings field
in the pool normalizer (`app/media/pool.py:180-218`). The proposal is
correctly listed as proposed in `STATUS.md`, but its UI wording and verification
steps must not be mistaken for current behavior.

### 5. Thumbnail extraction is not resolution-aware

`performance-settings-spec.md` assumes that thumbnail size can be selected and
that new thumbnails will use 120/240/480 widths. In reality,
`app/media/thumbnails.py:79-80` hard-codes `scale=480:-2`, and
`app/media/config.py:54-55` stores only `by_hash/<hash>/first.jpg` and
`last.jpg`. Range thumbnails also have a single fixed path per frame in
`thumbnails.py:383-386`. Changing a setting could not distinguish a low-size
thumbnail from an existing high-size one without changing the key or adding
metadata/version invalidation.

### 6. Documentation headers are stale relative to the canonical status

`STATUS.md` and the handoff identify version `5.05` on 2026-08-13. The docs
index still says “At a glance — 5.00” (`docs/README.md:40`) and omits the QR
Art operation from its implemented-ops list (`README.md:102-104`). The index
also describes the older recent-shipment range. `STATUS.md` itself contains
both `qr_illusion` and `qr_art` names in different rows, while the actual
operation, tab, and route integration use `qr_art` (`app.js:298`, `qr_ops.py`
and `tabs/qr.js`). This creates avoidable ambiguity for builders and spec
registry maintenance.

### 7. QR naming in STATUS does not match the code

The shipped table refers to `qr_illusion_ops.py`, `qr_illusion_worker.py`, and
`qr_illusion.js`, but those files are not present. The actual files are
`qr_ops.py`, `qr_art_ov_worker.py`, and `tabs/qr.js`. The spec registry correctly
points at `qr-illusion-art-spec.md`, but the status table should use the
as-built names.

## Gaps and risks

### Persistence

1. **Project payload is lossy.** The backend normalizer intentionally keeps a
   fixed pool allowlist (`pool.py:180-218`), so adding new state fields without
   updating both normalizers silently drops them. This is the exact failure
   mode the full-desk spec is intended to prevent.
2. **Project metadata is not fully round-tripped.** `created_at` and
   `updated_at` are accepted by the project reader but are not returned into
   the browser state; `project_version` remains 1; active tab and form state
   are absent.
3. **No `force` API contract exists.** The spec proposes
   `/api/project/save` `force`; the route and `save_project_file` currently
   accept no such parameter. The browser performs a client-side empty-sequence
   confirmation, but there is no server-side policy or race-safe enforcement.
4. **Concurrent writers are only partially controlled.** Pool saves use an
   `asyncio.Lock` in one process, while named project writes and the subsequent
   session mirror are separate operations. Browser tabs, reload beacons, or
   multiple workers can still produce last-writer-wins state without a revision
   number or cross-process lock.
5. **Cold-start semantics are underspecified.** `restorePoolState()` prefers
   `pool_state.json` and otherwise falls back to `last_project_path.txt`.
   This is a reasonable recovery behavior, but it differs from the proposed
   “cold start unless a project is forced open” language and should be stated
   explicitly.
6. **Absolute-path normalization is incomplete.** Pool and sequence paths are
   resolved when read, but `variant_path` and arbitrary selected-variant paths
   are copied without equivalent validation/resolution. The root invariant
   requires all subprocess/API paths to be absolute.

### Thumbnail and pHash caching

1. **An entry-count LRU is not a memory bound.** `lru_cache(maxsize=1000)`
   would bound objects, not bytes. A thousand large JPEGs can still consume a
   substantial fraction of available RAM. The proposal needs a byte budget,
   eviction accounting, and an explicit clear/invalidate operation.
2. **Cache keys must include representation.** At minimum, thumbnail cache
   identity needs content hash, first/last/frame selector, requested size, and
   extraction version. Otherwise changing size or extraction behavior can serve
   the old bytes under an `immutable` URL.
3. **Disk and RAM invalidation are unspecified.** Regeneration after a source
   change, stale-last-frame cleanup, extraction-version changes, and manual
   cache clearing must evict RAM entries as well as remove/replace disk files.
4. **Process-local cache behavior is unspecified.** FastAPI deployments with
   multiple workers have one cache per process; this is acceptable only if
   documented. The first request in each worker can also duplicate disk reads.
5. **Synchronous reads in an async route need care.** Reading JPEG bytes with
   `Path.read_bytes()` directly in the route can block the event loop. Use an
   async-compatible file strategy or a bounded worker call, and coalesce
   concurrent misses for the same key.
6. **`immutable` is unsafe on the current URL shape.** The current route
   returns `/api/thumbnail?...hash=...&which=...`, while the file can be
   regenerated at the same logical URL. Immutable browser caching is safe only
   when the representation/version is part of the URL or a strong content
   version is guaranteed.
7. **pHash RAM caching needs ownership rules.** pHashes are currently small
   files loaded through `load_phash()` and generated by `ensure_phashes()`.
   A RAM cache needs invalidation when source/thumb extraction changes and must
   not cache a failed/missing result forever. It also needs a defined scope
   (per-process, per-user, or global).
8. **Model-warm is not just a UI preference.** The neural operations use
   operation-specific workers/processes. Pinning PyTorch/OpenVINO weights in
   VRAM requires a lifecycle owner, eviction policy, device/OOM fallback, and
   cancellation behavior. A toggle in three tabs alone cannot guarantee the
   promised warm state.

### UI state map and architecture

1. The state map is useful as an inventory but is not a serialization schema.
   It lists `state.facemorph`, while the live state uses `state.faceMorph`
   (`app.js:91-96`), and lists `state.imagePool` under an “Image Pool
   (`images`)” heading. Canonical key spelling should be enforced before a
   full snapshot is built.
2. The map marks speed-change controls as “mostly DOM knobs,” matching the
   current implementation, but the universal spec requires inactive-tab form
   state to be in `state`. The two documents need an explicit migration order,
   not just a coverage table that says those fields must be saved.
3. `projectNew()` and `projectOpen()` reset/apply pool state but do not reset or
   apply the other state domains listed in the universal spec. A future full
   snapshot must define whether “New Project” also clears global inputs,
   inactive form models, Cut refs, and watcher configuration.
4. The performance proposal says settings are sent to the backend, but there is
   no user/session model or settings ownership rule. A global server setting
   would cause one browser/user to affect another; local-only preferences need
   not have an API endpoint.

## Filter-platform / DRY review

The performance spec follows the subprocess invariant by directing new scale
parameters through `extract_frame`/`extract_frame_at`, rather than prescribing
an ad-hoc shell command. That part is compatible with the repository rules.
However, thumbnail extraction is media-cache bookend work, not a frame-effect
stage, so it should remain in `app/media/thumbnails.py`; it should not be
introduced as a pipeline filter.

The universal persistence spec does not introduce ffmpeg work and therefore
has no direct filter-platform violation. The main architectural risk is
parallel state serializers: a second full-desk serializer beside
`buildPoolStatePayload()` would recreate the DRY problem. The implementation
should establish one canonical snapshot/normalization path and have session
and named-project writers consume it.

## Prioritized action items

### P0 — Correct the contract before implementation

1. Update the docs index and STATUS file names/version banners so QR Art is
   consistently `qr_art` and the index reflects 5.05.
2. Amend `universal-persistence-spec.md` to label the shipped scope precisely:
   pool/session isolation is implemented; full desk, inactive tabs, schema v2,
   server force checks, and variant round-trip remain open.
3. Decide and document the session path (`pool_state.json` versus
   `session_autosave.json`) and whether project-open fallback is automatic.

### P1 — Persistence correctness

4. Add a canonical full-desk snapshot schema with versioned migrations. First
   include `activeTab`, global inputs, Cut/Zoompan, and all currently modeled
   inactive-tab state; then update both session and project normalizers.
5. Preserve and validate `variant_path`, `rife_multiplier`, and selected
   variants in named project files.
6. Add server-side empty-overwrite/force semantics and a revision or lock
   strategy that covers named file plus session mirror, including multiple
   browser tabs/workers.
7. Add round-trip tests for A → clear → Save As B → reopen A, plus inactive-tab
   and RIFE metadata cases.

### P1 — Safe thumbnail settings design

8. Define thumbnail representation keys and migration/invalidation behavior
   before adding UI. A size-aware path or URL version is required; do not add
   `immutable` to the existing URL shape first.
9. Specify a byte-bounded RAM cache, per-process behavior, async miss handling,
   and invalidation for extraction-version/source changes. Apply the same
   policy to pHash caching.
10. Decide whether settings are local browser preferences or server-global
    configuration. If backend settings are needed, define ownership and
    restart/process semantics first.

### P2 — UI/documentation cleanup

11. Align `ui-state-map.md` names with the live camelCase keys and distinguish
    modeled state, DOM-only state, persisted state, and transient state.
12. Keep `persistence-inventory.md`, `STATUS.md`, `SESSION-STOPPING-STATE.md`,
    and `docs/README.md` synchronized on every shipped version.
13. Treat model warming as a separate architecture decision from ordinary
    performance settings, with explicit VRAM/OOM and worker-lifecycle behavior.

## Verification plan for the next builder

Before marking persistence or thumbnail settings implemented:

* inspect the generated project JSON and session JSON after every state class
  changes;
* reopen a project and assert active tab, global inputs, Cut refs, inactive
  form state, RIFE variant path, and multiplier survive;
* change thumbnail size and assert both disk dimensions and URL/cache identity;
* exercise concurrent thumbnail requests and verify bounded RAM usage and
  invalidation after regeneration;
* run a real browser smoke through Settings, Pool, Save, Save As, Open, and
  refresh, while checking the browser console for errors.

