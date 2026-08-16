# Handoff — Pool thumbnail scroll fix (6.3 follow-up)

> **Resolved in `000.000.6.4`.** Same-tab `switchTab` no longer wipes `#poolGrid`.
> `renderPoolGrid` rebuilds when the canvas has zero cards. `applyPoolData`
> refreshes the wall after restore. Smoke: 791 cards after 3.5s, src unchanged
> on scroll, Image Pool 8/8, zero repair/path-thumb requests.

## What's Done

### Committed (6.3 — pool display wall rewrite)
- **Deleted** `thumb-decode-cache.js` (436 lines) — decode-cache + virtualizer coordination module.
- **`freshness.js`** — new `assignCardThumbs`/`refreshAssignedPoolThumbs` with assign-once semantics via `data-thumbKey` guard.
- **`grid.js`** — flat CSS-grid stable card wall (`mountPoolCard` → assign thumbs once; `refreshPoolCard` → never touches `img.src`). `catalogRepair` handler calls `renderPoolGrid()` + `applySeqTokenTimeStyles()`.
- **`image-pool.js`** — same flat-card rewrite for Image Pool.
- **`items.js`** — removed `__mtapiVirtualGrid` refs; hash→URL upgrade through `assignCardThumbs`.
- **`chrome.js`** — `applyPoolZoom` no longer invalidates virtual grid.
- **`virtual-grid.js`** — removed dead dynamic import of deleted `thumb-decode-cache.js`.
- **`pool.css`** — removed `.pool-scroll-canvas > .pool-card` absolute positioning; removed `is-pending`/`is-missing` recycle chrome; added `content-visibility:auto` + `contain-intrinsic-size` to `.pool-card`.
- VERSION 6.2 → 6.3; STATUS.md, SESSION-STOPPING-STATE.md, spec_registry.json updated.

### Uncommitted (current changes — in working tree, NOT committed)
**Goal:** Fix thumbnails disappearing during/after scroll in the stable card wall.

**Changes:**
1. **`pool.css`** — removed `content-visibility: auto` from `.pool-card` (kept `contain: layout style` + `contain-intrinsic-size`).
2. **`grid.js`** — changed `loading="lazy"` → `loading="eager"` on both `pool-thumb` images (first/last frame).
3. **`image-pool.js`** — changed `loading="lazy"` → `loading="eager"` on the image pool `pool-thumb` image.

**Root cause (suspected):** `content-visibility:auto` was causing the browser to skip rendering/painting card contents when scrolled out of view, and `loading="lazy"` was causing image decoders to be torn down on scroll. Both removed as requested.

## What's NOT Done — Needs Investigation

### Bug: `renderPoolForm()` called again destroys the canvas, no cards rebuilt

Debug logging revealed the following sequence with a real 791-card pool:

1. **~340ms** — `renderPoolForm()` called (user clicks Video Pool). `existing poolGrid: false` → creates full HTML, canvas `#poolGrid` is inserted.
2. **~578ms** — `renderPoolGrid()` logs "rebuild done, canvas children: 791" — **all 791 cards created successfully, no errors**.
3. **~2919ms (2.4s later)** — `renderPoolForm()` called AGAIN, `existing poolGrid: false`. Something between 578ms and 2919ms **destroyed the `#poolGrid` element** (cleared `actionPanel.innerHTML`). `renderPoolForm` recreates new HTML (empty canvas), then calls `renderPoolGrid()`.
4. At this point `_poolWallSig` is already set (from step 1), and the new canvas element is fresh (innerHTML is empty). `renderPoolGrid` finds `sig === _poolWallSig` → takes the `else` branch (refresh in-place) → queries for existing `.pool-card` elements → finds **none** → does nothing.

**Result:** 0 cards on screen, 0 network requests for thumbs.

### What I tried but didn't resolve
- Added error catching around `mountPoolCard` — no errors thrown.
- Added stack trace logging in `renderPoolForm` — the stack trace wasn't captured by Playwright's console logging (possibly a separate console event type not captured to file).
- Verified `content-visibility:auto` removal and `loading="eager"` change — these are correct per user instructions but don't address this DOM-clearing bug.

### What needs to be found
**What clears `actionPanel.innerHTML` between ~580ms and ~2920ms?** Possible sources:
- `renderTabForm()` in `app.js` (line 923: `elements.actionPanel.innerHTML = ''`) — triggered by a tab switch
- `projectNew()` / `projectOpen()` in `persistence.js` (lines 540, 588) — only if user explicitly opens a project
- `restorePoolState()` flow in `persistence.js` — re-fetches state and calls `applyPoolData`
- The catalog repair queue processing items → `loadPoolItemMeta` in `items.js` dispatches `mtapi.catalogRepair` → handler calls `renderPoolGrid()` (not `renderPoolForm`) — this shouldn't destroy the DOM

### Fix direction
When `renderPoolForm()` is called and it recreates the HTML (the non-early-return path), it should reset `_poolWallSig = null` so that `renderPoolGrid()` knows to rebuild. Currently `_poolWallSig` persists across DOM rebuilds, causing `renderPoolGrid` to skip the rebuild on a freshly-created empty canvas.

This is likely the simplest fix: reset `_poolWallSig` in `renderPoolForm` before calling `renderPoolGrid()` on the full-HTML path.

## Testing Notes

### Playwright browser smoke test (before this follow-up)
- Page loads (version 6.3) ✓
- Video Pool tab switches ✓
- No JS console errors (only pre-existing favicon 404) ✓
- No warnings ✓

### Playwright browser smoke test (with debug logging)
- `renderPoolGrid` successfully creates 791 cards with 1582 hash-based thumbs (1556 hash-based, 0 path-based) ✓
- `content-visibility` returns "none" (removed) ✓
- `loading="eager"` confirmed on all pool-thumb images ✓
- BUT: `#poolGrid` canvas is destroyed ~2.4s after initial render, and `renderPoolGrid` doesn't rebuild because `_poolWallSig` is stale ✗

### Server startup
- Server runs under tmux: `tmux new-session -d -s mtapi "cd mtapi-project && uv run python run.py"`
- Port 24590
- Catalog lock may need clearing: `rm -f ~/.cache/mtapi/catalog.lock`

### Test assets
- `/tmp/teste.mp4` — 2s video, 320×240, 24fps, audio (47KB)
- `/tmp/teste.png` — 1-frame still, 320×240 (2KB)

### Thumbnail request count (observed)
- Server log showed 1380 `/api/thumbnail?hash=...` requests during initial pool render (791 items × ~2 thumbs, with some cached/hits)

## Files Modified (uncommitted)
```
mtapi-project/app/static/css/pool.css          | 3 +-- (removed content-visibility: auto)
mtapi-project/app/static/js/pool/grid.js         | 2 +-  (loading="lazy" → "eager" × 2)
mtapi-project/app/static/js/pool/image-pool.js | 2 +-  (loading="lazy" → "eager")
```

## Files to investigate
```
mtapi-project/app/static/js/pool/grid.js        (renderPoolForm — need _poolWallSig reset)
mtapi-project/app/static/app.js                 (renderTabForm — what clears innerHTML?)
mtapi-project/app/static/js/pool/persistence.js (restorePoolState, applyPoolData — re-render triggers?)
mtapi-project/app/static/js/pool/items.js       (loadPoolItemMeta — catalogRepair dispatch)
mtapi-project/app/static/js/repair-queue.js     (beginRender/endRender — any side effects?)
```

## Next steps
1. Fix the `_poolWallSig` reset bug in `renderPoolForm` (or prevent `renderPoolForm` from being called when canvas is stale).
2. Identify what clears `actionPanel.innerHTML` at ~2919ms.
3. Re-run browser smoke test: scroll slowly, fast, drag scrollbar, verify thumbs stay painted.
4. Count thumbnail requests to verify eager loading doesn't cause network overload.
5. Commit the fix with an appropriate message.
