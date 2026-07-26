# Latent Space Interpolation (`latentmorph`)

## Concept
Morphs between two face/portrait images by encoding them both into the StyleGAN2 latent space, performing Spherical Linear Interpolation (Slerp) between their latent vectors, and decoding the intermediate vectors into a smooth video transition.

## Architecture & Hardware Guardrails
- **Backend**: OpenVINO FP16 (`openvino.runtime`).
- **Models**: `e4e` (encoder for editing) to embed real images into latent space $W+$, and `StyleGAN2` (generator) to decode latents back to images.
- **Resolution**: `256x256` to ensure it streams easily on the Intel iGPU.
- **Hardware Target**: Intel Iris Xe Graphics. Use `device="GPU"` and `INFERENCE_PRECISION_HINT: f16` when compiling the OpenVINO models.

## Implementation Design (Pipeline)
1. **Encode**: Pass Image A and Image B into the `e4e` OpenVINO model to retrieve latents `w_a` and `w_b` (Shape: `1 x 14 x 512`).
2. **Interpolate**: Over $N$ frames, interpolate between `w_a` and `w_b` using Slerp (Spherical Linear Interpolation), NOT standard Lerp (which causes image washout in the middle).
3. **Decode**: Pass the intermediate vectors through the `StyleGAN2` OpenVINO Generator model to output video frames.
4. **Compile**: Combine the frames into a video using FFmpeg.

## Parameter Schema
- `input_a_path` (string): Source image A.
- `input_b_path` (string): Source image B.
- `duration` (float): Duration of morph in seconds. Default 2.0.
- `fps` (int): Framerate. Default 30.

## UI Requirements
- Found under "Hallucination" tab.
- Two file upload zones (Image A and Image B).
- Duration slider.
