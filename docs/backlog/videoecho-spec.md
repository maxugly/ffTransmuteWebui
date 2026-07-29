# Video Echo / Temporal Feedback (`videoecho`)

## Concept
Uses the FFmpeg `lagfun` filter to create phosphorescent light trails, retro CRT ghosting, and "liquid motion" by decaying pixel values exponentially over time.

## FFmpeg Capabilities
- `lagfun=decay=D:planes=P`
- `decay`: Float from 0 to 1. Higher value = longer trail. (0.95 is classic ghosting, 0.99 is extremely long).
- `planes`: Bitmask. `1` = Luma only (clean, monochrome light trails). `7` = All color planes (colorful smears).

## Implementation Design (Pipeline)
A simple `-vf` pipeline combining `lagfun` and optional contrast boost or blur.

### Preset: CRT Ghosting (Luma Only)
Clean light trails without color bleeding.
```bash
-vf "lagfun=decay={decay}:planes=1,eq=contrast=1.15:brightness=0.01"
```

### Preset: Liquid Motion (All Color Planes + Blur)
Colorful, melting trails.
```bash
-vf "lagfun=decay={decay}:planes=7,gblur=sigma=2.0:steps=1,eq=saturation=1.3"
```

### Preset: Chromatic Split (RGB Desync)
Different decay rates for Red, Green, and Blue.
```bash
-vf "format=gbrp,split=3[r][g][b];[r]lagfun=decay={decay}:planes=1[r_out];[g]lagfun=decay={decay-0.03}:planes=2[g_out];[b]lagfun=decay={decay-0.08}:planes=4[b_out];[r_out][g_out][b_out]mergeplanes=0x000102:gbrp,format=yuv420p"
```

## Parameter Schema
- `preset` (enum): `crt_ghost`, `liquid_motion`, `chromatic_split`
- `decay` (float): Range 0.5 to 0.99. Default 0.95.

## UI Requirements
- Dropdown for Preset.
- Continuous Knob for `decay`.
