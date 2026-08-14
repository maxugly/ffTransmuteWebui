# Performance Settings Spec

## Problem
The web interface occasionally feels sluggish when rendering the media pool or extracting thumbnails for long videos. High-resolution thumbnails take longer to extract and load, and fetching them repeatedly from the filesystem incurs disk I/O latency. The user wants the interface to be "snappier", akin to the McMaster-Carr website, by utilizing lower-resolution thumbnails and an in-memory (RAM) cache for serving thumbnails.

## Approach
We will introduce a "Performance" section within the existing "Settings" tab (`app/static/js/tabs/settings.js`). 

1. **Settings State & Persistence**: 
   - Add a `state.settings` object to the frontend (e.g., in `persistence.js` or a new `settings-store.js`) to save preferences in `localStorage`.
   - Settings to add:
     - `thumbnailSize`: (Options: High (480p), Medium (240p), Low (120p)). Default: High.
     - `thumbnailsToRam`: Boolean. Default: false.

2. **Frontend UI Update**:
   - In `app/static/js/tabs/settings.js`, replace the placeholder Performance card with real interactive controls designed with a tactile, DAW-like feel.
   - Use a **3-position knob** for Thumbnail Size (H, M, L).
   - Use a **toggle switch** for "Keep Thumbnails in RAM" (RAM vs Disk).
   - **pHash RAM Cache Toggle**: "Keep Hashes in RAM" for instant duplicate matching/sorting.
   - **Autosave Interval Knob**: A knob (e.g., 5s, 30s, 1m) to control how often the session autosaves to disk.
   - When changed, these settings must be persisted to `localStorage` and sent to the backend so it knows how to serve and extract thumbnails.

3. **Tool-Specific UI Updates**:
   - Instead of a global setting, add a "Keep Model Warm" toggle (off by default) directly inside the Neural FX tabs (DeepDream, Style Transfer, FastSAM). This pins PyTorch/OpenVINO weights in VRAM to eliminate 3-second startup delays on subsequent runs.

3. **Backend Adjustments & Constraints**:
   - `app/media/thumbnails.py`: Adjust the `scale=480:-2` in ffmpeg commands dynamically based on the requested thumbnail size.
   - **Cache Identity & Invalidation**: Changing thumbnail resolution must correctly bust the cache without colliding with old keys. Add a size parameter to the `/api/thumbnail` route (e.g. `&s=H`) and use it in the underlying `~/.cache/mtapi/media/by_hash/<hash>/first_<size>.jpg` filenames to ensure we don't serve a stale `immutable` URL or overwrite a High res thumb with a Low res thumb on the same key.
   - **RAM LRU Cache Rules**: The `lru_cache` for JPEGs and pHashes MUST be bounded by bytes (e.g. tracking size), not just by entry count (`maxsize=1000` could lead to OOM). It also must support explicit invalidation when source extraction changes or when a user clears the cache.
   - Ensure `immutable` cache headers are only served when the URL fully specifies the resolution version.

## Files to Touch
- `mtapi-project/app/static/js/tabs/settings.js`: Render the real form fields, attach event listeners to save settings.
- `mtapi-project/app/static/js/pool/persistence.js` (or a dedicated store): Logic to load/save settings to `localStorage` and sync with backend.
- `mtapi-project/app/media/thumbnails.py`: Accept a `scale` or `resolution` parameter when extracting frames.
- `mtapi-project/app/routes/media.py`: 
  - Expose a `POST /api/settings` endpoint to store the global settings.
  - Implement an LRU cache for thumbnail bytes.

## Pattern to Follow
- Keep the UI responsive and dark-themed, using existing `.form-group` and `.form-control` CSS classes.
- Use the existing notification system if restarting or clearing the pool is necessary when changing thumbnail sizes.
- Never write ad-hoc ffmpeg commands; extend `extract_frame` and `extract_frame_at` safely by parameterizing the `scale` string.

## Pitfalls
- **Cache Invalidation**: If the user switches from High to Low resolution, existing thumbs on disk are already 480p. The spec should clarify: the resolution setting applies to *newly generated* thumbnails (or we can add a "Clear Thumbnail Cache" button).
- **RAM Bloat**: An unconstrained LRU cache could OOM the server if thousands of thumbnails are loaded. Ensure `lru_cache(maxsize=1000)` or similar is used on the backend.

## Verification Steps
1. Navigate to the Settings tab in the WebUI.
2. Change the Thumbnail Size to "Low (120p)" and toggle "Keep Thumbnails in RAM" to ON.
3. Import a new video into the Video Pool.
4. Verify the frontend requests the thumbnail and it renders.
5. Inspect the generated thumbnail on disk (in `by_hash/...`): confirm its width is 120 pixels, not 480.
6. Refresh the page: the backend should serve the thumbnail directly from RAM (time the HTTP request to ensure it is near 0ms).
