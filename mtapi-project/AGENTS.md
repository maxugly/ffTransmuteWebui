# AGENTS.md — mtapi-project Backend & Web Server Agent Directives

> **Scope**: Subdirectory `/home/m/snc/cod/ffTransmuteWebui/mtapi-project`
> **Audience**: Autonomous AI Agents working on the FastAPI app, dependencies, and execution entrypoints.

---

## 🎯 1. Mission & Purpose

`mtapi-project` transforms CLI-based video rendering tools into a typed, RESTful HTTP microservice. It serves an interactive single-page Web application, exposes machine-readable OpenAPI specifications (`/openapi.json`), handles asynchronous subprocess execution, and manages a persistent media cache.

---

## 📁 2. Directory Architecture

```
mtapi-project/
├── run.py                 # Server startup (uvicorn :24590; sets TFHUB_CACHE_DIR)
├── requirements.txt       # fastapi, TF, dlib, withoutbg, tensorflow-hub, …
├── README.md              # API overview
├── AGENTS.md              # This file
├── app/
│   ├── job_control.py     # Cancel + progress for long ops
│   ├── pathutil.py        # Sequential never-overwrite output paths
│   ├── operations/        # transmute, datamosh, deepdream, facemorph, withoutbg, styletransfer
│   └── static/            # WebUI
└── bin/                   # transmute, datamosh.sh, ffglitch JS
```

---

## 🔒 3. Architectural Rules & Invariants

1. **Self-Contained Binaries**:
   - `app/shell.py` resolves CLI tools from `mtapi-project/bin/` by default (configurable via `MTAPI_BIN_DIR`).
   - Binaries in `bin/` MUST maintain operational parity with root CLI scripts.
2. **Unified Response Model**:
   - Every operation endpoint MUST return an instance of `OperationResult` (`app/contract.py`).
   - Operational failures (e.g., ffmpeg error, bad input format) MUST return HTTP status `200 OK` with `"ok": false` and error details in `error` / `stderr`. HTTP 4xx/5xx is reserved strictly for malformed client requests or unhandled server crashes.
3. **No Direct Subprocess Spawning in `main.py`**:
   - Subprocess creation for operations must be routed through `app/shell.py:run_command` or dedicated operation handlers in `app/operations/`.

---

## 🛠️ 4. Common Agent Tasks & Workflows

### Builder Agents

Two autonomous coding agents available for implementation work. Both read
AGENTS.md and follow the same rules. Use one per session — do not run both
on the same file at the same time.

| Agent | CLI | Browser tools | How to launch |
|-------|-----|---------------|---------------|
| **CodeWhale** | `codewhale` (TUI) | Playwright MCP (`mcp_mcp_browser_*`) | `codewhale` in terminal, paste prompt |
| **OpenCode** | `opencode` (TUI) | Playwright MCP | `opencode` in terminal, paste prompt |

Extraction prompts work with either agent. For browser smoke tests, use the
agent's native Playwright MCP tools — never `web.run` or `web_search`.

### A. Running the Server
```bash
# Prefer venv
.venv/bin/python run.py

# Live-reloading development mode
.venv/bin/uvicorn app.main:app --reload --host 0.0.0.0 --port 24590
```

### B. Checking System Health & Tool Availability
Call `GET /health` for ffmpeg/ffglitch binaries. Neural ops also need packages in
`requirements.txt` (and first-run model downloads for withoutbg / TF-Hub style).

### C. New neural / image ops
Follow `operations/README.md`: engine + ops + `__init__.py` import + optional UI tab.
Always resolve final write paths with `pathutil.unique_output_path` (or
`unique_related_paths` for multi-file outputs).

---

## 🔒 5. WebUI Testing (MANDATORY — DO NOT DEVIATE)

**Browser testing MUST use Playwright MCP tools.** The tool names start with
`mcp_mcp_browser_`: `mcp_mcp_browser_navigate`, `mcp_mcp_browser_console_messages`,
`mcp_mcp_browser_snapshot`, `mcp_mcp_browser_click`, `mcp_mcp_browser_type`,
`mcp_mcp_browser_screenshot`.

**NEVER use `web.run`, `web_search`, or `web_extract` to test the WebUI.**
Those tools block localhost connections. They will silently fail or return empty
results while making it look like the test passed. Console errors, render
failures, and broken CSS will all go undetected.

**NEVER fall back to curl + API-only verification when asked to test the WebUI.**
This is a browser application. The API responding is not the same as the UI
working. If you cannot access the browser, say so — don't substitute.

---

## ⚠️ 6. Known Hazards & Debugging Notes

- **Working Directory Drift**:
  - `transmute` outputs bare filenames by default. Handlers must calculate the parent directory of `input_path` and pass it as `cwd` to `run_command` so output files land alongside input media.
- **FastAPI Type Inspection**:
  - Do NOT re-add `from __future__ import annotations` in `app/main.py`. It interferes with Pydantic type reflection in dynamic route generation.
