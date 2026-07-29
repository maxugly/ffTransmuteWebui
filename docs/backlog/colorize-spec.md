# B&W Colorization (`colorize`)

## Concept
Use the DDColor-Tiny Dual Decoder model to semantically colorize black and white images or videos. DDColor understands context (sky=blue, grass=green) significantly better than older GAN-based colorizers.

## Architecture & Hardware Guardrails
- **Model**: `DDColor-Tiny` (Official Intel OpenVINO support).
- **Backend**: OpenVINO (`openvino.runtime`).
- **Precision**: FP16.
- **Color Space**: CIE Lab space. Only the $L$ (Lightness) channel is processed by the AI; original sharpness is perfectly preserved.
- **Execution**: Batch size 1. Very lightweight (~500MB VRAM).

## Implementation Design (Pipeline)
1. **Input Prep**: Ensure input is 3-channel BGR. Convert to CIE Lab (`cv2.cvtColor`). Extract the $L$ channel.
2. **Model Input**:
   - Resize the $L$ channel to 512x512.
   - Normalize it to range `[0, 100]` (divide by 255, multiply by 100).
   - Replicate the $L$ channel 3 times to shape `(1, 3, 512, 512)`.
3. **Inference**: Pass the tensor to the DDColor OpenVINO model on `"GPU"`. It returns predicted $a$ and $b$ chrominance channels.
4. **Output Reconstruction**:
   - Resize the predicted $a$ and $b$ channels back to the original image dimensions using `INTER_CUBIC`.
   - Shift the predictions (range `[-128, 127]`) by `+128` to fit OpenCV's uint8 Lab format `[0, 255]`.
   - Merge the original high-resolution $L$ channel with the predicted $a$ and $b$ channels (`cv2.merge`).
   - Convert back to BGR.

## Parameter Schema
- `input_path` (string): Source image/video.
- `output_path` (string, optional): Target output path.

## UI Requirements
- Found under "Image AI" tab.
- Simple run button (no complex tuning parameters needed for basic colorization).
