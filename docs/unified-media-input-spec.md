# Unified Global Media Input — Spec

> Status: Proposed
> Kind: E (UI Refactor)

## Problem
The current WebUI uses separate global inputs with buttons for 'V - in' / 'V - out' (Video) and 'I - in' / 'I - out' (Image). Introducing an "Audio" layer would add a third set of in/out controls, consuming valuable vertical screen space, creating cognitive overload, and violating the minimalist design language. 

## Goals / Non-goals
**Goals:**
- Consolidate the global inputs into a single unified pair of buttons: `I` (In) and `O` (Out).
- Provide file picker dialog filters for specifically isolating Audio, Video, Image, or "All Supported".
- Introduce smart color-coding (Video = Orange, Audio = Green, Image = Purple) to instantly communicate the active media type.
- Eliminate the word "Browse" and any legacy redundant path pickers.
- Maintain compatibility with downstream operations that expect to know the type of the global input.

**Non-goals:**
- Modifying the underlying backend separation (we still process them differently in operations).
- Merging the actual "Video Pool" and "Image Pool" libraries (this spec focuses *only* on the global `I`/`O` controls).

## User story
1. User looks at the global bar and sees a single `I` (In) and `O` (Out) row instead of the old `V - in`/`V - out` and `I - in`/`I - out`.
2. User clicks the `I` button. The file picker dialog appears with a dropdown filter at the bottom: "All Supported", "Audio", "Video", "Image".
3. User selects `drum_loop.wav`. The file loads into the global input.
4. The global input box's outline and text font instantly change to **Green** (Audio).
5. User later clicks `I` and selects `render.mp4`. The input box outline and font change to **Orange** (Video).
6. User selects a reference still `frame.png`. The box turns **Purple** (Image).

## Architecture
- **Frontend CSS:** We introduce three new CSS utility classes (`media-mode-video`, `media-mode-audio`, `media-mode-image`) that apply the respective border and text colors.
- **Frontend JS:** A central media manager script that listens to the `change` event on the file input, extracts the file extension, checks against a known dictionary of extensions (e.g., `mp4, mov -> video`, `wav, mp3 -> audio`, `png, jpg -> image`), and updates the DOM class.
- **File Picker Constraints:** The native dialog triggered by the `I` and `O` buttons will use the `accept` attribute mapped to mime types or extensions to trigger the OS-level dropdown filters.

## Files to touch
- **Frontend HTML:** `app/index.html` (Replace `V - in`/`V - out` and `I - in`/`I - out` with unified `I` and `O` controls).
- **Frontend CSS:** `app/static/css/style.css` (Add the `.media-mode-*` color classes).
- **Frontend JS:** `app/static/js/ui/global-bar.js` (or equivalent file handling the global inputs).
- **Docs:** `docs/unified-media-input-spec.md` (This document).

## UI Sketch
```text
========================================================================
[ I ] /absolute/path/to/my_file.wav    (Green Outline / Font)
[ O ] /absolute/path/to/output.wav     (Green Outline / Font)
========================================================================
```
*If a tab requires a specific type (e.g. the Cut tab requires Video/Audio but not an Image), the tab's logic will read the global state and display an error "This operation requires a Video or Audio file." if an Image is loaded.*

## Params / State Changes
The global frontend state currently tracks `globalVideoPath` and `globalImagePath`.
This will be refactored to:
- `globalMediaPath: string`
- `globalMediaType: enum('video', 'audio', 'image', 'mixed')`
- `globalOutputPath: string`

## Edge cases
- **Multiple Files (Mixed Types):** If the user selects multiple files (e.g. `1.mp4` and `2.wav`) via the `I` button, the UI will either outline in a neutral gray, or default to the type of the first file in the array.
- **Unsupported Extensions:** Falls back to neutral styling and sets type to `unknown`.
- **Legacy Tabs:** Any JS tab referencing specific V/I input element IDs will need to be updated to pull from the unified `I` and `O` inputs.

## Acceptance tests
- **UI:** Clicking the `I` button and selecting a video turns the box orange. Selecting audio turns it green. Selecting an image turns it purple.
- **Picker:** OS file picker displays the required filters (Audio, Video, Image, All Supported).
- **State Integrity:** Existing tabs that rely on the global video path successfully retrieve the path from the new unified input.

## Risks
- **Extensive Refactor:** Many existing tabs and operations hardcode references to the specific video or image DOM elements. This will require a pass over `app/static/js/tabs/*.js` to ensure they point to the new unified ID.
