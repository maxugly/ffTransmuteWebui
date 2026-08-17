# AGENTS.md — Root Workspace Directives

> **Scope**: Entire repository  
> **Where we are**: Read **`docs/STATUS.md`** first. It is the only live status and handoff.

## 1. Mission & Roles
Fast, non-destructive video manipulation combining CLI tools, a typed Python backend (FastAPI), and a vanilla SPA WebUI.

- **Spec Writer**: Specs in `docs/`. Do not write code. Do not re-spec shipped work.
- **Builder**: Implement open assignments. Test via browser (click controls) before claiming DONE.
- **Reviewer**: Check diffs against specs and invariants. Do not fix code.

## 2. System Invariants (Non-Negotiable)

1. **Filter Platform (dump → stages → encode)**: All neural/frame ops use `app/video_pipeline.py` bookends and a stage factory in `app/filters/` (`per_frame` or `directory`). Mid-chain: PNG `frame_%06d.png`, start `0`. Never invent a second dump/encode stack.
2. **Safe Subprocesses**: Subprocesses MUST use `shell.run_command` with explicit `argv` lists. NEVER use `shell=True`. No subprocess calls in `main.py`.
3. **Paths & Output**: Absolute paths for all I/O. `transmute` MUST output `Output: <path>` and `Command: <cmd>`. Keep `bin/transmute` in parity with root `transmute`.
4. **Dual Media Pools**: Video and Image pools are strictly separated. Cut uses global Video file + Frame range only. See `docs/video-image-pools-spec.md`.
5. **No Frontend Frameworks**: WebUI uses vanilla HTML5, CSS3, ES6 modules. No npm, React, or Tailwind.
6. **Junk / Scratch Directory**: All throwaways, scripts, weights, and screenshots MUST go in `mtapi-project/junk/`.
7. **Progress Reporting**: Long ops MUST call `report_progress()` every item. Directory binaries writing frames must use `start_dir_watch`. RIFE multiplier is 2–128.
8. **HTTP Ops**: Op failures return HTTP 200 + `{"ok": false}`.
9. **Wall & Previews**: Wall is one prepared JPEG (`first|last` combo). Open project quiet-saves with session.
10. **WebUI Testing**: You MUST use a real browser (Playwright) and click the controls to verify changes. Curl does not prove UI works.

## 3. Versioning & Handoff

- **Ship → update STATUS**: When landing a feature, you MUST bump the `VERSION` file (far-right DD) AND update `docs/STATUS.md` (top header and footer).
- **Session End**: Update the "Shipped this stretch / Next" box at the top of `docs/STATUS.md`.
