# MiniMax & Lightricks LTX Model Reference

### MiniMax H3 / Hailuo 03
- released: 2026-07 [minimax.io](https://minimax.io/blog/minimax-h3)
- category: Cinematic Realism
- good-at: Native 2K resolution output by default, single-pass generation up to 15 seconds, integrated native stereo audio synthesis, open weights release (`MiniMaxAI/MiniMax-H3`).
- do-not: Expect inclusion in standard subscription video packages (pay-as-you-go API only); rely on `Ref2VA` multi-reference mode for pristine raw visual fidelity (`FL2VA` keyframing yields cleaner base renders).
- personality: Cinematic and immersive; prioritizes high-resolution clarity and audio-visual synchronization, though prompt adherence varies across output resolutions.
- tips:
  1. Use keyframe reference (`FL2VA`) rather than multi-reference stack (`Ref2VA`) to maximize raw output image quality and identity preservation.
  2. Pair with the official `MiniMax-H3-Turbo-Lora` when running self-hosted/local inference to reduce step counts while preserving character identity.
  3. Include explicit acoustic and ambient sound descriptors to capitalize on the native stereo audio engine.
- vs: Delivers native 2K output and 15s durations over Hailuo 2.3/02, competing directly with Kling 3.0 and Veo 3.1, but requires pay-as-you-go API billing.
- sources: [minimax.io](https://minimax.io/blog/minimax-h3), [huggingface.co/MiniMaxAI/MiniMax-H3](https://huggingface.co/MiniMaxAI/MiniMax-H3), [fal.ai](https://fal.ai)

### MiniMax H3 Max / H3 Max Turbo
- released: 2026-08 [fal.ai](https://fal.ai/models/fal-ai/minimax-h3-max)
- category: Precision / Control
- good-at: Ultra-fast pay-as-you-go API inference, optimized 480p and 768p Text-to-Video and Image-to-Video generation, accelerated turnaround compared to base H3.
- do-not: Conflate official USD API pricing ($0.05/s for 480p, $0.08/s for 768p) with consumer app `hailuoai.video` internal credit tiers (~275–2400 credits); expect native 2K output.
- personality: Rapid and functional; engineered by MiniMax and fal.ai for high-throughput draft iterations.
- tips:
  1. Use 480p mode ($0.05/s) for initial composition and timing checks before scaling to 768p or base H3 2K.
  2. Input clear, high-contrast source stills when running in Image-to-Video (I2V) mode for best feature retention.
  3. Keep text prompts focused on macro subject movement to maintain motion stability at high inference speeds.
- vs: Trades native 2K resolution and stereo audio of base H3 for significantly lower generation latency and reduced per-second API costs.
- sources: [fal.ai](https://fal.ai/models/fal-ai/minimax-h3-max), [platform.minimax.io](https://platform.minimax.io/docs)

### MiniMax Hailuo 2.3 / 2.3 Fast
- released: 2025-10 [platform.minimax.io](https://platform.minimax.io/docs)
- category: Cinematic Realism
- good-at: High dynamic prompt responsiveness, steady 768p (6s or 10s) and 1080p (6s max) clip generation, low-cost fast tier (0.7 video points/s).
- do-not: Attempt First & Last Frame interpolation (FL2V is unsupported on 2.3, remaining exclusive to Hailuo 02); prompt multi-shot keyframing.
- personality: Responsive and grounded; adheres strictly to action prompts with realistic weight and physics.
- tips:
  1. Use 768p duration (10s) for extended single-shot takes where camera motion must remain steady.
  2. Reserve 1080p mode for 6-second hero shots requiring maximum pixel sharpness.
  3. Drive via standard Text-to-Video or single Image-to-Video inputs; do not attempt end-frame conditioning.
- vs: Offers higher prompt adherence and dynamic motion fidelity than Hailuo 02, but lacks Hailuo 02's FL2V first/last frame capability.
- sources: [platform.minimax.io](https://platform.minimax.io/docs), [reddit.com/r/aivideo](https://reddit.com/r/aivideo)

### MiniMax Hailuo 02
- released: 2025-06 [platform.minimax.io](https://platform.minimax.io/docs)
- category: Precision / Control
- good-at: First & Last Frame (FL2V) keyframe interpolation, 15 native camera control commands via `[command]` syntax, flexible resolution tiers (512p, 768p, 1080p up to 10s).
- do-not: Omit bracketed camera tags when precise framing is required; expect native audio synthesis (silent model stack).
- personality: Structured and controllable; acts like an automated camera rig when driven via explicit command syntax.
- tips:
  1. Insert bracketed camera tags such as `[Pan Left]`, `[Dolly In]`, or `[Zoom Out]` directly into prompt text.
  2. Supply both start and end images via the FL2V API endpoint (`video-generation-fl2v.md`) for controlled morphing clips.
  3. Use 512p/768p modes for rapid draft camera-blocking before rendering full 1080p masters.
- vs: Remains the only MiniMax Hailuo 2.x generation model supporting native start-to-end frame morphing (FL2V), whereas 2.3 dropped FL2V.
- sources: [platform.minimax.io](https://platform.minimax.io/docs), [reddit.com/r/aivideo](https://reddit.com/r/aivideo)

### MiniMax Video-01 Director / Live
- released: 2025-02 [platform.minimax.io](https://platform.minimax.io/docs)
- category: Precision / Control
- good-at: Specialized camera direction (`T2V-01-Director`, `I2V-01-Director`), stylized 2D/3D illustration animation (`I2V-01-Live-01`, 720p 5s).
- do-not: Use for photorealistic human close-ups (prone to facial softening); expect multi-shot storyline management.
- personality: Focused and illustrative; excels at artistic animation and guided camera trajectories.
- tips:
  1. Use `I2V-01-Live-01` specifically for animating 2D digital illustrations, anime stills, and artwork.
  2. Structure Director variant prompts around explicit camera framing and movement angles.
  3. Restrict clip lengths to 5 seconds to prevent visual degradation.
- vs: Dedicated camera and illustration animation variants of the early Video-01 architecture, preceding the Hailuo 02 model overhaul.
- sources: [platform.minimax.io](https://platform.minimax.io/docs), [hailuoai.video](https://hailuoai.video)

### MiniMax Video-01 (Base)
- released: 2024-10 [platform.minimax.io](https://platform.minimax.io/docs)
- category: Cinematic Realism
- good-at: Early foundational Text-to-Video (`T2V-01`) and Image-to-Video (`I2V-01`), smooth camera pans, basic fluid dynamics.
- do-not: Expect high temporal stability on complex human hand interactions; prompt long continuous takes without keyframes.
- personality: Loose and fluid; early-generation diffusion physics with prone-to-morphing edge details.
- tips:
  1. Drive via Image-to-Video (I2V-01) with clean input stills to stabilize subject geometry.
  2. Keep motion descriptors subtle to prevent prompt-drift distortion.
  3. Combine with external upscaling tools for modern high-resolution deliverables.
- vs: Legacy foundation model ("Hailuo 01"); superseded by Hailuo 02, 2.3, and H3 series.
- sources: [platform.minimax.io](https://platform.minimax.io/docs), [reddit.com/r/aivideo](https://reddit.com/r/aivideo)

### Lightricks LTX-2.5 / LTX-2.5 Fast
- released: 2026-08 [lightricks.com](https://lightricks.com)
- category: Cinematic Realism
- good-at: Native 4K up to 10s and 1080p up to 20s with integrated audio, world-model spatial dynamics, sub-7-second generation speeds on NVIDIA superchips.
- do-not: Over-rely on lip-sync in crowded multi-person dialogue scenes (exhibits facial artifacts and tracking slips in long takes); prompt dense text rendering.
- personality: Cinematic and rapid; state-of-the-art world model physics with fast API execution.
- tips:
  1. Leverage `ltx-2-5-fast` API endpoint for low-latency 1080p 20s generations with native audio.
  2. Keep multi-character dialogue scenes simple to prevent mouth tracking alignment drift.
  3. Use high-resolution source stills in I2V mode to take full advantage of the 4K render pipeline.
- vs: Flagship 2026 update to LTX-2, outperforming LTX-2.3 in generation speed and world physics simulation.
- sources: [lightricks.com](https://lightricks.com), [marktechpost.com](https://marktechpost.com), [cnet.com](https://cnet.com), [artificialanalysis.ai](https://artificialanalysis.ai)

### Lightricks LTX-2.3 / LTX-2.3 Fast / F2LF
- released: 2026-03 [lightricks.com](https://lightricks.com)
- category: Precision / Control
- good-at: First-and-last-frame interpolation (`LTX-2-3-First-Last-Frame`), native 1080p audio-visual clips up to 20s @24-25fps, singing avatar and music video production, LTX Desktop app integration.
- do-not: Use default `bf16` precision if visual corruption occurs (requires `fp32` fallback); rely on built-in x1.5 upscaler without applying community patches (joeygambino #65 fix).
- personality: Practical and music-focused; widely adopted by creators for singing avatars and keyframed transitions.
- tips:
  1. Use `last_frame_uri` parameter in `KeyframeInterpolationPipeline` for smooth start-to-end keyframe morphing up to 20s.
  2. If experiencing temporal upscaler artifacts (#35) or motion dampening from character LoRAs (#36), disable secondary upscaling layers.
  3. Format audio inputs at clean 44.1kHz rates for optimal music and vocal sync.
- vs: Introduced native keyframe interpolation (F2LF) and desktop application integration, paving the way for LTX-2.5.
- sources: [lightricks.com](https://lightricks.com), [gigazine.net](https://gigazine.net), [huggingface.co/Lightricks](https://huggingface.co/Lightricks)

### Lightricks LTX-2 (19B / Pro / Fast)
- released: 2026-01 [github.com/Lightricks/LTX-2](https://github.com/Lightricks/LTX-2)
- category: Open / Self-Host
- good-at: Full open-source 19B parameter model, native 4K output at 50fps, top-ranked open-source model on Artificial Analysis Video Arena (#3 overall behind Kling 3.5 and Veo 3.1).
- do-not: Attempt full local weights execution on consumer GPUs with <24GB VRAM without quantization; expect perfect multi-person facial tracking.
- personality: Powerful and authoritative open-source backbone; high visual fidelity with cinematic framing.
- tips:
  1. Deploy `LTX-2 Pro` API for highest bitrate hero shots; use `LTX-2 Fast` for low-latency draft iterations.
  2. Run 19B weights on multi-GPU or high-VRAM hardware (24GB+) for uncompressed 4K 50fps rendering.
  3. Include explicit camera speed and focal depth cues in text prompts.
- vs: Benchmark open-source video generation model of early 2026, outperforming legacy open weights while matching commercial APIs.
- sources: [github.com/Lightricks/LTX-2](https://github.com/Lightricks/LTX-2), [artificialanalysis.ai](https://artificialanalysis.ai), [wikipedia.org](https://wikipedia.org)

### Lightricks LTX 0.9.8 13B Distilled
- released: 2026-06 [huggingface.co/spaces/Lightricks/LTX-Video-Fast](https://huggingface.co/spaces/Lightricks/LTX-Video-Fast)
- category: Open / Self-Host
- good-at: 8-step ultra-fast preview inference, 1216x704 @30fps default output, real-time H100 generation (3s preview / 10s HD), 60s longshot capability, built-in detailer upscaler.
- do-not: Attempt full unquantized `bf16` execution on 16GB VRAM (requires ~26GB+ VRAM; use `fp8` quantization + CPU offloading for 16GB VRAM systems).
- personality: Lightning-fast self-hosted workhorse; rapid turnaround with distilled step efficiency.
- tips:
  1. Enable `fp8` quantization and model offloading in ComfyUI (`ComfyUI-LTXVideo`) to run comfortably on 16GB VRAM GPUs.
  2. Use 8-step inference for real-time visual previews before running full detailer upscaler passes.
  3. Leverage the 60s longshot extension pipeline for continuous camera motion sequences.
- vs: Offers significantly lower step count (8 steps) and faster generation than standard 13B/19B base models at minimal quality loss.
- sources: [huggingface.co](https://huggingface.co), [github.com/Lightricks/ComfyUI-LTXVideo](https://github.com/Lightricks/ComfyUI-LTXVideo)

### Lightricks LTX Video 2B (Open Source / Q8)
- released: 2024-11 [github.com/Lightricks/LTX-Video](https://github.com/Lightricks/LTX-Video)
- category: Open / Self-Host
- good-at: Low VRAM consumer GPU execution, 8-bit quantized (`Q8`) rendering on RTX 4060 (8GB VRAM) in under 60 seconds (720x480, 121 frames), lightweight real-time diffusion prototyping.
- do-not: Expect native 4K resolution or long temporal coherence without fine-tuning; use for complex multi-subject dialogue.
- personality: Accessible and lightweight; foundational open-source video transformer for budget hardware.
- tips:
  1. Apply `LTX-VideoQ8` (8-bit quantization) to run video generation on 8GB VRAM graphics cards.
  2. Limit resolution to 720x480 @ 30fps for fastest generation times on consumer GPUs.
  3. Pair with ComfyUI workflow nodes for post-generation spatial upscaling.
- vs: Historical open-source pioneer for consumer video generation on 8GB VRAM; superseded by 13B and 19B LTX series for production work.
- sources: [github.com/Lightricks/LTX-Video](https://github.com/Lightricks/LTX-Video), [reddit.com/r/StableDiffusion](https://reddit.com/r/StableDiffusion)
