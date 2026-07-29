# Face Restoration (`facerestore`)

## Concept
Uses CodeFormer to reconstruct and enhance facial details from blurry, low-resolution, or damaged images. To preserve system memory (16GB RAM constraint on Intel Xe), the pipeline detects faces first, crops them, restores the crop, and seamlessly pastes them back into the original image.

## Architecture & Hardware Guardrails
- **Models**: RetinaFace (Detection) + CodeFormer (Restoration).
- **Backend**: OpenVINO (`openvino.runtime`).
- **Precision**: FP16 for both models.
- **Tiling/Cropping**: RetinaFace runs on downscaled 640x640 input. CodeFormer runs strictly on 512x512 aligned face crops.
- **Performance**: Asynchronous execution via `compiled_model.create_infer_request()` if scaling to video, but batch size 1 synchronous is acceptable for images.

## Implementation Design (Pipeline)
1. **Model Loader**: Provide helpers to convert `CodeFormer` PyTorch checkpoint to OpenVINO FP16 (`codeformer_fp16.xml`) and load a standard `RetinaFace` ONNX to OpenVINO FP16 (`retinaface_fp16.xml`).
2. **Face Detection**: Run RetinaFace to find bounding boxes and 5 key landmarks (eyes, nose, mouth corners).
3. **Align & Crop**: Use `cv2.estimateAffinePartial2D` and `cv2.warpAffine` to crop the face to a canonical 512x512 alignment based on FFHQ templates.
4. **Restoration**: Pass the 512x512 aligned face and a dynamic `fidelity_weight` (w=0.5 default) tensor to CodeFormer FP16 on the iGPU.
5. **Paste & Blend**: 
   - Generate a 512x512 feathered elliptical mask.
   - Compute the inverse affine transform.
   - Warp the restored face and mask back to the original image dimensions.
   - Alpha blend the restored face over the original image using the feathered mask to eliminate seams.

## Parameter Schema
- `input_path` (string): Source image/video.
- `output_path` (string, optional): Target output path.
- `fidelity_weight` (float): Range 0.0 to 1.0 (0 = highest AI enhancement, 1.0 = highest identity preservation). Default 0.5.

## UI Requirements
- Found under "Image AI" tab.
- Continuous Knob for `fidelity_weight`.
- Note in UI: "Automatically detects and restores faces. Leave fidelity near 0.5 for best balance."
