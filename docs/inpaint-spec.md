# Generative Inpainting & Scratch Removal (`inpaint`)

## Concept
Uses the Large Mask Inpainting (LaMa) model to seamlessly remove objects, text, or scratches from images. For old photo restoration, it combines a lightweight Scratch Detection UNet to automatically generate a damage mask, which is then fed into LaMa.

## Architecture & Hardware Guardrails
- **Model**: `big-lama` ONNX -> OpenVINO FP16. (Optional: Scratch Detection UNet ONNX -> OpenVINO).
- **Backend**: OpenVINO (`openvino.runtime`).
- **Precision**: FP16.
- **Padding Requirement**: LaMa uses Fast Fourier Convolutions (FFCs). Input spatial dimensions must be padded to a multiple of 8 (modulo 8). If they are not, the FFT ops will crash or distort edges. Use `cv2.BORDER_REFLECT`.

## Implementation Design (Pipeline)
1. **Mode 1: Manual Mask Inpainting**
   - User provides Image + Binary Mask (where white = remove).
   - Pad image and mask to modulo 8.
   - Run LaMa OpenVINO FP16.
   - Crop output back to original dimensions.
2. **Mode 2: Auto Scratch Removal ("Old Photo")**
   - User provides damaged Image.
   - Run morphological top-hat filter (or Scratch UNet if available) to detect scratches, generating a mask.
   - Dilate the mask by 1-2 pixels to ensure edges are covered.
   - Feed `(Image, Auto-Mask)` to LaMa.

## Parameter Schema
- `input_path` (string): Source image.
- `mask_path` (string, optional): Mask image (required if mode is manual).
- `mode` (enum): `manual`, `auto_scratch`.

## UI Requirements
- Found under "Image AI" tab.
- Mode dropdown.
- Optional Mask file input (hidden if auto_scratch).
