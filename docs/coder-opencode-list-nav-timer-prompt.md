# Coder Prompt — Sticky Timer + List Keyboard / Scroll (OpenCode)

> **You are a Builder (OpenCode).** Read the spec and implement. Prefer Playwright browser verification.

## Spec (authoritative)

**`docs/ui-list-nav-timer-spec.md`**

## User pain (in order)

1. **No elapsed timer** while jobs run — make a **sticky** clock (status + dedicated chip + Run button). No new console line every second.
2. **Arrows** scroll the page / jump form focus instead of stepping list items. After clicking an image/clip in a list, arrows must go prev/next and `preventDefault` page scroll.
3. **Sequence** is horizontal — **Left/Right** select clips (Up/Down map the same). **Ctrl+arrows** reorder.
4. Reorder buttons / Ctrl+arrows cause the list to **jump to the top** — keep the selected/moved item **scrolled into view**.

## Do this

1. Read `docs/ui-list-nav-timer-spec.md` fully.  
2. Implement timer visibility (§3), then list-keys + scroll (§4–5).  
3. Wire sequence + stills lists + pools as listed in the spec.  
4. Playwright: §7 acceptance tests.  
5. Bump `VERSION` far-right DD. Commit working steps.

## Key files

- `mtapi-project/app/static/js/job-control.js` — timer already partially there  
- `mtapi-project/app/static/js/ui/list-keys.js` — extend  
- `mtapi-project/app/static/js/tabs/imagesort.js` (+ facemorph, withoutbg, styletransfer)  
- `mtapi-project/app/static/js/pool/sequence.js`, `grid.js`, `image-pool.js`  
- `index.html` / layout CSS for `#jobTimer`

## Done when

Spec §9 checkboxes pass under Playwright.
