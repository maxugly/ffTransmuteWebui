# Coder Prompt — Timer + List UX + Pre-Run Summary (OpenCode)

> **You are a Builder (OpenCode).** Read the spec and implement. Prefer Playwright browser verification.

## Spec (authoritative)

**`docs/ui-list-nav-timer-spec.md`** (full document — timer, list keys, scroll, **pre-run summary**)

## User decisions (locked)

1. **Elapsed timer on the Process / Run button is good — keep it.** Harden so it always ticks. No per-second console spam.
2. **Pre-run QoL strip at the top of each tool form** (before Run / before long chrome): anything we can know for sure, print solidly (frames, duration). Estimates with `~` when probe-based. Warn styling when frame budget is short (Speed already has this idea — promote + generalize).
3. **Arrows** step the selected list (images/clips), not page scroll / random focus. **Sequence = Left/Right.** **Ctrl+arrows** reorder where order matters.
4. Reorder must **not** scroll the list back to the top — keep the moved item in view.

## Example (Image Sort)

User has 4 images, RIFE ×4, 24 fps → strip at top:

```text
4 keyframes · RIFE ×4 · 24 fps → ~16 frames · ~0.67 s
```

## Do this

1. Read `docs/ui-list-nav-timer-spec.md` fully (§3 timer, §4–5 keys/scroll, **§6 pre-run summary**).  
2. Harden Run-button timer.  
3. Add `.pre-run-summary` (+ helper) to Image Sort, Speed, RIFE, Face Morph first; expand to ramp/convert as time allows.  
4. List-keys + scroll-into-view for stills lists + sequence + pools.  
5. Playwright §8.  
6. Bump `VERSION` far-right DD. Commit working steps.

## Key files

- `job-control.js` — keep/harden Run elapsed  
- `ui/pre-run-summary.js` (new, recommended) + `forms.css`  
- `ui/list-keys.js`  
- `tabs/imagesort.js`, `speedchange.js`, `rife.js`, `facemorph.js`, …  
- `pool/sequence.js`, `grid.js`, `image-pool.js`

## Done when

Spec §10 acceptance criteria pass under Playwright.
