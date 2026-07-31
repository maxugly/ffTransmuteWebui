# Video Pool, Image Pool & Cut Workspace — As-Built Handoff

> **Status:** Implemented (basics + persistence + global-range Cut)  
> **Version:** landed through `000.000.4.25` (2026-07-31)  
> **Audience:** Next agent (or future you with amnesia)  
> **Related:** `frame-range-spec.md`, `media-persistence-spec.md`, `pool-toggle-spec.md`,  
> `mtapi-project/AGENTS.md`, `mtapi-project/app/static/AGENTS.md`

This document is the **source of truth** for dual media libraries and the Cut tab.
Do not re-introduce a single mixed “media pool” with type if-branches.

---

## 0. Read this first (non-negotiables)

1. **Videos and images are separate libraries**  
   - `state.pool` = Video Pool (`items[]` in JSON)  
   - `state.imagePool` = Image Pool (`images[]` in JSON)  
   Never stuff stills into `state.pool.items` or videos into `state.imagePool.items`.

2. **Cut has no private video path / private file picker**  
   - Clip = global **Video file(s)** bar (`#giVideo` / `window.globalInputs.video`)  
   - In/Out = global **Frame range** sliders (`frameStart` / `frameEnd`)  
   - Refs = Image Pool (or Browse → also adds to Image Pool)  
   - Do **not** add a local “clip path” field back onto Cut. That was tried; it broke probe and felt broken.

3. **Frame previews on Cut follow the working range**, not absolute file first/last  
   - API: `GET /api/thumbnail?path=…&frame=N` (1-based)  
   - Absolute first/last (`which=first|last`) remain for **Video Pool cards** only (library identity).

4. **Persistence: open project must stay in sync**  
   - Session file: `~/.cache/mtapi/pool_state.json`  
   - Named project: `*.ffproject.json`  
   - On reload, **last project wins** over session.  
   - Therefore `savePoolStateNow()` quiet-saves the open project too (videos + images + sequence).  
   - If you only write session, Image Pool (and unsaved pool edits) vanish on refresh.

5. **Tab ids are stable** (UI labels may change; do not rename ids lightly)

| UI label | `data-tab` | Notes |
|----------|------------|--------|
| Video Pool | `pool` | Was “Media Pool”; id unchanged |
| Image Pool | `images` | New |
| Sequence | `sequence` | Videos only |
| Cut | `cut` | Workspace shell; no encode yet |

---

## 1. Goals (what shipped)

| # | Goal | Status |
|---|------|--------|
| 1 | Rename Media Pool → **Video Pool** | Done |
| 2 | Separate **Image Pool** for stills | Done |
| 3 | Persist both in session + project JSON v2 | Done |
| 4 | **Cut** workspace: In/Out from global range + Ref A/B | Done (no encode) |
| 5 | Pause preview → Image Pool | **Not done** (future) |
| 6 | Cut → write trimmed file | **Not done** (future) |

---

## 2. Frontend state model

### 2.1 Video Pool — `state.pool` (`app.js`)

```js
state.pool = {
  items: [],           // { path, name, size?, meta?, hash? }  VIDEOS ONLY
  selectedPath: null,
  selectedSeqId: null,
  filterQuery: '',
  sequence: [],        // { id, path, name, targetDuration? }  VIDEOS ONLY
  // … layout, tileZoom, match*, playback, reconcile, aspect, outputPath …
};
```

- Cards: dual-frame **absolute** first + last thumbs (`/api/thumbnail?which=first|last`).  
- Sequence stitch is video-only.  
- Fuzzy filter: name/path/codec/hash.  
- UI module: `js/pool/grid.js`, `items.js`, `sequence.js`, `chrome.js`, `layout.js`.

### 2.2 Image Pool — `state.imagePool`

```js
state.imagePool = {
  items: [],           // { path, name, size?, meta?, hash? }  STILLS ONLY
  selectedPath: null,
  filterQuery: '',
  loading: false,
};
```

- Cards: single thumb (`which=first` or hash-based first).  
- Extensions: `IMAGE_EXTS` in `js/pool/constants.js` (+ `isImagePath` in `js/utils.js`).  
- UI module: **`js/pool/image-pool.js`** (import, grid, send-to, clear).  
- Toolbar: project New/Open/Save/Save As (same project as video pool), filter, + Files, + Folder, Clear.  
- Send targets: Global Image, Face Morph, withoutBG, Style content/ref, DeepDream, **Cut · Ref A/B**, Preview.

### 2.3 Cut — `state.cut`

```js
state.cut = {
  refA: null,   // absolute image path or null
  refB: null,
  // NO videoPath — clip lives in window.globalInputs.video
};
```

- UI module: **`js/tabs/cut.js`**.  
- Clip display is read-only: “from global Video”.  
- Helpers: “Preview clip”, “Video Pool…” (navigates only).  
- Pending ref fill: `state._cutPendingRef = 'refA'|'refB'` when user jumps to Image Pool to pick.

### 2.4 Global inputs (shared with all ops)

```js
window.globalInputs = {
  video: '',           // multi-line absolute paths
  image: '',
  pathIn: '', pathOut: '',
  frameStart: 1,       // 1-based inclusive
  frameEnd: 100,       // default until probe; then true end
  totalFrames: 100,    // default until probe
  _lastProbedPath,     // probe cache
  _probeOk,            // true after successful probe
};
```

| Concern | Source of truth |
|---------|-----------------|
| Cut clip | `globalInputs.video` first non-empty line (`bestInput()`) |
| Cut In/Out | `globalInputs.frameStart` / `frameEnd` |
| Ops that dump frames | `withFrameRange(body)` → `start_frame` / `end_frame` |

`TAB_ACCEPTS.cut = 'video'`.  
`FRAME_RANGE_TABS` includes `'cut'`.

---

## 3. Persistence (session + project)

### 3.1 Payload shape (version 2)

```json
{
  "version": 2,
  "items":  [ { "path", "name", "hash", "size" } ],
  "images": [ { "path", "name", "hash", "size" } ],
  "sequence": [ { "path", "name", "target_duration?" } ],
  "selected_path": null,
  "selected_image_path": null,
  "reconcile": "pad",
  "aspect": "auto",
  "aspect_custom": "",
  "output_path": "",
  "tile_zoom": 200,
  "tile_info": {},
  "layout": {},
  "project_name": null,
  "project_path": null
}
```

| Key | Maps to |
|-----|---------|
| `items` | `state.pool.items` |
| `images` | `state.imagePool.items` |
| `sequence` | `state.pool.sequence` |
| `selected_path` | `state.pool.selectedPath` |
| `selected_image_path` | `state.imagePool.selectedPath` |

Missing `images` on load → `[]` (old projects).

### 3.2 Files & modules

| Layer | Path |
|-------|------|
| Session autosave | `~/.cache/mtapi/pool_state.json` |
| Named project | `*.ffproject.json` (`kind: "fftransmute-project"`, nested `pool` or flat legacy) |
| Last project pointer | `~/.cache/mtapi/last_project_path.txt` (via `projects.py`) |
| Frontend build/save | `js/pool/persistence.js` → `buildPoolStatePayload`, `applyPoolData`, `savePoolStateNow`, `restorePoolState` |
| Backend normalize | `app/media/pool.py` (`_normalize_media_entries`, `_normalize_pool_payload`) |
| Backend projects | `app/media/projects.py` |

### 3.3 Restore order (critical)

1. `GET /api/project/last` → if path exists, `GET /api/project/load`  
2. Else `GET /api/pool/state` (session)  
3. Project load **also writes** session (`save_pool_state`) so session mirrors project  

**Bug fixed (2026-07-31):** Image Pool only hit session; reload preferred project without `images[]` → empty pool.  
**Fix:** `savePoolStateNow()` also `POST /api/project/save` when `state.project.path` is set (debounced with session).

### 3.4 Project new / open / save

- Shared buttons on Video Pool and Image Pool toolbars.  
- `projectNew` clears videos, sequence, **and** images, and cut refs.  
- Folder scan: `/api/pool/scan?kind=video|image|all` (default `video` for back-compat).

---

## 4. Backend APIs (pools / thumbs / probe)

### 4.1 Pool & project

| Method | Route | Notes |
|--------|-------|--------|
| GET/PUT/POST | `/api/pool/state` | Session JSON v2 |
| GET | `/api/pool/scan?path=&kind=video\|image\|all` | Folder import |
| POST | `/api/project/save` | Body includes full pool payload + `path` |
| GET | `/api/project/load?path=` | Returns items + images + sequence |
| GET | `/api/project/last` | Last opened project path |

### 4.2 Thumbnails

| Query | Meaning |
|-------|---------|
| `GET /api/thumbnail?path=…&which=first\|last` | Absolute first/last of **whole file** (Video Pool cards) |
| `GET /api/thumbnail?path=…&frame=N` | **1-based** frame N (Cut In/Out, range previews) |

Implementation:

- `app/routes/media.py` — route  
- `app/media/thumbnails.py` — `extract_frame_at`, `get_frame_thumb_file`  
- Cache: `by_hash/{hash}/range_thumbs/frame_XXXXXX.jpg`  
- Frame 1 reuses permanent `first.jpg` when possible  
- Fast path: `-ss` with fps from record; fallback exact `select=eq(n,…)`

### 4.3 Probe (frame count for sliders)

- `GET /api/probe?path=` → `true_frames`  
- Frontend: `js/timeline.js` → `probeGlobalVideo(path, { force? })`  
- On success: sets `totalFrames`, resets range to full clip (1…N), updates slider max, dispatches:  
  - `mtapi:frame-range` `{ start, end, total }`  
  - `mtapi:video-probed` `{ path, frames, cached }`  
- Changing first line of `#giVideo` invalidates `_lastProbedPath` / `_probeOk` in `updateGlobalInputs`.

**Symptom if probe skipped:** sliders stuck at default **100**.  
**Cause usually was:** Cut using a local path never put into global video. Fixed by global-only Cut.

---

## 5. Cut tab behavior (as-built)

### 5.1 Layout

```text
Global bar:  Video file(s)  |  Frame range [====In====Out====]
Cut panel:
  Clip (read-only from global)
  [ In · frame S ]   [ Out · frame E ]
  [ Ref A        ]   [ Ref B        ]
```

### 5.2 Events

| Event | Listener | Action |
|-------|----------|--------|
| `mtapi:frame-range` | `cut.js` (debounced ~100ms) | Refresh In/Out thumbs + labels |
| `mtapi:video-probed` | `cut.js` | Refresh previews |
| `#giVideo` input/change | `cut.js` | Re-render Cut form |
| Cut tab open | `renderCutForm` | `probeGlobalVideo(path, { force: true })` |

### 5.3 Wiring from Video Pool

- `sendPoolPathTo(path, 'cut')` in `js/pool/items.js`:  
  writes `#giVideo`, clears probe cache, `switchTab('cut')`.  
- Use-as-input dropdown includes **Cut (global video + range)**.

### 5.4 What Cut is NOT (yet)

- No Run / encode / export of the trimmed segment.  
- No multi-clip edit.  
- No pause-frame → Image Pool (planned).

When implementing encode later: dump with `start_frame`/`end_frame` via existing `video_pipeline.dump` + `convert` or a thin `/ops/cut` — do not invent a parallel dump stack.

---

## 6. File map (complete)

### Frontend

| File | Role |
|------|------|
| `app/static/index.html` | Nav: Video Pool, Image Pool, Sequence, Cut |
| `app/static/app.js` | `state.pool`, `state.imagePool`, `state.cut`, `TAB_ACCEPTS`, `FRAME_RANGE_TABS`, tab switch |
| `app/static/js/pool/constants.js` | `VIDEO_EXTS`, `IMAGE_EXTS` |
| `app/static/js/utils.js` | `isVideoPath`, `isImagePath`, `globalFrameRange`, `withFrameRange` |
| `app/static/js/pool/grid.js` | Video Pool + Sequence UI |
| `app/static/js/pool/items.js` | Video import, send-to (incl. cut), meta |
| `app/static/js/pool/image-pool.js` | **Image Pool** UI + import + send |
| `app/static/js/pool/persistence.js` | Payload v2, project save/load, dual save |
| `app/static/js/pool/sequence.js` | Sequence composer |
| `app/static/js/tabs/cut.js` | **Cut** workspace |
| `app/static/js/timeline.js` | Global probe + range sliders + events |
| `app/static/css/pool.css` | Pool cards, Image Pool, Cut layout |

### Backend

| File | Role |
|------|------|
| `app/media/pool.py` | Session load/save, `images[]`, normalize |
| `app/media/projects.py` | Project load/save with images |
| `app/media/thumbnails.py` | first/last + **frame N** range thumbs |
| `app/media/__init__.py` | Exports `get_frame_thumb_file`, `extract_frame_at` |
| `app/routes/pool.py` | State routes + scan `kind=` |
| `app/routes/media.py` | Thumbnail `frame=` query |

---

## 7. Invariants for future agents

1. **Do not merge** video and image pools into one list.  
2. **Do not add** a private video path field on Cut (or any new “workspace” tab that needs range) — use global bar.  
3. **Do not** use absolute first/last thumbs for range UI — use `frame=N`.  
4. **Always** include `images` in project save payload.  
5. **Always** dual-save session + open project when pool state changes.  
6. Sequence / stitch / match stay **video-only**.  
7. New still-only features → Image Pool (or global Image bar), not Video Pool.  
8. Vanilla JS only; no new frontend frameworks.

---

## 8. Verification checklist

### Backend smoke

```bash
# Server
cd mtapi-project && .venv/bin/python run.py

curl -s http://127.0.0.1:24590/health | jq .version

# Per-frame thumbs differ by N
curl -s -o /tmp/f1.jpg  "http://127.0.0.1:24590/api/thumbnail?path=/tmp/teste.mp4&frame=1"
curl -s -o /tmp/f12.jpg "http://127.0.0.1:24590/api/thumbnail?path=/tmp/teste.mp4&frame=12"
md5sum /tmp/f1.jpg /tmp/f12.jpg   # must differ for animated/testsrc

# Image folder scan
curl -s "http://127.0.0.1:24590/api/pool/scan?path=/tmp&kind=image" | jq '.kind,.image_count'
```

### WebUI (preferred Playwright)

1. Hard-refresh UI.  
2. **Video Pool** still lists videos (dual frames).  
3. **Image Pool**: + Files still → card appears; refresh page with open project → still there.  
4. Global **Video file(s)** = `/tmp/teste.mp4` → open **Cut**.  
5. Hint shows real frame count (not stuck at 100).  
6. Drag Frame range → In/Out labels and images update (`data-frame` matches).  
7. No `#cutVideoPath` / private Browse for video.  
8. Video Pool → Use as → Cut → fills global video and opens Cut.

### Test assets

| File | Role |
|------|------|
| `/tmp/teste.mp4` | 2s 320×240 24fps (~48 frames) |
| `/tmp/teste.png` | Still for Image Pool |

---

## 9. Pitfalls (lessons learned)

| Symptom | Likely cause | Fix direction |
|---------|--------------|---------------|
| Image Pool empty after F5 | Project load without `images[]` overwrote session | Dual-save project in `savePoolStateNow` |
| Frame range stuck at 100 | Video never in global bar / probe never ran | Global-only clip; force probe on Cut open |
| Cut In/Out always same pictures | Using `which=first|last` | Use `frame=N` |
| Local Cut picker “worked” but range dead | Private path ignored by `probeGlobalVideo` | Removed local path |
| Playwright MCP missing in agent | No MCP tools registered | Use local Playwright CLI + Chromium under `~/.cache/ms-playwright` |

---

## 10. Future work (do not block)

1. **Pause preview → Add to Image Pool** (path + optional frame export PNG).  
2. **Cut encode**: dump range → encode via convert presets / thin op; honor pathOut.  
3. Optional: Cut Ref from global Image lines 1/2.  
4. Project UI copy that Image Pool is part of the project.  
5. Garbage-collect `range_thumbs/` with hash dir GC.

---

## 11. History (short)

| When | Change |
|------|--------|
| 2026-07-31 | Spec + Video/Image rename; Image Pool; Cut scaffold |
| 2026-07-31 | Persistence fix: project quiet-save includes `images` |
| 2026-07-31 | `/api/thumbnail?frame=N` + Cut range-driven In/Out |
| 2026-07-31 | Cut global-only inputs; remove private video picker; probe force |

---

*End of handoff. Prefer updating this file when behavior changes rather than scattering notes.*
