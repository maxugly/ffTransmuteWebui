# operations — Operation Schemas & Handlers

The `operations` subpackage defines every tool operation exposed by `mtapi-project`. Each operation is a self-contained module registering an `OperationSpec` into the global registry.

---

## 📁 File Structure

```
operations/
├── __init__.py           # Package init — imports ops modules to populate REGISTRY
├── transmute_ops.py      # Pydantic schemas and handlers for transmute CLI operations
└── datamosh_ops.py       # Pydantic schemas and handlers for datamosh.sh CLI operations
```

---

## 🛠️ Operational Modules

### 1. `transmute_ops.py`
Wraps the `transmute` Bash script. Exposes individual single-purpose operations to ensure clean UI node design:
- `first_frame` (`-f`): Extracts initial frame as PNG/JPG.
- `last_frame` (`-l`): Extracts last frame as PNG/JPG.
- `extract_audio` (`-a`): Extracts audio stream to M4A.
- `crop_16x9` (`-c`): Crops video to 16:9 center.
- `letterbox_16x9` (`-b`): Letterboxes video to 16:9.
- `square_crop` (`-s`): Crops video to 1:1 square.
- `square_letterbox` (`-S`): Letterboxes video to 1:1 square.
- `crop_exact` (`-z`): Center crops video to `WxH`.
- `stretch_exact` (`-x`): Scales video to `WxH`.
- `join` (`-j`): Stitches multiple clips end-to-end (`pad`, `crop`, `stretch`).
- `grid` (`-g`): Creates a 2x2 grid of four videos (`pad`, `crop`, `stretch`).
- `reverse` (`-r`): Reverses video and audio.
- `transmute_raw`: Raw escape hatch allowing arbitrary flag combinations.

### 2. `datamosh_ops.py`
Wraps the `datamosh.sh` script for motion vector destruction:
- `datamosh_melt`: Applies frame destruction with vector displacement drift (`tail`, `hdamp`).
- `datamosh_classic`: Traditional P-frame datamosh (kills keyframes and holds vectors across video segments).
- `datamosh_custom`: Advanced vector destruction using custom parameters (`mode`, frame ranges, vector multipliers, horizontal/vertical drift).
