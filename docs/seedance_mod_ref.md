# ByteDance Seedance Model Reference

### Seedance 2.5
- released: 2026-07 [bytedance.com](https://bytedance.com)
- category: Precision / Control
- good-at: Single-pass continuous 30-second clips, multimodal reference stacks (up to 50 items: images, video camera paths, audio), timestamp-level timeline control, maintaining character/clothing coherence across camera changes.
- do-not: Upload real human photos on Dreamina web UI (triggers facial biometric rejection filter); max out all 50 reference slots simultaneously (causes visual clutter & audio bleeding; power users stick to 11–15); expect native 1080p (renders 480p–720p natively, needs secondary upscaling).
- personality: Clean and restrained director-style; favors smooth, deliberate camera moves over chaotic physics morphing.
- tips:
  1. Segment 30s prompts using timestamp brackets (e.g., `[0-6s] camera dolly in on subject, [6-15s] subject turns left`).
  2. Use AI-generated face portraits (e.g., Flux) instead of real photos to bypass Dreamina facial filters.
  3. Specify speaker accent explicitly in text prompt if native audio defaults to unprompted accents.
- vs: Outperforms Kling 3.0 on reference stack depth and single-take duration (30s vs 5-10s), but incurs higher credit costs per render and less explosive physics than Veo 3.
- sources: [bytedance.com](https://bytedance.com), [fal.ai](https://fal.ai), [reddit.com/r/aivideo](https://reddit.com/r/aivideo)

### Seedance 2.5 Lite
- released: 2026-08 [dreamina.capcut.com](https://dreamina.capcut.com)
- category: Edit / Extend
- good-at: High-speed 30-second draft rendering, localized brush editing on existing footage, rapid storyboarding using multi-reference guidance on a lower credit budget.
- do-not: Use for final production deliverable without upscaling; feed low-light or noisy reference videos (causes visual artifact banding); rely on it for complex fluid/liquid physics.
- personality: Snappy and agile; prioritizes quick generation turnaround over ultra-fine background textural detail.
- tips:
  1. Use as a fast camera-blocking tool to test compositions before rendering on full 2.5.
  2. Use local brush edit on Dreamina to swap specific objects without re-rolling the entire background.
  3. Limit reference slots to under 10 for tightest prompt adherence.
- vs: Runs ~50% cheaper and faster than Seedance 2.5 flagship while retaining the 50-reference support, matching Wan 2.1 Fast generation speeds.
- sources: [dreamina.capcut.com](https://dreamina.capcut.com), [dtf.ru](https://dtf.ru), [reddit.com/r/StableDiffusion](https://reddit.com/r/StableDiffusion)

### Seedance 2.0
- released: 2026-02 [replicate.com](https://replicate.com/bytedance/seedance-2.0)
- category: Precision / Control
- good-at: Multi-shot sequence consistency, joint audio-video synchronization, matching explicit camera trajectories (dolly, pan, orbit) via video reference clips across 4–15s shots.
- do-not: Push single generations past 15 seconds (requires 2.5 for 30s takes); combine conflicting audio reference styles in a single prompt.
- personality: Camera-focused and disciplined; tight spatial framing with predictable motion paths.
- tips:
  1. Input a 3-second camera motion clip alongside text to force exact camera trajectory replication.
  2. Pair 1 face image + 1 wardrobe image + 1 audio file for locked character dialogue.
  3. Add intentional camera defects in text prompt (`subtle lens flare, handheld shake`) to counteract sterile AI gloss.
- vs: Superior character identity retention compared to Kling 2.0, but capped at 15-second clip limits.
- sources: [replicate.com](https://replicate.com/bytedance/seedance-2.0), [huggingface.co](https://huggingface.co), [reddit.com/r/aivideo](https://reddit.com/r/aivideo)

### Seedance 2.0 Fast
- released: 2026-03 [replicate.com](https://replicate.com/bytedance/seedance-2.0-fast)
- category: Precision / Control
- good-at: Low-latency dialogue scenes, rapid 720p prototyping, solid lip-sync at half the generation delay of standard 2.0.
- do-not: Expect native 1080p crispness; attempt complex smoke, fire, or liquid simulation (leads to temporal flickering).
- personality: Pragmatic and steady; clean motion with mild compression on secondary background details.
- tips:
  1. Use for fast dialogue iterative passes before sending final prompts to standard 2.0 or 2.5.
  2. Keep text prompts concise; heavy descriptive prose reduces motion fidelity.
  3. Use uncluttered backgrounds to prevent distortion during subject movement.
- vs: Matches Hailuo MiniMax Fast generation speeds while adding native audio and video reference inputs that MiniMax lacks.
- sources: [replicate.com](https://replicate.com/bytedance/seedance-2.0-fast), [reddit.com/r/aivideo](https://reddit.com/r/aivideo)

### Seedance 2.0 Mini
- released: 2026-04 [reddit.com/r/aivideo](https://reddit.com/r/aivideo)
- category: Avatar / Lip-Sync
- good-at: Budget talking-head shots, stylized/anime animation, clean 2D/3D line art rendering, high-volume batch generation.
- do-not: Attempt rapid dynamic camera moves or fast action/vehicle scenes (causes severe motion stuttering and limb morphing); rely on for strict photorealism.
- personality: Visually erratic on complex motion, but tight and clean on static close-up portraits.
- tips:
  1. Restrict usage to tight facial framing with simple mouth movements and voice sync.
  2. Lock camera in prompt (`locked tripod shot, static framing`) to eliminate camera jitter.
  3. Ideal for anime and cartoon art styles where background detail requirements are minimal.
- vs: Costs ~50% of Seedance 2.0 Fast; delivers more natural facial micro-expressions than standalone tools like SadTalker.
- sources: [reddit.com/r/aivideo](https://reddit.com/r/aivideo), [youtube.com](https://youtube.com)

### Seedance 1.5 Pro
- released: 2025-12 [replicate.com](https://replicate.com/bytedance/seedance-1.5-pro)
- category: Avatar / Lip-Sync
- good-at: Precise audio-video lip-syncing via dual-branch diffusion, synchronous generation of speech, ambient sound, and background music in a single pass.
- do-not: Expect single-shot clips longer than 12 seconds; supply distorted audio files (causes unnatural robotic facial twitches).
- personality: Restrained and rigid; speech alignment takes precedence over loose creative motion.
- tips:
  1. Provide clean 44.1kHz audio tracks for tightest lip-sync alignment.
  2. Explicitly declare camera focal length (e.g., `85mm portrait lens`) to anchor perspective.
  3. Drive via Image-to-Video (I2V) rather than pure text-to-video for consistent facial identity.
- vs: Outperformed Sora 1.0 on native lip-sync accuracy, but lacks the multi-reference features introduced in Seedance 2.0.
- sources: [replicate.com](https://replicate.com/bytedance/seedance-1.5-pro), [fal.ai](https://fal.ai)

### Seedance 1.0 Pro
- released: 2025-06 [fal.ai](https://fal.ai/models/seedance-1.0-pro)
- category: Cinematic Realism
- good-at: High-fidelity Image-to-Video (I2V), start-to-end frame morphing (FL2V), stable lighting continuity across 4–12s generations.
- do-not: Attempt multi-character dialogue scenes (lacks the joint audio-video branch of 1.5+); prompt rapid mid-clip scene cuts.
- personality: Stately and slow; emphasis on visual pixel stability over rapid motion.
- tips:
  1. Supply both start and end images (FL2V) to guide exact physical transformation bounds.
  2. Keep movement prompts subtle (`gentle wind blowing hair, slow pan right`).
  3. Input high-resolution source images to retain detailed surface textures.
- vs: Direct late-2025 competitor to Runway Gen-3 Alpha and Luma Ray 1, praised by creators for fewer hand/limb melting artifacts.
- sources: [fal.ai](https://fal.ai/models/seedance-1.0-pro), [replicate.com](https://replicate.com)

### Seedance 1.0 Pro Fast
- released: 2025-10 [replicate.com](https://replicate.com/bytedance/seedance-1.0-pro-fast)
- category: Cinematic Realism
- good-at: 30–60% faster inference than 1.0 Pro at ~60% lower compute cost, preserving primary I2V subject features for volume B-roll production.
- do-not: Use for intricate facial micro-expressions or complex multi-subject physical interactions.
- personality: Direct and prompt-obedient; sharp foreground subjects with mild background softening.
- tips:
  1. Use as the primary workhorse model for batch B-roll clip generation.
  2. Stick to 720p output settings to minimize generation latency.
  3. Include clear lighting direction (`golden hour side lighting`) to aid depth separation.
- vs: Largely replaced 1.0 Pro for general B-roll generation due to massive speed improvements with minimal loss in visual quality.
- sources: [replicate.com](https://replicate.com/bytedance/seedance-1.0-pro-fast), [youtube.com](https://youtube.com)

### Seedance 1.0 Lite
- released: 2025-07 [segmind.com](https://segmind.com/models/seedance-1.0-lite)
- category: Stylized
- good-at: Low-cost 480p–720p draft renders, basic camera moves, fast visual concept testing.
- do-not: Depend on for photorealistic human faces or commercial work (prone to facial distortion and noise artifacts).
- personality: Loose and unpredictable; fluid visual motion that frequently drifts from prompt constraints.
- tips:
  1. Restrict use to cartoon, abstract, or stylized concepts where realistic accuracy is unnecessary.
  2. Limit clip lengths to 4 seconds to prevent severe visual degradation.
  3. Apply strict negative prompts (`blur, noise, face distortion`).
- vs: Early budget tier, superseded by 2.0 Mini for avatar tasks and 2.5 Lite for draft editing.
- sources: [segmind.com](https://segmind.com), [getimg.ai](https://getimg.ai)

### DreamActor M2.0
- released: 2025-11 [replicate.com](https://replicate.com/bytedance/dreamactor-m2.0)
- category: Avatar / Lip-Sync
- good-at: Full-body character performance transfer, animating still portraits (human, animal, 3D render) using a driving video to mirror body gestures and facial expressions.
- do-not: Use as a standalone text-to-video generator (requires both a source image and a driving video); use driving videos with extreme head rotations exceeding 90 degrees or severe body occlusions.
- personality: Strictly mimetic; locks closely to the physical movement of the driving video performance.
- tips:
  1. Ensure driving video features clear lighting and un-obscured facial movement.
  2. Use front-facing source portrait images with neutral lighting for clean feature mapping.
  3. Can be applied to non-human subjects (statues, digital artwork, animals) driven by human performance video.
- vs: Competes directly with LivePortrait and Alibaba AnimateAnyone, praised for superior full-body gesture tracking accuracy compared to face-only tools.
- sources: [replicate.com](https://replicate.com/bytedance/dreamactor-m2.0), [bytedance.com](https://bytedance.com)
