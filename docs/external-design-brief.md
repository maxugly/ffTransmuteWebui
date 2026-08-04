# ffTransmute WebUI — Design Brief for External Spec Writers

> **Audience:** Agents / contractors who write feature specs **without** full repo access  
> **Your deliverable:** A concise implementation-ready spec (problem, approach, files, acceptance tests)  
> **Not your deliverable:** Production code (unless later hired as builder)  
> **Last updated:** 2026-08-03  
> **If you have repo access:** also read **`docs/STATUS.md`** (what is already shipped) so you do not re-spec live features.

Use this document as the **contract**. Prefer inventing features that fit these patterns over inventing new architecture.

---

## 1. What this product is

**ffTransmute WebUI** is a local creative video tool:

- Geometry / extract / join via a Bash `transmute` CLI (pixel-exact by default).
- Datamosh / bitstream glitch via `ffgac` + `ffedit` (file-level, not frame PNGs).
- Neural / frame effects (DeepDream, style transfer, RIFE, withoutBG, …) via a **filter platform**.
- Codec convert / frame dump / GIF via **Convert / Export** only.
- A **vanilla** single-page WebUI (no React/npm) talking to a **FastAPI** server (`mtapi-project`, port **24590**).

**Users** work with absolute filesystem paths, media libraries (Video Pool / Image Pool), global video/image bars, and optional frame ranges.

---

## 2. Mental model (one picture)

```text
                    ┌─────────────────────────────────────┐
                    │  WebUI (vanilla JS tabs + global bar) │
                    └─────────────────┬───────────────────┘
                                      │ JSON POST /ops/<id>
                                      ▼
┌──────────────┐   register()    ┌──────────────────────────┐
│ *_ops.py     │◄────────────────│ contract.REGISTRY         │
│ thin HTTP    │                 │ → OperationResult         │
└──────┬───────┘                 └──────────────────────────┘
       │
       ├─ Geometry / glitch ──► CLI (transmute, datamosh) via shell.run_command
       │
       └─ Frame effects ──► dump → filter stage(s) → encode
                              │           │            │
                         video_pipeline  app/filters/*  video_pipeline
                         + JobWorkspace  (effect only)  + convert_presets
```

**Golden rule:** Effects transform **PNG frame sequences on disk**. Bookends (probe / dump / encode / codecs) are **shared**, never reimplemented per feature.

---

## 3. Non-negotiable invariants

When writing a spec, **reject** designs that violate these:

| # | Invariant |
|---|-----------|
| 1 | **Absolute paths** for all media I/O (API + subprocess). |
| 2 | **No `shell=True`** — subprocesses are argv lists (`create_subprocess_exec` / `shell.run_command`). |
| 3 | **Frontend = vanilla** HTML/CSS/ES modules. No npm, React, Vue, Tailwind, webpack. |
| 4 | **Frame effects** use dump → stage → encode. No second ffmpeg dump/encode stack inside a neural op. |
| 5 | **Mid-chain frames:** `frame_%06d.png`, start number **0**, under per-job workspace. |
| 6 | **Geometry default = no scale** unless the user opts into stretch/composite. Prefer crop / letterbox. |
| 7 | **Videos and stills are separate libraries** (`items[]` vs `images[]`). Do not mix. |
| 8 | **Workspace tabs that need a clip + range** (e.g. Cut) use **global Video + Frame range**, not a private path field. |
| 9 | Ops return **`OperationResult`**: business failures are HTTP **200** + `"ok": false` (not random 500s for “file missing”). |
| 10 | Outputs **never overwrite** silently — use unique paths (`_0001`, …). |

---

## 4. Feature taxonomy (pick the right bucket)

Before designing, classify the feature:

| Kind | Examples | Implementation pattern |
|------|----------|------------------------|
| **A. Frame effect** | Neural style, RIFE, per-frame cleanup | `app/filters/<name>.py` factory + thin `*_ops.py` bookends; register for `/ops/pipeline` |
| **B. Bookend / codec** | ProRes, DNxHR, frames_png, GIF | Extend `convert_presets.py` + Convert UI only |
| **C. Geometry / timeline CLI** | Crop, pad, extract, join | Flags on `transmute` CLI + `transmute_ops.py` + docs |
| **D. File-level glitch** | Datamosh melt/classic | Bitstream tools; **not** PNG chain |
| **E. UI-only workspace** | Cut, Notes, Pool toggle | Frontend state + existing APIs; may call thin ops later |
| **F. Still → video utility** | Zoompan | May be special (Pillow/ffmpeg) but still: absolute paths, argv, `OperationResult` |

If unsure: **A** if it changes pixels per frame; **B** if it only changes container/codec; **D** if it mutates compressed bitstream.

### Stage kinds (for A)

- **`per_frame`**: 1 PNG in → 1 PNG out (DeepDream, style transfer, withoutBG).
- **`directory`**: whole folder in/out, may change frame count (RIFE).

Do not force RIFE-style tools into fake per-frame loops.

---

## 5. API & ops shape

- Route: **`POST /ops/<op_id>`** with JSON body (Pydantic model).
- Response: **`OperationResult`** fields conceptually:
  - `ok`, `operation`, `output_path`, `error`, `command`, `stdout`, `stderr`, `dry_run`
- Long jobs: support **cancel/progress** via existing job control (spec should mention cancel mid-run).
- **Dry-run** optional but valued for dangerous/expensive ops.
- **Frame range** (when applicable): 1-based inclusive `start_frame` / `end_frame` on the dump bookend (same convention as datamosh trim).

Do not invent parallel response formats or session-cookie auth models; this is a local trusted tool.

---

## 6. WebUI conventions

- **Tabs** in `index.html` + module under `app/static/js/tabs/<name>.js` (or `js/pool/*` for libraries).
- **Global bars:** Video file(s), Image file(s), Path in/out, optional **Frame range** row (only some tabs).
- **Dual libraries:**
  - Video Pool → videos, sequence stitch, send-to ops.
  - Image Pool → stills, refs for Cut / style / zoompan, etc.
- **Shared UI widgets** prefer reuse:
  - Frame range / steppers (global).
  - Image compare (`separate` / `overlay` / `A/B`) for alignment UIs.
  - DAW-style knobs where continuous params exist.
- **No private video path** on range-driven workspaces — use global Video so probe/range/thumbs stay consistent.
- **Persistence:** session + optional project JSON; if a feature stores library state, dual-save **videos + images** when a project is open.

---

## 7. What a good feature spec must contain

Produce a single markdown spec with these sections (short paragraphs, tables OK):

1. **Problem** — user pain in one paragraph.  
2. **Goals / non-goals** — 3–6 bullets each.  
3. **User story** — primary flow in 5–10 steps.  
4. **Classification** — A–F from §4 + stage kind if A.  
5. **Data & params** — JSON fields, defaults, validation, absolute paths.  
6. **Architecture** — which layers change; **what reuses bookends/filters**.  
7. **Files to touch** — concrete paths (even if approximate):  
   - backend: `operations/`, `filters/`, sometimes `convert_presets.py`  
   - frontend: `static/js/tabs/`, `index.html`, CSS as needed  
   - docs: this feature’s `docs/<name>-spec.md`  
8. **UI sketch** — tab placement, global bar needs, empty/error states.  
9. **Edge cases** — missing file, cancel, 0 frames, huge res, no GPU, mixed video+image inputs.  
10. **Acceptance tests** — must include:
    - Backend: `/tmp/teste.mp4` and/or `/tmp/teste.png` smoke (2s 320×240 test assets).  
    - WebUI: form renders, Run submits, `ok: true` (or clear `ok: false`), **zero JS console errors**.  
11. **Out of scope / follow-ups** — one short list.  
12. **Risks** — e.g. VRAM, ffmpeg version quirks, setpts unreliability (prefer PNG remap for variable speed).

### Spec quality bar

| Good | Bad |
|------|-----|
| “Video: dump → `filters.foo` per_frame → encode; stills: engine.batch” | “Call ffmpeg in the op with a big filtergraph and also in the UI” |
| “Use global Video + frame range” | “Add a second file picker only on this tab for the same clip” |
| “Register stage for `/ops/pipeline`” | “Copy DeepDream’s dump/encode into a new file and tweak” |
| “Vanilla JS module + CSS file” | “Scaffold with Vite + React” |
| “Absolute paths; OperationResult” | “Upload multipart to S3 and return signed URL” |

---

## 8. Existing building blocks (reuse first)

| Need | Use |
|------|-----|
| Probe / dump / encode | `video_pipeline` + `JobWorkspace` |
| Codec / frame dump UI | Convert / `convert_presets` |
| Chain multiple effects | `POST /ops/pipeline` + filter registry |
| Geometry | `transmute` CLI |
| Bitstream glitch | datamosh package / modes |
| Align two images | `js/ui/image-compare.js` |
| Libraries | Video Pool / Image Pool (separate) |
| Frame range | Global bar + `start_frame`/`end_frame` |
| Cancel / progress | `job_control` |
| Safe shell | `shell.run_command` |
| Unique outputs | `pathutil.finalize_output_path` |

**Known pitfall:** variable speed via ffmpeg `setpts` is unreliable across builds — prefer PNG frame remap (see speed ramp).

**Removed:** `PngFramePipeline` — do not specify reintroducing it.

---

## 9. Test assets (canonical)

| Path | Role |
|------|------|
| `/tmp/teste.mp4` | ~2s, 320×240, 24fps, with audio |
| `/tmp/teste.png` | 320×240 still |

Specs should not depend on proprietary media. Optional: larger files only as stretch goals.

---

## 10. Versioning note (for implementers later)

- Feature work: bump far-right segment of `VERSION` (`000.000.X.DD`).  
- Spec writers only need to say “bump VERSION when shipping.”

---

## 11. One-page checklist for the external agent

Before submitting a feature spec, confirm:

- [ ] Bucket A–F chosen and justified  
- [ ] No new frontend framework  
- [ ] No shell=True / relative path design  
- [ ] Frame effect = filter stage + thin op (if applicable)  
- [ ] Convert not abused for neural effects  
- [ ] Dual pool / global-input rules respected  
- [ ] Params table complete  
- [ ] Files-to-touch list present  
- [ ] Acceptance tests include `/tmp/teste.*` + WebUI no-console-errors  
- [ ] Edge cases + non-goals listed  

---

## 12. Template skeleton (copy-paste)

```markdown
# <Feature name> — Spec

> Status: Proposed
> Kind: A|B|C|D|E|F  (stage: per_frame|directory|n/a)

## Problem
## Goals / Non-goals
## User story
## Params (JSON)
## Architecture (reuse bookends/filters?)
## Files to touch
## UI
## Edge cases
## Acceptance tests
## Risks / follow-ups
```

---

*This brief is the outside agent’s source of truth. Deeper as-builts live in-repo (`filter-platform-spec.md`, `video-image-pools-spec.md`, `resolve-transcode-spec.md`) for implementers after the high-level spec is approved.*
