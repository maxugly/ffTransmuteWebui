# ffTransmuteWebui

A local one-stop video/image workshop: lossless geometry (`transmute`), datamosh, Video/Image Pool projects, Convert/Export codecs, plus neural tools (DeepDream, face morph, withoutBG, style transfer, RIFE) behind a typed FastAPI server and dark-mode WebUI.

---

## Overview

Two layers:

1. **Core CLI** (`transmute`, `datamosh.sh`, ffglitch JS) — ffmpeg-centric, minimal deps  
2. **mtapi + WebUI** (`mtapi-project/`) — typed `POST /ops/*`, dual media libraries (Video Pool + Image Pool), job cancel/progress, sequential output names so re-runs never overwrite

**Frame effects** use a shared **filter platform**: dump → `app/filters/*` stages → encode (`docs/filter-platform-spec.md`). **Convert / Export** is the user-facing bookends tab (ProRes, DNxHR, H.264/AVC, HEVC, frame folders, GIF).

**WebUI tabs include:** Datamosh, DeepDream, Face Morph, withoutBG, Style Transfer, RIFE, Convert/Export, single-clip transmute, join/grid, Quick Transmute, **Video Pool**, **Image Pool**, Sequence, **Cut**, Folder Watcher (ingest → DNxHR), raw CLI.

Libraries / Cut handoff: `docs/video-image-pools-spec.md`.

---

## 📁 Repository Structure

```
ffTransmuteWebui/
├── transmute                    # Lossless video geometry & frame extraction Bash script
├── datamosh.sh                  # Video datamoshing suite (MPEG-2 / AVI frame destruction)
├── melt.js                      # ffglitch motion vector displacement script
├── no_keyframe.js               # ffglitch iframe removal script
├── docs/docs-transmute-README.md  # Standalone transmute CLI reference
├── docs/docs-datamosh-README.md   # Standalone datamosh.sh CLI reference
├── VERSIONING.md                # Humble versioning scheme explanation
├── VERSION                      # Single-line version source of truth
├── mtapi-project/               # FastAPI backend & WebUI project directory
│   ├── app/                     # Python app package (routes, contracts, media, pipeline)
│   │   ├── filters/             # Frame stages (per_frame | directory)
│   │   ├── operations/          # Thin HTTP ops + engines
│   │   ├── video_pipeline.py    # dump / process / encode bookends
│   │   └── static/              # WebUI (tabs, pool, convert)
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

Full references: [transmute CLI](docs/docs-transmute-README.md) · [datamosh CLI](docs/docs-datamosh-README.md) · [versioning](VERSIONING.md)

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

## 🧱 Placeholder Tiles — fill in later

> Flag: `[TODO: fill]` = needs content. Remove flag when filled.

| Tile | Topic / Doc | Status |
|------|-------------|--------|
| [TODO: fill] Filter Platform | `docs/filter-platform-spec.md` — dump → stages → encode | placeholder |
| [TODO: fill] Video / Image Pools | `docs/video-image-pools-spec.md` + Cut handoff | placeholder |
| [TODO: fill] Convert / Export | `docs/file-to-file-transcode-spec.md`, `docs/resolve-transcode-spec.md` | placeholder |
| [TODO: fill] DeepDream + Evolve | `docs/deepdream-spec.md`, `docs/deepdream-evolve-video-spec.md` | placeholder |
| [TODO: fill] Face Morph | `docs/facemorph-spec.md` (dlib + YuNet) | placeholder |
| [TODO: fill] withoutBG | `docs/withoutbg-spec.md` | placeholder |
| [TODO: fill] Style Transfer | `docs/styletransfer-spec.md`, `docs/style-css-map.md` | placeholder |
| [TODO: fill] RIFE + Recoherence | `docs/rife-spec.md`, `docs/rife-recoherence-spec.md` | placeholder |
| [TODO: fill] Sequence / Timeline | `docs/sequence-*-spec.md`, `docs/sequence-images-spec.md` | placeholder |
| [TODO: fill] Image Sort + Chain | `docs/image-sort-rife-spec.md` | placeholder |
| [TODO: fill] Img2img / Txt2img OpenVINO | `docs/img2img-openvino-spec.md`, `docs/openvino-tab-spec.md` | placeholder |
| [TODO: fill] Agent + Vision Tab | `docs/agent-vision-tab-spec.md` | placeholder |
| [TODO: fill] Pool Wall Preview | `docs/pool-wall-preview-spec.md` | placeholder |
| [TODO: fill] Settings Cards | `docs/settings-card-layout-spec.md` | placeholder |
| [TODO: fill] Performance / Catalog UX | `docs/performance-*-spec.md`, `docs/performance-catalog-ux-spec.md` | placeholder |
| [TODO: fill] Job Queue | `docs/job-queue-spec.md` | placeholder |
| [TODO: fill] Prompt Library | `docs/prompt-library-spec.md` | placeholder |
| [TODO: fill] Folder Watcher / DNxHR | `mtapi-project/README.md` (watcher section) | placeholder |
| [TODO: fill] Archive / Changelog | `docs/archive/changelog.md`, `docs/STATUS.md` | placeholder |
| [TODO: fill] Backlog Ops | `docs/backlog/` (~28 draft specs) | placeholder |

---

## 📜 Subdirectory Documentation

Detailed documentation and agent guidance are available in each directory:
- [mtapi-project README](mtapi-project/README.md)
- [app README](mtapi-project/app/README.md)
- [operations README](mtapi-project/app/operations/README.md)
- [static README](mtapi-project/app/static/README.md)
- [bin README](mtapi-project/bin/README.md)
