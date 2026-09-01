# Image Sort + Optional RIFE — Spec

> **Status:** **Implemented** (as-built) including chain strategy + bottom docs + M **2–128**  
> **Shipped:** `000.000.4.41`+ feature; polish through densify / list-keys / folder list / pre-run; **chain + tool-docs + mult 128** ~`000.000.4.54`  
> **Audience:** Builders & reviewers  
> **Op ids:** `imagesort_rank` → `POST /ops/imagesort_rank`; `imagesort_rife` → `POST /ops/imagesort_rife`  
> **Related:** `STATUS.md`, `filter-platform-spec.md`, `rife-spec.md`, `tool-bottom-docs-spec.md`, `workspace-progress-spec.md`  
> **UI pattern:** Single multi-image list; Strategy **To base** / **Closest next**; bottom `.tool-docs`; shared order bar

---

## 1. Goal

Turn an unordered set of stills into a smooth video:

1. User builds one **ordered list** of stills. **Slot #1 (index 0) is the base** (first keyframe + sort start + conform size reference).
2. **Sort** reorders items **2…N** using a **distance metric** (`sort_mode`) and a **strategy** (`sort_strategy`: radial vs chain). Base stays #1 unless the user later moves it.
3. **Manual reorder** — after sort (or instead of sort), user drags / buttons the list; **preview** the selected row.
4. **Conform** every keyframe to the base size (letterbox default).
5. Optionally **RIFE** to multiply frames between keyframes.
6. **Encode** at a chosen **fps**. Total duration is **not** a knob — it falls out of keyframe count × multiplier × fps.

```text
single ordered list  (UI: [base★, …items…])
      │
      ├─ [Sort] ──► rank by metric + strategy (radial | chain); rewrite list order in UI
      │
      ├─ [manual reorder] ──► select row → shared ⤒↑↓⤓ / arrows + Ctrl+arrows; click → preview
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

### Quality honesty

| Strategy | What it optimizes | Honesty |
|----------|-------------------|---------|
| **`radial`** (default, as-built) | Distance of each still **only to the base** | Not a path through the set — later frames can jump relative to each other even if both are “near base.” |
| **`chain`** (new) | Greedy **nearest next** (or farthest next): start at base, repeatedly append the unused image closest to the *current* end | Locally smooth steps; **not** a global shortest tour (TSP). Can still paint itself into a corner and end with a big jump. |

Manual reorder always remains for fixing residual jumps before RIFE. Out of scope: true TSP / embeddings / learned metrics.

**Metrics vs strategy:** `sort_mode` (pHash, MSE, …) only defines *distance*. `sort_strategy` defines *how those distances become an order*. Same metric, different strategy → often very different sequences.

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
  image_sort/                    # pure ranking + conform (no HTTP, no RIFE, no UI)
    __init__.py
    modes.py                     # mode registry + score functions
    rank.py                      # rank_images / rank_images_full
    conform.py                   # conform_image(src, dst, w, h, fit)
  filters/rife.py                # run_rife_directory only
  video_pipeline.py              # encode only
  job_workspace.py
  operations/
    imagesort_rife_ops.py        # thin run + imagesort_rank
  static/js/tabs/imagesort.js    # list + sort + reorder + preview + collect
  static/js/ui/list-keys.js      # arrows select · Ctrl+arrows reorder (shared)
```

| Module | Owns | Does not own |
|--------|------|----------------|
| `image_sort` | Scores, sort, conform helpers | Job dirs, RIFE, SPA state |
| `filters.rife` | Directory RIFE pass | Sorting / UI order |
| `imagesort_rife_ops` | Validate ordered paths, workspace, optional RIFE, encode, rank-only JSON | Second RIFE binary path |
| `imagesort.js` | List, base badge, selection, shared order bar, Sort, collect body | Server-side ranking math (calls API) |

### Reuse vs redo

| Piece | Action |
|-------|--------|
| Facemorph / withoutbg **list UI** (`fm-list`, + Images / + Folder) | **Reuse pattern** — base styling + **shared** order bar (not per-row buttons). CSS: `.fm-*`, `.is-row`, `.is-base`, `.is-selected`. |
| Folder expand | **`GET /api/images/list?path=`** (alias `/api/facemorph/list`); fallback `GET /api/pool/scan?kind=image`. |
| `filters.rife.run_rife_directory` | **Reuse** |
| `JobWorkspace` + `video_pipeline.encode` | **Reuse** (`mux_audio=False`) |
| Hash modes | Implemented in `image_sort.modes` (not coupled to thumb cache). Optional later: share with `media/thumbnails`. |
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
| `image_paths` | `list[str]` | required | Current list; `[0]` is base / chain start |
| `sort_mode` | enum | `"phash"` | Distance metric — §6 |
| `sort_order` | enum | `"nearest_first"` | `nearest_first` \| `farthest_first` — §6 |
| `sort_strategy` | enum | `"radial"` | **`radial`** \| **`chain`** — §6.1 |

**Behavior:** reorder paths with metric + strategy; return:

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
  "stdout": "rank phash chain nearest_first: base + 2 targets …"
}
```

**Score meaning in `items`:**

| Strategy | `score` on each target |
|----------|-------------------------|
| `radial` | Distance **to base** |
| `chain` | Distance **to previous image in the chain** (step cost). Base still `null`. |

UI replaces its list with `ordered_paths` (preserve names/thumbs by path). Verbose `stdout` always.

If rank is folded into one op, return the same payload when `action="rank"` (still `ok` / HTTP 200).

### 5.4 Run params (`ImageSortRifeParams`)

| Field | Type | Default | Notes |
|-------|------|---------|--------|
| `image_paths` | `list[str]` | required | **Final** order from UI (after sort + manual tweaks) |
| `image_dir` / `input_path` | optional | | Fallback collect only if paths empty |
| `sort_mode` | enum | `"phash"` | Used **only if** `auto_sort=true` |
| `sort_order` | enum | `"nearest_first"` | Same |
| `sort_strategy` | enum | `"radial"` | Same; only when `auto_sort=true` |
| `auto_sort` | `bool` | `False` | Headless/curl convenience: re-rank before conform. **WebUI always sends `false`** after client Sort + manual order. |
| `use_rife` | `bool` | `True` | Off ⇒ keyframes only |
| `multiplier` | `int` | `2` | `2..128`; ignored if RIFE off. High M on 2 stills = long morph; list length K is uncapped |
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

## 6. Distance metrics + rank strategies

### 6.0 Two independent axes

| Axis | Param | Values | Meaning |
|------|-------|--------|---------|
| **Metric** | `sort_mode` | `phash`, `ahash`, `colorhash`, `mse`, `ssim` | *What* “distance” means (structure, color, pixels, …) |
| **Strategy** | `sort_strategy` | `radial` (default), `chain` | *How* distances become a list order |
| **Direction** | `sort_order` | `nearest_first` (default), `farthest_first` | Prefer small vs large distance at each choice |

**Metrics are not different “sort algorithms.”** They share one strategy pipeline and only swap the distance function. Strategy is the algorithm shape; metric is the math inside.

### 6.1 Strategies

#### `radial` — distance to base (as-built)

```text
base = paths[0]  # fixed #1
for each other path: score = distance(base, path)
sort others by score  (asc if nearest_first, desc if farthest_first)
order = [base] + sorted others
```

- Each image is judged **only against #1**, not against its neighbors in the final list.
- Good for “spread out from this hero frame.”
- Weak for RIFE morphs when two mid-list frames are both near base but far from each other → visible jump.

#### `chain` — greedy nearest (or farthest) next (**new**)

Also called **nearest-neighbor path**, **greedy walk**, **closest-next**.

```text
chain = [paths[0]]          # base starts the walk; never leaves slot #1
remaining = set(paths[1:])
while remaining:
    current = chain[-1]
    pick = argmin/argmax distance(current, r) over r in remaining
            # nearest_first → min distance; farthest_first → max
            # ties: stable by path string
    chain.append(pick)
    remaining.remove(pick)
order = chain
```

- Step 1: closest (or farthest) to **base**.
- Step 2: closest (or farthest) to **that** image among what’s left.
- And so on — always “best next from where we are,” never re-score against base only.
- **O(K²)** distance evals worst case (fine for UI lists; K is tens, not thousands). Optional: cache hashes for hash metrics so each image is hashed once.
- **Not** global optimal tour (TSP). Late frames can still force a long hop if the “local” path used up the smooth bridges early.

| `sort_order` under `chain` | Behavior |
|----------------------------|----------|
| `nearest_first` | Smooth morph path — **default recommendation when RIFE is on** |
| `farthest_first` | Maximally different next step — jump-cut / contrast walk |

### 6.2 Distance metrics (registry)

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

| Mode | Distance | Dependency | Result character (same strategy) |
|------|----------|------------|----------------------------------|
| `phash` | Hamming on perceptual hash | `imagehash` | Structure/layout. Mild grade changes still “near.” **Default.** |
| `ahash` | Hamming on average hash | `imagehash` | Coarser than pHash; more accidental ties/swaps on busy images. |
| `colorhash` | Color hash distance | `imagehash.colorhash` | Palette-led. Same pose, different grade can rank far. |
| `mse` | Mean squared error (~256 long side) | numpy + Pillow | Near-duplicates / same-clip frames. Harsh on crop/exposure. |
| `ssim` | `1 - SSIM` | skimage (optional) | Structure-friendly; softer than MSE on lighting drift. |

**How results differ in practice** (metric only; strategy fixed):

| Situation | pHash / aHash | colorhash | MSE / SSIM |
|-----------|---------------|-----------|------------|
| Same pose, heavy regrade | often still near | may rank far | often far (pixels/structure shift) |
| Same colors, different subject | often far | may rank near | far |
| Consecutive burst frames | usually near | if color stable, near | **tightest** clustering |
| Noisy / textured stills | aHash less reliable than pHash | ok if palette clear | MSE noisy |

Scores are **not comparable across metrics** (units differ). Only order within one metric matters.

### 6.3 Code API

```python
# existing — keep for radial
rank_images(base, targets, mode, order) -> list[RankedItem]

# preferred single entry (both strategies)
rank_images_full(
    paths, mode="phash", order="nearest_first", strategy="radial"
) -> RankResult

# chain implementation (new helper ok)
rank_images_chain(paths, mode, order) -> list[RankedItem]
# score on each RankedItem = step distance from previous
```

Builder notes:

1. Extend `rank_images_full(..., strategy: Literal["radial","chain"] = "radial")`.
2. `imagesort_rank` + `auto_sort` path on `imagesort_rife` pass `sort_strategy` through.
3. Unknown strategy → `ok: false` with clear error.
4. UI: new `<select id="isSortStrategy">` next to Mode / Order:

| label | value |
|-------|--------|
| To base | `radial` |
| Closest next | `chain` |

5. Sort button body: `{ image_paths, sort_mode, sort_order, sort_strategy }`.
6. Persist strategy with other Image Sort knobs when universal persistence lands.

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

### 9.2 Sequence list (as-built)

**State:** `state.imageSort = { images: [{ path, name, score? }, …], folder, selected }`  
Index `0` is always **base**. `selected` indexes the row that shared order buttons act on.

**List rows (no per-row button stack):**

```text
[01] name.png  BASE     ← selected highlight when selected === 0
[02] other.png
...
```

**Shared order bar (below list):**

```text
Selected: #02 · other.png   [⤒] [↑] [↓] [⤓] [✕]
```

| Element | Behavior |
|---------|----------|
| Ordinal | 1-based display (`01`, `02`, …) |
| Base badge | Row `0` only: class `is-base` + **BASE** badge (italic name) |
| Click row | Set `selected` + `showPreview(path)` (global preview panel) |
| Shared ⤒ / ↑ / ↓ / ⤓ / ✕ | Act on **selected** row only (not duplicated per row) |
| Keyboard | **Arrows** → move selection; **Ctrl+arrows** → reorder selected item (`list-keys.js`) |
| + Images / + Folder / Sort / Clear | Toolbar under list |
| + Folder | Expand via **`GET /api/images/list?path=`** (then re-render list) |

**Rules:**

- Promoting any row to top (⤒) makes it the base (conform + future Sort anchor).
- Sort **keeps** current index 0 fixed; only reorders `1..N-1`.
- Empty / single-item: disable Sort; Run needs ≥2 images.
- After rank response, rewrite list order; show score as muted subtitle when present.
- **No HTML5 drag-and-drop** in v1 (backlog).

**CSS:** `forms.css` — `.fm-list`, `.is-row`, `.is-base`, `.is-selected`, `.is-order-bar`, dense form chrome.

### 9.3 Preview

- **Click** or keyboard-select a row → `showPreview(path)` (main media viewer), not a private pane in the form.
- Preview updates after reorder / sort when selection is preserved by path.

### 9.4 Other controls

Dense form rows / knob rows (project-wide densify):

| Control | Maps to |
|---------|---------|
| Sort mode / **strategy** / order / fit | selects (packed on one row) — strategy: **To base** / **Closest next** |
| **Sort** button | `POST /ops/imagesort_rank` → replace list order |
| **Use RIFE** + multiplier / TTA / UHD / model | RIFE knobs; model row when RIFE on |
| FPS / CRF / keep frames / dry run | encode knobs |
| Output path | optional Save As |
| **Run** | `POST /ops/imagesort_rife`, `auto_sort: false` |

Duration estimate in header: `~${(K * (useRife?M:1) / fps).toFixed(2)}s`.

### 9.5 Collect body

```js
{
  image_paths: state.imageSort.images.map(i => i.path),
  auto_sort: false,
  sort_mode, sort_order, sort_strategy,  // strategy used by Sort UI + auto_sort only
  use_rife, multiplier, model, tta, uhd,
  fps, fit, output_path, crf, keep_frames, dry_run
}
```

Sort button JSON:

```js
{ image_paths, sort_mode, sort_order, sort_strategy }
```

No `base_image` key. Prefer expanded `image_paths` after folder import (do not rely on deferred `image_dir` alone).

### 9.6 Wiring

- `js/tabs/imagesort.js` — `renderImageSortForm`, `collectImageSortBody`, list + `registerListKeys('imagesort', …)`  
- `app.js` — nav **Image Sort**, import, run  
- `job-control.js` — `collectImageSortBody` → op `imagesort_rife`  

---

## 10. Files (as-built)

| Path | Role |
|------|------|
| `app/image_sort/__init__.py` | Package exports |
| `app/image_sort/modes.py` | Mode registry |
| `app/image_sort/rank.py` | `rank_images` / `rank_images_full` / **chain strategy** |
| `app/image_sort/conform.py` | `conform_image` |
| `app/operations/imagesort_rife_ops.py` | `imagesort_rank` + `imagesort_rife` |
| `app/operations/__init__.py` | Import |
| `app/routes/meta.py` | `GET /api/images/list` (+ facemorph list alias) |
| `app/static/js/tabs/imagesort.js` | Tab UI |
| `app/static/js/ui/list-keys.js` | Keyboard list nav/reorder |
| `app/static/css/forms.css` | List + dense chrome |
| `app/static/app.js` / `index.html` / `job-control.js` | Nav + run wiring |
| Root `VERSION` / `AGENTS.md` | Registry row |

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
2. Add four images (or **+ Folder** → list populates via `/api/images/list`); first row shows **BASE** styling.  
3. Click rows → selection + global preview updates.  
4. **Sort** (`colorhash`, nearest, **To base**) → order changes; base stays #1; scores = distance to base.  
5. **Sort** again with **Closest next** on a set where chain ≠ radial → order differs; scores = step distances.  
6. Select a non-base row; use shared **⤒ / ↑ / ↓ / ⤓** or **Ctrl+arrows**; Run with RIFE M=4 fps=24 → `ok: true`, duration ~`(4*4)/24` s.  
7. Promote another image to top → it becomes base; Sort starts from it.  
8. RIFE off → keyframe-only shorter clip.  
9. `< 2` images → Sort disabled / Run `ok: false`.  
10. Mixed aspect ratios → letterbox, no RIFE crash.

### Curl rank + run

```bash
# rank radial (default)
curl -s -X POST http://localhost:24590/ops/imagesort_rank \
  -H "Content-Type: application/json" \
  -d '{"image_paths":["/tmp/is_base.png","/tmp/is_blue.png","/tmp/is_near.png","/tmp/is_green.png"],"sort_mode":"colorhash","sort_strategy":"radial"}'

# rank chain (greedy closest next)
curl -s -X POST http://localhost:24590/ops/imagesort_rank \
  -H "Content-Type: application/json" \
  -d '{"image_paths":["/tmp/is_base.png","/tmp/is_blue.png","/tmp/is_near.png","/tmp/is_green.png"],"sort_mode":"colorhash","sort_strategy":"chain"}'

# run (final order; auto_sort false)
curl -s -X POST http://localhost:24590/ops/imagesort_rife \
  -H "Content-Type: application/json" \
  -d '{"image_paths":["/tmp/is_base.png","/tmp/is_near.png","/tmp/is_blue.png","/tmp/is_green.png"],"auto_sort":false,"use_rife":true,"multiplier":4,"fps":24}'
```

---

## 12. Backlog (post-v1)

1. Shared hash helpers → migrate `media/match.py` / thumbnails onto `image_sort.modes`.  
2. Shared multi-image list component (facemorph / this tab / withoutbg / styletransfer).  
3. True TSP / embeddings (beyond greedy **chain**).  
4. Image Pool “send selection here” / from global image bar.  
5. HTML5 **drag-and-drop** reorder (keyboard + shared bar already ship).  
6. Persist Image Sort list + knobs in desk/project snapshot (see universal persistence work).  
7. Tool bottom docs UI (`tool-bottom-docs-spec.md`) if not shipped with chain.

**Done since original draft:** keyboard select/reorder (`list-keys.js`); folder expand via `/api/images/list`; shared order bar; dense UI.

---

## 13. Non-goals (v1)

- Separate base path field in the UI.  
- Server re-sorting on every Run from the WebUI (`auto_sort` stays false there).  
- Audio; video inputs as keyframes.  
- Chain registry stage for sort.  
- Guaranteed smooth morphs under pure radial sort (manual order is the fix; prefer **chain** when RIFE is on).  
- Optimal TSP tour (chain is greedy only).  
- Per-row control buttons / drag-and-drop (replaced by selection + shared bar + keyboard).

---

## 14. Builder checklist

### As-built

- [x] `app/image_sort` — modes + rank + conform  
- [x] `imagesort_rank` returns `ordered_paths` + scores  
- [x] `imagesort_rife` trusts `image_paths`; `auto_sort` default false  
- [x] Optional RIFE + encode; verbose stdout  
- [x] WebUI: single list, base styling on #1, no base box  
- [x] Preview on select (`showPreview`); shared ⤒↑↓⤓✕ bar  
- [x] Arrows select · Ctrl+arrows reorder  
- [x] + Folder → `/api/images/list` populates list  
- [x] Sort button → rank → rewrite list  
- [x] Run with `auto_sort: false`  
- [x] VERSION / STATUS registry  

### Landed (~4.54)

- [x] `sort_strategy: radial | chain` on rank + auto_sort  
- [x] UI Strategy select: **To base** / **Closest next**  
- [x] Chain scores = step distance to previous  
- [x] Bottom `.tool-docs` on Image Sort  
- [x] RIFE multiplier **2–128** (list length still uncapped)  

**Pattern:** facemorph-style multi-image list + rife directory stage + client-owned ordered-path run contract.
