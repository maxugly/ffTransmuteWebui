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
├── run.py                 # Server startup entrypoint (wraps uvicorn.run)
├── requirements.txt       # Python dependencies (fastapi, uvicorn, pydantic)
├── README.md              # Technical overview and API usage documentation
├── AGENTS.md              # Agent directives for mtapi-project (this file)
├── app/                   # Python application package (FastAPI routes, core logic)
│   ├── operations/        # Operation specs & handlers (transmute, datamosh)
│   └── static/            # WebUI static assets (HTML/CSS/JS)
└── bin/                   # Local binary dependencies (transmute, datamosh.sh, js scripts)
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

### A. Running the Server
```bash
# Standalone execution
python run.py

# Live-reloading development mode
uvicorn app.main:app --reload --port 24590
```

### B. Checking System Health & Tool Availability
Call `GET /health` to verify that required system dependencies (`ffmpeg`, `ffprobe`, `ffgac`, `ffedit`) and local binaries are detected on `PATH` or in `bin/`.

---

## ⚠️ 5. Known Hazards & Debugging Notes

- **Working Directory Drift**:
  - `transmute` outputs bare filenames by default. Handlers must calculate the parent directory of `input_path` and pass it as `cwd` to `run_command` so output files land alongside input media.
- **FastAPI Type Inspection**:
  - Do NOT re-add `from __future__ import annotations` in `app/main.py`. It interferes with Pydantic type reflection in dynamic route generation.
