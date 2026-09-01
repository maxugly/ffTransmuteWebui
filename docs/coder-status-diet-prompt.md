# Coder prompt — STATUS is a map, not a diary

> **Branch:** `wip` (not `main`)  
> **Base:** `43aa23f` or later (`000.000.7.005`)  
> **Kind:** Docs only. One job.  
> **Owner of this pass:** Agy  
> **Not this pass:** `AGENTS.md` (other agent). FastSAM code/specs (kilo). App code. As-built rewrites.

---

## What we want

`docs/STATUS.md` answers **where we are now**.  
`docs/archive/changelog.md` answers **what we shipped, version by version**.

An agent that reads STATUS first must not spend the context window on Instant RIFE `4.83`–`4.90` or scrollbar width. Those facts stay in git + changelog.

---

## Do

1. **Create** `docs/archive/changelog.md`
   - First line: `> **Archive — not law. STATUS.md is where we are now.**`
   - Move the **version diary** out of STATUS §3: every row that is a DD bugfix / polish / “how we got here” (roughly Instant RIFE `4.83`–`4.90`, thumb/lazy `5.15`–`5.28`, chrome `5.29`–`5.35`, dead-code passes, settings polish, etc.).
   - Keep the rows as a table: Area | Notes | Ver. Do not invent new history. Cut-paste, then group lightly by theme if it helps. Do not rewrite the product.

2. **Rewrite STATUS §3** as a **shipped-by-area** table. One row per area. Current product only. Use this locked table (you may fix a path if `rg` shows a better spec name; do not add diary rows back):

| Area | Now | Spec / code |
|------|-----|-------------|
| Filter platform | dump → `app/filters/*` → encode. No second dump/encode stack. | `filter-platform-spec.md` |
| Convert / Export | codecs, `frames_*`, GIF | `convert_ops.py`, `convert_presets.py` |
| Transmute / datamosh | geometry CLI + file-level glitch | `transmute_ops.py`, `operations/datamosh/` |
| Neural / frame ops | deepdream, withoutbg, style, facemorph, img2img, txt2img, upscale, qr_art, FastSAM-s/x (Phase 1) | `*_ops` + `filters/` |
| RIFE | directory stage; multiplier **2–128**; recohere (2 stills → M=2 → img2img every mid, keep all) | `filters/rife.py`, `rife-recoherence-spec.md` |
| Speed | uniform + PNG ramp; optional RIFE | `speedchange_ops.py`, `speedramp_ops.py` |
| Dual pools + Cut | Video `items[]` vs Image `images[]`. Cut = global Video + frame range + encode. | `video-image-pools-spec.md` |
| Pool wall | one prepared JPEG (first\|last combo default); stable `<img>`; never clear `src` | `pool-wall-preview-spec.md` |
| Sequence / Join | stitch; codec export (file→file for DNxHR/ProRes); Instant RIFE; variants; total time | `sequence_*.md` under `docs/` |
| Catalog | server-resident index + virtualizer (chrome recycle; wall tenants stay) | `server-memory-catalog-spec.md` |
| Jobs / progress | in-memory FIFO; live preview; dir watch on frame writers | `job_queue.py`, `workspace-progress-spec.md` |
| Persistence | desk snapshot; open project quiet-saves with session | `universal-persistence-spec.md` |
| Agent + Prompt Library | CLI/HTTP vision; ± pairs in `localStorage` | `agent-vision-tab-spec.md`, `prompt-library-spec.md` |

Keep one **Active ops** line under the table (the existing registry list). Drop “Root `AGENTS.md`” as if it still holds that table.

3. **STATUS §4** — keep real partials only. Remove **Pre-7.000 dead-code cleanup** (it is shipped). Do not add new partials.

4. **STATUS §5**
   - §5.1 priority queue: **only things a human might still assign.** Drop rows that are already Implemented (job-queue v1, universal-persistence). FastSAM Phase 2 stays **deferred — do not build** (do not retitle it “ready”). Do not edit FastSAM specs.
   - §5.2 “Recently shipped” → move into changelog. Replace with one line: `Version diary: [archive/changelog.md](archive/changelog.md).`
   - §5.3 research: keep.
   - §5.4: keep **open** product specs. Move Implemented-only rows (nav-collapse, evolve, image-compare) to the §3 area table or changelog. Do not leave “Implemented” sitting in a “still to implement” list.
   - §5.5 backlog: keep the “human priority only” list. It is a map of drafts, not a diary.

5. **STATUS §6** — keep **open** bugs only. Move the struck-through fixed items into changelog.

6. **STATUS §7** — set VERSION to **`000.000.7.006`**. One sentence: STATUS is now a map; diary is `docs/archive/changelog.md`.

7. **STATUS §8** — drop strikethrough “already shipped” lines. Keep the live choices (partials, quality rating vs tilagup, agent polish, backlog only with human OK).

8. **STATUS top box** — add a row: docs STATUS diet `7.006`. Next stays **human names the next job** unless the human changed it.

9. **`docs/README.md`**
   - Delete **At a glance** (second changelog).
   - Delete **Kickoffs (historical / builder)** (those files live in `archive/`).
   - Canonical table: as-built specs + STATUS + archive pointer. Drop process leftovers (`docs-slim-plan`, `pool-deadcode-cleanup`, slim prompt) from the *canonical* list; one line under archive is enough.
   - Point at `archive/changelog.md`.

10. **`docs/archive/README.md`** — add one row for `changelog.md`.

11. Bump root `VERSION` to `000.000.7.006`.

12. After moves: `rg` for old phrasing that still claims STATUS is the diary (“handoff on stops”, “AGENTS registry”). Fix live files only. Archive may stay stale.

---

## Do not

- Do not touch `AGENTS.md`.
- Do not touch FastSAM: `filters/fastsam.py`, `fastsam_ops.py`, `fastsam.js`, `fastsam-*-spec.md`, `coder-fastsam-multimodel-prompt.md`.
- Do not rewrite `filter-platform-spec.md`, `pool-wall-preview-spec.md`, `video-image-pools-spec.md`.
- Do not invent product status. If a fact is only in a diary row and you are unsure it is still true, put it in changelog, not §3.
- Do not merge to `main`. Do not commit app code.
- Do not start Pass 4 (shortening as-built specs).

---

## Done

- STATUS §3 is ~15 area rows, not 90 version rows.
- `docs/archive/changelog.md` exists and holds the cut diary.
- `VERSION` is `000.000.7.006`.
- A new agent can read AGENTS + STATUS and know **now**, then open changelog only if they care about `4.86`.
