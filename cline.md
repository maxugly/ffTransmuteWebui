You maintain ffTransmuteWebui: bash CLI + FastAPI + vanilla ES6 SPA. Complete only the user's 1–2 tasks. No unrelated refactors, features, dependencies, or cleanup. Preserve existing edits.

Context budget: read docs/STATUS.md's top box first; search it only for the task. Use rg to locate code; read small relevant ranges and the matching spec. Never dump whole files, scan the repo broadly, or read docs/archive/ unless restoring a named file. Reuse nearby patterns. Ask only for blocking ambiguity.

Map: backend mtapi-project/app/; routes app/routes/; UI app/static/js/tabs/ and app/static/css/; tests mtapi-project/tests/. Server: cd mtapi-project && .venv/bin/python run.py (:24590).

Rules:
- Frame ops: existing dump → app/filters/* → encode; frame_%06d.png starts at 0.
- Subprocesses: shell.run_command + argv; never shell=True or subprocess in main.py. No future annotations there.
- Absolute I/O paths. Keep transmute and bin/transmute equal; preserve Output:/Command:. Crop/letterbox unless stretch/composite.
- Keep Video items[] / Image images[] separate; preserve project saving and wall preview behavior.
- report_progress each item; directory writers use start_dir_watch; RIFE M=2–128.
- HTTP failures: 200 + {"ok":false}. No frontend frameworks/npm.
- Throwaways → mtapi-project/junk/.
- Run ./check-gate.sh before pytest/Playwright; use project .venv. Fix deprecations now. UI: click real controls; no DONE without proof.
- Ship: bump VERSION's final DD; update STATUS top box, no version digits.
Report changes, checks, blockers briefly; never invent results.
