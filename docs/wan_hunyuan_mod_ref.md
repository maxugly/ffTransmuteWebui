# Alibaba Wan & Tencent Hunyuan Video Model Reference

### Alibaba Wan 3.0 Prime
- released: 2026-08 [wanx.aliyun.com](https://wanx.aliyun.com)
- category: Precision / Control
- good-at: Unified T2V+I2V+R2V multimodal reference stack (supports up to 20 references including .pdf/.pptx doc inputs), smart duration up to 30s, delivery-first prompting structure, multi-beat clip "thinking mode", native 1080p hard ceiling.
- do-not: Supply separate negative prompt fields (Wan 3.0 API ignores negative prompt parameters entirely; use plain-text inline exclusion clauses like "no blur, without text" in the main prompt); exceed 1080p output (hard resolution ceiling); overload all 20 reference slots with conflicting visual styles.
- personality: Delivery-first and highly disciplined; parses complex document context (.pdf/.pptx) and multi-beat story structures without visual or narrative drift.
- tips:
  1. Write inline negative exclusion clauses directly inside the main prompt text (e.g., `main scene description, no text, no watermark, clean background`) as separate negative prompt fields are completely ignored.
  2. Ingest up to 20 document reference files (.pdf, .pptx, images) alongside text to lock layout, branding, and multi-subject character consistency across long takes.
  3. Enable "thinking mode" for multi-beat clips to let the model automatically plan narrative transitions and pacing across continuous 30-second sequences.
- vs: Superior document reference ingestion (.pdf/.pptx) and multi-beat story planning compared to Kling 3.0 Omni and Seedance 2.5, but strictly capped at 1080p.
- sources: [wanx.aliyun.com](https://wanx.aliyun.com), [dashscope.aliyun.com](https://dashscope.aliyun.com), [reddit.com/r/aivideo](https://reddit.com/r/aivideo)

### Alibaba Wan 3.0 (Base / Self-Host)
- released: 2026-08 [github.com/Wan-Video/Wan3.0](https://github.com/Wan-Video/Wan3.0)
- category: Open / Self-Host
- good-at: Open-weights video diffusion transformer for local self-hosting, native 1080p video generation, integrated native stereo audio synthesis, multi-reference attention mechanism.
- do-not: Attempt unquantized `bf16` inference on consumer GPUs with <24GB VRAM (requires >32GB VRAM for uncompressed weights; use `fp8` quantization for 16GB–24GB GPUs); expect instantaneous generations without distilled LoRAs.
- personality: Cinematic and authoritative open-source backbone; integrates multi-reference attention with strong temporal stability and synchronized audio generation.
- tips:
  1. Load `fp8` or `int8` quantized weights in ComfyUI to execute comfortably on 16GB–24GB VRAM consumer GPUs (RTX 4090/3090).
  2. Include explicit acoustic and ambient sound descriptors in text prompts to maximize native stereo audio synthesis alignment.
  3. Feed up to 4 key image references into multi-reference attention nodes to lock subject features without visual degradation.
- vs: Direct open-weights counterpart to commercial Wan 3.0 Prime, competing head-to-head with LTX-2.5 and Hunyuan Video 4K for self-hosted 1080p text-to-video with audio.
- sources: [github.com/Wan-Video/Wan3.0](https://github.com/Wan-Video/Wan3.0), [huggingface.co/Wan-AI](https://huggingface.co/Wan-AI), [reddit.com/r/StableDiffusion](https://reddit.com/r/StableDiffusion)

### Alibaba Wan 2.2 Fast / I2V rCM / I2V LoRA
- released: 2025-07 [github.com/Wan-Video/Wan2.2](https://github.com/Wan-Video/Wan2.2)
- category: Precision / Control
- good-at: Ultra-fast MoE distilled architectures (A14B-NFE4), 4-step LightX2V Lightning LoRA, 4-step rCM (real-time consistency model) turbo I2V, rank-64 camera control LoRAs, native 480p/720p at 16fps (53–81 frame timing windows).
- do-not: Exceed 4 inference steps when using rCM or LightX2V distilled LoRAs (higher step counts cause extreme over-exposure and image artifacts); expect native 1080p output without secondary upscaling pass.
- personality: Modular, fast, and highly responsive; engineered for low-latency camera control and 4-step consistency-distilled execution.
- tips:
  1. Set sampler step count strictly to 4 steps when executing LightX2V Lightning LoRA or rCM turbo checkpoints in ComfyUI.
  2. Attach rank-64 camera control LoRAs (`zoom_in`, `pan_left`, `orbit`) to execute sharp, predictable camera moves across 53–81 frame windows.
  3. Deploy `fp8` quantized checkpoints on consumer 12GB–16GB VRAM GPUs for fast sub-15-second draft generation.
- vs: Outpaces Wan 2.1 14B base generation speed by 8x (4 steps vs 30-50 steps), matching LTX 0.9.8 Distilled and Kling 2.6 Turbo for high-speed camera-guided drafts.
- sources: [github.com/Wan-Video/Wan2.2](https://github.com/Wan-Video/Wan2.2), [huggingface.co/Wan-AI](https://huggingface.co/Wan-AI), [reddit.com/r/StableDiffusion](https://reddit.com/r/StableDiffusion)

### Alibaba Wan 2.1 (14B & 1.3B)
- released: 2025-02 [github.com/Wan-Video/Wan2.1](https://github.com/Wan-Video/Wan2.1)
- category: Open / Self-Host
- good-at: Foundational open-source video diffusion models featuring 1.3B lightweight (480p, ultra-low VRAM) and 14B production (720p/480p, high fidelity) variants, separate dedicated T2V and I2V pipeline branches.
- do-not: Run 14B `bf16` T2V on consumer GPUs without CPU offloading (14B requires ~24GB VRAM for `fp8`, >30GB for `bf16`; 1.3B runs on 8GB–12GB VRAM); mix T2V and I2V pipeline weights in ComfyUI workflows.
- personality: Versatile dual-scale open architecture; 1.3B is hyper-fast and accessible while 14B provides rich physical dynamics and prompt fidelity.
- tips:
  1. Use the 1.3B model on 8GB–12GB VRAM GPUs for rapid 480p scene blocking and storyboarding iterations.
  2. Deploy the 14B `fp8` quantized model in ComfyUI on 16GB–24GB GPUs for production-grade 720p master clips.
  3. Select dedicated `Wan2.1-I2V-14B-720P` weights specifically when conditioning from static image inputs for maximum identity retention.
- vs: Benchmark open-source foundation family that established open video generation standards alongside HunyuanVideo and LTX-Video 2B.
- sources: [github.com/Wan-Video/Wan2.1](https://github.com/Wan-Video/Wan2.1), [huggingface.co/Wan-AI](https://huggingface.co/Wan-AI), [reddit.com/r/StableDiffusion](https://reddit.com/r/StableDiffusion)

### Alibaba Wan 2.6 & 2.7
- released: 2025-11 [wanx.aliyun.com](https://wanx.aliyun.com)
- category: Cinematic Realism
- good-at: Extended duration preview tiers (15s–20s single takes), enhanced human anatomical stability, smooth organic camera movement, intermediate commercial releases between Wan 2.1 and Wan 3.0.
- do-not: Expect open-weights local execution (cloud API preview tiers only); request sudden 180-degree subject flips in a single-shot prompt without keyframing.
- personality: Smooth and photorealistic; bridges open foundation models to commercial production with refined lighting and temporal continuity.
- tips:
  1. Leverage 15-second continuous take mode for seamless narrative B-roll and atmospheric establishing shots.
  2. Use detailed lighting descriptors (`volumetric side lighting, 35mm film grain, shallow depth of field`) to exploit enhanced shader fidelity.
  3. Drive via Image-to-Video mode with 1080p source stills to maximize physical character consistency.
- vs: Stepped up single-take durations (15-20s) and facial photorealism over Wan 2.1 14B, laying the groundwork for Wan 3.0 Prime.
- sources: [wanx.aliyun.com](https://wanx.aliyun.com), [dashscope.aliyun.com](https://dashscope.aliyun.com), [reddit.com/r/aivideo](https://reddit.com/r/aivideo)

### Tencent Hunyuan Video (v1.0 & v2.0 4K)
- released: 2024-12 [github.com/Tencent/HunyuanVideo](https://github.com/Tencent/HunyuanVideo)
- category: Open / Self-Host
- good-at: Open-source 3D Causal VAE transformer, native 720p/1080p/4K @30fps generation, 121 frames default (5s base duration), dual-stream attention architecture for decoupled text and visual feature processing.
- do-not: Attempt full `bf16` execution without 24GB–32GB VRAM; skip text-encoder CPU offload on GPUs under 16GB VRAM (causes OOM crashes during LLM text encoding).
- personality: Grounded, precise, and physically realistic; dual-stream attention ensures high prompt obedience and structural motion stability.
- tips:
  1. Enable `fp8` or `int8` quantization + VAE/text-encoder CPU offloading in ComfyUI (`ComfyUI-HunyuanVideoWrapper`) to run on 12GB–16GB VRAM GPUs.
  2. Set target frame counts to 121 frames at 24/30fps to match the native 3D Causal VAE compression ratio.
  3. Upgrade to HunyuanVideo v2.0 4K weights for ultra-sharp high-resolution commercial hero renders.
- vs: Landmark open-source 13B video transformer competing directly with LTX-2 19B and Wan 2.1 14B for local high-resolution generation supremacy.
- sources: [github.com/Tencent/HunyuanVideo](https://github.com/Tencent/HunyuanVideo), [huggingface.co/Tencent-Hunyuan](https://huggingface.co/Tencent-Hunyuan), [reddit.com/r/StableDiffusion](https://reddit.com/r/StableDiffusion)

### Mochi 1 (Genmo)
- released: 2024-10 [github.com/genmoai/models](https://github.com/genmoai/models)
- category: Open / Self-Host
- good-at: Open-source 10B parameter Asymmetric Diffusion Transformer (AsymDiT), locked 480p native resolution (848x480 @ 30fps, 163 frames / 5.4s), extreme motion fluidity, hyper-realistic motion physics without visual tearing.
- do-not: Attempt to override native resolution above 848x480 (locked deliberately to optimize attention memory bandwidth and physical motion dynamics); run on GPUs under 12GB VRAM without `fp8` quantization.
- personality: Dynamic, organic, and motion-focused; sacrifices output pixel density for unmatched physical realism and fluid motion.
- tips:
  1. Pair native 848x480 outputs with external spatial upscalers (Real-ESRGAN or Topaz Video AI) for 1080p/4K production output.
  2. Use `fp8` quantized checkpoints in ComfyUI to fit within 12GB–16GB VRAM consumer GPU limits.
  3. Compose prompts highlighting physical forces (fluid motion, cloth wind dynamics, complex splash physics) to leverage its superior motion engine.
- vs: Outperforms Wan 2.1 1.3B and LTX Video 2B on motion fluidity and physical realism, though hard-locked natively to 480p.
- sources: [github.com/genmoai/models](https://github.com/genmoai/models), [huggingface.co/genmo](https://huggingface.co/genmo), [reddit.com/r/StableDiffusion](https://reddit.com/r/StableDiffusion)

### Pyramid Flow & ToonCrafter
- released: 2024-10 [github.com/jy500/Pyramid-Flow](https://github.com/jy500/Pyramid-Flow)
- category: Stylized
- good-at: Pyramidal flow matching framework for multi-resolution autoregressive sampling (768p, up to 10s extended generation) and ToonCrafter anime keyframe interpolation (512x320, 16-frame smooth 2D toon interpolation).
- do-not: Use ToonCrafter on photorealistic live-action source stills (tailored exclusively for 2D anime/line art); expect zero autoregressive drift on Pyramid Flow past 10 seconds.
- personality: Specialized and artistic; Pyramid Flow handles efficient multi-scale spatial sampling while ToonCrafter excels at jitter-free 2D animation keyframing.
- tips:
  1. Use ToonCrafter with two cartoon keyframe images to interpolate smooth 16-frame 2D animation clips without line jitter.
  2. Configure Pyramid Flow multi-resolution autoregressive sampling with lower step counts on initial coarse stages to accelerate generation.
  3. Reserve ToonCrafter specifically for anime, digital illustration, and cel-shaded animation pipelines.
- vs: ToonCrafter leads open-source 2D anime keyframe interpolation, while Pyramid Flow introduced efficient pyramidal flow matching for extended video generation.
- sources: [github.com/jy500/Pyramid-Flow](https://github.com/jy500/Pyramid-Flow), [github.com/Doubiiu/ToonCrafter](https://github.com/Doubiiu/ToonCrafter), [huggingface.co](https://huggingface.co)
