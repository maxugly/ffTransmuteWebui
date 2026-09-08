/**
 * References tab — two sub-tabs sharing one bare workspace:
 *   YT Footage (license/disclosure/monetize/watermarks/strategy cards)
 *   Video Models (the Big Chart — one card, one table)
 * Left nav (.nav-item data-tab="refs" / "refs-models") and the top
 * segmented bar stay in sync via switchTab.
 */
import { state, elements, switchTab } from '/app.js';
import { escapeHtml } from '/js/utils.js';

const SVG_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
const SVG_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
const SVG_WARN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>';
const SVG_INFO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>';
const SVG_EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>';
const SVG_SHIELD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></svg>';
const SVG_MONEY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" x2="12" y1="2" y2="22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>';
const SVG_LAYERS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/><path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"/><path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"/></svg>';
const SVG_UPRIGHT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7"/><path d="M7 7h10v10"/></svg>';
const SVG_FILM = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="14" rx="2"/><line x1="8" y1="22" x2="16" y2="22"/><line x1="12" y1="18" x2="12" y2="22"/></svg>';

function renderReferencesForm() {
  const sub = state.activeTab === 'refs-models' ? 'models'
    : state.activeTab === 'refs-images' ? 'imgmodels'
    : state.activeTab === 'refs-code' ? 'code' : 'yt';
  const wide = sub !== 'yt';
  const html = `
    <div class="ref-workspace${wide ? ' ref-workspace-wide' : ''}">
      <div class="ref-subtabs" id="refSubtabs">
        <button class="ref-subtab${sub === 'yt' ? ' active' : ''}" data-ref-tab="refs">YT Footage</button>
        <button class="ref-subtab${sub === 'models' ? ' active' : ''}" data-ref-tab="refs-models">Video Models</button>
        <button class="ref-subtab${sub === 'imgmodels' ? ' active' : ''}" data-ref-tab="refs-images">Image Models</button>
        <button class="ref-subtab${sub === 'code' ? ' active' : ''}" data-ref-tab="refs-code">Coding Models</button>
      </div>
      ${sub === 'models' ? buildModelsSection() : sub === 'imgmodels' ? buildImageModelsSection() : sub === 'code' ? buildCodeModelsSection() : buildYtSections()}
    </div>
  `;
  elements.actionPanel.innerHTML = html;
  (elements.actionPanelRoot || elements.actionPanel).classList.add('ref-active');
  elements.actionPanel.querySelectorAll('#refSubtabs .ref-subtab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-ref-tab');
      if (target && target !== state.activeTab) switchTab(target);
    });
  });
  bindSortableTables();
}

function buildYtSections() {
  return `
      ${buildLicenseSection()}
      <div class="ref-grid-2col">
        ${buildDisclosureSection()}
        ${buildMonetizeSection()}
      </div>
      <div class="ref-grid-2col">
        ${buildWatermarksSection()}
        ${buildStrategySection()}
      </div>
  `;
}

/* ═══════════════════════════════════════════════
   Video Models — The Big Chart
   ═══════════════════════════════════════════════ */
const MODELS_ROWS = [
  { model: 'LTX Video 2.5 (Upsampler) (⚡ Latest · T2V+I2V)', category: 'Cinematic Realism', released: '2026-08', native: '768x512 class, Divisible by 32, default 1216x704 @30fps', sweet: '768x512 single-stage or 960x544 / 1280x720 final via 2x latent upsampler', max: 'Native 4K @ up to 50 fps (3840x2176 tiled)', dur: '5s (121f @24fps) default, API 6-20s (720p/1080p) 6-10s (4K)', fl2v: 'yes', audio: 'yes', notes: 'LTX2TwoStagePipeline / LTX2LatentUpsamplePipeline', strengths: 'Native 4K AV, 2-stage latent upscaler, 50fps, sub-7s 20s API execution', weaknesses: 'Needs 2 stages for best quality, single-stage >1280x704 in I2V duplicates', tips: 'Use LTX2TwoStagePipeline (960x544 -> 1920x1088); guidance_scale=1.0 for distilled; lock multi-character lip-sync by keeping sentences concise.' },
  { model: 'LTX Video 2.5 Distilled (⚡ Latest · T2V+I2V)', category: 'Cinematic Realism', released: '2026-08', native: 'Training buckets 960x544x49, Stage1 960x544 -> Stage2 1920x1088', sweet: 'Single-stage 768x512 or 960x544 @24fps 97-121f, 8 steps stage1 + 4 steps stage2', max: 'Native 4K @ up to 50 fps', dur: '5s (121f) sweet, practical 97-161f (4-6.7s), up to 20s API', fl2v: 'yes', audio: 'yes', notes: 'Fastest inference', strengths: '8-step distilled, guidance_scale=1.0, fastest LTX 2.5', weaknesses: 'Duplicates/disintegrates above 1280x704 in I2V', tips: 'Set guidance_scale=1.0 strictly to prevent color burn; use 960x544 8-step passes for rapid 20s AV drafts.' },
  { model: 'LTX Video 2.3 Distilled (High Quality · T2V+I2V)', category: 'Precision / Control', released: '2026-03', native: '1216x704 native -> 1920x1088 upscale, example 480x832, 720p class', sweet: '768x512 @97f (~4s) - 40s @768x512 and 50s @1280x704 on RTX 5090', max: '4K via latent upscaler, up to 20s', dur: '4-6s sweet, max 20s single generation', fl2v: 'yes', audio: 'yes', notes: 'Distilled default', strengths: '50% lower compute, synced stereo audio', weaknesses: 'LTX-2.0 LoRAs incompatible, requires fp32 if bf16 visual corruption manifests', tips: 'Use for singing avatars and music videos; input uncompressed 44.1kHz audio; disable secondary temporal upscaler if edge shivering occurs.' },
  { model: 'LTX-2.3 F2LF (First-Last Frame · T2V+I2V)', category: 'Precision / Control', released: '2026-03', native: '720p native (range 480p-1440p native, 4K via upscaler), divisible by 32, 8n+1 frames', sweet: '768x512 to 1280x720 (720p) @121f (~5s @24fps), 704x416x97f on 8GB', max: '4K (2160p) via 2-stage latent upscale, Fast reaches 20s', dur: '5-6s coherence, up to 10s, max 20s, API 6/8/10/12/14/16/18/20s', fl2v: 'yes', audio: 'yes', notes: 'Video_ltx2_3_flf2v workflow', strengths: 'Native first+last frame interpolation, 20s max one pass', weaknesses: 'Needs start+end image for best use', tips: 'Set last_frame_uri in KeyframeInterpolationPipeline; enforce 8n+1 frame counts (97f, 121f) for clean mathematical steps.' },
  { model: 'LTX Video 2 TURBO (High Quality · T2V+I2V)', category: 'Precision / Control', released: '2026-01', native: '720p-1080p native, Native 4K Fidelity', sweet: '720p Standard @6s - 6s Full HD in 5s', max: 'Native 4K @ up to 48-50 fps, clips up to 10s, up to 20s audio', dur: '6-10s sweet, I2V 6-20s up to 4K', fl2v: 'yes', audio: 'yes', notes: 'TURBO = Fast variant', strengths: 'Fast prototyping, 5s for 6s 1080p, open-source 19B', weaknesses: 'Still heavy 19B, 4K needs 2-stage', tips: 'Deploy LTX-2 Fast for low-latency composition checks before submitting final master renders to LTX-2 Pro.' },
  { model: 'LTX Video 0.9.8 13B Distilled (High Quality · T2V+I2V)', category: 'Open / Self-Host', released: '2026-06', native: '768x512 @24fps, new default 1216x704 @30fps', sweet: '768x512 / 512x768 base, cheap HD 704x1216 / 1216x704, 7 steps guidance 1', max: 'Up to 1280px natively, 1920x1080 via ltxv-spatial-upscaler-0.9.8', dur: '5s @24-30fps ideal, 15-30s reliable, up to 60s via chunking, max 1441f', fl2v: 'no', audio: 'no', notes: 'Old arch, 13B', strengths: '8 steps preview, long-form 60s chunking', weaknesses: 'No native audio, needs upscaler for 1080p+', tips: 'Run 8-step preview passes at guidance_scale=1.0; use longshot chunking pipeline to chain 5s windows up to 60s.' },
  { model: 'Omni Video Custom (⚡ Fast Motion · T2V+I2V)', category: 'Precision / Control', released: '2025-06', native: 'Unknown - custom factory model, inferred 720p-class', sweet: 'Unknown - inferred 720p / 1216x704', max: 'Unknown - inferred 720p-1080p', dur: 'Unknown - inferred 5s', fl2v: 'no', audio: '?', notes: 'Custom - HF Space Omni Video Custom-fast-motion', strengths: 'Fast motion focused, video extend, listed with LTX/Wan', weaknesses: 'Zero docs, custom no public card', tips: 'Use strictly for fast motion prototype clips.' },
  { model: 'Wan 2.2 Fast (⚡ Fast · T2V+I2V)', category: 'Precision / Control', released: '2025-02', native: '480P & 720P MoE, high-quality 720p dataset', sweet: '480p (832x480 @16fps, 53f) cheap, RIFE interpolation', max: '1280x720 (720P) natively, 1080p via external upscaler', dur: '5s (81f @16fps)', fl2v: 'no', audio: 'no', notes: 'A14B-NFE4 distilled', strengths: '4-step LightX2V Lightning LoRA, 20s vs 147s base @720p, complex motion retained', weaknesses: '720p max native, no audio, steps >4 corrupt render', tips: 'Must execute at strictly 4 steps; exceeding 4 steps causes severe over-exposure and color clipping.' },
  { model: 'Wan 2.2 I2V rCM (I2V Only · T2V+I2V)', category: 'Precision / Control', released: '2025-02', native: '480P & 720P, 5s @720P 16fps target, Best 720p', sweet: '480p (832x480) 8.0s distill vs 720p (1280x720) 20.0s distill', max: '720P native, 1080x1920 works via scale', dur: '5s (81f @16fps), extendable 81-109f (6.8s)', fl2v: 'yes', audio: 'no', notes: 'TurboWan2.2-I2V-A14B-720P', strengths: 'rCM 4-step turbo, I2V optimized, complex motion', weaknesses: 'No audio, I2V only, steps >4 corrupt render', tips: 'Execute at strictly 4 steps with rCM checkpoint; feed clean 720p stills; keep text prompts concise.' },
  { model: 'Wan 2.2 I2V (LoRA) (I2V Only · T2V+I2V)', category: 'Precision / Control', released: '2025-02', native: '480P & 720P MoE, 5s @ up to 720p/24fps', sweet: '480p class 832x480 @16fps, 832x480 @16fps (53f) + RIFE', max: '1280*720 (720p)', dur: '5s (supports 5, 8s), 81f @16fps', fl2v: 'yes', audio: 'no', notes: 'I2V High/Low Noise rank64 lightx2v 4step', strengths: 'LoRA camera controls, must use with Wan2.2-I2V-A14B base, fast', weaknesses: 'Cannot standalone, LoRA only, no audio', tips: 'Deploy rank-64 camera LoRAs at weights 0.6–0.8; ensure LoRA architecture matches base model exactly.' },
  { model: 'Seedance 1.0 Lite', category: 'Stylized', released: '2025-07', native: '480p-720p', sweet: '480p rapid iteration, 720p balanced', max: '720p', dur: '4-5s', fl2v: 'no', audio: 'no', notes: 'Early budget draft tier', strengths: 'Quick, cheap concept generation', weaknesses: 'Prone to visual noise and facial drift', tips: 'Keep clip lengths under 4s; apply negative prompts for noise.' },
  { model: 'Seedance 1.0 Pro / Pro Fast', category: 'Cinematic Realism', released: '2025-10', native: '1080p max but trained 720p', sweet: '720p / 640x640 — 1080p is final polish tier', max: '1080p', dur: '5-12s', fl2v: 'yes', audio: 'no', notes: 'Your current model', highlight: true, strengths: 'Dependable middle ground, 30-60% faster inference than 1.0 Pro', weaknesses: '1080p is upscaled polish, soft micro-expressions on intricate faces', tips: 'Use as primary B-roll engine; specify explicit lighting directions (golden hour side lighting).' },
  { model: 'Seedance 2.0', category: 'Precision / Control', released: '2026-02', native: '720p / 1080p', sweet: '720p — outputs 480p/720p/1080p', max: '1080p', dur: '4s-15s', fl2v: 'yes', audio: 'yes', notes: 'Native audio + 3s video trajectory drive', strengths: '1 face + 1 wardrobe + 1 audio + 1 video reference; 3s camera clip forces exact 3D trajectory', weaknesses: 'Capped at 15s max; combining conflicting audio styles causes robotic dialogue', tips: 'Supply a 3s camera motion video alongside text to force exact camera trajectory replication; add organic camera texture (subtle lens flare).' },
  { model: 'Seedance 2.5 / 3.0', category: 'Precision / Control', released: '2026-07', native: '480p/720p native, 1080p upscale', sweet: '720p for physics, 1080p for final', max: '1080p', dur: '30s continuous single take', fl2v: 'yes', audio: 'yes', notes: '50-item multimodal reference stack', strengths: 'Single-pass 30s clips without cuts; 50 reference slots (optimal 11-15); local in-scene edit without re-roll', weaknesses: 'Native renders 480p-720p (needs upscaler); real human photo filter blocks', tips: 'Format 30s takes in timestamp brackets ([0-8s] dolly in, [8-18s] turn left); power-user sweet spot is 11-15 refs; use AI face stills to bypass filter.' },
  { model: 'MiniMax H3 (High Quality · T2V+I2V) / Hailuo 03', category: 'Cinematic Realism', released: '2026-07', native: '2K native (2048x1152 / 1152x2048)', sweet: '768P @ 5-15s while iterating, 2K for final masters', max: '2K @ up to 15s, 24/30 FPS', dur: '4-15s allowed, sweet 5-10s', fl2v: 'yes', audio: 'yes', notes: 'Alias Hailuo 3.0', highlight: true, strengths: 'Native 2K resolution default, single-pass 15s, native stereo audio, open weights (MiniMax-H3)', weaknesses: 'Pay-as-you-go API; Ref2VA multi-ref mode has lower visual quality than FL2VA keyframing', tips: 'Use FL2VA keyframing rather than Ref2VA multi-ref stack for cleanest base renders; include explicit acoustic soundscape descriptors.' },
  { model: 'Vidu 1.0 / 1.5 / 2.0', category: 'Precision / Control', released: '2024-09', native: '1080p', sweet: '540p drafts, 720p default, 1080p final', max: '1080p', dur: '4s or 8s', fl2v: 'yes', audio: 'no', notes: 'Legacy line — Q-series supersedes it', strengths: 'Early reference-to-video + template motion synthesis', weaknesses: 'Superseded by Q3; no native audio', tips: 'Only reach for these when Q3 credits sting — same anchor discipline applies.' },
  { model: 'Vidu Q1 / Q3-Pro / S1', category: 'Precision / Control', released: '2026-02', native: '540p/720p/1080p tiers (Q3 Pro)', sweet: '720p Turbo drafts, 1080p Pro finals', max: '1080p up to 16s', dur: 'Flexible 1-16s (Q1 start-end fixed 5s)', fl2v: 'yes', audio: 'yes', notes: 'Start-end magic is the flagship; S1 is real-time', strengths: 'Q3 Pro single-pass joint AV lip-sync + 1-7 R2V slots (sweet spot 3-4); Q1 viduq1-start-end 5s keyframe morphing; arena-ranked #1 I2V', weaknesses: 'Q1 enforces strict 0.8–1.25 start/end aspect ratio guard (HTTP 400 rejection if mismatched); T2V weaker than R2V', tips: 'For Q1 start-end: ensure start and end frames match aspect ratios within 0.8–1.25 boundary; for Q3 Pro dialogue: use double quotes ("speech text") or attach audio track.' },
  { model: 'Kling 2.0 / 2.1 / 2.5 Turbo / 2.6', category: 'Avatar / Lip-Sync', released: '2025-12', native: '1080p', sweet: '720p Standard (~1300x708), 1080p Pro', max: '1080p', dur: '5-10s', fl2v: 'yes', audio: 'yes', notes: 'Standard = 720p, Pro = 1080p', strengths: 'First Kling release with single-pass synchronized audio-visual generation (voiceovers, SFX, ambient soundscapes)', weaknesses: 'Multi-speaker dialogue in single clip causes audio attribution slips across characters', tips: 'Format spoken dialogue in double quotes ("speech"); insert sound effect tags in brackets [heavy footsteps]; keep character motion subtle during speech.' },
  { model: 'Kling 3.0 / O3', category: 'Cinematic Realism', released: '2026-01', native: 'Native 4K — 3840x2160 native rendering, no upscaling', sweet: '1080p Pro for physics, 4K for final — max 4K (3840x2160)', max: '4K 60fps', dur: '10-15s', fl2v: 'yes', audio: 'yes', notes: 'First true native 4K model', strengths: 'Native 4K/60fps single-pass generation without upscalers, fluid liquid/cloth dynamics, single-pass sound FX', weaknesses: 'Fast multi-subject action causes limb morphing and fused digits; multi-speaker audio slips across faces', tips: 'Use explicit camera commands (slow dolly in, tracking shot) rather than vague adjectives; use explicit negative prompts against digit fusion (mutated hands, extra fingers, broken wrist).' },
  { model: 'Luma Ray2', category: 'Cinematic Realism', released: '2024-12', native: '540p/720p', sweet: '720p', max: '720p', dur: '5-9s', fl2v: 'yes', audio: 'yes', notes: 'Legacy Luma line', strengths: 'Good lighting and physics feel', weaknesses: 'Capped at 720p, showing its age next to Ray3', tips: 'Use 720p for quick lighting concept checks.' },
  { model: 'Luma Ray3 / Ray3.14', category: 'Physics / Chaos', released: '2025-11', native: 'Native 1080p — delivering native 1080p', sweet: '1080p — architecture scaled to produce crisp 1080p natively', max: '1080p + 4K upscaler', dur: '5-10s', fl2v: 'yes', audio: 'yes', notes: 'Your best for wall crash debris', highlight: true, strengths: 'Physics and particle chaos — demolition derby model, debris, splashing, wall crashes', weaknesses: 'Long scene lip-sync/motion tracking inconsistencies (Ray3 review), cost and render time climb with upscale pass', tips: 'Highlight kinetic force words (crashing waves, collapsing stone, exploding debris) in prompt.' },
  { model: 'Veo 3 / Veo 3 Fast / Veo 3.1', category: 'Cinematic Realism', released: '2026-05', native: '720p/1080p/4K', sweet: '720p default, 1080p or 4K for final', max: '4K', dur: '8-10s', fl2v: 'yes', audio: 'yes', notes: 'Fast = double speed at 720p, Standard = HQ, 3.1 = stereo lip-sync', strengths: 'Best cinematic prompt adherence, native synchronized audio (dialogue, ambient, SFX), true 3D keyframe interpolation', weaknesses: 'Hard 8-10s cap, strict safety filter moderation rejections', tips: 'Follow 6-Part Formula: Subject + Context + Action + Style + Camera Work + Audio (dialogue: "...", ambient sound).' },
  { model: 'Pixverse 6.0 / Motion 2.0', category: 'Precision / Control', released: '2026-03', native: '1080p', sweet: '1080p 15s with virtual camera controls', max: '1080p', dur: '15s', fl2v: 'yes', audio: 'yes', notes: '20+ virtual camera lens controls & synchronized audio', strengths: 'Granular lens controls (85mm portrait lens, shallow depth of field), 15s duration', weaknesses: 'Steeper learning curve for camera parameter tuning', tips: 'Specify explicit lens parameters (e.g. 85mm portrait lens, f/1.8 aperture, shallow depth of field) in prompt.' },
  { model: 'Van Gogh Relax Fast', category: 'Stylized', released: '2025-10', native: '720p', sweet: '540p draft, 720p default', max: '720p', dur: '5s', fl2v: '?', audio: 'no', notes: 'Use for drafts, then upscale to Standard/HQ', strengths: 'Fastest painterly pass, heavy impasto / swirl, good for style tests', weaknesses: 'Low detail, temporal flicker, no audio, soft edges', tips: 'Use Fast for 540p draft style checks before committing to HQ.' },
  { model: 'Van Gogh Relax Standard', category: 'Stylized', released: '2025-10', native: '1080p', sweet: '720p default', max: '1080p', dur: '5s', fl2v: '?', audio: 'no', notes: 'Best daily driver for Van Gogh', strengths: 'Balanced Van Gogh look, retains detail better than Fast, still quick', weaknesses: 'No audio, can warp small objects like dice / rigging', tips: 'Emphasize painterly terms: thick oil paint impasto, heavy swirling brushstrokes.' },
  { model: 'Van Gogh Relax HQ', category: 'Stylized', released: '2025-10', native: '1080p', sweet: '1080p default', max: '1080p', dur: '5-8s', fl2v: '?', audio: 'no', notes: 'Use for final art pass after Real Motion', strengths: 'Highest brush detail, thick oil texture, most stable style of the 3', weaknesses: 'Slowest, no audio', tips: 'Use for final art pass on stylized master renders.' },
  { model: 'Real Motion 3.5 Turbo', category: 'Physics / Chaos', released: '2025-12', native: '1080p', sweet: '720p draft, 1080p final', max: '1080p', dur: '5s or 8s', fl2v: '?', audio: 'yes', notes: 'Top pick - your overhead battle model.', highlight: true, strengths: 'Current flagship - best particle explosion physics, liquid splashes + audio sync, turbo fast', weaknesses: 'Prop Eating failure mode: high destruction strength can swallow/dissolve small secondary props (dice, rigging)', tips: 'Provide high-resolution structural start frames before triggering destruction prompts; highlight kinetic force words (shattering glass, crashing wave).' },
  { model: 'Real Motion 3.5', category: 'Physics / Chaos', released: '2026-08', native: '1080p', sweet: '720p draft, 1080p final', max: '1080p', dur: '5s or 8s', fl2v: '?', audio: 'yes', notes: 'Use when you need max quality over speed', strengths: 'Full quality 3.5, slightly cleaner particle dynamics than Turbo, audio sync', weaknesses: 'Slower than Turbo', tips: 'Use full 3.5 for uncompressed particle explosion masters.' },
  { model: 'Real Motion 3.1 Turbo', category: 'Physics / Chaos', released: '2025-10', native: '1080p', sweet: '540p drafts, 720p default, 1080p final', max: '1080p', dur: '5s', fl2v: '?', audio: 'yes', notes: 'Good cheap draft for sinking-dice gag.', strengths: 'Fast iteration, good subject consistency, audio', weaknesses: 'Older physics than 3.2/3.5, softer fire/smoke micro-textures', tips: 'Keep background simple to minimize particle noise.' },
  { model: 'Real Motion 3.1', category: 'Physics / Chaos', released: '2025-10', native: '1080p', sweet: '720p default', max: '1080p', dur: '5s or 8s', fl2v: '?', audio: 'yes', notes: 'Stable 3.1 base', strengths: 'Stable 3.1 base, better motion than 2.6/Turbo, audio', weaknesses: 'No turbo speed, mid-pack vs 3.5', tips: 'Good for simple rolling and falling physical dynamics.' },
  { model: 'Real Motion 3.2', category: 'Physics / Chaos', released: '2025-11', native: '1080p', sweet: '720p default', max: '1080p', dur: '5s or 8s', fl2v: '?', audio: 'yes', notes: 'Best for scenes with climbers + ships + planes together', strengths: 'More stable than 3.1 on multi-object scenes, prevents structural collapse during camera pans', weaknesses: 'No turbo, slightly softer than 3.5', tips: 'Use for multi-object physics scenes where structural retention is required.' },
  { model: 'Real Motion Turbo', category: 'Physics / Chaos', released: '2025-08', native: '720p', sweet: '540p drafts, 720p default', max: '720p', dur: '5s', fl2v: '?', audio: 'no', notes: 'Use for quick camera tests only.', strengths: 'Super fast 720p draft physics', weaknesses: '720p ceiling, no audio, weak particle detail', tips: 'Restrict use strictly to rapid camera motion rough-cuts.' },
  { model: 'Real Motion 2.6', category: 'Physics / Chaos', released: '2025-06', native: '720p', sweet: '540p default', max: '720p', dur: '5s', fl2v: '?', audio: 'no', notes: 'Legacy base', strengths: 'Oldest stable base, runs fast', weaknesses: 'No audio, dated motion, soft edges', tips: 'Legacy 720p draft tool.' },
  { model: 'Real Motion 3.2 Remix', category: 'Edit / Extend', released: '2025-11', native: '1080p', sweet: '720p default', max: '1080p', dur: '5-8s', fl2v: '?', audio: 'yes', notes: 'Use for Van Gogh + Real Motion combo pass.', strengths: 'Remix mode - restyles motion & physics from reference video onto new subject image, audio', weaknesses: 'High restyling strength causes severe subject warping, limb tearing, and facial melting', tips: 'Match physical silhouette of target image to reference motion video before restyling.' },
  { model: 'Real Motion 2.6 Remix', category: 'Edit / Extend', released: '2025-11', native: '720p', sweet: '540p default', max: '720p', dur: '5s', fl2v: '?', audio: 'no', notes: 'Style restyling tests.', strengths: 'Remix on old 2.6 base, style experiments', weaknesses: 'No audio, 720p only, least stable', tips: 'Dial restyling strength down to avoid limb tearing.' },
  { model: 'Wan 3.0', category: 'Open / Self-Host', released: '2026-08', native: '1080p', sweet: '720p drafts, 1080p finals', max: '1080p @ 30fps', dur: '30s', fl2v: 'yes', audio: 'yes', notes: 'Alibaba open-weights multimodal video foundation model', strengths: '30s clip length, 20 reference slots, native audio, high spatial fidelity', weaknesses: 'Heavy GPU memory requirements for local multi-reference stack', tips: 'Limit reference stack to 5–9 key images for optimal attention focus.' },
  { model: 'Wan 3.0 Prime', category: 'Precision / Control', released: '2026-08', native: '1080p API model (480P/720P/1080P @30fps)', sweet: '720p drafts, 1080p finals', max: '1080p @30fps', dur: '2-30s (smart duration -1)', fl2v: 'yes', audio: 'yes', notes: 'Prime = speed tier of Wan 3.0 (~1.4x standard price)', strengths: 'Unified T2V+I2V+R2V in one model; refs span images, video, audio, even docs (.pptx/.pdf/.xls)', weaknesses: 'Hard 1080p ceiling, no 4K; invite-gated regional API; ignores negative prompt fields', tips: 'Set delivery (res/ratio/duration) before writing prompt; exclusions MUST be written as plain text in main prompt (API ignores negative fields); set enable_thinking=true for document parsing (.pdf/.pptx).' },
  { model: 'Wan 2.7', category: 'Cinematic Realism', released: '2026-05', native: '720p / 1080p', sweet: '720p @ 10s', max: '1080p', dur: '5-15s', fl2v: 'yes', audio: 'no', notes: 'Alibaba Wan intermediate release preceding Wan 3.0', strengths: 'Steady motion physics, solid I2V feature preservation', weaknesses: 'Lacks the unified document reference stack of Wan 3.0', tips: 'Use for general I2V scene extension where 3.0 multimodal features are not required.' },
  { model: 'Wan 2.6', category: 'Cinematic Realism', released: '2026-03', native: '720p', sweet: '720p @ 5s', max: '720p', dur: '5-10s', fl2v: 'yes', audio: 'no', notes: 'Wan 2.x generation base model', strengths: 'Stable camera motion, low credit cost', weaknesses: 'No native audio, 720p max resolution', tips: 'Keep prompts direct and concise.' },
  { model: 'Happy Horse 1.1', category: 'Avatar / Lip-Sync', released: '2025-11', native: '720p/1080p', sweet: '1080p 15s lip-sync', max: '1080p', dur: '15s', fl2v: 'yes', audio: 'yes', notes: 'Multilingual lip-sync, joint audio-video 15B Transformer', strengths: 'Single-pass phoneme-level lip-sync across 7 languages; 9 reference image character consistency slots', weaknesses: 'Restricted to talking-head framing', tips: 'Format dialogue in double quotes ("speech") or attach uncompressed 44.1kHz audio track.' },
  { model: 'Happy Horse 1.0', category: 'Avatar / Lip-Sync', released: '2025-08', native: '720p', sweet: '720p portrait speech', max: '720p', dur: '10s', fl2v: 'yes', audio: 'yes', notes: 'Base model, predecessor to 1.1', strengths: 'Early audio-visual avatar sync', weaknesses: 'Soft facial details on 1080p scaling', tips: 'Use high-resolution portrait inputs.' },
  { model: 'Happy Horse Edit', category: 'Edit / Extend', released: '2025-12', native: '1080p', sweet: '1080p local edit', max: '1080p', dur: '10s', fl2v: 'yes', audio: 'yes', notes: 'Localized avatar performance editing', strengths: 'In-scene facial performance restyling', weaknesses: 'Requires clear source video framing', tips: 'Ensure input video has steady lighting.' },
  { model: 'Minimax H3 Max', category: 'Precision / Control', released: '2026-08', native: '480p / 768p', sweet: '480p ($0.05/s) drafts, 768p ($0.08/s) finals', max: '768p @ 15s', dur: '5-15s', fl2v: 'yes', audio: 'yes', notes: 'Fast pay-as-you-go API optimized with fal.ai', strengths: 'Ultra-fast API inference, 480p/768p cheap draft iterations', weaknesses: 'Not included in flat video packages; no native 2K output', tips: 'Use 480p ($0.05/s) for initial composition before scaling; keep text prompts focused on macro subject movement.' },
  { model: 'Minimax H3 Max Turbo', category: 'Precision / Control', released: '2026-08', native: '480p / 768p', sweet: '480p fast drafts', max: '768p @ 15s', dur: '5-15s', fl2v: 'yes', audio: 'yes', notes: 'Consumer app hailuoai.video fast credit tier', strengths: 'Rapid turnaround draft mode', weaknesses: 'Credit system unverified on official API docs', tips: 'Ideal for high-throughput draft iterations on hailuoai.video.' },
  { model: 'MiniMax Hailuo 2.3', category: 'Cinematic Realism', released: '2025-10', native: '768p / 1080p', sweet: '768p @ 10s (0.7 points/s Fast tier)', max: '1080p @ 6s', dur: '6-10s', fl2v: 'no', audio: 'no', notes: 'High dynamic prompt adherence; FL2V dropped', strengths: 'Strict prompt obedience, steady physical weight & motion', weaknesses: 'Does not support First & Last Frame (FL2V)', tips: 'Use 768p for 10s steady single-shot takes; 1080p for 6s hero shots.' },
  { model: 'MiniMax Live Illustrations', category: 'Precision / Control', released: '2025-02', native: '720p', sweet: '720p 5s illustration animation', max: '720p @ 5s', dur: '5s', fl2v: 'no', audio: 'no', notes: 'Video Agent template / I2V-01-Live-01 model', strengths: 'Animates 2D digital illustrations, anime stills, and artwork cleanly', weaknesses: 'Capped at 5s, soft on photorealistic inputs', tips: 'Use specifically for 2D illustration and anime artwork stills.' },
  { model: 'Seedance 2.5 Lite', category: 'Precision / Control', released: '2026-07', native: '720p class (native 480p/720p; announced 4K unverified on API)', sweet: '720p drafts — cheap 30s volume', max: '30s single pass (4K announced, API native 480p/720p)', dur: '4-30s (Ultra-Long 180s beta on Jimeng)', fl2v: 'yes', audio: 'yes', notes: 'Lite = fast/cheap tier of 2.5 family (announced Jun 23, shipped Jul 31)', strengths: '30s native single shot without cuts; 50 multimodal refs (image+video+audio); local in-scene edit without re-roll', weaknesses: 'Announced 4K unverified on API tiers; 30s wanders without beat structure; real human photo filter blocks', tips: 'Write 30s in beats with explicit transitions ([0-8s] dolly in); 11-15 refs beat 50; build AI character face portrait to bypass filter.' },
  { model: 'Seedance 2.0 Mini', category: 'Avatar / Lip-Sync', released: '2026-04', native: '480p', sweet: '480p / 720p close-up talking heads', max: '720p', dur: '5-10s', fl2v: 'no', audio: 'yes', notes: 'Budget avatar talking-head model', strengths: 'Cheap lip-sync, clean stylized/anime 2D & portrait facial micro-expressions', weaknesses: 'Motion stutter on fast dynamic camera moves or full-body action', tips: 'Restrict to static portrait framing; lock camera in prompt (locked tripod shot, static framing).' },
  { model: 'Seedance 1.0 Pro Fast', category: 'Cinematic Realism', released: '2025-10', native: '720p', sweet: '720p B-roll batch renders', max: '1080p', dur: '5-12s', fl2v: 'yes', audio: 'no', notes: '30-60% faster inference than 1.0 Pro at lower compute cost', strengths: 'Fast high-volume B-roll production, strong I2V feature retention', weaknesses: 'Soft micro-expressions on intricate human faces', tips: 'Use as primary B-roll engine; specify explicit lighting directions.' },
  { model: 'Seedance 1 Lite', category: 'Stylized', released: '2025-07', native: '480p', sweet: '480p concept drafts', max: '720p', dur: '4-5s', fl2v: 'no', audio: 'no', notes: 'Early budget draft tier', strengths: 'Low credit cost, fast concept generation', weaknesses: 'Prone to visual noise and facial drift', tips: 'Keep clip lengths under 4s; apply negative prompts for noise.' },
  { model: 'Omni Human 1.5', category: 'Avatar / Lip-Sync', released: '2025-12', native: '1080p', sweet: '1080p full-body avatar performance', max: '1080p', dur: '15s', fl2v: 'yes', audio: 'yes', notes: 'ByteDance full-body avatar & motion sync engine', strengths: 'Full-body character tracking, realistic body dynamics and speech alignment matching speech tone', weaknesses: 'Audio inputs >15s suffer from sync drift; requires clear un-obscured portrait', tips: 'Prompt with emotional intent ("spokesperson delivering confident presentation with natural head tilts"); keep audio <15s.' },
  { model: 'Kling 3.0 Omni', category: 'Precision / Control', released: '2026-02', native: '1080p (base 3.0 renders native 4K/60)', sweet: '720p Standard drafts ($0.08/s), 1080p/4K Pro finals', max: '4K/60fps on base 3.0; Omni 1080p', dur: '3-15s, multi-shot up to 6 cuts', fl2v: 'yes', audio: 'yes', notes: 'Omni = unified engine (T2V+I2V+extend+storyboard)', strengths: 'Per-shot storyboard control; voice binds to character; Character Identity 3.0; Canvas Agent spatial control', weaknesses: 'Pro 4K costs 2x and renders slow; consistency frays past ~10s single takes', tips: 'Think director not photographer — Shot, Character, Action, Lighting, Extra; lead with camera language; small edits beat full rewrites; 1080p-min clean references; name light setups explicitly' },
  { model: 'Kling 3.0 Motion Control', category: 'Precision / Control', released: '2026-02', native: '1080p', sweet: '1080p skeletal motion transfer', max: '1080p 30s', dur: '3-30s', fl2v: 'yes', audio: 'yes', notes: 'Video-to-video 3D skeletal motion transfer', strengths: '3D motion tracking, facial expression mirroring, athletic/dance transfer', weaknesses: 'Requires clean reference video without camera shake or occlusions', tips: 'Follow the 7-Image Rule (front, side, 3/4 profiles) to retain subject identity.' },
  { model: 'Kling 01', category: 'Cinematic Realism', released: '2024-06', native: '720p', sweet: '720p single subject', max: '720p', dur: '5s', fl2v: 'no', audio: 'no', notes: 'Foundational legacy Kling model', strengths: 'Early text-to-video baseline, basic fluid simulation', weaknesses: 'Severe digit/hand distortion, high visual drift', tips: 'Drive via I2V with simple single-subject prompts.' },
  { model: 'Grok Imagine Video 1.5', category: 'Cinematic Realism', released: '2025-12', native: '720p / 1080p', sweet: '1080p 6s in-feed', max: '1080p', dur: '5-15s', fl2v: 'yes', audio: 'yes', notes: 'Improved motion physics, faster inference in X/Grok', strengths: 'High prompt responsiveness, rapid generation speed, native audio, extended 15s clips', weaknesses: 'Platform-gated inside X/Grok UI; moderation block triggers on safety filter', tips: 'Focus on motion vectors and sensory sound descriptors; structure multi-segment timelines.' },
  { model: 'Grok Imagine Video', category: 'Cinematic Realism', released: '2025-08', native: '720p', sweet: '720p in-feed video', max: '720p', dur: '5s', fl2v: 'no', audio: 'yes', notes: 'Integrated into X/Grok', strengths: 'Fast generation speed, native audio synthesis', weaknesses: '720p ceiling, limited camera controls, start-frame driven only', tips: 'Keep prompts focused on single action sequences.' },
  { model: 'Gemini Omni 1.1 Flash', category: 'Edit / Extend', released: '2026-03', native: '1080p / 4K', sweet: '1080p conversational video editing', max: '4K @ 40s', dur: '40s', fl2v: 'yes', audio: 'yes', notes: 'Conversational editing, scene extension up to 40s', strengths: '40s max duration per single pass, natural language video editing, multimodal reasoning', weaknesses: 'API latency on long 40s 4K generations', tips: 'Use conversational prompts for step-by-step scene extension ("Extend previous clip by 15s panning left").' },
  { model: 'Gemini Omni Flash', category: 'Edit / Extend', released: '2025-11', native: '1080p', sweet: '1080p fast scene editing', max: '1080p', dur: '20s', fl2v: 'yes', audio: 'yes', notes: 'Fast multimodal video interaction model', strengths: 'Low latency, natural language editing instructions', weaknesses: 'Capped at 20s, lower detail than 1.1 Flash', tips: 'Use for quick iterative scene modifications.' },
  { model: 'Runway Gen-4S', category: 'Cinematic Realism', released: '2025-09', native: '720p', sweet: '720p fast draft clips', max: '720p', dur: '5s', fl2v: 'yes', audio: 'no', notes: 'Fast/short variant of Runway Gen-4', strengths: 'Rapid inference, clean Motion Brush response', weaknesses: 'No native audio, 720p max resolution', tips: 'Use for fast camera motion draft passes with Motion Brush.' },
  { model: 'Runway Gen 4', category: 'Cinematic Realism', released: '2025-06', native: '720p / 1080p', sweet: '1080p @ 10s', max: '4K (Upscaled)', dur: '10s', fl2v: 'yes', audio: 'no', notes: 'Runway commercial diffusion stack', strengths: 'Cinematic lighting, camera control sliders, high aesthetic polish, character/world consistency', weaknesses: 'No native audio synthesis, fixed 5s/10s duration tiers', tips: 'Pair with Motion Brush for targeted element movement; use last-frame extraction bridge for multi-scene extensions.' },
  { model: 'Runway Gen 4 Turbo', category: 'Cinematic Realism', released: '2025-07', native: '720p / 1080p', sweet: '1080p @ 5s', max: '1080p', dur: '10s', fl2v: 'yes', audio: 'no', notes: 'Faster inference variant of Gen 4 (~3x faster)', strengths: 'Fast generation turnaround, crisp 1080p rendering', weaknesses: 'No native audio, slightly higher compression on background details', tips: 'Keep prompts concise (<50 words); ideal workhorse for volume B-roll production.' },
  { model: 'Runway Gen-4 Act Two', category: 'Avatar / Lip-Sync', released: '2026-01', native: '1080p', sweet: '1080p portrait performance transfer', max: '1080p', dur: '10s', fl2v: 'yes', audio: 'yes', notes: 'Character performance & lip-sync engine', strengths: '3D facial mesh deformation, facial micro-expression capture, speech alignment from driving video', weaknesses: 'Body remains static below chest/shoulders; extreme profile stills cause warping', tips: 'Provide clean front-facing target portrait still + driving performance video.' },
  { model: 'Sora 2 Pro', category: 'Cinematic Realism', released: '2025-09', native: '1080p', sweet: '1080p @ 25s', max: '1080p', dur: '25s', fl2v: 'yes', audio: 'yes', notes: 'OpenAI Sora 2 production model', strengths: '3D Spacetime Physics Morphing, multi-agent physical simulation, object permanence, spatial audio', weaknesses: 'Micro-particle physics collapse (glass shattering can turn gummy); camera rotation crumpling', tips: 'Use material science descriptors (viscous oil fluidity, 100% reflection matte-black titanium) and locked camera vectors.' },
  { model: 'Sora 2 Max', category: 'Cinematic Realism', released: '2025-10', native: '1080p / 4K', sweet: '1080p/4K @ 30s', max: '4K', dur: '30s', fl2v: 'yes', audio: 'yes', notes: 'OpenAI Sora 2 flagship render tier', strengths: 'Maximum spatial detail, fluid multi-subject physical collisions, 30s takes', weaknesses: 'High generation cost and latency; multi-person hand interactions suffer digit fusion', tips: 'Use for hero shots requiring complex multi-subject physics collisions; specify exact lens settings (50mm prime, f/2.0).' },
  { model: 'Hunyuan Video', category: 'Open / Self-Host', released: '2024-12', native: '720p / 1080p', sweet: '720p 121f (~5s @24fps) or 1080p', max: '4K (v2.0)', dur: '5-10s', fl2v: 'yes', audio: 'no', notes: 'Tencent 3D Causal VAE open-source transformer', strengths: 'High spatial fidelity, dual-stream attention (independent text & visual tokens), native 4K (v2.0)', weaknesses: 'Long text prompts can cause text-encoder timeout; heavy compute overhead on 4K', tips: 'Set target frame count to exactly 121 frames (5s @ 24/30fps); separate visual descriptors from camera commands.' },
  { model: 'LTX 2.3 Pro', category: 'Precision / Control', released: '2026-03', native: '1080p', sweet: '1080p 20s with audio', max: '4K via 2-stage upscale', dur: '20s', fl2v: 'yes', audio: 'yes', notes: 'Production-grade, audio sync', strengths: 'High bitrate 1080p/4K, native audio sync, 20s clip length', weaknesses: 'Requires 2-stage latent upscaling for native 4K', tips: 'Use LTX-2 Pro for high-bitrate hero renders; use 1080p 20s for music videos.' },
  { model: 'LTX 2 Fast', category: 'Precision / Control', released: '2026-01', native: '720p / 1080p', sweet: '1080p @24fps fast API', max: '4K @ 50fps', dur: '20s', fl2v: 'yes', audio: 'yes', notes: 'Optimized for speed', strengths: 'Fast inference, ranked high on Artificial Analysis Video Arena', weaknesses: 'Slightly lower textural sharpness than Pro tier', tips: 'Use LTX-2 Fast for low-latency draft iterations before submitting Pro hero renders.' },
  { model: 'PixVerse V6', category: 'Precision / Control', released: '2026-03', native: '1080p', sweet: '1080p 15s with virtual camera controls', max: '1080p', dur: '15s', fl2v: 'yes', audio: 'yes', notes: 'Relaxed duration limits & 20+ lens controls', strengths: 'Granular lens controls (85mm portrait lens, aperture, focal length), 15s duration', weaknesses: 'Steeper learning curve for camera parameter tuning', tips: 'Specify explicit lens parameters (85mm portrait lens, f/1.8 aperture, shallow depth of field) in prompt.' },
  { model: 'PixVerse V5.6', category: 'Stylized', released: '2025-11', native: '1080p', sweet: '1080p @ 10s', max: '1080p', dur: '10s', fl2v: 'yes', audio: 'yes', notes: 'Anime & 3D stylized character animation', strengths: 'Vibrant motion, motion brush trajectories, anime/cyberpunk aesthetic', weaknesses: 'Waxy skin textures on photorealistic close-ups', tips: 'Draw explicit Motion Brush trajectories over target zone; use bracketed audio tags [sound of explosion].' },
  { model: 'PixVerse V5', category: 'Stylized', released: '2025-08', native: '1080p', sweet: '1080p @ 8s', max: '1080p', dur: '8s', fl2v: 'yes', audio: 'no', notes: 'Dynamic stylized animation engine', strengths: 'High motion responsiveness, vibrant visual styles', weaknesses: 'No native audio', tips: 'Keep prompts focused on visual style and atmosphere.' },
  { model: 'PixVerse V4.5', category: 'Stylized', released: '2025-04', native: '1080p', sweet: '1080p @ 8s anime', max: '1080p', dur: '8s', fl2v: 'yes', audio: 'no', notes: 'Keyframe transition stability for anime', strengths: 'Fluid motion for 2D/3D illustrative artwork', weaknesses: 'Causes limb clipping in complex multi-subject scenes', tips: 'Keep camera movement prompts gentle.' },
  { model: 'PixVerse V4', category: 'Stylized', released: '2024-12', native: '1080p', sweet: '1080p @ 8s', max: '1080p', dur: '8s', fl2v: 'yes', audio: 'no', notes: '5s usually locked for 1080p', strengths: 'Early motion brush controls, vector graphics rendering', weaknesses: 'Prone to static human facial expressions', tips: 'Restrict prompts to single subjects.' },
  { model: 'Mochi 1', category: 'Open / Self-Host', released: '2024-10', native: '480p (848x480 native)', sweet: '480p @ 30fps (163f)', max: '848x480 (Native)', dur: '5.4s', fl2v: 'no', audio: 'no', notes: 'Genmo open-source Asymmetric Diffusion Transformer (AsymDiT)', strengths: 'Extreme organic motion fluidity, zero visual tearing during fast moves, fluid splash & cloth physics', weaknesses: 'Hard-locked to 848x480 native resolution (do NOT override; upscale externally)', tips: 'Pipe raw 848x480 output into spatial upscalers for 1080p; use hyper-kinetic force prompt terms (swirling vortex, fluid splash).' },
  { model: 'Pyramid Flow', category: 'Open / Self-Host', released: '2024-10', native: '768p', sweet: '768p @ 24fps', max: '768p', dur: '10s', fl2v: 'yes', audio: 'no', notes: 'Pyramidal flow matching multi-resolution sampling', strengths: 'Efficient multi-scale sampling, open weights, 10s duration', weaknesses: 'Autoregressive spatial drift past 10s', tips: 'Configure lower step counts on initial coarse stages to establish motion blocking before spatial refinement.' },
  { model: 'ToonCrafter', category: 'Edit / Extend', released: '2024-05', native: '512x320', sweet: '512x320 @ 16f', max: '512x320', dur: '2s (16 frames max)', fl2v: 'yes', audio: 'no', notes: 'Generative 2D cartoon keyframe interpolation', strengths: 'Zero line art jitter in 2D animation, true generative line deconstruction/reconstruction between cartoon keyframes', weaknesses: 'Completely non-functional on photorealistic live-action footage; capped at 16 frames', tips: 'Input strictly 2D cartoon/anime keyframes; match color fills and vector outlines across both stills.' },
  { model: 'Play (Open MMLab)', category: 'Stylized', released: '2024-04', native: '512p', sweet: '512p', max: '512p', dur: '4s', fl2v: 'no', audio: 'no', notes: 'Likely referring to PIA / MMagic toolboxes', strengths: 'Perception-Guided Image Animation research baseline', weaknesses: 'Low resolution, complex setup', tips: 'Use for research experimentation with custom motion control pipelines.' },
  { model: 'FLUX 3 Video (Black Forest Labs · T2V + multi-frame I2V + continuation)', category: 'Unified multimodal frontier (Self-Flow: image, video and audio learned simultaneously so each constrains the others; FLUX-mimic robotics offshoot; not a bolt-on video head)', released: '2026-07 (announced July 23, 2026; Video + Action gated Early Access immediately; image side "coming weeks", open-weight Dev later 2026; public playground free trial until Aug 17)', native: 'BFL never published exact training res; all early evaluations run at 720p; API catalog flux_3_video (5-20s, 720p/1080p, the only entry with native 2:1 ratio); wrapper docs expose 480p / 720p / 1080p; joint image+video+audio train, not upscaled image', sweet: '720p Draft mode = cheap coherence lab: $0.06/s draft vs $0.29/s full (other routes 6 credits/s vs 17/s full, roughly 1:3; another breakdown $0.17/s draft, $0.43/s normal); physics holds best at 5-10s, 720p, single subject, slow/medium motion — fast combat still breaks; iterate in draft then enhance one keeper (drafts only save money when you iterate); 15-20s or 1080p first try burns money for drift', max: '20s single generation with native audio; max 1080p, no 4K', dur: '10s 720p T2V with audio was BFL benchmark; API wrappers default 4-10s; street take 5-8s testing, 10s delivery; 20s works for a full ad beat but compositional drift after ~12s unless locked with keyframes', fl2v: 'yes', audio: 'yes', notes: 'Same weights as the unified frontier model announced July 23, 2026 (one architecture: image, video, native synchronized audio); API flux_3_video 5-20s 720p/1080p, only native 2:1 entry', strengths: 'Human faces / skin sharper than FLUX.2 paid tools, natural micro-motion; lip-sync winner (Seedance visuals realistic but voice not nice, Omni Flash great lip-sync but plasticky and AI-sounding, Flux 3 super realistic — audio "sounds like she is in the room", multilingual dialogue + lip-sync legit good); "weird believable" retro TV footage, awkward interviews, fake docs; typography / product consistency locked better than Veo; chainable into minutes via agentic chaining with reference images', weaknesses: 'Smoked by Seedance 2.5 on motion ("seedance competitor, maybe seedance 2, fails so much vs 2.5"; carousel: Seedance outperformed across dialogue, product commercials, transitions; monster clip side-by-side darker, softer, less detailed); more expensive, restrictive censorship, less organic human physique rendering, limited reference-to-video support; needs prompt-constraint enforcement vs unwanted motion, inconsistencies, drift — fast action, crowds, hands drift past 12-15s; BFL 93% vs Luma / 77% vs Runway are "preliminary evaluation of an early FLUX 3 candidate", vs Seedance 2.0 and Omni Flash 52% = coin flip; no open weights yet, gated access (ComfyUI crowd locked out)', tips: 'Iterate in 720p Draft 5-10s single-subject slow/medium, then enhance one keeper; lock 12s+ compositions with keyframes (flux-3-flf-draft start_image_url + end_image_url, flux-3-keyframes-draft, or images_list T2V+I2V); enforce prompt constraints to cut unwanted motion/drift; reference images can serve as opening frames — no external audio input (generate_audio outputs dialogue, SFX, music matched to visuals only); FLF transitions are not physics-locked (blurry failed cut where Seedance delivered clean).' }
];

/* ── Generic sortable-table helpers (Video + Image models) ── */
function sortRows(rows, sort, valueFn, tieFn) {
  const { key, dir } = sort;
  return [...rows].sort((a, b) => {
    const va = valueFn(a, key);
    const vb = valueFn(b, key);
    if (!va && vb) return 1;   // empties always last
    if (va && !vb) return -1;
    if (!va && !vb) return 0;
    const cmp = va.localeCompare(vb, undefined, { numeric: true, sensitivity: 'base' });
    if (cmp !== 0 || !tieFn) return cmp * dir;
    return tieFn(a, b);        // tiebreak always ascending
  });
}

function sortHeaders(cols, sort, tableType) {
  return cols.map((c) => {
    const visible = isColVisible(tableType, c.key);
    const checked = visible ? 'checked' : '';
    return `<th data-sort="${c.key}" class="sortable${sort.key === c.key ? ' sorted' : ''}${c.cls ? ' ' + c.cls : ''}${visible ? '' : ' ref-col-collapsed'}" data-col-key="${c.key}">
      <div class="ref-col-head">
        <span class="ref-col-top">
          <label class="ref-col-toggle" title="Toggle column">
            <input type="checkbox" ${checked} data-table="${tableType}" data-col="${c.key}">
          </label>
          <span class="ref-sort-arrow${sort.key === c.key ? '' : ' dim'}">${sort.key === c.key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ' ⇅'}</span>
        </span>
        <span class="ref-col-label" title="${esc(c.label)}">${esc(c.label)}</span>
      </div>
    </th>`;
  }).join('');
}

function paintSortableTable(table, cfg) {
  const tbody = table.querySelector('tbody');
  if (tbody) tbody.innerHTML = sortRows(cfg.rows, cfg.sort, cfg.valueFn, cfg.tieFn).map(cfg.rowFn).join('');
  const tableType = cfg.tableType || table.getAttribute('data-mtable');
  table.querySelectorAll('th[data-sort]').forEach((th) => {
    const active = th.getAttribute('data-sort') === cfg.sort.key;
    th.classList.toggle('sorted', active);
    const arrow = th.querySelector('.ref-sort-arrow');
    if (arrow) {
      arrow.textContent = active ? (cfg.sort.dir === 1 ? ' ▲' : ' ▼') : ' ⇅';
      arrow.classList.toggle('dim', !active);
    }
    // Column visibility — collapsed columns shrink to a checkbox strip, never vanish
    const colKey = th.getAttribute('data-col-key');
    const visible = isColVisible(tableType, colKey);
    th.classList.toggle('ref-col-collapsed', !visible);
    const checkbox = th.querySelector('input[type="checkbox"]');
    if (checkbox) checkbox.checked = visible;
  });
  // Hide/show td cells by index
  const cols = Array.from(table.querySelectorAll('th[data-sort]')).map(th => th.getAttribute('data-col-key'));
  const rows = table.querySelectorAll('tbody tr');
  rows.forEach(row => {
    const cells = row.querySelectorAll('td');
    cols.forEach((key, idx) => {
      if (cells[idx]) cells[idx].classList.toggle('ref-col-collapsed-cell', !isColVisible(tableType, key));
    });
  });
}

function bindSortableTables() {
  const table = elements.actionPanel.querySelector('.ref-models-table');
  if (table) {
    const cfg = table.getAttribute('data-mtable') === 'image' ? imageTableCfg()
      : table.getAttribute('data-mtable') === 'code' ? codeTableCfg()
      : videoTableCfg();
    table.querySelectorAll('th[data-sort]').forEach((th) => {
      th.addEventListener('click', (e) => {
        if (e.target.closest('.ref-col-toggle')) return; // don't sort when clicking checkbox
        const key = th.getAttribute('data-sort');
        if (cfg.sort.key === key) {
          cfg.sort.dir *= -1;
        } else {
          cfg.sort.key = key;
          cfg.sort.dir = 1;
        }
        paintSortableTable(table, cfg);
      });
    });
    // Column toggle checkboxes
    table.querySelectorAll('th[data-sort] input[type="checkbox"]').forEach((cb) => {
      cb.addEventListener('change', (e) => {
        const tableType = e.target.getAttribute('data-table');
        const colKey = e.target.getAttribute('data-col');
        setColVisible(tableType, colKey, e.target.checked);
        paintSortableTable(table, cfg);
      });
    });
  }
  // Plain sortable YT tables (License / Watermarks) — every header sorts, no toggles
  elements.actionPanel.querySelectorAll('table[data-ytable]').forEach((yt) => {
    yt.querySelectorAll('th[data-sort]').forEach((th) => {
      th.addEventListener('click', () => {
        const cfg = ytTableCfg(yt.getAttribute('data-ytable'));
        const key = th.getAttribute('data-sort');
        if (cfg.sort.key === key) {
          cfg.sort.dir *= -1;
        } else {
          cfg.sort.key = key;
          cfg.sort.dir = 1;
        }
        paintYtTable(yt, cfg);
      });
    });
  });
}

/* Sort state — defaults: Video = Model A→Z, Image = Company A→Z, Code = Model A→Z */
let modelsSort = { key: 'model', dir: 1 };
let imageModelsSort = { key: 'company', dir: 1 };
let codeModelsSort = { key: 'model', dir: 1 };

/* Column visibility state — per table type, keyed by column key */
function loadColVisibility() {
  try {
    return JSON.parse(localStorage.getItem('refs-col-vis') || '{}');
  } catch { return {}; }
}
function saveColVisibility(vis) {
  localStorage.setItem('refs-col-vis', JSON.stringify(vis));
}
let colVisibility = loadColVisibility();

function isColVisible(tableType, key) {
  const t = colVisibility[tableType];
  if (!t) return true;
  return t[key] !== false;
}
function setColVisible(tableType, key, visible) {
  if (!colVisibility[tableType]) colVisibility[tableType] = {};
  colVisibility[tableType][key] = visible;
  saveColVisibility(colVisibility);
}

const MODELS_COLS = [
  { key: 'model', label: 'Model' },
  { key: 'category', label: 'Category' },
  { key: 'released', label: 'Released' },
  { key: 'native', label: 'Native Training Res' },
  { key: 'sweet', label: 'Sweet Spot for Physics / Coherence — Cheap' },
  { key: 'max', label: 'Max Output' },
  { key: 'dur', label: 'Duration Sweet Spot' },
  { key: 'fl2v', label: 'True FL2V', cls: 'ref-col-center' },
  { key: 'audio', label: 'Audio', cls: 'ref-col-center' },
  { key: 'strengths', label: 'Strengths' },
  { key: 'weaknesses', label: 'Weaknesses' },
  { key: 'tips', label: 'Use / Prompt Tips' },
  { key: 'notes', label: 'Notes' },
];

function modelsSortValue(r, key) {
  if (key === 'sweet') return [r.sweet, r.warn || ''].filter((v) => v && v !== '—').join(' — ');
  if (key === 'fl2v' || key === 'audio') return { yes: '0', '?': '1', no: '2' }[r[key]] || '1';
  const v = r[key] || '';
  return v === '—' ? '' : v;
}

function videoTableCfg() {
  return { rows: MODELS_ROWS, sort: modelsSort, valueFn: modelsSortValue, tieFn: null, rowFn: modelRow, tableType: 'video' };
}

function buildModelsSection() {
  return `
    <div class="ref-card">
      <div class="ref-card-head">
        <div class="ref-card-head-icon">${SVG_FILM}</div>
        <h2>Video Models<span class="ref-sub">The Big Chart — native res, cheap physics sweet spot, max output</span></h2>
      </div>
      <div class="ref-card-body ref-table-scroll">
        <table class="ref-table ref-models-table" data-mtable="video">
          <thead><tr>
            ${sortHeaders(MODELS_COLS, modelsSort, 'video')}
          </tr></thead>
          <tbody>
            ${sortRows(MODELS_ROWS, modelsSort, modelsSortValue, null).map(modelRow).join('')}
          </tbody>
        </table>
        <div class="ref-legend">
          <span class="ref-status"><span class="ref-badge ref-badge-green">${SVG_CHECK} Yes</span> True FL2V (start + end frame) / Audio (native audio out)</span>
          <span class="ref-status"><span class="ref-badge ref-badge-gray">${SVG_X} No</span> Start-frame / T2V only / silent</span>
          <span class="ref-status"><span class="ref-badge ref-badge-amber">${SVG_WARN} ?</span> Unconfirmed — tell me and I'll fix it</span>
        </div>
      </div>
    </div>`;
}

function fl2vBadge(v) {
  if (v === 'yes') return `<span class="ref-badge ref-badge-green">${SVG_CHECK} Yes</span>`;
  if (v === 'no')  return `<span class="ref-badge ref-badge-gray">${SVG_X} No</span>`;
  return `<span class="ref-badge ref-badge-amber">${SVG_WARN} ?</span>`;
}

function modelRow(r) {
  const sweet = r.warn
    ? `<span class="ref-lic-name">${esc(r.sweet)}</span><div class="ref-warn"><span class="ref-badge ref-badge-amber">${SVG_WARN} ${esc(r.warn)}</span></div>`
    : `<span class="ref-cell">${esc(r.sweet)}</span>`;
  const notes = r.notes
    ? (r.highlight
      ? `<span class="ref-badge ref-badge-green">${SVG_CHECK} ${esc(r.notes)}</span>`
      : `<span class="ref-cell">${esc(r.notes)}</span>`)
    : '<span class="ref-muted">—</span>';
  const strengths = r.strengths ? `<span class="ref-cell">${esc(r.strengths)}</span>` : '<span class="ref-muted">—</span>';
  const weaknesses = r.weaknesses ? `<span class="ref-cell">${esc(r.weaknesses)}</span>` : '<span class="ref-muted">—</span>';
  const category = r.category ? `<span class="ref-cell">${esc(r.category)}</span>` : '<span class="ref-muted">—</span>';
  const released = r.released ? `<span class="ref-cell">${esc(r.released)}</span>` : '<span class="ref-muted">—</span>';
  const tips = r.tips ? `<span class="ref-cell">${esc(r.tips)}</span>` : '<span class="ref-muted">—</span>';
  return `<tr${r.highlight ? ' class="ref-highlight"' : ''}>
    <td><span class="ref-lic-name">${esc(r.model)}</span></td>
    <td>${category}</td>
    <td>${released}</td>
    <td><span class="ref-cell">${esc(r.native)}</span></td>
    <td>${sweet}</td>
    <td><span class="ref-cell">${esc(r.max)}</span></td>
    <td><span class="ref-cell">${esc(r.dur)}</span></td>
    <td class="ref-col-center">${fl2vBadge(r.fl2v)}</td>
    <td class="ref-col-center">${fl2vBadge(r.audio)}</td>
    <td>${strengths}</td>
    <td>${weaknesses}</td>
    <td>${tips}</td>
    <td>${notes}</td>
  </tr>`;
}

/* ═══════════════════════════════════════════════
   Image Models — same card/table treatment, 6 cols
   ═══════════════════════════════════════════════ */
const IMAGE_MODELS_ROWS = [
  { company: 'ALIBABA', model: 'Wan Image', native: '1024', optimal: '1024x1024', buckets: '1:1, 16:9, 9:16', notes: "Wan's image version, same as video but single frame" },
  { company: 'ALIBABA', model: 'Qwen, Qwen 2, Qwen 3', native: '1328p dynamic 256p→1328p during training', optimal: '1328x1328 - base_resolution 1328 for Qwen family', buckets: '1328x1328, 1440x810, etc', notes: 'New high-res native, likes bigger than Flux' },
  { company: 'ALIBABA TONGYI', model: 'ZImage', native: '1024 - Flux / Z-Image: 1024', optimal: '1024x1024 - 1536x1536', buckets: '1024x1024', notes: 'Lumina 2 architecture' },
  { company: 'BAIDU', model: 'Ernie / Ernie Image', native: '1024', optimal: '1024x1024', buckets: '1:1, 3:4', notes: "Baidu's Flux competitor" },
  { company: 'BFL', model: 'Flux.1, Flux.1 Dev', native: '1024x1024 - As Flux is a 1024px model, Training resolution: 1024x1024', optimal: '1024x1024 portrait, 1360x768 widescreen', buckets: '1024x1024, 1280x768, 2048x2048 fine-tuned buckets', notes: 'Sweet spot 1MP total' },
  { company: 'BFL', model: 'Flux.1 Krea, Kontext', native: '1024', optimal: '1024x1024 - 1536x1536', buckets: 'Same as Flux.1', notes: 'Krea = more aesthetic, Kontext = edit version' },
  { company: 'BFL', model: 'Flux.2, Flux.2 Klein', native: '1024-2048', optimal: '1024 to 2048x2048 - Up to 4MP native (2000x2000)', buckets: 'Up to 2048x2048 max', notes: 'First true 2K native image model' },
  { company: 'BOOGU', model: 'Boogu', native: '1024', optimal: '1024x1024', buckets: '1:1, 9:16', notes: 'Indie SDXL fork' },
  { company: 'BYTEDANCE', model: 'Seedream 3.0 / 4.0', native: '1024-2048', optimal: '1024x1024 for draft, 2048x2048 for final', buckets: '1:1, 16:9, 4:3', notes: "Bytedance's image flagship, multi-aspect native" },
  { company: 'GOOGLE', model: 'Imagen 4', native: '1024 / 2048', optimal: '1024x1024 / 2048x2048 (1:1), 1408x768 / 2816x1536 (16:9)', buckets: '1024x1024, 2048x2048, 2816x1536', notes: 'Output supports up to 2048x2048' },
  { company: 'GOOGLE', model: 'Nano Banana', native: '1024', optimal: '1024x1024', buckets: 'Auto', notes: 'Gemini 2.0 Flash Image internal name' },
  { company: 'HIDREAM', model: 'HiDream, HiDream-O1', native: '1024-1328', optimal: '1024x1024, 1366x768', buckets: '1MP area', notes: 'SD3.5-based, very close to Flux' },
  { company: 'KREA AI', model: 'Krea 2', native: '1328', optimal: '1328x1328', buckets: '1328x1328', notes: 'Same family as Qwen, likes 1328' },
  { company: 'META', model: 'Muse Image', native: '1024', optimal: '1024x1024', buckets: '1:1', notes: "Meta's internal SDXL replacement" },
  { company: 'MICROSOFT', model: 'MAI, Mage Flow', native: '1024', optimal: '1024x1024', buckets: '1:1', notes: "Microsoft's Flux finetunes" },
  { company: 'OPENAI', model: 'OpenAI / GPT Image 1', native: '1024-2048', optimal: '1024x1024, 1536x1024, 1024x1536', buckets: 'Auto buckets', notes: 'Native 1K-2K, no fixed bucket' },
  { company: 'PONY DIFFUSION', model: 'Pony Diffusion V6 XL, V7', native: '1024px optimized - Resolution: 1024x1024', optimal: '832x1216, 1024x1024, 1216x832 - Standard Pony resolutions', buckets: '768x1344 ~ 1344x768', notes: 'Keep total ∼1MP' },
  { company: 'REVE AI', model: 'Reve', native: '1024', optimal: '1024x1024', buckets: '1:1, 16:9', notes: 'Aesthetic SDXL' },
  { company: 'SDXL COMMUNITY', model: 'Illustrious', native: '1024x1024 native - supports 512 to 1536', optimal: '1024x1024 - 1536x1536', buckets: '768x1344, 832x1216, 1024x1024, 1152x896, 1216x832, 1344x768', notes: 'SDXL community king' },
  { company: 'SDXL COMMUNITY', model: 'NoobAI XL', native: '1024x1024 - Total area around 1024x1024, Native 1024x1024 supports 768-1536', optimal: '832x1216 is best per author', buckets: 'Same 7 buckets as Illustrious', notes: 'Finetune of Illustrious, Danbooru tags' },
  { company: 'STABILITY', model: 'Stable Diffusion 1.x', native: '512x512', optimal: '512x512, 768x512', buckets: '512x512', notes: 'Ancient, avoid upscaling' },
  { company: 'STABILITY', model: 'Stable Diffusion XL', native: '1024x1024 - trained for 40k steps at 1024x1024, set to 1024 by default for best results', optimal: '1024x1024', buckets: '1024x1024, 1152x896, 1344x768', notes: '' },
  { company: 'XAI', model: 'Grok Image', native: '1024', optimal: '1024x1024', buckets: 'Auto', notes: 'Flux-based' },
  { company: 'OTHER', model: 'Anima, Chroma, Lens', native: '1920 - base_resolution 1920', optimal: '1920x1080 - 1920x1920', buckets: '1920px native', notes: 'Cosmos/Anima family, true 1080p+ native' },
  { company: 'BLACK FOREST LABS', model: 'Flux 3', native: '4MP', optimal: '4MP', buckets: '-', notes: 'Multimodal successor' },
  { company: 'BLACK FOREST LABS', model: 'Flux 2 Klein', native: '4MP', optimal: '4MP', buckets: '-', notes: 'Optimized for speed' },
  { company: 'BLACK FOREST LABS', model: 'Flux Schnell', native: '1024x1024', optimal: '1024x1024', buckets: '0.1-2.0MP', notes: 'Keep divisible by 64' },
  { company: 'BLACK FOREST LABS', model: 'Flux 2 Flex', native: '1024x1024', optimal: '4MP', buckets: '-', notes: 'High precision, adjustable steps' },
  { company: 'BLACK FOREST LABS', model: 'Flux 2 Max', native: '4MP', optimal: '4MP', buckets: '-', notes: 'Flagship, highest fidelity' },
  { company: 'BLACK FOREST LABS', model: 'Flux 2 Pro', native: '4MP', optimal: '4MP', buckets: 'Divisible by 64', notes: 'High-fidelity, professional-grade output up to 4MP natively.' },
  { company: 'BLACK FOREST LABS', model: 'Flux Kontext Pro', native: 'Preset-based (e.g., 1024x1024 for 1:1)', optimal: '1024x1024 (1:1) / 1184x880 (16:9)', buckets: 'Pre-defined aspect ratios', notes: 'Instruction-based editing model; defaults to specific preset sizes.' },
  { company: 'RECRAFT', model: 'Recraft V4.1', native: '2048x2048', optimal: '2048x2048', buckets: 'Various aspect ratios', notes: 'Pro variant for print-ready assets and large-format displays.' },
  { company: 'RECRAFT', model: 'Recraft V4', native: '2048x2048 (Pro) / 1024x1024 (Standard)', optimal: '2048x2048', buckets: 'Various aspect ratios', notes: 'Pro versions offer native 2K resolution for professional workflows.' },
  { company: 'RECRAFT', model: 'Recraft V3', native: '1024x1024', optimal: '1024x1024', buckets: 'Various aspect ratios', notes: 'Native 1024x1024; supports AI upscaling up to 4096x4096.' },
  { company: 'RECRAFT', model: 'Recraft Vectorize', native: '-', optimal: '-', buckets: '-', notes: 'Converts raster images to true infinitely scalable vectors (SVG).' },
  { company: 'IDEOGRAM', model: 'Ideogram V4', native: '2048x2048', optimal: '2048x2048', buckets: '256 to 2048px in 16px increments', notes: 'Native 2K resolution; supports flexible aspect ratios up to 6:1.' },
  { company: 'IDEOGRAM', model: 'Ideogram V3', native: '1024x1024', optimal: '1024x1024', buckets: 'Presets (1:1, 16:9, etc.)', notes: 'Optimized for standard resolutions; rely on upscaling for higher fidelity.' },
  { company: 'IDEOGRAM', model: 'Ideogram V2A', native: '1024x1024', optimal: '1024x1024', buckets: 'Presets', notes: 'Similar architecture and handling to V2.' },
  { company: 'IDEOGRAM', model: 'Ideogram V2', native: '1024x1024', optimal: '1024x1024', buckets: 'Preset ratios', notes: 'Define dimensions early; use built-in upscale for high resolution.' },
  { company: 'STABILITY AI', model: 'Stable Diffusion 3.5 Medium', native: '1024x1024', optimal: '1024x1024', buckets: 'Divisible by 64 (~1MP)', notes: 'Trained across progressive resolutions; 1024px is the sweet spot.' },
  { company: 'STABILITY AI', model: 'Stable Diffusion 3.5 Large', native: '1024x1024', optimal: '1024x1024', buckets: 'Divisible by 64 (~1MP)', notes: 'Similar bucketing and resolution capabilities as Medium.' },
  { company: 'STABILITY AI', model: 'Stable Diffusion 3.5 Large Turbo', native: '1024x1024', optimal: '1024x1024', buckets: 'Divisible by 64 (~1MP)', notes: 'Optimized for fewer steps while maintaining 1024x1024 base.' },
  { company: 'PLAYGROUND', model: 'Playground V2.5', native: '1024x1024', optimal: '1024x1024', buckets: 'Flexible aspect ratios', notes: 'Maintains high aesthetic quality across various aspect ratios.' },
  { company: 'SDXL COMMUNITY', model: 'RealVisXL V3', native: '1024x1024', optimal: '1024x1024', buckets: 'SDXL standard (~1MP)', notes: 'Based on SDXL; generate at native 1024x1024 and upscale later.' },
  { company: 'SDXL COMMUNITY', model: 'DreamShaper XL', native: '1024x1024', optimal: '1024x1024', buckets: 'SDXL standard (~1MP)', notes: 'Keep generations near 1024 base resolution for optimal quality.' },
  { company: 'ALIBABA', model: 'Qwen Image 2 Pro', native: '2048x2048', optimal: '2048x2048', buckets: 'Various aspect ratios', notes: 'Native 2K; optimized for professional typography and photorealism.' },
  { company: 'ALIBABA', model: 'Qwen Image 2.5', native: 'Variable (e.g., 1328x1328, 1664x928)', optimal: 'Variable', buckets: 'Native aspect ratios', notes: 'Enhanced realism; resolutions vary based on chosen aspect ratio.' },
  { company: 'BYTEDANCE', model: 'Seedream 5 Pro', native: '2K', optimal: '2K', buckets: '-', notes: 'Standard high-detail output up to 2K natively.' },
  { company: 'BYTEDANCE', model: 'Seedream 5 Lite', native: '3K (up to 3072px)', optimal: '3K', buckets: '-', notes: 'Supports higher native resolution outputs than the Pro variant.' },
  { company: 'BYTEDANCE', model: 'Seedream 4.5', native: '4096x4096', optimal: '4096x4096', buckets: '-', notes: 'Native 4K output; depending on platform, up to 4704x4704.' },
  { company: 'BYTEDANCE', model: 'Seedream 4', native: '4096x4096', optimal: '4096x4096', buckets: '-', notes: 'Pioneered native 4K standard without external upscaling tax.' },
];

const IMAGE_MODELS_COLS = [
  { key: 'company', label: 'Company' },
  { key: 'model', label: 'Model' },
  { key: 'native', label: 'Native Training Res' },
  { key: 'optimal', label: 'Optimal Gen Res - Best Quality' },
  { key: 'buckets', label: 'Buckets That Work' },
  { key: 'notes', label: 'Notes' },
];

function imageModelsSortValue(r, key) {
  const v = r[key] || '';
  return v === '—' ? '' : v;
}

function imageTableCfg() {
  return {
    rows: IMAGE_MODELS_ROWS,
    sort: imageModelsSort,
    valueFn: imageModelsSortValue,
    tieFn: (a, b) => String(a.model || '').localeCompare(String(b.model || ''), undefined, { numeric: true, sensitivity: 'base' }),
    rowFn: imageModelRow,
    tableType: 'image',
  };
}

function buildImageModelsSection() {
  return `
    <div class="ref-card">
      <div class="ref-card-head">
        <div class="ref-card-head-icon">${SVG_EYE}</div>
        <h2>Image Models<span class="ref-sub">Native res, best-quality gen res, working buckets</span></h2>
      </div>
      <div class="ref-card-body ref-table-scroll">
        <table class="ref-table ref-models-table" data-mtable="image">
          <thead><tr>
            ${sortHeaders(IMAGE_MODELS_COLS, imageModelsSort, 'image')}
          </tr></thead>
          <tbody>
            ${sortRows(IMAGE_MODELS_ROWS, imageModelsSort, imageModelsSortValue, imageTableCfg().tieFn).map(imageModelRow).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

function imageModelRow(r) {
  const notes = r.notes ? `<span class="ref-cell">${esc(r.notes)}</span>` : '<span class="ref-muted">—</span>';
  return `<tr>
    <td><span class="ref-lic-name">${esc(r.company)}</span></td>
    <td><span class="ref-lic-name">${esc(r.model)}</span></td>
    <td><span class="ref-cell">${esc(r.native)}</span></td>
    <td><span class="ref-cell">${esc(r.optimal)}</span></td>
    <td><span class="ref-cell">${esc(r.buckets)}</span></td>
    <td>${notes}</td>
  </tr>`;
}

/* ═══════════════════════════════════════════════
   Coding / LLM Models — same treatment, 7 cols.
   LLM twist vs Video/Image tables: a sortable `Benchmarks`
   column that quotes the reported number AND its provenance
   (vendor-reported vs independent tracker). Data curated from
   docs/llm_mod_ref.md (Sept 2026 gateway-list verification pass).
   Unconfirmed cells render `—` (sort last) until verified.
   ═══════════════════════════════════════════════ */
const CODE_MODELS_ROWS = [
  { model: 'Kimi K3', provider: 'Moonshot AI', context: '1M', strengths: '2.8T-param MoE, native vision, built for multi-hour repo-scale sessions; largest open-weight model in this set', benchmarks: 'Vendor: ahead of Opus 4.8 & GPT-5.5 on coding/agent tasks (unverified independently)', availability: '+', bestfor: 'Biggest, longest-horizon open coder; custom license w/ revenue share' },
  { model: 'GLM-5.2', provider: 'Zhipu AI', context: '1M', strengths: '753B MoE (~40B active); holds project-scale context well — retains module boundaries across long tasks', benchmarks: 'SWE-bench Pro 62.1 (> GPT-5.5 58.6); Terminal-Bench 2.1: 81.0', availability: '+', bestfor: 'Repo-scale coding agents — strongest open-weight coding benchmarks', highlight: true },
  { model: 'GLM-5.3', provider: 'Zhipu AI', context: '1M', strengths: 'Post-trained upgrade of 5.2 base; leads on CyberGym vulnerability discovery in its comparison set', benchmarks: 'Terminal-Bench 3.0: 28.3 (own scale); mixed vs Opus 4.8 per Zhipu footnotes', availability: '+', bestfor: 'Security-adjacent code review and vuln discovery workflows' },
  { model: 'DeepSeek V4 Pro', provider: 'DeepSeek', context: '1M', strengths: '1.6T-param MoE (49B active); native OpenAI + Anthropic-compatible API, drops into agent harnesses directly', benchmarks: 'Vendor: SOTA open-source claim (not independently confirmed)', availability: '+', bestfor: 'Max open-weight capability where token cost is secondary' },
  { model: 'Kimi K2.6', provider: 'Moonshot AI', context: '256K', strengths: '1T/32B MoE, open-weight, native multimodal; Agent Swarm scales to 300 sub-agents / 4,000 steps', benchmarks: 'SWE-Bench Pro 58.6% (ties GPT-5.5, third-party writeups)', availability: '+', bestfor: 'Swarm-style parallel agent orchestration' },
  { model: 'Kimi K2 Thinking', provider: 'Moonshot AI', context: '256K', strengths: 'Interleaves chain-of-thought with tool calls across 200–300 sequential calls without drift', benchmarks: 'SOTA at release: HLE, BrowseComp, LiveCodeBench', availability: '+', bestfor: 'Long tool-call chains; weaker prose / non-English quality' },
  { model: 'Qwen3.8 27B', provider: 'Alibaba', context: '262K–1M', strengths: 'Efficiency architecture preview for Qwen4; Flash-Next activates ~6B of 125B + 51B N-gram layer', benchmarks: 'Vendor: beats DeepSeek-V4-Flash & Opus 4.6 on coding/office', availability: '+', bestfor: 'Frontier-adjacent quality on small-team compute budgets' },
  { model: 'DeepSeek V4 Flash', provider: 'DeepSeek', context: '1M', strengths: '284B/13B-active MoE, same 1M stack as Pro at ~1/3 price; fast, cheap, chatty', benchmarks: 'Terminal-Bench 2.1: 61.8→82.7 post-training (vendor)', availability: '+', bestfor: 'Budget agentic coding at 1M context' },
  { model: 'Nemotron 3 Ultra', provider: 'NVIDIA', context: '1M', strengths: '550B/55B-active hybrid Mamba-Transformer MoE; fast, controllable open worker for pipelines', benchmarks: 'AA Intelligence Index: 48 (leading US open-weight in snapshot)', availability: '+', bestfor: 'Terminal / review pipelines needing speed over peak reasoning' },
  { model: 'Qwen3.6 Flash', provider: 'Alibaba', context: '1M', strengths: 'Native vision-language Flash tier; fast/cheap with spatial visual understanding', benchmarks: '—', availability: '+', bestfor: 'Fast multimodal drafts, cost-sensitive agent loops' },
  { model: 'MiniMax M3', provider: 'MiniMax', context: '~1M', strengths: 'Open-weight coding + multimodal; the practical pick when you need local deploy / fine-tuning', benchmarks: 'Aggregator-sourced only; no first-party numbers found', availability: '+', bestfor: 'Local / self-hosted coding-agent deployment' },
  { model: 'Inkling', provider: 'Thinking Machines', context: '1M', strengths: '975B/41B-active multimodal MoE; trained in randomized harnesses; self-directed fine-tuning via Tinker', benchmarks: 'AA Intelligence Index: 41 (top US open-weight at release; behind Opus 4.8 at 56)', availability: '+', bestfor: 'Fine-tuning base, not out-of-box frontier performance' },
  { model: 'Ling 3.0 Flash', provider: 'InclusionAI', context: '256K', strengths: '124B/5.1B-active MoE; token-efficient agentic inference from 10K+ interactive training envs', benchmarks: 'Vendor: matches/beats 1T-class Ring-2.6-1T', availability: '+', bestfor: 'High-frequency agent loops; free slot may have rotated — re-check' },
  { model: 'Nemotron 3 Super', provider: 'NVIDIA', context: '1M', strengths: '120B/12B-active hybrid Mamba MoE; context-gathering workhorse ahead of frontier reasoners', benchmarks: 'Production use: CodeRabbit PR-review context stage', availability: '+', bestfor: 'Long-context summarization / retrieval stage in a pipeline' },
  { model: 'Llama 4 Maverick', provider: 'Meta', context: '1M', strengths: '400B/17B-active MoE, natively multimodal; solid 2025 generalist (source “178B” figure was wrong)', benchmarks: 'Vendor (2025): beats GPT-4o / Gemini 2.0; dated vs 2026 field', availability: '+', bestfor: 'Multimodal on a budget; dated vs mid-2026 open field' },
  { model: 'Inkling Small', provider: 'Thinking Machines', context: '~1M', strengths: '12B-active sibling; near-Inkling quality on reasoning/agentic at much lower cost', benchmarks: '—', availability: '+', bestfor: 'Cost-sensitive coding / grading tasks' },
  { model: 'Nemotron 3 Nano', provider: 'NVIDIA', context: '1M', strengths: '4B / 30B-A3B tiers; 4x throughput over Nemotron 2 Nano; fits single consumer GPU at 4-bit', benchmarks: '—', availability: '+', bestfor: 'Lightweight pipeline steps, routing, simple extraction' },
  { model: 'Muse Spark 1.3', provider: 'Meta', context: '1M', strengths: 'Closed-weight agentic orchestrator; plans, delegates across subagents, tools, multimodal inputs', benchmarks: 'Review: competitive w/ Sol & Opus 5 on agentic/coding, ahead of 1.2 (unverified)', availability: '+', bestfor: 'Top overall free pick right now', highlight: true },
  { model: 'Muse Spark 1.2', provider: 'Meta', context: '1M', strengths: 'Same orchestrator line as 1.3, one generation behind; closed weight, no local deploy', benchmarks: 'Superseded by 1.3 per same review', availability: '+', bestfor: 'Use 1.3 instead unless pinned for a reason' },
  { model: 'Mistral Medium', provider: 'Mistral AI', context: '—', strengths: 'Balanced mid-tier flagship; comparison point in 2026 benchmark trackers (3.1 / 3.5 version churn)', benchmarks: '—', availability: '+', bestfor: 'General coding/reasoning at mid price; “Latest” is a routing alias, not a version' },
  { model: 'Mistral Small', provider: 'Mistral AI', context: '—', strengths: 'Small/cheap tier; fast drafts and lightweight agent steps', benchmarks: '—', availability: '+', bestfor: 'Fast drafts, simple pipeline steps' },
  { model: 'MiniMax M2.7', provider: 'MiniMax', context: '—', strengths: 'Predecessor to M3; appears in benchmark comparison tables only, no spec sheet found', benchmarks: 'AA comparison tables only', availability: '+', bestfor: 'Superseded by M3 — pin only for a specific reason' },
  { model: 'Gemma 4 26B / 31B', provider: 'Google', context: '—', strengths: 'Small open-weight baseline; “268/318” source strings read as garbled 26B/31B — unconfirmed', benchmarks: 'Beaten by Nemotron 3 Ultra on AA Index', availability: '+', bestfor: 'Needs first-party spec check before real use' },
  { model: 'gpt-oss 120B / 20B', provider: 'OpenAI', context: '—', strengths: 'Small-open-weight comparison baseline; source “GPT 0SS 1208” likely mangled gpt-oss-120b — verify model ID', benchmarks: 'Baseline in others’ benchmark tables', availability: '+', bestfor: 'Verify the literal model ID before using' },
  { model: 'North Mini Code', provider: '—', context: '—', strengths: 'Real (appears in AA tracker) but no dedicated writeup found — specifics unconfirmed', benchmarks: '—', availability: '+', bestfor: 'Needs direct lookup before use' },
  { model: 'MiMo V2.5', provider: 'Xiaomi', context: '—', strengths: 'Coding agents + real-world automation w/ long-context reasoning, per one aggregator description', benchmarks: '—', availability: '+', bestfor: 'Needs first-party spec check' },
  { model: 'Nemotron 3.5 Lightning', provider: 'NVIDIA', context: '—', strengths: 'Plausible .5 point release in Nemotron 3 line; no first-party page found', benchmarks: '—', availability: '+', bestfor: 'Needs first-party spec check' },
  { model: 'Nemotron 3 Nano Omni', provider: 'NVIDIA', context: '—', strengths: 'Plausible omni-modal small variant; no first-party page found', benchmarks: '—', availability: '+', bestfor: 'Needs first-party spec check' },
  { model: 'Nemotron 3.5 Content Safety', provider: 'NVIDIA', context: '—', strengths: 'Safety-classifier variant, not a coding driver — kept so the name is not re-added as a mystery model', benchmarks: '—', availability: '+', bestfor: 'Safety classification, not code generation' },
];

const CODE_MODELS_COLS = [
  { key: 'model', label: 'Model' },
  { key: 'provider', label: 'Provider' },
  { key: 'context', label: 'Context' },
  { key: 'strengths', label: 'Key Strengths (Coding / Agentic)' },
  { key: 'benchmarks', label: 'Reported Benchmarks' },
  { key: 'availability', label: 'Avail.' },
  { key: 'bestfor', label: 'Notes / Best For' },
];

function codeModelsSortValue(r, key) {
  const v = r[key] || '';
  return v === '—' ? '' : v;
}

function codeTableCfg() {
  return {
    rows: CODE_MODELS_ROWS,
    sort: codeModelsSort,
    valueFn: codeModelsSortValue,
    tieFn: (a, b) => String(a.provider || '').localeCompare(String(b.provider || ''), undefined, { numeric: true, sensitivity: 'base' }),
    rowFn: codeModelRow,
    tableType: 'code',
  };
}

function buildCodeModelsSection() {
  return `
    <div class="ref-card">
      <div class="ref-card-head">
        <div class="ref-card-head-icon">${SVG_UPRIGHT}</div>
        <h2>Coding Models<span class="ref-sub">Verified open-weight comparison for OpenCode / Kilo use — benchmarks quote provenance</span></h2>
      </div>
      <div class="ref-card-body ref-table-scroll">
        <table class="ref-table ref-models-table" data-mtable="code">
          <thead><tr>
            ${sortHeaders(CODE_MODELS_COLS, codeModelsSort, 'code')}
          </tr></thead>
          <tbody>
            ${sortRows(CODE_MODELS_ROWS, codeModelsSort, codeModelsSortValue, codeTableCfg().tieFn).map(codeModelRow).join('')}
          </tbody>
        </table>
        <div class="ref-legend">
          <span class="ref-status"><span class="ref-badge ref-badge-green">${SVG_CHECK} *</span> Free in OpenCode Zen</span>
          <span class="ref-status"><span class="ref-badge ref-badge-amber">${SVG_CHECK} +</span> Free via Kilo Gateway / OpenRouter free router</span>
          <span class="ref-status"><span class="ref-badge ref-badge-gray">${SVG_CHECK} *+</span> Available in both</span>
          <span class="ref-status"><span class="ref-badge ref-badge-amber">${SVG_WARN} Benchmarks</span> Vendor-reported unless tagged AA (Artificial Analysis) / third-party</span>
        </div>
      </div>
    </div>
    <div class="ref-card">
      <div class="ref-card-head">
        <div class="ref-card-head-icon">${SVG_CHECK}</div>
        <h2>Quick Recommendations<span class="ref-sub">Where to start</span></h2>
      </div>
      <div class="ref-card-body">
        <ul class="ref-checklist">
          ${checkItem('green', SVG_CHECK, 'Best overall free right now:', 'Muse Spark 1.3 (+) or Kimi K3 (+) for max open-weight reach')}
          ${checkItem('green', SVG_CHECK, 'Best pure coding agents:', 'GLM-5.2, DeepSeek V4 Pro, or Kimi K2.6')}
          ${checkItem('green', SVG_CHECK, 'Best speed / high-volume:', 'DeepSeek V4 Flash, Qwen3.6 Flash, or Nemotron 3 Nano')}
          ${checkItem('green', SVG_CHECK, 'Best multimodal:', 'Kimi K3, MiniMax M3, Inkling, or Qwen3.6 Flash')}
          ${checkItem('green', SVG_CHECK, 'Best tiny / local:', 'Nemotron 3 Nano, Inkling Small, or gpt-oss-20B')}
        </ul>
        <div class="ref-callout">
          ${SVG_INFO}
          <p>Curated from <strong>docs/llm_mod_ref.md</strong> (Sept 2026 gateway-list verification). Avail. is <strong>+ throughout</strong>: free-tier status was not re-verified per model — check the gateway live list. Benchmark cells say vendor vs AA/third-party. Dropped as unconfirmed: BigPickle, Charm, Dots3-Note, Laguna S/XS, “Latest”, Ling Sante/Fin. Real agent-loop performance can differ from benchmarks — test a couple on your own repo.</p>
        </div>
      </div>
    </div>`;
}

function codeModelRow(r) {
  const bestfor = r.highlight
    ? `<span class="ref-badge ref-badge-green">${SVG_CHECK} ${esc(r.bestfor)}</span>`
    : `<span class="ref-cell">${esc(r.bestfor)}</span>`;
  const benchmarks = r.benchmarks ? `<span class="ref-cell">${esc(r.benchmarks)}</span>` : '<span class="ref-muted">—</span>';
  return `<tr${r.highlight ? ' class="ref-highlight"' : ''}>
    <td><span class="ref-lic-name">${esc(r.model)}</span></td>
    <td><span class="ref-cell">${esc(r.provider)}</span></td>
    <td><span class="ref-cell">${esc(r.context)}</span></td>
    <td><span class="ref-cell">${esc(r.strengths)}</span></td>
    <td>${benchmarks}</td>
    <td class="ref-col-center"><span class="ref-cell">${esc(r.availability)}</span></td>
    <td>${bestfor}</td>
  </tr>`;
}

/* ═══════════════════════════════════════════════
   Plain sortable tables (YT License / Watermarks).
   Horizontal headers, every header click-sorts asc/desc with an arrow.
   Badge columns sort best→worst (Yes→Varies→No, Survives→Degraded→Stripped).
   No column toggles here — these tables are narrow and fully visible.
   ═══════════════════════════════════════════════ */
let licenseSort = { key: 'name', dir: 1 };
let wmSort = { key: 'proc', dir: 1 };

const LICENSE_COLS = [
  { key: 'name', label: 'License', width: '38%' },
  { key: 'c1', label: 'Commercial?', cls: 'ref-col-center', width: '20%' },
  { key: 'c2', label: 'Credit?', cls: 'ref-col-center', width: '18%' },
  { key: 'c3', label: 'For YPP?', cls: 'ref-col-center', width: '24%' },
];
const LICENSE_ROWS = [
  { name: 'CC0 / Public Domain', sub: 'Pexels, Pixabay, Mixkit, NASA, Prelinger, National Archives', c1: 'yes', c2: 'no', c3: 'yes-star' },
  { name: 'CC BY', sub: '', c1: 'yes', c2: 'yes', c3: 'yes-star' },
  { name: 'CC BY-NC / NC-SA', sub: '', c1: 'no', c2: 'yes', c3: 'no' },
  { name: 'Videvo Free / Videezy Free', sub: 'check per clip', c1: 'maybe', c2: 'yes', c3: 'risk' },
  { name: 'Free AI tool with watermark', sub: 'Runway free, Pika free etc', c1: 'tos', c2: 'no', c3: 'no-wm' },
  { name: 'Paid AI / Meta AI clean export', sub: 'full ownership', c1: 'yes', c2: 'no', c3: 'yes', highlight: true },
];

const WM_COLS = [
  { key: 'proc', label: 'Processing', width: '32%' },
  { key: 'm', label: 'Metadata', cls: 'ref-col-center', width: '22%' },
  { key: 'inv', label: 'Invisible', cls: 'ref-col-center', width: '22%' },
  { key: 'vis', label: 'Visible WM', cls: 'ref-col-center', width: '24%' },
];
const WM_ROWS = [
  { proc: 'Square crop', m: 'survives', inv: 'survives', vis: 'degraded' },
  { proc: 'Color grade', m: 'survives', inv: 'degraded', vis: 'survives' },
  { proc: 'Add noise / grain', m: 'survives', inv: 'degraded', vis: 'survives' },
  { proc: 'Re-export / ffmpeg', m: 'stripped', inv: 'degraded', vis: 'survives' },
  { proc: 'Datamosh', m: 'stripped', inv: 'stripped', vis: 'degraded' },
];

function licenseSortValue(r, key) {
  if (key === 'name') return r.name || '';
  return { 'yes-star': '0', yes: '0', maybe: '1', tos: '1', risk: '1', no: '2', 'no-wm': '2' }[r[key]] || '1';
}

function wmSortValue(r, key) {
  if (key === 'proc') return r.proc || '';
  return { survives: '0', degraded: '1', stripped: '2' }[r[key]] || '1';
}

function ytSortHeaders(cols, sort) {
  return cols.map((c) => `<th data-sort="${c.key}" class="sortable${sort.key === c.key ? ' sorted' : ''}${c.cls ? ' ' + c.cls : ''}"${c.width ? ` style="width:${c.width}"` : ''}>${esc(c.label)}<span class="ref-sort-arrow${sort.key === c.key ? '' : ' dim'}">${sort.key === c.key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ' ⇅'}</span></th>`).join('');
}

function ytTableCfg(id) {
  if (id === 'license') return { rows: LICENSE_ROWS, sort: licenseSort, valueFn: licenseSortValue, rowFn: (r) => licRow(r.name, r.sub, r.c1, r.c2, r.c3, r.highlight) };
  return { rows: WM_ROWS, sort: wmSort, valueFn: wmSortValue, rowFn: (r) => wmRow(r.proc, r.m, r.inv, r.vis) };
}

function paintYtTable(table, cfg) {
  const tbody = table.querySelector('tbody');
  if (tbody) tbody.innerHTML = sortRows(cfg.rows, cfg.sort, cfg.valueFn, null).map(cfg.rowFn).join('');
  table.querySelectorAll('th[data-sort]').forEach((th) => {
    const active = th.getAttribute('data-sort') === cfg.sort.key;
    th.classList.toggle('sorted', active);
    const arrow = th.querySelector('.ref-sort-arrow');
    if (arrow) {
      arrow.textContent = active ? (cfg.sort.dir === 1 ? ' ▲' : ' ▼') : ' ⇅';
      arrow.classList.toggle('dim', !active);
    }
  });
}

/* ═══════════════════════════════════════════════
   Section A — License Table
   ═══════════════════════════════════════════════ */
function buildLicenseSection() {
  return `
    <div class="ref-card">
      <div class="ref-card-head">
        <div class="ref-card-head-icon">${SVG_SHIELD}</div>
        <h2>A — License<span class="ref-sub">Can I get sued?</span></h2>
      </div>
      <div class="ref-card-body">
        <table class="ref-table" data-ytable="license">
          <thead><tr>
            ${ytSortHeaders(LICENSE_COLS, licenseSort)}
          </tr></thead>
          <tbody>
            ${sortRows(LICENSE_ROWS, licenseSort, licenseSortValue, null).map((r) => licRow(r.name, r.sub, r.c1, r.c2, r.c3, r.highlight)).join('')}
          </tbody>
        </table>
        <p class="ref-note">* Public domain is legal, but YPP needs original commentary — see Monetize section.</p>
      </div>
    </div>`;
}

function licRow(name, sub, c1, c2, c3, highlight) {
  return `<tr${highlight ? ' class="ref-highlight"' : ''}>
    <td><span class="ref-lic-name">${esc(name)}</span>${sub ? `<div class="ref-lic-sub">${esc(sub)}</div>` : ''}</td>
    <td class="ref-col-center">${badge(c1)}</td>
    <td class="ref-col-center">${badge(c2)}</td>
    <td class="ref-col-center">${badge(c3)}</td>
  </tr>`;
}

function badge(type) {
  if (type === 'yes')      return `<span class="ref-badge ref-badge-green">${SVG_CHECK} Yes</span>`;
  if (type === 'yes-star') return `<span class="ref-badge ref-badge-green">${SVG_CHECK} Yes*</span>`;
  if (type === 'no')       return `<span class="ref-badge ref-badge-red">${SVG_X} No</span>`;
  if (type === 'maybe')    return `<span class="ref-badge ref-badge-amber">${SVG_WARN} Varies</span>`;
  if (type === 'tos')      return `<span class="ref-badge ref-badge-gray">Per ToS</span>`;
  if (type === 'risk')     return `<span class="ref-badge ref-badge-amber">${SVG_WARN} Risky</span>`;
  if (type === 'no-wm')    return `<span class="ref-badge ref-badge-red">${SVG_X} No — WM</span>`;
  return '';
}

/* ═══════════════════════════════════════════════
   Section B — Disclosure Checklist
   ═══════════════════════════════════════════════ */
function buildDisclosureSection() {
  return `
    <div class="ref-card">
      <div class="ref-card-head">
        <div class="ref-card-head-icon">${SVG_EYE}</div>
        <h2>B — Disclosure<span class="ref-sub">Will I get penalized?</span></h2>
      </div>
      <div class="ref-card-body">
        <ul class="ref-checklist">
          ${checkItem('green', SVG_CHECK, 'Toggle YES to "altered or synthetic content"', 'if ANY AI visuals / voice in video')}
          ${checkItem('green', SVG_CHECK, 'Disclosure does NOT kill monetization,', 'hiding it does')}
          ${checkItem('green', SVG_CHECK, 'YouTube adds small label automatically,', "that's normal")}
          ${checkItem('amber', SVG_WARN, 'Invisible tags (C2PA / IPTC) often stripped', 'by re-encoding / crop / noise / datamosh — manual toggle still required')}
        </ul>
      </div>
    </div>`;
}

function checkItem(color, icon, strong, detail) {
  return `<li class="ref-check">
    <span class="ref-check-icon ${color}">${icon}</span>
    <span class="ref-check-text"><strong>${esc(strong)}</strong>${detail ? ` <span class="ref-muted">— ${esc(detail)}</span>` : ''}</span>
  </li>`;
}

/* ═══════════════════════════════════════════════
   Section C — Monetization (split cards)
   ═══════════════════════════════════════════════ */
function buildMonetizeSection() {
  return `
    <div class="ref-card">
      <div class="ref-card-head">
        <div class="ref-card-head-icon">${SVG_MONEY}</div>
        <h2>C — Monetization<span class="ref-sub">Will YPP approve?</span></h2>
      </div>
      <div class="ref-card-body">
        <div class="ref-split">
          <div class="ref-split-card red">
            <div class="ref-split-title">${SVG_X} Kills Monetization</div>
            <ul class="ref-split-list">
              <li>compilation of stock / public domain with no commentary</li>
              <li>AI voice reading Wikipedia over stock</li>
              <li>large AI watermarks</li>
              <li>mass-produced template</li>
            </ul>
          </div>
          <div class="ref-split-card green">
            <div class="ref-split-title">${SVG_CHECK} Safe for Monetization</div>
            <ul class="ref-split-list">
              <li>same footage + YOUR voiceover + analysis / story / education</li>
              <li>significant editing, transformative</li>
            </ul>
          </div>
        </div>
        <div class="ref-callout">
          ${SVG_INFO}
          <p>Simply re-uploading public domain video may not be eligible — needs original commentary</p>
        </div>
      </div>
    </div>`;
}

/* ═══════════════════════════════════════════════
   Section D — Watermarks & Invisible Tags
   ═══════════════════════════════════════════════ */
function buildWatermarksSection() {
  return `
    <div class="ref-card">
      <div class="ref-card-head">
        <div class="ref-card-head-icon">${SVG_LAYERS}</div>
        <h2>D — Watermarks & Tags<span class="ref-sub">What survives?</span></h2>
      </div>
      <div class="ref-card-body">
        <table class="ref-table" data-ytable="watermarks">
          <thead><tr>
            ${ytSortHeaders(WM_COLS, wmSort)}
          </tr></thead>
          <tbody>
            ${sortRows(WM_ROWS, wmSort, wmSortValue, null).map((r) => wmRow(r.proc, r.m, r.inv, r.vis)).join('')}
          </tbody>
        </table>
        <div class="ref-legend">
          <span class="ref-status"><span class="ref-dot green">${SVG_CHECK}</span> Survives</span>
          <span class="ref-status"><span class="ref-dot amber">${SVG_WARN}</span> Degraded</span>
          <span class="ref-status"><span class="ref-dot red">${SVG_X}</span> Stripped</span>
        </div>
      </div>
    </div>`;
}

function wmRow(proc, m, inv, vis) {
  return `<tr>
    <td><span class="ref-lic-name">${esc(proc)}</span></td>
    <td class="ref-col-center">${wmStatus(m)}</td>
    <td class="ref-col-center">${wmStatus(inv)}</td>
    <td class="ref-col-center">${wmStatus(vis)}</td>
  </tr>`;
}

function wmStatus(type) {
  if (type === 'survives')  return `<span class="ref-status ref-status-green"><span class="ref-dot green">${SVG_CHECK}</span> Survives</span>`;
  if (type === 'degraded')  return `<span class="ref-status ref-status-amber"><span class="ref-dot amber">${SVG_WARN}</span> Degraded</span>`;
  return `<span class="ref-status ref-status-red"><span class="ref-dot red">${SVG_X}</span> Stripped</span>`;
}

/* ═══════════════════════════════════════════════
   Section E — Channel Strategy Checklist
   ═══════════════════════════════════════════════ */
function buildStrategySection() {
  return `
    <div class="ref-card">
      <div class="ref-card-head">
        <div class="ref-card-head-icon"><span style="font-size:12px;font-weight:700">${SVG_UPRIGHT}</span></div>
        <h2>E — Channel Strategy<span class="ref-sub">Can I mix?</span></h2>
      </div>
      <div class="ref-card-body">
        <ul class="ref-checklist">
          ${checkItem('green', SVG_CHECK, 'One non-monetizable video does NOT burn channel', '')}
          ${checkItem('green', SVG_CHECK, 'Video-level demonetization (yellow $) != channel demonetization', '')}
          ${checkItem('green', SVG_CHECK, 'YPP review looks at MAJORITY of PUBLIC videos', '')}
          ${checkItem('green', SVG_CHECK, 'If applying for YPP: set experimental non-monetizable videos to Unlisted / Private,', 'or have majority original content public')}
          ${checkItem('green', SVG_CHECK, 'You can reapply after 30 days', '')}
        </ul>
      </div>
    </div>

    <div class="ref-footer">
      <span class="ref-footer-icon">R</span>
      <span>Rule of thumb: <strong>Legal = license</strong>, <strong>YouTube = originality + disclosure</strong>. Do both.</span>
      <span class="ref-muted">No trackers — Keep this card open while editing</span>
    </div>`;
}

function esc(s) {
  return escapeHtml(String(s || ''));
}

export { renderReferencesForm };
