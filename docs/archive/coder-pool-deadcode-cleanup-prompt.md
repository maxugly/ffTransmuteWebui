# Coder Prompt — Pool dead-code cleanup (`000.000.6.10`)

> **Target:** ffTransmuteWebui / `wip` @ **`c4b6216` or later 6.9**  
> **Role:** Builder (codewhale / codex / opencode / grok)  
> **Kind:** **One-shot assignment** — product is locked. You delete leftovers. You do **not** redesign the wall.  
> **Plan (authoritative):** [pool-deadcode-cleanup-spec.md](pool-deadcode-cleanup-spec.md)  
> **Wall contract:** [pool-wall-preview-spec.md](pool-wall-preview-spec.md)  
> **Verification:** root `AGENTS.md` §D. No DONE without a clicked browser smoke.

---

## What “one-shot” means

You get one complete assignment. Do not ask “should we delete virtual-grid?” — **no.** Do not ask “should wall go back to first+last `<img>`s?” — **no.**

If `rg` shows a live caller, **keep the symbol**. Note it in the commit message. Do not guess.

This is **not** one giant commit. Phases A→E in the spec, each committed, each smoked if it touches JS/CSS.

**Stop** if you would change: dump/encode, match/pHash, Sequence Instant RIFE, CatalogIndex, or wall generate rules.

---

## MISSION

Remove dead recycle / viewport-lazy leftovers from the 6.2–6.5 era so 6.9’s wall is the only thumb story.

Ship as **`000.000.6.10`**. **Do not** bump to `000.000.7.000`. **Do not** merge to `main`. **Push only if the human asked.**

---

## LOCKED DECISIONS

| # | Lock |
|---|------|
| 1 | Wall stays: one JPEG (`wall_pair` default, `wall` optional), stable `<img>` per path, chrome virtualizer. |
| 2 | Scroll never clears `src`. Recycle chrome only (`detachWallTenant`). |
| 3 | Hash-only `/api/thumbnail` never ffmpeg. Path= may generate. |
| 4 | First+last **H** + pHash stay for match / Sequence focus / Cut. |
| 5 | Settings keep **First + last wall** and **L/M/H**. Remove **Viewport-lazy** switch only. |
| 6 | `rg` proof before every delete. No “looks unused.” |
| 7 | Prefer skip-wall in `assignCardThumbs` over deleting freshness.js. |
| 8 | VERSION far-right DD → **6.10**. STATUS + SESSION + spec_registry. |
| 9 | Junk / screenshots → `mtapi-project/junk/` only. |

---

## DO NOT TOUCH

```
js/pool/wall-thumbs.js          (behavior — you may add a comment, not rewrite)
js/pool/virtual-grid.js         (keep; recycleCard must not clear img.src)
app/media/thumbnails.py         wall_* + extract_frame first/last
app/media/catalog.py            except you must not
js/pool/sequence.js
Instant RIFE / job-control
Cut encode / range thumbs
app/filters/* , *_ops.py
```

Do not recreate `thumb-decode-cache.js`. Do not mount all cards. Do not set `content-visibility: auto` on `.pool-card`.

---

## DO THIS (phases)

Read the spec §3–§6. Summary:

**A.** Delete `activateVideoCard` + `bindVideoRetry` if still uncalled. Delete `imageThumbUrl` if still unimported.

**B.** `assignCardThumbs`: return immediately when `data-which` is `wall` or `wall_pair`. Settings change for wall style stays on `refreshWallTenantSrcs`.

**C.** Remove Settings checkbox `settingsViewportLazy` and its blurb sentence. Keep parsing old `viewportLazyThumbnails` / `preloadAllThumbnails` so load doesn’t throw. Do not delete `lazy-loader.js`.

**D.** `chrome.js` `refreshPoolTileOverlays`: do not inject FIRST/LAST onto `.pool-frames.pool-wall`. Sequence focus labels stay.

**E.** Docs + VERSION 6.10. Fix STATUS 6.5 row so it does not claim “stale-pixel clearing” is current wall behavior. Optional: delete `docs/HANDOFF-6.3-scroll-fix.md` and drop it from spec_registry if present.

Before each delete:

```bash
rg -n 'SYMBOL' --glob '!docs/backlog/**' --glob '!docs/TODO*' --glob '!docs/ideas*'
```

If any hit outside the definition + this spec/prompt, **keep it**.

---

## VERIFICATION (copy the spec table)

After every JS/CSS phase, headed or Playwright, **click** nav:

1. Video Pool — scroll a real/large pool; thumbs stay; no new JS errors.  
2. Import a **new** file (`/tmp/teste.mp4` copy with a new name). Meta + wall pixels. Not stuck on “Loading thumbnail…”.  
3. Settings — toggle First + last wall (240 vs 120). L/M/H still there. No viewport-lazy switch.  
4. Image Pool — stills still show.  
5. Sequence — tokens + focus first/last (not wall_pair).  
6. Cut — tab still works.

If a phase fails: `git revert` that commit. Do not change wall generate to “fix” a cleanup bug.

---

## DONE

- [ ] Each phase committed  
- [ ] `000.000.6.10` in VERSION, STATUS header + §7, SESSION header  
- [ ] spec_registry notes 6.10 cleanup  
- [ ] Browser table passed  
- [ ] Human has a sentence: what was deleted, what `rg` blocked  

You never merge to main. You never ship 7.000.
