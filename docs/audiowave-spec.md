# Audio-Reactive Waveforms (`audiowave`)

## Concept
Overlays a live audio visualizer directly onto a video stream, syncing automatically to the audio track. Perfect for synthwave music videos or podcast clips.

## FFmpeg Capabilities
- `showwaves`: Classic waveform oscilloscope.
- `avectorscope`: Stereo phase polar/lissajous vector traces.
- `showspectrum`: Frequency waterfall/spectrogram.

## Implementation Design (Pipeline)
Since we are overlaying over video, we use `-filter_complex` with `colorkey` or `blend`.

### Preset: Neon Oscilloscope (`showwaves`)
Centered line waveform overlaid via additive screen blend.
```bash
-filter_complex \
"[0:a]showwaves=s=1280x240:mode=cline:colors=0x00FFFF|0xFF00FF:split_channels=1[wave]; \
 [0:v][wave]blend=all_mode=screen[out]" \
-map "[out]" -map 0:a
```

### Preset: Vector Radar (`avectorscope`)
Polar oscilloscope in the corner. Uses colorkey for transparency.
```bash
-filter_complex \
"[0:a]avectorscope=m=polar:d=aaline:s=400x400:rc=0:gc=255:bc=255,colorkey=0x000000:0.01:0.1,format=yuva420p[scope]; \
 [0:v][scope]overlay=20:20[out]" \
-map "[out]" -map 0:a
```

### Preset: Magma Waterfall (`showspectrum`)
Scrolling frequency spectrum at the bottom.
```bash
-filter_complex \
"[0:a]showspectrum=s=1280x300:color=magma:scale=cbrt:slide=scroll,colorkey=0x000000:0.01:0.1,format=yuva420p[spec]; \
 [0:v][spec]overlay=0:H-h[out]" \
-map "[out]" -map 0:a
```

## Parameter Schema
- `preset` (enum): `neon_wave`, `vector_radar`, `magma_waterfall`
- `color` (string): For `neon_wave`, hex colors (e.g. `0x00FFFF|0xFF00FF`).

## UI Requirements
- Check for audio presence via ffprobe (must fail gracefully if video has no audio track).
- Dropdown for Preset.
- String input for Colors (if applicable).
