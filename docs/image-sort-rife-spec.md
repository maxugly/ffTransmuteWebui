# Image Sort + Optional RIFE — Spec

> **Status:** Ready for build  
> **Audience:** Builder agents  
> **Op id:** `imagesort_rife` → `POST /ops/imagesort_rife`  
> **Related:** `filter-platform-spec.md` §3.4 (multi-source generators), `rife-spec.md`, `facemorph-spec.md`, `video-image-pools-spec.md`  
> **UI pattern:** Single multi-image list (facemorph / withoutbg / styletransfer `fm-list` family) — no separate “base path” field

---

## 1. Goal

Turn an unordered set of stills into a smooth video:

1. User builds one **ordered list** of stills. **Slot #1 (index 0) is the base** (first keyframe + sort anchor + conform size reference).
2. **Sort** reorders items **2…N** by likeness to the current base (pluggable modes). Base stays #1 unless the user later moves it.
3. **Manual reorder** — after sort (or instead of sort), user drags / buttons the list; **preview** the selected row.
4. **Conform** every keyframe to the base size (letterbox default).
5. Optionally **RIFE** to multiply frames between keyframes.
6. **Encode** at a chosen **fps**. Total duration is **not** a knob — it falls out of keyframe count × multiplier × fps.

```text
single ordered list  (UI: [base★, …items…])
      │
      ├─ [Sort] ──► rank items 2..N vs list[0]; rewrite list order in UI
      │
      ├─ [manual reorder] ──► drag / ↑↓ / ⤒⤓; click → preview
      │
      ▼
 POST final image_paths in UI order  (list[0] = base)
      │
      ▼
 conform → JobWorkspace frames (frame_%06d.png, start 0)
      │
      ├─ use_rife=false ──► encode keyframes @ fps
      │
      └─ use_rife=true  ──► run_rife_directory (×multiplier) ──► encode @ fps
```

**Not** a video dump→filter chain. Same class as facemorph: **multi-source stills → sequence → (optional stage) → encode**.

---

## 2. Product decisions (locked)

| # | Decision |
|---|----------|
| 1 | **Base = list index 0** (UI “#01” / first row). On disk: `frame_000000.png` (platform start_number **0**). No separate base-image text field. |
| 2 | User sets **`fps`** and **`multiplier`** (and whether RIFE is on). **No total-length control.** Duration is derived (see §3). |
| 3 | Size conform default = **letterbox** to base WxH; even dimensions for yuv420p. Options: `letterbox` \| `crop` \| `stretch`. |
| 4 | API defaults as in §5. |
| 5 | **`use_rife: bool`** — when false, skip interpolation (keyframes only). |
| 6 | **Final order is client-owned.** Run op **trusts** `image_paths` order. Sort is a **separate UI action** (optional lightweight rank call); manual reorder sits **after sort, before RIFE/encode**. |
| 7 | **One list UI** (reuse facemorph-style import list). Slot #1 visually marked as base; drop the standalone base box/label. |

### Quality honesty (v1)

Sorting by distance-to-base is a **radial ranking**, not a shortest path through image space. Manual reorder exists exactly so the user can fix bad jumps before RIFE. Future (out of scope): pairwise / embedding / TSP chain sort.

---

## 3. Duration math (no length knob)

Let:

- `K` = `len(image_paths)` after validation (`K ≥ 2`)
- `M` = RIFE multiplier if `use_rife`, else `1`
- `F` = output fps

```text
N_out ≈ K * M
duration_sec ≈ (K * M) / F
```

| K | M | F | ~duration |
|---|---|---|-----------|
| 4 | 1 (RIFE off) | 24 | ≈ 0.17 s |
| 4 | 4 | 24 | ≈ 0.67 s |
| 10 | 8 | 30 | ≈ 2.7 s |

**UI hint:** estimated duration from current list length, multiplier, and fps.

**Do not** scale encode fps to preserve duration. fps is absolute; more frames ⇒ longer video.

---

## 4. Modular architecture

```text
app/
  image_sort/                    # NEW — pure ranking (no HTTP, no RIFE, no UI)
    __init__.py
    modes.py                     # mode registry + score functions
    rank.py                      # rank_images(base, targets, mode, order) → RankedItem[]
    conform.py                   # conform_image(src, dst, w, h, fit)
  filters/rife.py                # EXISTING — run_rife_directory only
  video_pipeline.py              # EXISTING — encode only
  job_workspace.py               # EXISTING
  operations/
    imagesort_rife_ops.py        # THIN run op + optional rank-only endpoint
  static/js/tabs/imagesort.js    # list + sort + reorder + preview + collect
```

| Module | Owns | Does not own |
|--------|------|----------------|
| `image_sort` | Scores, sort, conform helpers | Job dirs, RIFE, SPA state |
| `filters.rife` | Directory RIFE pass | Sorting / UI order |
| `imagesort_rife_ops` | Validate ordered paths, workspace, optional RIFE, encode, rank-only JSON | Second RIFE binary path |
| `imagesort.js` | List, base badge, preview, drag/buttons, Sort button, collect body | Server-side ranking math (calls API) |

### Reuse vs redo

| Piece | Action |
|-------|--------|
| Facemorph / withoutbg **list UI** (`fm-list`, add files/folder, ↑↓, remove) | **Reuse pattern** — extend with base styling, ⤒⤓, drag, click-preview. Prefer shared CSS classes (`fm-*` or a thin `image-list` partial) over a third one-off list. |
| `filters.rife.run_rife_directory` | **Reuse** |
| `JobWorkspace` + `video_pipeline.encode` | **Reuse** (`mux_audio=False`) |
| `media` pHash helpers | **Reuse for `phash` if clean**; else implement in `image_sort.modes` and backlog-migrate pool matching later |
| Facemorph ad-hoc scale | **Do not copy** — use `conform.py` |

**Invariant:** no second RIFE subprocess path; no video dump for this op.

---

## 5. API contract

### 5.1 Two entry points (same module)

| Endpoint | Purpose |
|----------|---------|
| `POST /ops/imagesort_rank` (or same op with `action: "rank"`) | **Sort only.** Returns ordered paths + scores for the UI. No conform/RIFE/encode. |
| `POST /ops/imagesort_rife` | **Run.** Trusts final `image_paths` order. Conform → optional RIFE → encode. |

Builders may implement rank as a second `OperationSpec` (`id="imagesort_rank"`) **or** one params model with `action: Literal["rank","run"]`. Prefer **two clear ops** if registration is easier; keep shared helpers.

### 5.2 Shared path fields

Ordered list is the single source of truth:

| Field | Type | Default | Notes |
|-------|------|---------|--------|
| `image_paths` | `list[str]` | required for run/rank | **Order matters.** `[0]` = base. |
| `image_dir` | `str \| None` | `None` | Only if `image_paths` empty: scan dir (alpha order); UI should usually expand into paths first. |
| `input_path` | `str \| None` | `None` | Newline-separated paths (global multi-image). Parsed into ordered list if `image_paths` empty. |

**No `base_image` field.** Base = `image_paths[0]` after resolve.

### 5.3 Rank params (`ImageSortRankParams`)

| Field | Type | Default | Notes |
|-------|------|---------|--------|
| `image_paths` | `list[str]` | required | Current list; `[0]` is sort anchor |
| `sort_mode` | enum | `"phash"` | §6 |
| `sort_order` | enum | `"nearest_first"` | `nearest_first` \| `farthest_first` |

**Behavior:** score every path after index 0 against path 0; return:

```json
{
  "ok": true,
  "operation": "imagesort_rank",
  "ordered_paths": ["…/base.png", "…/near.png", "…/far.png"],
  "items": [
    {"path": "…/base.png", "score": null, "role": "base"},
    {"path": "…/near.png", "score": 3.0, "role": "target"},
    {"path": "…/far.png", "score": 12.0, "role": "target"}
  ],
  "stdout": "rank phash nearest_first: base + 2 targets …"
}
```

UI replaces its list with `ordered_paths` (preserve names/thumbs by path). Verbose `stdout` always.

If rank is folded into one op, return the same payload when `action="rank"` (still `ok` / HTTP 200).

### 5.4 Run params (`ImageSortRifeParams`)

| Field | Type | Default | Notes |
|-------|------|---------|--------|
| `image_paths` | `list[str]` | required | **Final** order from UI (after sort + manual tweaks) |
| `image_dir` / `input_path` | optional | | Fallback collect only if paths empty |
| `sort_mode` | enum | `"phash"` | Used **only if** `auto_sort=true` |
| `sort_order` | enum | `"nearest_first"` | Same |
| `auto_sort` | `bool` | `False` | Headless/curl convenience: re-rank vs `[0]` before conform. **WebUI always sends `false`** after client Sort + manual order. |
| `use_rife` | `bool` | `True` | Off ⇒ keyframes only |
| `multiplier` | `int` | `2` | `2..8`; ignored if RIFE off |
| `model` | enum | `"rife-v4.6"` | Ignored if RIFE off |
| `tta` / `uhd` | `bool` | `False` | RIFE flags |
| `fps` | `float` | `24` | `1..120` |
| `fit` | enum | `"letterbox"` | `letterbox` \| `crop` \| `stretch` |
| `output_path` | `str \| None` | `None` | `finalize_output_path` |
| `crf` | `int` | `18` | |
| `keep_frames` | `bool` | `False` | |
| `dry_run` | `bool` | `False` | |

**Collect priority:** `image_paths` if non-empty → else `input_path` lines → else `image_dir` scan.

**Dedup:** optional warn if same path appears twice; keep first occurrence.

### 5.5 Validation (run)

| Condition | Result |
|-----------|--------|
| `< 2` paths after resolve | `ok: false` — need base + ≥1 other |
| Path missing / not a file | `ok: false` with path in error |
| Unknown `sort_mode` when `auto_sort` | `ok: false` |
| `use_rife` and binary missing | `ok: false` via `resolve_rife_bin` |
| `use_rife` and `multiplier < 2` | reject |
| Unreadable image during auto_sort score | skip + log; still need `K ≥ 2` |

### 5.6 Output naming

```text
source = image_paths[0]
suffix = "_imagesort" if not use_rife else f"_imagesort_rife{multiplier}x"
finalize_output_path(..., default_suffix=suffix, default_ext=".mp4")
```

### 5.7 Verbose `OperationResult` logs

Always prefer readable multi-line `stdout` (project-wide verbosity preference):

```text
imagesort_rife  K=4  use_rife=true  M=4  fps=24  fit=letterbox  auto_sort=false
order (final):
  00  base.png           role=base
  01  near.png           (manual)
  02  mid.png
  03  far.png
conform: 320x240 even  letterbox
rife: 4 → 16 frames  model=rife-v4.6
encode: /path/out.mp4  ~duration=0.67s
```

Rank responses similarly list scores. Dry-run prints the same plan without GPU work.

---

## 6. Sort modes (decoupled registry)

`app/image_sort/modes.py`:

```python
ScoreFn = Callable[[Path, Path], float]  # lower = closer

MODES = {
  "phash": ...,
  "ahash": ...,
  "colorhash": ...,
  "mse": ...,
  "ssim": ...,   # score = 1 - ssim
}
```

| Mode | Distance | Dependency |
|------|----------|------------|
| `phash` | Hamming | `imagehash` |
| `ahash` | Hamming | `imagehash` |
| `colorhash` | Hash distance | `imagehash.colorhash` |
| `mse` | MSE | numpy + Pillow (score at max side ~256) |
| `ssim` | `1 - SSIM` | skimage (optional drop if missing) |

**`rank_images(base, targets, mode, order)`** returns targets sorted; caller prepends base.

---

## 7. Conform (size policy)

Reference size = **first path** (base) WxH; force even dims.

| `fit` | Behavior |
|-------|----------|
| `letterbox` (default) | Fit inside; black pad |
| `crop` | Cover + center crop |
| `stretch` | Exact WxH (opt-in distort) |

ffmpeg argv only (`shell.run_command` / `create_subprocess_exec`). Uniform PNG sequence `frame_%06d.png` from 0.

```python
async def conform_image(src: Path, dst: Path, width: int, height: int, fit: str) -> None: ...
```

---

## 8. Pipeline steps

### 8.1 Rank (Sort button)

```text
1. Resolve image_paths; K ≥ 2
2. base = paths[0]; targets = paths[1:]
3. ranked = rank_images(base, targets, mode, order)
4. Return ordered_paths = [base] + ranked paths + scores in stdout/items
```

### 8.2 Run (after UI order is final)

```text
1. Resolve image_paths; K ≥ 2; base = paths[0]
2. If auto_sort: re-rank targets vs base (curl convenience only)
3. dry_run → plan + return
4. JobWorkspace(prefix="imagesort_")
5. Probe base size; even floor
6. For i, path in enumerate(final_paths):
     conform → frames_in/frame_{i:06d}.png
7. If use_rife:
     run_rife_directory(frames_in, frames_out, …)
     encode_dir = frames_out
   Else:
     encode_dir = frames_in  # frame_source_dir=
8. await encode(ws, out, fps=F, mux_audio=False, crf=…, frame_source_dir=encode_dir)
9. cleanup (keep on failure; keep_on_success if keep_frames)
```

**Cancel / progress:** phases `rank` | `conform` | `rife` | `encode`.

---

## 9. WebUI (primary design)

### 9.1 Layout philosophy

**Yes — use one preexisting-style target list; kill the separate base box.**

| Before (rejected) | After (this spec) |
|-------------------|-------------------|
| Base path field + label | — |
| Targets list | **Sequence list** only: every still in play order |
| Sort only on server at run | Sort button → rank API → rewrite list; then manual edit; then Run |

Condenses chrome, matches how users already import multi-images (facemorph / withoutbg / styletransfer).

### 9.2 Sequence list (extend `fm-list` pattern)

**State:** `state.imageSort.images = [{ path, name, score? }, …]`  
Index `0` is always **base**.

**Row UI:**

```text
[01] ★ BASE   name.png     [⤒] [↑] [↓] [⤓] [✕]
[02]          other.png    [⤒] [↑] [↓] [⤓] [✕]
...
```

| Element | Behavior |
|---------|----------|
| Ordinal | 1-based display (`01`, `02`, …) |
| Base badge | Row `0` only: e.g. class `is-base`, accent border/background, **italic** or bold label `BASE` / ★ |
| Click row | Select + show **preview** (see §9.3) |
| Drag handle / whole row | HTML5 drag-and-drop reorder (or pointer drag if project already has a helper) |
| ↑ / ↓ | Swap with neighbor |
| ⤒ To top | Move to index 0 → **becomes new base** (restyle rows) |
| ⤓ To bottom | Move to end |
| ✕ | Remove; if base removed, new index 0 becomes base (restyle) |
| + Images / + Folder / Clear | Same as facemorph |
| Optional “From global images” | `resolveGlobalImages()` append |

**Rules:**

- Promoting any row to top makes it the base (conform + future Sort anchor).
- Sort **keeps** current index 0 fixed; only reorders `1..N-1`.
- Empty / single-item: disable Sort and Run with hint “need at least 2 images”.
- After rank response, rewrite list order; show score as muted subtitle when present.

**CSS:** extend `forms.css` `.fm-*` or add `.is-list` / `.is-base` next to facemorph — do not invent a parallel layout language unless necessary.

### 9.3 Preview pane

- Beside or above the list: fixed-height preview (`object-fit: contain`).
- **Click** a row (or select via keyboard later) → preview that path via existing media URL pattern if any (`/api/...` thumb) or `file://` is **not** available in browser — use whatever facemorph/pool uses for still preview (e.g. cache thumb by path, or a small `/api/media/preview?path=` if it exists).
- If no thumb API: show basename + path and a “open in Image Pool” hint rather than broken `<img>`. Prefer reusing Image Pool / thumbnail endpoints when cheap.
- Preview updates on select after reorder/sort.

### 9.4 Other controls

| Control | Maps to |
|---------|---------|
| Sort mode `<select>` | `sort_mode` (rank + optional auto_sort) |
| Sort order nearest / farthest | `sort_order` |
| **Sort list** button | `POST` rank → replace list order |
| **Use RIFE** | `use_rife` |
| Multiplier 2–8 | `multiplier` (disabled if RIFE off) |
| Model / TTA / UHD | RIFE only; hide/disable if off |
| FPS / fit / CRF / dry run / keep frames / output | as §5.4 |
| **Run** | `POST /ops/imagesort_rife` with `image_paths` in list order, `auto_sort: false` |

Duration estimate under list: `~${(K * (useRife?M:1) / fps).toFixed(2)}s`.

### 9.5 Collect body

```js
{
  image_paths: state.imageSort.images.map(i => i.path),
  auto_sort: false,
  sort_mode, sort_order, use_rife, multiplier, model, tta, uhd,
  fps, fit, output_path, crf, keep_frames, dry_run
}
```

No `base_image` key.

### 9.6 Wiring

- `js/tabs/imagesort.js` — `renderImageSortForm`, `collectImageSortBody`, list event handlers  
- `app.js` — nav **Image Sort → Video**, import, run  
- `job-control.js` — register collect if required  

---

## 10. Files to create / touch

| Path | Action |
|------|--------|
| `app/image_sort/__init__.py` | New package |
| `app/image_sort/modes.py` | Mode registry |
| `app/image_sort/rank.py` | `rank_images` |
| `app/image_sort/conform.py` | `conform_image` |
| `app/operations/imagesort_rife_ops.py` | Run + rank registration |
| `app/operations/__init__.py` | Import |
| `app/static/js/tabs/imagesort.js` | List / sort / reorder / preview / collect |
| `app/static/css/forms.css` (or small CSS) | `.is-base`, drag cursor, preview box |
| `app/static/app.js` | Nav + wiring |
| `app/static/js/job-control.js` | If needed |
| Root `VERSION` | Far-right DD |
| AGENTS.md op table | Optional row |

**Do not** register sort as a `filters/*` chain stage. **Do not** use `PngFramePipeline`.

---

## 11. Verification

### Assets

```bash
ffmpeg -y -f lavfi -i "color=c=red:s=320x240:d=1" -frames:v 1 /tmp/is_base.png
ffmpeg -y -f lavfi -i "color=c=0xFF6666:s=640x480:d=1" -frames:v 1 /tmp/is_near.png
ffmpeg -y -f lavfi -i "color=c=blue:s=200x200:d=1" -frames:v 1 /tmp/is_blue.png
ffmpeg -y -f lavfi -i "color=c=green:s=320x180:d=1" -frames:v 1 /tmp/is_green.png
```

### WebUI (required for DONE)

1. Tab opens; **one** sequence list; **no** separate base field; no console errors.  
2. Add four images; first row shows **BASE** styling.  
3. Click rows → preview updates.  
4. **Sort** (`colorhash`, nearest) → order changes; base stays #1; scores visible if shown.  
5. Manually **drag** or ⤒/↓ a non-base row; Run with RIFE M=4 fps=24 → `ok: true`, duration ~`(4*4)/24` s.  
6. Promote another image to top → it becomes base; Sort anchors on it.  
7. RIFE off → keyframe-only shorter clip.  
8. `< 2` images → Sort/Run disabled or `ok: false`.  
9. Mixed aspect ratios → letterbox, no RIFE crash.

### Curl rank + run

```bash
# rank
curl -s -X POST http://localhost:24590/ops/imagesort_rank \
  -H "Content-Type: application/json" \
  -d '{"image_paths":["/tmp/is_base.png","/tmp/is_blue.png","/tmp/is_near.png","/tmp/is_green.png"],"sort_mode":"colorhash"}'

# run (final order; auto_sort false)
curl -s -X POST http://localhost:24590/ops/imagesort_rife \
  -H "Content-Type: application/json" \
  -d '{"image_paths":["/tmp/is_base.png","/tmp/is_near.png","/tmp/is_blue.png","/tmp/is_green.png"],"auto_sort":false,"use_rife":true,"multiplier":4,"fps":24}'
```

---

## 12. Backlog (do not block v1)

1. Shared hash helpers → migrate `media/match.py` / thumbnails.  
2. Shared multi-image list component (facemorph / this tab / withoutbg).  
3. Smarter path order (TSP / embeddings).  
4. Image Pool “send selection here”.  
5. Keyboard reorder / accessibility pass.  
6. Preview via dedicated thumb API if missing.

---

## 13. Non-goals (v1)

- Separate base path field in the UI.  
- Server re-sorting on every Run from the WebUI (`auto_sort` stays false there).  
- Audio; video inputs as keyframes.  
- Chain registry stage for sort.  
- Guaranteed smooth morphs under pure radial sort (manual order is the fix).

---

## 14. Builder checklist

- [ ] `app/image_sort` — modes + rank + conform  
- [ ] `imagesort_rank` (or action=rank) returns ordered_paths + scores  
- [ ] `imagesort_rife` trusts `image_paths`; `auto_sort` default false  
- [ ] Optional RIFE + encode; verbose stdout  
- [ ] WebUI: single list, base styling on #1, no base box  
- [ ] Preview on click; drag + ↑↓ + ⤒⤓ + remove  
- [ ] Sort button → rank → rewrite list  
- [ ] Run with `auto_sort: false`  
- [ ] WebUI verification §11  
- [ ] VERSION DD bump  

**Pattern:** facemorph list UX + rife directory stage + this spec’s ordered-path run contract.
