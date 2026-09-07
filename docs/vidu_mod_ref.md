# ShengShu Vidu AI Video Model Reference

### Vidu Q3 Pro / Q3 Flagship
- released: 2026-02 [vidu.studio](https://vidu.studio)
- category: Precision / Control
- good-at: Hero-tier 1080p high-bitrate rendering, 1–16s variable duration, single-pass joint audio-visual latent generation, multi-character identity retention via Reference-to-Video (R2V, 1–7 reference slots), multi-speaker lip-sync alignment with natural facial expressions, top-tier Image-to-Video (I2V) Artificial Analysis benchmark performance.
- do-not: Overload all 7 reference slots with conflicting lighting or art styles (causes visual feature bleeding and identity confusion); submit pure text-only prompts without image references if cinema-grade character consistency is required (reference-first input yields significantly higher benchmark fidelity than text-only generation); run quick draft tests on Pro tier (higher credit cost per second compared to Q3 Turbo).
- personality: Stately, cinematic, and highly disciplined; excels at multi-subject character coherence and joint acoustic-visual temporal sync without post-hoc lip-sync distortion.
- tips:
  1. Upload 3–4 clean reference images (e.g., 2 multi-angle character portraits, 1 face close-up, 1 environment still) to achieve the optimal sweet spot between character identity retention and background fidelity.
  2. Enclose spoken dialogue in explicit quotation marks (`Character A: "exact spoken sentence"`) inside the prompt or attach a WAV/MP3 audio track to trigger single-pass native audio lip-sync.
  3. Pre-plan camera motion, timing, and shot composition using Vidu Q3 Turbo before locking in final master renders on Q3 Pro to conserve generation credits.
- vs: Outperforms Kling 3.0 Pro and Seedance 2.5 on multi-reference character identity locking (up to 7 image slots) and native single-pass audio generation, though credit consumption is higher per 1080p frame.
- sources: [vidu.studio](https://vidu.studio), ShengShu Vidu Q3 Launch Technical Briefing, [reddit.com/r/aivideo](https://reddit.com/r/aivideo)

### Vidu Q3 Turbo
- released: 2026-02 [vidu.studio](https://vidu.studio)
- category: Precision / Control
- good-at: High-speed low-cost video draft generation, accelerated camera path blocking, shot timing preview, 1–16s variable duration testing, quick multi-reference layout validation prior to Pro rendering.
- do-not: Expect master-tier micro-textural skin detail or high-bitrate visual clarity required for final hero commercial delivery; rely on Turbo for fine acoustic lip-sync nuance in dense multi-speaker dialogue scenes.
- personality: Agile, responsive, and pragmatic; engineered for rapid turnarounds and structural camera blocking rather than micro-detail polish.
- tips:
  1. Use Q3 Turbo as a rapid blocking tool to iterate camera paths (e.g., fast orbit, push-in, crane up) and scene timing before sending the sequence to Q3 Pro.
  2. Test multi-reference image slot combinations (1–7 inputs) on Turbo to quickly verify whether character features and background stills blend without identity drift.
  3. Switch to Q3 Pro once shot composition and timing are locked to execute the final 1080p high-bitrate master render.
- vs: Matches Wan 2.2 Fast and Kling 3.0 Turbo in generation throughput and low credit burn, serving as the dedicated prototyping engine for the Vidu Q3 ecosystem.
- sources: [vidu.studio](https://vidu.studio), ShengShu API Documentation, Creator Community Benchmarks

### Vidu Q1 / Start-End Interpolation Endpoint
- released: 2025-06 [vidu.studio](https://vidu.studio)
- category: Precision / Control
- good-at: Dedicated `viduq1-start-end` API endpoint, fixed 5s seamless transition keyframe interpolation between start and end frames, strict aspect ratio boundary validation (enforcing 0.8–1.25 start/end aspect ratio matching), smooth morph-free object transformation.
- do-not: Submit start and end images with mismatched aspect ratios outside the `0.8` to `1.25` tolerance boundary ($AR_{end} / AR_{start}$ ratio constraint), which triggers an immediate HTTP 400 validation error (`invalid_aspect_ratio_mismatch`); attempt to force variable duration (hard-locked to 5-second interpolation window).
- personality: Rigidly constrained and mathematically exact; acts as a strict keyframe bridge that guarantees boundary validation while smoothing intermediate spatial transitions.
- tips:
  1. Crop start and end frames to identical pixel dimensions (or ensure their aspect ratios satisfy the `0.8`–`1.25` ratio tolerance factor) prior to API submission to avoid pre-inference HTTP 400 rejection.
  2. Align subject positions and main focal elements across both keyframes to facilitate smooth physical motion trajectories during the 5-second transition window.
  3. Use for complex scene morphs, camera push-through transitions, or time-lapse bridging between distinct visual states.
- vs: Superior aspect ratio safety and transition validation compared to unconstrained start-end keyframe tools (e.g., Luma Ray 2, Kling 2.6 FL2V), protecting users from credit loss due to aspect ratio distortion.
- sources: [vidu.studio](https://vidu.studio), ShengShu Developer API Documentation (`viduq1-start-end`)

### Vidu S1 (Real-Time / Low Latency)
- released: 2025-09 [vidu.studio](https://vidu.studio)
- category: Precision / Control
- good-at: Ultra-low-latency real-time video stream generation, sub-second latency frame output for interactive applications, real-time prompt-driven motion control, streamable visual feedback loops.
- do-not: Submit heavy multi-reference 7-image character sheets (optimized for low-latency single-prompt or single-image stream inputs); expect offline-quality multi-pass 1080p hero rendering.
- personality: Hyper-reactive and stream-oriented; prioritizes immediate temporal frame output and interactive responsiveness over dense spatial refinement.
- tips:
  1. Stream input prompts via persistent API connections to maintain uninterrupted real-time video generation cycles.
  2. Pair with lightweight single-image conditioning inputs to steer visual aesthetic without incurring reference ingestion latency.
  3. Target interactive installation, live visual performance, or real-time simulation workflows requiring sub-second response times.
- vs: Competes with real-time stream engines like LTX Video 2B Fast and real-time LCM video pipelines, prioritizing ultra-low latency over offline cinematic rendering.
- sources: [vidu.studio](https://vidu.studio), ShengShu Real-Time SDK Technical Notes

### Vidu Q2
- released: 2025-11 [vidu.studio](https://vidu.studio)
- category: Stylized
- good-at: 5–8s 1080p anime and 3D illustrative character animation, crisp line art preservation, reference-to-video (R2V) character locking for 2D/3D stylized artwork, vibrant visual color rendition.
- do-not: Expect native audio generation (silent model architecture, requiring external audio pairing); use for photorealistic live-action human skin and real-world micro-textural rendering (optimized strictly for stylized art).
- personality: Expressive, artistic, and visually crisp; highly specialized for retaining 2D line art and 3D anime character integrity across dynamic motion passes.
- tips:
  1. Input clean, high-contrast 2D anime illustrations or 3D character renders as image conditions to maximize line art stability.
  2. Keep prompt descriptions focused on movement trajectories (e.g., "character running through wind, floating hair, dynamic camera angle") to leverage stylized physics.
  3. Combine output clips with external post-production audio tracks since Q2 does not include native audio generation.
- vs: Outperforms generalist photorealistic models on 2D anime line art retention and 3D cartoon style stability, competing directly with ToonCrafter and specialized anime LoRAs.
- sources: [vidu.studio](https://vidu.studio), [reddit.com/r/aivideo](https://reddit.com/r/aivideo), Anime Creator Benchmarks

### Vidu 1.0 / 1.5 / 2.0
- released: 2024-09 [vidu.studio](https://vidu.studio)
- category: Stylized
- good-at: Early foundation line for 4–8s 1080p video generation, basic anime motion synthesis, simple template-driven camera pans, early image-conditioned animation.
- do-not: Expect complex multi-character identity locking or multi-image R2V slots (supports baseline single-image or text-only conditioning); request complex physical collision dynamics or native audio.
- personality: Simple, foundational, and template-bound; predictable motion on basic stylized keyframes, but easily overwhelmed by complex physical scenes.
- tips:
  1. Use primarily for legacy maintenance of early anime animation workflows or quick baseline testing.
  2. Stick to simple single-subject prompts with clear directional camera movements (e.g., "slow pan right across stylized landscape").
  3. Upgrade workflows to Vidu Q2 for stylized anime or Vidu Q3 Pro for cinematic multi-reference production.
- vs: Foundational legacy generation line that established ShengShu's initial video diffusion architecture, now superseded by the Q2 and Q3 series.
- sources: [vidu.studio](https://vidu.studio), ShengShu 1.0 Release Announcement
