# UI Density Standard

> **Purpose:** one visual scale across all tabs. The reference density is the
> Sequence options strip and the Pan & Zoom coordinate strips — flat text +
> compact controls, wrapping only between controls, never inside one.
> New UI must match this; old UI migrates to it opportunistically.

## 1. Type scale (root 16px)

| Use | Size | Example |
|-----|------|---------|
| Tab title (`h3`) | `0.88rem` (14px) | `.panel-title-desc.dense h3` |
| Tab description | `0.70–0.75rem` (11–12px) | `.panel-title-desc.dense p` |
| Control labels | `0.72–0.78rem` | `.pool-opt-label`, `.zp-params-row label` |
| Control values / inputs | `0.72–0.78rem` | selects, number inputs |
| Mono meta (paths, counts, coords) | `0.68–0.75rem`, `Fira Code` | `.seq-clip-settings-hint`, `.zp-box-nums` |

Never use `≥0.9rem` for tab chrome. Exceptions (deliberate only): media
viewport empties, score readouts, editor text areas, popover titles.

## 2. Control heights

| Control | Height | Padding |
|---------|--------|---------|
| Text / number / select | 24–27px | `3–4px 6–8px` |
| Buttons (default / small) | 24–26px | `4px 8–10px` |
| Mini (chips, toggles-in-row) | 20–22px | `2–4px 6–10px` |
| Coordinate / mono inputs | ~21px | `2px 4px` |

Keep every control on a filter/option row at the same height band.

## 3. Gaps

| Context | Gap |
|---------|-----|
| Sections in a tab workspace | `8–10px` |
| Items in a wrapping option row | `4px` row / `8px` column |
| Label ↔ its control | `4px` |
| Card padding | `6–8px` |

## 4. Wrap rules

1. Each label + its control is one glued unit (`inline-flex` +
   `white-space: nowrap`). Rows wrap **between** controls, never inside one.
2. Option rows are `flex-wrap: wrap` with `min-width: 0` — they spill to a
   new line only when horizontal space runs out.
3. The option container takes the full row (`flex: 1 1 100%`) when action
   buttons follow; buttons form their own row instead of squeezing the
   options into a narrow column with a void beside it (Sequence `8.116`).
4. No horizontal scroll: containers get `min-width: 0; max-width: 100%`;
   verify `scrollWidth === clientWidth` (see 8.109).

## 5. Long values

- Path displays: ellipsis (`overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap`), full value in `title`/`data-help-title`.
- Selects with long option text: `max-width: 160–180px` + ellipsis on the
  closed select; dropdown keeps full text.
- File names in panels: cap at ~180–260px with ellipsis.

## 6. Headers

Tab headers use `<div class="panel-title-desc dense">` (title `0.88rem`,
desc `0.70rem`). The non-dense variant exists for landing/help pages only —
never inside op tabs.

## 7. Verification (Builder law)

- `./check-gate.sh` green before any Playwright pass.
- Playwright: click the real controls, measure strip heights before/after,
  confirm `0px` horizontal overflow at full + narrow widths, zero new
  console errors. Proof screenshots go to `mtapi-project/junk/`.

## 8. Rollout status

- [x] Sequence options + Selected-clip strip (`8.116`)
- [x] Pan & Zoom tab (`8.117`)
- [ ] yt-dlp banks, Settings cards, Cut/Compare/Dart headers — converge on
      touch; all already within `0.70–0.82rem`, no fisher-price outliers
      found in the CSS audit (only deliberate exceptions: notes editor,
      compare score, pool info popover).
