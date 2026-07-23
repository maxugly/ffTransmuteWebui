# bin — Execution Binaries & Script Wrappers

The `bin` directory contains the core executable scripts and JavaScript glitch hooks utilized by `app/shell.py` to perform media processing operations.

---

## 📁 Executables & Scripts

```
bin/
├── transmute          # Geometry & frame extraction Bash script
├── datamosh.sh        # Datamoshing orchestrator Bash script
├── melt.js            # ffglitch JS script for vector displacement melting
├── no_keyframe.js     # ffglitch JS script for removing iframe/keyframe data
└── custom_glitch.js   # ffglitch JS script (used by API datamosh hijack/residual/MV)
```

---

## 🔧 Script Descriptions & Dependencies

### 1. `transmute`
- **Language**: Bash (v4+)
- **Dependencies**: `ffmpeg`, `ffprobe`
- **Purpose**: Lossless video geometry transformations, joining, grid compositing, and frame extraction.
- **Contract**: Accepts input file/folder as first argument, flag options, and optional output path as last argument. Prints `Output: <path>` and `Command: <argv>` to stdout prior to execution.

### 2. `datamosh.sh`
- **Language**: Bash (v4+)
- **Dependencies**: `ffgac`, `ffedit`, `ffmpeg`, `ffprobe`
- **Modes**:
  - `melt`: Uses `melt.js` via `ffedit` to corrupt motion vectors across P-frames.
  - `classic`: Uses `no_keyframe.js` to strip keyframes and hold vector buffer across transitions.

### 3. `melt.js`, `no_keyframe.js`, `custom_glitch.js`
- **Language**: ECMAScript (ffglitch module format)
- **Engine**: `ffedit` (part of [ffglitch](https://ffglitch.org/))
- **Purpose**: Direct frame payload inspection, motion vector modification (`frame.mv`), and DCT residual zeroing (`frame.q_dct`). `custom_glitch.js` is invoked directly by the API's `datamosh_ops.py` for hijack / residual destruct / motion-vector hack modes — not via `datamosh.sh`.
