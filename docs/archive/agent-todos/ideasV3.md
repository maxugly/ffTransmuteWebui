# mtapi WebUI Specification
## Intel 1335U + Xe iGPU, 16GB Shared RAM

*A practical roadmap for the sprinter. Existing: datamosh, deepdream, facemorph, style transfer, RIFE-withoutbg, ffmpeg scripts.*

---

## 0. Hardware Reality (Don't Ignore This)

**CPU**: 8 E-cores + 2 P-cores (single-threaded performance is modest)  
**GPU**: Intel Iris Xe iGPU (80 EUs, shared system memory)  
**RAM**: 16GB shared (kernel, GPU buffers, model weights all fight here)  
**Constraint**: No discrete GPU. Everything is CPU + iGPU + aggressive swapping if careless.

**What This Means**:
- Batch size = 1 always.
- FP16 OpenVINO conversions are non-negotiable (cuts VRAM in half).
- Tiling for any operation on frames > 1024x1024 or images > 2MP.
- Vulkan as fallback when OpenVINO support is thin (NCNN binaries).
- CPU tasks (detection, preprocessing) run while GPU processes inference.

---

## 1. FFmpeg Ops Layer (Utility Foundation)

These are the building blocks. Dead simple, no AI, pure pipeline work.

### Palette & Media Export
```bash
# Crisp GIF/WebP (two-pass palette)
ffmpeg -i input.mp4 -vf "fps=10,scale=320:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" -loop 0 output.gif

# WebP variant (better quality, smaller)
ffmpeg -i input.mp4 -vf "fps=10,scale=1280:-1:flags=lanczos" -c:v libwebp -q:v 70 output.webp
```

### Audio Processing
```bash
# EBU R128 loudness normalization (fix mixed source levels)
ffmpeg -i input.mp4 -af "loudnorm=I=-16:TP=-1.5:LRA=11" -c:v copy output.mp4

# Mute audio
ffmpeg -i input.mp4 -c:v copy -an output_muted.mp4

# Add silent track (for stitching without sync gaps)
ffmpeg -f lavfi -i anullsrc=r=44100:cl=stereo -i input_video.mp4 -c:v copy -shortest output.mp4
```

### Time Manipulation
```bash
# Time-lapse / frame sampling
ffmpeg -i input.mp4 -vf "fps=1" timelapse_1fps.mp4
ffmpeg -i input.mp4 -vf "select=not(mod(n\,10))" -vsync vfr hyperlapse.mp4

# LUT (color profile) application
ffmpeg -i input.mp4 -vf "lut3d=file=my_look.cube" output_lut.mp4
```

---

## 2. Video Processing Pipeline

### Existing Nodes
- ✅ **Datamosh** (ffglitch)
- ✅ **DeepDream** (style hallucination)
- ✅ **Face Morph** (shape interpolation)
- ✅ **Style Transfer** (fast AdaIN or similar)
- ✅ **RIFE without BG** (frame interpolation + transparency)

### Add-On Nodes (Prioritized)

#### Tier 1: High Impact, Intel Xe Native

**Motion Vector Overlay** (`codecview`)  
Draw H.264/MPEG-4 motion vectors as diagnostic HUD overlays (pairs perfectly with datamosh).
```bash
ffmpeg -flags2 +export_mvs -i input.mp4 -vf "codecview=mv=pf+bf+bb" motion_vectors.mp4
```
*Why*: Looks technical, minimal compute, great for debug/demo. Pure FFmpeg.

**Optical Flow Maps** (RAFT or Farneback)  
RGB-encoded flow (direction + speed as color intensity). Use as mask source for style transfer or datamosh guidance.
```python
# Output: flow_map.mp4 (RGB, compatible with masking nodes)
# Use OpenVINO RAFT if available, otherwise NCNN Vulkan fallback
```
*Implementation note*: CPU-intensive but parallelizable. Generate flow offline, feed to other nodes.

**Depth Map Extraction** (MiDaS or ZoeDepth)  
Per-frame depth grayscale. Drive faux-3D parallax, focus pulls, or displacement maps downstream.
```python
# Output: depth_map.mp4 (grayscale, same resolution as input)
# OpenVINO or Vulkan NCNN, batch size 1, tile if > 1080p
```

#### Tier 2: Glitch & Weird Effects (Low Compute, High Vibe)

**Slit-Scan / Time Displacement**  
Vertical/horizontal axis = time instead of space. Eerie motion trails.
```bash
ffmpeg -i input.mp4 -vf "tblend=all_mode=average" slit_scan.mp4
```

**Video Echo / Temporal Feedback** (`lagfun`)  
Previous frames bleed into current frames with decay. Liquid, ghostly trails.
```bash
ffmpeg -i input.mp4 -vf "lagfun=0.9" echo_effect.mp4
```

**Audio-Reactive Waveforms** (`showwaves` / `avectorscope`)  
Live oscilloscope or frequency spectrum overlay, synced to audio.
```bash
ffmpeg -i input.mp4 -filter_complex "showwaves=s=1280x720:mode=line" -c:v libx264 -c:a copy waveform.mp4
```

**Pixel Sorting** (Custom Python or Shader)  
Sort rows/columns by luminance, hue, or saturation. Falling/melting digital landscapes.  
*Note*: No native FFmpeg filter. Implement as Python postprocessor or GLSL shader node.

**Intentional Stream Corruption** (Bit-Flip Glitch)  
Direct byte-level manipulation on keyframes for hardware-level artifacts.  
*Note*: Requires external hex editor or custom C script. Low priority (cool but niche).

---

## 3. Single-Image Processing (Restoration & Enhancement)

### Tier 1: Highest ROI (Do These First)

**CodeFormer (Face Restoration)**  
Reconstructs facial detail from blur/low-res. Industry standard for old photo repair.
- Model: Convert `CodeFormer` backbone to **OpenVINO FP16** (cuts VRAM by 50%).
- Control: "Fidelity" slider (0=original fidelity, 1=AI-generated perfection).
- Optimization: **Detect faces with RetinaFace (OpenVINO)** → crop → restore → paste back (saves RAM massively).
- Batch: 1 face at a time.

**DDColor-Tiny (B&W to Color)**  
Semantic colorization. Knows sky = blue, grass = green. Far better than old GANs.
- Model: Official OpenVINO support via Intel.
- Tiny variant: Explicitly lightweight, CPU-viable.
- Control: Optional reference image for color guidance (if model supports it).

**SwinIR-Light (Denoising + Deblurring)**  
General restoration without content hallucination. Great for "preserve the original" workflows.
- Models: `SWINIR-Light` (denoising), `SWINIR-Light-Deblur` (motion/defocus blur).
- Optimization: OpenVINO FP16 + tiling for images > 1024x1024.
- Use case: Offer as "Denoise Only" and "Deblur Only" specialized filters.

### Tier 2: Specialized Restoration

**Real-ESRGAN Photo Model** (2x/4x Upscaling)  
Handles photographic textures better than anime models. Requires tiling for 16GB RAM.
- Model: `RealESRGAN_x4plus` (not anime variant) → OpenVINO FP16.
- Caveat: Denoises aggressively. Pair with "Re-Grain" step if you want analog texture back.
- Tiling: 256x256 tiles with 10px overlap, blend seams.

**SRMD (Noise-Aware Upscaling)**  
Unlike standard upscalers, SRMD *accepts noise level as input* and upscales WITH grain, not against it.
- Backend: **NCNN Vulkan** (very fast on Xe) or OpenVINO if available.
- Control: "Noise Scale" slider for grain retention.
- Use case: VHS/DVD rips where denoise-first would kill character.

**Bringing-Old-Photos-Back-to-Life (Scratch Removal)**  
Targets physical damage (scratches, tears, dust) in scanned film.
- Pipeline: Detection (CPU) → Inpainting (Intel Xe, OpenVINO LaMa variant) → Fusion (CPU).
- Niche but viral feature. Users love restoring family photos.

### Tier 3: Creative / Inpainting

**LaMa (Generative Inpainting)**  
SOTA for object removal or region filling. Understands global context.
- Model: Lightweight, runs easily on Intel Xe.
- WebUI: Simple brush tool + remove.

**Re-Grain Module** (Essential for Upscaling Cleanup)  
All AI upscalers denoise as a side effect. Restore "film look" afterward.
- FFmpeg: `noise` filter or `filmgrain` (if available in build).
  ```bash
  ffmpeg -i input.mp4 -vf "noise=alls=20:allf=t+u" output.mp4
  ```
- WebUI controls: Grain Strength, Grain Size, Temporal Consistency sliders.
- Advanced: Integrate **Grain-ML** (if lightweight OpenVINO version exists) for content-aware synthesis.

---

## 4. Model Conversion & Optimization (Infrastructure)

**Non-Negotiable for Intel Xe + 16GB RAM:**

### 1. PyTorch → OpenVINO FP16 Converter Script
```python
import openvino as ov

def convert_to_openvino_fp16(model, dummy_input_shape, output_dir):
    """Convert PyTorch model to OpenVINO IR with FP16 compression."""
    ov_model = ov.convert_model(
        model,
        input_shape=[dummy_input_shape],
    )
    ov.save_model(ov_model, output_dir, compress_to_fp16=True)
    return ov_model
```
Run once per model, save as `.xml` + `.bin`, load on inference.

### 2. Tiling Utility (Reusable for Video & Image)
```python
def tile_process(input_path, model, tile_size=256, pad=10, output_path=None):
    """
    Split frame/image into overlapping tiles, process on GPU, stitch back.
    Handles 16GB RAM constraints for large frames/images.
    """
    # 1. Load frame
    # 2. Split into tiles (256x256 with 10px padding)
    # 3. Send each tile to OpenVINO model
    # 4. Blend overlaps using padding region
    # 5. Reassemble
    pass
```
Apply to:
- Video upscaling (SwinIR, RealESRGAN) on frames > 1080p.
- Image upscaling/restoration on images > 2MP.

### 3. Face Detection + Crop Strategy
```python
def smart_face_restore(image, model="CodeFormer"):
    """
    Detect faces with RetinaFace (OpenVINO) → crop → restore → paste.
    Cuts RAM usage by 10x for multi-face images.
    """
    # 1. RetinaFace detection (lightweight, OpenVINO FP16)
    # 2. For each face bounding box: crop with margin
    # 3. Process crop through CodeFormer
    # 4. Paste back into original image
    pass
```

---

## 5. Hallucination & Glitch Art (Creative Chaos Layer)

### Tier 1: Hallucination Engines (High-Vibe, Low-Compute)

**DeepDream (Algorithmic Pareidolia)**  
Classic neural network dreaming. Amplifies patterns to create eyes, creatures, and impossible geometries out of noise.
- Model: InceptionV3 or ResNet backbone → OpenVINO FP16.
- Controls: Octave scale (zoom iterations), iteration depth, layer selection (early = edges, deep = creatures).
- Twist: Interpolate DeepDream effect across multiple input images for morphing hallucinations.

**VQGAN+CLIP (Text-to-Surreal-Image)**  
Combine a vector-quantized generator with language-image pre-training. Text prompts warp into abstract, melting imagery.
- Models: Tiny VQGAN + CLIP (both lightweight) → OpenVINO FP16.
- Controls: Text prompt, optional image seed, iteration depth.
- Example: "A cathedral of melting glass in a neon jungle" → weird, impossible architecture.

**Latent Space Interpolation (Image Morphing via GAN)**  
Encode two images into latent vectors, morph between them. Intermediate frames hallucinate bizarre, shifting forms.
- Model: StyleGAN2/3 (ffhq or smaller domain models at 256x256) + encoder (e4e or pixel2style2pixel) → OpenVINO FP16.
- Constraint: Use smaller models (256x256) to fit 16GB RAM. Quality trade-off is acceptable for creative output.
- Controls: Image A + Image B, trajectory mode (Linear, Spherical, Random Walk), frame count.

### Tier 2: Glitch & Databending (Breaking the Data)

**Databending (Audio-Effects-on-Images)**  
Treat image file as audio data. Apply reverb, echo, bitcrush, mp3 compression, then save back as image. Pure byte manipulation, instant.
- Implementation: Load image → interpret as 16-bit PCM → apply `scipy.signal` effects → save.
- Controls: Effect type (Echo, Reverb, Distortion, Bitcrush, MP3 Compression), intensity slider.
- Bonus: Accept audio file as "sonification source" — image glitches based on waveform shape.

**Pixel Sorting & Channel Shifting**  
Sort pixels by luminance or hue to create dripping effects. Separate RGB channels for anaglyph glitch look.
- Backend: **Vulkan compute shader** (native on Intel Xe) or numpy for quick prototyping.
- Controls: Sort threshold (brightness level to trigger), direction (vertical/horizontal/diagonal).
- Channel Shift: Independent R/G/B offset sliders (X/Y displacement).

**Optical Flow Warping (Image "Moshing")**  
Simulate datamosh on static images. Use optical flow from a reference image/video to warp the static input.
- Model: Farnebäck or TV-L1 optical flow (OpenCV, runs on CPU or OpenVINO).
- Workflow: Static image + motion reference (image or video) → warped, melted result.
- Use case: Apply datamosh aesthetics to photos without video source.

### Tier 3: Advanced Chaos

**Chaos-Mode Style Transfer**  
Your existing style transfer, but with knobs turned all the way wrong.
- Tweak: Lower content weight, raise style weight significantly, randomize layer selection.
- Control: "Chaos Mode" toggle enables unpredictable, abstract output (not preserving recognizable content).

**Diffusion Mode Interpolation (Prompt Morphing)**  
Intercept diffusion sampling mid-generation. Swap prompts or inject high noise between timesteps.
- Technique: Generate with "A cat" at steps 1–25, switch to "A toaster" at steps 26–50.
- Caveat: Requires tiling or quantized model (SDXL-Turbo, Flux.1-dev quantized) to fit 16GB RAM.
- Use case: Create impossible hybrid objects (5-legged chairs, 7-fingered hands, surreal blends).

---

## 6. Implementation Priority Matrix

### Sprint 1: Laying Foundation
- [ ] OpenVINO FP16 converter script (batch-convert all `.pth` models)
- [ ] Tiling utility class (shared by video + image nodes)
- [ ] RetinaFace detector (OpenVINO FP16) for face cropping
- [ ] Integrate **CodeFormer** (OpenVINO) + fidelity slider
- [ ] Integrate **DDColor-Tiny** (OpenVINO) + auto/reference mode
- [ ] FFmpeg ops wrapper (palette export, audio loudnorm, time-lapse, LUT)

### Sprint 2: Video Enhancement
- [ ] **Motion Vector Overlay** (`codecview`) node
- [ ] **Optical Flow** node (RAFT or Farneback, OpenVINO/Vulkan)
- [ ] **Depth Map** node (MiDaS or ZoeDepth, OpenVINO/Vulkan)
- [ ] Glitch effects: slit-scan, video echo, audio-reactive waveforms

### Sprint 3: Image Restoration
- [ ] **SwinIR-Light** (denoise + deblur, OpenVINO FP16 + tiling)
- [ ] **Real-ESRGAN Photo** (4x upscaling, tiling, paired with Re-Grain)
- [ ] **SRMD** (grain-aware upscaling, Vulkan NCNN)
- [ ] **Re-Grain module** (FFmpeg noise filter + UI sliders)

### Sprint 4: Hallucination & Glitch (Creative Chaos)
- [ ] **DeepDream** (OpenVINO FP16) with layer/iteration controls
- [ ] **VQGAN+CLIP** (OpenVINO FP16) for text-to-surreal-image
- [ ] **Latent Space Interpolation** (StyleGAN2/3 at 256x256, OpenVINO FP16)
- [ ] **Databending** (Audio effects on images, pure Python/NumPy)
- [ ] **Pixel Sorting & Channel Shifting** (Vulkan compute shader)
- [ ] **Optical Flow Warping** (image moshing via Farnebäck)
- [ ] Chaos-mode Style Transfer (existing model, new UI toggles)

### Sprint 5: Advanced & Niche
- [ ] **LaMa** inpainting (object removal brush)
- [ ] **Bringing-Old-Photos** (scratch removal pipeline)
- [ ] Diffusion mode interpolation (prompt morphing, if model fits)
- [ ] Extended interpolation (AMT or GMFSS, if ONNX/OpenVINO available)

---

## 7. Quick Reference: OpenVINO + Vulkan Decisions

| Model | Preferred Backend | Fallback | Notes |
|-------|-------------------|----------|-------|
| **Restoration & Enhancement** | | | |
| CodeFormer | OpenVINO FP16 | ONNX Runtime | Face detection bottleneck; use RetinaFace crop |
| DDColor-Tiny | OpenVINO FP16 | ONNX Runtime | Official Intel support |
| SwinIR-Light | OpenVINO FP16 | ONNX Runtime | Requires tiling for > 1024x1024 |
| Real-ESRGAN | OpenVINO FP16 | NCNN Vulkan | Tiling mandatory for 16GB |
| SRMD | NCNN Vulkan | OpenVINO FP16 | Vulkan often faster for this model |
| **Video & Flow** | | | |
| RAFT (Flow) | OpenVINO FP16 | NCNN Vulkan | Lightweight, parallelizable |
| MiDaS (Depth) | OpenVINO FP16 | NCNN Vulkan | Works well at 384x384 downsampled |
| **Hallucination & Glitch** | | | |
| DeepDream | OpenVINO FP16 | PyTorch CPU | Lightweight, very fast |
| VQGAN (Gen) | OpenVINO FP16 | ONNX Runtime | CLIP lightweight; both FP16 |
| StyleGAN2/3 | OpenVINO FP16 | ONNX Runtime | Use 256x256 models only for 16GB RAM |
| Latent Encoder (e4e) | OpenVINO FP16 | ONNX Runtime | Couples with StyleGAN for morphing |
| Pixel Sorting | Vulkan Shader | NumPy (slow) | Intel Xe native compute; instant |
| Optical Flow (Farnebäck) | OpenCV CPU | OpenVINO FP16 | CPU-optimized, parallel-friendly |
| **Inpainting & Other** | | | |
| LaMa | OpenVINO FP16 | ONNX Runtime | Lightweight, no tiling needed |
| **Existing (Confirm)** | | | |
| RIFE | (Already working) | — | Batch size=1 only |
| Style Transfer | (Already working) | — | Convert to OpenVINO FP16 if not done |
| Datamosh (FFmpeg) | (Already working) | — | Zero AI; pure stream processing |

---

## 8. Technical Guardrails

**Memory Leaks**:
- Free GPU buffers after each node (don't accumulate).
- Reload models once per session, reuse across frames (don't reload per frame).

**Stability**:
- Hardcode batch size = 1 everywhere.
- Monitor OOM; gracefully degrade to CPU if GPU allocation fails.
- Log VRAM usage before/after each operation.

**Quality**:
- Disable upscaler denoise if user workflow includes Re-Grain (avoid double-processing).
- Face crop detection: fail gracefully if no faces found (process whole image).
- Tiling: overlap padding prevents seam artifacts. Use at least 10px, test visually at tile boundaries.

**Performance**:
- Profile on actual hardware (Intel 1335U). Specs optimism dies at reality.
- Expect ~1–5 sec per frame for lightweight models (depth, flow), ~2–10 sec for restoration (face, upscale).
- Publish expected runtimes in WebUI (manage user expectations).

**Hallucination & Glitch Models** (Creative Chaos Layer):
- **DeepDream**: Very lightweight. Expect <1 sec per iteration on CPU. Scale up via octave loops (user handles speed/quality trade).
- **VQGAN+CLIP**: Expect 5–15 sec per iteration (GPU-dependent). Warn users about convergence time in UI.
- **StyleGAN Morphing**: Pre-compute and cache latent vectors. Only run generator on Xe (encoding is CPU work). Each frame ~0.5–1 sec.
- **Databending**: Pure CPU, instant. No model overhead.
- **Pixel Sorting & Channel Shift**: Vulkan compute shader, real-time for most images. Fallback to NumPy if shader unavailable (slow, but acceptable for preview).
- **Optical Flow Warping**: Farnebäck is CPU-optimized. Expect 2–5 sec for optical flow calc, then warping is instant.

---

## 9. Notes for the Sprinter

**Your Workflow**:
- You go deep on specs. The team implements, tests, iterates.
- This doc is your baseline. Verify model availability, OpenVINO conversions, and Vulkan binaries *before* committing to sprint tasks.
- Check Intel's OpenVINO Notebooks GitHub for reference implementations (they often include notebooks for SAM 2, depth models, etc.).

**When You Hit Ambiguity**:
- OpenVINO vs. ONNX Runtime: OpenVINO wins on Intel Xe (native GPU plugin). ONNX is safer if Intel support is thin.
- Vulkan fallback: NCNN Vulkan binaries are pre-compiled and just work. Use when OpenVINO IR isn't available.
- Tiling: Always implement. It's the difference between "works on your machine" and "actually ships."

**Win Condition**:
- Full pipeline runs end-to-end on Intel 1335U + Xe without OOM.
- All Tier 1 models (CodeFormer, DDColor, SwinIR, optical flow) are production-ready.
- Users can chain operations (denoise → upscale → re-grain) without manual RAM management.

---

*Last updated: July 2026 | Merged: Creative Chaos (Hallucination & Glitch) Layer | Target: Intel 1335U + Xe iGPU, 16GB shared RAM*
