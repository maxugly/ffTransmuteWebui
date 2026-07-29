# Slit-Scan / Time Displacement (`slitscan`)

## Concept
A pure FFmpeg filter chain that creates eerie time-displacement, motion trails, and temporal ghosting by blending multiple frames across time. Rather than doing heavy optical flow, it relies on temporal mixing (`tmix`) and frame blending (`tblend`) to smear motion non-destructively.

## FFmpeg Capabilities
- `tmix`: Blends $N$ consecutive frames together with weighted averaging. Creates smooth motion trails.
- `tblend`: Blends two consecutive frames using standard blend modes (`lighten`, `darken`, `difference`, `exclusion`).

## Implementation Design (Pipeline)
The user selects a "Preset" which dictates the filter graph structure.

### Preset 1: Light Trails (tmix)
Averaging multiple frames, biased towards brighter pixels.
```bash
-vf "format=rgba,tmix=frames={frames}:weights='1 0.9 0.8 0.7 0.6 0.5',tblend=all_mode=lighten,format=yuv420p"
```

### Preset 2: Dark Trails
Same as Light Trails, but using `darken`.
```bash
-vf "format=rgba,tmix=frames={frames}:weights='1 0.9 0.8 0.7 0.6 0.5',tblend=all_mode=darken,format=yuv420p"
```

### Preset 3: Spectral Difference
Uses `difference` mode to extract motion edges.
```bash
-vf "tmix=frames={frames}:weights='1 0.8 0.5',tblend=all_mode=difference"
```

### Preset 4: True Slit-Scan (Vertical Slices)
Divides the frame horizontally into bands, delaying each one further in time. (Keep it simple: 4 bands).
```bash
-filter_complex \
"[0:v]split=4[v0][v1][v2][v3]; \
 [v0]crop=iw:ih/4:0:0[s0]; \
 [v1]setpts=PTS+0.15/TB,crop=iw:ih/4:0:ih/4[s1]; \
 [v2]setpts=PTS+0.30/TB,crop=iw:ih/4:0:2*ih/4[s2]; \
 [v3]setpts=PTS+0.45/TB,crop=iw:ih/4:0:3*ih/4[s3]; \
 [s0][s1][s2][s3]vstack=inputs=4[out]"
```

## Parameter Schema
- `preset` (enum): `light_trails`, `dark_trails`, `difference`, `slit_scan_4`
- `frames` (int): Number of frames for trail generation (applies to trails presets). Range: 3-30. Default: 10.

## UI Requirements
- Dropdown for Preset.
- Slider for frames (3-30). Hidden if preset is `slit_scan_4`.
