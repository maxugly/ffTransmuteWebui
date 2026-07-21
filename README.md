# ffTransmuteWebui

A high-performance, non-destructive video manipulation suite and WebUI engine combining core Bash CLI utilities (`transmute`, `datamosh.sh`) with a typed FastAPI server (`mtapi-project`) and interactive single-page WebUI.

---

## 🌟 Overview

`ffTransmuteWebui` is built around lossless geometry transformation and frame-accurate video datamoshing without scaling artifacts.

It consists of two primary layers:
1. **Core CLI Tools (`/transmute`, `/datamosh.sh`)**: Dependency-minimal Bash scripts wrapping `ffmpeg`, `ffprobe`, `ffgac`, `ffedit`, and `ffglitch`.
2. **REST API & WebUI (`/mtapi-project`)**: A Python FastAPI backend providing typed endpoints for video operations, persistent BLAKE2b media tracking, media preview probing, and a zero-dependency HTML5/JS Web application.

---

## 📁 Repository Structure

```
ffTransmuteWebui/
├── transmute                    # Lossless video geometry & frame extraction Bash script
├── datamosh.sh                  # Video datamoshing suite (MPEG-2 / AVI frame destruction)
├── melt.js                      # ffglitch motion vector displacement script
├── no_keyframe.js               # ffglitch iframe removal script
├── docs-transmute-README.md     # Original transmute CLI specification
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

### 3. Launching the Web Server & UI
```bash
cd mtapi-project
pip install -r requirements.txt
python run.py
```
Then navigate to:
- **Interactive WebUI**: `http://localhost:24590/`
- **Interactive OpenAPI Docs**: `http://localhost:24590/docs`
- **Machine-Readable API Schema**: `http://localhost:24590/openapi.json`

---

## 📜 Subdirectory Documentation

Detailed documentation and agent guidance are available in each directory:
- [mtapi-project README](file:///home/m/snc/cod/ffTransmuteWebui/mtapi-project/README.md) & [mtapi-project AGENTS.md](file:///home/m/snc/cod/ffTransmuteWebui/mtapi-project/AGENTS.md)
- [app README](file:///home/m/snc/cod/ffTransmuteWebui/mtapi-project/app/README.md) & [app AGENTS.md](file:///home/m/snc/cod/ffTransmuteWebui/mtapi-project/app/AGENTS.md)
- [operations README](file:///home/m/snc/cod/ffTransmuteWebui/mtapi-project/app/operations/README.md) & [operations AGENTS.md](file:///home/m/snc/cod/ffTransmuteWebui/mtapi-project/app/operations/AGENTS.md)
- [static README](file:///home/m/snc/cod/ffTransmuteWebui/mtapi-project/app/static/README.md) & [static AGENTS.md](file:///home/m/snc/cod/ffTransmuteWebui/mtapi-project/app/static/AGENTS.md)
- [bin README](file:///home/m/snc/cod/ffTransmuteWebui/mtapi-project/bin/README.md) & [bin AGENTS.md](file:///home/m/snc/cod/ffTransmuteWebui/mtapi-project/bin/AGENTS.md)
