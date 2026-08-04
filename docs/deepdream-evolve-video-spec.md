# DeepDream Evolve Video — Spec

> **Status:** **Implemented (Phase A+B stills)** — `000.000.4.73`  
> Capture + pHash dedupe + encode + optional RIFE on still path. Multi/video/ouro later.  
> **Shared stack:** `app/evolve_video.py` (`build_evolve_video`, `EvolveRifeOpts`, `EvolveRifeParams`) + `js/ui/evolve-rife.js` — Style Transfer Evolve reuses both (`4.74`/`4.75`).  
> **Audience:** Builders & human (product locks below + open questions §11)  
> **Related:** `deepdream-spec.md`, `image-sort-rife-spec.md`, `filter-platform-spec.md`, `workspace-progress-spec.md`, live preview (`/tmp/mtapi_live/`)  
> **Problem:** Ascent often **plateaus** — many mid-steps look identical; Live only keeps **one** overwrite PNG. User wants a **video of the dream evolving**, with **near-duplicates dropped** via Image Sort metrics, optional **RIFE** in-betweens, for **stills / multi / video**.

---

## 1. Goal (product story)

While DeepDream runs, capture a **timeline of meaningful intermediate frames** (the dream “fading in” / evolving), then:

1. **Keep** a frame only if it is **different enough** from the last kept frame (tunable distance + Image Sort metric).  
2. **Toss** near-duplicates / wheel-spinning plateaus (same objective as Image Sort “how different are these two stills?”).  
3. Optionally **RIFE** between kept keyframes to smooth the evolve clip.  
4. **Encode** to `.mp4` (and optionally save the kept stills strip).

```text
source still(s) or video frames
        │
        ▼
  dream_image / per_frame dream   ──► ordered strip of candidate PNGs
        │                              (ascent steps / octaves / ouro steps / video frames)
        ▼
  dedupe (metric + threshold vs last kept)
        │
        ├─ use_rife? ──► run_rife_directory ×M
        │
        ▼
  encode @ fps  →  *_evolve.mp4
  optional: keep kept keyframes as PNGs
```

**Not** a replacement for the final single-image dream export — that remains. This is an **additional product** of the same run (or a dedicated mode).

---

## 2. Why existing Live is not enough

| Today | Gap |
|-------|-----|
| `/tmp/mtapi_live/{token}.png` | **One** file overwritten each publish |
| `latest_frame` for UI | No history, no encode |
| Ouroboros already writes `frames_out/` | Different product (feedback loop), no dedupe metric |
| Image Sort metrics | Exist (`app/image_sort/modes.py`) but not wired to DeepDream |

**Fall-off / stale:** ascent steps keep reporting progress while the **pixels stop changing** (or change &lt; threshold). Dedupe vs **last kept** frame is the right filter.

---

## 3. Locked decisions (v1 defaults — challenge only if you disagree)

| # | Decision | Default |
|---|----------|---------|
| 1 | **Feature name** | **DeepDream Evolve** (UI section + output suffix `_evolve`) |
| 2 | **Where in UI** | DeepDream tab — collapsible **Evolve video** block (not a new sidebar tab) |
| 3 | **Op shape** | Extend `POST /ops/deepdream` with evolve params (one job). Optional later: `deepdream_evolve` alias. |
| 4 | **Candidate capture** | Write **numbered** PNGs under job workspace, e.g. `ws.evolve_candidates/frame_%06d.png` (or `ws.root/evolve_in/`), **not** only the single live overwrite |
| 5 | **When to snapshot** | Same cadence as live publish today: start of live interval + end of each octave + final; plus optional **every N ascent steps** (shared with live) |
| 6 | **Dedupe algorithm** | Reuse `app/image_sort/modes.py` **MODES**: `phash` (default), `ahash`, `colorhash`, `mse`, `ssim` if available |
| 7 | **Dedupe rule** | Sequential **vs last kept** only (chain). First candidate always kept. Drop if `distance(last_kept, candidate) < threshold` |
| 8 | **Threshold** | Float; **metric-dependent**. UI presets per metric (see §6). Default: pHash **≤ 4** = near-dupe (drop) |
| 9 | **RIFE** | Optional `use_rife` + `multiplier` **2–128** (same as Image Sort / RIFE tab); directory stage `filters.rife` |
| 10 | **Encode** | `video_pipeline.encode` bookend; fps user knob (default **12** for evolve — readable morph) |
| 11 | **Include original** | **Yes** as frame 0 of candidates (pre-dream), so fade-in starts from source |
| 12 | **Always keep final** | **Yes** — last dreamed frame always kept even if “near” previous (force-append) |
| 13 | **Multi-image** | Batch: each still → own evolve video next to source (or under batch dir); sequential jobs in one op or N outputs list |
| 14 | **Video input** | **v1:** evolve **per source frame** is expensive — ship **still + ouroboros** first; video evolve = optional phase-2 (see §8) |
| 15 | **Ouroboros** | Candidates = each ouro still **after** dream (already on disk); dedupe + optional RIFE + encode as evolve product **alongside** main ouro video |
| 16 | **Progress** | Phases: `dream` / `capture` / `dedupe` / `rife` / `encode`; `latest_frame` = last kept or last candidate |
| 17 | **Cancel** | Between candidates / between RIFE / normal job_control |
| 18 | **Platform** | No second dump/encode stack; RIFE via existing directory stage |

---

## 4. Pipeline detail

### 4.1 Capture (still path)

Inside / beside `dream_image` when `evolve_enabled`:

```text
ws = JobWorkspace(..., prefix="dream_evolve_")
candidates/
  frame_000000.png   # original (copy of input, conformed if needed)
  frame_000001.png   # first mid snapshot
  ...
  frame_NNNNNN.png   # final deprocess (same as main still output content)
```

Rules:

- Snapshots must be **unique files** (copy/rename from live buffer, not a single overwrite).  
- Live UI can keep updating `/tmp/mtapi_live/{token}.png` **and** append a copy into `candidates/`.  
- Resolution: prefer **consistent size** for RIFE — resize/letterbox all candidates to first frame size (or final full size once known). **Lock: letterbox to final output size** when final is known; if capture mid-run at varying octave sizes, **upscale/letterbox to max side seen** or to input size — see open Q.  

**Proposed lock for v1:** capture all candidates at **current tensor deprocess size**, then **one conform pass** to even W×H of the **final** frame before dedupe/RIFE (reuse Image Sort conform helper).

### 4.2 Dedupe

```python
kept = [candidates[0]]
for c in candidates[1:-1]:
    d = score_fn(kept[-1], c)   # MODES[metric]
    if d >= threshold:          # "different enough"
        kept.append(c)
# always append final
if candidates[-1] not in kept:  # by path identity
    kept.append(candidates[-1])
```

- **Higher distance = more different** (same as Image Sort: pHash Hamming, MSE, 1−SSIM).  
- Threshold semantics: **minimum distance required to keep** (drop if closer than threshold).  
- Log: `kept K of N candidates (metric=phash thr=4)`.

### 4.3 Optional RIFE

```text
kept keyframes → frames_in → run_rife_directory(M) → frames_out → encode @ fps
```

If `use_rife=false`: encode kept frames only @ fps.  
Duration ≈ `len(kept) * M / fps` (M=1 if no RIFE).

### 4.4 Outputs

| Artifact | Path |
|----------|------|
| Final still (existing) | `source_dream.png` (unchanged behavior) |
| Evolve video | `source_dream_evolve.mp4` (or `*_evolve.mp4` next to still) |
| Optional stills | `source_dream_evolve_stills/frame_%06d.png` if `save_evolve_stills` |

**As-built:** `output_path` = **main still** (compat). Evolve path is logged in stdout as `Evolve: …_evolve.mp4` (and appears in the console). UI may open the still; user finds video next to it.

---

## 5. API params (additive on DeepDream)

```text
evolve_enabled: bool = false
evolve_fps: float = 12          # 1–60
evolve_metric: str = "phash"    # MODES keys
evolve_threshold: float = 4     # min distance to keep (metric scale)
evolve_use_rife: bool = false
evolve_rife_multiplier: int = 2 # 2–128
evolve_rife_model / tta / uhd   # same defaults as RIFE tab
evolve_save_stills: bool = false
evolve_capture_every: int = 0   # 0 = use live cadence only; else every N ascent steps (min 1)
```

Existing dream knobs unchanged. When `evolve_enabled=false`, zero behavior change.

### Threshold guidance (UI presets)

| Metric | Soft (keep more) | Default | Hard (keep fewer) | Unit meaning |
|--------|------------------|---------|-------------------|--------------|
| pHash / aHash | 2 | **4** | 10 | Hamming distance (0 = identical) |
| colorhash | 1 | **3** | 8 | Hash distance |
| MSE | 50 | **200** | 800 | Pixel MSE after resize |
| SSIM dist | 0.02 | **0.08** | 0.2 | 1−SSIM |

UI: metric select + threshold knob + short legend “lower threshold → more frames kept”.

---

## 6. UI (DeepDream tab)

**Evolve video** section (after Ouroboros / before About):

- Binary: **Evolve · Off | On**  
- When On:  
  - FPS  
  - Metric select (same labels as Image Sort)  
  - Threshold knob (format by metric)  
  - Use RIFE + Multiplier + model/TTA/UHD (reuse knob pattern from Image Sort)  
  - Save stills · Off | On  
  - Capture every N steps (0 = auto/live cadence)  
- Pre-run hint when On: `evolve: capture → dedupe (phash≥4) → [RIFE ×M] → encode @ F fps`  
- Bottom docs: short “stale plateau” explanation + metric table  
- Tool input preview unchanged  

Run still one button: if evolve on, job does dream + evolve pipeline.

---

## 7. Files to touch (builder checklist)

| File | Change |
|------|--------|
| `operations/deepdream/dream.py` | Append unique candidate PNGs when evolve capture active; hook from `_publish_live_tensor` / octave end / final |
| `operations/deepdream_ops.py` | Params + post-dream: conform → dedupe → optional RIFE → encode; multi-still loop |
| `image_sort/modes.py` | **Reuse only** (no fork) |
| `filters/rife.py` | Reuse directory stage |
| `static/js/tabs/deepdream.js` | Evolve knobs + collect + docs |
| `docs/deepdream-spec.md` | Cross-link evolve |
| `STATUS.md` | Spec → Implemented on ship |

No new sidebar tab. No Python shell=True.

---

## 8. Phased delivery

| Phase | Scope | Ship when |
|-------|--------|-----------|
| **A** | Single still: capture + dedupe + encode (no RIFE) | Core value |
| **B** | + optional RIFE + save stills | Smooth morphs |
| **C** | Multi-still batch | Power user |
| **D** | Ouroboros strip as candidates | Natural fit |
| **E** | Video: evolve montage of **per-frame final dreams** only (not mid-ascent × every frame) | Expensive — explicit opt-in |

**v1 recommendation:** Phase A+B on still; C+D if cheap after A+B; E last.

---

## 9. Pitfalls

| Risk | Mitigation |
|------|------------|
| Octave-resolution mismatch | Conform all to final size before dedupe/RIFE |
| Thousands of near-dupes | Dedupe; cap max candidates (e.g. 500) with log |
| max_loss / stale ascent | Dedupe handles; don’t require perfect ascent |
| Disk fill | Job workspace cleaned after success; optional keep stills |
| Metric scale confusion | Threshold **0 = keep all** (locked) |
| RIFE needs ≥2 frames | If kept &lt; 2 after dedupe, skip RIFE, encode what we have or fail soft with still only |
| Double encode cost | Evolve is opt-in |
| Live overwrite race | Copy to candidates under lock / sequential write |

---

## 10. Verification

1. Still + evolve on, pHash thr=4, no RIFE → `_evolve.mp4` shorter than raw capture count.  
2. thr=0 or very low → more frames kept.  
3. thr high → fewer frames; final still always in strip.  
4. RIFE ×2 → frame count ~ 2× kept.  
5. Evolve off → bit-identical to pre-feature still path.  
6. Console/log: `kept K/N`, phases visible.  
7. Cancel mid-dream → no half-broken silent success.  
8. `/tmp/teste.png` smoke + one real photo.

---

## 11. Product locks (answered — as-built `4.73`+)

| # | Decision | Lock |
|---|----------|------|
| 1 | Fade-in includes **original as frame 0** | Yes |
| 2 | Plateau: keep **first** of near-dups (vs last kept) | Yes |
| 3 | v1 scope | **Single still + optional RIFE** (multi/video/ouro = later phases) |
| 4 | `output_path` | **Still primary**; evolve path in stdout / sibling `*_evolve.mp4` |
| 5 | Capture density | Live cadence + **Every N** knob (0 = auto) |
| 6 | Max candidates | **500** |
| 7 | Default metric / thr | **pHash**, **4** |
| 8 | Threshold 0 | **Keep all** |
| 9 | Dedupe vs original after frame 0 | **No** — only vs last kept |
| 10 | Evolve fps default | **12** |
| 11 | RIFE default | **Off**, M=**2** when on |
| 12 | Audio | **Silent** |
| 13 | Name | **Evolve video** |
| 14 | Save stills default | **Off** |

---

## 12. STATUS

Shipped row: DeepDream Evolve · **`000.000.4.73`**. Style Transfer strength Evolve reuses bookend · **`4.74`**.

---

## 13. Non-goals (v1) — still open backlog

- Training / new networks  
- True optical-flow morph instead of RIFE  
- TSP ordering of intermediates (time order is ascent order only)  
- Streaming evolve encode while dreaming (post-pass after dream is enough)  
- Replacing Ouroboros (complementary)  
- Multi-still / video evolve (phases C–E)

---

## 14. As-built code map (`4.73`–`4.74`)

| Piece | Location |
|-------|----------|
| Shared bookend | `mtapi-project/app/evolve_video.py` |
| Dream capture | `operations/deepdream/dream.py` — `EvolveCapture` |
| Dream op | `operations/deepdream_ops.py` — `evolve_*` params |
| Style strength strip | `operations/styletransfer_engine.stylize_strength_strip` |
| Style op | `operations/styletransfer_ops.py` — evolve path |
| UI | `static/js/tabs/deepdream.js`, `styletransfer.js` |

**Debt:** RIFE evolve knobs duplicated in JS (backend is DRY). Prefer a shared UI fragment before a third consumer.
