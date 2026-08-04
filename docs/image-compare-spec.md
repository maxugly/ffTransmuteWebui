# Image Compare — Shared Dual-Image Viewer

> **Status:** Implemented (2026-07-31) · module `000.000.4.29` · **dedicated tab `000.000.4.68`**  
> **Audience:** Any tab that needs separate / overlay / A/B image comparison  
> **Consumers:** Cut (`js/tabs/cut.js`), Zoompan, **Image Compare tab** (`js/tabs/imgcompare.js`)  
> **Related:** `video-image-pools-spec.md` (Cut host wiring); Image Sort metrics via `imagesort_rank`

---

## 1. Purpose

Reusable **frame vs reference** (or any base vs overlay image) UI:

| Mode | Behavior |
|------|----------|
| **separate** | Host lays out images; module paints a single base image per viewport |
| **overlay** | Base + ref stacked (`object-fit: contain`); ref opacity 0–100 |
| **ab** | Wipe: left of handle = base, right = ref; drag on viewport or slider |

**No** knowledge of Cut, pools, frame range, or video. Hosts supply image URLs and own state.

---

## 2. Files

| Path | Role |
|------|------|
| `mtapi-project/app/static/js/ui/image-compare.js` | Module API |
| `mtapi-project/app/static/css/image-compare.css` | Toolbar + dual-layer styles |
| `mtapi-project/app/static/index.html` | Links `image-compare.css` |

---

## 3. State shape

```js
{
  mode: 'separate' | 'overlay' | 'ab',
  overlayOpacity: 50,  // 0–100
  abPosition: 50,      // 0–100 wipe handle from left
}
```

Helpers:

- `defaultCompareState()` → fresh defaults  
- `normalizeCompareState(obj)` → clamp in place; also accepts legacy `compareMode` and keeps it synced when present  

---

## 4. API (summary)

```js
import {
  COMPARE_MODES,
  defaultCompareState,
  normalizeCompareState,
  compareToolbarHtml,
  paintCompareView,
  paintSimpleImage,
  applyCompareVars,
  syncCompareToolbar,
  bindCompareControls,
} from '/js/ui/image-compare.js';
```

### Toolbar

```js
compareToolbarHtml({
  idPrefix: 'my',           // unique per host (ids: myCompareSlider, …)
  state: cmp,
  label: 'Compare',
  modeTitles: { /* optional overrides */ },
});
```

### Paint a viewport

Host element should be sized and `position: relative` (class `img-compare-viewport` helps).

```js
paintCompareView(el, {
  mode: cmp.mode,
  baseSrc: '/api/thumbnail?...',
  baseKey: 12,              // cache key (e.g. frame number)
  refSrc: '/api/thumbnail?...',
  opacity: cmp.overlayOpacity,
  ab: cmp.abPosition,
  baseLabel: 'Frame',
  refLabel: 'Ref',
  emptyMsg: 'No image',
  missingRefMsg: 'Load ref to compare',
  emptyClass: 'cut-frame-empty', // optional host empty style
});
```

### Bind controls

```js
const ctl = bindCompareControls({
  idPrefix: 'my',
  getState: () => normalizeCompareState(host.compare),
  setState: (partial) => Object.assign(host.compare, partial),
  getViewports: () => [document.getElementById('myView')],
  onModeChange: (mode) => reRender(),  // usually full host re-render
});
// later: ctl.destroy()
```

Opacity / A/B slider and drag update CSS vars live (`--img-compare-opacity`, `--img-compare-ab-pct`) without re-fetching images.

---

## 5. CSS classes / variables

| Class / var | Role |
|-------------|------|
| `.img-compare-bar` | Mode switch + slider row |
| `.img-compare-mode-btn` | Segmented 1/2/3 |
| `.img-compare-viewport` | Host box for layers |
| `.img-compare` + `.mode-overlay` / `.mode-ab` | Dual-layer stack |
| `.img-layer-base` / `.img-layer-ref` | Stacked images |
| `--img-compare-opacity` | 0–1 ref opacity (overlay) |
| `--img-compare-ab-pct` | Wipe handle `%` from left |

---

## 6. Host checklist (new consumer)

1. Own state: `{ mode, overlayOpacity, abPosition }` (or nest under a key).  
2. Unique `idPrefix` if multiple compares on one page.  
3. Sized viewport DOM + `img-compare-viewport`.  
4. Call `compareToolbarHtml` + `paintCompareView` + `bindCompareControls`.  
5. On mode change, re-render host layout if separate vs composite layout differs.  
6. Do **not** copy dual-layer CSS into tab CSS — extend `image-compare.css` only if the control itself needs a new feature.

---

## 7. Cut mapping (first consumer)

| Cut concern | How |
|-------------|-----|
| In frame | base of viewport `#cutFirstFrame` |
| Out frame | base of `#cutLastFrame` |
| Ref A / B | `refSrc` for In / Out |
| Layout | Cut still owns cards, ref pool/browse buttons, grid |
| State | `state.cut.mode` (+ legacy `compareMode` alias) |

See `docs/video-image-pools-spec.md` §2.3 / §5.

---

## 8. Image Compare tab (`4.68`)

Dedicated host under Library sidebar → **Compare** (`data-tab="imgcompare"`).

| Concern | How |
|---------|-----|
| Paths | `state.imgCompare.pathA` / `pathB` (browse, pool, global image soft-fill) |
| View modes | Shared toolbar + viewport (`idPrefix: ic`) |
| AR | Stage sets `--ic-ar` from natural image dims; layers use `object-fit: contain` |
| Rate | `POST /ops/imagesort_rank` with `[A, B]` + metric (pHash / aHash / colorhash / MSE / SSIM) |
| Run button | Hidden — interactive tool, not a long job |
| Image Pool | Send targets `compare_a` / `compare_b` |

---

## 8. Verification

1. Hard-refresh WebUI.  
2. Cut → load video + Ref A → **2 Overlay** → opacity changes stack without console errors.  
3. **3 A/B** → drag wipe on image and slider stay in sync.  
4. **1 Separate** → four cards again.  
5. No leftover `.cut-compare` / `--cut-ref-opacity` dependencies in new code.
