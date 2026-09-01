# Unified Join Frontend Spec — format dropdown + RIFE toggle + variant nodes

> **Status:** Spec (backend deps DONE: `/api/presets`, `/api/variants`, variant registry)
> **Companion specs:** `sequence_codec_export_spec_2.0.md` (target field),
> `sequence_rife_interpolation_spec.md` (use_rife/target_fps),
> `sequence_clip_variant_registry_spec.md` (variants).
> Backend verified: codec-export + RIFE + variant-registry shipped & simplify-passed.

## 1. Goal
One coherent frontend pass for the Join / Sequence composer that wires three
backend features the user explicitly wanted batched (they are intertwined):
- **Target Format** dropdown (codec export) — sends `target` to `/ops/join`.
- **RIFE toggle + target_fps** — sends `use_rife` + `target_fps` to `/ops/join`.
- **Variant nodes** — a clip in the Video Pool / Sequence shows its associated
  variants (original / rifed / export) and the user picks which one feeds the join.

All three consume the already-shipped endpoints. No new backend needed except
the optional `/api/variants` security restriction (tracked separately).

## 2. Files (verified to exist)
- `app/static/js/pool/persistence.js` — builds the `POST /ops/join` body (~line 570).
- `app/static/js/pool/grid.js` — Video Pool + Sequence card rendering (variant display lives here).
- `app/static/js/tabs/convert.js` — reference pattern for a preset dropdown
  (NOTE: it currently HARDCODES `PRESETS_BY_GROUP` at line 4; do NOT copy that
  anti-pattern — fetch `/api/presets` instead, per app/static/AGENTS.md §6.4).
- `app/static/js/tabs/imagesort.js` / `speedchange.js` — reference for `use_rife`
  / `target_fps` field wiring (already established UI pattern).
- `app/static/index.html` — nav / form mount points (only if new controls need a home).

## 3. Target Format dropdown (exact anchors)
Mount point: `app/static/js/pool/grid.js`, inside `_composeHtml()` (function at
line 396). The stitch panel already has `poolReconcile` / `poolAspect` / `poolOutput`
selects and `btnPoolStitch` (line 472). Insert the Target Format select RIGHT BEFORE
the `poolOutput` input-row block (after line 462, before line 467), mirroring the
existing label/select pattern:

```html
<label class="pool-opt-label" title="Export codec (DNxHR / ProRes / H.264 / …)">Format
  <select id="poolTarget">
    <option value="">Legacy H.264 (default)</option>
    <!-- options injected by JS from /api/presets -->
  </select>
</label>
```

Populate it in `_bindSequencePanel()` (function at line 268), alongside the existing
`poolReconcile`/`poolAspect` binds. Add a helper that fetches once and fills the
`<optgroup>`s (DO NOT hardcode — convert.js hardcodes PRESETS_BY_GROUP, that is the
anti-pattern; app/static/AGENTS.md §6.4 says use the backend):

```js
let JOIN_PRESETS = null;
async function fillJoinTargetOptions() {
  const sel = document.getElementById('poolTarget');
  if (!sel || sel.dataset.filled) return;
  if (!JOIN_PRESETS) {
    try { JOIN_PRESETS = await (await fetch('/api/presets')).json(); }
    catch { JOIN_PRESETS = {}; }
  }
  const groups = {};
  for (const [pid, ep] of Object.entries(JOIN_PRESETS)) {
    (groups[ep.group] ||= []).push(`<option value="${pid}" title="${(ep.blurb||'').replace(/"/g,'&quot;')}">${ep.label}</option>`);
  }
  sel.innerHTML = '<option value="">Legacy H.264 (default)</option>' +
    Object.entries(groups).map(([g, opts]) => `<optgroup label="${g}">${opts.join('')}</optgroup>`).join('');
  sel.dataset.filled = '1';
  sel.value = state.pool.target || '';
}
```

Call `fillJoinTargetOptions()` at the end of `_bindSequencePanel()`. Wire the change:
```js
document.getElementById('poolTarget')?.addEventListener('change', (e) => {
  state.pool.target = e.target.value || null;
  scheduleSavePoolState();
});
```
Restore from `state.pool.target` on render (the select's `value` is set in fillJoinTargetOptions above).

## 4. RIFE toggle + target_fps (exact anchors)
Same `_composeHtml()` mount: insert AFTER the `poolTarget` label block (before
`poolOutput`), a checkbox + number, mirroring the `poolReconcile` label style:

```html
<label class="checkbox-label" title="Interpolate low-fps clips to target_fps with RIFE before stitch">
  <input type="checkbox" id="poolUseRife"> RIFE interpolate
</label>
<label class="pool-opt-label" title="Exact output fps (RIFE overshoots to 2^k then resamples; max ~128× source)">RIFE fps
  <input type="number" id="poolTargetFps" min="1" step="1" placeholder="auto = max native" class="seq-clip-dur-input">
</label>
```

Wire in `_bindSequencePanel()` (after the poolTarget bind):
```js
document.getElementById('poolUseRife')?.addEventListener('change', (e) => {
  state.pool.useRife = e.target.checked;
  scheduleSavePoolState();
});
document.getElementById('poolTargetFps')?.addEventListener('input', (e) => {
  const v = parseFloat(e.target.value);
  state.pool.targetFps = (v > 0) ? v : null;
  scheduleSavePoolState();
});
```
Restore on render: set `poolUseRife.checked = !!state.pool.useRife` and
`poolTargetFps.value = state.pool.targetFps || ''` in `fillJoinTargetOptions()` (or a
small `restoreJoinOpts()` called from `_bindSequencePanel`). Fail-fast UX: if
`poolUseRife.checked` && `!poolTarget.value`, surface a hint "RIFE requires a target
format" (backend also errors, but catch early).

## 5. Variant nodes (exact anchors)
The variant registry associates original / rifed / export clips in the central cache.
Display them under each pool card. Mount point: `renderPoolGrid()` in grid.js (function
at line 644); the card `innerHTML` template is at lines 700-727. After the
`pool-card-info-btn` button (line 726) and before the closing backtick (line 727),
inject a variant sub-block:

```js
${await _variantNodeHtml(item.path)}
```
where `_variantNodeHtml` is a new async helper (module-level in grid.js):
```js
async function _variantNodeHtml(path) {
  let variants = {};
  try { variants = (await (await fetch(`/api/variants?path=${encodeURIComponent(path)}`)).json()).variants || {}; }
  catch { variants = {}; }
  const kinds = Object.keys(variants);
  if (!kinds.length) return '';
  const rows = kinds.map(kind => variants[kind].map(v => `
    <div class="variant-row${v.path && state.pool.selectedVariantPaths?.[path] === v.path ? ' selected' : ''}"
         data-variant-path="${v.path || ''}" data-variant-kind="${kind}">
      <span class="variant-kind">${kind}</span>
      ${v.detail ? `<span class="variant-detail">${Object.entries(v.detail).map(([k,val])=>`${k}=${val}`).join(' · ')}</span>` : ''}
    </div>`).join('')).join('');
  return `<div class="variant-node"><span class="variant-head">Variants</span>${rows}</div>`;
}
```
Note: `renderPoolGrid` is currently synchronous; make it `async` (or build the variant
HTML in a post-render pass) since `/api/variants` is a fetch. Check callers of
`renderPoolGrid()` — if any await it, just flip the signature; otherwise do the variant
fetch after `grid.appendChild(card)` per card (preferred: keeps the base card sync).
Click handling: in the card's click listener area (around line 729), add:
```js
card.querySelectorAll('.variant-row').forEach(r => r.addEventListener('click', (e) => {
  e.stopPropagation();
  const p = r.dataset.variantPath;
  if (!p) return;
  state.pool.selectedVariantPaths = state.pool.selectedVariantPaths || {};
  state.pool.selectedVariantPaths[path] = p;   // original path -> chosen variant path
  scheduleSavePoolState();
  renderPoolGrid();
}));
```
Default: if no variant selected for a clip, `input_paths` uses the original `item.path`
(see §6). Re-fetch variants after a stitch that registers one (the stitched output is
auto-added to pool at persistence.js:586; just call `renderPoolGrid()` again — already
done there).

## 6. Join body (final shape — exact edit)
File: `app/static/js/pool/persistence.js`. The body is built at lines 552-559:
```js
  const body = {
    input_paths: paths,
    mode,
    aspect,
    durations: anyTimed ? durations : null,
    output_path,
    dry_run: false,
  };
```
Replace `input_paths: paths` with variant-aware paths, and add the 3 new keys:
```js
  const selVar = state.pool.selectedVariantPaths || {};
  const input_paths = paths.map(p => selVar[p] || p);   // original, or chosen variant
  const body = {
    input_paths,
    mode,
    aspect,
    durations: anyTimed ? durations : null,
    target: state.pool.target || null,            // NEW
    use_rife: !!state.pool.useRife,                // NEW
    target_fps: state.pool.targetFps || null,      // NEW
    output_path,
    dry_run: false,
  };
```
All new keys nullable; legacy path (no target, use_rife false, no variant) is unchanged
and must still work. `paths` is the existing sequence path list (built just above line 552).

## 7. Verification (MANDATORY — browser, not curl)
Per app/static/AGENTS.md §7: use Playwright (MCP or local Chromium). No claim of
DONE from curl alone.
1. Hard-refresh WebUI. Global Video / Sequence = `/tmp/teste.mp4`.
2. Sequence/Join form shows: Target Format dropdown populated from /api/presets
   (dnxhr_hq, prores_hq, h264_avc present), RIFE checkbox + target_fps number.
3. Select `target = dnxhr_hq`, run join on two clips → output is `.mov` DNxHR,
   console shows no JS errors, response `ok:true`.
4. Check `use_rife`, `target_fps=60`, `target=h264_avc` → output 60fps, rifed
   variant appears under the clip card after refresh (GET /api/variants shows it).
5. Click the `rifed` variant row, re-join → `input_paths` contains the `_rifed.mov`
   path (verify via the logged POST body in console), output uses the rifed source.
6. Legacy: no target, use_rife off → identical to before, no new fields sent.

## 8. Constraints
- Vanilla ES6, zero-build. No React/npm/Tailwind (root AGENTS.md rule 4).
- Don't hardcode the preset list (single source of truth = /api/presets).
- Don't break dual-pool invariants (videos in state.pool, stills in state.imagePool).
- Don't touch backend (it's done). This is frontend-only.
- Keep the existing `use_rife`/`target_fps` patterns in other tabs untouched.
