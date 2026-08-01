# Spec: Sticky Job Timer + List Keyboard / Scroll UX + Pre-Run Summary

> **Status:** Ready for build (OpenCode / Playwright)  
> **Audience:** Builder agents  
> **Priority:** UX polish — high user visibility  
> **Related:** `job-control.js` sticky timer (partially present), `ui/list-keys.js` (partial), Image Sort / pools / sequence / Speed

---

## 1. Problems (user reports)

| # | Symptom | Likely cause (as-built) |
|---|---------|-------------------------|
| 1 | **No elapsed timer visible** while jobs run | Timer code exists in `job-control.js` (`paintStickyJobUi`) — **keep timer on Run/Process button** (user loves it). Ensure it always updates; optional status text is secondary. Do **not** remove Run-button elapsed. |
| 2 | **Arrows scroll the page** or tab through controls in a weird order instead of flipping list items | `list-keys` only handles some tabs; when focus is wrong or tab has no handler, browser default scroll/focus wins; focus after click may leave the “list context” |
| 3 | **Sequence is left–right**, not up–down | Sequence strip is horizontal; only up/down mental model is wrong — need **← →** as primary for sequence (↑↓ can map same) |
| 4 | **List jumps to top** after each reorder button press | Full `render*Form()` / pool re-render resets scroll; selected item not scrolled into view |
| 5 | **No pre-run readout** of things we already know (keyframes × RIFE × fps → frames + duration) | Scattered half-hints (`isDurHint`, `scBudget`); not a consistent strip **above Run** |

User framing: knits, things going well — polish selection, keyboard, job feedback, and pre-run QoL numbers.

---

## 2. Goals

1. **Sticky job elapsed on the Run / Process button** (primary — user approved). Keep status bar updates if useful.  
2. **List focus model:** clicking a list item (image/video/clip) makes that list the **keyboard target**; arrows step prev/next **without** page scroll.  
3. **Sequence:** horizontal navigation (Left/Right) through clips; Ctrl+Left/Right reorders.  
4. **Scroll retention:** after reorder (button or keyboard), keep the **moved/selected** item visible (no jump to top).  
5. **Do not** flood console with per-second timer lines — sticky UI only.  
6. **Pre-run summary strip** at the **top of the action panel** (before form chrome / clearly above Run): solid totals when known, estimates when approximate.

### Non-goals

- Redesign pool layout / sequencer visual design.  
- Full accessibility audit (but tabindex + `aria-selected` encouraged).  
- Changing server progress reporting.  
- Fake precision — never invent numbers when inputs are missing.

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

### 3.3 Required UX (Run button is primary)

**Keep elapsed on the Process / Run button** — user explicitly prefers this over a separate chip-only design.

```text
[ ● 0:42 ]   ← btnRun while busy (already roughly this — keep & harden)
```

| Piece | Detail |
|-------|--------|
| **Primary** | `elements.btnRun` shows `● m:ss` (or `h:mm:ss`) every 1s while job runs |
| **Secondary** | `statusText` may mirror `Running · 0:42 · phase` |
| Optional | Small `#jobTimer` chip only if it does not fight the Run button; **not required** if Run timer is solid |
| End | Restore Run label; final console line `done in m:ss` |

**Invariant:** one local wall clock from job start; do **not** print a new console line every second.  
**Do not regress** the Run-button timer.

### 3.4 Verification (timer)

1. Start Image Sort or RIFE on a multi-second job.  
2. Within 1s, **Run button** shows `0:00` → `0:01` → …  
3. Console has **no** repeating elapsed lines.  
4. On complete, Run button restores; console has one final duration line.

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

## 6. Pre-run summary strip (QoL)

### 6.1 Placement

**Top of the action panel** for each tool tab — **first content the user sees** when the tab form renders (above or immediately under the short title), **visually before** the long form and **conceptually before Run**.

Not buried in a footer hint. Not only in the page title.

```text
┌─ action panel ─────────────────────────────────────┐
│ Image Sort → Video                                 │
│ ┌─ pre-run summary ─────────────────────────────┐  │
│ │ 4 keyframes · RIFE ×4 · 24 fps                 │  │
│ │ → ~16 frames · ~0.67 s                         │  │
│ └────────────────────────────────────────────────┘  │
│ [list / knobs …]                                   │
│                                      [ Run  ● ]    │
└────────────────────────────────────────────────────┘
```

Shared CSS class e.g. `.pre-run-summary` (neutral). Use modifiers:

| Class | When |
|-------|------|
| `.pre-run-summary` | Default solid info |
| `.pre-run-summary.is-estimate` | Muted: values depend on probe / assumptions |
| `.pre-run-summary.is-warn` | Red/amber: shortfall (e.g. Speed frame budget SHORT) |

Update live on knob change / list change / `mtapi:video-probed` / frame range — same pattern as `scBudget` / `isDurHint` but **unified strip**.

### 6.2 Solid vs estimate

| Label | Meaning |
|-------|---------|
| **Solid** | Deterministic from current UI state alone (e.g. Image Sort: K list items, user M, user F) |
| **Estimate** | Needs probe/range (source duration, frame span) or approximate RIFE `N_out ≈ N_in × M` |

Always mark estimates with `~` and class `is-estimate` when any term is estimated.

### 6.3 Per-tab formulas (minimum set)

#### Image Sort (`imagesort`)

```
K = state.imageSort.images.length
M = use_rife ? multiplier : 1
F = fps
N_out ≈ K * M          // solid for keyframe×RIFE model (same as op)
duration ≈ N_out / F   // solid given that model
```

Strip example:  
`4 keyframes · RIFE ×4 · 24 fps → ~16 frames · ~0.67 s`  
RIFE off: `4 keyframes · no RIFE · 24 fps → 4 frames · 0.17 s`

#### RIFE tab (`rife`)

Needs probe / global range:

```
N_in = frames in selected range (or full clip if open)
M = multiplier
N_out ≈ N_in * M
src_fps from probe
// RIFE op preserves duration: out_fps ≈ src_fps * (N_out/N_in) ≈ src_fps * M
duration ≈ N_in / src_fps   // ~same as source span
```

Strip:  
`~120 in · ×4 → ~480 frames · ~5.0 s @ ~96 fps` (mark estimate until probe ok)

#### Speed Change (`speedchange`)

Reuse budget math (already partially in `scBudget` — **promote** to top strip):

```
N = range frames, f = src fps, S = speed, F = target_fps or f
out_dur = (N/f) / S
needed = out_dur * F
available = N * (use_rife ? M : 1)
```

Strip:  
`0.5× · 24 fps target · out ~4.0 s · need ~96 frames · have 48` + **is-warn** if short  
Suggest RIFE × when short (existing copy).

#### Speed Ramp (transmute extras)

```
out_dur = duration knob
out_frames ≈ out_dur * encode_fps   // encode_fps from ramp math / ramp_fps if RIFE
source needed ≈ from existing updateRampInfoLine math
```

Strip: `spin_down · out 5.0 s · ~source 12.3 s · RIFE ×2` (+ warn if source short if detectable)

#### Face Morph

```
pairs = max(0, images.length - 1)
sec_per = duration knob
out_dur ≈ pairs * sec_per
frames ≈ out_dur * fps
```

Strip: `5 faces · 4 pairs · 2.0 s/pair · 30 fps → ~8.0 s · ~240 frames`

#### Convert / generic video ops

When input probed + range known:

```
span_frames = end - start + 1
span_sec = span_frames / src_fps
```

Strip: `range 1–240 · 24 fps · ~10.0 s in`  
If target preset known, optional estimate of output type only (no fake bitrate).

#### Datamosh / DeepDream / Style Transfer video

At least: **input span** (frames + seconds) when probe available.  
Neural runtime: do **not** invent wall-clock ETA unless a crude “heavy” badge is enough — prefer solid I/O numbers only.

### 6.4 Shared helper (recommended)

```js
// e.g. js/ui/pre-run-summary.js
function renderPreRunSummary(el, { lines, tone }) // tone: 'ok' | 'estimate' | 'warn'
function fmtDuration(sec) // 0.67 s / 1:05
function fmtFrames(n) // integer or ~n
```

Each tab calls `updateXxxSummary()` on render + input listeners (mirror Speed budget).

### 6.5 Verification (pre-run)

1. Image Sort: 4 images, RIFE on ×4, 24 fps → strip shows 16 frames and ~0.67 s **before** Run.  
2. Toggle RIFE off → strip updates to 4 frames / shorter duration.  
3. Speed Change: force SHORT budget → strip `is-warn` red.  
4. Face Morph: 3 faces, 2 s/pair, 30 fps → ~4 s, ~120 frames.  
5. Missing probe on RIFE tab → estimate/`—` not fake zeros.

---

## 7. Implementation plan (ordered)

1. **Harden Run-button timer** — verify `paintStickyJobUi` always owns busy Run label; fix overwrites.  
2. **Pre-run summary** — shared CSS + helper; Image Sort + Speed + RIFE + Face Morph first; then ramp/convert.  
3. **Shared scroll helper** — use from all list reorders.  
4. **Image Sort** — focus row on click; scroll after move; confirm arrows + Ctrl+arrows.  
5. **Other still lists** — facemorph, withoutbg, styletransfer same pattern.  
6. **Sequence** — register horizontal nav + reorder + scroll.  
7. **Video / Image Pool** — arrows change selection among cards.  
8. **Playwright** — automated checks §8.

---

## 8. Verification (OpenCode + Playwright)

### 8.1 Timer

```
1. Open http://localhost:24590/
2. Image Sort or RIFE: start multi-second op
3. Assert Run button text shows increasing 0:0N
4. Assert console does not grow by one line per second with only elapsed
5. On complete, Run button restores default label
```

### 8.2 Image Sort keyboard + scroll

```
1. Add ≥5 images so list scrolls
2. Click row near bottom; assert .is-selected
3. Press ArrowDown / ArrowUp — selection moves; page scrollY unchanged (or only list scrolls)
4. Press Ctrl+ArrowDown — item reorders; selected stays on same path; list does not jump to top (selected still visible)
5. Click shared ↑ button repeatedly — same scroll retention
```

### 8.3 Sequence keyboard + scroll

```
1. Sequence tab with ≥6 clips (horizontal overflow if possible)
2. Click a middle clip
3. ArrowLeft / ArrowRight move selection along strip
4. Ctrl+ArrowLeft / Ctrl+ArrowRight reorder; selected clip remains in view (not scrolled to start)
```

### 8.4 Pre-run summary

```
1. Image Sort: strip shows frames + duration from K, M, fps before Run
2. Change multiplier → strip updates without reloading tab
3. Speed Change short budget → warn styling
```

### 8.5 Regression

- Typing in path fields: arrows still edit caret / native control.  
- **Run-button elapsed timer** still works after list-keys changes.  
- Stop button still cancels.  
- Pre-run strip does not block Run.

---

## 9. Files to touch (builder list)

| Path | Change |
|------|--------|
| `app/static/js/job-control.js` | Harden Run-button timer; guard status while running |
| `app/static/css/forms.css` (or layout) | `.pre-run-summary` (+ warn/estimate) |
| `app/static/js/ui/pre-run-summary.js` | **New** shared helper (optional but preferred) |
| `app/static/js/ui/list-keys.js` | Stronger capture, axis, scroll callback, active scope |
| `app/static/js/tabs/imagesort.js` | Focus, scrollIntoView, **top summary strip** |
| `app/static/js/tabs/speedchange.js` | Promote budget to top summary strip |
| `app/static/js/tabs/rife.js` | Top summary from probe × multiplier |
| `app/static/js/tabs/facemorph.js` | Summary + list keys/scroll |
| `app/static/js/tabs/withoutbg.js` | List keys/scroll (+ simple count summary) |
| `app/static/js/tabs/styletransfer.js` | List keys/scroll (+ content count summary) |
| `app/static/js/tabs/transmute.js` | Speed ramp summary + RIFE note |
| `app/static/js/pool/sequence.js` | Horizontal keys + scroll |
| `app/static/js/pool/grid.js` / `image-pool.js` | Pool selection keys + scroll |
| Root `VERSION` | Far-right DD bump |

---

## 10. Acceptance criteria

- [ ] **Run button** shows live elapsed for every `runOpWithCancel` job.  
- [ ] No per-second console timer spam.  
- [ ] Pre-run summary at **top** of Image Sort / Speed / RIFE / Face Morph (at least) with solid frames+time where known.  
- [ ] Estimates marked with `~` / `is-estimate`; shortfalls `is-warn`.  
- [ ] With a list item selected, arrows flip selection one step; page does not scroll away.  
- [ ] Sequence uses Left/Right (and Up/Down mapped) for clip selection.  
- [ ] Reorder (buttons or Ctrl+arrows) keeps the working item on-screen.  
- [ ] Text fields keep normal arrow behavior.  
- [ ] Playwright paths in §8 pass.

---

## 11. Notes for OpenCode

- Prefer **browser verification** (Playwright MCP) over curl.  
- Test with `/tmp` stills and a short video already used in AGENTS.md.  
- **Keep elapsed on the Run button** — user loves it; do not replace it with a chip-only design.  
- Pre-run strip is **live QoL**, not a second progress system.  
- Commit after each working sub-step; push when asked.
