# Video Pool Toggle (Sequencer-only view)

> **Note:** UI label is **Video Pool** (`data-tab="pool"`). Older text said “Media Pool”.

> **Status:** Specification Phase
> **Category:** Frontend

## 1. Overview
Currently, the Media Pool tab always displays both the clip grid and the sequence composer docked together. When a user is focused exclusively on building or fine-tuning a sequence, the grid of raw clips becomes a visual distraction and wastes valuable screen real estate. This specification introduces a toggle button to collapse/hide the pool grid, allowing the sequencer and preview modules to expand and fill the available height. 

This enhancement leverages the existing `POOL_LAYOUT_DEFAULTS` collapsible section infrastructure.

## 2. Implementation

### A. State Management (`js/pool/constants.js` & `js/pool/layout.js`)
The application already manages collapsible pool panels (like `sequence` and `selection`) via `state.pool.layout.collapsed`.
- **`constants.js`:** Add `pool: false` to the `POOL_LAYOUT_DEFAULTS.collapsed` object.
- **`layout.js - ensurePoolLayout()`:** Ensure `'pool'` is caught in the default-false loop during state initialization.
- **`layout.js - applyPoolLayout()`:** Query the DOM for `.pool-grid-wrap` and toggle the `.is-collapsed` CSS class based on `state.pool.layout.collapsed.pool`.

### B. UI Component (`js/pool/grid.js` or `renderPoolForm`)
Inject a toggle button into the pool toolbar to control the visibility of the grid.
- **Button Elements:** `<button type="button" class="pool-toggle-btn">`
- **Icon / Text:** "Hide Pool" / "Show Pool" (along with a grid icon like `◧` if available).
- **Wiring:** Bind an `onclick` event listener that calls the existing `togglePoolSection('pool')` function, which automatically handles state flipping and triggers `applyPoolLayout()`.

### C. CSS Layout & Transitions (`css/pool.css`)
Ensure that when the grid is hidden, the remaining elements expand gracefully.
- Add rule: `.pool-grid-wrap.is-collapsed { display: none; }` (or use max-height/opacity rules to support CSS transitions).
- Ensure the `.pool-sequence-panel` or main preview container has appropriate flex-grow properties to fill the vertical void left by the collapsed grid.
- Add a CSS transition to the `.pool-grid-wrap` container for smooth UX when collapsing/expanding.

## 3. Persistence & Default Behavior
- **Default State:** `collapsed.pool = false` (The pool grid is visible by default).
- **Persistence:** Because the toggle hooks into `state.pool.layout.collapsed`, the `buildPoolStatePayload` function will automatically include the new `pool` boolean. When a project is saved and later reloaded, the grid's collapsed state will persist seamlessly without any extra API work.
- **Shortcuts:** None required at this stage.

## 4. Files to Touch
- **NEW:** `docs/pool-toggle-spec.md` (This file)
- **TOUCH:** `app/static/js/pool/constants.js` (Add `collapsed.pool`)
- **TOUCH:** `app/static/js/pool/layout.js` (Handle DOM toggling in `applyPoolLayout`)
- **TOUCH:** `app/static/js/pool/grid.js` (Render the toggle button in the toolbar)
- **TOUCH:** `app/static/css/pool.css` (CSS rules for `.pool-grid-wrap.is-collapsed` and flex expansions)

## 5. Acceptance Criteria
- **AC-1:** Given the media pool is open, When the user clicks "Hide Pool", Then the thumbnail grid disappears smoothly and the sequence composer fills the available space.
- **AC-2:** Given the pool is hidden, When the user clicks "Show Pool", Then the grid reappears and the sequence composer resizes back to its normal docked dimension.
- **AC-3:** Given the pool is collapsed, When the project state is saved and reloaded, Then the pool remains collapsed upon reload.
- **AC-4:** Given the completion of all UI actions, When checking the browser console, Then zero errors are logged.
