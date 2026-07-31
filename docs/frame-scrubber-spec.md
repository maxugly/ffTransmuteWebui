# Frame Scrubber (Global Frame Range Picker)

> **Status:** Specification Phase
> **Category:** Frontend / Operation

## 1. Overview
The global frame range picker currently displays numbers (e.g., 1-90), but the user cannot visually confirm what frame they are selecting. This specification introduces a thumbnail preview mechanism (a "Frame Scrubber") tailored for short clips. A new purple `[+]` button next to the picker will generate a sequence of low-res thumbnails. When hovering or dragging the start/end bounds, a stationary popup appears below the picker, showing the exact frame at the cursor position.

## 2. Backend Architecture (`app/routes/media.py`)
Two new endpoints are required to manage thumbnail extraction and serving.

### A. POST /media/frame-strip
- **Body:** `{ "path": "/path/to/video.mp4" }`
- **Action:** Uses `ffmpeg` to extract all frames as 120px-wide JPEG thumbnails.
- **Storage:** Stores images in the media cache at `~/.cache/mtapi/media/by_hash/{content_hash}/frames/`.
- **Response:** `{ "hash": "abc123", "frame_count": 90, "frame_urls": ["/media/frame-strip/abc123/frame_00001.jpg", ...] }`
- **Caching:** Content-hash based. If the hash already exists in the cache, the API immediately returns the cached URLs without re-extracting.
- **Cancellation:** Extraction must check `job_control.check_cancelled()` between frames (while fast, it must remain cancel-aware).

### B. GET /media/frame-strip/{hash}/frame_{n}.jpg
- Serves individual thumbnail JPEGs directly from the cache.
- Must support HTTP range requests for progressive loading.

## 3. Frontend Architecture
A new interaction layer built into `js/preview.js` or a dedicated `js/frame-scrubber.js`.

### Interaction Flow
- **Trigger:** A purple `[+]` button sits next to the frame range display (`giFramesRow`).
- **Click:** Fires `POST /media/frame-strip` and displays progress ("extracting N frames...").
- **State:** On completion, stores `frame_urls` in `state.pool` or `state.frameStrip`.
- **Hover/Drag:** Hovering or dragging the range thumb triggers a popup `<img>` below the picker.
- **Popup UI:** Stationary, fixed below the timeline track, displaying the frame corresponding to the current cursor position. Hides on mouse leave.
- **Lazy Loading:** Only fetches frame JPEGs that are within ±10 frames of the current hover position to conserve bandwidth.

## 4. Pitfalls & Constraints
- **Long Videos:** Extraction is $O(n)$ and risks filling the disk. Add a `frame_limit` parameter (default 500). If a video exceeds 500 frames, return a warning and abort extraction.
- **Cache Invalidation:** Because the cache uses a content-hash, if a video is overwritten/replaced, the hash changes. Old thumbnails will eventually be swept by the standard media cache garbage collection.
- **Popup Positioning:** The popup must not scroll off-screen at the edges of the timeline. Its coordinates must be clamped to viewport boundaries.
- **Already Extracted:** The backend must reliably check the cache before spinning up `ffmpeg`.

## 5. Files to Touch
- **NEW:** `docs/frame-scrubber-spec.md` (This file)
- **TOUCH:** `app/routes/media.py` (Add `POST/GET` frame-strip endpoints)
- **TOUCH:** `app/media/cache.py` (Implement frame-strip hash storage logic)
- **TOUCH:** `app/static/js/preview.js` or **NEW** `app/static/js/frame-scrubber.js` (Frontend logic)
- **TOUCH:** `app/static/css/forms.css` (Styles for the purple button and popup)

## 6. Acceptance Criteria
- **AC-1:** Given a request to `POST /media/frame-strip` on `/tmp/teste.mp4`, When executed, Then 90 thumbnails are generated, a hash is returned, and a subsequent call returns the cached result instantly.
- **AC-2:** Given a generated frame strip in the UI, When the user hovers on the start thumb, Then a popup shows frame 1, and dragging to 45 updates the stationary popup to show frame 45.
- **AC-3:** Given a video with > 500 frames, When `POST /media/frame-strip` is called, Then a warning is returned and extraction is aborted.
- **AC-4:** Given the WebUI, When viewing the datamosh tab (or any tab with the frame range), Then the purple `[+]` button is visible next to the frame range picker.
- **AC-5:** Given the completion of all UI actions, When checking the browser console, Then zero errors are logged.
