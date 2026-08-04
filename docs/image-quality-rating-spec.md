# Image Quality Rating & Filtering — Spec

> **Status:** **Spec only** — not implemented (`STATUS.md` §5)  
> **Audience:** Builders & reviewers  
> **Related:** `STATUS.md`, `video-image-pools-spec.md`, `image-sort-rife-spec.md`, `workspace-progress-spec.md`, digiKam quality tools (inspiration only)  
> **Scope:** Rate stills (primary) and optional video **thumbs**; sort/filter pools by score  
> **Not this:** Full digiKam port · full video stream analysis · auto-delete

---

## 1. Problem

Generated and collected media piles up in **Image Pool** (and video thumbs). Humans need a fast way to:

- Flag **blurry / soft / broken** stills (technical)  
- Rank **looks better / worse** for keepers (aesthetic, optional)  
- **Sort / filter** the pool without opening every file  

Inspiration: digiKam’s quality tools. Implementation: **our** dual-pool persistence + job progress + absolute paths — not a C++/Qt rewrite.

---

## 2. Goals

| # | Goal |
|---|------|
| 1 | **Technical scores** (cheap, always-on path): sharpness, optional exposure extremes |
| 2 | **Aesthetic score** (optional heavy path): pretrained predictor, lazy-loaded |
| 3 | **Combined stars** (1–5) for simple UI filters |
| 4 | Persist on **pool entries** (session + project dual-save) and/or **hash cache** |
| 5 | Progress via `job_control` for batch runs (hundreds of images) |
| 6 | Image Pool (first) + Video Pool cards via **thumbnail frame** only |

### Non-goals (v1)

- Auto-delete or move to trash without explicit user action  
- Analyzing every frame of a video  
- Replacing Image Sort’s visual-similarity modes (different problem; quality can be a **future** rank metric)  
- Requiring CUDA; Intel/CPU must work even if slow for aesthetic  

---

## 3. Score model

### 3.1 Fields (per media entry)

Attach under a stable key so normalize won’t invent parallel schemas:

```json
{
  "path": "/abs/photo.png",
  "name": "photo.png",
  "hash": "…",
  "size": 12345,
  "quality": {
    "version": 1,
    "analyzed_at": "2026-08-03T12:00:00Z",
    "source": "file",
    "blur_var": 145.2,
    "sharpness": 0.72,
    "exposure_flag": "ok",
    "aesthetic": 6.4,
    "stars": 4,
    "engine": "laplacian+laion_aes_v1"
  }
}
```

| Field | Type | Meaning |
|-------|------|---------|
| `blur_var` | float | Laplacian variance (raw). **Higher → sharper.** Not comparable across wildly different resolutions without normalize. |
| `sharpness` | float 0–1 | Normalized sharpness for UI (see §3.2) |
| `exposure_flag` | enum | `ok` \| `dark` \| `bright` \| `unknown` (histogram heuristics) |
| `aesthetic` | float \| null | Model score (often ~1–10). **null** if aesthetic pass skipped / failed |
| `stars` | int 1–5 | Combined rank for filters |
| `engine` | str | Which pipelines produced the scores (debug) |
| `source` | str | `file` \| `thumb` (video used a range thumb) |

### 3.2 Technical engine (OpenCV) — **P0, no new heavy deps**

`opencv-python-headless` is already in `requirements.txt`.

**Sharpness — Laplacian variance**

```python
gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
# Optional: downscale long side to e.g. 1024 for stable cost / comparable scores
blur_var = float(cv2.Laplacian(gray, cv2.CV_64F).var())
```

**Normalize to `sharpness` ∈ [0,1]** (v1 heuristic — document as tunable):

```text
# log-ish map; clamp. Tune on /tmp/teste.png vs a motion-blurred copy.
sharpness = clamp( log1p(blur_var) / log1p(BLUR_REF), 0, 1 )
# BLUR_REF ≈ 500–2000 depending on resize policy — pick one resize policy and freeze it.
```

**Exposure (cheap)**

- Convert to gray, mean / percentiles  
- `dark` if mean &lt; T_lo; `bright` if mean &gt; T_hi; else `ok`  

**Noise** — defer v1.1 (high-frequency residual or BRISQUE if we accept an extra model).

### 3.3 Aesthetic engine (optional) — **P1**

CLIP-based aesthetics predictors (e.g. LAION aesthetics / `shunk031/aesthetics-predictor-*`) are fine **if**:

- Lazy-loaded on first use (never on server import)  
- Batch size 1–4  
- Device: CUDA if present, else CPU (honest slow). OpenVINO conversion is **out of scope v1** unless already trivial.  
- First download reflected in progress (`phase=model_load`)  

**Do not** hard-require aesthetic for “Run quality” — allow:

| Mode | What runs |
|------|-----------|
| `tech` | Laplacian + exposure only |
| `full` | tech + aesthetic |
| `aesthetic` | aesthetic only (re-use cached tech if present) |

Default button: **`tech`** (fast, no multi-GB download). Advanced: full.

### 3.4 Stars combination (v1 formula)

```text
# Prefer explicit, boring, tunable weights
if aesthetic is not None:
  a = (aesthetic - 1) / 9          # map ~1–10 → 0–1 (clamp)
  s = 0.45 * sharpness + 0.55 * a
else:
  s = sharpness

# Exposure penalty
if exposure_flag in (dark, bright): s *= 0.85

stars = clamp(round(1 + 4 * s), 1, 5)
```

Ship formula version in `quality.version` / `engine` so we can re-rate later.

---

## 4. Architecture (this repo)

### 4.1 Wrong vs right paths

| Draft said | Reality |
|------------|---------|
| `pool_manager.py` | **`app/media/pool.py`** (+ routes in `app/routes/pool.py` or `media.py`) |
| Mystery `metadata` bag | Dual pools: `items[]` videos, `images[]` stills — extend **entry dicts** carefully |
| One-shot fire | Long batches need **`job_control`** token + progress |

### 4.2 Critical: normalize currently drops extra fields

As-built `_normalize_media_entries` in `pool.py` keeps only:

```text
path, name, hash, size
```

**Any quality fields written into pool state will be wiped on the next load/normalize** unless builders **extend normalize** to preserve `quality` (and ideally `hash` for cache keys).

**Required change:**

```python
out.append({
    "path": key,
    "name": ...,
    "hash": ...,
    "size": ...,
    "quality": it.get("quality"),  # pass-through if dict
})
```

Same for project JSON dual-save (`savePoolStateNow` / projects).

### 4.3 Optional content-hash cache

Under media cache (pattern like thumbs):

```text
~/.cache/mtapi/by_hash/{hash}/quality_v1.json
```

- Skip re-analysis if file mtime/size/hash matches and `engine` version matches  
- Pool entry can copy from cache on import  

### 4.4 Modules

| Module | Role |
|--------|------|
| `app/media/quality_engine.py` | Pure: load image path → quality dict (tech / full) |
| `app/media/quality_cache.py` | Optional hash cache R/W |
| `app/routes/…` or pool route | `POST /api/pool/analyze_quality` |
| `app/media/pool.py` | Preserve `quality` in normalize |
| `js/pool/image-pool.js` (+ video grid) | Button, badges, sort/filter |
| `js/pool/persistence.js` | Dual-save includes quality |

### 4.5 API

`POST /api/pool/analyze_quality`

```json
{
  "kind": "image",
  "paths": ["/abs/a.png", "/abs/b.png"],
  "mode": "tech",
  "force": false
}
```

| Field | Notes |
|-------|--------|
| `kind` | `image` \| `video` \| `all` — which pool list to update |
| `paths` | Optional subset; empty → all entries of kind in **current session pool** (server load) **or** client sends full path list (prefer client-owned list so UI selection works) |
| `mode` | `tech` \| `full` \| `aesthetic` |
| `force` | Ignore cache / existing quality |

**Response:** `OperationResult`-like or pool-shaped:

```json
{
  "ok": true,
  "analyzed": 12,
  "skipped": 3,
  "failed": [{"path": "…", "error": "…"}],
  "results": [
    {"path": "/abs/a.png", "quality": { … }}
  ]
}
```

Client merges into `state.imagePool` / `state.pool` and **dual-saves**.

**Progress:** register job token (same pattern as long ops); report every image:

```text
phase=quality  current=i  total=N  unit=images
message=a.png  stars=4  sharp=0.71
```

Absolute paths only.

### 4.6 Video policy

- Do **not** dump the video.  
- Score **`GET /api/thumbnail?path=&which=first`** (or frame 1) as `source: "thumb"`.  
- Label UI: “thumb quality” so users don’t think the whole clip was graded.

---

## 5. WebUI

### 5.1 Image Pool (primary)

| Control | Behavior |
|---------|----------|
| **Analyze quality** | Selected rows if any; else all images in pool |
| Mode toggle | Tech (default) / Full |
| Sort | Name · Sharpness · Aesthetic · Stars (desc/asc) |
| Filter | Stars ≥ N · Hide dark/bright · Hide unanalyzed |
| Card badge | `★4` or `S .72` when `quality` present; muted if missing |

### 5.2 Video Pool (secondary)

Same badge from thumb analysis; lower priority.

### 5.3 Persistence

- Session: `~/.cache/mtapi/pool_state.json`  
- Project: `images[]` / `items[]` must include `quality` after dual-save  
- F5 must not drop scores (normalize + dual-save tests mandatory)

---

## 6. Implementation phases

### Phase A — Tech only (shippable alone)

1. Extend pool normalize to keep `quality`  
2. `quality_engine.analyze_tech(path) → quality dict` (resize policy frozen)  
3. `POST /api/pool/analyze_quality` mode=`tech` + progress  
4. Image Pool button + sort by sharpness/stars + badge  
5. Dual-save + F5 test  

### Phase B — Aesthetic

6. Lazy aesthetic model + mode=`full`  
7. Model download progress  
8. Stars use aesthetic when present  

### Phase C — Polish

9. Hash cache  
10. Video thumb analyze  
11. Filter chips · bulk “select stars ≤ 2”  
12. Optional: Image Sort **mode** `quality` (rank by stars vs base? or global sort only — product call; default **pool-only**)  

---

## 7. Dependencies

| Need | Status |
|------|--------|
| OpenCV | **Already** `opencv-python-headless` |
| Pillow | **Already** |
| torch / transformers | Needed only for Phase B; may already exist for DeepDream etc. — **do not** add if unused in Phase A |
| digiKam | **Not** a runtime dependency |

---

## 8. Pitfalls

| Pitfall | Mitigation |
|---------|------------|
| Normalize strips `quality` | Extend `pool.py` **first** |
| Scores incomparable at different resolutions | Always resize long side to fixed max before Laplacian |
| Aesthetic model multi‑GB first download | Phase A default; progress on load; cache weights |
| RAM spike on batch aesthetic | Batch 1–4; free tensors; optional `gc` |
| Treating video thumb as whole-clip grade | `source: thumb` + UI label |
| Stars feel random | Publish formula; allow re-run with `force` after tuning |
| Blocking event loop | Run CV/model in `asyncio.to_thread` |
| Relative paths | Resolve absolute; reject missing files per item, don’t fail whole batch |

---

## 9. Verification

### Assets

```bash
# sharp-ish
ffmpeg -y -f lavfi -i "testsrc=duration=1:size=320x240:rate=1" -vframes 1 /tmp/q_sharp.png
# blurry
ffmpeg -y -i /tmp/q_sharp.png -vf "gblur=sigma=8" /tmp/q_blur.png
```

### Checks

1. Analyze both → `q_sharp` higher `blur_var` / `sharpness` / stars than `q_blur`  
2. Progress ticks per image on a 10+ list  
3. Sort Image Pool by sharpness reorders cards  
4. F5: scores still present (session + open project dual-save)  
5. `force=false` second run skips or is fast via cache  
6. Console clean; no full-batch fail if one path missing  

**DONE (Phase A)** = tech scores + pool UI sort/filter + persistence.  
**DONE (Phase B)** = full mode aesthetic + stars blend.

---

## 10. Relationship to digiKam

| digiKam idea | We do |
|--------------|--------|
| Detect blur / reject soft | Laplacian variance + threshold via stars/filter |
| Aesthetic / “quality” DL | Optional CLIP aesthetics (Phase B) |
| Pickers / albums | Image Pool filters — not digiKam albums |
| C++ Qt engine | Python OpenCV + optional torch |

Do not claim “digiKam-compatible scores.” Different scale, different resize.

---

## 11. One-line summary

**Cheap OpenCV sharpness (and exposure) on every pool still, optional neural aesthetics later; persist `quality` on dual-pool entries (fix normalize first); sort/filter Image Pool with stars — not a full digiKam clone.**
