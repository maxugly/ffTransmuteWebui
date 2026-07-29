# Spec: ASCII Rendering Operation

> **Version**: 000.000.6.00 (next major feature bump)
> **Status**: Proposed
> **Author**: Spec agent
> **Scope**: New operation `ascii_ops.py` and WebUI integration

---

## 1. What It Does

Introduces a visual effect that converts an input image or video into ASCII art, and then **renders that ASCII text back into standard visual frames (PNG/MP4)**. 

Unlike CLI tools that output raw text to the terminal, this operation bakes the ASCII text onto an image canvas, maintaining standard video formats so the result can be easily shared or piped into further operations. It perfectly conforms to our unified pipeline pattern: **dump PNGs → tool processes frames → ffmpeg re-encode**.

---

## 2. Approach & Libraries

Based on research, we will use a hybrid approach:
- **Core ASCII Mapping**: We can utilize the `to-ascii` Python package to quickly map image blocks to characters, or implement a lightweight native mapping function (luminance to character array) since we need to render the characters back to an image anyway.
- **Rendering to Frames**: Python's `Pillow` (PIL) library will be used to draw the ASCII characters onto a blank canvas (using a monospaced font like `Courier New`).
- **Media Pipeline**: Our existing `ffmpeg` orchestration (via `shell.py` / `create_subprocess_exec`) will handle frame extraction, re-encoding, and audio muxing.

---

## 3. Parameter Models

### File: `mtapi-project/app/operations/ascii_ops.py`

```python
from pydantic import BaseModel, Field

class AsciiParams(BaseModel):
    input_path: str = Field(..., description="Source video or image")
    output_path: str | None = Field(None, description="Where to write the result; auto-named if omitted")
    
    # Aesthetic Controls
    font_size: int = Field(12, ge=4, le=72, description="Size of the monospaced font. Controls the 'resolution' of the ASCII grid. Smaller = finer detail.")
    color: bool = Field(True, description="If true, sample the original pixel color for the text. If false, output classic green-on-black or white-on-black.")
    bg_color: str = Field("#000000", description="Background color hex code")
    fg_color: str | None = Field("#00FF00", description="Foreground text color if color=False")
    charset: str = Field("complex", description="Character set to use (e.g., 'simple', 'complex', 'blocks')")
```

---

## 4. Handler Pipeline

The operation strictly follows the **Unified Pipeline Pattern**:

1. **Probe Input**: Check if input is a video or image. Check if audio exists.
2. **Dump PNGs**: 
   - `ffmpeg -i <input> -q:v 2 <tmpdir>/frame_%06d.png`
3. **Tool/Engine Process (The Render Loop)**:
   - For each frame in the `tmpdir`:
     1. Open with PIL.
     2. Calculate the grid size based on `font_size` and font metrics (e.g., a 12pt font might have an 8x12 pixel bounding box).
     3. Downscale the image to match the grid size (so 1 pixel = 1 character).
     4. Map each pixel's luminance to an ASCII character.
     5. Create a new blank PIL image of the original resolution.
     6. Use `ImageDraw.Draw.text` to render the characters onto the canvas. If `color=True`, use the original downscaled pixel color as the `fill`.
     7. Save over the original frame (or to a new sequence).
4. **Re-encode**:
   - `ffmpeg -framerate <fps> -i <tmpdir>/frame_%06d.png -i <input> -map 0:v -map 1:a? -c:v libx264 -pix_fmt yuv420p -c:a aac output.mp4`

---

## 5. Files to Touch

| File | Action | Description |
|---|---|---|
| `app/operations/ascii_ops.py` | **CREATE** | Pydantic model, render loop, and pipeline orchestrator. |
| `app/operations/__init__.py` | **EDIT** | Add `ascii_ops` import to register it. |
| `app/static/index.html` | **EDIT** | Add "ASCII Art" tab and form. |
| `app/static/app.js` | **EDIT** | Form state mapping to `/ops/ascii`. |
| `requirements.txt` | **EDIT** | Add `to-ascii` (if we decide to use it directly) and `Pillow` (if not already present). |
| Root `AGENTS.md` | **EDIT** | Add to ops registry table. |

---

## 6. Open Questions & Implementation Details

1. **Font Sourcing**: We need a standard monospaced TrueType font (`.ttf`). `Pillow` requires a font file to draw text with specific sizes. We should bundle a free monospaced font (like `JetBrainsMono`, `FiraCode`, or a classic `Courier` open alternative) in the repository (e.g., `mtapi-project/assets/fonts/mono.ttf`) so it works reliably across operating systems.
2. **Performance Optimization**: Drawing thousands of text characters frame-by-frame in Python can be slow. 
   - *Optimization 1*: Parallelize the frame processing loop using `concurrent.futures.ProcessPoolExecutor` or `asyncio.gather` for I/O bound PIL saves.
   - *Optimization 2*: Instead of drawing character by character, draw row by row as long strings to reduce the overhead of `ImageDraw.text`.

---

## 7. Verification Steps

1. Boot the server and load the WebUI.
2. Ensure the "ASCII Art" tab renders correctly.
3. Test with a static image (`/tmp/teste.png`) to verify the font renders and colors are mapped correctly.
4. Test with a video (`/tmp/teste.mp4`) to ensure audio is successfully muxed back in, and that the frame extraction/reassembly maintains the correct duration and framerate.
5. Confirm no JS console errors.
