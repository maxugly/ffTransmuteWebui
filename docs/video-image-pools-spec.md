# Video Pool, Image Pool & Cut Workspace — As-Built Spec

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

- Wall: one 120px `wall.jpg` (`/api/thumbnail?which=wall`). First+last stay for Sequence / match. See `pool-wall-preview-spec.md`.  
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
- UI module: **`js/pool/image-pool.js`** (import, grid, clear).  
- Toolbar: project New/Open/Save/Save As (same project as video pool), filter, + Files, + Folder, Clear.  
- No per-tool Send menu (removed in 8.104). One destination: the global **Media In** box.
  Click an image card (fills the preview) then the preview's `→I-in`; the user navigates to the
  tab by hand. Slot targets (Cut · Ref A/B, Compare A/B, Pan & Zoom ref) stay on the owning tab's
  own **Pool** button.

### 2.3 Cut — `state.cut`

```js
state.cut = {
  refA: null,              // absolute image path or null (pairs with In)
  refB: null,              // pairs with Out
  mode: 'separate',        // shared image-compare: 'separate' | 'overlay' | 'ab'
  compareMode: 'separate', // legacy alias; kept in sync with mode
  overlayOpacity: 50,      // 0–100, ref opacity in overlay mode
  abPosition: 50,          // 0–100 wipe handle (left of handle = frame, right = ref)
  // NO videoPath — clip lives in window.globalInputs.video
};
```

- UI module: **`js/tabs/cut.js`** (host only).  
- **Compare control (shared):** `js/ui/image-compare.js` + `css/image-compare.css` — see **`docs/image-compare-spec.md`**.  
- Clip display is read-only: “from global Video”.  
- Helpers: “Preview clip”, “Video Pool…” (navigates only).  
- Pending ref fill: `state._cutPendingRef = 'refA'|'refB'` when user jumps to Image Pool to pick.  
- **Compare modes** (via shared module; In↔Ref A, Out↔Ref B):  
  1. **Separate** — In / Out / Ref A / Ref B as four cards (default).  
  2. **Overlay** — Ref stacked on In/Out with adjustable transparency (align frames).  
  3. **A/B** — wipe slider left=frame / right=ref (drag on image or bar).

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

### 2.5 Sequence render range (clip N → M)

The Sequence can render a **sub-range** of its clips — "render clip 34 → clip
56" — without deleting the other clips or making a second project.

```js
state.pool.renderRange = { from: null, to: null };  // 1-based, inclusive
```

| Concern | Rule |
|---------|------|
| Bounds | 1-based, inclusive. `null`/blank = unset (whole sequence renders) |
| Scope | The **render** (Stitch) only. Instant RIFE, Erase▸Run and the conform cache still cover the whole sequence |
| Mutation | Never. The sequence, the project file and every clip stay as they are — the range only chooses what the render consumes |
| Validation | `resolveRange(range, clipCount)` — `From > To`, `From` past the last clip, non-integer or `< 1` bounds → the Stitch is disabled and the hint names the reason |
| Clamping | `To` past the last clip is clamped to the last clip (hint says so); `From` past the last clip is an error |
| Persistence | `render_range` in the pool payload (`{from, to}`, `null` = unset) — session autosave + named project |

**UI** (`Sequence` tab, composer row above the options):

- Two number inputs (`#seqRangeFrom`, `#seqRangeTo`) labelled `Clips`.
- A hint line (`#seqRangeHint`): `All 60 clips` → `Clips 34–56 of 60 · 23 clips`,
  or the error reason.
- Chips outside the window get `.is-out-of-range` (dimmed, still visible).
- The Stitch button names the window: `Stitch 34–56` (`(copy)` / `(re-encode)`
  suffixes still come from the conform prediction).

**Modules:**

| File | Role |
|------|------|
| `app/static/js/pool/sequence-range.js` | Pure range math (no imports, no DOM) — `resolveRange`, `sliceRange`, `rangeLabel`, `rangeHint`, `rangeIncludes` |
| `app/static/js/pool/sequence-range-ui.js` | Inputs, hint line, chip dimming, Stitch button state |
| `app/media/pool.py` | `_normalize_render_range` — known-key payload entry, bad bounds → unset |

**Proof:** `node mtapi-project/tests/test_sequence_range.mjs` (pure math) ·
`mtapi-project/tests/test_sequence_render_range.py` (payload round trip) ·
`mtapi-project/junk/prove_sequence_range.mjs` (Playwright: real typing, real
Stitch click, output probed on disk — a 2–5 window of 1 s…6 s clips renders a
14 s file, not the 21 s sequence).

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
  "render_range": { "from": null, "to": null },
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
| `render_range` | `state.pool.renderRange` — Sequence render window (§2.5) |

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
  Compare: [1 Separate | 2 Overlay | 3 A/B]  [opacity or wipe slider]
  [ In · frame S ]   [ Out · frame E ]   (± ref composite when mode ≠ separate)
  [ Ref A        ]   [ Ref B        ]   (separate mode only; toolbars when composite)
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
| `app/static/js/pool/items.js` | Video import, frame-PNG export, meta |
| `app/static/js/pool/image-pool.js` | **Image Pool** UI + import |
| `app/static/js/pool/persistence.js` | Payload v2, project save/load, dual save |
| `app/static/js/pool/sequence.js` | Sequence composer |
| `app/static/js/pool/sequence-range.js` | Sequence render range — pure math (§2.5) |
| `app/static/js/pool/sequence-range-ui.js` | Sequence render range — inputs, hint, chip dimming (§2.5) |
| `app/static/js/tabs/cut.js` | **Cut** workspace (host; no dual-layer logic) |
| `app/static/js/ui/image-compare.js` | Shared separate/overlay/A/B compare control |
| `app/static/css/image-compare.css` | Shared compare styles |
| `app/static/js/timeline.js` | Global probe + range sliders + events |
| `app/static/css/pool.css` | Pool cards, Image Pool, Cut layout only |

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
9. The Sequence **render range** scopes the Stitch only — never the sequence
   content, the project file, Instant RIFE or Erase▸Run (§2.5).

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
| 2026-07-31 | Cut compare modes: separate / overlay opacity / A/B wipe |
| 2026-07-31 | Extract compare → `js/ui/image-compare.js` + `css/image-compare.css` |

---

*End of spec. Prefer updating this file when behavior changes rather than scattering notes.*
