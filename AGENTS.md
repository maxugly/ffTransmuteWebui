# AGENTS.md — Root Workspace Directives

> **Scope**: Entire repository  
> **Where we are**: Read **`docs/STATUS.md`** first. It is the only live status and handoff.  
> **Diary** (not law): `docs/archive/changelog.md`. Do not read `docs/archive/` unless restoring a named file.

## 1. Mission & Roles

Fast, non-destructive video manipulation: bash CLI + FastAPI (`mtapi-project`) + vanilla SPA.

Hats for a turn. The human names who wears which hat in the prompt.

- **Spec writer**: `docs/` only. Do not write app code. Do not re-spec shipped work.
- **Builder**: implement open assignments. Browser-click before claiming DONE.
- **Reviewer**: report vs spec. Do not fix.

**As-built (on demand):** `docs/filter-platform-spec.md` · `docs/pool-wall-preview-spec.md` · `docs/video-image-pools-spec.md`

## 2. System Invariants (Non-Negotiable)

1. **Filter platform**: neural/frame ops are dump → `app/filters/*` (`per_frame` or `directory`) → encode. Mid-chain PNG `frame_%06d.png`, start `0`. Never invent a second dump/encode stack.
2. **Subprocesses**: `shell.run_command` + argv lists. NEVER `shell=True`. No subprocess in `main.py`.
3. **Paths**: absolute I/O. `transmute` prints `Output:` and `Command:`. Keep `bin/transmute` in parity with root `transmute`.
4. **Pixel integrity**: transmute defaults to crop (`-c`) or letterbox (`-b`). Do not scale unless stretch (`-x`) or composite.
5. **Dual pools**: Video (`items[]`) and Image (`images[]`) stay separate. Cut = global Video + frame range only. If a named project is open, pool saves also write that project (`items[]` + `images[]`). Session autosave never overwrites a named file on its own.
6. **Wall**: one prepared JPEG (first|last combo default). Assign `src` once. Never clear `img.src` because a shell was reused. Wall JPEGs are not pHash/match sources.
7. **No frontend frameworks**: vanilla HTML5 / CSS3 / ES6. No npm, React, Tailwind.
8. **Junk**: throwaways, weights, screenshots → `mtapi-project/junk/` only.
9. **Progress**: `report_progress()` every item. Directory frame-writers use `start_dir_watch`. RIFE M is 2–128.
10. **HTTP ops**: failures are HTTP 200 + `{"ok": false}`.
11. **`main.py`**: do not add `from __future__ import annotations` (breaks dynamic routes).
12. **WebUI proof**: Playwright, click the real control. Curl is not UI proof.

## 3. Versioning & Handoff

- **Ship**: bump root `VERSION` (far-right DD) and the STATUS **top box** (what shipped / next). Do not copy the version digits into STATUS. Diary goes in `docs/archive/changelog.md`.
- **Session end**: update the **Shipped this stretch / Next** box at the top of `docs/STATUS.md`.
