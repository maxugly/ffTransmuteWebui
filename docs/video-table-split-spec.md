# Video Table Column Split Spec (Shipped — see §8 for the standing research tail)

> **Status:** Shipped (bump recorded in changelog) · §8 research directive still open, tracked in STATUS §5.3
> **Scope:** video Big Chart only (`data-mtable="video"` in `mtapi-project/app/static/js/tabs/references.js` + `css/references.css`). Image / Code / YT tables untouched.
> **Iron rule:** existing 14 columns keep their prose byte-identical. All new data lands in additive keys. Nothing is reworded, nothing is deleted.
> **Related:** `docs/video-model-research-prompt-spec.md` (brief format + resolution reporting rule) · `docs/flux_mod_ref.md` (gold-standard brief)

## 1. Goal

Columns that glue hard numbers to prose get split apart: numbers become sortable numeric/badge columns, prose keeps its own text columns. Width and height are always separate fields. Resolution ranges become a Yes/No tier matrix. Result: ~36 columns, most hidden by default, all toggleable.

## 2. Full schema (36 columns)

Existing 14 stay exactly where they are. New columns insert immediately after their text sibling:

| Order | Key | Label | Type | Default |
|---|---|---|---|---|
| 1–2 | `model`, `category` | Model, Category | as-is | visible |
| 3–5 | `released`, `relDate`, `relNote` | Released, Rel Date, Rel Note | text + `YYYY-MM` numeric + text | visible / **hidden** / **hidden** |
| 6–9 | `native`, `natW`, `natH`, `natNote` | Native Training Res, Native W, Native H, Native Note | text + px + px + text | visible / **hidden** ×3 |
| 10–13 | `sweet`, `swW`, `swH`, `swNote` | Sweet Spot…, Sweet W, Sweet H, Sweet Note | text + px + px + text | visible / **hidden** ×3 |
| 14–18 | `max`, `maxW`, `maxH`, `maxFps`, `maxNote` | Max Output, Max W, Max H, Max FPS, Max Note | text + px + px + fps + text | visible / **hidden** ×4 |
| 19 | `upscaled` | Upscaled | text (`4K via upscaler`, else blank) | **hidden** |
| 20–25 | `tier480`, `tier540`, `tier720`, `tier1080`, `tier2k`, `tier4k` | 480p, 540p, 720p, 1080p, 2K, 4K | Yes/No badges (`ref-col-center`) | **hidden** ×6 |
| 26–29 | `dur`, `durMin`, `durMax`, `durNote` | Duration Sweet Spot, Dur Min (s), Dur Max (s), Dur Note | text + sec + sec + text | visible / **hidden** ×3 |
| 30–32 | `fl2v`, `audio`, `crazy` | badges | as-is | visible |
| 33–36 | `strengths`, `weaknesses`, `tips`, `notes` | text | as-is | visible |

## 3. Standards mapping (human-approved assumption)

Bare tier labels file **both** dimensions, assumed landscape:

| Label | W | H |
|---|---|---|
| 480p | 640 | 480 |
| 540p | 960 | 540 |
| 720p | 1280 | 720 |
| 1080p | 1920 | 1080 |
| 1440p | 2560 | 1440 |
| 4K | 3840 | 2160 |

Exceptions (do not assume):
- Bare **`2K`** stays unmapped (QHD vs DCI genuinely ambiguous) unless WxH is stated.
- Any row whose prose says **portrait / vertical / 9:16** gets no landscape assumption (W blank, reason in Note).
- Explicit `WxH` in prose always wins verbatim (even portrait-shaped, e.g. `768x512` → W=768 H=512). Never "correct" orientation.
- Every assumed fill is flagged in the build audit (§7). Original text always survives in the Note column, so no assumption can silently corrupt data.

## 4. Normalization rules

- **Multiple figures** (`480P & 720P`, `720p/1080p`, `768x512 or 960x544`): headline W/H = the **max** figure; the full set stays in Note; tiers reflect full coverage.
- **Ranges** (`5-8s`, `4-30s`, `1-16s`): Dur Min/Max take both ends. Single (`5s`, `40s`) → Min = Max.
- **`or` durations** (`5s or 8s`, `4s or 8s`): Min/Max take both ends.
- **Frames/fps in duration** (`5s (121f @24fps)`): seconds go to Min/Max; frames/fps stay in Dur Note (no separate columns — scope cut).
- **Max FPS** (`up to 50 fps` → 50; `24/30 FPS` → 30; `@30fps` → 30; absent → blank).
- **Sweet headline**: the figure prose marks final/default/delivery (`540p drafts, 720p default, 1080p final` → 1920x1080); ambiguous → max mentioned, audit-flagged.
- **Upscaler extraction**: `1080p + 4K upscaler` → Max W/H = 1920x1080, `upscaled` = `4K via upscaler`. Upscaler-only 4K never enters Max W/H.
- **Unknown** (`Unknown - …`, no figures anywhere): numeric fields blank (`—`, sorts last), prose untouched in Note.

## 5. Tier Yes/No rules

- **Yes** if native/sweet/max *direct* claims cover the tier (ranges light up every covered tier).
- **No** if a stated ceiling excludes it (`720p max native` → 1080p/2K/4K No).
- **Upscaler-only does NOT earn Yes** — `4K Yes` means real 4K.
- Blank only where truly unknown. Tiers reuse `fl2vBadge` renderer + the Yes→blank→No sort mapping.

## 6. Code changes

- `MODELS_COLS`: 22 entries appended per §2 order (narrow `ref-col-center` class on all numeric/tier columns).
- `MODELS_ROWS`: additive numeric keys on all 77 rows (same pattern as `crazy:`).
- `modelRow`: one cell per new column (numbers as plain `ref-cell` spans, tiers via `fl2vBadge`, blanks as `ref-muted —`).
- `modelsSortValue`: numeric branch for the W/H/FPS/seconds/date keys (digit strings sort correctly under the existing `numeric:true` collation; blanks already sort last).
- `isColVisible`: new `DEFAULT_HIDDEN` key set consulted when no stored pref exists (today unseen keys default visible — that would blast 22 columns open on every existing browser).
- CSS: numeric/tier columns get badge-like narrow min-widths; the existing `td > *` 3-line clamp and hover/copy delegation (`cellIndex`-based) cover new cells with zero changes.
- Nothing else: `sortHeaders`, `paintSortableTable`, collapse strips, sticky Model column, banding all key-agnostic.

## 7. Build audit (deliverable alongside the build)

A derived-vs-source table for all 77 rows listing every assumed landscape fill (§3), every ambiguous headline pick (§4), and every cross-bucket conflict (e.g. Kling 2.0 row spans crazy-Yes 2.0/2.1 and crazy-No 2.5 Turbo). Human spot-checks the audit, not 77 rows.

## 8. Standing research directive (not part of the build)

Assumptions above are **interim**. For every model in the table, research actual available resolutions from **(1) the manufacturer/vendor docs** and **(2) a third-party generation-site listing** (fal / Replicate / Segmind / API catalog), then replace assumed fills. Record provenance in the family `_mod_ref.md` `sources` + the audit; table cells stay clean numbers. Run per-family through `video-model-research-prompt-spec.md`, never the whole table in one run. Tracked in STATUS §5.3 until done.

## 9. Verification

- `node --check` clean.
- Browser proof with real clicks: toggle a hidden numeric column on; numeric sorts order correctly with blanks last; tier badge sorts Yes→blank→No; row count still 77; no h-scroll regression beyond the expected wider max; zero console errors.

## 10. Out of scope

Image / Code / YT tables. FPS/frames columns. Aspect-ratio columns. Rewording any existing prose. Research itself (§8 tracks it separately).
