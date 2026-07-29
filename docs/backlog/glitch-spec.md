# Databending & Pixel Sorting (`databend` / `pixelsort`)

## Concept
These are pure Algorithmic Glitch operations. They manipulate raw pixel data using mathematics, with zero AI or neural networks. Fast, volatile, and highly aesthetic.

1. **Databending**: Treats the image's flattened pixel array as a 1D audio waveform. Applies audio DSP (Digital Signal Processing) effects like Delay/Echo, Lowpass Filters, and Bitcrushing, then wraps the waveform back into a 2D image matrix.
2. **Pixel Sorting**: Isolates pixels that fall within a specific luminance threshold range and sorts them spatially (horizontally or vertically) creating a melting or smearing aesthetic.

## Architecture & Hardware Guardrails
- **Backend**: Pure Python (`numpy`, `scipy.signal`).
- **Speed Constraints**: DO NOT use Python `for` loops for iterating over pixels. The operations must be 100% vectorized using numpy C-API calls to ensure they execute in milliseconds on the CPU.
- **Pixel Sort Math**: Use `np.argsort` combined with accumulator logic (`np.maximum.accumulate`) to create bounding masks and sort continuous threshold keys without loops.

## Implementation Design (Pipeline)
1. **Databending**:
   - Read Image -> `flatten()` to 1D float32 array in `[-1.0, 1.0]`.
   - Apply `scipy.signal.sosfilt` (for frequency filtering) or convolution (for reverb).
   - Reshape back to `(H, W, 3)` uint8.
2. **Pixel Sorting**:
   - Convert to Luminance mask.
   - Define interval boundaries.
   - Generate continuous floating point keys for valid interval pixels.
   - Execute a single global `np.argsort(keys, axis)`.
   - `np.take_along_axis` to reorder the RGB channels.

## Parameter Schema
- For `databend`: `effect` (enum: lowpass, delay, bitcrush).
- For `pixelsort`: `axis` (horizontal, vertical), `lum_min` (0-255), `lum_max` (0-255).

## UI Requirements
- Found under "Glitch" tab.
- Distinct tools for bending and sorting.
