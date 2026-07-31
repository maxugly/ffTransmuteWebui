# AGENTS.md — Static WebUI Frontend

> **Scope**: `mtapi-project/app/static`  
> **Audience**: Agents modifying WebUI, CSS, client JS.  
> **Handoff (pools / Cut)**: repo `docs/video-image-pools-spec.md` (as-built).  
> **Frame range**: repo `docs/frame-range-spec.md`.

---

## 1. Mission

Fast, dark, **zero-build** UI for pipelines, convert/export, dual media libraries, and ops.

- **Vanilla** HTML5 / CSS3 / ES6 modules — no npm, React, Tailwind, bundlers.  
- REST: `/ops`, `/ops/{id}`, `/media/*`, `/health`, `/api/*`.  
- Absolute filesystem paths in all media fields.

---

## 2. Layout

```
static/
├── index.html              # Shell + sidebar nav (data-tab=…)
├── app.js                  # State, tab switch, global inputs, exports
├── css/                    # base, layout, forms, pool, …
└── js/
    ├── timeline.js         # Global probe + frame-range sliders + events
    ├── frame-scrubber.js   # Optional full-strip scrubber
    ├── job-control.js
    ├── preview.js
    ├── utils.js            # isVideoPath, isImagePath, globalFrameRange, withFrameRange
    ├── tabs/               # One module per major op tab
    │   ├── cut.js          # Cut workspace (global video + range + refs)
    │   ├── convert.js
    │   ├── rife.js
    │   ├── deepdream.js
    │   └── …
    └── pool/
        ├── constants.js    # VIDEO_EXTS, IMAGE_EXTS, zoom, tile fields
        ├── grid.js         # Video Pool + Sequence UI
        ├── image-pool.js   # Image Pool UI (stills only)
        ├── items.js        # Video import, send-to (incl. cut)
        ├── persistence.js  # Session + project JSON v2 (items + images)
        ├── sequence.js
        ├── chrome.js
        └── layout.js
```

---

## 3. Product map (do not blur)

| Tab / area | `data-tab` | Job |
|------------|------------|-----|
| Convert / Export | `convert` | Bookends only: codecs + frames_* dumps |
| Single-Clip Ops | `transmute` | Geometry / extract — not full codec suite |
| RIFE / DeepDream / … | various | Named effect ops |
| Folder Watcher | `watcher` | Auto folder → DNxHR batch ingest |
| **Video Pool** | `pool` | Video library (dual first/last thumbs); projects |
| **Image Pool** | `images` | Still library; cut refs / image ops |
| **Sequence** | `sequence` | Stitch composer (**videos only**) |
| **Cut** | `cut` | In/Out from **global** range + Ref A/B stills (no encode yet) |

**Word rule:** “Media Pool” is deprecated wording. Say **Video Pool** or **Image Pool**.

---

## 4. Dual pools + Cut (summary)

Full detail: **`docs/video-image-pools-spec.md`**.

### State

| State | Contents |
|-------|----------|
| `state.pool` | Videos + sequence + layout |
| `state.imagePool` | Stills only |
| `state.cut` | `{ refA, refB }` only — **no videoPath** |
| `window.globalInputs` | `video`, `image`, `frameStart`, `frameEnd`, `totalFrames` |

### Hard rules

1. **Never** mix stills into `state.pool.items` or videos into `state.imagePool.items`.  
2. **Cut clip** = first path in global **Video file(s)** only. No private path field.  
3. **Cut In/Out thumbs** = `GET /api/thumbnail?path=&frame=N` (1-based), not `which=first|last`.  
4. Video Pool cards still use absolute first/last (`which=`) for library identity.  
5. Persistence payload **v2** includes `images[]`. `savePoolStateNow` quiet-saves open project too.

### Events (listen, do not reinvent)

| Event | When |
|-------|------|
| `mtapi:frame-range` | Global range sliders move (`detail: { start, end, total }`) |
| `mtapi:video-probed` | Probe finished (`detail: { path, frames, cached }`) |

### Send-to wiring

- Video Pool → **Cut** → writes `#giVideo`, invalidates probe cache, `switchTab('cut')`.  
- Image Pool → **Cut · Ref A/B** → sets `state.cut.refA|refB`, opens Cut.

---

## 5. Global inputs pattern (all ops)

Prefer this over per-tab private pickers for primary media:

| Global row | Used by |
|------------|---------|
| Video file(s) `#giVideo` | Video ops + Cut clip |
| Image file(s) `#giImage` | Image ops |
| Frame range `#giFramesRow` | Tabs in `FRAME_RANGE_TABS` (`app.js`), including **cut** |
| Path in / out | Batch / watcher / outputs |

- `TAB_ACCEPTS[tab]` = `'video' | 'image' | 'any'` — status icons.  
- `bestInput()` / `allInputPaths()` prefer global video/image over local field.  
- Collectors: wrap body with `withFrameRange()` so ops get `start_frame` / `end_frame`.  
- Probe: `probeGlobalVideo(path, { force })` in `timeline.js`. Changing first video line clears probe cache.

**If frame UI stuck at 100:** probe never ran or video not in global bar — fix wiring, not the slider math.

---

## 6. Front-end rules

1. Absolute paths in API bodies.  
2. Op failures: HTTP 200 + `ok: false` — surface `error` / `stderr`.  
3. New op tabs: `js/tabs/<name>.js` + nav in `index.html` + `switchTab` / `renderTabForm` in `app.js`.  
4. Convert targets only via product presets / `convert_presets` backend.  
5. No new frontend frameworks.

---

## 7. WebUI testing — CRITICAL

**Prefer** Playwright MCP (`mcp_mcp_browser_*`) when available.

**If MCP is unavailable in this agent:** use local Playwright + Chromium under `~/.cache/ms-playwright` (see handoff §8–9). Still browser-test; do not claim UI DONE from curl alone.

**Never** use `web.run` / `web_search` / `web_extract` for localhost.

Minimum Cut/pool smoke:

1. Hard-refresh.  
2. Global Video = `/tmp/teste.mp4` → Cut shows real frame count (not 100).  
3. Drag range → In/Out `data-frame` updates.  
4. Image Pool import survives refresh when a project is open.

---

## 8. Backend coupling (read-only context)

```text
dump → app/filters/* → encode
```

UI POSTs `/ops/{id}` or `/ops/convert` / `/ops/pipeline`.  
Pool/project/thumbs: `/api/pool/*`, `/api/project/*`, `/api/thumbnail`, `/api/probe`.
