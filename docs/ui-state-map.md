# UI State Map — Variables and Controls

This document provides a comprehensive list of all state variables and controls across the WebUI, grouped by their respective tabs, as well as global and internal (transient) states.

---

## 1. Global / Application Level

These states are shared across the entire application and govern the core workspace.

### `window.globalInputs`
Maintains the active media paths and global frame range selections across tabs.
* `video` (string): Newline-separated list of active video paths.
* `image` (string): Newline-separated list of active image paths.
* `pathIn` (string): Active input directory path.
* `pathOut` (string): Active output directory path.
* `frameStart` (number): Global frame range start point.
* `frameEnd` (number): Global frame range end point.
* `totalFrames` (number): Total frame count probed from the active video.

### `state` (Core App State)
* `activeTab` (string): The currently active tab ID (e.g., `'mosh'`, `'pool'`, `'cut'`).
* `health` (object): System health status (`{ ok: true, warnings: [] }`).
* `operations` (object): Fetched backend operations schema/registry.
* `multiClips` (array): List of paths used for Multi-Clip layouts (Join / Grid).
* `project` (object): Open project file tracking.
  * `path` (string): Absolute path to `.ffproject.json`.
  * `name` (string): Name of the project.
  * `dirty` (boolean): Flag indicating unsaved changes.

### `state.fb` (Modal File Browser)
* `currentPath` (string): Current directory being browsed.
* `selectedPath` (string): Path of the highlighted item.
* `selectedName` (string): Name of the highlighted item.
* `selectedIsDir` (boolean): True if the highlighted item is a directory.
* `targetInputId` (string): ID of the DOM element to receive the picked path.
* `selectDirOnly` (boolean): Restrict selection to directories.
* `resolveMode` (string): Mode of resolution (`'file'` or `'dir'`).

---

## 2. Tab-Specific States

### Datamosh (`mosh`)
* `selectedMoshMode` (string): The active mosh engine (`'melt'` or `'classic'`).
* `moshVideoFrames` (number): Frame tracking specific to datamosh processing.

### Face Morph (`facemorph`)
* `faceMorph.images` (array): Array of objects `{path, name}` representing the face sequence.
* `faceMorph.folder` (string): Folder path for batch morph operations.

### withoutBG (`withoutbg`)
* `withoutbg.images` (array): Array of objects `{path, name}` for background removal.
* `withoutbg.folder` (string): Folder path for batch background removal operations.

### Style Transfer (`styletransfer`)
* `styleTransfer.contents` (array): Array of objects `{path, name}` (content images).
* `styleTransfer.stylePath` (string): Path to the single style reference image.

### Quick Transmute (`quick`)
* `quick.reconcile` (string): How to handle mismatched resolutions (`'pad'`, `'crop'`, `'stretch'`).
* `quick.aspect` (string): Target aspect ratio (`'auto'`, `'16:9'`, `'1:1'`, `'custom'`, etc.).
* `quick.aspectCustom` (string): Custom aspect ratio string (e.g., `'W:H'` or `'WxH'`).

### Folder Watcher (`watcher`)
* `watcher.enabled` (boolean): Toggle for active directory watching.
* `watcher.in_dir` (string): Input directory path to watch.
* `watcher.out_dir` (string): Output directory path for processed files.
* `watcher.resize_mode` (string): Scaling mode (`'letterbox'`, etc.).
* `watcher.status` (object | null): Live status object from the backend.
* `watcher.pollTimer` (number | null): Interval ID for the active polling loop.

### Video Pool & Sequence (`pool`, `sequence`)
* `pool.items` (array): The main library of video clips.
* `pool.selectedPath` (string): Sticky selection syncing library ↔ sequence.
* `pool.selectedSeqId` (string): Specific ID of the selected sequence token.
* `pool.filterQuery` (string): Live fuzzy search filter input.
* `pool.sequence` (array): Ordered clips for the timeline stitcher (`{ id, path, name, targetDuration }`).
* `pool.reconcile` (string): Sequence frame conform strategy (`'pad'`, `'crop'`, `'stretch'`).
* `pool.aspect` (string): Target sequence aspect ratio.
* `pool.aspectCustom` (string): Custom aspect ratio.
* `pool.outputPath` (string): Target file render path.
* `pool.playback` (object): Inline sequence preview state (`{ playing, index, loop, video }`).
* `pool.tileZoom` (number): Grid tile size slider value.
* `pool.tileInfo` (object): Boolean toggles for metadata visibility on cards.
* `pool.matchMaxDistance` (number): pHash tolerance slider.
* `pool.matchMode` (string): Match search direction (`'next'`, `'prev'`, `'both'`).
* `pool.matchResults` (object | null): Last successful match API response.
* `pool.layout` (object): Resizable UI layout dock dimensions (`composeHeight`, `focusWidth`, `selectionHeight`, `matchHeight`, `collapsed` object).

### Image Pool (`images`)
* `imagePool.items` (array): The main library of still images.
* `imagePool.selectedPath` (string): Highlighted image path.
* `imagePool.filterQuery` (string): Live fuzzy search filter input.

### Cut (`cut`)
* `cut.refA` (string | null): Absolute path of Reference Image A (In point).
* `cut.refB` (string | null): Absolute path of Reference Image B (Out point).
* `cut.mode` (string): Active compare layout (`'separate'`, `'overlay'`, `'ab'`).
* `cut.compareMode` (string): Legacy alias for `mode`.
* `cut.overlayOpacity` (number): 0–100 opacity of the reference image layer.
* `cut.abPosition` (number): 0–100 percentage position of the wipe handle.

### Pan & Zoom (`zoompan`)
* `zoompan.imagePath` (string): The source image to pan/zoom.
* `zoompan.refPath` (string): Optional reference still for scene-match alignment.
* `zoompan.imageW` (number): Native width of the source image.
* `zoompan.imageH` (number): Native height of the source image.
* `zoompan.startBox` (object): The start viewport `{x, y, w, h}`.
* `zoompan.endBox` (object): The last viewport `{x, y, w, h}`.
* `zoompan.durationSec` (number): Length of the pan/zoom clip in seconds.
* `zoompan.fps` (number): Render framerate.
* `zoompan.aspect` (string): Locked aspect ratio of the bounding boxes.
* `zoompan.viewModeStart` (string): Layout toggle for start frame (`'full'` or `'zoomed'`).
* `zoompan.viewModeEnd` (string): Layout toggle for last frame (`'full'` or `'zoomed'`).
* `zoompan.compareTarget` (string): What the Compare Tool is evaluating (e.g., `'end_ref'`, `'start_end'`).
* `zoompan.mode` (string): Image compare mode (`'separate'`, `'overlay'`, `'ab'`).
* `zoompan.overlayOpacity` (number): Compare tool opacity slider value.
* `zoompan.abPosition` (number): Compare tool wipe slider value.

---

## 3. Non-Visible / Transient Internal States

These variables are used internally to manage async loading, UI hovering, and routing without explicitly drawing permanent DOM elements.

* `window.globalInputs._lastProbedPath` (string | null): Caches the last video probed to prevent redundant API calls.
* `window.globalInputs._probeOk` (boolean): Flag indicating successful probe.
* `state.pool.hoverPath` (string | null): Temporary path for the video pool detail sidebar (resets on mouseout).
* `state.pool.loading` (boolean): True while fetching pool folder scans.
* `state.pool.matchLoading` (boolean): True while calculating pHash scene matches.
* `state.pool.tileInfoMenuOpen` (boolean): Dropdown menu toggle state.
* `state.imagePool.loading` (boolean): True while fetching image folder scans.
* `state._cutPendingRef` (string | null): Tracks whether the user is in the Image Pool specifically to pick `'refA'` or `'refB'` for the Cut tab.
* `state._zoompanPendingRef` (boolean): Tracks whether the user hopped to the Image Pool to pick a Reference for the Pan & Zoom tab.
