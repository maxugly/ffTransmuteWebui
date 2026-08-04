# Tool Bottom Docs — Spec

> **Status:** **Partial** — Image Sort pilot **shipped** (`000.000.4.54` era); other tabs open  
> **Audience:** Builders & reviewers  
> **Pilot tab:** Image Sort (`js/tabs/imagesort.js` + `.tool-docs` in `forms.css`)  
> **Related:** `STATUS.md`, `image-sort-rife-spec.md`, `rife-spec.md`, `style-css-map.md`  
> **Not this:** Top-of-panel one-liners (`.dream-hint`), knob-row legends — those stay short.  
> **Shipped with pilot:** bottom-docs UI + chain strategy docs copy on Image Sort.

---

## 1. Goal

Every tool that has non-obvious knobs eventually gets a **long description block at the bottom of its action panel**, after:

1. Title / short hint  
2. Inputs, lists, directories  
3. Settings / knobs / selects  
4. **Then → About / reference docs**

Users should not hunt tooltips or leave the app to learn what **TTA**, **UHD**, **CRF**, a RIFE model, or a sort mode actually do.

**Pilot:** Image Sort only. Other tabs adopt the same shell later with their own copy.

---

## 2. Product rule (locked)

| # | Rule |
|---|------|
| 1 | **Long explanations live at the bottom** of the tool panel — never between knobs, never replacing the top one-liner. |
| 2 | Top of panel stays dense: title + one short `.dream-hint` (what the tool does). |
| 3 | Inline legends (`.knob-row-legend`, `.form-row-hint`) stay **short** (one line / phrase). Deep meaning goes to the bottom block. |
| 4 | Bottom block is **scrollable with the panel** (normal document flow). Not a modal, not a separate tab. |
| 5 | Copy is **honest and practical** — what it does, when to use it, cost (time/VRAM/quality), default recommendation. No marketing fluff. |
| 6 | Terms are **shared** across tabs where the same knob exists (TTA/UHD/CRF/RIFE models). Image Sort is the source of truth for the first full set; RIFE / Speed can reuse the same wording later. |
| 7 | Bottom-docs copy alone does not change ops. **Chain strategy** is a separate rank feature (see `image-sort-rife-spec.md` §6) — document it here when present. |

---

## 3. UI shell

### 3.1 Placement in Image Sort

Current render order in `imagesort.js` (after this work):

```text
pre-run summary
title + short dream-hint
stills list + order bar
output path
mode / strategy / order / fit selects
knob row (Use RIFE, Multiplier, TTA, UHD, FPS, CRF, …)
RIFE model select
────────────────────────────  ← separator
.tool-docs  (About this tool)  ← NEW, last
```

### 3.2 Markup pattern

Shared class names (reuse on every tab later):

```html
<section class="tool-docs" aria-label="About this tool">
  <h4 class="tool-docs-title">About · Image Sort</h4>
  <p class="tool-docs-lede">…one paragraph overview…</p>

  <h5 class="tool-docs-h">Sort strategy</h5>
  …

  <h5 class="tool-docs-h">Distance metric (Mode)</h5>
  <dl class="tool-docs-dl">
    <dt>pHash</dt>
    <dd>…</dd>
    …
  </dl>

  <h5 class="tool-docs-h">Order</h5>
  …

  <h5 class="tool-docs-h">RIFE models</h5>
  …

  <h5 class="tool-docs-h">TTA</h5>
  …

  <h5 class="tool-docs-h">UHD</h5>
  …

  <h5 class="tool-docs-h">CRF</h5>
  …
</section>
```

Optional later: collapse/expand (`<details>`) if the panel feels tall. **v1 = always expanded** so the copy is discoverable without a click.

### 3.3 CSS (`forms.css` or small `tool-docs.css`)

Keep dense and muted — match existing form typography:

| Class | Intent |
|-------|--------|
| `.tool-docs` | Top border or subtle separator; `margin-top: 14px`; `padding-top: 12px`; muted text |
| `.tool-docs-title` | Small uppercase section label (like `.dream-section-title`) |
| `.tool-docs-lede` | Slightly larger body (~0.78rem), 2–4 lines max |
| `.tool-docs-h` | Term group heading |
| `.tool-docs-dl` | `dt` bold/primary-muted; `dd` muted, compact line-height |
| `dt` / `dd` | No giant spacing; `margin` tight so it fits a long scroll |

Do **not** introduce a new design language (no cards, no icons required).

### 3.4 Code ownership

| File | Change |
|------|--------|
| `app/static/js/tabs/imagesort.js` | Strategy select; Sort body; `tool-docs` HTML at end of form |
| `app/static/css/forms.css` (or `tool-docs.css` + link in `index.html`) | `.tool-docs` styles |
| `app/image_sort/rank.py` | `strategy=radial\|chain` |
| `app/operations/imagesort_rife_ops.py` | `sort_strategy` on rank + auto_sort |
| Optional: `app/static/js/ui/tool-docs.js` | Only if a second tab needs a shared renderer soon; **not required for pilot** |

Copy may live as a template literal in `imagesort.js` for the pilot. If a third tab needs the same RIFE paragraphs, extract a shared string module then — do not over-abstract on day one.

---

## 4. Image Sort — canonical copy

Builders should paste (or lightly wrap) this text. Wording is part of the product contract; tweak only for grammar/layout.

### 4.1 Lede (overview)

> **Image Sort → Video** turns a pile of stills into one clip. Slot **#1 is the base**: first keyframe, conform size reference, and start of Sort. **Sort** reorders #2…N using a **distance metric** (what “similar” means) and a **strategy** (how those scores become an order). You can still reorder by hand after. Optional **RIFE** invents in-between frames between keyframes, then the sequence is encoded at your chosen **FPS**. Duration is not a knob — it falls out of keyframe count × RIFE multiplier ÷ FPS.

### 4.2 Sort strategy (how order is built)

**Same procedure family, two shapes.** Metrics only change the distance math; strategy changes the ranking shape.

| UI label | id | Algorithm | When results look different |
|----------|-----|-----------|------------------------------|
| **To base** | `radial` | Score every still **only against #1**, then sort by that score. | Mid-list frames can jump relative to each other: both “near base” but far from each other. Good for “spread from this hero.” **Default (as-built).** |
| **Closest next** | `chain` | Start at #1. Repeatedly append the unused image **closest to the current end** (or farthest, if Order says so). Greedy nearest-neighbor walk. | Each step is locally smooth — usually better for RIFE morphs. Can still end with a big hop if early choices used up the bridges. **Not** a perfect global tour. |

Example (base A, stills B near A, C near B but far from A, D near A):

- **To base:** A → B → D → C (C last because far from A, even though C would blend after B).  
- **Closest next:** A → B → C → D (after B, C is the natural next; D is picked later).

Scores shown after Sort:

- **To base:** distance of each row to **base**.  
- **Closest next:** distance of each row to the **previous** row (step cost).

### 4.3 Distance metric (Mode)

All metrics plug into **either** strategy. Lower score = closer. **Scores are not comparable across metrics** (different units) — only the order within one metric matters.

| UI label | id | What “similar” means | How order tends to differ vs the others |
|----------|-----|----------------------|----------------------------------------|
| **pHash** | `phash` | Perceptual structure / layout (DCT hash). Mild regrades still look close. | **Default.** Same pose, different grade → usually near. Same colors, different subject → usually far. |
| **aHash** | `ahash` | Coarse bright/dark grid. Faster, cruder. | Often **same rough order** as pHash; more random swaps on busy/noisy images. Draft pass. |
| **colorhash** | `colorhash` | Palette / color mood more than shape. | Same subject regraded → may rank **far**. Different subject, same colors → may rank **near**. Mood-board sequences. |
| **MSE** | `mse` | Pixel mean-squared error (resized ~256 long side). | Tightest on near-duplicates / burst frames. Small crop or exposure bump can rank worse than a different but globally similar image. |
| **SSIM** | `ssim` | Structure (`score = 1 − SSIM`). | Like softer MSE: lighting/blur drift hurts less. Needs `scikit-image` (omitted from API if missing). |

**Order** (direction; works with both strategies):

| UI label | id | **To base** | **Closest next** |
|----------|-----|-------------|------------------|
| **Nearest first** | `nearest_first` | Closest to base first. | Greedy **closest** unused next. Best default for smooth morphs. |
| **Farthest first** | `farthest_first` | Most different from base first. | Greedy **most different** next (contrast walk / jump energy). |

### 4.4 Fit (brief — include under “Conform” if space allows)

| UI | Meaning |
|----|---------|
| **Letterbox** | Fit inside base WxH; black bars. No crop. **Default.** |
| **Crop** | Cover base frame; center crop. Fills frame, may lose edges. |
| **Stretch** | Force exact WxH. Distorts aspect — only if you want that. |

### 4.5 RIFE models

Engine: **`rife-ncnn-vulkan`**. Models ship as folders (e.g. under the system model path). This app exposes four:

| Model | Character | Prefer when |
|-------|-----------|-------------|
| **rife-v4.6** | Newest of the four we expose. Cleanest edges, best general motion. | **Default.** Almost always. |
| **rife-v4** | Solid v4 line; slightly older / sometimes a bit faster. | v4.6 glitches on a specific clip; A/B quality. |
| **rife-v2.4** | Older architecture. Different artifact style. | Experimentation; rare content that “likes” older flow. |
| **rife-v2.3** | Oldest / often fastest of the set. | Max speed, draft previews, weak GPU. |

Higher model number is not always “better for every frame,” but **v4.6 is the right default** for Image Sort morphs. Multiplier (2–8) multiplies keyframes ≈×M; quality cost and time rise with M more than with model pick.

### 4.6 TTA (Test-Time Augmentation)

- Maps to `rife-ncnn-vulkan` **spatial TTA** (`-x`).
- Runs the network on flipped/augmented views and merges — usually **cleaner** interpolation, roughly **~2× slower**, more VRAM.
- **Default: Off.** Turn on for hero exports or when you see shimmering/ghosting on edges.
- Temporal TTA (`-z` on the binary) is **not** exposed in the WebUI; do not document as if it were.

### 4.7 UHD

- Maps to **UHD mode** (`-u`).
- Helps high-resolution sources (roughly **4K and up**) so RIFE does not thrash or quality-collapse on large frames. Uses more VRAM / can be slower.
- **Default: Off.** Leave off for HD and below. On for 4K stills or when the base is UHD-sized after conform.
- Not a “make it sharper” button for 720p — it is a resolution-path mode.

### 4.8 CRF (Constant Rate Factor)

- x264-style **quality** for the final encode (this stack uses libx264-style CRF through the encode bookend).
- **Lower = higher quality / larger file.** Higher = smaller / softer.
- **Useful scale in this UI (knob 0–28):**
  - **0** — effectively lossless (huge files; rare need).
  - **15–18** — near-lossless / archival / heavy post.
  - **18** — **default** (excellent for most morphs).
  - **20–23** — good web delivery, still clean.
  - **24–28** — smaller files; visible softness if you push it.
- CRF does **not** change duration, FPS, or RIFE quality — only how hard the encoder compresses the finished frames.

### 4.9 Other knobs (short entries; optional subsection)

| Control | One-paragraph meaning |
|---------|------------------------|
| **Use RIFE** | Off = each still is one frame at FPS (slideshow). On = neural in-betweens between consecutive keyframes. |
| **Multiplier** | Only with RIFE. Target ≈ K×M frames (K = still count). 2 = double density; 4–8 = smoother/slower morph, much more work. |
| **FPS** | Absolute playback rate of the output. Not scaled by M. More frames + same FPS = longer clip. |
| **Keep PNG** | Leave job workspace frames on disk for debug. Off by default. |
| **Dry run** | Plan only — no encode. |

---

## 5. Suggested rendered text (v1 paste block)

Builders may use this as a single HTML string (ids optional for deep-linking later):

**Title:** About · Image Sort  

**Lede:** (section 4.1)

**Sort strategy**

- **To base (default)** — Rank each still only by distance to #1. Simple “how close to the hero.” Mid-list frames can still jump relative to each other.  
- **Closest next** — Walk the set: after #1, pick the closest unused image to the current end, then repeat. Locally smoother for RIFE. Not a perfect global path; late jumps can still happen.  

Metrics (Mode) only change what “distance” means; strategy changes the shape of the list.

**Distance metric (Mode)**

- **pHash (default)** — Structure/layout. Best general “looks like” for photos; mild regrades still near.  
- **aHash** — Coarser brightness hash. Fast draft; more accidental swaps. Prefer pHash for final.  
- **colorhash** — Color mood. Same pose regraded may rank far; same palette different subject may rank near.  
- **MSE** — Pixel error. Best for near-duplicates / burst frames; harsh on crop/exposure.  
- **SSIM** — Structural similarity (score = 1 − SSIM). Softer than MSE when lighting drifts.  

Same Mode under different strategies often yields different orders — not “just different math for the same list.”

**Order:** Nearest = prefer small distance (smooth). Farthest = prefer large distance (contrast). Applies to both To base and Closest next.

**RIFE models**

- **rife-v4.6 (default)** — Cleanest general quality of the models we ship.  
- **rife-v4** — Stable alternate on the v4 line.  
- **rife-v2.4 / rife-v2.3** — Older; try only if you want a different look or more speed.  

**TTA** — Spatial test-time augmentation (`-x`). Cleaner frames, ~2× slower, more VRAM. Off by default; on for final exports.

**UHD** — High-res path (`-u`) for ~4K+ bases. More VRAM. Off for HD and below.

**CRF** — Encode quality. Lower = better / bigger. **0** ≈ lossless; **18** default near-lossless; **23** smaller web; higher = softer. Does not change motion or length.

---

## 6. Implementation checklist (builder)

### Bottom docs

- [ ] Add `.tool-docs` styles (separator + typography).  
- [ ] Append About section to `renderImageSortForm()` **after** last control row.  
- [ ] Use canonical copy from §4–§5 (include strategy + metric result differences).  

### Chain strategy (see `image-sort-rife-spec.md` §6)

- [ ] Backend: `sort_strategy: radial | chain` on rank (+ auto_sort path).  
- [ ] `rank_images_full` / chain helper; scores = step distance under chain.  
- [ ] UI: Strategy select (**To base** / **Closest next**); Sort + `collectImageSortBody` send `sort_strategy`.  
- [ ] Curl smoke: small set where radial and chain orders **differ**.  

### Shared

- [ ] Panel scrolls; knobs work; console clean.  
- [ ] Bump root `VERSION` far-right DD.  
- [ ] WebUI: open Image Sort, Sort with Closest next, confirm order + About text.  

---

## 7. Follow-ups (out of scope for pilot)

| Item | Note |
|------|------|
| RIFE tab bottom docs | Reuse TTA / UHD / model paragraphs; drop sort modes. |
| Speed / Convert | CRF shared wording; their own ledes. |
| Shared `tool-docs.js` | Extract when second tab copies the same block. |
| Collapsible sections | Only if users complain about height. |
| True TSP / embeddings | Out of scope; chain is greedy only. |
| AGENTS.md rule line | After pilot lands: one bullet under WebUI invariants — “Long tool docs = bottom of panel (`.tool-docs`).” |

---

## 8. Non-goals

- Tooltips on every knob (bottom block is enough for v1).  
- Opening external wiki / markdown files at runtime.  
- Translating OpenAPI `description` fields into the SPA.  
- Changing RIFE flags or CRF defaults.  
- Optimal TSP tour (chain is deliberately greedy / local).

---

## 9. Verification

1. Open WebUI → **Image Sort**.  
2. Scroll past knobs/model → **About · Image Sort** covers strategy, metrics (with result differences), RIFE models, TTA, UHD, CRF.  
3. Strategy **Closest next** + Sort on a set where chain ≠ radial → list order matches greedy walk.  
4. Console clean; Run still works.  

**DONE for builder** = bottom docs visible + chain works + VERSION bumped.  
**DONE for spec writer** = this document + image-sort §6 accepted (no code claim).
