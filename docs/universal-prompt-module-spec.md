# Universal Prompt Module (Reusable SD Prompt Bar)

> **Status:** **Proposed** — not implemented
> **Audience:** Builder assigned this job
> **Builder prompt:** `coder-universal-prompt-module-prompt.md`
> **Related:** `prompt-library-spec.md`, `qr-illusion-art-spec.md`, `img2img-openvino-spec.md`, `fastsdcpu-upscalers-spec.md`, `AGENTS.md`
> **Kickoff (agy):** `coder-agy-universal-prompt-module-prompt.md`

---

## 1. Problem

Every SD-adjacent tab (`img2img`, `txt2img`, `upscale`, `qr`, `illusion`) duplicates the same prompt knobs: positive, negative, seed, strength, guidance/CFG, model, and a save/load affordance. `prompt-library.js` already saves ± pairs, but it has no concept of **style presets**, **per-field visibility**, or **model selection**. Each tab manually wires its own HTML + knobs + collect function, so a parameter rename or a new shared knob requires touching five files. Non-SD tabs (e.g., a future Google Veo tab) that only need a positive prompt cannot reuse anything.

## 2. Goals / non-goals

**Goals**

* One **shared module** (`universalPromptBar`) that renders all common SD prompt fields.
* Each tab declares a **capability set** (`prompt`, `negative`, `seed`, `strength`, `guidance`, `model`, `style`); fields the tab does not list are **not rendered**.
* Existing `prompt-library.js` save/load is preserved and **merged** into the bar as a `[+]` save button + preset dropdown adjacent to the positive text box.
* A **Style** dropdown is supported, but only when styles are true **prewritten prompt bundles** (positive + negative + defaults). If the current style value is a plain prompt, the Style field is **hidden** and the preset dropdown is the only style surface.
* **Model selection** is part of the bar so every SD tab shares one model registry.
* The bar exposes a **collect function** that returns a normalized params object for the tab's `collectBody`.
* The bar can be used for **non-SD APIs** with a minimal capability set (e.g., `prompt` only for Veo).

**Non-goals (v1)**

* Cloud / CivitAI model downloading.
* Style files authored outside the browser (import/export JSON for styles → v1.1).
* Prompt weighting / emphasis syntax parsing.
* Server-backed prompt library (still `localStorage`).

## 3. Locked decisions

| Decision | Selection | Notes |
|----------|-----------|-------|
| **Module file** | `mtapi-project/app/static/js/ui/universal-prompt-bar.js` | New file; replaces per-tab prompt HTML + library attach |
| **Legacy library** | `prompt-library.js` stays, but `universalPromptBar` **wraps** it | Existing tabs can migrate one by one; old file removed only when no tab uses it |
| **Style storage** | `localStorage` key `mtapi_prompt_styles` | Separate from `mtapi_prompt_library` |
| **Style data model** | Same schema as prompt library entries, plus `fields` overrides | Allows a style to override defaults for `steps`, `guidance`, `strength`, etc. |
| **Conditional fields** | Tab passes `fields: ['prompt', 'negative', 'seed', 'strength', 'guidance', 'model', 'style']` | Missing fields = not rendered |
| **Model registry** | Single JSON file `mtapi-project/app/static/js/ui/sd-model-registry.js` | Exports `SD_MODELS` array; tabs pick subsets |
| **Preset [+] location** | Immediately right of the positive prompt input | Same row, compact |
| **Drop style when prompt** | If a loaded style's `positive` is identical to a plain preset's `positive`, the Style `<select>` is hidden | User sees only presets; editing is free-form |
| **Non-SD usage** | Pass `fields: ['prompt']` (or any subset) | Bar renders only what is asked for |
| **Collect output** | Returns a flat JS object keyed by standard SD names (`prompt`, `negative_prompt`, `seed`, `strength`, `guidance_scale`, `model_id`, `style`) | Tab's `collectBody` spreads or maps this into its API payload |
| **Knob reuse** | Uses existing `setupContinuousKnob` / `setupBinaryKnob` / `knobUnitHtml` from `js/ui/knobs.js` | No new knob framework |
| **Seed field** | Always a text input (blank = random). Converted to `null` in collect if blank | Consistent across tabs |
| **Guidance vs CFG** | Label is `Guidance` (existing convention). API field is `guidance_scale` | Do not rename existing API field |
| **Dry run** | Not part of the universal bar (tab-specific) | Tabs keep their own dry-run UI |

## 4. Data models

### 4.1 Style entry (`localStorage['mtapi_prompt_styles']`)

```json
[
  {
    "id": "st_20260825_001",
    "name": "Photoreal portrait",
    "positive": "photorealistic portrait, sharp focus, 8k, studio lighting, masterpiece",
    "negative": "blurry, low quality, distorted, ugly, watermark, text",
    "created_at": "2026-08-25T00:00:00.000Z",
    "updated_at": "2026-08-25T00:00:00.000Z",
    "overrides": {
      "steps": 30,
      "guidance": 7.5,
      "strength": 0.4,
      "model_id": "rupeshs/sd-turbo-openvino"
    }
  }
]
```

| Field | Rule |
|-------|------|
| `id` | Same scheme as prompt library |
| `name` | Trimmed, 1–80 chars |
| `positive` / `negative` | Strings; max 4000 chars |
| `overrides` | Optional partial object; keys are subset of `{steps, guidance, strength, model_id, width, height}`. Unknown keys ignored on load. |
| `created_at` / `updated_at` | ISO-8601 |

**Seed rule:** Seed **only** when `getItem` returns `null` / `undefined`. Empty array `[]` after user deleted everything = **do not** re-seed.

### 4.2 Model registry (`sd-model-registry.js`)

```javascript
export const SD_MODELS = [
  { id: 'rupeshs/sd-turbo-openvino', label: 'SD Turbo OpenVINO (default)', tags: ['txt2img', 'img2img', 'qr', 'illusion', 'riferecohere'] },
  { id: 'rupeshs/LCM-dreamshaper-v7-openvino', label: 'LCM Dreamshaper v7 OpenVINO', tags: ['txt2img', 'img2img', 'riferecohere'] },
  { id: 'rupeshs/sd15-lcm-square-openvino-int8', label: 'SD 1.5 LCM Square INT8 (OV)', tags: ['txt2img', 'img2img', 'riferecohere'] },
  { id: 'runwayml/stable-diffusion-v1-5', label: 'SD 1.5 (PyTorch, slow)', tags: ['qr', 'illusion'] },
  { id: 'OpenVINO/stable-diffusion-v1-5-int8', label: 'SD 1.5 INT8 (OV)', tags: ['qr'] },
];
```

Tabs pass a `modelTags` filter (e.g., `['txt2img', 'img2img']`) and the bar renders only matching models. If a tab passes no filter, all models are shown.

## 5. Module API

`mtapi-project/app/static/js/ui/universal-prompt-bar.js`:

```javascript
/**
 * @param {object} opts
 * @param {HTMLElement} opts.containerEl - inject the bar here
 * @param {string[]} opts.fields - subset of ['prompt','negative','seed','strength','guidance','model','style']
 * @param {string[]} [opts.modelTags] - filter SD_MODELS by tag
 * @param {object} [opts.defaults] - initial values for fields
 * @param {object} [opts.knobRanges] - override min/max/step for strength/guidance
 * @returns {{ el: HTMLElement, collect: () => object|null, setField: (k,v) => void }}
 */
export function universalPromptBar({ containerEl, fields, modelTags, defaults, knobRanges }) {}
```

**Return value:**

| Property | Type | Purpose |
|----------|------|---------|
| `el` | `HTMLElement` | The rendered bar; tab inserts into its form |
| `collect` | `function()` | Reads current state, returns normalized params object or `null` if validation fails |
| `setField` | `function(key, value)` | Programmatically set a field (e.g., tab prefill) |

**Internal helpers (not exported):** `_loadStyleStore`, `_saveStyleStore`, `_ensureStyleSeeded`, `_loadPromptStore`, `_savePromptStore`, `_buildPromptBar`, `_buildStyleBar`, `_renderFields`, `_attachKnobs`, `_collectField`.

### 5.1 Field rendering rules

The bar renders fields **in this order**, skipping any not in `fields`:

1. **Style** (`<select>`) — only if `fields.includes('style')`
2. **Prompt** (`<textarea>` or `<input type="text">` depending on `opts.multiline`) — always if `fields.includes('prompt')`
3. **Preset [+] + dropdown** — immediately right of Prompt on the same row
4. **Negative** (`<input type="text">`) — if `fields.includes('negative')`
5. **Seed** (`<input type="text">`) — if `fields.includes('seed')`
6. **Strength** (knob) — if `fields.includes('strength')`
7. **Guidance** (knob) — if `fields.includes('guidance')`
8. **Model** (`<select>`) — if `fields.includes('model')`

If `fields` does not include `style`, the preset dropdown is the **only** style surface and sits directly to the right of the prompt input.

### 5.2 Style vs preset collapsing

When a style is selected:
* Its `positive` fills the prompt field.
* Its `negative` fills the negative field (if present).
* Its `overrides` are applied to the matching knobs/inputs.

When the user edits any field after loading a style:
* The Style `<select>` is cleared (hidden if `fields` does not contain `style`).
* The preset dropdown retains its value (it is a prompt-library preset, not a style).

If `fields` does not include `style` **and** the prompt text exactly matches a prompt-library preset's positive, the preset dropdown auto-selects that preset. This is a UI hint only; the user can still edit freely.

### 5.3 Knob ranges

Default ranges (overridable per tab via `opts.knobRanges`):

| Knob | Min | Max | Step | Default | Decimals |
|------|-----|-----|------|---------|----------|
| `strength` | 0.05 | 0.95 | 0.01 | 0.35 | 2 |
| `guidance` | 0.0 | 8.0 | 0.1 | 1.0 | 1 |

`upscale` and `qr` tabs pass their own ranges (e.g., guidance 5–15).

## 6. Tab integration (v1 locked)

| Tab | `fields` | `modelTags` | Notes |
|-----|----------|-------------|-------|
| `txt2img` | `['prompt','negative','seed','strength','guidance','model','style']` | `['txt2img','img2img']` | Style enabled; full bar |
| `img2img` | `['prompt','negative','seed','strength','guidance','model','style']` | `['txt2img','img2img']` | Style enabled; full bar |
| `riferecohere` | `['prompt','negative','seed','strength','guidance','model','style']` | `['txt2img','img2img']` | Style enabled; full bar |
| `qr` | `['prompt','negative','seed','strength','guidance','model','style']` | `['qr','illusion']` | Style enabled; full bar |
| `illusion` | `['prompt','negative','seed','strength','guidance','model','style']` | `['qr','illusion']` | Style enabled; full bar (QR-specific knobs like Ctrl Scale / IP Scale remain tab-owned) |
| `upscale` | `['prompt']` | `[]` | Only prompt; no style, no knobs, no model (or tab-owned engine/model) |
| `veo` (future) | `['prompt']` | `[]` | Minimal: positive prompt only |

### 6.1 Tab migration pattern

Each tab's `render*Form` function becomes:

```javascript
import { universalPromptBar } from '/js/ui/universal-prompt-bar.js';

function renderTxt2ImgForm() {
  const bar = universalPromptBar({
    containerEl: null, // we will insert manually
    fields: ['prompt','negative','seed','strength','guidance','model','style'],
    modelTags: ['txt2img','img2img'],
    defaults: { prompt: '', negative: '', seed: '', strength: '0.35', guidance: '1.0', model_id: 'rupeshs/sd-turbo-openvino' },
    knobRanges: { strength: { min: 0.05, max: 0.95, step: 0.01, decimals: 2 }, guidance: { min: 0, max: 8, step: 0.1, decimals: 1 } },
  });

  var html = `
    <div class="panel-title-desc dense">
      <h3>Txt2Img · OpenVINO (GPU)</h3>
      <p class="dream-hint">...</p>
    </div>
    ${bar.el.outerHTML}
    <div class="form-row">
      <label for="t2iOutput">Output</label>
      ...
    </div>
    ... rest of tab ...
  `;
  elements.actionPanel.innerHTML = html;

  // Re-bind bar to the now-mounted DOM elements
  var boundBar = universalPromptBar({
    containerEl: document.getElementById('t2iPromptBar'),
    fields: ['prompt','negative','seed','strength','guidance','model','style'],
    modelTags: ['txt2img','img2img'],
    defaults: { ... },
    knobRanges: { ... },
  });

  document.getElementById('btnT2iBrowseOut')?.addEventListener('click', ...);

  function collectTxt2ImgBody() {
    var barParams = boundBar.collect();
    if (!barParams) return null;
    return {
      ...barParams,
      output_path: ...,
      width: ...,
      height: ...,
      count: ...,
      dry_run: ...,
    };
  }
}
```

**Why two calls:** The first generates HTML string (`outerHTML`). The second binds events to the live DOM. This matches the existing tab pattern of building a string then inserting it.

## 7. Prompt library integration

`universalPromptBar` internally imports `prompt-library.js` and calls its save/load helpers against the same `localStorage` key `mtapi_prompt_library`. The preset dropdown and `[+]` button replace the old `attachPromptLibrary` toolbar.

**Behavior parity with v1 prompt library:**

| Action | Behavior |
|--------|----------|
| **[+] Save** | `prompt('Name')`; validates; overwrite `confirm` if name exists; writes positive + negative (and current knob values as style overrides if Style field is present) |
| **Load preset** | Fills positive, negative, and any visible knob fields from the saved entry |
| **Active label** | If current fields exactly match a preset, show its name inline |
| **Dirty** | Any `input` on a tracked field → if no longer exact match, clear active name and preset selection |
| **Delete** | If preset selected, `confirm` then remove |
| **200 limit** | Block new saves (overwrites still OK) |

## 8. Style management

### 8.1 Save style

When the Style field is visible, the `[+]` button shows a **duplicate** action in a small context menu:

* **Save as preset** — saves positive + negative + knob values to prompt library (existing behavior).
* **Save as style** — saves the same bundle to `mtapi_prompt_styles` with the current knob values as `overrides`.

If the user saves as a style, the Style dropdown updates to include the new entry.

### 8.2 Load style

* Selecting a style from the dropdown populates all visible fields from the style's `positive`, `negative`, and `overrides`.
* The preset dropdown is cleared (they are independent namespaces).
* Editing any field clears the style selection (style becomes "custom").

### 8.3 Delete style

* Right-click or a small trash icon on the style dropdown removes the style after `confirm`.
* Deleting a style does **not** affect prompt-library presets.

## 9. Validation & edge cases

| Case | Behavior |
|------|----------|
| Empty positive prompt | `collect()` returns `null`; tab shows its own alert |
| Tab passes no `fields` | Bar renders nothing; returns empty `collect()` object |
| `modelTags` empty or no match | Model `<select>` renders with a single `—` placeholder; `collect()` sets `model_id: null` |
| Knob range overrides invalid | Fall back to defaults; `console.warn` |
| `localStorage` throws on style save | `alert`; do not crash tab |
| Style overrides key unknown | Ignore silently; do not pollute payload |
| Preset and style both match current text | Preset dropdown wins (style dropdown is already cleared on edit) |
| Tab re-render (switch away and back) | Fresh `universalPromptBar` call; prompt library state persists in `localStorage` |

## 10. Files to touch

| Path | Action |
|------|--------|
| `docs/universal-prompt-module-spec.md` | **NEW** — this file |
| `mtapi-project/app/static/js/ui/universal-prompt-bar.js` | **NEW** |
| `mtapi-project/app/static/js/ui/sd-model-registry.js` | **NEW** |
| `mtapi-project/app/static/js/ui/prompt-library.js` | No removal yet; remains until all tabs migrate |
| `mtapi-project/app/static/js/tabs/txt2img.js` | Migrate to `universalPromptBar` |
| `mtapi-project/app/static/js/tabs/img2img.js` | Migrate to `universalPromptBar` |
| `mtapi-project/app/static/js/tabs/riferecohere.js` | Migrate to `universalPromptBar` |
| `mtapi-project/app/static/js/tabs/qr.js` | Migrate to `universalPromptBar`; keep QR/Illusion-specific knobs (Ctrl Scale, IP Scale) tab-owned |
| `mtapi-project/app/static/js/tabs/upscale.js` | Migrate to `universalPromptBar` with `fields: ['prompt']` |
| `docs/STATUS.md` | Update on ship |
| Root `VERSION` | Bump DD on ship |

No Python / no OpenAPI changes for v1.

## 11. Verification (WebUI)

1. **Txt2img:** full bar renders; style dropdown present; save preset → appears in dropdown; save style → appears in style dropdown.
2. **Img2img:** load preset → prompt + negative + strength/guidance filled; edit prompt → style clears, preset clears.
3. **QR:** bar renders; model list filtered to QR/Illusion tags; Ctrl Scale and IP Scale remain visible below the bar (tab-owned).
4. **Illusion:** same as QR; pattern/appearance rows still visible (tab-owned).
5. **Upscale:** only positive prompt + preset `[+]` renders; no knobs, no model, no style.
6. **Style override:** create style "Fast 4-step" with `steps: 4, guidance: 1.0, strength: 0.35`; load it → knobs update.
7. **F5:** presets and styles survive in `localStorage`.
8. **Collect:** `bar.collect()` returns `null` on empty prompt; tab alerts correctly.
9. **Console:** zero errors across all five migrated tabs.

**Claim DONE only after WebUI path** (root `AGENTS.md` §D).

## 12. Conflicts with other docs

* `prompt-library-spec.md` — v1 library is unchanged in behavior; `universalPromptBar` is a superset that reuses the same storage key. No conflict.
* `qr-illusion-art-spec.md` — QR/Illusion-specific inputs (Pattern, Appearance, Reference Image, QR Data, Ctrl Scale, IP Scale) remain tab-owned. The universal bar only covers the common prompt subset.
* `AGENTS.md` invariants — no second dump/encode stack introduced; no subprocess in frontend JS; vanilla HTML/CSS/ES6 only.

## 13. Out of scope / later

* Import/export styles as JSON files.
* Cloud-hosted style library.
* Prompt embeddings / textual inversion / LoRA selectors.
* Auto-suggest styles from prompt content.
* Server-side style caching.
