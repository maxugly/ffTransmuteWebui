# ffTransmuteWebui

A local one-stop video/image workshop: lossless geometry (`transmute`), datamosh, media pool/projects, plus neural tools (DeepDream, face morph, withoutBG, style transfer) behind a typed FastAPI server and dark-mode WebUI.

---

## Overview

Two layers:

1. **Core CLI** (`transmute`, `datamosh.sh`, ffglitch JS) — ffmpeg-centric, minimal deps  
2. **mtapi + WebUI** (`mtapi-project/`) — typed `POST /ops/*`, media pool, job cancel/progress, sequential output names so re-runs never overwrite

**WebUI tabs include:** Datamosh, DeepDream, Face Morph, withoutBG, Style Transfer, single-clip transmute, join/grid, Quick Transmute (`fit`), Media Pool, Folder Watcher (ingest → DNxHR), raw CLI.

---

## 📁 Repository Structure

```
ffTransmuteWebui/
├── transmute                    # Lossless video geometry & frame extraction Bash script
├── datamosh.sh                  # Video datamoshing suite (MPEG-2 / AVI frame destruction)
├── melt.js                      # ffglitch motion vector displacement script
├── no_keyframe.js               # ffglitch iframe removal script
├── docs-transmute-README.md     # Standalone transmute CLI reference
├── docs-datamosh-README.md      # Standalone datamosh.sh CLI reference
├── mtapi-project/               # FastAPI backend & WebUI project directory
│   ├── app/                     # Python app package (routes, contracts, media store)
│   │   ├── operations/          # Typed operation handlers (transmute, datamosh)
│   │   └── static/              # Frontend web application (index.html, app.js, style.css)
│   ├── bin/                     # Embedded binary wrappers and ffglitch JS scripts
│   ├── run.py                   # Server startup script
│   └── requirements.txt         # Python dependencies
└── AGENTS.md                    # Dox-style AI Agent guidance for the root workspace
```

---

## 🚀 Quick Start

### 1. Requirements
Ensure the following CLI binaries are available on your system `PATH`:
- `ffmpeg` & `ffprobe` (for `transmute` operations)
- `ffgac` & `ffedit` (from [ffglitch](https://ffglitch.org/) for datamosh operations)
- `bash` (v4.0+) & `python` (v3.10+)

### 2. Standalone CLI Usage
Run `transmute` directly for rapid geometry processing:
```bash
# Extract square center crop without re-scaling
./transmute input.mp4 -s

# Extract first frame as high-quality PNG
./transmute input.mp4 -f
```

Run `datamosh.sh` for motion-vector or keyframe-suppression glitching:
```bash
# Melt — continuous motion smear with default settings
./datamosh.sh input.mp4 output.mp4

# Classic — keyframe-suppression bleed at scene cuts
./datamosh.sh input.mp4 output.mp4 --mode classic
```

Full references: [transmute CLI](docs-transmute-README.md) · [datamosh CLI](docs-datamosh-README.md)

### 3. Launching the Web Server & UI
```bash
cd mtapi-project
python -m venv .venv          # once
source .venv/bin/activate     # or: .venv/bin/python …
pip install -r requirements.txt
python run.py
```
Then open:
- **WebUI**: `http://localhost:24590/`
- **OpenAPI**: `http://localhost:24590/docs`
- **Schema**: `http://localhost:24590/openapi.json`

Stop the server with Ctrl+C (or free the port: `fuser -k 24590/tcp`).

Optional extras (installed via requirements; some download models on first use):
| Feature | Notes |
|---------|--------|
| DeepDream | TensorFlow + ImageNet nets |
| Face Morph | dlib + `FACEMORPH_ROOT` (default `~/snc/cod/facemorph`) + YuNet ONNX |
| withoutBG | `withoutbg` package; local ~455 MB weights or Cloud API key |
| Style Transfer | Magenta TF-Hub ~90 MB under `~/.cache/tfhub_modules` |

Outputs auto-sequence (`file.png`, `file_0001.png`, …) so repeated runs do not clobber prior results.

---

## 📜 Subdirectory Documentation

Detailed documentation and agent guidance are available in each directory:
- [mtapi-project README](mtapi-project/README.md) & [mtapi-project AGENTS.md](mtapi-project/AGENTS.md)
- [app README](mtapi-project/app/README.md) & [app AGENTS.md](mtapi-project/app/AGENTS.md)
- [operations README](mtapi-project/app/operations/README.md) & [operations AGENTS.md](mtapi-project/app/operations/AGENTS.md)
- [static README](mtapi-project/app/static/README.md) & [static AGENTS.md](mtapi-project/app/static/AGENTS.md)
- [bin README](mtapi-project/bin/README.md) & [bin AGENTS.md](mtapi-project/bin/AGENTS.md)
