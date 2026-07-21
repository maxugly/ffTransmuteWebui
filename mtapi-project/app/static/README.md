# static — WebUI Frontend Client

The `static` directory houses the frontend web client for `ffTransmuteWebui`. It is built with vanilla HTML5, CSS3, and JavaScript (ES6+) with zero build tools or external npm package requirements.

---

## 📁 File Structure

```
static/
├── index.html     # Single-page web application HTML document
├── style.css      # Dark-mode styling, layouts, parameter forms, and animation rules
└── app.js         # Frontend JavaScript client logic (API calls, state, DOM rendering)
```

---

## 🎨 Design & Features

1. **Workspace & Media Browser**:
   - Lists local media files from `/home/m/snc/cod/ffTransmuteWebui` via `GET /media/workspace`.
   - Displays metadata (duration, resolution, fps, size, codecs) and thumbnail previews fetched from `media_store`.
2. **Operation Panel**:
   - Queries `GET /ops` to dynamically render operational forms based on OpenAPI JSON schemas.
   - Handles parameter inputs (single file picker, multi-file selection for grid/join, numerical range controls).
3. **Execution Feedback & Terminal Output**:
   - Sends `POST /ops/{operation_id}` requests with typed JSON payloads.
   - Renders live `stdout`, `stderr`, exact ffmpeg shell commands, and status indicators.
4. **Media Pool / History**:
   - Manages active media pools and execution history with quick output inspection and re-use.
