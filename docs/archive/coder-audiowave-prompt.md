# Coder Prompt — Audio-Reactive Waveforms (`audiowave`)

> **Target**: ffTransmuteWebui — new standalone operation + new WebUI tab
> **Spec reference**: `docs/audiowave-spec.md` (same directory)

---

## MISSION
Implement an "Audio Wave" operation that overlays audio visualizers (showwaves, avectorscope, showspectrum) directly onto the video.

## PHASE 1 — BACKEND: `audiowave_ops.py`
Create `mtapi-project/app/operations/audiowave_ops.py`.
Define Pydantic schema `AudioWaveParams` with `preset` (neon_wave, vector_radar, magma_waterfall).

**Critical Check:**
Use `ffprobe` to check if the input file has an audio stream. If it does NOT, return `OperationResult(ok=False, error="Input file has no audio stream to visualize.")`.

**Logic for Filter Generation:**
- `neon_wave`: 
  ```bash
  -filter_complex "[0:a]showwaves=s=1280x240:mode=cline:colors=0x00FFFF|0xFF00FF:split_channels=1[wave];[0:v][wave]blend=all_mode=screen[out]" -map "[out]" -map 0:a
  ```
- `vector_radar`:
  ```bash
  -filter_complex "[0:a]avectorscope=m=polar:d=aaline:s=400x400:rc=0:gc=255:bc=255,colorkey=0x000000:0.01:0.1,format=yuva420p[scope];[0:v][scope]overlay=20:20[out]" -map "[out]" -map 0:a
  ```
- `magma_waterfall`:
  ```bash
  -filter_complex "[0:a]showspectrum=s=1280x300:color=magma:scale=cbrt:slide=scroll,colorkey=0x000000:0.01:0.1,format=yuva420p[spec];[0:v][spec]overlay=0:H-h[out]" -map "[out]" -map 0:a
  ```

Note: You might need to inject the video's width (`iw`/`W`) into the `showwaves` or `showspectrum` size parameter if the video is not exactly 1280 wide, or use FFmpeg's width expressions if supported, or probe the video dimensions first. For simplicity, probing video width/height and generating exact sizes is best (e.g. `s={width}x{height//3}`).

Register the operation. Import in `__init__.py`.

## PHASE 2 — FRONTEND: app.js + index.html
- Add `audiowave` tab under "Glitch / FX".
- Form: Preset dropdown.
- Add routing and execution logic.
