# AGENTS.md — Root Workspace Agent Directives

> **Scope**: Root directory `/home/m/snc/cod/ffTransmuteWebui`
> **Audience**: Autonomous AI Agents, Code Assistants, and Developer Tooling

---

## 🎯 1. Mission & System Purpose

The root workspace orchestrates a non-destructive video manipulation system. It combines raw shell-level ffmpeg/ffglitch pipelines with a typed Python HTTP server (`mtapi-project`) and an asynchronous single-page web interface.

Agents operating at this level are responsible for top-level repository integrity, cross-component interface stability, build execution, and workspace-wide documentation.

---

## 🏗️ 2. Architectural Map & Component Roles

```
/home/m/snc/cod/ffTransmuteWebui/
├── transmute                    # Pure Bash CLI script (wraps ffmpeg for pixel-exact geometry ops)
├── datamosh.sh                  # Pure Bash CLI script (wraps ffgac/ffedit/ffmpeg for datamoshing)
├── melt.js / no_keyframe.js     # ffglitch ECMAScript modules for vector & frame destruction
├── docs-transmute-README.md     # Reference doc for standalone transmute CLI flags
├── mtapi-project/               # FastAPI backend package and WebUI client
└── AGENTS.md                    # Root agent operational directives (this file)
```

### Component Breakdown
1. **`transmute`**:
   - Single-file executable Bash script. Zero dependencies beyond `ffmpeg` and `ffprobe`.
   - Rule: Never scales or interpolates pixels unless explicitly requested via stretch (`-x`) or composite modes (`-g`/`-j`).
2. **`datamosh.sh`**:
   - Orchestrates two-pass MPEG-2 video corruption using `ffgac` (MPEG-2 encoder/decoder) and `ffedit` with JavaScript glitch hooks.
3. **`mtapi-project`**:
   - Python 3.10+ FastAPI server exposing every operation as a typed HTTP endpoint.
   - Hosts `app/static/index.html` (the web application).

---

## 🚨 3. System Invariants & Non-Negotiable Rules

When modifying files at the root level or coordinating changes across components:

1. **Pixel Integrity Guarantee**:
   - Operations in `transmute` MUST preserve native frame dimensions and aspect ratios by default using crop (`-c`, `-s`, `-z`) or letterbox (`-b`, `-S`) filters rather than scaling.
2. **Absolute Path Requirement**:
   - All API endpoints and subprocesses must be supplied with or convert arguments to absolute filesystem paths. Relative paths are ambiguous in multi-threaded API environments.
3. **Safe Subprocess Spawning**:
   - Subprocess invocations in Python MUST use `create_subprocess_exec` with explicit `argv` lists. NEVER use `shell=True` or string interpolation to execute shell commands.
4. **No External Framework Dependencies on Frontend**:
   - The WebUI in `mtapi-project/app/static` uses vanilla HTML5, CSS3, and JavaScript (ES6+). Do NOT introduce npm/webpack/React/Tailwind dependencies unless explicitly requested.

---

## 🛠️ 4. Agent Workflows & Action Protocols

### A. Testing the Entire Stack
1. Ensure `ffmpeg`, `ffprobe`, `ffgac`, and `ffedit` are on `$PATH`.
2. Check backend server startup:
   ```bash
   cd mtapi-project
   python run.py
   ```
3. Test API responsiveness:
   ```bash
   curl -s http://localhost:24590/health | jq .
   ```

### B. Synchronizing CLI and API Capabilities
If a new flag or operation is added to root `./transmute` or `./datamosh.sh`:
1. Mirror the script update inside `mtapi-project/bin/`.
2. Define a corresponding Pydantic schema and handler in `mtapi-project/app/operations/`.
3. Register the `OperationSpec` in `REGISTRY`.
4. Expose UI controls in `mtapi-project/app/static/app.js` and `index.html`.

---

## ⚡ 5. Troubleshooting & Known Edge Cases

- **Path Spacing**: Always wrap file variables in quotes within bash scripts (`"$INPUT"`).
- **FastAPI Postponed Evaluation Issue**: `from __future__ import annotations` in `app/main.py` breaks FastAPI's dynamic route parameter extraction. Keep it removed in `main.py`.
- **ffglitch Feature Exclusivity**: In `ffedit`, requesting incompatible features simultaneously (e.g., `mv` and `q_dct`) causes hard crashes. Request ONLY the required feature in `setup(args)`.
