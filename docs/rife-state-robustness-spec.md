# RIFE State Robustness Spec

> **Status:** Implemented (hydration gate + busy-block alert removal) · `5.02`

## 1. The Problem
Currently, the UI frequently "forgets" that clips have been RIFEd and attempts to re-interpolate them on page load. This occurs because of two critical architectural flaws:
1. **Missing State:** The project save file (`pool_state.json`) saves the *path* to the RIFEd variant, but fails to save the *multiplier* (e.g., `4x`). 
2. **Race Condition:** On page load, the frontend sets an arbitrary `setTimeout` of 1.5 seconds to wait for `/api/variants` to return the multiplier from the SQLite registry. If that lookup takes longer than 1.5s (or if the frontend executes out of order), the frontend assumes the multiplier is `0`, determines the clip needs RIFEing, drops the variant link, and forces a re-render.

## 2. The Solution Pattern

### A. Persist the Multiplier in the Project State
Instead of relying solely on the SQLite registry to survive a page reload, the frontend must persist the known multiplier in the pool state payload.

**`mtapi-project/app/static/js/pool/persistence.js`**
- Update `buildPoolStatePayload()`: Currently, it sends `selected_variant_paths: state.pool.selectedVariantPaths`. Add a companion dictionary `selected_variant_multipliers` that maps the original path to the known `_rifeMultiplier`.
- Update `applyPoolData()`: When restoring the state, immediately assign `entry._rifeMultiplier` from the saved data so the sequence is never in a state of `0` while waiting for the network.

**`mtapi-project/app/media/pool.py`**
- Update `_default_pool_state()`, `load_pool_state()`, and `_normalize_pool_payload()` to accept and persist the new `selected_variant_multipliers` dictionary.

### B. Eliminate the Arbitrary Timeout & Zero-Scan Loading
The `setTimeout(..., 1500)` in `persistence.js` is a fragile hack. However, blocking the UI to `await` database lookups on hundreds of files is also unacceptable for pro-level software.

**`mtapi-project/app/static/js/pool/persistence.js`**
- Because `entry._rifeMultiplier` is now restored instantly from the JSON payload (Step A), the UI does not need to ask the database for anything on load.
- Remove the `setTimeout` block wrapping `_maybeAutoRifeAll` entirely. 
- `_maybeAutoRifeAll` should only trigger instantaneously using the already-known state in memory. If a clip's multiplier is already known, it skips it.
- Database scanning (`/api/variants`) should only ever happen lazily for *new* clips, or when the user explicitly clicks a "Find Matches" button.

### C. Defensive Guarding in `sequence.js`
Never queue a RIFE job if the metadata is still pending.

**`mtapi-project/app/static/js/pool/sequence.js`**
- In `_rifeInfoForEntry`, if `meta` or variant hydration is still pending, it must return `needed: false` or explicitly block the queueing process until the state is fully resolved.
- Modify `ensureSequenceMetaAndInstantScan` to definitively await all variant lookups (`_hydrateEntryFromVariants`) *before* it calculates `need` and queues jobs.

## 3. Verification
1. Load a project with RIFEd clips.
2. Ensure the network tab shows `/api/variants` resolving.
3. Verify that `_maybeAutoRifeAll` does not queue any clips that already meet the target FPS.
4. Throttle the network in DevTools to "Slow 3G" and refresh the page. The sequence must **not** drop the RIFE badges or queue re-renders while waiting for the slow network requests.

## 4. Implementation notes (5.02)
- Added `_hydrationComplete` flag in `sequence.js`; `ensureSequenceMetaAndInstantScan` sets it `false` during variant hydration and `true` on exit.
- `renderSequenceBox` now checks `_hydrationComplete` before auto-kicking Instant RIFE, preventing the race where `loadPoolItemMeta` -> `renderSequenceBox` fires before hydration finishes.
- Removed busy-block `alert()` popups in `job-control.js` and `pool/persistence.js`; replaced with `logConsole` + status text updates to stop modal spam.
- `applyPoolData` already persisted `rife_multiplier` (v2 payload). No backend changes required.
