# Scripts Tab Spec

## Overview

A new top-level tab under **Transmutations** (or its own section) that provides a **script runner** UI — a dropdown to select from a user-provided catalog of scripts, each with its own dynamically rendered control panel. Modeled on the **Single-Clip Ops** pattern in `transmute.js` but generalized for arbitrary backend operations.

**Key constraints:**
- **One global input only** — uses existing `window.globalInputs` (video, image, pathIn, pathOut). No second input field in the tab.
- **Multi-input scripts** (2+ inputs) get additional file choosers rendered inline; single-input scripts use the global input.
- **Zero duplication** — share the knob/form infrastructure, `FLIP_ROTATE_MODES`, `knobUnitHtml`, `setupContinuousKnob`, `setupBinaryKnob`, and the global input system.
- **Backend-agnostic** — the tab only knows how to POST JSON to `/ops/scripts/run` (or similar); script definitions live server-side.

---

## 1. Tab Registration

### 1.1 Nav entry (index.html)

Add under **Transmutations** section (or new **Scripts** section):

```html
<div class="nav-section" data-section="scripts">
  <div class="nav-header" role="button" tabindex="0" aria-expanded="true" aria-controls="nav-items-scripts">
    <svg class="nav-chevron" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="6 9 12 15 18 9"/>
    </svg>
    <span class="nav-header-label">Scripts</span>
  </div>
  <div class="nav-section-items" id="nav-items-scripts">
    <div class="nav-item" data-tab="scripts">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9 18V5l12-2v13"/>
        <circle cx="6" cy="18" r="3"/>
        <path d="M18 16a6 6 0 0 0-6-6"/>
      </svg>
      Script Runner
    </div>
  </div>
</div>
```

### 1.2 Tab switch (app.js)

- Add `'scripts'` to `switchTab()` render branch.
- Import `renderScriptsForm` from `/js/tabs/scripts.js`.
- Set `TAB_ACCEPTS.scripts = 'any'` (scripts declare their own input needs).
- Add `'scripts'` to `FRAME_RANGE_TABS` only if any script opts in (see §3.2).

---

## 2. Script Catalog (Server-Side)

### 2.1 Source of truth

A JSON file on disk (e.g. `mtapi-project/scripts/catalog.json`) or a directory of `.json` files. Each entry:

```json
{
  "id": "my_script",
  "label": "My Custom Script",
  "description": "Does something cool with video",
  "category": "geometry",              // optional grouping
  "input_mode": "single",              // "single" | "multi" | "none"
  "accepts": "video",                  // "video" | "image" | "any" | "none" (maps to TAB_ACCEPTS)
  "uses_frame_range": false,           // if true, global frame range row shows
  "parameters": [                      // control definitions
    {
      "name": "quality",
      "type": "knob",                  // "knob" | "select" | "text" | "binary" | "file"
      "label": "Quality",
      "min": 2, "max": 31, "step": 1, "decimals": 0,
      "default": "2",
      "legend": "PNG quality 2–31 (lower = better)."
    },
    {
      "name": "mode",
      "type": "select",
      "label": "Mode",
      "options": [
        { "value": "fast", "label": "Fast" },
        { "value": "quality", "label": "Quality" }
      ],
      "default": "fast"
    },
    {
      "name": "extra_input",
      "type": "file",
      "label": "Overlay video",
      "accept": "video",
      "required": true
    }
  ],
  "endpoint": "/ops/my_script",        // backend route to POST to
  "method": "POST",
  "dry_run_param": "dry_run"           // parameter name for dry-run flag
}
```

### 2.2 Catalog API

```
GET /api/scripts/catalog
→ { "scripts": [ {id, label, description, category, input_mode, accepts, uses_frame_range, parameters, endpoint, dry_run_param }, ... ] }
```

The frontend fetches this on tab load (or caches in `state.scripts.catalog`).

---

## 3. Frontend: `js/tabs/scripts.js`

### 3.1 State

```js
let activeScriptId = null;
let scriptCatalog = [];  // populated from /api/scripts/catalog
```

### 3.2 Render flow

```
renderScriptsForm()
  ├─ fetch catalog (if not cached)
  ├─ build dropdown <select id="scriptSelect"> from catalog
  ├─ render global input reminder (read-only display of current global input)
  ├─ render dry-run knob (shared)
  └─ call updateScriptExtras() for active script
```

### 3.3 `updateScriptExtras()`

Clears `#scriptExtras` and rebuilds controls from `script.parameters[]`:

| param.type | Rendered as | Notes |
|------------|-------------|-------|
| `knob` | `knobUnitHtml({...})` + `setupContinuousKnob()` | min/max/step/decimals from spec |
| `binary` | `knobUnitHtml({binary:true, leftCap, rightCap})` + `setupBinaryKnob()` | |
| `select` | `<select>` with `<option>` from `options[]` | |
| `text` | `<input type="text">` | |
| `file` | `<input type="text" data-clearable> + Browse button` | **Only for `input_mode: "multi"` scripts**; single-input scripts use global input |

**File inputs:** When `input_mode === "multi"` and a parameter has `type: "file"`, render an inline file chooser (reuse `openFileBrowser`). Single-input scripts (`input_mode: "single"`) **never** render a file chooser — they consume `bestInput()` from global.

### 3.4 Collect & Run

```js
function collectScriptBody(scriptDef) {
  const body = { dry_run: document.getElementById('scriptDryRun').value === '1' };
  
  // Single-input: pull from global
  if (scriptDef.input_mode === 'single') {
    body.input_path = bestInput();
  }
  
  // Multi-input: pull from rendered file fields + global for primary
  if (scriptDef.input_mode === 'multi') {
    scriptDef.parameters
      .filter(p => p.type === 'file')
      .forEach(p => {
        const val = document.getElementById(`scriptParam_${p.name}`)?.value.trim();
        if (val) body[p.name] = val;
      });
    // Primary input still from global if not explicitly provided
    if (!body.input_path) body.input_path = bestInput();
  }
  
  // All other parameters
  scriptDef.parameters
    .filter(p => p.type !== 'file')
    .forEach(p => {
      const el = document.getElementById(`scriptParam_${p.name}`);
      if (el) body[p.name] = el.value;
    });
  
  // Frame range if script opts in
  if (scriptDef.uses_frame_range) {
    Object.assign(body, globalFrameRange());
  }
  
  return body;
}
```

### 3.5 Run handler

```js
async function runScript() {
  const scriptDef = scriptCatalog.find(s => s.id === activeScriptId);
  if (!scriptDef) return;
  
  const body = collectScriptBody(scriptDef);
  if (!body.input_path && scriptDef.accepts !== 'none') {
    alert('No input selected. Use the global Video/Image inputs.');
    return;
  }
  
  setRunUiBusy(true);
  logConsole(`[SCRIPT]: POST ${scriptDef.endpoint}\n${JSON.stringify(body, null, 2)}`);
  
  try {
    const res = await fetch(scriptDef.endpoint, {
      method: scriptDef.method || 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    displayOpResult(data);
  } catch (err) {
    logConsole(`[SCRIPT ERROR]: ${err.message}`, 'error');
  } finally {
    setRunUiBusy(false);
    await checkHealth();
  }
}
```

---

## 4. Shared Resources (No Duplication)

| Resource | Location | Used by Scripts Tab |
|----------|----------|---------------------|
| `knobUnitHtml`, `setupContinuousKnob`, `setupBinaryKnob` | `js/ui/knobs.js` | ✅ |
| `FLIP_ROTATE_MODES`, `flipRotateOptionsHtml` | `js/utils.js` | ✅ (if a script uses flip/rotate) |
| `openFileBrowser` | `app.js` / `pool/chrome.js` | ✅ |
| `bestInput`, `allInputPaths`, `globalFrameRange` | `app.js` | ✅ |
| `displayOpResult`, `setRunUiBusy`, `runActiveOperation` | `job-control.js` | ✅ |
| Global inputs (`giVideo`, `giImage`, `giPathIn`, `giPathOut`) | `index.html` + `app.js` | ✅ (read-only display + consumption) |
| `data-clearable` + `makeClearable` | `js/ui/clearable.js` | ✅ |

---

## 5. Backend Contract (Minimal)

### 5.1 Catalog endpoint

```
GET /api/scripts/catalog
```

Returns the array of script definitions (§2.1).

### 5.2 Script execution endpoints

Each script defines its own `endpoint` (e.g. `/ops/my_script`). The backend implements these as normal FastAPI routes. The contract:

- **Request:** JSON body with `input_path`, `dry_run`, and any parameters from the catalog.
- **Response:** Same as other ops — `{ ok: true, output_path?, ... }` or `{ ok: false, error: ... }` with HTTP 200.

### 5.3 Script storage (optional)

If users need to add scripts via UI later, add:
- `POST /api/scripts/catalog` — add/update a script definition
- `DELETE /api/scripts/catalog/{id}` — remove

**V1 scope:** Read-only catalog from disk. UI management is a follow-up.

---

## 6. UX Details

### 6.1 Global input reminder

At top of form (below dropdown), show a compact read-only line:

```
Current input: [Video: /path/to/clip.mp4]  (click to change → global inputs panel)
```

Updates reactively via `updateGlobalInputs()` (already fires on global input change).

### 6.2 Dry-run knob

Always present (shared with transmute/quick/advanced):

```html
<div class="knob-row">
  <div class="knob-bank">
    ${knobUnitHtml({ id: 'scriptDryRun', label: 'Dry run', value: '0', binary: true, leftCap: 'Run', rightCap: 'Dry' })}
  </div>
  <p class="knob-row-legend">Dry = print command only, no file written.</p>
</div>
```

### 6.3 Parameter legends

Each parameter can have a `legend` string → rendered as `<p class="knob-row-legend">` under its control (matches transmute pattern).

### 6.4 Categories (optional)

If `category` exists in catalog, group dropdown with `<optgroup label="Category">`.

### 6.5 Persistence

- Remember `activeScriptId` in `state.formState.scripts` (existing form-state capture/restore).
- Catalog cached in `sessionStorage` with 5-min TTL.

---

## 7. Integration Checklist

- [ ] Add nav item in `index.html` (§1.1)
- [ ] Add `scripts` to `TAB_ACCEPTS` and `FRAME_RANGE_TABS` in `app.js`
- [ ] Add `renderScriptsForm` import + switch branch in `app.js`
- [ ] Create `js/tabs/scripts.js` with render/collect/run logic
- [ ] Add `/api/scripts/catalog` endpoint in FastAPI (reads `scripts/catalog.json`)
- [ ] Add example script definitions in `mtapi-project/scripts/catalog.json`
- [ ] Playwright proof: select script → controls render → dry-run → real run → output appears in pool

---

## 8. Future Extensions (Not in V1)

- **Script editor UI** — create/edit catalog entries in-browser
- **Script chaining** — multi-step pipelines
- **Parameter presets** — save/load per-script parameter sets
- **Script marketplace** — import from URL/GitHub

---

## 9. Files to Create / Modify

| File | Action |
|------|--------|
| `docs/scripts-tab-spec.md` | This spec |
| `mtapi-project/app/static/index.html` | Add nav item |
| `mtapi-project/app/static/app.js` | Register tab, TAB_ACCEPTS, FRAME_RANGE_TABS |
| `mtapi-project/app/static/js/tabs/scripts.js` | **New** — main tab module |
| `mtapi-project/app/routes/scripts.py` | **New** — `/api/scripts/catalog` endpoint |
| `mtapi-project/scripts/catalog.json` | **New** — example catalog |
| `mtapi-project/app/main.py` | Include scripts router |

---

## 10. Example Catalog Entry (for testing)

```json
{
  "id": "example_trim",
  "label": "Example: Trim + Fade",
  "description": "Trim video to frame range and add fade in/out",
  "category": "Editing",
  "input_mode": "single",
  "accepts": "video",
  "uses_frame_range": true,
  "parameters": [
    { "name": "fade_in", "type": "knob", "label": "Fade in (s)", "min": 0, "max": 5, "step": 0.1, "decimals": 1, "default": "0.5", "legend": "Seconds to fade in from black." },
    { "name": "fade_out", "type": "knob", "label": "Fade out (s)", "min": 0, "max": 5, "step": 0.1, "decimals": 1, "default": "0.5", "legend": "Seconds to fade out to black." }
  ],
  "endpoint": "/ops/example_trim",
  "dry_run_param": "dry_run"
}
```