# AGENTS.md — Static WebUI Frontend

> **Scope**: `mtapi-project/app/static`  
> **Audience**: Agents modifying WebUI, CSS, client JS.

---

## 1. Mission

Fast, dark, zero-build UI for configuring pipelines, convert/export, pool, and ops.

- **Vanilla** HTML5 / CSS3 / ES6 modules — no npm, React, Tailwind, bundlers.  
- REST: `/ops`, `/ops/{id}`, `/media/*`, `/health`, `/api/*`.  
- Absolute filesystem paths in all media fields.

---

## 2. Layout

```
static/
├── index.html           # Shell + sidebar nav (data-tab=…)
├── app.js               # Tab switch, global inputs, op fetch, run helpers
├── css/                 # base, layout, forms, pool, …
└── js/
    ├── tabs/            # One module per major tab
    │   ├── convert.js   # Convert / Export (codecs + frames_*)
    │   ├── transmute.js # Single-clip geometry / extract
    │   ├── rife.js
    │   ├── deepdream.js
    │   ├── watcher.js   # Batch DNxHR ingest (not Convert)
    │   └── …
    └── pool/            # Media pool grid, sequence, persistence
```

---

## 3. Product map (do not blur)

| Tab / area | Job |
|------------|-----|
| **Convert / Export** | Bookends only: ProRes/DNxHR/H.264/HEVC/WebM/AV1/FFV1, frames PNG/WebP/JPG/TIFF, GIF in |
| **Single-Clip Ops** | Geometry / first-last frame / reverse — **not** full sequence dump or codecs |
| **RIFE / DeepDream / …** | Named effect ops (server uses filter platform under the hood) |
| **Folder Watcher** | Auto folder → DNxHR LB + AR fit — batch ingest, not one-clip Convert |
| **Media Pool** | Library / sequence; may “send to” tabs |

Wordy labels and tooltips on Convert are intentional (AVC = H.264, etc.).

---

## 4. Front-end rules

1. **Absolute paths** in API bodies.  
2. API returns HTTP 200 with `ok: false` on op failure — surface `error` / `stderr`.  
3. Previews via `/media/file?path=…` / thumbs.  
4. New ops: prefer `js/tabs/<name>.js` + nav item in `index.html` + `switchTab` wiring in `app.js` — not a mega-dropdown dump into transmute.  
5. Convert targets come from product presets; do not invent ad-hoc codec knobs that bypass `convert_presets` without backend support.

---

## 5. WebUI testing — CRITICAL

**Must** use Playwright MCP (`mcp_mcp_browser_*`).

**Must not** use `web.run` / `web_search` / `web_extract` for localhost.  
**Must not** claim UI DONE from curl alone.

If Playwright is unavailable, stop and report — do not substitute.

---

## 6. Backend coupling (read-only context)

Effects on the server are moving to:

```text
dump → app/filters/* → encode
```

UI does not call dump/encode directly; it POSTs `/ops/{id}` or `/ops/convert` / `/ops/pipeline`. Prefer forms that match thin ops and Convert targets already registered.
