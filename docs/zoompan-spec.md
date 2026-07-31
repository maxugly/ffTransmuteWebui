# Zoompan (Image to Video) — Spec

> **Status:** Implemented (2026-07-31) · `000.000.4.31` — exact Zoomed In + Reference match  

> **Audience:** Builder agents (codewhale, codex)  
> **Related:** `image-compare-spec.md`, `video-image-pools-spec.md`

---

## 1. Purpose

Create a new tab that generates a video from a single fixed image by panning and zooming between two defined viewports (Start Frame and Last Frame).

The user defines a rectangle (viewport box) for the Start Frame and a rectangle for the Last Frame. The backend uses `ffmpeg` (via the filter platform or a thin CLI operation) to render a smooth interpolation between the two viewports over a specified duration and framerate.

---

## 2. Frontend UI / Workspace

### 2.1 Tab & Layout

- **Tab ID:** `zoompan` (Label: "Pan & Zoom")
- **Inputs:** 
  - Uses the global **Image** as the source (`window.globalInputs.image`), just as Cut uses the global Video.
  - No private file picker.

### 2.2 Viewport Configuration (The "Box")

The UI will display two primary views similar to the Cut tab's In/Out layout:
1. **Start Frame Configuration**
2. **Last Frame Configuration**

**Shared Controls & Image Compare:**
- Toolbar from `js/ui/image-compare.js`: **Separate**, **Overlay**, **A/B**.
- **Reference still** (optional but primary for scene-match): Image Pool / Browse / Send-to → *Pan & Zoom · Reference*.
- **Pair** selector: Last vs Reference (default) | Start vs Reference | Both vs Reference | Start vs Last.
- Per viewport:
  - **Zoomed Out:** full source + AR-locked draggable box.
  - **Zoomed In:** canvas crop of **exactly** the box pixels from full `/api/image` (not an arbitrary CSS zoom). When Pair includes Reference and mode is Overlay/A/B, the reference is stacked on that crop for alignment.

### 2.3 Parameters

- **Duration:** Time in seconds or total frame count.
- **Framerate:** Default to `24` fps.
- **Start Box:** `x, y, width, height` (maintained via UI dragging or inputs).
- **Last Box:** `x, y, width, height`.
- *Constraint:* The aspect ratio of the Start Box, Last Box, and the Output Video must match to avoid stretching. By default, lock the box aspect ratio to 16:9 or let the user choose a target aspect ratio.

---

## 3. Backend Implementation

### 3.1 API & Operation

Create a new operation (e.g., `app/operations/zoompan_ops.py`) or register it within the transmute operations if appropriate. Since this is an image-to-video generation, a standalone op is usually cleaner.

**Route:** `POST /ops/zoompan`

**Request Payload:**
```json
{
  "input_path": "/path/to/image.png",
  "start_box": {"x": 0, "y": 0, "w": 1920, "h": 1080},
  "end_box": {"x": 400, "y": 200, "w": 960, "h": 540},
  "duration_sec": 5.0,
  "fps": 24,
  "output_path": ""
}
```

### 3.2 Frame generation (as-built)

**Do not** rely on ffmpeg `crop` expressions with animated `w/h/x/y` or the
`zoompan` filter for product motion — both are finicky and often freeze on
the first crop.

**As-built pipeline (`zoompan_ops.py`):**

1. `N = max(2, round(duration_sec * fps))`
2. For each frame `i = 0 … N-1`:
   - `p = i / (N - 1)`  → first frame = start box, last = end box
   - box = linear lerp of `(x,y,w,h)` start → end, clamped to image
   - Pillow: `crop` → LANCZOS `resize` to even `output_width × output_height`
   - write `frame_%06d.png`
3. `ffmpeg -framerate FPS -i frame_%06d.png -c:v libx264 -pix_fmt yuv420p out.mp4`

Warn in the result if start≈end (static video).

---

## 4. Files (as-built)

| Path | Role |
|------|------|
| `mtapi-project/app/static/index.html` | Nav item `data-tab="zoompan"` + `zoompan.css` |
| `mtapi-project/app/static/app.js` | `TAB_ACCEPTS.zoompan = 'image'`, render hook |
| `mtapi-project/app/static/js/tabs/zoompan.js` | UI: boxes, Full/Zoomed, image-compare, collector |
| `mtapi-project/app/static/css/zoompan.css` | Workspace layout |
| `mtapi-project/app/static/js/job-control.js` | Run → `POST /ops/zoompan` |
| `mtapi-project/app/operations/zoompan_ops.py` | Params + ffmpeg crop interpolate + encode |
| `mtapi-project/app/operations/__init__.py` | Import register |

**Encode strategy:** linear crop `w/h/x/y` by frame index `n/(N-1)`, then `scale` to even start-box size, `libx264` yuv420p. (Avoided nested `min`/`t` crop exprs that fail filter init on some ffmpeg builds.)

---

## 5. Potential Pitfalls

- **Image Compare shared state:** Ensure that when switching between Separate/Overlay/A/B, the Start and End boxes are drawn accurately relative to the base image and reference image. 
- **Aspect Ratio Locking:** If the start box and end box have different aspect ratios, the zoom will warp or jump. Enforce a locked target aspect ratio for the boxes in the frontend UI.
- **FFMPEG zoompan jitter:** `zoompan` is known to cause jitter at very slow zoom speeds due to rounding. An alternative is `crop='...':exact=1` if `zoompan` proves too jittery.

---

## 6. Verification Steps (Mandatory before calling DONE)

1. Load a high-res image into the **Image Pool**.
2. Navigate to the **Pan & Zoom** tab.
3. Verify that the image appears in the Start and Last viewports.
4. Draw a box on the Start viewport (e.g., full screen).
5. Draw a smaller box on the Last viewport (e.g., top-left quadrant).
6. Toggle between "Zoomed Out (Full Image)" and "Zoomed In (Box Size)".
7. Use the Compare modes (Separate, Overlay, A/B) and verify the slider works.
8. Set Duration to 2s, FPS to 24.
9. Click **Run**.
10. Check that the backend generates a valid `mp4` with a smooth zoom from full image to the top-left quadrant. No javascript console errors should be present.
