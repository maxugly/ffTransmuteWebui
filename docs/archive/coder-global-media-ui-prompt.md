# Coder Prompt — Global Active Media UI

> **Target**: ffTransmuteWebui — `mtapi-project/app/static/app.js` and `index.html`
> **Spec reference**: `docs/global-media-ui-spec.md` (same directory)

---

## MISSION
Refactor the frontend WebUI to use a single, persistent "Global Active Media" input bar that travels across all operation tabs. Implement smart validation that disables the Run button if the current tool doesn't support the selected media type.

## PHASE 1 — HTML LAYOUT (`index.html`)
1. Create a global input bar above the tab content area. 
   - Element: `<input type="text" id="global-media-input" placeholder="/absolute/path/to/media.mp4">`
   - Include a visual warning area: `<span id="global-media-warning" style="color: red; display: none;"></span>`
2. Remove the individual "Input File" boxes from all the existing operation tabs (e.g., datamosh, deepdream, styletransfer).
3. Add a `data-supported-media` attribute to each tab's container or button. 
   - Example: `<div id="tab-datamosh" data-supported-media="video">`
   - Example: `<div id="tab-upscale" data-supported-media="image,video">`

## PHASE 2 — JAVASCRIPT LOGIC (`app.js`)
1. **State**: Track the value of `#global-media-input`.
2. **Validation Loop**: Create a function `validateGlobalMedia()` that runs whenever the user types in the global input OR switches tabs.
   - Determine if the global string ends in a video extension (`.mp4`, `.mkv`, `.avi`, `.webm`) or image extension (`.jpg`, `.jpeg`, `.png`, `.webp`).
   - Check the `data-supported-media` of the currently active tab.
   - If mismatch (e.g., Video selected on Image-only tool):
     - Disable the tool's "Run" or "Process" button.
     - Show warning: *"Video not supported for this tool, please select an image."* (or vice versa).
   - If match (or both supported):
     - Enable the "Run" button.
     - Hide the warning.
3. **Payload Construction**: Update all API `fetch()` calls so they pull `input_path` directly from `#global-media-input.value` rather than a local tab input.
