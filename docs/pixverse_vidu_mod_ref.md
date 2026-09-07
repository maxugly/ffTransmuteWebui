# PixVerse & Shengshu Vidu Model Reference

### PixVerse 6 / V6
- released: 2026-03 [pixverse.ai](https://pixverse.ai)
- category: Precision / Control
- good-at: 15-second variable duration generation, 20+ virtual camera lens controls (aperture, focal length, depth of field), multi-shot scene linking with synchronized audio.
- do-not: Expect simple one-click prompts without setting camera parameters; rely on lip-sync for fast dialogue scenes (can lag behind audio beats).
- personality: Clean and structured; camera-driven control with disciplined spatial moves.
- tips:
  1. Use explicit lens parameters (`85mm portrait lens, shallow depth of field`) to leverage the virtual camera engine.
  2. Set exact integer duration (1-15s) in settings to match scene timing prior to generation.
  3. Combine with multi-shot prompts to chain character actions across continuous takes.
- vs: Offers more granular camera controls and longer single-take clips (15s) than PixVerse 5.5, but has a steeper camera-tuning learning curve.
- sources: [pixverse.ai](https://pixverse.ai), [reddit.com/r/aivideo](https://reddit.com/r/aivideo)

### PixVerse 5.5
- released: 2025-12 [pixverse.ai](https://pixverse.ai)
- category: Stylized
- good-at: Integrated audio-visual generation (sound effects, voiceovers, music), 10-second clip extension, anime and 3D stylized character animation.
- do-not: Generate photorealistic human close-ups under dynamic lighting (prone to waxy skin textures and facial morphing); over-prompt complex hand gestures.
- personality: Energetic and semi-stylized; handles rapid camera motion well but exhibits mild visual gloss.
- tips:
  1. Leverage for anime or 3D-stylized projects where PixVerse's rendering engine natively excels.
  2. Include audio cues in brackets `[sound of explosion, thunder]` to drive native sound design.
  3. Use Image-to-Video (I2V) with high-contrast stills to anchor character geometry.
- vs: Added native audio synthesis and 10s durations over PixVerse 5.0, competing directly with Kling 2.6 on sound generation.
- sources: [pixverse.ai](https://pixverse.ai), [reddit.com/r/aivideo](https://reddit.com/r/aivideo)

### PixVerse 5 / V5
- released: 2025-08 [pixverse.ai](https://pixverse.ai)
- category: Stylized
- good-at: 8-second 1080p clip generation, motion responsiveness, vibrant stylized aesthetics (anime/cyberpunk), basic motion brush guidance.
- do-not: Expect native audio (silent model); rely on for complex fluid or cloth physical simulations (tends to dissolve secondary structures).
- personality: Zany and dynamic; highly expressive motion that can over-shoot prompt boundaries.
- tips:
  1. Use motion brush trajectories to guide specific object movements rather than relying on text prompts alone.
  2. Keep text prompts focused on visual style and atmosphere rather than mechanical physics.
  3. Run renders at 8-second default length for optimal temporal coherence.
- vs: Improved motion smoothness over PixVerse 4.5, but lacks the native audio and multi-shot tools of V5.5/V6.
- sources: [pixverse.ai](https://pixverse.ai), [reddit.com/r/aivideo](https://reddit.com/r/aivideo)

### PixVerse 4.5
- released: 2025-04 [pixverse.ai](https://pixverse.ai)
- category: Stylized
- good-at: 8-second 1080p anime renders, stylized character motion, keyframe transition stability.
- do-not: Attempt photorealistic human faces; prompt multi-subject chaotic battle scenes (causes severe limb clipping).
- personality: Fluid and stylized; favors cartoon and 3D animation aesthetics over realistic weight.
- tips:
  1. Best used for anime and 2D/3D illustrative artwork inputs.
  2. Keep camera movement prompts gentle to avoid background tearing.
  3. Use image inputs with clean line art for sharpest motion paths.
- vs: Stepping stone update between 4.0 and 5.0, offering cleaner edge stability than V4 on stylized inputs.
- sources: [pixverse.ai](https://pixverse.ai), [reddit.com/r/aivideo](https://reddit.com/r/aivideo)

### PixVerse 4
- released: 2024-12 [pixverse.ai](https://pixverse.ai)
- category: Stylized
- good-at: 8-second 1080p generation, early motion brush controls, stylized visual aesthetics.
- do-not: Prompt long complex narratives; rely on for realistic human micro-expressions (prone to static faces).
- personality: Rigid on realism, but lively on stylized vector graphics and anime stills.
- tips:
  1. Restrict prompts to single subjects with clear background separation.
  2. Apply motion brush selectively to small background elements like water or hair.
  3. Pair with high-contrast input stills for best subject retention.
- vs: Legacy model; superseded by PixVerse V5 and V6 series.
- sources: [pixverse.ai](https://pixverse.ai), [reddit.com/r/aivideo](https://reddit.com/r/aivideo)

### Real Motion 3.5 Turbo
- released: 2025-12 [digen.ai](https://digen.ai)
- category: Physics / Chaos
- good-at: Fast 1080p physics simulation (debris, particle explosions, dice rolling, liquid splashes), fast render turnaround, integrated audio effects on free/paid tiers.
- do-not: Expect watermark-free exports on free tier (free renders burn branded watermarks); use for delicate facial micro-expressions (physics engine prioritizes mechanical chaos over face stability).
- personality: Explosive and chaotic; excels at rapid physical interactions and environmental destruction.
- tips:
  1. Highlight physical interaction words (`shattering glass, splashing water, tumbling dice`) in text prompts.
  2. Use for action B-roll and debris sequences where chaotic movement is desired.
  3. Upgrade to paid tier if watermark-free high-bitrate masters are required.
- vs: Highlighted top pick in the Real Motion physics suite; offers faster generation than standard 3.5 with strong particle dynamics.
- sources: [digen.ai](https://digen.ai), [facebook.com](https://facebook.com), [reddit.com/r/aivideo](https://reddit.com/r/aivideo)

### Real Motion 3.5
- released: 2026-08 [digen.ai](https://digen.ai)
- category: Physics / Chaos
- good-at: Physical simulation fidelity, uncompressed particle dynamics, complex multi-object collision physics, realistic weight and gravity simulation.
- do-not: Use for fast draft iterations (higher credit cost and render latency than Turbo); attempt clean talking-head dialogue scenes.
- personality: Grounded and physically heavy; realistic momentum and momentum conservation across collisions.
- tips:
  1. Provide high-resolution start frames showing structural objects before triggering destruction or movement prompts.
  2. Structure prompts around kinetic forces (`heavy crashing wave, collapsing stone archway`).
  3. Pair with external sound design for action sequences.
- vs: Full-quality flagship of the Real Motion physics line; delivers higher particle texture sharpness than 3.5 Turbo at the expense of render speed.
- sources: [digen.ai](https://digen.ai), [youtube.com](https://youtube.com)

### Real Motion 3.1 / 3.1 Turbo
- released: 2025-10 [digen.ai](https://digen.ai)
- category: Physics / Chaos
- good-at: Budget-friendly physics simulation, basic particle motion, free-tier rapid prototyping with audio cues.
- do-not: Expect high-resolution micro-detail on smoke/fire; attempt multi-character dialogue (lacks fine lip-sync).
- personality: Energetic and loose; handles basic falling/rolling physics well with mild visual artifacts.
- tips:
  1. Ideal for quick physics test passes before committing to 3.5 renders.
  2. Keep background elements simple to minimize particle noise.
  3. Use shorter 5-second duration settings for best temporal stability.
- vs: Predecessor to 3.5 Turbo; lower physics fidelity but lightweight for quick concept testing.
- sources: [digen.ai](https://digen.ai), [reddit.com/r/aivideo](https://reddit.com/r/aivideo)

### Real Motion 3.2
- released: 2025-11 [digen.ai](https://digen.ai)
- category: Physics / Chaos
- good-at: Multi-object stability during physical movement, preventing subject structural collapse during camera pans, solid collision boundaries.
- do-not: Over-prompt secondary background motion (can freeze non-target objects); push past 8-second clip limits.
- personality: Restrained physics engine; prioritizes subject structural retention over maximum particle destruction.
- tips:
  1. Use when generating physical scenes containing multiple distinct moving objects.
  2. Keep camera movement linear to prevent multi-object overlap distortion.
  3. Provide clean foreground-background separation in source stills.
- vs: Intermediate release that stabilized multi-object tracking between 3.1 and 3.5.
- sources: [digen.ai](https://digen.ai), [youtube.com](https://youtube.com)

### Real Motion Turbo
- released: 2025-08 [digen.ai](https://digen.ai)
- category: Physics / Chaos
- good-at: Fast 720p draft physics generation, low-latency motion testing, free-tier experimentation.
- do-not: Use for 1080p final deliverables; expect detailed facial preservation during fast physical motion.
- personality: Fast and draft-focused; rapid physical motion with coarse particle resolution.
- tips:
  1. Use strictly as a low-cost motion rough-cut tool.
  2. Restrict prompts to simple physical dynamics (`ball bouncing, car driving fast`).
  3. Scale down resolution expectations for free-tier previews.
- vs: Lightweight 720p variant superseded by Real Motion 3.5 Turbo for 1080p output.
- sources: [digen.ai](https://digen.ai), [digen.ai/specs](https://digen.ai)

### Real Motion 2.6
- released: 2025-06 [digen.ai](https://digen.ai)
- category: Physics / Chaos
- good-at: Legacy 720p 24fps draft physics, low consumer GPU hardware rendering via Mixture-of-Experts (MoE) architecture.
- do-not: Expect native 1080p sharpness; use for photorealistic character animation.
- personality: Loose and flexible; good motion fluidness but soft edge definition.
- tips:
  1. Useful for rapid local or low-tier cloud drafting.
  2. Keep clip lengths to 4-5 seconds.
  3. Combine with external upscalers if reusing legacy 2.6 outputs.
- vs: Foundational release of the Real Motion series; superseded by 3.x line.
- sources: [digen.ai](https://digen.ai), [youtube.com](https://youtube.com)

### Real Motion 3.2 Remix / 2.6 Remix
- released: 2025-11 [digen.ai](https://digen.ai)
- category: Edit / Extend
- good-at: Motion restyling (transferring physics and motion trajectory from reference video onto a new stylized subject image), preserving physical momentum across visual swaps.
- do-not: Use heavily disparate body structures between source video and target image (causes severe subject warping and limb tearing); expect perfect facial preservation during extreme turns.
- personality: Hybrid edit engine; restyles visual surface textures while adhering to underlying motion physics.
- tips:
  1. Match the physical silhouette of the target image to the reference motion video to avoid subject warping.
  2. Use for restyling live-action footage into stylized/anime physical animations.
  3. Keep reference video lighting clean and clear for accurate physics extraction.
- vs: Dedicated restyling mode in the Real Motion suite, competing with DomoAI and Runway Gen-1 video-to-video restyling.
- sources: [digen.ai](https://digen.ai), [reddit.com/r/aivideo](https://reddit.com/r/aivideo)

### Vidu Q3
- released: 2026-02 [vidu.studio](https://vidu.studio)
- category: Precision / Control
- good-at: 1-16s variable duration, native audio-visual synchronization, multi-reference subject locking, dedicated start-to-end frame transition endpoint.
- do-not: Supply start and end images with mismatched aspect ratios (API enforces strict 0.8–1.25 ratio boundary between start/end frames); over-saturate reference slots.
- personality: Disciplined and director-like; precise visual transitions anchored between keyframe bounds.
- tips:
  1. Ensure start and end images have matching aspect ratios (within 0.8–1.25 ratio range) to avoid transition rejection.
  2. Use reference-to-video mode with 2-3 clear character stills for locked subject identity.
  3. Format dialogue prompts clearly to trigger native audio lip-sync.
- vs: Outperforms Kling 3.0 on start-to-end frame aspect ratio constraint validation and multi-reference stability, supporting up to 16s takes.
- sources: [vidu.studio](https://vidu.studio), [reddit.com/r/aivideo](https://reddit.com/r/aivideo)

### Vidu Q3 Turbo / Q3 Pro
- released: 2026-02 [vidu.studio](https://vidu.studio)
- category: Precision / Control
- good-at: Q3 Pro delivers high-bitrate 1080p hero renders with native audio and multi-character consistency; Q3 Turbo provides low-cost rapid prototyping.
- do-not: Use Q3 Turbo for final cinematic masters (lower textural detail); push Q3 Pro with cluttered multi-subject prompts without reference images.
- personality: Q3 Pro is stately and cinematic; Q3 Turbo is quick and agile.
- tips:
  1. Prototype camera paths and timing on Q3 Turbo before submitting final master renders to Q3 Pro.
  2. Upload dedicated character reference portraits to maintain subject features across shots.
  3. Leverage native audio generation for multi-speaker dialogue scenes.
- vs: Q3 Pro competes directly with Kling 3.0 Pro and Seedance 2.5 on multi-reference character locking; Q3 Turbo matches Wan 2.1 Fast speeds.
- sources: [vidu.studio](https://vidu.studio), [reddit.com/r/aivideo](https://reddit.com/r/aivideo)

### Vidu Q2
- released: 2025-11 [vidu.studio](https://vidu.studio)
- category: Stylized
- good-at: 5-8s 1080p anime-style animation, reference-to-video (R2V) character retention, sharp 2D visual fidelity.
- do-not: Expect native audio (silent model); attempt complex photorealistic human skin micro-textures (favors anime/3D stylized rendering).
- personality: Crisp and stylized; outstanding motion stability for anime and cartoon illustration inputs.
- tips:
  1. Ideal model choice for anime artwork and 2D digital illustrations.
  2. Use reference-to-video mode to lock character visual identity across shots.
  3. Keep camera movements smooth and linear for cleanest line art retention.
- vs: Predecessor to Q3 series; highly favored by anime creators for clean line art rendering prior to Q3's audio release.
- sources: [vidu.studio](https://vidu.studio), [reddit.com/r/aivideo](https://reddit.com/r/aivideo)

### Vidu 1.0 / 1.5 / 2.0
- released: 2024-09 [vidu.studio](https://vidu.studio)
- category: Stylized
- good-at: Early baseline 4-8s 1080p generation, anime motion synthesis, basic camera pans.
- do-not: Expect complex multi-shot narrative control; rely on for realistic physical destruction or native audio.
- personality: Stylized and predictable; solid performance on simple anime stills but rigid on complex real-world physics.
- tips:
  1. Use for legacy 2D anime animation workflows.
  2. Keep prompts simple and focused on a single visual subject.
  3. Drive via Image-to-Video rather than Text-to-Video.
- vs: Foundational legacy line; superseded by Vidu Q2 and Q3 series.
- sources: [vidu.studio](https://vidu.studio), [reddit.com/r/aivideo](https://reddit.com/r/aivideo)
