> **LEGACY — do not build from this file. STATUS.md is law.**

# Global Active Media UI (`global_media_ui`)

## Concept
A persistent, global input bar in the WebUI that holds the "Active Media" (file path). As the user navigates between different operation tabs (Datamosh, RIFE, Upscale, etc.), the active media travels with them. This eliminates the friction of re-selecting the same file on every tab.

## Architecture
- **Placement**: A fixed bar at the top of the UI (or top of the main content area) containing a text input for the absolute file path, and a "Browse" button (if utilizing a local file picker or browser-native path selection).
- **State Management**: Stored in a global JavaScript variable in `app.js` (e.g., `window.activeMediaFile`).

## Validation & "Grey-Out" Logic
Because some operations only support Video, some only support Image, and some support Both, the UI must dynamically react to the intersection of the *Global File Type* and the *Current Tab's Capabilities*.

1. **Detection**: `app.js` checks the file extension of the Active Media (e.g., `.mp4`, `.webm` vs `.jpg`, `.png`).
2. **Tool Capabilities**: Each tool tab must have a data attribute indicating its supported types (e.g., `data-supported="video"` or `data-supported="image,video"`).
3. **Dynamic Feedback**:
   - If the user selects a Video, but switches to an Image-Only tab (e.g., `inpaint`): 
     - The "Run" button is disabled.
     - The Global Bar (or a local warning in the tab) displays: *"Video not supported for this tool, please select an image."*
   - If the user selects an Image, but switches to a Video-Only tab (e.g., `datamosh`):
     - The "Run" button is disabled.
     - Warning displays: *"Image not supported for this tool, please select a video."*
   - If supported, the "Run" button is active and uses the global file path in the JSON payload.

## Secondary Inputs
For operations that require a *second* file (e.g., Latent Morph needs Image A and Image B, or Inpaint needs a Mask):
- The Global Bar acts as "Input A".
- A local file input inside that specific tab acts as "Input B".
