# Optical Flow Maps (`opticalflow`)

## Concept
Generate an RGB-encoded optical flow map from a video, where color (Hue) represents the direction of motion, and intensity/saturation (Value) represents the speed. Useful as a mask source or for datamosh guidance.

## Architecture & Hardware Guardrails
- **Model/Engine**: OpenCV `DISOpticalFlow` (Dense Inverse Search).
- **Why not RAFT/OpenVINO?** RAFT requires massive VRAM for correlation volumes, which crashes 16GB shared RAM systems at 1080p. OpenCV DIS is 2x-5x faster (50+ FPS), uses < 30MB RAM, has zero cold-start model loads, and produces crisp motion boundaries perfect for glitch masking.
- **Execution**: Pure CPU, multi-threaded C++ backend via `opencv-python`.

## Implementation Design (Pipeline)
1. **Engine**: `dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_FAST)`.
2. **Frame Loop**: Read via `cv2.VideoCapture`. Convert to grayscale.
3. **Downscaling**: To maintain extreme speed on 1080p/4K footage, compute flow at a downscaled resolution (e.g. `scale_factor = 0.5`) and upsample the resulting flow vectors back to full size using `INTER_LINEAR`.
4. **RGB Encoding**:
   - `mag, ang = cv2.cartToPolar(dx, dy, angleInDegrees=True)`
   - HSV mapping: `H = ang / 2.0`, `S = 255`, `V = min((mag / max_speed) * 255, 255)`
   - Convert HSV to BGR and write frame.
5. **Encoding**: Write frames to `mp4`.

## Parameter Schema
- `input_path` (string): Source video.
- `output_path` (string, optional): Target video path.
- `scale` (float): Processing resolution scale (0.1 to 1.0, default 0.5 for speed).
- `max_speed` (float): Normalization threshold for speed magnitude (default 15.0).

## UI Requirements
- Found under "Video AI" tab.
- Sliders for Scale and Max Speed.
