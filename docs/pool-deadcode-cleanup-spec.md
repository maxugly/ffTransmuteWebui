# Pool dead-code cleanup — plan before `000.000.7.000`

> **Status:** Spec / assignment only — **not implemented**  
> **Date:** 2026-08-16  
> **Base:** `wip` @ `c4b6216` (`000.000.6.9`)  
> **Goal:** Delete leftovers from the 6.2–6.5 recycle / viewport-lazy path **without** touching the 6.6–6.9 wall.  
> **Executor prompt:** [coder-pool-deadcode-cleanup-prompt.md](archive/coder-pool-deadcode-cleanup-prompt.md)

This is **not** the 7.000 bump. Ship cleanup as **`000.000.6.10`**. Human reviews, then a later pass bumps third segment to 7.000.

---

## 1. Why this exists

6.9 works: one prepared wall JPEG, stable `<img>` tenants, chrome virtualizer, import probe + wall generate. The tree still contains the previous attempts (viewport-lazy knobs, assign-on-recycle helpers, unused card activators). Those confuse the next agent into “fixing” a wall that is already correct.

**Rule:** if `rg` finds a live caller, it stays. No “probably unused.”

---

## 2. Sacred — do not remove, rewrite, or “simplify”

These are the product. Treat a delete here as a failed assignment.

| Keep | Why |
|------|-----|
| `js/pool/wall-thumbs.js` | Stable image identity. Assign-once. Park, don’t clear `src`. |
| `js/pool/virtual-grid.js` | Chrome pool only. Still required. |
| `ensure_wall_preview` / `ensure_wall_pair` / `ensure_wall_previews` | Display JPEGs. |
| `GET /api/thumbnail?which=wall` and `which=wall_pair` | Serve those files. |
| Hash-only GET never ffmpeg | Pay-once. Path= may generate. |
| First + last **H** extract + `.phash` | Match / Find matches / Sequence focus / Cut. **Not** the wall. |
| Settings **First + last wall** | User-facing style switch. |
| Settings **L / M / H** | Still sizes match / first+last, **not** the wall. |
| `repair-queue.js` hash / probe / first+last ensure | Import + Repair Metadata. |
| `forceWallSrc` after thumbs land | Stops “Loading thumbnail…” on new imports. |
| Dual pools (`items[]` vs `images[]`) | Invariant. |
| Sequence.js token strip + Instant RIFE | Out of scope. |
| CatalogIndex / warmer | Out of scope. |
| Filter platform / ops | Out of scope. |

**Do not** remount 791 full cards. **Do not** bring back `thumb-decode-cache.js`. **Do not** clear `img.src` on chrome recycle.

---

## 3. Candidate removals (only after `rg` proof)

Prove **zero live callers** (imports, string refs, HTML ids, `window.*`) before deleting.

### 3.1 Safe-looking (checked 2026-08-16 — re-verify)

| Symbol / UI | Where | Evidence it may be dead | Risk |
|-------------|--------|-------------------------|------|
| `activateVideoCard` | `grid.js` | Defined; no callers | Low |
| `bindVideoRetry` | `grid.js` | Only called from `activateVideoCard`. Card click already delegates `.pool-retry-meta` | Low |
| `imageThumbUrl` | `image-pool.js` | Defined + exported; no other file imports it | Low |
| Settings **Viewport-lazy thumbnails** | `settings.js` | Wall does not use IntersectionObserver. Human asked this path gone | Low **if** `lazy-loader.observe()` has no other live callers |
| `preloadAllThumbnails` alias | `app.js`, `lazy-loader.js` | Only maps old localStorage into viewport-lazy | Low — keep a one-line ignore so old JSON doesn’t crash |
| `assignCardThumbs` on **wall** cards | `freshness.js` via `mtapi.settingsChanged` | Fights `refreshWallTenantSrcs`. Wall tenants use `data-which="wall"` | Medium — retarget, don’t blindly delete |
| FIRST/LAST labels injected onto `.pool-wall` | `chrome.js` `refreshPoolTileOverlays` | Wall is one combo image; labels are leftover dual-frame chrome | Low if scoped to `.pool-wall` only |
| `HANDOFF-6.3-scroll-fix.md` | `docs/` | Historical; 6.3 was superseded | Docs only |

### 3.2 Do **not** delete even if “lazy” is in the name

| Keep | Live use |
|------|----------|
| `lazy-loader.js` `enqueueSignature` / `flushSignatureQueue` | `freshness.js`, `sequence.js` |
| `lazy-loader.js` `recordVariantBatch` | `repair-queue.js`, `sequence.js` |
| `lazy-loader.js` `clearPending` | `grid.js`, `image-pool.js` empty-state |
| `lazy-loader.js` `assignThumbSrc` | Still used by `assignCardThumbs` **if** focus/sequence first+last still go through it |
| `freshness.js` signature / recover helpers | Restore + repair |
| `virtual-grid.js` `recycleCard` | Parks chrome. Must call `detachWallTenant`, never `removeAttribute('src')` |

### 3.3 Explicitly out of scope (leave files alone)

`sequence.js`, Instant RIFE, Cut encode, Jobs, filter platform, `app/media/catalog.py` warmer, match/`phash`, L/M/H extract paths, neural ops.

Docs backlog / TODO-agy / ideas\* — do **not** mass-delete. Only the 6.3 handoff is in-scope if you touch docs.

---

## 4. Required retarget (not optional)

`window` `mtapi.settingsChanged` currently:

1. `persistence.js` → `refreshAssignedPoolThumbs()` → `assignCardThumbs` on every `.pool-card` / `.img-pool-card` `<img>`.
2. `wall-thumbs.js` → `refreshWallTenantSrcs()`.

**After cleanup:** pool wall images update **only** via `refreshWallTenantSrcs` / `forceWallSrc`. `assignCardThumbs` may remain **only** for non-wall imgs (Sequence focus first/last, if those still use `.pool-thumb` + `data-which=first|last`). If `rg` shows wall tenants are the only `.pool-thumb`s in those cards, delete `assignCardThumbs` **after** settings L/M/H still updates Sequence/Cut thumbs another way — or leave `assignCardThumbs` and skip imgs with `data-which="wall"`.

Prefer the skip: `if (img.dataset.which === 'wall' \|\| img.dataset.which === 'wall_pair') return;`

---

## 5. Viewport-lazy knob

**Product lock:** wall is not viewport-lazy. Import prepares; scroll does not start/stop loads.

Allowed:

- Remove the Settings switch and the blurb line about viewport-lazy.
- Stop writing `viewportLazyThumbnails` on new saves.
- Keep reading the key so old `localStorage` / project JSON doesn’t throw.

Not allowed:

- Deleting `lazy-loader.js`.
- Changing hash-only 404 / ensure-queue policy.
- Reintroducing IntersectionObserver on wall tenants.

---

## 6. Phases (separate commits)

| Phase | Commit | What |
|-------|--------|------|
| A | prove-then-delete helpers | `activateVideoCard`, `bindVideoRetry`, unused `imageThumbUrl` — only if `rg` is clean |
| B | settingsChanged / assignCardThumbs | Skip wall tenants; no src fight |
| C | Settings UI | Remove viewport-lazy switch; keep first+last wall + L/M/H |
| D | chrome labels | Do not inject FIRST/LAST on `.pool-wall` |
| E | docs | STATUS 6.5 row no longer describes current wall; optional delete `HANDOFF-6.3-scroll-fix.md`; VERSION **6.10** |

Do not squash into one commit with ops or catalog changes.

---

## 7. Verification — mandatory, or it is not done

Use `/tmp/teste.mp4` and `/tmp/teste.png` (root `AGENTS.md` §D). Playwright or headed Chromium. **Click** the real nav items.

After **each** phase that touches JS/CSS:

| Surface | Prove |
|---------|--------|
| Video Pool | Hard-refresh real project (or 576+ restore). Scroll fast. **Zero** empty `src` on tenants. Combo (or first-only if setting off) still paints. |
| Import | Add a **new** file not already in the pool. Meta fills. Wall leaves “Loading thumbnail…” and shows pixels. |
| Repair Metadata | On a card that still has the button: click works (`pointer-events: auto`). |
| Settings | Toggle **First + last wall**. Width ~240 vs ~120. L/M/H still exists and does **not** change wall URL `which=`. |
| Image Pool | Open tab. If empty, import `teste.png`. One wall thumb. |
| Sequence | Tokens still render. Focus first+last still first/last H, **not** `wall_pair`. Instant RIFE strip not broken (tokens present, no JS error). |
| Cut | Tab opens; range thumbs still `which=first` / `frame=`. |
| Console | No new JS errors (favicon 404 ignored). |

**Rollback:** if any row fails, revert that phase commit. Do not “fix forward” by changing wall-thumbs generate rules.

---

## 8. Done

- `VERSION` = `000.000.6.10`
- STATUS / SESSION / spec_registry updated
- Working tree only contains this cleanup
- Human has not yet said merge or 7.000

**7.000 is a later human decision.** This spec does not bump the third segment.
