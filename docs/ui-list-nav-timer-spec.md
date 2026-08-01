# Spec: Sticky Job Timer + List Keyboard / Scroll UX

> **Status:** Ready for build (OpenCode / Playwright)  
> **Audience:** Builder agents  
> **Priority:** UX polish — high user visibility  
> **Related:** `job-control.js` sticky timer (partially present), `ui/list-keys.js` (partial), Image Sort / pools / sequence

---

## 1. Problems (user reports)

| # | Symptom | Likely cause (as-built) |
|---|---------|-------------------------|
| 1 | **No elapsed timer visible** while jobs run | Timer code exists in `job-control.js` (`paintStickyJobUi`) but is easy to miss, may not paint, or is overwritten; user wants a **clear sticky clock**, not progress line spam |
| 2 | **Arrows scroll the page** or tab through controls in a weird order instead of flipping list items | `list-keys` only handles some tabs; when focus is wrong or tab has no handler, browser default scroll/focus wins; focus after click may leave the “list context” |
| 3 | **Sequence is left–right**, not up–down | Sequence strip is horizontal; only up/down mental model is wrong — need **← →** as primary for sequence (↑↓ can map same) |
| 4 | **List jumps to top** after each reorder button press | Full `render*Form()` / pool re-render resets scroll; selected item not scrolled into view |

User framing: knits, things going well — polish selection, keyboard, and job feedback.

---

## 2. Goals

1. **Always-visible job elapsed timer** while any `runOpWithCancel` job runs (and Stop path).  
2. **List focus model:** clicking a list item (image/video/clip) makes that list the **keyboard target**; arrows step prev/next **without** page scroll.  
3. **Sequence:** horizontal navigation (Left/Right) through clips; Ctrl+Left/Right reorders.  
4. **Scroll retention:** after reorder (button or keyboard), keep the **moved/selected** item visible (no jump to top).  
5. **Do not** flood console with per-second timer lines — sticky UI only.

### Non-goals

- Redesign pool layout / sequencer visual design.  
- Full accessibility audit (but tabindex + `aria-selected` encouraged).  
- Changing server progress reporting.

---

## 3. Sticky elapsed timer

### 3.1 Current code (do not invent a second system)

Already in `mtapi-project/app/static/js/job-control.js`:

- `activeJob.startedAt`, `tickTimer` (1s), `paintStickyJobUi()`
- Writes to `elements.statusText` and `elements.btnRun` innerHTML with `m:ss` / `h:mm:ss`

### 3.2 Builder must verify why user sees “none”

Checklist (Playwright + real long op, e.g. Image Sort RIFE or RIFE tab):

| Check | Fix if false |
|-------|----------------|
| `setupListKeys` / init runs; `runOpWithCancel` used for Run | Wire missing tabs |
| `elements.statusText` / `btnRun` non-null when painting | Bind in `elements` once at boot |
| `activeJob.token` still set during poll | Don’t clear token before job ends |
| Status bar not overwritten every frame by something else | Guard: if job active, only `paintStickyJobUi` owns status text |
| Timer visible (contrast, layout) | Add dedicated **sticky chip** (see §3.3) |

### 3.3 Required UX (ship this even if status bar already works)

Add a **dedicated sticky job timer** that is unmistakable:

```text
┌─────────────────────────────┐
│ ● Running  0:42  · rife     │   ← fixed strip near Run/Stop or top status
└─────────────────────────────┘
```

**Suggested implementation:**

| Piece | Detail |
|-------|--------|
| Element | e.g. `#jobTimer` in header next to Run/Stop or status row (`index.html`) |
| CSS | Monospace, always visible when job active; `hidden` when idle |
| Update | `paintStickyJobUi()` sets `#jobTimer` text every 1s: `● 0:42` or `● 1:03:12` |
| Phase | Optional short phase from `lastSnap.phase` (no spam) |
| End | Hide chip; final console line already logs `done in m:ss` |

**Invariant:** one local wall clock from job start; do **not** print a new console line every second.

### 3.4 Verification (timer)

1. Start Image Sort or RIFE on a multi-second job.  
2. Within 1s, `#jobTimer` or status + Run button shows `0:00` → `0:01` → …  
3. Console has **no** repeating elapsed lines.  
4. On complete, timer hides; console has one final duration line.

---

## 4. List keyboard model (global rules)

### 4.1 Focus / “list has capture”

When user **clicks** a list row (Image Sort, Face Morph, withoutBG, Style Transfer content list, Video Pool card, Sequence clip, Image Pool card):

1. Mark that list as **active list context** for the tab (or globally).  
2. Set selection to that item; update preview if applicable.  
3. Prefer `tabindex="0"` on rows; call `row.focus({ preventScroll: true })` so subsequent keys hit the list, not random form controls.  
4. On Arrow* while list context is active (and target is not a text field/select):  
   - **`preventDefault()` + `stopPropagation()`** so the page does **not** scroll.  
   - Step selection prev/next.

### 4.2 Key map

| Context | Keys | Action |
|---------|------|--------|
| Vertical list (Image Sort, Face Morph, withoutBG, Style Transfer, Image Pool, Video Pool grid **reading order**) | **↑ / ↓** | Select previous / next item |
| Same | **← / →** | Same as ↑ / ↓ (optional but recommended for consistency) |
| Same | **Ctrl+↑/↓** (and Ctrl+←/→) | **Reorder** selected item (where order matters: Image Sort, Face Morph, Style content, Sequence) |
| **Sequence strip (horizontal)** | **← / →** | Select previous / next **clip** (primary) |
| Sequence | **↑ / ↓** | Same as ← / → (map both axes) |
| Sequence | **Ctrl+← / Ctrl+→** | Move selected clip earlier / later in sequence |
| Sequence | **Ctrl+↑ / Ctrl+↓** | Same as Ctrl+← / Ctrl+→ |
| Text input / select / textarea focused | Arrows | **Browser default** (do not steal) |
| No list context, no typing | Optional: leave default; do **not** force page jump |

### 4.3 Files to extend

| File | Work |
|------|------|
| `app/static/js/ui/list-keys.js` | Strengthen capture: `preventDefault` when list owns keys; support `axis: 'vertical' \| 'horizontal' \| 'both'`; optional `scrollSelectedIntoView` callback; ensure setup runs once |
| `tabs/imagesort.js` | Already registered — add focus + `scrollIntoView` on select/move |
| `tabs/facemorph.js`, `withoutbg.js`, `styletransfer.js` | Same: focus row, scroll into view, register if missing |
| `pool/sequence.js` + `pool/grid.js` | **Register** sequence + pool under `list-keys` (or dedicated handlers); horizontal axis for sequence |
| `pool/image-pool.js` | Register image pool selection navigation |
| `app.js` `init` | Confirm `setupListKeys()` is called |

### 4.4 Sequence-specific

Sequence UI is a **horizontal** strip (`pool-sequence-panel` / compose row).

- Selection: `state.pool.selectedSeqId` (existing).  
- Prev/next: step index in `state.pool.sequence`.  
- Reorder: existing move first/left/right/last buttons — keyboard should call the **same** helpers, then re-render **and** scroll selected chip into view horizontally (`scrollIntoView({ inline: 'nearest', block: 'nearest' })`).  
- Do not use Image Sort’s vertical-only mental model without also binding Left/Right.

### 4.5 Why arrows feel “wrong” today (document for builder)

1. **No handler** for `pool` / `sequence` → browser scrolls the page.  
2. **Focus** on a toolbar button after re-render → Tab order jumps; arrows may not hit list-keys if `isTypingTarget` false but focus is on disabled control — still should handle if `activeList` is set.  
3. Prefer **state-based capture**: once user selects a list item, arrows go to that list until they click a form field or another region.  
   - Implementation: `state.keyboardNav = { scope: 'imagesort' \| 'sequence' \| …, id }` set on row click; clear when focusing text inputs.

---

## 5. Scroll jump on reorder (must fix)

### 5.1 Bug

Pressing ↑/↓/⤒/⤓ (or sequence move buttons) calls full re-render → list container `scrollTop = 0` → user loses the item they were adjusting.

### 5.2 Required behavior

After any select or reorder:

1. Keep `selected` / `selectedSeqId` correct.  
2. After DOM paint (`requestAnimationFrame` double-rAF if needed), call:

```js
selectedEl.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
// or behavior: 'smooth' only if it does not fight rapid key-repeat
```

3. Prefer **not** scrolling the whole page — only the list/sequence scrollport. If `scrollIntoView` scrolls the window, use manual `container.scrollTop` / `scrollLeft` math relative to the scroll parent.

### 5.3 Where re-renders happen

| UI | Re-render function | After move |
|----|-------------------|------------|
| Image Sort | `renderImageSortForm()` | scroll selected `.is-row` |
| Face Morph / withoutBG / style | `render*Form()` | scroll `.fm-item.is-selected` |
| Sequence | `renderSequenceBox()` / grid refresh | scroll selected sequence chip |
| Pool move | any grid re-render | scroll selected `.pool-card` |

Helper suggestion (shared):

```js
// e.g. in list-keys.js or utils.js
function scrollListSelectionIntoView(containerSelector, selectedSelector) {
  const container = document.querySelector(containerSelector);
  const el = document.querySelector(selectedSelector);
  if (!container || !el) return;
  // keep el visible inside container without jumping page
}
```

### 5.4 Button handlers

Order-bar buttons that currently call `renderImageSortForm()` after move **must** end with scroll-into-view. Same for sequence `btnSeqMove*`.

---

## 6. Implementation plan (ordered)

1. **Timer visibility** — add `#jobTimer` chip + wire `paintStickyJobUi`; verify with long job.  
2. **Shared scroll helper** — use from all list reorders.  
3. **Image Sort** — focus row on click; scroll after move; confirm arrows + Ctrl+arrows.  
4. **Other still lists** — facemorph, withoutbg, styletransfer same pattern.  
5. **Sequence** — register horizontal nav + reorder + scroll.  
6. **Video / Image Pool** — arrows change selection among cards (no reorder unless product already has it).  
7. **Playwright** — automated checks §7.

---

## 7. Verification (OpenCode + Playwright)

### 7.1 Timer

```
1. Open http://localhost:24590/
2. Image Sort or RIFE: start multi-second op
3. Assert #jobTimer (or status) shows increasing 0:0N
4. Assert console does not grow by one line per second with only elapsed
5. On complete, timer hidden / idle status restored
```

### 7.2 Image Sort keyboard + scroll

```
1. Add ≥5 images so list scrolls
2. Click row near bottom; assert .is-selected
3. Press ArrowDown / ArrowUp — selection moves; page scrollY unchanged (or only list scrolls)
4. Press Ctrl+ArrowDown — item reorders; selected stays on same path; list does not jump to top (selected still visible)
5. Click shared ↑ button repeatedly — same scroll retention
```

### 7.3 Sequence keyboard + scroll

```
1. Sequence tab with ≥6 clips (horizontal overflow if possible)
2. Click a middle clip
3. ArrowLeft / ArrowRight move selection along strip
4. Ctrl+ArrowLeft / Ctrl+ArrowRight reorder; selected clip remains in view (not scrolled to start)
```

### 7.4 Regression

- Typing in path fields: arrows still edit caret / native control.  
- Sticky job timer still works after list-keys changes.  
- Stop button still cancels.

---

## 8. Files to touch (builder list)

| Path | Change |
|------|--------|
| `app/static/index.html` | Optional `#jobTimer` element near status/Run |
| `app/static/css/layout.css` (or forms) | Timer chip styles |
| `app/static/js/job-control.js` | Drive `#jobTimer`; guard status ownership while running |
| `app/static/js/ui/list-keys.js` | Stronger capture, axis, scroll callback, active scope |
| `app/static/js/tabs/imagesort.js` | Focus, scrollIntoView, register callbacks |
| `app/static/js/tabs/facemorph.js` | Same |
| `app/static/js/tabs/withoutbg.js` | Same |
| `app/static/js/tabs/styletransfer.js` | Same |
| `app/static/js/pool/sequence.js` | Horizontal keys + scroll |
| `app/static/js/pool/grid.js` / `image-pool.js` | Pool selection keys + scroll |
| Root `VERSION` | Far-right DD bump |

---

## 9. Acceptance criteria

- [ ] Elapsed timer clearly visible for every Run Operation job (status and/or `#jobTimer` + Run button).  
- [ ] No per-second console timer spam.  
- [ ] With a list item selected, arrows flip selection one step; page does not scroll away.  
- [ ] Sequence uses Left/Right (and Up/Down mapped) for clip selection.  
- [ ] Reorder (buttons or Ctrl+arrows) keeps the working item on-screen.  
- [ ] Text fields keep normal arrow behavior.  
- [ ] Playwright paths in §7 pass.

---

## 10. Notes for OpenCode

- Prefer **browser verification** (Playwright MCP) over curl.  
- Test with `/tmp` stills and a short video already used in AGENTS.md.  
- If sticky timer already updates status but is invisible, still add `#jobTimer` — user explicitly cannot find a timer.  
- Commit after each working sub-step; push when asked.
