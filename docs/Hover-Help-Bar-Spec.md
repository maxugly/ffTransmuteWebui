# Context-Sensitive Help Strip (Hover Help Bar) — Spec

> Status: Proposed
> Kind: E — UI-only workspace
> Stage: n/a
> Version bump: patch when shipped
> Depends on: `docs/STATUS.md` §3 map — does not re-spec shipped ops
> Replaces: all native `title=` tooltip popups

## Problem

ffTransmute's UI is dense: DAW-style knobs, binary caption pairs, pool items, timeline, tabs with niche params (BPM, key, timesig, LoRA badges, device/format grids). Current help uses browser-native `title=` tooltips that:

- pop up over the control, obscuring it,
- have unpredictable delay / OS styling,
- stack badly when dragging knobs,
- are undiscoverable on touch,
- duplicate effort per tab.

Users (especially new ones) get no persistent guidance. Reference pattern: **FL Studio hint bar**, **GIMP status bar**, **Ableton Live Info View**, **Blender status bar**. All show a fixed, always-visible 1-2 line explanation of whatever is under the cursor — no popup in the way.

Goal: replace every hover tooltip with a single persistent help strip at the bottom of the main area.

## Goals / Non-goals

**Goals:**

- One fixed strip, always visible, never covers content, explains hovered element in 1-2 lines.
- Location: bottom edge, full width of main content area only — immediately to the right of the nav sidebar's bottom status box, not under the nav.
- Two-line layout:
  - Line 1: what it is (control name / action) — bold / high-contrast
  - Line 2: what it does, how to use, value/range, or extra hint — muted
- Eliminate all native `title=` tooltips and `mouseenter` popup tooltips app-wide; migrate their text into the new system.
- Vanilla JS/CSS/HTML only. No framework. Delegated listeners, zero per-element overhead.
- Works for all tab types: knobs, buttons, selects, text inputs, pool items, timeline handles, tabs themselves, dice roll icon, etc.
- Dynamic values for knobs: show current value in Line 1 or Line 2 while dragging/hovering.
- Graceful idle state when nothing is hovered.

**Non-goals:**

- Not a full manual / docs replacement — max ~140 chars per line, brief.
- Not a searchable help panel or `?` popover system.
- Not showing backend progress / job status (that's console/status box).
- Not context menus, not keyboard shortcut overlay.
- Not persistence of help history.

## User story

1. User launches WebUI at `http://localhost:24590/` — bottom of screen shows: nav sidebar on left (with its own small status/version box at bottom-left), and to its right, spanning rest of width, a new dark strip ~38-44px tall with two lines: idle text like "Hover a control for help — ffTransmute".
2. User moves mouse over "BPM" knob in Music tab — strip updates instantly: Line 1: `BPM — Beats Per Minute [0-300, 0=auto]` Line 2: `Sets tempo for SFT template. Scroll or drag to change. 0 lets model estimate.`
3. User hovers dice icon overlapping seed knob — strip shows Line 1: `Randomize Seed` Line 2: `Rolls a new random seed and updates display. Click to randomize.`
4. User hovers a binary caption pair (Fixed/Rand) — strip identifies which side is hovered.
5. User drags a knob — while dragging, Line 2 shows live value: `Value: 95 → 102`
6. User hovers Video Pool item — strip shows filename, resolution, duration.
7. User moves mouse to empty canvas — after 300ms debounce, strip returns to idle.
8. No browser-native yellow tooltip ever appears.

## Classification

- Kind **E** UI-only workspace.
- No new API endpoint, no filter stage, no `transmute` flag.
- Reuses existing global bar / layout grid, but introduces new module `js/ui/help-strip.js`.

## Data & Params

No backend JSON. Front-end data model:

### Declarative attribute API (preferred for static controls)

```html
<button data-help-title="Export Frame Range" 
        data-help-text="Dump current frame range to PNGs for external edit. No encode.">
  Export PNGs
</button>
```

- `data-help-title` — short name, required if element is help-enabled (≤60 chars)
- `data-help-text` — longer hint (≤160 chars)
- Alternative shorthand: `data-help="Title | Description"` — split on first `|` for quick migration.
- `data-help-persist="true"` — keeps text even when mouse leaves (for focused inputs)

### Programmatic API for dynamic knobs / pool items

```js
// js/ui/help-strip.js
export const HelpStrip = {
  init(), // call once from main.js
  register(el, { title, text, getDynamicText }), // getDynamicText returns live value string
  setIdle(title, text),
  setFromElement(el),
  clear(),
  audit() // dev-only: logs elements still using title=
}
```

- `getDynamicText` optional callback: `(el, state) => string` — used by knobs to show `Value: 95 | default 95` while dragging.
- Delegation: HelpStrip listens on `#main-content` for `mouseover` / `mouseout` / `focusin` / `focusout`, walks `event.target` up via `closest('[data-help-title],[data-help],[data-help-text]')`.
- Performance: `mouseover` not `mousemove`; throttle idle revert 200ms; no layout thrash.

### Content guidelines for help text

- Line 1: `Name — optional range / units` e.g., `Steps — [8-50]`
- Line 2: verb-led: `Drag to adjust, Shift+drag for fine. Double-click to reset.` Keep under 140 chars.
- For knobs that had binary caption pairs (`8.091`): help must name left vs right: `Seed Mode: Fixed (left) — uses fixed seed for repeatable output | Random (right) — rolls per Run`

## Architecture

**What changes:**

- Layout: existing app is likely CSS grid: `nav | main` on top, `nav-status | help-strip` on bottom. If not, add bottom row to grid.
- New module `app/static/js/ui/help-strip.js` — ~120-180 lines, ES module, no deps.
- Init in `app/static/js/main.js` after DOM ready: `HelpStrip.init()`
- Style in `app/static/css/layout.css` (or new `help-strip.css` imported by `layout.css`).

**Reuse:**

- Existing `knobs.js` already emits value changes — hook via `register` to provide dynamic text, don't duplicate knob logic.
- Existing `pool/*` items — register pool render to add `data-help-*`.

**Migration of existing tooltips:**

- Grep tree for `title=` in `index.html` and `js/tabs/*.js`. For each, move string to `data-help-*` and delete `title`.
- Also audit any custom popup tooltip divs (if any) — delete, replace with help-strip path.
- Keep `aria-label` for accessibility; help strip gets `aria-live="polite"`.

**No backend, no filter platform, no shell.**

## Files to touch

- `app/static/index.html`
  - Add bottom row container: `<div id="help-strip"><span class="help-title"></span><span class="help-text"></span></div>` inside main content footer area, to the right of nav bottom status. Ensure it is sibling of main, not inside tab panels.
  - Remove all hardcoded `title=` attributes (migrate first).

- `app/static/css/layout.css`
  - Define grid for bottom: `grid-template-rows: 1fr auto; grid-template-columns: var(--nav-w) 1fr;` bottom row: nav status + help-strip.
  - Styles:
    ```css
    #help-strip {
      grid-column: 2; grid-row: 2;
      height: 40px; /* two lines */
      display: flex; flex-direction: column; justify-content: center;
      padding: 2px 12px; background: #1e1e26; border-top: 1px solid #2e2e3e;
      font-size: 12px; line-height: 1.2; overflow: hidden; white-space: nowrap;
    }
    #help-strip .help-title { font-weight: 600; color: #e6e6f0; overflow: hidden; text-overflow: ellipsis; }
    #help-strip .help-text { font-weight: 400; color: #9a9ab0; overflow: hidden; text-overflow: ellipsis; }
    ```
  - Responsive: if viewport < 900px, collapse to 1 line with `text-overflow`.

- `app/static/js/ui/help-strip.js` (new)
  - Implements API above. Delegated listeners. Handles idle timer.

- `app/static/js/main.js`
  - Import and `HelpStrip.init()`; on dev build expose `window.HelpStrip` for audit.

- `app/static/js/tabs/*.js` (all 10+ tab modules) + `js/pool/*` + `js/ui/knobs.js`
  - Replace `title=` and any `tooltip` logic with `data-help-*` + `HelpStrip.register` for dynamic knobs.
  - Knobs: register with `getDynamicText: (el) => Value: ${knob.value} — default ${def}`

- `docs/STATUS.md` (on ship)
  - Add entry in top box: Hover help bar shipped.

- Optional: `app/static/css/help-strip.css` if you prefer separation, then import in `index.html`.

## UI sketch

```
+-----------------------------------+-------------------------------------------+
| Nav sidebar (tabs)                | Main content (tab panel)                |
|  - Cut                            |  [global video bar]                     |
|  - Music (9 rows + bank + grid)   |  [frame range]                          |
|  - Datamosh etc...                |  [knobs / forms / pool]                 |
|                                   |                                           |
+-----------------------------------+-------------------------------------------+
| [nav bottom status: VERSION + job]| [HELP STRIP — 2 lines across main area] |
|  v0.xxx • idle                    | Title: BPM — Beats Per Minute [0-300]    |
|                                   | Text: Sets tempo for SFT template. Drag… |
+-----------------------------------+-------------------------------------------+
```

Idle state:
- Title: `ffTransmute — Hover for help`
- Text: `Hover any control, knob, or pool item to see what it does. No popups.`

Hover state:
- Title: control name, truncated.
- Text: hint + live value if dragging.

Focus state (keyboard):
- Same as hover when input focused via Tab.

Touch:
- On `touchstart`, show help for tapped element, clear on next tap elsewhere.

## Edge cases

- Rapid mouse moves across many controls: only last `mouseover` wins, no flicker — use `requestAnimationFrame` or 16ms debounce.
- Disabled controls: still show help, but Line 2 appends `(disabled — needs video)` etc.
- Nested elements: e.g., dice icon inside knob bank — `closest` ensures child help wins over parent.
- Missing help text: element without `data-help-*` → ignore, keep current help, don't clear to idle immediately.
- Overflow: two lines must truncate with ellipsis, never wrap to 3rd line.
- Existing `title=` leftovers: `HelpStrip.audit()` in console logs warnings if any `*[title]` remains under `#main-content`.
- Keyboard nav: `focusin` should set help, `focusout` should schedule idle revert 300ms.
- Window blur: clear to idle.
- Performance: no `mousemove` listener; only `mouseover`/`mouseout`. Should be <0.5ms per event.
- Dark theme: ensure contrast AA on #1e1e26 bg.
- No JS errors if help-strip element missing (fail silently).

## Acceptance tests

### UI / Playwright (required, headed)

1. **Strip renders:**
   - Load `http://localhost:24590/` → `document.getElementById('help-strip')` exists, visible, `grid-column: 2`, height 36-48px, two child spans.

2. **Hover updates:**
   - Hover `[data-help-title]` via Playwright `locator.hover()` → `#help-strip .help-title` text changes within 50ms to match hovered element's title.
   - Hover empty area → after 300ms, returns to idle text.

3. **No native tooltips:**
   - `document.querySelectorAll('#main-content [title]').length === 0` — zero title attributes remain in main area (nav status box exempt).

4. **Knob dynamic value:**
   - Hover Music tab BPM knob → help shows `BPM`. Start drag → help Text updates with `Value:` substring and live number.
   - Playwright drag test passes.

5. **Pool item:**
   - Hover Video Pool item → help shows filename / resolution hint.

6. **Keyboard focus:**
   - `Tab` into an input → help updates same as hover.

7. **Zero console errors:**
   - During all hover/drag/focus actions, `page.on('console', msg => msg.type() === 'error')` collects zero errors.

8. **Two-line truncation:**
   - Inject extremely long help text (300 chars) → strip remains 40px tall, `text-overflow: ellipsis` applied, no layout shift of main content.

9. **Migration completeness:**
   - Run `HelpStrip.audit()` in console → returns empty array (no leftover title tooltips).

### Backend smoke (minimal, since UI-only)

- `GET /health` returns 200 — no backend change broke server.
- Optional: `POST /ops/transmute` with `/tmp/teste.mp4` still works (regression check).

## Out of scope / Follow-ups

- **Value history graph** in help strip (like FL Studio shows waveform) — future.
- **Rich markdown / links** in help text — keep plain text for v1; could allow `<code>` later.
- **User-customizable help text** / i18n — future.
- **Click to pin help** / copy help — nice-to-have later, add `data-help-persist` for now.
- **Help search palette (Cmd+/)** — separate spec.
- **Audio preview of control** — no.

Follow-up ticket: audit all existing tabs for quality of help copy — second pass by human for tone.

## Risks

- **Grepping title=**: some `title=` may be legit (SVG `<title>` for icons, `<img title>`). Distinguish: only strip from interactive controls under `#main-content`. Keep for media preview `img` alt fallback? Prefer `aria-label`.
- **Layout grid assumption**: current `layout.css` may not use grid — if flex, need to retrofit bottom row without breaking existing height calculations. Must browser-click before claiming DONE (per AGENTS.md #12).
- **Knob bank overlay (`8.090`)**: dice icon is `position:absolute` overlapping seed knob — ensure `z-index` and hit test still routes hover to dice, not underlying knob. Test dice hover specifically.
- **Performance of delegated listener**: if `mouseover` attached to document, could fire too often — scope to `#main-content` only.
- **Touch devices**: hover doesn't exist — ensure tap-to-show doesn't conflict with existing click handlers (use `pointerenter` fallback).
- **Existing docs**: external-design-brief §6 says shared UI widgets prefer reuse — this creates new widget, but justified as global, not per-tab.

## Builder checklist (copy-paste)

- [ ] Add `#help-strip` element in `index.html` bottom row, grid-column 2
- [ ] Style in `layout.css` (or new file): 40px, two lines, ellipsis, dark theme matching `#2b2a38` panel boxes (`8.092`)
- [ ] Create `js/ui/help-strip.js` with init/register/setIdle/audit
- [ ] Init in `main.js`
- [ ] Migrate all `title=` in tabs/pool/knobs to `data-help-title` + `data-help-text`
- [ ] Register dynamic knobs with `getDynamicText`
- [ ] Idle text when nothing hovered
- [ ] Playwright proof: hover updates, no title left, zero console errors, no layout jump
- [ ] Update `docs/STATUS.md` top box + bump VERSION far-right DD
- [ ] Screenshot of strip in hover + idle states → `mtapi-project/junk/`

---
*Pattern refs: FL Studio Hint Bar (bottom help strip, always visible), GIMP status bar tooltip area, Ableton Live Info View, Blender Status Bar — all use fixed bottom area instead of popup tooltips.*
