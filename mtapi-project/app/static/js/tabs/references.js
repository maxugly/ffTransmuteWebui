/**
 * References tab — two sub-tabs sharing one bare workspace:
 *   YT Footage (license/disclosure/monetize/watermarks/strategy cards)
 *   Video Models (the Big Chart — one card, one table)
 * Left nav (.nav-item data-tab="refs" / "refs-models") and the top
 * segmented bar stay in sync via switchTab.
 */
import { state, elements, switchTab } from '/app.js?v=2';
import { escapeHtml } from '/js/utils.js';
import { MUSIC_PROMPT_EXAMPLES } from '/js/ref-music-prompts.js';

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
    : state.activeTab === 'refs-code' ? 'code'
    : state.activeTab === 'refs-apis' ? 'apis'
    : state.activeTab === 'refs-music' ? 'music' : 'yt';
  const wide = sub !== 'yt';
  const html = `
    <div class="ref-workspace${wide ? ' ref-workspace-wide' : ''}">
      <div class="ref-subtabs" id="refSubtabs">
        <button class="ref-subtab${sub === 'yt' ? ' active' : ''}" data-ref-tab="refs">YT Footage</button>
        <button class="ref-subtab${sub === 'models' ? ' active' : ''}" data-ref-tab="refs-models">Video Models</button>
        <button class="ref-subtab${sub === 'imgmodels' ? ' active' : ''}" data-ref-tab="refs-images">Image Models</button>
        <button class="ref-subtab${sub === 'code' ? ' active' : ''}" data-ref-tab="refs-code">Coding Models</button>
        <button class="ref-subtab${sub === 'apis' ? ' active' : ''}" data-ref-tab="refs-apis">APIs / Free Tiers</button>
        <button class="ref-subtab${sub === 'music' ? ' active' : ''}" data-ref-tab="refs-music">Music Prompts</button>
      </div>
      ${sub === 'models' ? buildModelsSection() : sub === 'imgmodels' ? buildImageModelsSection() : sub === 'code' ? (codeModelOpen ? buildCodeModelPage(codeModelOpen) : buildCodeModelsSection()) : sub === 'apis' ? (apiPageOpen ? buildApiPage(apiPageOpen) : buildApisSection()) : sub === 'music' ? buildMusicSection() : buildYtSections()}
    </div>
  `;
  elements.actionPanel.innerHTML = html;
  (elements.actionPanelRoot || elements.actionPanel).classList.add('ref-active');
  elements.actionPanel.querySelectorAll('#refSubtabs .ref-subtab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-ref-tab');
      if (target === state.activeTab) {
        // Re-clicking the active Coding Models segment exits an open model page.
        if (target === 'refs-code' && codeModelOpen) {
          codeModelOpen = null;
          renderReferencesForm();
        }
        // Re-clicking the active APIs segment exits an open API page.
        if (target === 'refs-apis' && apiPageOpen) {
          apiPageOpen = null;
          renderReferencesForm();
        }
        return;
      }
      if (target) switchTab(target);
    });
  });
  bindSortableTables();
  bindMusicBank();
  bindCodeModelNav();
  bindApisNav();
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
  { model: 'LTX Video 2.5 (Upsampler) (⚡ Latest · T2V+I2V)', relDate: '2026-08', natW: '768', natH: '512', swW: '1280', swH: '720', maxW: '3840', maxH: '2160', maxFps: '50', durMin: '6', durMax: '20', tier480: 'no', tier540: 'no', tier720: 'yes', tier1080: 'yes', tier2k: 'yes', tier4k: 'yes', crazy: 'yes', category: 'Cinematic Realism', released: '2026-08', native: '768x512 class, Divisible by 32, default 1216x704 @30fps', sweet: '768x512 single-stage or 960x544 / 1280x720 final via 2x latent upsampler', max: 'Native 4K @ up to 50 fps (3840x2176 tiled)', dur: '5s (121f @24fps) default, API 6-20s (720p/1080p) 6-10s (4K)', fl2v: 'yes', audio: 'yes', notes: 'LTX2TwoStagePipeline / LTX2LatentUpsamplePipeline', strengths: 'Native 4K AV, 2-stage latent upscaler, 50fps, sub-7s 20s API execution', weaknesses: 'Needs 2 stages for best quality, single-stage >1280x704 in I2V duplicates', tips: 'Use LTX2TwoStagePipeline (960x544 -> 1920x1088); guidance_scale=1.0 for distilled; lock multi-character lip-sync by keeping sentences concise.' },
  { model: 'LTX Video 2.5 Distilled (⚡ Latest · T2V+I2V)', relDate: '2026-08', natW: '960', natH: '544', swW: '960', swH: '544', maxW: '3840', maxH: '2160', maxFps: '50', durMin: '6', durMax: '20', tier480: 'no', tier540: 'no', tier720: 'yes', tier1080: 'yes', tier2k: 'yes', tier4k: 'yes', crazy: 'yes', category: 'Cinematic Realism', released: '2026-08', native: 'Training buckets 960x544x49, Stage1 960x544 -> Stage2 1920x1088', sweet: 'Single-stage 768x512 or 960x544 @24fps 97-121f, 8 steps stage1 + 4 steps stage2', max: 'Native 4K @ up to 50 fps', dur: '5s (121f) sweet, practical 97-161f (4-6.7s), up to 20s API', fl2v: 'yes', audio: 'yes', notes: 'Fastest inference', strengths: '8-step distilled, guidance_scale=1.0, fastest LTX 2.5', weaknesses: 'Duplicates/disintegrates above 1280x704 in I2V', tips: 'Set guidance_scale=1.0 strictly to prevent color burn; use 960x544 8-step passes for rapid 20s AV drafts.' },
  { model: 'LTX Video 2.3 Distilled (High Quality · T2V+I2V)', relDate: '2026-03', natW: '1216', natH: '704', swW: '768', swH: '512', maxW: '3840', maxH: '2160', maxFps: '50', durMin: '6', durMax: '20', tier480: 'no', tier540: 'no', tier720: 'yes', tier1080: 'yes', tier2k: 'yes', tier4k: 'yes', crazy: 'yes', category: 'Precision / Control', released: '2026-03', native: '1216x704 native -> 1920x1088 upscale, example 480x832, 720p class', sweet: '768x512 @97f (~4s) - 40s @768x512 and 50s @1280x704 on RTX 5090', max: '4K via latent upscaler, up to 20s', dur: '4-6s sweet, max 20s single generation', fl2v: 'yes', audio: 'yes', notes: 'Distilled default', strengths: '50% lower compute, synced stereo audio', weaknesses: 'LTX-2.0 LoRAs incompatible, requires fp32 if bf16 visual corruption manifests', tips: 'Use for singing avatars and music videos; input uncompressed 44.1kHz audio; disable secondary temporal upscaler if edge shivering occurs.' },
  { model: 'LTX-2.3 F2LF (First-Last Frame · T2V+I2V)', relDate: '2026-03', natW: '1280', natH: '720', natNote: 'Range 480p-1440p native', swW: '1280', swH: '720', maxW: '3840', maxH: '2160', maxFps: '50', upscaled: '4K via 2-stage latent upscale', durMin: '6', durMax: '20', tier480: 'no', tier540: 'no', tier720: 'yes', tier1080: 'yes', tier2k: 'yes', tier4k: 'yes', crazy: 'yes', category: 'Precision / Control', released: '2026-03', native: '720p native (range 480p-1440p native, 4K via upscaler), divisible by 32, 8n+1 frames', sweet: '768x512 to 1280x720 (720p) @121f (~5s @24fps), 704x416x97f on 8GB', max: '4K (2160p) via 2-stage latent upscale, Fast reaches 20s', dur: '5-6s coherence, up to 10s, max 20s, API 6/8/10/12/14/16/18/20s', fl2v: 'yes', audio: 'yes', notes: 'Video_ltx2_3_flf2v workflow', strengths: 'Native first+last frame interpolation, 20s max one pass', weaknesses: 'Needs start+end image for best use', tips: 'Set last_frame_uri in KeyframeInterpolationPipeline; enforce 8n+1 frame counts (97f, 121f) for clean mathematical steps.' },
  { model: 'LTX Video 2 TURBO (High Quality · T2V+I2V)', relDate: '2026-01', natW: '1920', natH: '1080', swW: '1280', swH: '720', maxW: '3840', maxH: '2160', maxFps: '50', durMin: '6', durMax: '10', tier480: 'no', tier540: 'no', tier720: 'yes', tier1080: 'yes', tier2k: 'yes', tier4k: 'yes', crazy: 'yes', category: 'Precision / Control', released: '2026-01', native: '720p-1080p native, Native 4K Fidelity', sweet: '720p Standard @6s - 6s Full HD in 5s', max: 'Native 4K @ up to 48-50 fps, clips up to 10s, up to 20s audio', dur: '6-10s sweet, I2V 6-20s up to 4K', fl2v: 'yes', audio: 'yes', notes: 'TURBO = Fast variant', strengths: 'Fast prototyping, 5s for 6s 1080p, open-source 19B', weaknesses: 'Still heavy 19B, 4K needs 2-stage', tips: 'Deploy LTX-2 Fast for low-latency composition checks before submitting final master renders to LTX-2 Pro.' },
  { model: 'LTX Video 0.9.8 13B Distilled (High Quality · T2V+I2V)', relDate: '2025-07', natW: '1216', natH: '704', swW: '1216', swH: '704', maxW: '1216', maxH: '704', maxFps: '30', upscaled: 'Multiscale ltxv-spatial-upscaler to 4K', durMin: '5', durMax: '60', tier720: 'yes', tier1080: 'no', tier2k: 'no', tier4k: 'no', crazy: 'yes', category: 'Open / Self-Host', released: '2026-06', native: '768x512 @24fps, new default 1216x704 @30fps', sweet: '768x512 / 512x768 base, cheap HD 704x1216 / 1216x704, 7 steps guidance 1', max: 'Up to 1280px natively, 1920x1080 via ltxv-spatial-upscaler-0.9.8', dur: '5s @24-30fps ideal, 15-30s reliable, up to 60s via chunking, max 1441f', fl2v: 'no', audio: 'no', notes: 'Old arch, 13B', strengths: '8 steps preview, long-form 60s chunking', weaknesses: 'No native audio, needs upscaler for 1080p+', tips: 'Run 8-step preview passes at guidance_scale=1.0; use longshot chunking pipeline to chain 5s windows up to 60s.' },
  { model: 'Omni Video Custom (⚡ Fast Motion · T2V+I2V)', relDate: '2026-02', natNote: 'Config buckets [576,992] / [512,992] / [720,720]', maxFps: '24', durMin: '5', durMax: '5', category: 'Precision / Control', released: '2025-06', native: 'Unknown - custom factory model, inferred 720p-class', sweet: 'Unknown - inferred 720p / 1216x704', max: 'Unknown - inferred 720p-1080p', dur: 'Unknown - inferred 5s', fl2v: 'no', audio: '?', notes: 'Custom - HF Space Omni Video Custom-fast-motion', strengths: 'Fast motion focused, video extend, listed with LTX/Wan', weaknesses: 'Zero docs, custom no public card', tips: 'Use strictly for fast motion prototype clips.' },
  { model: 'Wan 2.2 Fast (⚡ Fast · T2V+I2V)', relDate: '2025-07', natW: '1280', natH: '704', natNote: 'Portrait 704x1280', swW: '1280', swH: '720', maxW: '1280', maxH: '704', maxFps: '24', durMin: '5', durMax: '5', tier480: 'yes', tier540: 'no', tier720: 'yes', tier1080: 'no', tier2k: 'no', tier4k: 'no', crazy: 'yes', category: 'Precision / Control', released: '2025-02', native: '480P & 720P MoE, high-quality 720p dataset', sweet: '480p (832x480 @16fps, 53f) cheap, RIFE interpolation', max: '1280x720 (720P) natively, 1080p via external upscaler', dur: '5s (81f @16fps)', fl2v: 'no', audio: 'no', notes: 'A14B-NFE4 distilled', strengths: '4-step LightX2V Lightning LoRA, 20s vs 147s base @720p, complex motion retained', weaknesses: '720p max native, no audio, steps >4 corrupt render', tips: 'Must execute at strictly 4 steps; exceeding 4 steps causes severe over-exposure and color clipping.' },
  { model: 'Wan 2.2 I2V rCM (I2V Only · T2V+I2V)', relDate: '2025-02', natW: '1280', natH: '720', swW: '1280', swH: '720', maxW: '1280', maxH: '720', durMin: '5', durMax: '6.8', durNote: '81-109f @16fps', tier480: 'yes', tier720: 'yes', tier1080: 'no', tier2k: 'no', tier4k: 'no', crazy: 'yes', category: 'Precision / Control', released: '2025-02', native: '480P & 720P, 5s @720P 16fps target, Best 720p', sweet: '480p (832x480) 8.0s distill vs 720p (1280x720) 20.0s distill', max: '720P native, 1080x1920 works via scale', dur: '5s (81f @16fps), extendable 81-109f (6.8s)', fl2v: 'yes', audio: 'no', notes: 'TurboWan2.2-I2V-A14B-720P', strengths: 'rCM 4-step turbo, I2V optimized, complex motion', weaknesses: 'No audio, I2V only, steps >4 corrupt render', tips: 'Execute at strictly 4 steps with rCM checkpoint; feed clean 720p stills; keep text prompts concise.' },
  { model: 'Wan 2.2 I2V (LoRA) (I2V Only · T2V+I2V)', relDate: '2025-02', natW: '1280', natH: '720', swW: '1280', swH: '720', maxW: '1280', maxH: '720', maxFps: '24', durMin: '5', durMax: '8', tier480: 'yes', tier540: 'no', tier720: 'yes', tier1080: 'no', tier2k: 'no', tier4k: 'no', crazy: 'yes', category: 'Precision / Control', released: '2025-02', native: '480P & 720P MoE, 5s @ up to 720p/24fps', sweet: '480p class 832x480 @16fps, 832x480 @16fps (53f) + RIFE', max: '1280*720 (720p)', dur: '5s (supports 5, 8s), 81f @16fps', fl2v: 'yes', audio: 'no', notes: 'I2V High/Low Noise rank64 lightx2v 4step', strengths: 'LoRA camera controls, must use with Wan2.2-I2V-A14B base, fast', weaknesses: 'Cannot standalone, LoRA only, no audio', tips: 'Deploy rank-64 camera LoRAs at weights 0.6–0.8; ensure LoRA architecture matches base model exactly.' },
  { model: 'Seedance 1.0 Lite', relDate: '2025-06', natH: '480', natNote: '9:16/9:21 portrait variants', swH: '720', maxH: '1080', upscaled: '480p base refiner to 720p/1080p', durMin: '5', durMax: '10', tier480: 'yes', tier540: 'no', tier720: 'yes', tier1080: 'yes', tier2k: 'no', tier4k: 'no', crazy: 'yes', category: 'Stylized', released: '2025-07', native: '480p-720p', sweet: '480p rapid iteration, 720p balanced', max: '720p', dur: '4-5s', fl2v: 'no', audio: 'no', notes: 'Early budget draft tier', strengths: 'Quick, cheap concept generation', weaknesses: 'Prone to visual noise and facial drift', tips: 'Keep clip lengths under 4s; apply negative prompts for noise.' },
  { model: 'Seedance 1.0 Pro / Pro Fast', relDate: '2025-06', natH: '480', natNote: '9:16 portrait variant', swH: '1080', maxH: '1080', maxFps: '24', upscaled: '480p base refiner to 720p/1080p', durMin: '2', durMax: '12', tier480: 'yes', tier540: 'no', tier720: 'yes', tier1080: 'yes', tier2k: 'no', tier4k: 'no', crazy: 'yes', category: 'Cinematic Realism', released: '2025-10', native: '1080p max but trained 720p', sweet: '720p / 640x640 — 1080p is final polish tier', max: '1080p', dur: '5-12s', fl2v: 'yes', audio: 'no', notes: 'Your current model', highlight: true, strengths: 'Dependable middle ground, 30-60% faster inference than 1.0 Pro', weaknesses: '1080p is upscaled polish, soft micro-expressions on intricate faces', tips: 'Use as primary B-roll engine; specify explicit lighting directions (golden hour side lighting).' },
  { model: 'Seedance 2.0', relDate: '2026-02', natH: '720', natNote: '480p + 720p tiers; portrait 1080x2048', swH: '720', maxW: '2048', maxH: '1080', maxFps: '30', upscaled: '720p native to 1080p/4K platform SR (Pro)', durMin: '4', durMax: '15', tier480: 'yes', tier540: 'no', tier720: 'yes', tier1080: 'yes', tier2k: 'no', tier4k: 'no', category: 'Precision / Control', released: '2026-02', native: '720p / 1080p', sweet: '720p — outputs 480p/720p/1080p', max: '1080p', dur: '4s-15s', fl2v: 'yes', audio: 'yes', notes: 'Native audio + 3s video trajectory drive', strengths: '1 face + 1 wardrobe + 1 audio + 1 video reference; 3s camera clip forces exact 3D trajectory', weaknesses: 'Capped at 15s max; combining conflicting audio styles causes robotic dialogue', tips: 'Supply a 3s camera motion video alongside text to force exact camera trajectory replication; add organic camera texture (subtle lens flare).' },
  { model: 'Seedance 2.5 / 3.0', relDate: '2026-07', natH: '720', natNote: 'Shipped API 480p/720p; train res unpublished', swH: '720', durMin: '4', durMax: '30', tier480: 'yes', tier540: 'no', tier720: 'yes', tier1080: 'no', tier2k: 'no', tier4k: 'no', category: 'Precision / Control', released: '2026-07', native: '480p/720p native, 1080p upscale', sweet: '720p for physics, 1080p for final', max: '1080p', dur: '30s continuous single take', fl2v: 'yes', audio: 'yes', notes: '50-item multimodal reference stack (brief cites 9 image + 3 clip + 3 audio input structure)', strengths: 'Single-pass 30s clips without cuts (brief cites 16s+ multi-shot narrative); 50 reference slots (optimal 11-15); local in-scene edit without re-roll; audio leaderboard #1 (brief claim)', weaknesses: 'Native renders 480p-720p (needs upscaler); real human photo filter blocks', tips: 'Format 30s takes in timestamp brackets ([0-8s] dolly in, [8-18s] turn left); power-user sweet spot is 11-15 refs; use AI face stills to bypass filter.' },
  { model: 'MiniMax H3 (High Quality · T2V+I2V) / Hailuo 03', relDate: '2026-07', natH: '768', natNote: '480P/768P buckets; 2K via in-context regen', swH: '768', maxW: '2560', maxH: '1440', maxFps: '24', maxNote: 'Portrait 1440x2560; 21:9 2976x1248', upscaled: '768P to 2K in-context regen; 4K upscale-only (fal)', durMin: '4', durMax: '15', tier480: 'yes', tier540: 'no', tier720: 'no', tier1080: 'no', tier2k: 'yes', tier4k: 'no', category: 'Cinematic Realism', released: '2026-07', native: '2K native (2048x1152 / 1152x2048)', sweet: '768P @ 5-15s while iterating, 2K for final masters', max: '2K @ up to 15s, 24/30 FPS', dur: '4-15s allowed, sweet 5-10s', fl2v: 'yes', audio: 'yes', notes: 'Alias Hailuo 3.0', highlight: true, strengths: 'Native 2K resolution default, single-pass 15s, native stereo audio, open weights (MiniMax-H3)', weaknesses: 'Pay-as-you-go API; Ref2VA multi-ref mode has lower visual quality than FL2VA keyframing', tips: 'Use FL2VA keyframing rather than Ref2VA multi-ref stack for cleanest base renders; include explicit acoustic soundscape descriptors.' },
  { model: 'Vidu 1.0 / 1.5 / 2.0', relDate: '2024-09', natH: '1080', natNote: '1.0: 360p base; 1.5/2.0: 1080p', swH: '720', maxW: '1920', maxH: '1080', maxNote: 'Vertical 1080x1920', durMin: '4', durMax: '8', tier480: 'no', tier540: 'no', tier720: 'yes', tier1080: 'yes', tier2k: 'no', tier4k: 'no', category: 'Precision / Control', released: '2024-09', native: '1080p', sweet: '540p drafts, 720p default, 1080p final', max: '1080p', dur: '4s or 8s', fl2v: 'yes', audio: 'no', notes: 'Legacy line — Q-series supersedes it', strengths: 'Early reference-to-video + template motion synthesis', weaknesses: 'Superseded by Q3; no native audio', tips: 'Only reach for these when Q3 credits sting — same anchor discipline applies.' },
  { model: 'Vidu Q1 / Q3-Pro / S1', relDate: '2026-02', natH: '1080', natNote: 'Q1/Q3-Pro 1080p; S1 960x540', swH: '1080', maxW: '1920', maxH: '1080', maxFps: '24', maxNote: 'S1 caps 960x540 at 25fps; vertical variants', durMin: '3', durMax: '16', durNote: 'S1 is continuous realtime', tier480: 'no', tier540: 'yes', tier720: 'yes', tier1080: 'yes', tier2k: 'no', tier4k: 'no', crazy: 'yes', category: 'Precision / Control', released: '2026-02', native: '540p/720p/1080p tiers (Q3 Pro)', sweet: '720p Turbo drafts, 1080p Pro finals', max: '1080p up to 16s', dur: 'Flexible 1-16s (Q1 start-end fixed 5s)', fl2v: 'yes', audio: 'yes', notes: 'Start-end magic is the flagship; S1 is real-time', strengths: 'Q3 Pro single-pass joint AV lip-sync + 1-7 R2V slots (sweet spot 3-4); Q1 viduq1-start-end 5s keyframe morphing; arena-ranked #1 I2V; up to 7 reference images (Q3)', weaknesses: 'Q1 enforces strict 0.8–1.25 start/end aspect ratio guard (HTTP 400 rejection if mismatched); T2V weaker than R2V; modify/restyle existing video limited', tips: 'For Q1 start-end: ensure start and end frames match aspect ratios within 0.8–1.25 boundary; for Q3 Pro dialogue: use double quotes ("speech text") or attach audio track; start-end frame morphing; Q3 lip-sync ±15ms.' },
  { model: 'Kling 2.0 / 2.1 / 2.5 Turbo / 2.6', relDate: '2025-12', natH: '1080', natNote: 'Std 720p / Pro+Master 1080p tiers; 9:16 portrait, 1:1', swW: '1920', swH: '1080', maxH: '1080', maxFps: '30', durMin: '5', durMax: '10', tier480: 'no', tier540: 'no', tier720: 'yes', tier1080: 'yes', tier2k: 'no', tier4k: 'no', crazy: 'yes', category: 'Avatar / Lip-Sync', released: '2025-12', native: '1080p', sweet: '720p Standard (~1300x708), 1080p Pro', max: '1080p', dur: '5-10s', fl2v: 'yes', audio: 'yes', notes: 'Standard = 720p, Pro = 1080p', strengths: 'First Kling release with single-pass synchronized audio-visual generation (voiceovers, SFX, ambient soundscapes)', weaknesses: 'Multi-speaker dialogue in single clip causes audio attribution slips across characters', tips: 'Format spoken dialogue in double quotes ("speech"); insert sound effect tags in brackets [heavy footsteps]; keep character motion subtle during speech.' },
  { model: 'Kling 3.0 / O3', relDate: '2026-02', natH: '2160', natNote: 'Std 720p / Pro 1080p + native-4K endpoint; 9:16', maxH: '2160', maxFps: '30', maxNote: 'Third-party lists 60fps for 4K', durMin: '3', durMax: '15', tier480: 'no', tier540: 'no', tier720: 'yes', tier1080: 'yes', tier2k: 'no', tier4k: 'yes', crazy: 'no', category: 'Cinematic Realism', released: '2026-01', native: 'Native 4K — 3840x2160 native rendering, no upscaling', sweet: '1080p Pro for physics, 4K for final — max 4K (3840x2160)', max: '4K 60fps', dur: '10-15s', fl2v: 'yes', audio: 'yes', notes: 'First true native 4K model', strengths: 'Native 4K/60fps single-pass generation without upscalers, fluid liquid/cloth dynamics, single-pass sound FX', weaknesses: 'Fast multi-subject action causes limb morphing and fused digits; multi-speaker audio slips across faces', tips: 'Use explicit camera commands (slow dolly in, tracking shot) rather than vague adjectives; use explicit negative prompts against digit fusion (mutated hands, extra fingers, broken wrist).' },
  { model: 'Luma Ray2', relDate: '2025-01', natH: '1080', natNote: '540p/720p/1080p tiers', swH: '720', upscaled: '4K upscale (separate step)', durMin: '5', durMax: '9', durNote: 'Extendable to 30 total', tier480: 'no', tier540: 'yes', tier720: 'yes', tier1080: 'yes', tier2k: 'no', tier4k: 'no', crazy: 'no', category: 'Cinematic Realism', released: '2024-12', native: '540p/720p', sweet: '720p', max: '720p', dur: '5-9s', fl2v: 'yes', audio: 'yes', notes: 'Legacy Luma line', strengths: 'Good lighting and physics feel', weaknesses: 'Capped at 720p, showing its age next to Ray3', tips: 'Use 720p for quick lighting concept checks.' },
  { model: 'Luma Ray3 / Ray3.14', relDate: '2025-09', natH: '1080', natNote: '540p/720p/1080p tiers + Draft', swH: '720', maxH: '1080', maxFps: '24', upscaled: '4K neural upscale / 4K HDR master', durMin: '5', durMax: '10', durNote: 'Modify Video up to 18s', tier480: 'no', tier540: 'yes', tier720: 'yes', tier1080: 'yes', tier2k: 'no', tier4k: 'no', crazy: 'yes', category: 'Physics / Chaos', released: '2025-11', native: 'Native 1080p — delivering native 1080p', sweet: '1080p — architecture scaled to produce crisp 1080p natively', max: '1080p + 4K upscaler', dur: '5-10s', fl2v: 'yes', audio: 'yes', notes: 'Your best for wall crash debris', highlight: true, strengths: 'Physics and particle chaos — demolition derby model, debris, splashing, wall crashes; character reference + keyframes; reasons over complex prompts (plans + critiques own output)', weaknesses: 'Long scene lip-sync/motion tracking inconsistencies (Ray3 review), cost and render time climb with upscale pass; no native audio synthesis', tips: 'Highlight kinetic force words (crashing waves, collapsing stone, exploding debris) in prompt. Up to 16 keyframes; Modify Video restyles up to 20s.' },
  { model: 'Veo 3 / Veo 3 Fast / Veo 3.1', relDate: '2025-05', natH: '1080', natNote: '720p/1080p tiers; 3.1 Quality direct 4K', swH: '2160', maxH: '2160', maxFps: '24', maxNote: '4K is 3.1 Quality direct only', durMin: '4', durMax: '8', durNote: '3.1 extendable +7s x20', tier480: 'no', tier540: 'no', tier720: 'yes', tier1080: 'yes', tier2k: 'no', tier4k: 'yes', crazy: 'no', category: 'Cinematic Realism', released: '2026-05', native: '720p/1080p/4K', sweet: '720p default, 1080p or 4K for final', max: '4K', dur: '8-10s', fl2v: 'yes', audio: 'yes', notes: 'Fast = double speed at 720p, Standard = HQ, 3.1 = stereo lip-sync', strengths: 'Best cinematic prompt adherence, native synchronized audio incl. dialogue + ambient + SFX, true 3D keyframe interpolation, reference image control', weaknesses: 'Hard 8-10s cap per clip, strict safety filter moderation rejections', tips: 'Follow 6-Part Formula: Subject + Context + Action + Style + Camera Work + Audio (dialogue: "...", ambient sound). 8s clips extendable (+7s x20); drive dialogue takes from a reference image for identity lock.' },
  { model: 'Pixverse 6.0 / Motion 2.0', relDate: '2026-03', natH: '1080', natNote: 'Landscape 1920x1080; vertical 1080x1920; 1:1; 4:3/3:4', swH: '1080', maxW: '1920', maxH: '1080', maxNote: 'Vertical 1080x1920', durMin: '1', durMax: '15', tier480: 'no', tier540: 'yes', tier720: 'yes', tier1080: 'yes', tier2k: 'no', tier4k: 'no', crazy: 'yes', category: 'Precision / Control', released: '2026-03', native: '1080p', sweet: '1080p 15s with virtual camera controls', max: '1080p', dur: '15s', fl2v: 'yes', audio: 'yes', notes: '20+ virtual camera lens controls & synchronized audio', strengths: 'Granular lens controls (85mm portrait lens, shallow depth of field), 15s duration', weaknesses: 'Steeper learning curve for camera parameter tuning', tips: 'Specify explicit lens parameters (e.g. 85mm portrait lens, f/1.8 aperture, shallow depth of field) in prompt.' },
  { model: 'Van Gogh Relax Fast', relDate: '2025-10', natH: '720', swH: '720', maxH: '720', durMin: '5', durMax: '5', tier540: 'yes', tier720: 'yes', tier1080: 'no', tier2k: 'no', tier4k: 'no', category: 'Stylized', released: '2025-10', native: '720p', sweet: '540p draft, 720p default', max: '720p', dur: '5s', fl2v: '?', audio: 'no', notes: 'Use for drafts, then upscale to Standard/HQ', strengths: 'Fastest painterly pass, heavy impasto / swirl, good for style tests', weaknesses: 'Low detail, temporal flicker, no audio, soft edges', tips: 'Use Fast for 540p draft style checks before committing to HQ.' },
  { model: 'Van Gogh Relax Standard', relDate: '2025-10', natH: '1080', swH: '720', maxH: '1080', durMin: '5', durMax: '5', tier720: 'yes', tier1080: 'yes', tier2k: 'no', tier4k: 'no', category: 'Stylized', released: '2025-10', native: '1080p', sweet: '720p default', max: '1080p', dur: '5s', fl2v: '?', audio: 'no', notes: 'Best daily driver for Van Gogh', strengths: 'Balanced Van Gogh look, retains detail better than Fast, still quick', weaknesses: 'No audio, can warp small objects like dice / rigging', tips: 'Emphasize painterly terms: thick oil paint impasto, heavy swirling brushstrokes.' },
  { model: 'Van Gogh Relax HQ', relDate: '2025-10', natH: '1080', swH: '1080', maxH: '1080', durMin: '5', durMax: '8', tier1080: 'yes', tier2k: 'no', tier4k: 'no', category: 'Stylized', released: '2025-10', native: '1080p', sweet: '1080p default', max: '1080p', dur: '5-8s', fl2v: '?', audio: 'no', notes: 'Use for final art pass after Real Motion', strengths: 'Highest brush detail, thick oil texture, most stable style of the 3', weaknesses: 'Slowest, no audio', tips: 'Use for final art pass on stylized master renders.' },
  { model: 'Real Motion 3.5 Turbo', relDate: '2025-12', natH: '1080', swH: '1080', maxH: '1080', durMin: '5', durMax: '8', tier720: 'yes', tier1080: 'yes', tier2k: 'no', tier4k: 'no', category: 'Physics / Chaos', released: '2025-12', native: '1080p', sweet: '720p draft, 1080p final', max: '1080p', dur: '5s or 8s', fl2v: '?', audio: 'yes', notes: 'Top pick - your overhead battle model.', highlight: true, strengths: 'Current flagship - best particle explosion physics, liquid splashes + audio sync, turbo fast', weaknesses: 'Prop Eating failure mode: high destruction strength can swallow/dissolve small secondary props (dice, rigging)', tips: 'Provide high-resolution structural start frames before triggering destruction prompts; highlight kinetic force words (shattering glass, crashing wave).' },
  { model: 'Real Motion 3.5', relDate: '2026-08', natH: '720', swH: '720', maxH: '720', durMin: '5', durMax: '5', tier720: 'yes', tier1080: 'no', tier2k: 'no', tier4k: 'no', category: 'Physics / Chaos', released: '2026-08', native: '1080p', sweet: '720p draft, 1080p final', max: '1080p', dur: '5s or 8s', fl2v: '?', audio: 'yes', notes: 'Use when you need max quality over speed', strengths: 'Full quality 3.5, slightly cleaner particle dynamics than Turbo, audio sync', weaknesses: 'Slower than Turbo', tips: 'Use full 3.5 for uncompressed particle explosion masters.' },
  { model: 'Real Motion 3.1 Turbo', relDate: '2025-10', natH: '720', natNote: '480p variant in UI', swH: '480', maxH: '720', durMin: '5', durMax: '5', tier480: 'yes', tier720: 'yes', tier1080: 'no', tier2k: 'no', tier4k: 'no', category: 'Physics / Chaos', released: '2025-10', native: '1080p', sweet: '540p drafts, 720p default, 1080p final', max: '1080p', dur: '5s', fl2v: '?', audio: 'yes', notes: 'Good cheap draft for sinking-dice gag.', strengths: 'Fast iteration, good subject consistency, audio', weaknesses: 'Older physics than 3.2/3.5, softer fire/smoke micro-textures', tips: 'Keep background simple to minimize particle noise.' },
  { model: 'Real Motion 3.1', relDate: '2025-10', natH: '720', swH: '720', maxH: '720', durMin: '5', durMax: '5', tier720: 'yes', tier1080: 'no', tier2k: 'no', tier4k: 'no', category: 'Physics / Chaos', released: '2025-10', native: '1080p', sweet: '720p default', max: '1080p', dur: '5s or 8s', fl2v: '?', audio: 'yes', notes: 'Stable 3.1 base', strengths: 'Stable 3.1 base, better motion than 2.6/Turbo, audio', weaknesses: 'No turbo speed, mid-pack vs 3.5', tips: 'Good for simple rolling and falling physical dynamics.' },
  { model: 'Real Motion 3.2', relDate: '2025-11', natH: '1080', swH: '720', maxH: '1080', durMin: '5', durMax: '8', tier720: 'yes', tier1080: 'yes', tier2k: 'no', tier4k: 'no', category: 'Physics / Chaos', released: '2025-11', native: '1080p', sweet: '720p default', max: '1080p', dur: '5s or 8s', fl2v: '?', audio: 'yes', notes: 'Best for scenes with climbers + ships + planes together', strengths: 'More stable than 3.1 on multi-object scenes, prevents structural collapse during camera pans', weaknesses: 'No turbo, slightly softer than 3.5', tips: 'Use for multi-object physics scenes where structural retention is required.' },
  { model: 'Real Motion Turbo', relDate: '2025-08', natH: '720', swH: '720', maxH: '720', maxFps: '16', durMin: '5', durMax: '10', tier720: 'yes', tier1080: 'no', tier2k: 'no', tier4k: 'no', category: 'Physics / Chaos', released: '2025-08', native: '720p', sweet: '540p drafts, 720p default', max: '720p', dur: '5s', fl2v: '?', audio: 'no', notes: 'Use for quick camera tests only.', strengths: 'Super fast 720p draft physics', weaknesses: '720p ceiling, no audio, weak particle detail', tips: 'Restrict use strictly to rapid camera motion rough-cuts.' },
  { model: 'Real Motion 2.6', relDate: '2025-06', natH: '1080', swH: '1080', maxH: '1080', maxFps: '16', durMin: '5', durMax: '10', tier1080: 'yes', tier2k: 'no', tier4k: 'no', category: 'Physics / Chaos', released: '2025-06', native: '720p', sweet: '540p default', max: '720p', dur: '5s', fl2v: '?', audio: 'no', notes: 'Legacy base', strengths: 'Oldest stable base, runs fast', weaknesses: 'No audio, dated motion, soft edges', tips: 'Legacy 720p draft tool.' },
  { model: 'Real Motion 3.2 Remix', relDate: '2025-11', natH: '1080', swH: '720', maxH: '1080', durMin: '5', durMax: '8', tier720: 'yes', tier1080: 'yes', tier2k: 'no', tier4k: 'no', category: 'Edit / Extend', released: '2025-11', native: '1080p', sweet: '720p default', max: '1080p', dur: '5-8s', fl2v: '?', audio: 'yes', notes: 'Use for Van Gogh + Real Motion combo pass.', strengths: 'Remix mode - restyles motion & physics from reference video onto new subject image, audio', weaknesses: 'High restyling strength causes severe subject warping, limb tearing, and facial melting', tips: 'Match physical silhouette of target image to reference motion video before restyling.' },
  { model: 'Real Motion 2.6 Remix', relDate: '2025-11', natH: '1080', swH: '1080', maxH: '1080', maxFps: '16', durMin: '5', durMax: '10', tier1080: 'yes', tier2k: 'no', tier4k: 'no', category: 'Edit / Extend', released: '2025-11', native: '720p', sweet: '540p default', max: '720p', dur: '5s', fl2v: '?', audio: 'no', notes: 'Style restyling tests.', strengths: 'Remix on old 2.6 base, style experiments', weaknesses: 'No audio, 720p only, least stable', tips: 'Dial restyling strength down to avoid limb tearing.' },
  { model: 'Wan 3.0', relDate: '2026-08', natW: '1920', natH: '1080', swW: '1920', swH: '1080', maxW: '1920', maxH: '1080', maxFps: '30', durMin: '2', durMax: '30', tier480: 'yes', tier540: 'no', tier720: 'yes', tier1080: 'yes', tier2k: 'no', tier4k: 'no', category: 'Open / Self-Host', released: '2026-08', native: '1080p', sweet: '720p drafts, 1080p finals', max: '1080p @ 30fps', dur: '30s', fl2v: 'yes', audio: 'yes', notes: 'Alibaba open-weights multimodal video foundation model', strengths: '30s clip length, 20 reference slots, native audio, high spatial fidelity', weaknesses: 'Heavy GPU memory requirements for local multi-reference stack', tips: 'Limit reference stack to 5–9 key images for optimal attention focus.' },
  { model: 'Wan 3.0 Prime', relDate: '2026-08', natW: '1920', natH: '1080', swW: '1920', swH: '1080', maxW: '1920', maxH: '1080', maxFps: '30', durMin: '2', durMax: '30', tier480: 'yes', tier540: 'no', tier720: 'yes', tier1080: 'yes', tier2k: 'no', tier4k: 'no', category: 'Precision / Control', released: '2026-08', native: '1080p API model (480P/720P/1080P @30fps)', sweet: '720p drafts, 1080p finals', max: '1080p @30fps', dur: '2-30s (smart duration -1)', fl2v: 'yes', audio: 'yes', notes: 'Prime = speed tier of Wan 3.0 (~1.4x standard price)', strengths: 'Unified T2V+I2V+R2V in one model; refs span images, video, audio, even docs (.pptx/.pdf/.xls)', weaknesses: 'Hard 1080p ceiling, no 4K; invite-gated regional API; ignores negative prompt fields', tips: 'Set delivery (res/ratio/duration) before writing prompt; exclusions MUST be written as plain text in main prompt (API ignores negative fields); set enable_thinking=true for document parsing (.pdf/.pptx).' },
  { model: 'Wan 2.7', relDate: '2026-04', natW: '1920', natH: '1080', natNote: 'Portrait 1080x1920', swW: '1920', swH: '1080', maxW: '1920', maxH: '1080', maxFps: '30', durMin: '2', durMax: '15', tier480: 'no', tier540: 'no', tier720: 'yes', tier1080: 'yes', tier2k: 'no', tier4k: 'no', category: 'Cinematic Realism', released: '2026-05', native: '720p / 1080p', sweet: '720p @ 10s', max: '1080p', dur: '5-15s', fl2v: 'yes', audio: 'no', notes: 'Alibaba Wan intermediate release preceding Wan 3.0', strengths: 'Steady motion physics, solid I2V feature preservation', weaknesses: 'Lacks the unified document reference stack of Wan 3.0', tips: 'Use for general I2V scene extension where 3.0 multimodal features are not required.' },
  { model: 'Wan 2.6', relDate: '2025-12', natW: '1920', natH: '1080', natNote: 'Portrait 1080x1920', swW: '1920', swH: '1080', maxW: '1920', maxH: '1080', maxFps: '30', durMin: '2', durMax: '15', tier480: 'no', tier540: 'no', tier720: 'yes', tier1080: 'yes', tier2k: 'no', tier4k: 'no', category: 'Cinematic Realism', released: '2026-03', native: '720p', sweet: '720p @ 5s', max: '720p', dur: '5-10s', fl2v: 'yes', audio: 'no', notes: 'Wan 2.x generation base model', strengths: 'Stable camera motion, low credit cost', weaknesses: 'No native audio, 720p max resolution', tips: 'Keep prompts direct and concise.' },
  { model: 'Happy Horse 1.1', relDate: '2026-06', natH: '1080', natNote: '720p/1080p; portrait 9:16/9:21 + 1:1/4:3/3:4/21:9', swH: '1080', maxW: '1920', maxH: '1080', maxFps: '24', durMin: '3', durMax: '15', tier480: 'no', tier540: 'no', tier720: 'yes', tier1080: 'yes', tier2k: 'no', tier4k: 'no', crazy: 'no', category: 'Avatar / Lip-Sync', released: '2025-11', native: '720p/1080p', sweet: '1080p 15s lip-sync', max: '1080p', dur: '15s', fl2v: 'yes', audio: 'yes', notes: 'Multilingual lip-sync, joint audio-video 15B Transformer', strengths: 'Single-pass phoneme-level lip-sync across 7 languages; 9 reference image character consistency slots', weaknesses: 'Restricted to talking-head framing', tips: 'Format dialogue in double quotes ("speech") or attach uncompressed 44.1kHz audio track.' },
  { model: 'Happy Horse 1.0', relDate: '2026-04', natH: '1080', natNote: '720p/1080p; portrait 9:16 supported', swH: '1080', maxW: '1920', maxH: '1080', maxFps: '24', durMin: '3', durMax: '15', durNote: 'Web app 5-10 observed; brief cites 10s', tier480: 'no', tier540: 'no', tier720: 'yes', tier1080: 'yes', tier2k: 'no', tier4k: 'no', crazy: 'no', category: 'Avatar / Lip-Sync', released: '2025-08', native: '720p', sweet: '720p portrait speech', max: '720p', dur: '10s', fl2v: 'yes', audio: 'yes', notes: 'Base model, predecessor to 1.1 (brief cites top raw Elo 1357)', strengths: 'Early joint audio-video generation; 7-language lip-sync line', weaknesses: 'Soft facial details on 1080p scaling', tips: 'Use high-resolution portrait inputs.' },
  { model: 'Happy Horse Edit', relDate: '2026-04', natH: '1080', natNote: 'Edit preserves source; output 720P/1080P', maxW: '1920', maxH: '1080', maxFps: '24', maxNote: 'Aspect preserved from source', durMin: '3', durMax: '15', durNote: 'Input 3-60s, truncated to 15', tier480: 'no', tier540: 'no', tier720: 'yes', tier1080: 'yes', tier2k: 'no', tier4k: 'no', category: 'Edit / Extend', released: '2025-12', native: '1080p', sweet: '1080p local edit', max: '1080p', dur: '10s', fl2v: 'yes', audio: 'yes', notes: 'Localized avatar performance editing', strengths: 'In-scene facial performance restyling', weaknesses: 'Requires clear source video framing', tips: 'Ensure input video has steady lighting.' },
  { model: 'Minimax H3 Max', relDate: '2026-08', natH: '768', natNote: '480P/768P buckets', swH: '768', maxH: '768', maxFps: '24', maxNote: '16:9/21:9/4:3/1:1/9:16/3:4', durMin: '5', durMax: '15', tier480: 'yes', tier540: 'no', tier720: 'no', tier1080: 'no', tier2k: 'no', tier4k: 'no', category: 'Precision / Control', released: '2026-08', native: '480p / 768p', sweet: '480p ($0.05/s) drafts, 768p ($0.08/s) finals', max: '768p @ 15s', dur: '5-15s', fl2v: 'yes', audio: 'yes', notes: 'Fast pay-as-you-go API optimized with fal.ai', strengths: 'Ultra-fast API inference, 480p/768p cheap draft iterations', weaknesses: 'Not included in flat video packages; no native 2K output', tips: 'Use 480p ($0.05/s) for initial composition before scaling; keep text prompts focused on macro subject movement.' },
  { model: 'Minimax H3 Max Turbo', relDate: '2026-09', natH: '768', natNote: '480P/768P buckets', swH: '768', maxH: '768', durMin: '5', durMax: '15', tier480: 'yes', tier540: 'no', tier720: 'no', tier1080: 'no', tier2k: 'no', tier4k: 'no', category: 'Precision / Control', released: '2026-08', native: '480p / 768p', sweet: '480p fast drafts', max: '768p @ 15s', dur: '5-15s', fl2v: 'yes', audio: 'yes', notes: 'Consumer app hailuoai.video fast credit tier', strengths: 'Rapid turnaround draft mode', weaknesses: 'Credit system unverified on official API docs', tips: 'Ideal for high-throughput draft iterations on hailuoai.video.' },
  { model: 'MiniMax Hailuo 2.3', relDate: '2025-10', natH: '1080', natNote: '768P/1080P tiers; I2V follows source', swH: '768', maxH: '1080', maxFps: '24', durMin: '6', durMax: '10', tier480: 'no', tier540: 'no', tier720: 'no', tier1080: 'yes', tier2k: 'no', tier4k: 'no', crazy: 'yes', category: 'Cinematic Realism', released: '2025-10', native: '768p / 1080p', sweet: '768p @ 10s (0.7 points/s Fast tier)', max: '1080p @ 6s', dur: '6-10s', fl2v: 'no', audio: 'no', notes: 'High dynamic prompt adherence; FL2V dropped (brief cites free tier)', strengths: 'Strict prompt obedience, steady physical weight & motion, strong micro-expressions and character consistency', weaknesses: 'Does not support First & Last Frame (FL2V)', tips: 'Use 768p for 10s steady single-shot takes; 1080p for 6s hero shots.' },
  { model: 'MiniMax Live Illustrations', relDate: '2025-01', natH: '720', swH: '720', maxW: '1366', maxH: '768', maxFps: '25', maxNote: 'Aspect follows source', durMin: '6', durMax: '6', tier480: 'no', tier540: 'no', tier720: 'yes', tier1080: 'no', tier2k: 'no', tier4k: 'no', category: 'Precision / Control', released: '2025-02', native: '720p', sweet: '720p 5s illustration animation', max: '720p @ 5s', dur: '5s', fl2v: 'no', audio: 'no', notes: 'Video Agent template / I2V-01-Live-01 model', strengths: 'Animates 2D digital illustrations, anime stills, and artwork cleanly', weaknesses: 'Capped at 5s, soft on photorealistic inputs', tips: 'Use specifically for 2D illustration and anime artwork stills.' },
  { model: 'Seedance 2.5 Lite', relDate: '2026-08', natH: '720', natNote: '480p/720p tiers; 9:16 portrait', swH: '720', maxH: '720', durMin: '5', durMax: '10', tier480: 'yes', tier540: 'no', tier720: 'yes', tier1080: 'no', tier2k: 'no', tier4k: 'no', category: 'Precision / Control', released: '2026-07', native: '720p class (native 480p/720p; announced 4K unverified on API)', sweet: '720p drafts — cheap 30s volume', max: '30s single pass (4K announced, API native 480p/720p)', dur: '4-30s (Ultra-Long 180s beta on Jimeng)', fl2v: 'yes', audio: 'yes', notes: 'Lite = fast/cheap tier of 2.5 family (announced Jun 23, shipped Jul 31)', strengths: '30s native single shot without cuts; 50 multimodal refs (image+video+audio); local in-scene edit without re-roll', weaknesses: 'Announced 4K unverified on API tiers; 30s wanders without beat structure; real human photo filter blocks', tips: 'Write 30s in beats with explicit transitions ([0-8s] dolly in); 11-15 refs beat 50; build AI character face portrait to bypass filter.' },
  { model: 'Seedance 2.0 Mini', relDate: '2026-06', natH: '720', natNote: '480p/720p tiers; 9:16 portrait', swH: '720', maxH: '720', durMin: '4', durMax: '15', tier480: 'yes', tier540: 'no', tier720: 'yes', tier1080: 'no', tier2k: 'no', tier4k: 'no', category: 'Avatar / Lip-Sync', released: '2026-04', native: '480p', sweet: '480p / 720p close-up talking heads', max: '720p', dur: '5-10s', fl2v: 'no', audio: 'yes', notes: 'Budget avatar talking-head model', strengths: 'Cheap lip-sync, clean stylized/anime 2D & portrait facial micro-expressions', weaknesses: 'Motion stutter on fast dynamic camera moves or full-body action', tips: 'Restrict to static portrait framing; lock camera in prompt (locked tripod shot, static framing).' },
  { model: 'Seedance 1.0 Pro Fast', relDate: '2025-10', natH: '480', natNote: '9:16 portrait variant', swH: '1080', maxH: '1080', maxFps: '24', upscaled: '480p base refiner to 720p/1080p', durMin: '2', durMax: '12', tier480: 'yes', tier540: 'no', tier720: 'yes', tier1080: 'yes', tier2k: 'no', tier4k: 'no', crazy: 'yes', category: 'Cinematic Realism', released: '2025-10', native: '720p', sweet: '720p B-roll batch renders', max: '1080p', dur: '5-12s', fl2v: 'yes', audio: 'no', notes: '30-60% faster inference than 1.0 Pro at lower compute cost', strengths: 'Fast high-volume B-roll production, strong I2V feature retention', weaknesses: 'Soft micro-expressions on intricate human faces', tips: 'Use as primary B-roll engine; specify explicit lighting directions.' },
  { model: 'Seedance 1 Lite', relDate: '2025-07', natH: '480', swH: '480', maxH: '720', durMin: '4', durMax: '5', tier480: 'yes', tier540: 'no', tier720: 'yes', tier1080: 'no', tier2k: 'no', tier4k: 'no', crazy: 'yes', category: 'Stylized', released: '2025-07', native: '480p', sweet: '480p concept drafts', max: '720p', dur: '4-5s', fl2v: 'no', audio: 'no', notes: 'Early budget draft tier', strengths: 'Low credit cost, fast concept generation', weaknesses: 'Prone to visual noise and facial drift', tips: 'Keep clip lengths under 4s; apply negative prompts for noise.' },
  { model: 'Omni Human 1.5', relDate: '2025-08', natH: '480', natNote: '480p short-side base', swH: '720', maxH: '1080', upscaled: '480p base SR to 720p/1080p', durMax: '60', durNote: 'Up to 60s at 720p, 30s at 1080p', tier480: 'yes', tier540: 'no', tier720: 'yes', tier1080: 'yes', tier2k: 'no', tier4k: 'no', category: 'Avatar / Lip-Sync', released: '2025-12', native: '1080p', sweet: '1080p full-body avatar performance', max: '1080p', dur: '15s', fl2v: 'yes', audio: 'yes', notes: 'ByteDance full-body avatar & motion sync engine', strengths: 'Full-body character tracking, realistic body dynamics and speech alignment matching speech tone', weaknesses: 'Audio inputs >15s suffer from sync drift; requires clear un-obscured portrait', tips: 'Prompt with emotional intent ("spokesperson delivering confident presentation with natural head tilts"); keep audio <15s.' },
  { model: 'Kling 3.0 Omni', relDate: '2026-02', natH: '2160', natNote: 'Std 720p / Pro 1080p; 4K output; 9:16', maxH: '2160', maxFps: '30', durMin: '3', durMax: '15', tier480: 'no', tier540: 'no', tier720: 'yes', tier1080: 'yes', tier2k: 'no', tier4k: 'yes', category: 'Precision / Control', released: '2026-02', native: '1080p (base 3.0 renders native 4K/60)', sweet: '720p Standard drafts ($0.08/s), 1080p/4K Pro finals', max: '4K/60fps on base 3.0; Omni 1080p', dur: '3-15s, multi-shot up to 6 cuts', fl2v: 'yes', audio: 'yes', notes: 'Omni = unified engine (T2V+I2V+extend+storyboard)', strengths: 'Per-shot storyboard control with multi-shot sequencing; per-character lip-sync with voice binding to character; reference elements; Character Identity 3.0; Canvas Agent spatial control (4K/60 native on base 3.0, Omni caps 1080p)', weaknesses: 'Pro 4K costs 2x and renders slow; consistency frays past ~10s single takes', tips: 'Think director not photographer — Shot, Character, Action, Lighting, Extra; lead with camera language; small edits beat full rewrites; 1080p-min clean references; name light setups explicitly' },
  { model: 'Kling 3.0 Motion Control', relDate: '2026-05', natH: '1080', natNote: 'Std 720p / Pro 1080p; orientation follows input', maxH: '1080', durMax: '30', durNote: 'Ref-driven; 30s video-orientation, 10s image', tier480: 'no', tier540: 'no', tier720: 'yes', tier1080: 'yes', tier2k: 'no', tier4k: 'no', category: 'Precision / Control', released: '2026-02', native: '1080p', sweet: '1080p skeletal motion transfer', max: '1080p 30s', dur: '3-30s', fl2v: 'yes', audio: 'yes', notes: 'Video-to-video 3D skeletal motion transfer', strengths: '3D motion tracking, facial expression mirroring, athletic/dance transfer', weaknesses: 'Requires clean reference video without camera shake or occlusions', tips: 'Follow the 7-Image Rule (front, side, 3/4 profiles) to retain subject identity.' },
  { model: 'Kling 01', relDate: '2024-06', natW: '1920', natH: '1080', natNote: 'Std 1280x720; portrait 720x1280/1080x1920; square', swW: '1920', swH: '1080', swNote: 'Std 1280x720', maxW: '1920', maxH: '1080', maxFps: '30', durMin: '5', durMax: '10', tier480: 'no', tier540: 'no', tier720: 'yes', tier1080: 'yes', tier2k: 'no', tier4k: 'no', category: 'Cinematic Realism', released: '2024-06', native: '720p', sweet: '720p single subject', max: '720p', dur: '5s', fl2v: 'no', audio: 'no', notes: 'Foundational legacy Kling model', strengths: 'Early text-to-video baseline, basic fluid simulation', weaknesses: 'Severe digit/hand distortion, high visual drift', tips: 'Drive via I2V with simple single-subject prompts.' },
  { model: 'Grok Imagine Video 1.5', relDate: '2026-06', natH: '1080', natNote: 'Portrait 9:16/3:4/2:3 variants', swH: '1080', maxW: '1920', maxH: '1088', maxFps: '24', durMin: '1', durMax: '15', tier480: 'yes', tier540: 'no', tier720: 'yes', tier1080: 'yes', tier2k: 'no', tier4k: 'no', category: 'Cinematic Realism', released: '2025-12', native: '720p / 1080p', sweet: '1080p 6s in-feed', max: '1080p', dur: '5-15s', fl2v: 'yes', audio: 'yes', notes: 'Improved motion physics, faster inference in X/Grok', strengths: 'High prompt responsiveness, rapid generation speed, native audio, extended 15s clips', weaknesses: 'Platform-gated inside X/Grok UI; moderation block triggers on safety filter', tips: 'Focus on motion vectors and sensory sound descriptors; structure multi-segment timelines.' },
  { model: 'Grok Imagine Video', relDate: '2026-01', swH: '720', maxW: '1280', maxH: '720', maxFps: '24', durMin: '1', durMax: '15', tier480: 'yes', tier540: 'no', tier720: 'yes', tier1080: 'no', tier2k: 'no', tier4k: 'no', category: 'Cinematic Realism', released: '2025-08', native: '720p', sweet: '720p in-feed video', max: '720p', dur: '5s', fl2v: 'no', audio: 'yes', notes: 'Integrated into X/Grok', strengths: 'Fast generation speed, native audio synthesis', weaknesses: '720p ceiling, limited camera controls, start-frame driven only', tips: 'Keep prompts focused on single action sequences.' },
  { model: 'Gemini Omni 1.1 Flash', relDate: '2026-08', natH: '720', natNote: '360p draft native', swH: '720', maxH: '720', maxFps: '24', upscaled: 'Built-in upscale to 1080p/4K', durMin: '3', durMax: '40', tier480: 'no', tier540: 'no', tier720: 'yes', tier1080: 'no', tier2k: 'no', tier4k: 'no', category: 'Edit / Extend', released: '2026-03', native: '1080p / 4K', sweet: '1080p conversational video editing', max: '4K @ 40s', dur: '40s', fl2v: 'yes', audio: 'yes', notes: 'Conversational editing, scene extension up to 40s', strengths: '40s max duration per single pass, natural language video editing, multimodal reasoning', weaknesses: 'API latency on long 40s 4K generations', tips: 'Use conversational prompts for step-by-step scene extension ("Extend previous clip by 15s panning left").' },
  { model: 'Gemini Omni Flash', relDate: '2026-05', swH: '720', maxH: '720', maxFps: '24', durMin: '10', durMax: '20', tier480: 'no', tier540: 'no', tier720: 'yes', tier1080: 'no', tier2k: 'no', tier4k: 'no', category: 'Edit / Extend', released: '2025-11', native: '1080p', sweet: '1080p fast scene editing', max: '1080p', dur: '20s', fl2v: 'yes', audio: 'yes', notes: 'Fast multimodal video interaction model', strengths: 'Low latency, natural language editing instructions', weaknesses: 'Capped at 20s, lower detail than 1.1 Flash', tips: 'Use for quick iterative scene modifications.' },
  { model: 'Runway Gen-4S', relDate: '2025-09', natH: '720', swH: '720', maxH: '720', durMin: '5', durMax: '5', tier720: 'yes', tier1080: 'no', tier2k: 'no', tier4k: 'no', category: 'Cinematic Realism', released: '2025-09', native: '720p', sweet: '720p fast draft clips', max: '720p', dur: '5s', fl2v: 'yes', audio: 'no', notes: 'Fast/short variant of Runway Gen-4', strengths: 'Rapid inference, clean Motion Brush response', weaknesses: 'No native audio, 720p max resolution', tips: 'Use for fast camera motion draft passes with Motion Brush.' },
  { model: 'Runway Gen 4', relDate: '2025-03', natW: '1280', natH: '720', natNote: 'Vertical 720x1280; square + ultrawide buckets', swW: '1280', swH: '720', maxW: '1280', maxH: '720', maxFps: '24', maxNote: 'Widest 1584x672', upscaled: 'Runway 4K upscale (separate step)', durMin: '5', durMax: '10', tier480: 'no', tier540: 'no', tier720: 'yes', tier1080: 'no', tier2k: 'no', tier4k: 'no', crazy: 'no', category: 'Cinematic Realism', released: '2025-06', native: '720p / 1080p', sweet: '1080p @ 10s', max: '4K (Upscaled)', dur: '10s', fl2v: 'yes', audio: 'no', notes: 'Runway commercial diffusion stack', strengths: 'Cinematic lighting, camera control sliders, high aesthetic polish, character/world consistency', weaknesses: 'No native audio synthesis, fixed 5s/10s duration tiers', tips: 'Pair with Motion Brush for targeted element movement; use last-frame extraction bridge for multi-scene extensions.' },
  { model: 'Runway Gen 4 Turbo', relDate: '2025-04', natW: '1280', natH: '720', natNote: 'Vertical 720x1280; square + ultrawide buckets', swW: '1280', swH: '720', maxW: '1280', maxH: '720', maxFps: '24', maxNote: 'Widest 1584x672', upscaled: 'Runway 4K upscale (separate step)', durMin: '5', durMax: '10', tier480: 'no', tier540: 'no', tier720: 'yes', tier1080: 'no', tier2k: 'no', tier4k: 'no', crazy: 'no', category: 'Cinematic Realism', released: '2025-07', native: '720p / 1080p', sweet: '1080p @ 5s', max: '1080p', dur: '10s', fl2v: 'yes', audio: 'no', notes: 'Faster inference variant of Gen 4 (~3x faster)', strengths: 'Fast generation turnaround, crisp 1080p rendering', weaknesses: 'No native audio, slightly higher compression on background details', tips: 'Keep prompts concise (<50 words); ideal workhorse for volume B-roll production.' },
  { model: 'Runway Gen-4 Act Two', relDate: '2025-09', natW: '1280', natH: '720', natNote: 'Vertical 720x1280; square + ultrawide buckets', swW: '1280', swH: '720', maxW: '1280', maxH: '720', maxFps: '24', durMin: '3', durMax: '30', tier480: 'no', tier540: 'no', tier720: 'yes', tier1080: 'no', tier2k: 'no', tier4k: 'no', crazy: 'no', category: 'Avatar / Lip-Sync', released: '2026-01', native: '1080p', sweet: '1080p portrait performance transfer', max: '1080p', dur: '10s', fl2v: 'yes', audio: 'yes', notes: 'Character performance & lip-sync engine', strengths: '3D facial mesh deformation, facial micro-expression capture, speech alignment from driving video', weaknesses: 'Body remains static below chest/shoulders; extreme profile stills cause warping', tips: 'Provide clean front-facing target portrait still + driving performance video.' },
  { model: 'Sora 2 Pro', relDate: '2025-09', maxW: '1920', maxH: '1080', maxNote: 'Portrait 1080x1920; mid tier 1792x1024', durMin: '4', durMax: '20', durNote: '25 via Pro storyboard; up to ~60s narrative via multi-shot chaining; extensions to 120', tier480: 'no', tier540: 'no', tier720: 'yes', tier1080: 'yes', tier2k: 'no', tier4k: 'no', crazy: 'no', category: 'Cinematic Realism', released: '2025-09', native: '1080p', sweet: '1080p @ 25s', max: '1080p', dur: '25s storyboard; up to ~60s multi-shot narrative', fl2v: 'yes', audio: 'yes', notes: 'OpenAI Sora 2 production model', strengths: '3D Spacetime Physics Morphing, multi-agent physical simulation, object permanence, spatial audio, multi-shot continuity', weaknesses: 'Micro-particle physics collapse (glass shattering can turn gummy); camera rotation crumpling', tips: 'Use material science descriptors (viscous oil fluidity, 100% reflection matte-black titanium) and locked camera vectors; build 60s narratives as chained storyboard shots, not one prompt.' },
  { model: 'Sora 2 Max', relDate: '2025-10', natH: '2160', swH: '2160', maxH: '2160', durMin: '30', durMax: '30', tier720: 'yes', tier1080: 'yes', tier4k: 'yes', category: 'Cinematic Realism', released: '2025-10', native: '1080p / 4K', sweet: '1080p/4K @ 30s', max: '4K', dur: '30s', fl2v: 'yes', audio: 'yes', notes: 'OpenAI Sora 2 flagship render tier', strengths: 'Maximum spatial detail, fluid multi-subject physical collisions, 30s takes', weaknesses: 'High generation cost and latency; multi-person hand interactions suffer digit fusion', tips: 'Use for hero shots requiring complex multi-subject physics collisions; specify exact lens settings (50mm prime, f/2.0).' },
  { model: 'Hunyuan Video', relDate: '2024-12', natW: '1280', natH: '720', natNote: '540p bucket 960x544; portrait 720x1280', swW: '1280', swH: '720', maxW: '1280', maxH: '720', maxFps: '24', maxNote: '4K native in v2.0', durMin: '5', durMax: '5', tier480: 'no', tier540: 'yes', tier720: 'yes', tier1080: 'no', tier2k: 'no', tier4k: 'no', crazy: 'yes', category: 'Open / Self-Host', released: '2024-12', native: '720p / 1080p', sweet: '720p 121f (~5s @24fps) or 1080p', max: '4K (v2.0)', dur: '5-10s', fl2v: 'yes', audio: 'no', notes: 'Tencent 3D Causal VAE open-source transformer', strengths: 'High spatial fidelity, dual-stream attention (independent text & visual tokens), native 4K (v2.0)', weaknesses: 'Long text prompts can cause text-encoder timeout; heavy compute overhead on 4K', tips: 'Set target frame count to exactly 121 frames (5s @ 24/30fps); separate visual descriptors from camera commands.' },
  { model: 'LTX 2.3 Pro', relDate: '2026-03', natW: '1920', natH: '1080', swW: '1920', swH: '1080', maxW: '3840', maxH: '2160', maxFps: '50', durMin: '6', durMax: '10', tier480: 'no', tier540: 'no', tier720: 'yes', tier1080: 'yes', tier2k: 'yes', tier4k: 'yes', crazy: 'yes', category: 'Precision / Control', released: '2026-03', native: '1080p', sweet: '1080p 20s with audio', max: '4K via 2-stage upscale', dur: '20s', fl2v: 'yes', audio: 'yes', notes: 'Production-grade, audio sync', strengths: 'High bitrate 1080p/4K, native audio sync, 20s clip length', weaknesses: 'Requires 2-stage latent upscaling for native 4K', tips: 'Use LTX-2 Pro for high-bitrate hero renders; use 1080p 20s for music videos.' },
  { model: 'LTX 2 Fast', relDate: '2025-10', natW: '1920', natH: '1080', swW: '1920', swH: '1080', maxW: '3840', maxH: '2160', maxFps: '50', durMin: '6', durMax: '10', tier480: 'no', tier540: 'no', tier720: 'yes', tier1080: 'yes', tier2k: 'yes', tier4k: 'yes', crazy: 'yes', category: 'Precision / Control', released: '2026-01', native: '720p / 1080p', sweet: '1080p @24fps fast API', max: '4K @ 50fps', dur: '20s', fl2v: 'yes', audio: 'yes', notes: 'Optimized for speed', strengths: 'Fast inference, ranked high on Artificial Analysis Video Arena', weaknesses: 'Slightly lower textural sharpness than Pro tier', tips: 'Use LTX-2 Fast for low-latency draft iterations before submitting Pro hero renders.' },
  { model: 'PixVerse V6', relDate: '2026-03', natH: '1080', natNote: 'Landscape 1920x1080; vertical 1080x1920; 1:1', swH: '1080', maxW: '1920', maxH: '1080', durMin: '1', durMax: '15', tier480: 'no', tier540: 'yes', tier720: 'yes', tier1080: 'yes', tier2k: 'no', tier4k: 'no', crazy: 'yes', category: 'Precision / Control', released: '2026-03', native: '1080p', sweet: '1080p 15s with virtual camera controls', max: '1080p', dur: '15s', fl2v: 'yes', audio: 'yes', notes: 'Relaxed duration limits & 20+ lens controls', strengths: 'Granular lens controls (85mm portrait lens, aperture, focal length), 15s duration; ~1 reference supported', weaknesses: 'Steeper learning curve for camera parameter tuning', tips: 'Specify explicit lens parameters (85mm portrait lens, f/1.8 aperture, shallow depth of field) in prompt. First+last frame keyframing; Modify tool restyles existing video.' },
  { model: 'PixVerse C1', category: 'Precision / Control', native: '—', sweet: '—', max: '—', dur: '1–15s', fl2v: '?', audio: 'yes', crazy: 'yes', notes: 'Consistency/storyboard tier (comparison brief)', strengths: 'Reference-locked consistency across shots; storyboard control (3-9 panels)', weaknesses: 'Modify/restyle of existing video limited', tips: 'Drive multi-shot consistency via storyboard panels (3-9); reference-lock characters across shots', durMin: '1', durMax: '15' },
  { model: 'PixVerse V5.6', relDate: '2026-01', natH: '1080', natNote: 'Landscape 1920x1080; vertical 1080x1920; 1:1', swH: '720', maxW: '1920', maxH: '1080', durMin: '5', durMax: '8', tier480: 'no', tier540: 'yes', tier720: 'yes', tier1080: 'yes', tier2k: 'no', tier4k: 'no', category: 'Stylized', released: '2025-11', native: '1080p', sweet: '1080p @ 10s', max: '1080p', dur: '10s', fl2v: 'yes', audio: 'yes', notes: 'Anime & 3D stylized character animation', strengths: 'Vibrant motion, motion brush trajectories, anime/cyberpunk aesthetic', weaknesses: 'Waxy skin textures on photorealistic close-ups', tips: 'Draw explicit Motion Brush trajectories over target zone; use bracketed audio tags [sound of explosion].' },
  { model: 'PixVerse V5', relDate: '2025-08', natH: '1080', natNote: 'Landscape 1920x1080; vertical 1080x1920; 1:1', swH: '720', maxW: '1920', maxH: '1080', maxFps: '24', durMin: '5', durMax: '8', tier480: 'no', tier540: 'yes', tier720: 'yes', tier1080: 'yes', tier2k: 'no', tier4k: 'no', crazy: 'yes', category: 'Stylized', released: '2025-08', native: '1080p', sweet: '1080p @ 8s', max: '1080p', dur: '8s', fl2v: 'yes', audio: 'no', notes: 'Dynamic stylized animation engine', strengths: 'High motion responsiveness, vibrant visual styles', weaknesses: 'No native audio', tips: 'Keep prompts focused on visual style and atmosphere.' },
  { model: 'PixVerse V4.5', relDate: '2025-05', natH: '1080', natNote: 'Landscape 1920x1080; vertical 1080x1920; 1:1', swH: '720', maxW: '1920', maxH: '1080', upscaled: 'Separate 4K upscale pass (not native)', durMin: '5', durMax: '8', tier480: 'no', tier540: 'yes', tier720: 'yes', tier1080: 'yes', tier2k: 'no', tier4k: 'no', crazy: 'yes', category: 'Stylized', released: '2025-04', native: '1080p', sweet: '1080p @ 8s anime', max: '1080p', dur: '8s', fl2v: 'yes', audio: 'no', notes: 'Keyframe transition stability for anime', strengths: 'Fluid motion for 2D/3D illustrative artwork', weaknesses: 'Causes limb clipping in complex multi-subject scenes', tips: 'Keep camera movement prompts gentle.' },
  { model: 'PixVerse V4', relDate: '2025-02', natH: '1080', natNote: 'Landscape 1920x1080; vertical 1080x1920; 1:1', swH: '720', maxW: '1920', maxH: '1080', durMin: '5', durMax: '8', tier480: 'no', tier540: 'yes', tier720: 'yes', tier1080: 'yes', tier2k: 'no', tier4k: 'no', crazy: 'yes', category: 'Stylized', released: '2024-12', native: '1080p', sweet: '1080p @ 8s', max: '1080p', dur: '8s', fl2v: 'yes', audio: 'no', notes: '5s usually locked for 1080p', strengths: 'Early motion brush controls, vector graphics rendering', weaknesses: 'Prone to static human facial expressions', tips: 'Restrict prompts to single subjects.' },
  { model: 'Mochi 1', relDate: '2024-10', natW: '848', natH: '480', swW: '848', swH: '480', maxW: '848', maxH: '480', maxFps: '30', durMax: '5.4', durNote: '31-163 frames', tier480: 'yes', tier540: 'no', tier720: 'no', tier1080: 'no', tier2k: 'no', tier4k: 'no', crazy: 'yes', category: 'Open / Self-Host', released: '2024-10', native: '480p (848x480 native)', sweet: '480p @ 30fps (163f)', max: '848x480 (Native)', dur: '5.4s', fl2v: 'no', audio: 'no', notes: 'Genmo open-source Asymmetric Diffusion Transformer (AsymDiT)', strengths: 'Extreme organic motion fluidity, zero visual tearing during fast moves, fluid splash & cloth physics', weaknesses: 'Hard-locked to 848x480 native resolution (do NOT override; upscale externally)', tips: 'Pipe raw 848x480 output into spatial upscalers for 1080p; use hyper-kinetic force prompt terms (swirling vortex, fluid splash).' },
  { model: 'Pyramid Flow', relDate: '2024-10', natW: '1280', natH: '768', natNote: '384p checkpoint exists', swW: '1280', swH: '768', maxW: '1280', maxH: '768', maxFps: '24', durMin: '5', durMax: '10', tier480: 'no', tier540: 'no', tier720: 'no', tier1080: 'no', tier2k: 'no', tier4k: 'no', category: 'Open / Self-Host', released: '2024-10', native: '768p', sweet: '768p @ 24fps', max: '768p', dur: '10s', fl2v: 'yes', audio: 'no', notes: 'Pyramidal flow matching multi-resolution sampling', strengths: 'Efficient multi-scale sampling, open weights, 10s duration', weaknesses: 'Autoregressive spatial drift past 10s', tips: 'Configure lower step counts on initial coarse stages to establish motion blocking before spatial refinement.' },
  { model: 'ToonCrafter', relDate: '2024-05', natW: '512', natH: '320', natNote: 'Portrait 320x512', swW: '512', swH: '320', maxW: '512', maxH: '320', maxFps: '8', durMin: '2', durMax: '2', tier480: 'no', tier540: 'no', tier720: 'no', tier1080: 'no', tier2k: 'no', tier4k: 'no', category: 'Edit / Extend', released: '2024-05', native: '512x320', sweet: '512x320 @ 16f', max: '512x320', dur: '2s (16 frames max)', fl2v: 'yes', audio: 'no', notes: 'Generative 2D cartoon keyframe interpolation', strengths: 'Zero line art jitter in 2D animation, true generative line deconstruction/reconstruction between cartoon keyframes', weaknesses: 'Completely non-functional on photorealistic live-action footage; capped at 16 frames', tips: 'Input strictly 2D cartoon/anime keyframes; match color fills and vector outlines across both stills.' },
  { model: 'Play (Open MMLab)', relDate: '2023-12', swNote: '512 long-edge default, up to 1024', maxFps: '8', maxNote: 'Input-size dependent, 1024 long-edge max', durMin: '1', durMax: '3', durNote: '8-24f, default 16', tier480: 'no', tier540: 'no', tier720: 'no', tier1080: 'no', tier2k: 'no', tier4k: 'no', category: 'Stylized', released: '2024-04', native: '512p', sweet: '512p', max: '512p', dur: '4s', fl2v: 'no', audio: 'no', notes: 'Likely referring to PIA / MMagic toolboxes', strengths: 'Perception-Guided Image Animation research baseline', weaknesses: 'Low resolution, complex setup', tips: 'Use for research experimentation with custom motion control pipelines.' },
  { model: 'Runway Gen-4.5', category: 'Edit / Extend', native: '—', sweet: '—', max: '—', dur: 'Up to 10s (brief)', fl2v: '?', audio: 'no', crazy: 'no', notes: 'GWM-1 world model; video-to-video + generative editing (brief)', strengths: 'Motion Brush targeted movement, keyframe control, world-model consistency', weaknesses: 'No native audio (separate step)', tips: 'Pair Motion Brush with keyframes; bridge multi-scene extends via last-frame extraction', durMin: '5', durMax: '10' },
  { model: 'Pika 2.5', category: 'Stylized', native: '—', sweet: '—', max: '—', dur: 'Up to 10s (brief)', fl2v: '?', audio: '?', crazy: 'yes', notes: 'Fast-iteration stylized line; audio limited (brief)', strengths: 'Fast iteration, stylized/artistic consistency, effects shots', weaknesses: 'Audio limited; photoreal detail thinner than Veo/Sora tier', tips: 'Use for rapid style/effects drafts; keep prompts to one effect + one motion', durMin: '5', durMax: '10' },
  { model: 'FLUX 3 Video (Black Forest Labs · T2V + multi-frame I2V + continuation)', relDate: '2026-07', relNote: 'Announced Jul 23, 2026; Video + Action gated EA; image weeks later; Dev open weights later 2026; playground trial till Aug 17', natH: '720', natNote: 'Train res unpublished; early evals at 720p', swH: '720', maxW: '1920', maxH: '1080', durMin: '5', durMax: '20', tier720: 'yes', tier1080: 'yes', tier2k: 'no', tier4k: 'no', category: 'Unified multimodal frontier (Self-Flow: image, video and audio learned simultaneously so each constrains the others; FLUX-mimic robotics offshoot; not a bolt-on video head)', released: '2026-07 (announced July 23, 2026; Video + Action gated Early Access immediately; image side "coming weeks", open-weight Dev later 2026; public playground free trial until Aug 17)', native: 'BFL never published exact training res; all early evaluations run at 720p; API catalog flux_3_video (5-20s, 720p/1080p, the only entry with native 2:1 ratio); wrapper docs expose 480p / 720p / 1080p; joint image+video+audio train, not upscaled image', sweet: '720p Draft mode = cheap coherence lab: $0.06/s draft vs $0.29/s full (other routes 6 credits/s vs 17/s full, roughly 1:3; another breakdown $0.17/s draft, $0.43/s normal); physics holds best at 5-10s, 720p, single subject, slow/medium motion — fast combat still breaks; iterate in draft then enhance one keeper (drafts only save money when you iterate); 15-20s or 1080p first try burns money for drift', max: '20s single generation with native audio; max 1080p, no 4K', dur: '10s 720p T2V with audio was BFL benchmark; API wrappers default 4-10s; street take 5-8s testing, 10s delivery; 20s works for a full ad beat but compositional drift after ~12s unless locked with keyframes', fl2v: 'yes', audio: 'yes', notes: 'Same weights as the unified frontier model announced July 23, 2026 (one architecture: image, video, native synchronized audio); API flux_3_video 5-20s 720p/1080p, only native 2:1 entry', strengths: 'Human faces / skin sharper than FLUX.2 paid tools, natural micro-motion; lip-sync winner (Seedance visuals realistic but voice not nice, Omni Flash great lip-sync but plasticky and AI-sounding, Flux 3 super realistic — audio "sounds like she is in the room", multilingual dialogue + lip-sync legit good); "weird believable" retro TV footage, awkward interviews, fake docs; typography / product consistency locked better than Veo; chainable into minutes via agentic chaining with reference images', weaknesses: 'Smoked by Seedance 2.5 on motion ("seedance competitor, maybe seedance 2, fails so much vs 2.5"; carousel: Seedance outperformed across dialogue, product commercials, transitions; monster clip side-by-side darker, softer, less detailed); more expensive, restrictive censorship, less organic human physique rendering, limited reference-to-video support; needs prompt-constraint enforcement vs unwanted motion, inconsistencies, drift — fast action, crowds, hands drift past 12-15s; BFL 93% vs Luma / 77% vs Runway are "preliminary evaluation of an early FLUX 3 candidate", vs Seedance 2.0 and Omni Flash 52% = coin flip; no open weights yet, gated access (ComfyUI crowd locked out)', tips: 'Iterate in 720p Draft 5-10s single-subject slow/medium, then enhance one keeper; lock 12s+ compositions with keyframes (flux-3-flf-draft start_image_url + end_image_url, flux-3-keyframes-draft, or images_list T2V+I2V); enforce prompt constraints to cut unwanted motion/drift; reference images can serve as opening frames — no external audio input (generate_audio outputs dialogue, SFX, music matched to visuals only); FLF transitions are not physics-locked (blurry failed cut where Seedance delivered clean).' }
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
          <label class="ref-col-toggle" data-help-title="Toggle column">
            <input type="checkbox" ${checked} data-table="${tableType}" data-col="${c.key}">
          </label>
          <span class="ref-sort-arrow${sort.key === c.key ? '' : ' dim'}">${sort.key === c.key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ' ⇅'}</span>
        </span>
        <span class="ref-col-label" data-help-title="${esc(c.label)}">${esc(c.label)}</span>
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

function clearModelHot(table) {
  table.querySelectorAll('.ref-hot, .ref-colhot').forEach((el) => el.classList.remove('ref-hot', 'ref-colhot'));
}

function copyCellText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopyCellText(text));
  } else {
    fallbackCopyCellText(text);
  }
}

function fallbackCopyCellText(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch (err) { /* clipboard unavailable */ }
  ta.remove();
}

function bindSortableTables() {
  const table = elements.actionPanel.querySelector('.ref-models-table');
  if (table) {
    const cfg = table.getAttribute('data-mtable') === 'image' ? imageTableCfg()
      : table.getAttribute('data-mtable') === 'code' ? codeTableCfg()
      : table.getAttribute('data-mtable') === 'apis' ? apiTableCfg()
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
    // Video Big Chart only: hover crosshair (cell + column via classes, row
    // via CSS :hover) + click-to-copy. Delegated on the table so tbody
    // repaints survive; bound once via dataset flag. (Inside if(table) —
    // cfg is scoped here.)
    if (cfg.tableType === 'video' && !table.dataset.hotBound) {
    table.dataset.hotBound = '1';
    table.addEventListener('mouseover', (e) => {
      const td = e.target.closest ? e.target.closest('td') : null;
      if (!td || !table.contains(td)) return;
      clearModelHot(table);
      td.classList.add('ref-hot');
      const idx = td.cellIndex;
      table.querySelectorAll('tbody tr').forEach((r) => {
        const c = r.cells[idx];
        if (c && c !== td) c.classList.add('ref-colhot');
      });
    });
    table.addEventListener('mouseout', (e) => {
      if (e.target.closest && e.target.closest('td')) clearModelHot(table);
    });
    table.addEventListener('click', (e) => {
      const td = e.target.closest ? e.target.closest('td') : null;
      if (!td || !table.contains(td)) return;
      const text = td.textContent.trim();
      if (!text || text === '—') return;
      copyCellText(text);
      td.classList.add('ref-copied');
      setTimeout(() => td.classList.remove('ref-copied'), 650);
      });
    }
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
/* Coding-model detail pages: every overview row opens its own page; the model
   chip strip under the sub-tab bar is the model nav. Survives tab switches. */
let codeModelOpen = null;
let apiPageOpen = null;

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

/* Columns hidden by default (no stored pref yet): the split-schema numerics
   and tier badges. Existing 14 columns stay visible; toggles re-show these. */
const DEFAULT_HIDDEN_COLS = {
  video: new Set(['relDate', 'relNote', 'natW', 'natH', 'natNote', 'swW', 'swH', 'swNote', 'maxW', 'maxH', 'maxFps', 'maxNote', 'upscaled', 'tier480', 'tier540', 'tier720', 'tier1080', 'tier2k', 'tier4k', 'durMin', 'durMax', 'durNote']),
};

function isColVisible(tableType, key) {
  const t = colVisibility[tableType];
  if (!t || !(key in t)) {
    const hidden = DEFAULT_HIDDEN_COLS[tableType];
    if (hidden && hidden.has(key)) return false;
    if (!t) return true;
    return t[key] !== false;
  }
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
  { key: 'relDate', label: 'Rel Date', cls: 'ref-col-center' },
  { key: 'relNote', label: 'Rel Note' },
  { key: 'native', label: 'Native Training Res' },
  { key: 'natW', label: 'Native W', cls: 'ref-col-center' },
  { key: 'natH', label: 'Native H', cls: 'ref-col-center' },
  { key: 'natNote', label: 'Native Note' },
  { key: 'sweet', label: 'Sweet Spot for Physics / Coherence — Cheap' },
  { key: 'swW', label: 'Sweet W', cls: 'ref-col-center' },
  { key: 'swH', label: 'Sweet H', cls: 'ref-col-center' },
  { key: 'swNote', label: 'Sweet Note' },
  { key: 'max', label: 'Max Output' },
  { key: 'maxW', label: 'Max W', cls: 'ref-col-center' },
  { key: 'maxH', label: 'Max H', cls: 'ref-col-center' },
  { key: 'maxFps', label: 'Max FPS', cls: 'ref-col-center' },
  { key: 'maxNote', label: 'Max Note' },
  { key: 'upscaled', label: 'Upscaled' },
  { key: 'tier480', label: '480p', cls: 'ref-col-center' },
  { key: 'tier540', label: '540p', cls: 'ref-col-center' },
  { key: 'tier720', label: '720p', cls: 'ref-col-center' },
  { key: 'tier1080', label: '1080p', cls: 'ref-col-center' },
  { key: 'tier2k', label: '2K', cls: 'ref-col-center' },
  { key: 'tier4k', label: '4K', cls: 'ref-col-center' },
  { key: 'dur', label: 'Duration Sweet Spot' },
  { key: 'durMin', label: 'Dur Min (s)', cls: 'ref-col-center' },
  { key: 'durMax', label: 'Dur Max (s)', cls: 'ref-col-center' },
  { key: 'durNote', label: 'Dur Note' },
  { key: 'fl2v', label: 'True FL2V', cls: 'ref-col-center' },
  { key: 'audio', label: 'Audio', cls: 'ref-col-center' },
  { key: 'crazy', label: 'Does Crazy', cls: 'ref-col-center' },
  { key: 'strengths', label: 'Strengths' },
  { key: 'weaknesses', label: 'Weaknesses' },
  { key: 'tips', label: 'Use / Prompt Tips' },
  { key: 'notes', label: 'Notes' },
];

function modelsSortValue(r, key) {
  if (key === 'sweet') return [r.sweet, r.warn || ''].filter((v) => v && v !== '—').join(' — ');
  if (key === 'fl2v' || key === 'audio' || key === 'crazy' || key.startsWith('tier')) return { yes: '0', '?': '1', no: '2' }[r[key]] || '1';
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
  const num = (v) => (v ? `<span class="ref-cell">${esc(v)}</span>` : '<span class="ref-muted">—</span>');
  const tier = (v) => (v ? fl2vBadge(v) : '<span class="ref-muted">—</span>');
  return `<tr${r.highlight ? ' class="ref-highlight"' : ''}>
    <td><span class="ref-lic-name">${esc(r.model)}</span></td>
    <td>${category}</td>
    <td>${released}</td>
    <td class="ref-col-center">${num(r.relDate)}</td>
    <td>${num(r.relNote)}</td>
    <td><span class="ref-cell">${esc(r.native)}</span></td>
    <td class="ref-col-center">${num(r.natW)}</td>
    <td class="ref-col-center">${num(r.natH)}</td>
    <td>${num(r.natNote)}</td>
    <td>${sweet}</td>
    <td class="ref-col-center">${num(r.swW)}</td>
    <td class="ref-col-center">${num(r.swH)}</td>
    <td>${num(r.swNote)}</td>
    <td><span class="ref-cell">${esc(r.max)}</span></td>
    <td class="ref-col-center">${num(r.maxW)}</td>
    <td class="ref-col-center">${num(r.maxH)}</td>
    <td class="ref-col-center">${num(r.maxFps)}</td>
    <td>${num(r.maxNote)}</td>
    <td>${num(r.upscaled)}</td>
    <td class="ref-col-center">${tier(r.tier480)}</td>
    <td class="ref-col-center">${tier(r.tier540)}</td>
    <td class="ref-col-center">${tier(r.tier720)}</td>
    <td class="ref-col-center">${tier(r.tier1080)}</td>
    <td class="ref-col-center">${tier(r.tier2k)}</td>
    <td class="ref-col-center">${tier(r.tier4k)}</td>
    <td><span class="ref-cell">${esc(r.dur)}</span></td>
    <td class="ref-col-center">${num(r.durMin)}</td>
    <td class="ref-col-center">${num(r.durMax)}</td>
    <td>${num(r.durNote)}</td>
    <td class="ref-col-center">${fl2vBadge(r.fl2v)}</td>
    <td class="ref-col-center">${fl2vBadge(r.audio)}</td>
    <td class="ref-col-center">${r.crazy ? fl2vBadge(r.crazy) : '<span class="ref-muted">—</span>'}</td>
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
   BigPickle was dropped as unconfirmed by that pass; the user's own
   usage confirms it, and its page carries a community verdict.
   Unconfirmed cells render `—` (sort last) until verified.
   ═══════════════════════════════════════════════ */
const CODE_MODELS_ROWS = [
  { model: 'Kimi K3', provider: 'Moonshot AI', context: '1M', strengths: '2.8T-param MoE, native vision, built for multi-hour repo-scale sessions; largest open-weight model in this set', benchmarks: 'AA Index 44 — beats Opus 4.8 (42)', availability: '—', bestfor: 'Biggest, longest-horizon open coder; custom license w/ revenue share' },
  { model: 'GLM-5.2', provider: 'Zhipu AI', context: '1M', strengths: '753B MoE (~40B active); holds project-scale context well — retains module boundaries across long tasks', benchmarks: 'AA Index 34 · Antigma TB 2.1 74.6% (81.0 vendor-only)', availability: '—', bestfor: 'Repo-scale coding agents — strongest open-weight coding benchmarks', highlight: true },
  { model: 'GLM-5.3', provider: 'Zhipu AI', context: '1M', strengths: 'Post-trained upgrade of 5.2 base; leads on CyberGym vulnerability discovery in its comparison set', benchmarks: 'AA Index 45 — ties Qwen3.8 Max as top verified open', availability: '—', bestfor: 'Security-adjacent code review and vuln discovery workflows' },
  { model: 'DeepSeek V4 Pro', provider: 'DeepSeek', context: '1M', strengths: '1.6T-param MoE (49B active); native OpenAI + Anthropic-compatible API, drops into agent harnesses directly', benchmarks: 'AA Index 36 · Antigma TB 2.1 69.1% — "best open" contradicted', availability: '—', bestfor: 'Max open-weight capability where token cost is secondary' },
  { model: 'Kimi K2.6', provider: 'Moonshot AI', context: '256K', strengths: '1T/32B MoE, open-weight, native multimodal; Agent Swarm scales to 300 sub-agents / 4,000 steps', benchmarks: 'SWE-Bench Pro 58.6% (ties GPT-5.5, third-party writeups)', availability: '—', bestfor: 'Swarm-style parallel agent orchestration' },
  { model: 'Kimi K2 Thinking', provider: 'Moonshot AI', context: '256K', strengths: 'Interleaves chain-of-thought with tool calls across 200–300 sequential calls without drift', benchmarks: 'SOTA at release: HLE, BrowseComp, LiveCodeBench', availability: '—', bestfor: 'Long tool-call chains; weaker prose / non-English quality' },
  { model: 'Qwen3.8 27B', provider: 'Alibaba', context: '262K–1M', strengths: 'Efficiency architecture preview for Qwen4; Flash-Next activates ~6B of 125B + 51B N-gram layer', benchmarks: 'AA Index 34 · SWE-bench Pro 61.7 (HF card)', availability: '—', bestfor: 'Frontier-adjacent quality on small-team compute budgets' },
  { model: 'DeepSeek V4 Flash', provider: 'DeepSeek', context: '1M', strengths: '284B/13B-active MoE, same 1M stack as Pro at ~1/3 price; fast, cheap, chatty', benchmarks: 'TB 2.1 82.7% independently reproduced (Antigma)', availability: '—', bestfor: 'Budget agentic coding at 1M context' },
  { model: 'Nemotron 3 Ultra', provider: 'NVIDIA', context: '1M', strengths: '550B/55B-active hybrid Mamba-Transformer MoE; fast, controllable open worker for pipelines', benchmarks: 'AA Intelligence Index: 48 (leading US open-weight in snapshot)', availability: '*+', bestfor: 'Terminal / review pipelines needing speed over peak reasoning' },
  { model: 'Qwen3.6 Flash', provider: 'Alibaba', context: '262K–1M', strengths: '35B/3B MoE vision-language Flash tier; spatial visual understanding', benchmarks: 'AA Index 18 · SWE-bench Verified 73.4 (vendor)', availability: '—', bestfor: 'Fast multimodal drafts, cost-sensitive agent loops' },
  { model: 'MiniMax M3', provider: 'MiniMax', context: '~1M', strengths: 'Open-weight coding + multimodal; the practical pick when you need local deploy / fine-tuning', benchmarks: 'AA Index 29 · SWE-bench Verified 80.5 (HF card)', availability: '—', bestfor: 'Local / self-hosted coding-agent deployment' },
  { model: 'Inkling', provider: 'Thinking Machines', context: '1M', strengths: '975B/41B-active multimodal MoE; trained in randomized harnesses; self-directed fine-tuning via Tinker', benchmarks: 'AA Intelligence Index: 41 (top US open-weight at release; behind Opus 4.8 at 56)', availability: '+', bestfor: 'Fine-tuning base, not out-of-box frontier performance' },
  { model: 'Ling 3.0 Flash', provider: 'InclusionAI', context: '256K', strengths: '124B/5.1B-active MoE; token-efficient agentic inference from 10K+ interactive training envs', benchmarks: 'AA Index 20 · AIME 2026 93.2 (vendor)', availability: '*', bestfor: 'High-frequency agent loops; free slot may have rotated — re-check' },
  { model: 'Nemotron 3 Super', provider: 'NVIDIA', context: '1M', strengths: '120B/12B-active hybrid Mamba MoE; context-gathering workhorse ahead of frontier reasoners', benchmarks: 'Production use: CodeRabbit PR-review context stage', availability: '+', bestfor: 'Long-context summarization / retrieval stage in a pipeline' },
  { model: 'Llama 4 Maverick', provider: 'Meta', context: '1M', strengths: '400B/17B-active MoE, natively multimodal; solid 2025 generalist (source “178B” figure was wrong)', benchmarks: 'AA Index 10 — 2025 claims contradicted', availability: '—', bestfor: 'Multimodal on a budget; dated vs mid-2026 open field' },
  { model: 'Inkling Small', provider: 'Thinking Machines', context: '1M', strengths: '276B/12B-active sibling; near-Inkling quality at much lower cost', benchmarks: 'AA Index 26 · SWE-bench Verified 80.2 (vendor)', availability: '+', bestfor: 'Cost-sensitive coding / grading tasks' },
  { model: 'Nemotron 3 Nano', provider: 'NVIDIA', context: '1M', strengths: '4B / 30B-A3B tiers; 4x throughput over Nemotron 2 Nano; fits single consumer GPU at 4-bit', benchmarks: '—', availability: '+', bestfor: 'Lightweight pipeline steps, routing, simple extraction' },
  { model: 'Muse Spark 1.3', provider: 'Meta', context: '1M', strengths: 'Closed-weight agentic orchestrator; plans, delegates across subagents, tools, multimodal inputs', benchmarks: 'AA Index 48 vs Sol 47 / Opus 5 51 — corroborated', availability: '*', bestfor: 'Top overall free pick right now', highlight: true },
  { model: 'Muse Spark 1.2', provider: 'Meta', context: '1M', strengths: 'Same orchestrator line as 1.3, one generation behind; closed weight, no local deploy', benchmarks: 'AA Index 40', availability: '*', bestfor: 'Use 1.3 instead unless pinned for a reason' },
  { model: 'Mistral Medium', provider: 'Mistral AI', context: '256K (3.5)', strengths: '3.5: 128B dense "first flagship merged model"; 3.1 deprecated (retired 2026-08-31)', benchmarks: 'Vendor (3.5): SWE-bench Verified 77.6%', availability: '—', bestfor: 'General coding/reasoning at mid price — pin 3.5' },
  { model: 'Mistral Small', provider: 'Mistral AI', context: '256K', strengths: 'Small 4: 119B/6.5B MoE unifying instruct/reasoning/coding', benchmarks: 'Vendor: GPQA Diamond 71.2', availability: '—', bestfor: 'Fast drafts, simple pipeline steps' },
  { model: 'MiniMax M2.7', provider: 'MiniMax', context: '200K', strengths: '~230B/10B MoE billed as a self-evolving agent model', benchmarks: 'AA Index 23 · SWE-bench Pro 56.2 (vendor)', availability: '—', bestfor: 'Superseded by M3 — pin only for a specific reason' },
  { model: 'Gemma 4 26B / 31B', provider: 'Google DeepMind', context: '256K', strengths: 'First Apache-licensed + first MoE Gemma; multimodal, 140+ languages', benchmarks: 'Vendor: LiveCodeBench v6 77.1–80.0', availability: '—', bestfor: 'Small open multimodal — edge / consumer GPU' },
  { model: 'gpt-oss 120B / 20B', provider: 'OpenAI', context: '128K', strengths: 'STEM/coding MoE pair — 117B/5.1B and 21B/3.6B active', benchmarks: 'Vendor: SWE-bench Verified 45.8–60.7%', availability: '—', bestfor: 'Small open STEM baseline; single-GPU deploy' },
  { model: 'North Mini Code', provider: 'Cohere', context: '256K', strengths: 'Cohere "North" family; 30B/3B MoE for agentic coding; ~73 tok/s live', benchmarks: 'AA: Coding Index 33.4 · Agentic 21.7 · GPQA 75.7%', availability: '+', bestfor: 'Coding-focused agentic on one GPU' },
  { model: 'MiMo V2.5', provider: 'Xiaomi', context: '1M', strengths: '1.02T/42B MoE, hybrid attention; 1M-context retention (vendor card)', benchmarks: 'Vendor: 512K/1M retention 0.56–0.92 / 0.37–0.62', availability: '*', bestfor: 'Long-context open-weight coding' },
  { model: 'Nemotron 3.5 Lightning', provider: 'NVIDIA', context: '—', strengths: 'Plausible .5 point release in Nemotron 3 line; no first-party page found', benchmarks: '—', availability: '+', bestfor: 'Needs first-party spec check' },
  { model: 'Nemotron 3 Nano Omni', provider: 'NVIDIA', context: '—', strengths: 'Plausible omni-modal small variant; no first-party page found', benchmarks: '—', availability: '+', bestfor: 'Needs first-party spec check' },
  { model: 'Nemotron 3.5 Content Safety', provider: 'NVIDIA', context: '—', strengths: 'Safety-classifier variant, not a coding driver — kept so the name is not re-added as a mystery model', benchmarks: '—', availability: '+', bestfor: 'Safety classification, not code generation' },
  { model: 'BigPickle', provider: '—', context: '—', strengths: 'Fast free workhorse — community-verified: 10k+ line codebases, code review, clean tool calls; weak on frontend and long multi-domain planning', benchmarks: '—', availability: '*', bestfor: 'User-confirmed free fallback: small-to-medium backend tasks, review, exploration; rotating backend — experience varies by week. Full community verdict on its page' },
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
        <h2>Coding Models<span class="ref-sub">Verified open-weight comparison for OpenCode / Kilo use — benchmarks quote provenance · click a model name for its page</span></h2>
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
          <p>Curated from <strong>docs/llm_mod_ref.md</strong> (Sept 2026 gateway-list verification). Avail. is <strong>+ throughout</strong>: free-tier status was not re-verified per model — check the gateway live list. Benchmark cells say vendor vs AA/third-party. Dropped as unconfirmed: Charm, Dots3-Note, Laguna S/XS, “Latest”, Ling Sante/Fin. (BigPickle was on that list — since confirmed by real use; its page carries the community verdict.) Real agent-loop performance can differ from benchmarks — test a couple on your own repo.</p>
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
    <td><button type="button" class="ref-model-link" data-open-model="${esc(r.model)}" data-help-title="Open ${esc(r.model)} page">${esc(r.model)}</button></td>
    <td><span class="ref-cell">${esc(r.provider)}</span></td>
    <td><span class="ref-cell">${esc(r.context)}</span></td>
    <td><span class="ref-cell">${esc(r.strengths)}</span></td>
    <td>${benchmarks}</td>
    <td class="ref-col-center"><span class="ref-cell">${esc(r.availability)}</span></td>
    <td>${bestfor}</td>
  </tr>`;
}

/* ── Per-model pages ──
   Keyed by the overview row's `model` string. Each page has `details`
   (mined from docs/llm_mod_ref.md — Sept 2026 pass — plus a 2026-10-09
   web-research pass over live gateway catalogs, HF model cards and
   Artificial Analysis pages; provenance is noted in the text) and
   optionally `verdicts` (the community Category|Verdict|Notes table).
   A field that is null/absent renders a literal <placeholder> so the gaps
   are visible and greppable; models without verdicts get the 10-category
   skeleton with <placeholder> cells. Verdict tones map to the house badge
   colors (green/amber/red); the emoji is the source table's marker. */
const VERDICT_CATEGORIES = ['Code (general)', 'Debug', 'Plan', 'Agentic Use', 'Tool Use', 'Frontend / UI', 'Speed', 'Reliability', 'Reasoning / Analysis', 'Cost'];
const PLACEHOLDER = '<span class="ref-placeholder">&lt;placeholder&gt;</span>';

const CODE_MODEL_PAGES = {
  'DeepSeek V4 Pro': {
    details: {
      provider: 'DeepSeek',
      released: '2026-04 (preview) / 2026-08-13 GA (V4-Pro-0813)',
      context: '1M (384K max output)',
      params: '1.6T total / 49B active MoE; hybrid CSA+HCA sparse attention',
      availability: 'NOT FREE — paid on OpenRouter / Zen / Kilo ($0.21/$0.42 per M on OpenRouter); no :free variant in live catalogs (2026-10-09)',
      strengths: 'Strong agentic coding benchmarks; native OpenAI + Anthropic-compatible API (drops into Claude Code / OpenCode without a proxy).',
      weaknesses: "Self-reported superiority claims aren't independently verified — the AA index contradicts them (below). Heavier compute footprint than the Flash sibling.",
      personality: 'Reasoning-heavy, willing to grind long-horizon tasks — "a big model that wants to think before it types."',
      bestfor: 'Long-horizon agentic coding; maximum open-weight capability where token cost is secondary.',
      benchmarks: 'Independent: AA Intelligence Index 36 (0813 Max); Antigma Terminal-Bench 2.1 69.1% ±2.24. Vendor "best open-source" claim contradicted — GLM-5.3 (45), Qwen3.8 Max (45), Kimi K3 (44) all score higher.',
      compare: 'GLM-5.2 — GLM is more coding-benchmark-focused and cheaper; V4 Pro leans on raw scale.',
      sources: ['https://api-docs.deepseek.com/news/news260424/', 'https://www.morphllm.com/deepseek-v4', 'https://deepinfra.com/deepseek-ai/DeepSeek-V4-Pro', 'https://artificialanalysis.ai/models/deepseek-v4-pro', 'https://antigma.ai/eval'],
    },
  },
  'DeepSeek V4 Flash': {
    details: {
      provider: 'DeepSeek',
      released: '2026-04 (preview) / 2026-07-31 GA (V4-Flash-0731)',
      context: '1M (384K max output)',
      params: '284B total / 13B active MoE',
      availability: 'NOT FREE — deepseek-v4-flash:free removed ~2026-05; paid on OpenRouter / Zen / Kilo (2026-10-09)',
      strengths: 'Same 1M stack as Pro at ~1/3 price; big post-training jump on Terminal-Bench 2.1 and DeepSWE from preview to GA.',
      weaknesses: 'Runs verbose — ~2x the output-token cost per Intelligence-Index run vs similarly-sized models; ~1 point behind Pro on the AA index despite the price gap.',
      personality: 'Fast, cheap, chatty — good for high-throughput loops where you pay per call.',
      bestfor: 'Budget agentic coding, high-volume tool-use pipelines, fast drafts at 1M context.',
      benchmarks: 'Independent (Antigma, 2026-08-09): Terminal-Bench 2.1 82.7% ±1.79 reproduced — the 61.8→82.7 post-training jump confirmed (pre-release build 66.4%). DeepSWE 7.3→54.4 is vendor-only, no independent score.',
      compare: 'Qwen3.8 27B — similarly cheap+fast tier; Alibaba\'s own numbers claim Qwen edges it on coding/office.',
      sources: ['https://www.morphllm.com/deepseek-v4-flash', 'https://openrouter.ai/deepseek/deepseek-v4-flash', 'https://lmstudio.ai/models/deepseek-v4-flash', 'https://www.orcarouter.ai/blog/deepseek-v4-flash-arc-verified', 'https://antigma.ai/eval'],
    },
  },
  'GLM-5.2': {
    details: {
      provider: 'Zhipu AI (Z.ai)',
      released: '2026-06-13, MIT license',
      context: '1M (128K max output; Together AI serves it at 262K in FP4)',
      params: '753B total / ~40B active MoE, IndexShare sparse attention',
      availability: 'NOT FREE — paid on OpenRouter / Kilo / Zen / Vercel ($0.19/$1.80 per M); no live :free listing (2026-10-09)',
      strengths: 'Strongest open-weight model on standard coding benchmarks at release: SWE-bench Pro 62.1 (beats GPT-5.5\'s 58.6), Terminal-Bench 2.1 81.0 (vendor).',
      weaknesses: 'Verbose — ~43K output tokens per Index task (37K reasoning) vs 16K for GPT-5.5. Real latency/cost overhead.',
      personality: 'Holds project-scale context well — users report it retaining module boundaries and architectural constraints across long tasks.',
      bestfor: 'Long-horizon repo-scale coding agents; doesn\'t lose the plot after 50 tool calls.',
      benchmarks: 'Independent: AA Index 34; Antigma Terminal-Bench 2.1 74.6% ±2.06 (the claimed 81.0 is vendor-only). SWE-bench Pro 62.1 vendor-only.',
      compare: 'DeepSeek V4 Pro — GLM wins standard coding benchmarks head-to-head; DeepSeek has the bigger raw parameter count.',
      sources: ['https://docs.z.ai/guides/llm/glm-5.2', 'https://www.morphllm.com/glm-5-2', 'https://docs.together.ai/docs/glm-5.2-quickstart', 'https://artificialanalysis.ai/models/glm-5-2', 'https://antigma.ai/eval'],
    },
  },
  'GLM-5.3': {
    details: {
      provider: 'Zhipu AI (Z.ai)',
      released: '2026-08-14 (API), weights public 2026-08-25 under custom GLM-5.3 License',
      context: '1M',
      params: '743B base, post-training upgrade of 5.2',
      availability: 'NOT FREE — paid everywhere checked (Z.ai $1.40/$4.40 per M); only off-gateway third-party free aliases (2026-10-09)',
      strengths: 'Same 743B base as 5.2, upgraded via post-training only. Leads on CyberGym vulnerability discovery among the compared labs.',
      weaknesses: 'Zhipu\'s own notes flag it mixed vs Claude Opus 4.8 depending on task, and it plainly trails Claude Fable 5 on their internal coding benchmark. Release table mixed three Anthropic models across sections — read footnotes before quoting.',
      personality: 'Same behavioral profile as 5.2, sharpened post-training rather than a new brain.',
      bestfor: 'Security-adjacent code review and vuln-discovery workflows; long-horizon coding where 5.2 already fit.',
      benchmarks: 'Independent: AA Intelligence Index 45 — ties Qwen3.8 Max as the highest open-weight score verified (2026-10-09). Terminal-Bench 3.0 28.3 is vendor-only (own scale).',
      compare: 'Kimi K3 — both landed within weeks; Kimi is bigger (2.8T) and self-reported ahead on more tasks, GLM is cheaper to run.',
      sources: ['https://www.artificialintelligence-news.com/news/zhipu-glm-5-3-benchmarks-explained/', 'https://vercel.com/ai-gateway/models/glm-5.3-flash/latency', 'https://artificialanalysis.ai/models/glm-5-3'],
    },
  },
  'Kimi K2 Thinking': {
    details: {
      provider: 'Moonshot AI',
      released: '2025-11',
      context: '256K (262,144)',
      params: '1T total / 32B active MoE, native INT4',
      availability: 'NOT FREE — paid on OpenRouter and Kilo ($0.60/$2.50 per M); not listed on Zen (2026-10-09)',
      strengths: 'Interleaves chain-of-thought with tool calls across 200–300 sequential calls without drift; set open-source SOTA at release on HLE, BrowseComp, SWE-Multilingual, LiveCodeBench.',
      weaknesses: 'Independent review found it below the non-thinking K2 Instruct on creative-writing quality; undertrained-feeling non-English output. Superseded on coding by K2.6/K2.7/K3.',
      personality: 'A reasoning grinder — stays on task through very long tool-call chains, weaker on prose quality.',
      bestfor: 'Long-horizon autonomous research/coding tasks needing hundreds of sequential tool calls without the model wandering.',
      benchmarks: 'HLE / BrowseComp / LiveCodeBench SOTA at release (2025-11).',
      compare: 'DeepSeek V4 Pro — similar MoE scale class; Kimi wins on sustained tool-call stability, DeepSeek on raw benchmark breadth.',
      sources: ['https://openrouter.ai/moonshotai/kimi-k2-thinking', 'https://ndurner.substack.com/p/kimi-k2-thinking', 'https://leanware.co/insights/kimi-k2'],
    },
  },
  'Kimi K2.6': {
    details: {
      provider: 'Moonshot AI',
      released: '2026-04-20',
      context: '256K (262,144)',
      params: '1T total / 32B active MoE, native multimodal',
      availability: 'NOT FREE — paid on OpenRouter, Kilo, and Zen (2026-10-09)',
      strengths: 'Open-weight, native multimodal; "Agent Swarm" scales to 300 sub-agents / 4,000 coordinated steps. Ties GPT-5.5 on SWE-Bench Pro (58.6%) per third-party writeups; leads HLE-with-tools (54.0%) in some comparisons.',
      weaknesses: 'Headline capability is sustained autonomous execution, not peak single-shot benchmark score.',
      personality: 'Built for horizontal scale-out — many cheap agents working in parallel rather than one very deep reasoner.',
      bestfor: 'Swarm-style agent orchestration, large parallel task decomposition.',
      benchmarks: 'SWE-bench Pro 58.6% (ties GPT-5.5, third-party).',
      compare: 'Claude Opus 4.6/4.7 — writeups position it ~80% cheaper per token while trading blows on SWE-bench Pro.',
      sources: ['https://llm-stats.com/models/kimi-k2.6', 'https://miraflow.ai/blog/kimi-k2-6-explained-moonshot-ai-open-source-model-ties-gpt-5-5-coding', 'https://huggingface.co/moonshotai/Kimi-K2.6'],
    },
  },
  'Kimi K3': {
    details: {
      provider: 'Moonshot AI',
      released: '2026-07-16 (API), weights July 27 under Kimi K3 License (custom, revenue-share above $20M/yr inference revenue)',
      context: '1M (1,048,576)',
      params: '2.8T total, native vision, Delta Attention + Attention Residuals',
      availability: 'NOT FREE — paid on OpenRouter ($0.80/$13.50 per M), Kilo, Zen; Copilot access is paid-plan only (2026-10-09)',
      strengths: '2.8T total params (largest open-weight at writing), native vision. Moonshot places it ahead of Claude Opus 4.8 and GPT-5.5 on several coding/agent tasks.',
      weaknesses: 'Custom license, not clean permissive open-weight — 30% revenue-share for large inference providers. "Open weight" claims launched slightly ahead of the weights shipping.',
      personality: 'The family heavyweight — built for multi-hour engineering sessions across large repos.',
      bestfor: 'The biggest, longest-horizon coding/agent tasks you\'d otherwise reach for a closed frontier model.',
      benchmarks: 'Independent: AA Intelligence Index 44 — beats Claude Opus 4.8 (42) on the same composite. Coding/agent-specific "ahead of Opus 4.8/GPT-5.5" claims vendor-only.',
      compare: 'Claude Fable 5 / GPT-5.6 Sol — Moonshot\'s own marketing comparison; independent confirmation thinner than for K2.6.',
      sources: ['https://en.wikipedia.org/wiki/Kimi_(AI)', 'https://amplifilabs.com/post/kimi-k3-the-complete-guide-to-moonshot-ais-2-8t-model', 'https://github.com/MoonshotAI/Kimi-K3', 'https://openrouter.ai/moonshotai/kimi-k3', 'https://artificialanalysis.ai/models/kimi-k3'],
    },
  },
  'Qwen3.6 Flash': {
    details: {
      provider: 'Alibaba (Qwen team)',
      released: '2026-04-15/16; Apache 2.0 (API alias qwen3.6-flash)',
      context: '262,144 native, extensible to ~1.01M; max output 65,536',
      params: '35B total / 3B active (AA lists 36B); sparse MoE + hybrid linear attention',
      availability: 'NOT FREE — paid on OpenRouter ($0.19/$1.13 per M) and Kilo; absent from Zen (2026-10-09)',
      strengths: 'Native vision-language Flash tier; fast/cheap agentic coding with spatial visual understanding (object localization/detection).',
      weaknesses: 'Flash tier — not the reasoning-depth flagship; superseded by the Qwen3.7/3.8 lines within the year.',
      personality: 'Quick, cost-efficient, multimodal-first.',
      bestfor: 'Fast drafts, cost-sensitive agent loops that also need image/video input.',
      benchmarks: 'Vendor (HF card): SWE-bench Verified 73.4, Terminal-Bench 2.0 51.5. Independent: AA Intelligence Index 18.',
      compare: 'DeepSeek V4 Flash — similar fast/cheap positioning; Qwen adds native vision, DeepSeek focuses text/code.',
      sources: ['https://huggingface.co/Qwen/Qwen3.6-35B-A3B', 'https://artificialanalysis.ai/models/qwen3-6-35b-a3b', 'https://www.mindstudio.ai/models/qwen-3-6-flash', 'https://opencode.ai/data/alibaba'],
    },
  },
  'Qwen3.8 27B': {
    details: {
      provider: 'Alibaba (Qwen team)',
      released: '"27B" naming confirmed — HF repo 2026-08-05 (AA lists 2026-08-14), Apache 2.0. Flash-Next: HF 2026-08-24, Qwen Community License 1.0',
      context: '262,144 native, extensible to 1M (YaRN) — both variants',
      params: '27B: 64 layers (48 Gated DeltaNet linear attention + 16 gated attention), hidden 5,120. Flash-Next: 180B total / 6B active MoE + 51B n-gram table + 4B MTP module',
      availability: 'NOT FREE — 27B paid on OpenRouter / Kilo / Vercel; Flash-Next is open-weights only, not on the gateways (2026-10-09). Source string "Qwen3.8 278" = 27B confirmed',
      strengths: '27B runs in ~55.6GB BF16 / ~17GB 4-bit. Flash-Next: Qwen4 architecture preview — 7.6–10.2x prefill speedups at 1M context (vendor).',
      weaknesses: 'Independent production numbers still thin — the throughput story is mostly Alibaba\'s own.',
      personality: 'Efficiency-obsessed — an architecture preview for Qwen4, testing cost tricks rather than chasing peak score.',
      bestfor: 'Small teams running their own coding/document agents who want frontier-adjacent quality without frontier compute bills.',
      benchmarks: '27B vendor (HF): SWE-bench Pro 61.7, Terminal-Bench 2.1 73.0, GPQA Diamond 89.2, LiveCodeBench v6 90.3. Independent: AA Index 34. Flash-Next vendor: SWE-bench Pro 62.5, DeepSWE 1.1 58.7 (no independent numbers found).',
      compare: 'DeepSeek V4 Flash — the direct comparison target in Alibaba\'s release materials.',
      sources: ['https://huggingface.co/Qwen/Qwen3.8-27B', 'https://huggingface.co/Qwen/Qwen3.8-Flash-Next', 'https://artificialanalysis.ai/models/qwen3-8-27b', 'https://opencode.ai/data/alibaba'],
    },
  },
  'Nemotron 3 Nano': {
    details: {
      provider: 'NVIDIA',
      released: '2025-12',
      context: '1M (default deploy config often 262,144 to avoid OOM)',
      params: '4B / 30B-A3B variants, hybrid MoE',
      availability: 'FREE — OpenRouter + Kilo (nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free); NVIDIA trial terms, usage logged',
      strengths: '4x throughput over Nemotron 2 Nano, up to 60% less reasoning-token generation. Fits a single consumer GPU at 4-bit.',
      weaknesses: 'Smallest of the three — not the one for hard reasoning/coding; that\'s Super/Ultra\'s job.',
      personality: 'Fast, cheap, disposable-agent-worker energy.',
      bestfor: 'High-throughput lightweight steps in a multi-agent pipeline (routing, simple extraction).',
      benchmarks: null,
      compare: 'Qwen3.6 Flash — similar small/fast tier; Nemotron leans agentic-pipeline-step use, Qwen leans multimodal.',
      sources: ['https://nvidianews.nvidia.com/news/nvidia-debuts-nemotron-3-family-of-open-models', 'https://unsloth.ai/docs/models/nemotron-3'],
    },
  },
  'Nemotron 3 Super': {
    details: {
      provider: 'NVIDIA',
      released: '2026-03',
      context: '1M native',
      params: '120B total / 12B active, hybrid Mamba-Transformer MoE',
      availability: 'FREE — OpenRouter + Kilo (nvidia/nemotron-3-super-120b-a12b:free); NVIDIA trial terms, usage logged',
      strengths: 'Mamba layers make the 1M context practical rather than theoretical. CodeRabbit uses it in production for PR-review context gathering ahead of frontier reasoners.',
      weaknesses: 'Positioned as the mid-tier context-gathering workhorse, not the top-line reasoner.',
      personality: 'A capable pre-processor/summarizer that keeps a big context pile organized for whatever reasons over it next.',
      bestfor: 'Long-context summarization and retrieval stages inside a larger agent pipeline; software-dev and cybersecurity triage.',
      benchmarks: 'Production use: CodeRabbit PR-review context stage.',
      compare: 'Nemotron 3 Nano — same family; Super trades some throughput for real reasoning depth.',
      sources: ['https://developer.nvidia.com/blog/introducing-nemotron-3-super-an-open-hybrid-mamba-transformer-moe-for-agentic-reasoning/', 'https://www.coderabbit.ai/blog/faster-code-reviews-with-nemotron-3-super', 'https://www.verdent.ai/guides/what-is-nemotron-3-super'],
    },
  },
  'Nemotron 3 Ultra': {
    details: {
      provider: 'NVIDIA',
      released: '2026-06',
      context: '1M native; scores 95% on Ruler-at-1M recall benchmark',
      params: '550B total / 55B active, hybrid Mamba-Transformer MoE, latent MoE routing + multi-token prediction',
      availability: 'FREE — OpenRouter + Kilo + OpenCode Zen (nvidia/nemotron-3-ultra-550b-a55b:free); NVIDIA trial terms, usage logged',
      strengths: 'AA Intelligence Index 48 — leading US open-weight model in that snapshot, ahead of Gemma 4 31B and gpt-oss-120b.',
      weaknesses: 'A third-party review explicitly frames it as NOT "the new best coding assistant" — a fast, controllable open worker for pipelines, not a frontier reasoning champion.',
      personality: 'Built for developers who stay in the loop — fast enough to retry, controllable enough to keep inside a harness.',
      bestfor: 'Terminal/coding-agent harnesses, review pipelines, churning through messy long context fast.',
      benchmarks: 'AA Intelligence Index: 48 (leading US open-weight in snapshot).',
      compare: 'Inkling — both "open US model, closely watched" releases; Inkling leans generalist/fine-tunable, Ultra leans speed + agent-pipeline fit.',
      sources: ['https://www.coderabbit.ai/blog/nemotron-3-ultra-release', 'https://openrouter.ai/nvidia/nemotron-3-ultra-550b-a55b:free', 'https://vercel.com/ai-gateway/models/nemotron-3-ultra-550b-a55b/faq'],
    },
  },
  'Inkling': {
    details: {
      provider: 'Thinking Machines Lab',
      released: '2026-07-15, Apache 2.0',
      context: '1M',
      params: '975B total / 41B active multimodal MoE',
      availability: 'FREE — OpenRouter (thinkingmachines/inkling:free); on Kilo only the Small variant is free (2026-10-09)',
      strengths: 'Trained inside randomized coding/agent harnesses so it doesn\'t overfit to one tool schema. Can drive its own fine-tuning via the Tinker platform.',
      weaknesses: 'Thinking Machines says it plainly: "not the strongest overall model available today, open or closed." AA Index 41 — behind Claude Opus 4.8 (56) and GPT-5.6 (59). Code-gen solid, not exceptional.',
      personality: 'A balanced generalist tuned for customization rather than leaderboard-topping.',
      bestfor: 'Teams that want an open-weight base to fine-tune for a specific domain.',
      benchmarks: 'AA Intelligence Index: 41 (top US open-weight at release; behind Opus 4.8 at 56).',
      compare: 'Nemotron 3 Ultra — Inkling is the fine-tuning-first play, Ultra the pipeline-speed play.',
      sources: ['https://thinkingmachines.ai/news/introducing-inkling/', 'https://www.analyticsvidhya.com/blog/2026/07/thinking-machines-inkling/', 'https://www.databricks.com/blog/inkling-thinking-machines-lab-now-databricks', 'https://thinkingmachines.ai/model-card/inkling/'],
    },
  },
  'Inkling Small': {
    details: {
      provider: 'Thinking Machines Lab',
      released: '2026-07-30; Apache 2.0 — full weights shipped (BF16 + NVFP4)',
      context: 'Up to 1M (AA)',
      params: '276B total / 12B active (AA lists 266B; HF card 276B); MoE 6-of-256 + 2 shared; 42 layers; text+image+audio',
      availability: 'FREE — OpenRouter + Kilo (thinkingmachines/inkling-small:free); serverless API ~$0.30/$1.20 per M at launch (vendor)',
      strengths: '~1/4 the size of flagship Inkling (975B) — near-Inkling reasoning/agentic at much lower cost/latency.',
      weaknesses: 'Specs provisional at launch; AA and HF card disagree on total params (266B vs 276B).',
      personality: 'The cheap-and-fast sibling — LLM-as-judge grading, synthetic data where cost matters more than peak capability.',
      bestfor: 'Cost-sensitive coding/grading tasks with Inkling\'s behavior profile without Inkling\'s compute bill.',
      benchmarks: 'Vendor (HF): SWE-bench Verified 80.2, HLE 31.6, GPQA Diamond 89.5, SWE-bench Pro 55.9. Independent: AA Intelligence Index 26.',
      compare: 'Nemotron 3 Nano — both are the "small, cheap sibling" of their families.',
      sources: ['https://huggingface.co/thinkingmachines/Inkling-Small', 'https://artificialanalysis.ai/models/inkling-small', 'https://thinkingmachines.ai/news/introducing-inkling/'],
    },
  },
  'Llama 4 Maverick': {
    details: {
      provider: 'Meta',
      released: '2025-04-05, Llama 4 Community License',
      context: '1M (1,048,576)',
      params: '400B total / 17B active MoE (128 experts), natively multimodal',
      availability: 'NOT FREE — paid on OpenRouter / Kilo / Vercel ($0.24/$0.97 per M); absent from Zen (2026-10-09)',
      strengths: 'Natively multimodal (early fusion), 12 supported output languages.',
      weaknesses: 'The source list\'s "178 Instruct" param count is wrong — the real Maverick is 400B/17B. Meta\'s agent progress acknowledged behind plan — weigh the 2025 claims accordingly.',
      personality: 'Solid 2025 multimodal generalist; dated next to the mid-2026 open-weight field.',
      bestfor: 'Multimodal (image+text) tasks on a budget where you don\'t need frontier-2026 coding.',
      benchmarks: 'Independent: AA Intelligence Index 10 (2026-10-09) — far below the 2025 "beats GPT-4o/Gemini 2.0" positioning and below every 2026 open-weight rival measured; coding subscores not published.',
      compare: 'DeepSeek V3 — Meta\'s own launch comparison; both ~a year+ old by this list.',
      sources: ['https://ai.meta.com/blog/llama-4-multimodal-intelligence/', 'https://huggingface.co/blog/llama4-release', 'https://openrouter.ai/meta-llama/llama-4-maverick', 'https://artificialanalysis.ai/models/llama-4-maverick'],
    },
  },
  'Mistral Medium': {
    details: {
      provider: 'Mistral AI',
      released: '3.1: ~2025-08-12 (API 25.08), deprecated — retirement 2026-08-31. 3.5: 2026-05-22, open weights (modified MIT) — current',
      context: '3.1: 131K (max output ~40K). 3.5: 256K',
      params: '3.5: 128B dense (not MoE) + custom vision encoder; 3.1 params undisclosed',
      availability: 'NOT FREE — paid on OpenRouter and Kilo; not on Zen/Vercel (2026-10-09). 3.5 API $1.50/$7.50 per M; self-host on ~4 GPUs',
      strengths: '3.5 is Mistral\'s "first flagship merged model" (instruct + reasoning + coding); replaced 3.1 in Le Chat.',
      weaknesses: '3.1 is now deprecated (retired 2026-08-31) — pin 3.5. Don\'t ship a benchmark entry for "Mistral Medium | Latest" as a stable target.',
      personality: 'Balanced mid-tier option in Mistral\'s lineup.',
      bestfor: 'General coding/reasoning tasks at a mid price point.',
      benchmarks: 'Vendor (3.5): SWE-Bench Verified 77.6%, τ³-Telecom 91.4 — no independent verification found.',
      compare: 'GLM-5.2 — GLM is the more benchmark-aggressive open-weight coder; Mistral trades peak score for an established vendor.',
      sources: ['https://docs.mistral.ai/getting-started/models/models_overview/', 'https://mistral.ai/news/vibe-remote-agents-mistral-medium-3-5'],
    },
  },
  'Mistral Small': {
    details: {
      provider: 'Mistral AI',
      released: 'Current: Small 4 v26.03 (2026-03), Apache 2.0. Predecessor Small 3.2 (24B dense, 2025-06)',
      context: '256K (Small 4); 3.2 was 131,072',
      params: '119B total / 6.5B active, sparse MoE (128 experts, 4 active)',
      availability: 'NOT FREE — paid on OpenRouter and Kilo; absent from Zen (2026-10-09). API ~$0.15/$0.60 per M reported',
      strengths: 'Hybrid unifying instruct/reasoning/coding.',
      weaknesses: 'No independent benchmark numbers found — card numbers vendor-reported.',
      personality: 'Fast, cheap, no-frills.',
      bestfor: 'Fast drafts, simple extraction/classification steps in a larger pipeline.',
      benchmarks: 'Vendor (HF): GPQA Diamond 71.2 (reasoning high). Independent numbers not found.',
      compare: 'Qwen3.6 Flash — same small/fast tier positioning from a different lab.',
      sources: ['https://huggingface.co/mistralai/Mistral-Small-4-119B-2603', 'https://docs.mistral.ai/getting-started/models/models_overview/'],
    },
  },
  'MiniMax M3': {
    details: {
      provider: 'MiniMax',
      released: '2026-06-01/02; MiniMax Community license',
      context: '1M (vendor: guaranteed min 512K; max output ~512K — unverified)',
      params: '428B total / ~23B active; sparse MoE (128 experts, 4 active + 1 shared); MiniMax Sparse Attention (MSA) block-level KV cache',
      availability: 'NOT FREE — paid on OpenRouter / Kilo / Zen / Vercel; earlier minimax-m3:free listings gone from live catalogs (2026-10-09)',
      strengths: 'Open-weight multimodal (text/image/video); MSA marketed as ~1/20th per-token compute at 1M context.',
      weaknesses: 'Context/benchmark numbers still vendor-reported — treat the 1M claims as unverified.',
      personality: 'The practical open-weight coding option when closed models won\'t give you local deploy.',
      bestfor: 'Local/self-hosted coding-agent deployment where you need the actual weights.',
      benchmarks: 'Vendor (HF): SWE-bench Verified 80.5, SWE-bench Pro 59, MMMU-Pro 78.1. Independent: AA Intelligence Index 29.',
      compare: 'Muse Spark 1.1/1.2/1.3 — framed as "the open-weight alternative" to Meta\'s closed line.',
      sources: ['https://huggingface.co/MiniMaxAI/MiniMax-M3', 'https://artificialanalysis.ai/models/minimax-m3'],
    },
  },
  'MiniMax M2.7': {
    details: {
      provider: 'MiniMax',
      released: '2026-03-18 (AA); weights on HF 2026-04-09',
      context: '200K (AA FAQ; one spec says 205K)',
      params: '~230B total / 10B active; sparse MoE (256 experts, 8 active per third-party)',
      availability: 'NOT FREE — paid on OpenRouter / Kilo / Zen; earlier minimax-m2.7:free gone (2026-10-09)',
      strengths: 'Billed as a self-evolving agent model.',
      weaknesses: 'No independent verification of the self-evolving claims — superseded by M3.',
      personality: null,
      bestfor: 'Treat as superseded by M3 unless pinned for a specific reason.',
      benchmarks: 'Vendor (HF): SWE-bench Pro 56.2, Terminal-Bench 2 57, SkillsBench v1.1 34.9. Independent: AA Intelligence Index 23.',
      compare: 'MiniMax-M3 — direct predecessor/successor pair.',
      sources: ['https://artificialanalysis.ai/models/minimax-m2-7', 'https://huggingface.co/MiniMaxAI/MiniMax-M2.7'],
    },
  },
  'Muse Spark 1.2': {
    details: {
      provider: 'Meta (Superintelligence Labs)',
      released: '2026-08-05 (Artificial Analysis page)',
      context: '1M input (131K output reported)',
      params: 'Not disclosed',
      availability: 'FREE on OpenCode Zen (muse-spark-1.2-contributor-free — prompts train the model); paid on OpenRouter and Kilo ($1.25/$4.25 per M)',
      strengths: 'Successor to 1.1, launched with the Muse Code terminal agent; multimodal (text/image/video/audio/PDF).',
      weaknesses: 'Closed weight, proprietary — no local deployment, no fine-tuning, no published architecture specs.',
      personality: 'An orchestrator — plans, delegates, and keeps track across multi-tool, multi-modal sessions.',
      bestfor: 'Consumer-facing agentic tasks via meta.ai or the Meta Model API.',
      benchmarks: 'Independent: AA Intelligence Index 40 (2026-10-09).',
      compare: 'MiniMax M3 — closed vs open-weight version of roughly the same "agentic orchestrator" pitch.',
      sources: ['https://artificialanalysis.ai/models/muse-spark-1-2', 'https://www.datacamp.com/blog/muse-spark-1-1'],
    },
  },
  'Muse Spark 1.3': {
    details: {
      provider: 'Meta (Superintelligence Labs)',
      released: '2026-09-02 (Artificial Analysis page)',
      context: '1M',
      params: 'Not disclosed',
      availability: 'FREE on OpenCode Zen (muse-spark-1.3-contributor-free — prompts train the model); paid on OpenRouter and Kilo ($1.25/$4.25 per M); "Max" reasoning tier in limited preview',
      strengths: 'Same agentic/multimodal orchestration line; AA: 48 — 1pt above GPT-5.6 Sol (47), 3 behind Claude Opus 5 (51).',
      weaknesses: 'Params undisclosed; no open-weights commitment. The original review lacked Fable 5.1 / Gemini 3.8 Flash comparisons and confidence intervals.',
      personality: 'Same orchestrator profile as 1.1/1.2, incrementally sharpened.',
      bestfor: 'Consumer/API agentic orchestration — use the newest point release.',
      benchmarks: 'Independent (AA, 2026-10-09): 48 (Max) vs GPT-5.6 Sol 47 / Claude Opus 5 51 — the "competitive with Sol and Opus 5" review claim corroborated.',
      compare: 'GPT-5.6 Sol / Claude Opus 5 — the review\'s own comparison set.',
      sources: ['https://artificialanalysis.ai/models/muse-spark-1-3', 'https://artificialanalysis.ai/models/gpt-5-6-sol', 'https://artificialanalysis.ai/models/claude-opus-5', 'https://kingy.ai/blog/muse-spark-1-3-review-benchmarks-pricing-verdict/'],
    },
  },
  'Ling 3.0 Flash': {
    details: {
      provider: 'InclusionAI (Ant Group)',
      released: '2026-07-23 (Vercel); MIT open weights',
      context: '256K native (expandable to 1M per some listings)',
      params: '124B total / ~5.1B active; sparse MoE, hybrid Delta attention + MLA (1/64)',
      availability: 'FREE on OpenCode Zen (ling-3.0-flash-fin-free); Vercel\'s free slot ended 2026-08-03; paid on OpenRouter/Kilo; successor ling-3.1-flash is free on more gateways',
      strengths: 'Token-efficient agentic inference; matches/beats its 1T-class predecessor Ring-2.6-1T. 10,000+ interactive training environments.',
      weaknesses: 'The Vercel free promo has expired — free access now only via Zen.',
      personality: 'Efficiency-first — more agentic work per token, not raw leaderboard topping.',
      bestfor: 'High-frequency agentic workflows and document processing where token cost per action matters.',
      benchmarks: 'Vendor (HF): AIME 2026 93.2, SWE-bench Pro 56.6, HLE 22.7. Independent: AA Intelligence Index 20.',
      compare: 'Qwen3.8 Flash-Next — similar "efficiency architecture experiment" positioning.',
      sources: ['https://vercel.com/changelog/ling-3-0-flash-is-now-available-on-ai-gateway', 'https://huggingface.co/inclusionAI/Ling-3.0-flash', 'https://artificialanalysis.ai/models/ling-3-0-flash'],
    },
  },
  'Gemma 4 26B / 31B': {
    details: {
      provider: 'Google DeepMind',
      released: '2026-04-02 (blog; 31B HF card shows 2026-03-11); Apache 2.0 — first Apache-licensed Gemma',
      context: '256K',
      params: '26B: 25.2B/3.8B MoE (128 experts, top-8), 30 layers. 31B: 30.7B dense, 60 layers',
      availability: 'Open weights on HF; 26B ~52GB bf16, 31B ~62GB — single 80GB GPU',
      strengths: 'First MoE in the Gemma series; multimodal text+image (video as frames); 140+ languages; configurable <|think|> thinking mode.',
      weaknesses: 'No independent benchmark verification located — card numbers are vendor-reported.',
      personality: null,
      bestfor: 'Small/efficient open Google multimodal — edge / consumer-GPU deployment.',
      benchmarks: 'Vendor card (26B-it): MMLU Pro 82.6%, AIME 2026 88.3%, LiveCodeBench v6 77.1%, GPQA Diamond 82.3%. (31B-it): MMLU Pro 85.2%, AIME 2026 89.2%, LiveCodeBench v6 80.0%, GPQA Diamond 84.3%, HLE 19.5%.',
      compare: 'gpt-oss-20b — similar small-open-weight class, different vendor.',
      sources: ['https://developers.googleblog.com/en/bring-state-of-the-art-agentic-skills-to-the-edge-with-gemma-4/', 'https://huggingface.co/google/gemma-4-26B-A4B-it', 'https://huggingface.co/google/gemma-4-31b-it'],
    },
  },
  'gpt-oss 120B / 20B': {
    details: {
      provider: 'OpenAI',
      released: '2025-08-04 (HF card date); Apache 2.0',
      context: '128K (131,072 per Azure listing); Codex splits 96K in / 32K out',
      params: '120B: ~117B/5.1B active MoE, 36 layers, 128 experts top-4, MXFP4. 20B: ~21B/3.6B active, 24 layers, 32 experts top-4',
      availability: 'Open weights on HF; 120B fits one 80GB GPU, 20B ~16GB; Azure/AWS/Vercel/Databricks; llama.cpp/Ollama/LM Studio',
      strengths: 'Decoder-only, STEM/coding-focused; o200k_harmony tokenizer open-sourced.',
      weaknesses: 'Do not ship "GPT 0SS 1208" as a row — that source string is a mangled gpt-oss-120b, now confirmed.',
      personality: null,
      bestfor: 'Small open-weight STEM/coding baseline; local single-GPU deploy.',
      benchmarks: 'Vendor card (120B): GPQA Diamond 69.0%, MMLU-Pro 73.7%, SWE-bench Verified 45.8%, HLE 10.0%. (20B): SWE-bench Verified 60.7% (high) / 53.2% (med), GPQA Diamond 71.5%, MMLU-Pro 73.6%.',
      compare: 'Gemma 4 — both show up as the "small open baseline" in the same tables.',
      sources: ['https://huggingface.co/openai/gpt-oss-120b', 'https://huggingface.co/openai/gpt-oss-20b'],
    },
  },
  'North Mini Code': {
    details: {
      provider: 'Cohere (HF: CohereLabs/North-Mini-Code-1.0)',
      released: '2026-06-09; Apache 2.0 open weights',
      context: '256K (AA lists 260K); up to 64K output',
      params: '30B total / 3B active; sparse MoE — 128 experts, 8 active per token, SwiGLU; decoder-only reasoning model',
      availability: 'FREE on Cohere API (launch period, rate-limited); weights on HF; runs on one H100 at FP8/FP4',
      strengths: 'First model of Cohere\'s "North" family, aimed at agentic coding; ~73 tok/s live (199 t/s pre-release).',
      weaknesses: 'Emits more output tokens than peers; weak on non-coding agentic tasks (AA).',
      personality: null,
      bestfor: 'Coding-focused agentic work on a single GPU.',
      benchmarks: 'Independent (AA): Coding Index 33.4, Agentic Index 21.7, GPQA Diamond 75.7%, IFBench 57.6%, SciCode 38.8%.',
      compare: null,
      sources: ['https://artificialanalysis.ai/models/north-mini-code', 'https://artificialanalysis.ai/articles/north-mini-code-cohere-s-small-coding-focused-moe-model', 'https://cohere.com/north-mini-code', 'https://huggingface.co/CohereLabs/North-Mini-Code-1.0'],
    },
  },
  'MiMo V2.5': {
    details: {
      provider: 'Xiaomi (HF org XiaomiMiMo)',
      released: '2026 (exact date unconfirmed); MIT license',
      context: '1M (V2.5-Pro); 256K (FP8 base); native 32K pretraining sequences',
      params: 'V2.5-Pro: 1.02T total / 42B active; 70 layers, hidden 6144, 384 routed experts × 8 active, 3 MTP modules; hybrid attention (10 global + 60 sliding-window layers)',
      availability: 'Open weights on HF (MIT); "MiMo-V2.5 Free" in the OpenCode Zen free pool; SGLang/vLLM day-0 support',
      strengths: 'Pretrained on 27T tokens FP8; SFT + agentic RL + Multi-Teacher On-Policy Distillation; holds long context at 512K/1M where MiMo V2 Pro collapsed to 0.00.',
      weaknesses: 'MiMo-V2-Flash specs still not located; the benchmark table is vendor-reported.',
      personality: null,
      bestfor: 'Long-context coding/automation on open weights.',
      benchmarks: 'Vendor card: long-context retention 0.56/0.92 @512K, 0.37/0.62 @1M (V2 Pro: 0.00 @1M); compares vs DeepSeek-V4-Pro/Flash and Kimi-K2.',
      compare: null,
      sources: ['https://huggingface.co/collections/XiaomiMiMo/mimo-v25', 'https://huggingface.co/XiaomiMiMo/MiMo-V2.5-Pro-Base'],
    },
  },
  'Nemotron 3.5 Lightning': {
    details: {
      provider: 'NVIDIA',
      released: '2026-08-11; OpenMDW-1.1 (open weights, data, recipes)',
      context: 'Up to 1M model-level; ~256K practical on one H100; OpenRouter standard endpoints ~262K, the :free endpoint exposes 1M',
      params: '30B total / ~3B active (AA: 31.6B/3.6B); hybrid Mamba-2 + MoE with select attention layers',
      availability: 'FREE — OpenRouter (:free) and OpenCode Zen free tier; open weights BF16 + NVFP4; runs on RTX/DGX Spark/Station/Jetson',
      strengths: 'Distilled from Nemotron 3 Ultra; 20T+ token NVFP4 recipe; multi-token prediction + DFlash/DSpark draft models; ~4x throughput vs similar-size (vendor).',
      weaknesses: 'Free tier is trial-based with usage logging.',
      personality: null,
      bestfor: 'Long-running specialized task execution; fast open agentic worker.',
      benchmarks: 'Vendor: PinchBench 86% while finishing 10k tasks ~30% faster than Qwen3.6 35B. Independent: AA Intelligence Index 13, ~283 tok/s output.',
      compare: null,
      sources: ['https://blogs.nvidia.com/blog/nemotron-lightning-switchyard-rtx-dgx/', 'https://developer.nvidia.com/blog/nvidia-nemotron-3-5-lightning-delivers-fast-accurate-specialized-task-execution-for-long-running-agents/', 'https://artificialanalysis.ai/models/nemotron-3-5-lightning', 'https://openrouter.ai/blog/insights/nemotron-3-5-lightning/'],
    },
  },
  'Nemotron 3.5 Content Safety': {
    details: {
      provider: 'NVIDIA',
      released: '2026 (V1.1/V1.2; exact date unconfirmed)',
      context: 'Up to 128K',
      params: '4B (LoRA fine-tune on Gemma-3-4B-it, merged back into base)',
      availability: 'FREE — OpenRouter (nvidia/nemotron-3.5-content-safety:free); also NVIDIA NIM + NGC catalog',
      strengths: 'Multimodal (text+image) guardrail SLM; Aegis 2.0 taxonomy (13 core + 10 fine-grained categories), 12 languages, optional THINK reasoning traces.',
      weaknesses: 'Not a coding model at all — kept as a labeled row so the name doesn\'t get re-added as a mystery model.',
      personality: null,
      bestfor: 'Safety classification, not code generation.',
      benchmarks: 'Vendor card V1.2: VLGuard 0.89, Aegis 2.0 0.85 accuracy / 0.86 harmful F1, Wildguard 0.92, XSTest 0.95.',
      compare: null,
      sources: ['https://huggingface.co/blog/nvidia/nemotron-3-5-content-safety', 'https://docs.api.nvidia.com/nim/re/reference/nvidia-nemotron-3-5-content-safety', 'https://openrouter.ai/nvidia/nemotron-3.5-content-safety:free'],
    },
  },
  'Nemotron 3 Nano Omni': {
    details: {
      provider: 'NVIDIA',
      released: '2026-04-28; NVIDIA Nemotron Open Model License (commercial use)',
      context: '256K (up to 300K supported; 16,384 reasoning budget)',
      params: '30B-A3B hybrid MoE (~31B total / ~3B active); 23 Mamba-2 + 23 MoE layers (128 experts, 6 active); C-RADIOv4-H vision, Parakeet-TDT audio',
      availability: 'Open weights BF16/FP8/NVFP4; HF, OpenRouter, build.nvidia.com, vLLM/SGLang/TensorRT-LLM/Ollama/llama.cpp',
      strengths: 'Unifies text, image, video (up to 2 min), audio, and documents; reasoning on by default; base 25T tokens, adapters ~127B tokens, 2.3M+ RL rollouts.',
      weaknesses: 'Benchmark claims are vendor-only (no numeric scores captured).',
      personality: null,
      bestfor: 'Perception/context sub-agent in multimodal pipelines.',
      benchmarks: 'Vendor: tops MMlongbench-Doc, OCRBenchV2, WorldSense, DailyOmni, VoiceBench, MediaPerf; ~9x throughput vs comparable open omni models.',
      compare: null,
      sources: ['https://blogs.nvidia.com/blog/nemotron-3-nano-omni-multimodal-ai-agents/', 'https://developer.nvidia.com/blog/nvidia-nemotron-3-nano-omni-powers-multimodal-agent-reasoning-in-a-single-efficient-open-model'],
    },
  },
  'BigPickle': {
    details: {
      provider: 'OpenCode team (anomalyco) — a free "stealth" alias on the OpenCode Zen gateway, not a named vendor model; backend rotates (community traced GLM 4.6 → DeepSeek V4 Flash → possibly "Ox Alpha")',
      released: 'No model card — documented in community issues (Sept 2026)',
      context: '~200K listed in Zen UI; maintainer stated 128K max output; users measured ~1M at times',
      params: null,
      availability: 'FREE in OpenCode Zen (Sept 2026) — requires a real OpenCode session (direct API → 403 FreeTierError); prompts may be used to improve the model during the free period',
      strengths: 'Fast free workhorse: 10k+ line codebases, code review, clean tool calls, ~189 tok/s (community verdict). Independent SWE Atlas run resolved 50.8% of tasks — topping every Mini-SWE-Agent entry.',
      weaknesses: 'Frontend/UI is the weakest area; weak on hard multi-dimensional bugfixing; backend rotates without notice; context degrades ~50–70k tokens (community verdict). GitHub issue #50202 (2026-09) logged corruption, repetition loops and language drift from rotation.',
      personality: null,
      bestfor: 'Small-to-medium backend tasks, code review, exploration — a free fallback to a paid model (community verdict).',
      benchmarks: 'Independent (SWE Atlas Codebase QnA): 50.8% (63/124 tasks) — tops Mini-SWE-Agent entries; 674M in / 4.3M out tokens at $0 (third-party)',
      compare: null,
      sources: ['https://github.com/anomalyco/opencode/issues/4276', 'https://github.com/anomalyco/opencode/issues/50202', 'https://times.hntrends.net/story/49315563'],
    },
    verdicts: [
      { cat: 'Code (general)', tone: 'green', text: 'Good', notes: 'Handles 10k+ line codebases, APIs, refactoring, boilerplate. Strong on C#, Blazor, PowerShell. Produces redundant code; must double-check output.' },
      { cat: 'Debug', tone: 'amber', text: 'Mixed', notes: 'Good at code review and finding issues (AWS/IAM debugging praised). Weak on hard, multi-dimensional bugfixing — "the sort of thing you\'d want Opus for."' },
      { cat: 'Plan', tone: 'amber', text: 'Mixed', notes: 'Solid on well-defined single-domain tasks. Struggles with cross-domain/monorepo planning. Can deviate from a plan.md at depth.' },
      { cat: 'Agentic Use', tone: 'amber', text: 'Mixed', notes: 'Good at managing sub-agents, identifying target code, following instructions. Falls apart on mid-sized projects without MCPs/subagents. Context degrades ~50–70k tokens despite 200k window.' },
      { cat: 'Tool Use', tone: 'green', text: 'Good', notes: 'One dev.to test: only model that paused to search a protocol spec before coding. Tool calls handled cleanly (84.3% of context in one session). But can get stuck in loops on easy tool calls.' },
      { cat: 'Frontend / UI', tone: 'red', text: 'Weak', notes: 'Consistently the weakest area. "Plain text pages, no colors." "Bare minimum frontend." Messes up Jinja+CSS, HTML minifiers.' },
      { cat: 'Speed', tone: 'green', text: 'Good', notes: '~189 tok/s, "insane response speed." Some report slowness or hangs during peak load.' },
      { cat: 'Reliability', tone: 'red', text: 'Poor', notes: '#1 complaint. "Model lottery" — backend rotates without notice. Random Chinese output, outages, quality swings day-to-day.' },
      { cat: 'Reasoning / Analysis', tone: 'green', text: 'Surprisingly Good', notes: '"Forensic analyst" behavior. Strong code reviews, structured reports, analytical investigation beyond just coding.' },
      { cat: 'Cost', tone: 'green', text: 'Free', notes: 'The main selling point. "Outperforms Claude Sonnet on ROI." $20/month of paid tokens lasts all month when using it as a fallback.' },
    ],
    bottomLine: "It's a strong free workhorse for small-to-medium backend tasks, code review, and exploration — but unreliable for production-critical work, frontend, or complex multi-domain planning, and the rotating backend means your experience may differ from someone else's by a week.",
  },
};

function verdictBadge(v) {
  const emoji = v.tone === 'amber' ? '🟡' : v.tone === 'red' ? '🔴' : '🟢';
  const cls = v.tone === 'amber' ? 'ref-badge-amber' : v.tone === 'red' ? 'ref-badge-red' : 'ref-badge-green';
  return `<span class="ref-badge ${cls}">${emoji} ${esc(v.text)}</span>`;
}

function srcLink(u) {
  const label = String(u).replace(/^https?:\/\//, '').replace(/\/$/, '');
  return `<a class="ref-src-link" href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;
}

function cell(v) {
  return v ? `<span class="ref-cell">${esc(v)}</span>` : PLACEHOLDER;
}

function buildCodeModelPage(key) {
  const r = CODE_MODELS_ROWS.find((x) => x.model === key);
  if (!r) return buildCodeModelsSection();
  const page = CODE_MODEL_PAGES[key] || {};
  const d = page.details || {};
  // Row data is the fallback where the detail sheet has no entry; '—' = unknown.
  const val = (v) => (v && v !== '—' ? v : null);
  const field = (label, v) => `<tr><td class="ref-spec-key">${esc(label)}</td><td>${cell(v)}</td></tr>`;
  const specRows = [
    field('Provider', val(d.provider) ?? val(r.provider)),
    field('Released', val(d.released)),
    field('Context', val(d.context) ?? val(r.context)),
    field('Parameters', val(d.params)),
    field('Availability', val(d.availability) ?? val(r.availability)),
    field('Key Strengths', val(d.strengths) ?? val(r.strengths)),
    field('Watch-outs', val(d.weaknesses)),
    field('Personality', val(d.personality)),
    field('Best For', val(d.bestfor) ?? val(r.bestfor)),
    field('Reported Benchmarks', val(d.benchmarks) ?? val(r.benchmarks)),
    field('Compare', val(d.compare)),
  ].join('');
  const sources = (d.sources && d.sources.length)
    ? `<span class="ref-cell">${d.sources.map(srcLink).join(' · ')}</span>`
    : PLACEHOLDER;
  // Verdict skeleton: whatever is filled renders as badges, the rest stays
  // <placeholder> — a partial fill never hides a category.
  const filled = {};
  (page.verdicts || []).forEach((v) => { filled[v.cat] = v; });
  const verdictRows = VERDICT_CATEGORIES.map((cat) => {
    const v = filled[cat];
    return `<tr>
      <td class="ref-verdict-cat">${esc(cat)}</td>
      <td class="ref-verdict-cell">${v && v.text ? verdictBadge(v) : PLACEHOLDER}</td>
      <td class="ref-cell">${v && v.notes ? esc(v.notes) : PLACEHOLDER}</td>
    </tr>`;
  }).join('');
  const chips = [
    `<button type="button" class="ref-model-chip" data-model-chip="__overview__" data-help-title="Back to the overview comparison">← Overview</button>`,
    ...CODE_MODELS_ROWS.map((m) => `<button type="button" class="ref-model-chip${m.model === key ? ' active' : ''}" data-model-chip="${esc(m.model)}" data-help-title="Open ${esc(m.model)} page">${esc(m.model)}</button>`),
  ].join('');
  const prov = val(d.provider) ?? val(r.provider);
  const ctx = val(d.context) ?? val(r.context);
  return `
    <div class="ref-model-page">
      <div class="ref-model-strip">${chips}</div>
      <div class="ref-card">
        <div class="ref-card-head">
          <div class="ref-card-head-icon">${SVG_UPRIGHT}</div>
          <h2>${esc(r.model)}<span class="ref-sub">${prov ? esc(prov) : ''}${ctx ? ` · context ${esc(ctx)}` : ''}</span></h2>
        </div>
        <div class="ref-card-body">
          <table class="ref-table ref-spec-table"><tbody>${specRows}<tr><td class="ref-spec-key">Sources</td><td>${sources}</td></tr></tbody></table>
        </div>
      </div>
      <div class="ref-card">
        <div class="ref-card-head">
          <div class="ref-card-head-icon">${SVG_EYE}</div>
          <h2>Community Verdict<span class="ref-sub">per-category, community-sourced — <span class="ref-placeholder">&lt;placeholder&gt;</span> cells are yours to fill</span></h2>
        </div>
        <div class="ref-card-body">
          <table class="ref-table ref-verdict-table">
            <thead><tr><th>Category</th><th>Verdict</th><th>Notes</th></tr></thead>
            <tbody>${verdictRows}</tbody>
          </table>
          <div class="ref-callout">
            ${SVG_INFO}
            <p><strong>Bottom line from the community:</strong> ${page.bottomLine ? esc(page.bottomLine) : PLACEHOLDER}</p>
          </div>
        </div>
      </div>
    </div>`;
}

function openCodeModel(key) {
  codeModelOpen = key;
  renderReferencesForm();
}

function bindCodeModelNav() {
  // Overview table: delegated so sort/column-toggle repaints survive.
  const table = elements.actionPanel.querySelector('table[data-mtable="code"]');
  if (table && !table.dataset.openBound) {
    table.dataset.openBound = '1';
    table.addEventListener('click', (e) => {
      const link = e.target.closest('[data-open-model]');
      if (link) openCodeModel(link.getAttribute('data-open-model'));
    });
  }
  // Model page: strip chips — Overview resets, model chips open their page.
  elements.actionPanel.querySelectorAll('[data-model-chip]').forEach((chip) => {
    chip.addEventListener('click', () => {
      const key = chip.getAttribute('data-model-chip');
      openCodeModel(key === '__overview__' ? null : key);
    });
  });
}

/* ═══════════════════════════════════════════════
   APIs / Free Tiers — model-inference gateways
   with a working free tier. Columns: Provider |
   Why it makes the list | Free Tier | Notes.
   Each row opens a detail page with verified
   facts + <placeholder> for gaps. Data from the
   user's Oct-2026 free-tier survey.
   ═══════════════════════════════════════════════ */
let apiSort = { key: 'provider', dir: 1 };

const APIS_ROWS = [
  { provider: 'Google AI Studio (Gemini)', company: 'Google', why: 'Permanent free tier, no card. Gemini 3.5/3.6 Flash + Gemma 4. Generous RPD on Flash models; Pro tiers are paid.', free: 'Y', notes: 'Generous RPD on Flash; Pro paid' },
  { provider: 'Groq', company: 'Groq', why: 'Fastest inference around. Free developer tier (~30 rpm) for GPT-OSS, Llama, Qwen, plus Whisper STT. No card.', free: 'Y', notes: '~30 rpm free tier' },
  { provider: 'Cerebras', company: 'Cerebras', why: '~1,000,000 tokens/day free on record-breaking hardware. GPT-OSS 120B and GLM.', free: 'Y', notes: '1M tokens/day free' },
  { provider: 'OpenRouter', company: 'OpenRouter', why: 'A pool of :free models. 50 requests/day free, or 1,000/day once you\'ve ever bought $10 of credits. No card to start.', free: 'Y', notes: '50 req/day (1,000 after $10 spent)' },
  { provider: 'NVIDIA NIM', company: 'NVIDIA', why: 'Recurring free tier at build.nvidia.com (~40 rpm), no card. DeepSeek, Llama, Nemotron, Gemma and MiniMax.', free: 'Y', notes: '~40 rpm, recurring' },
  { provider: 'Cloudflare Workers AI', company: 'Cloudflare', why: '10,000 free Neurons/day, no card. Llama, Qwen, Mistral, GLM and image models.', free: 'Y', notes: '10,000 Neurons/day' },
  { provider: 'Mistral', company: 'Mistral AI', why: 'Free \'Experiment\' tier covering Large, Medium, Small, Codestral and Devstral. No card.', free: 'Y', notes: 'Experiment tier (dev/preview)' },
  { provider: 'Cohere', company: 'Cohere', why: 'Free trial key: ~1,000 calls/month across Command A/R, Aya, rerank and embed. No card (dev/eval only).', free: 'Y', notes: '~1,000 calls/month, dev/eval only' },
  { provider: 'Z.ai / Zhipu (GLM)', company: 'Z.ai / Zhipu AI', why: 'Free GLM Flash models on an international endpoint (no Chinese phone). GLM-4.5/4.6/4.7 Flash.', free: 'Y', notes: 'No Chinese phone required' },
  { provider: 'Reka', company: 'Reka', why: 'One of the few with a true recurring monthly credit — $10/month, auto-refreshed.', free: 'Y', notes: '$10/month recurring credit' },
];

const APIS_COLS = [
  { key: 'provider', label: 'Provider' },
  { key: 'why', label: 'Why it makes the list' },
  { key: 'free', label: 'Free Tier', cls: 'ref-col-center' },
  { key: 'notes', label: 'Notes' },
];

function apiSortValue(r, key) {
  const v = r[key] || '';
  return v === '—' ? '' : v;
}

function apiTableCfg() {
  return {
    rows: APIS_ROWS,
    sort: apiSort,
    valueFn: apiSortValue,
    tieFn: null,
    rowFn: apiRow,
    tableType: 'apis',
  };
}

function buildApisSection() {
  return `
    <div class="ref-card">
      <div class="ref-card-head">
        <div class="ref-card-head-icon">${SVG_MONEY}</div>
        <h2>APIs / Free Tiers<span class="ref-sub">Model-inference gateways with a working free tier — all community-verified (Oct 2026) · click a provider name for its page</span></h2>
      </div>
      <div class="ref-card-body ref-table-scroll">
        <table class="ref-table ref-models-table" data-mtable="apis">
          <thead><tr>
            ${sortHeaders(APIS_COLS, apiSort, 'apis')}
          </tr></thead>
          <tbody>
            ${sortRows(APIS_ROWS, apiSort, apiSortValue, apiTableCfg().tieFn).map(apiRow).join('')}
          </tbody>
        </table>
        <div class="ref-legend">
          <span class="ref-status"><span class="ref-badge ref-badge-green">${SVG_CHECK} Y</span> All carry a free tier</span>
          <span class="ref-status"><span class="ref-badge ref-badge-gray">${SVG_INFO}</span> Rate limits vary — see each provider page</span>
        </div>
      </div>
    </div>`;
}

function apiRow(r) {
  return `<tr>
    <td><button type="button" class="ref-model-link" data-open-api="${esc(r.provider)}" data-help-title="Open ${esc(r.provider)} page">${esc(r.provider)}</button></td>
    <td><span class="ref-cell">${esc(r.why)}</span></td>
    <td class="ref-col-center"><span class="ref-cell">${esc(r.free)}</span></td>
    <td><span class="ref-cell">${esc(r.notes)}</span></td>
  </tr>`;
}

const APIS_PAGES = {
  'Google AI Studio (Gemini)': {
    details: {
      provider: 'Google',
      free_tier: 'Y',
      no_card: 'Yes',
      rate_limit: 'Per-project quotas: 15 RPM / 1M TPM / 1,500 RPD on Flash models (varies by project/region)',
      model_coverage: 'Gemini 3.5 Flash, Gemini 3.6 Flash, Gemma 4',
      notes: 'Permanent free tier, no card. Data may be used for tuning. Pro tiers are paid.',
      sources: ['https://aistudio.google.com/', 'https://ai.google.dev/pricing'],
    },
  },
  'Groq': {
    details: {
      provider: 'Groq',
      free_tier: 'Y',
      no_card: 'Yes',
      rate_limit: '~30 rpm',
      model_coverage: 'GPT-OSS, Llama, Qwen, Whisper STT',
      notes: 'Fastest inference around — low-latency token streaming.',
      sources: ['https://console.groq.com/', 'https://groq.com/'],
    },
  },
  'Cerebras': {
    details: {
      provider: 'Cerebras',
      free_tier: 'Y',
      no_card: 'Card required for new keys (free trial: $5 credits / 30 days; legacy free tier was ~1M tokens/day)',
      rate_limit: '~1,000,000 tokens/day (legacy/promotional) · $5 trial credits on activation',
      model_coverage: 'GPT-OSS 120B, GLM',
      notes: 'Runs on Cerebras wafer-scale engine — record-breaking hardware speed.',
      sources: ['https://www.cerebras.ai/', 'https://inference.cerebras.ai/'],
    },
  },
  'OpenRouter': {
    details: {
      provider: 'OpenRouter',
      free_tier: 'Y',
      no_card: 'Yes (to start)',
      rate_limit: '50 requests/day free; 1,000/day after you\'ve ever bought $10 of credits',
      model_coverage: 'Rotating pool of :free models (selection rotates by popularity and cost)',
      notes: 'No card needed to start; the 1,000/day threshold is one-time (sticks after first $10 spend).',
      sources: ['https://openrouter.ai/', 'https://openrouter.ai/docs'],
    },
  },
  'NVIDIA NIM': {
    details: {
      provider: 'NVIDIA',
      free_tier: 'Y',
      no_card: 'Yes',
      rate_limit: '~40 rpm',
      model_coverage: 'DeepSeek, Llama, Nemotron, Gemma, MiniMax',
      notes: 'Recurring free tier at build.nvidia.com — does not expire; trial terms log usage.',
      sources: ['https://build.nvidia.com/', 'https://developer.nvidia.com/nim'],
    },
  },
  'Cloudflare Workers AI': {
    details: {
      provider: 'Cloudflare',
      free_tier: 'Y',
      no_card: 'Yes',
      rate_limit: '10,000 Neurons/day',
      model_coverage: 'Llama, Qwen, Mistral, GLM, image models',
      notes: '"Neurons" are Cloudflare\'s token-based billing unit; 10,000 is the daily free allotment.',
      sources: ['https://developers.cloudflare.com/workers-ai/', 'https://workers.cloudflare.com/'],
    },
  },
  'Mistral': {
    details: {
      provider: 'Mistral AI',
      free_tier: 'Y',
      no_card: 'Yes (SMS verification only)',
      rate_limit: '~1 RPS (req/s), ~500k TPM (dev/eval workspace caps)',
      model_coverage: 'Large, Medium, Small, Codestral, Devstral',
      notes: 'Free \'Experiment\' tier — dev/preview access, no card required. 1B tokens/mo ceiling.',
      sources: ['https://mistral.ai/', 'https://docs.mistral.ai/api/'],
    },
  },
  'Cohere': {
    details: {
      provider: 'Cohere',
      free_tier: 'Y',
      no_card: 'Yes (dev/eval only)',
      rate_limit: '~1,000 calls/month across all endpoints',
      model_coverage: 'Command A/R, Aya, rerank, embed',
      notes: 'Free trial key — dev/evaluation only, not for production.',
      sources: ['https://cohere.com/', 'https://docs.cohere.com/'],
    },
  },
  'Z.ai / Zhipu (GLM)': {
    details: {
      provider: 'Z.ai / Zhipu AI',
      free_tier: 'Y',
      no_card: 'Yes (no card for Flash models on international Z.ai endpoint)',
      rate_limit: 'Concurrency-based: 1 concurrent request for free Flash models',
      model_coverage: 'GLM-4.5 Flash, GLM-4.6 Flash, GLM-4.7 Flash, GLM-4.6V Flash',
      notes: 'Free GLM Flash models on an international endpoint — no Chinese phone required.',
      sources: ['https://api.z.ai/', 'https://z.ai/en/'],
    },
  },
  'Reka': {
    details: {
      provider: 'Reka',
      free_tier: 'Y',
      no_card: 'Card/verification requested on signup for API key generation',
      rate_limit: '$10/month, auto-refreshed (true recurring monthly credit)',
      model_coverage: 'Reka Core, Reka Flash, Reka Spark',
      notes: 'One of the few providers that auto-refreshes a monthly free credit without requiring a new sign-up or spend.',
      sources: ['https://reka.ai/', 'https://docs.reka.ai/'],
    },
  },
};

function buildApiPage(key) {
  const r = APIS_ROWS.find((x) => x.provider === key);
  if (!r) return buildApisSection();
  const page = APIS_PAGES[key] || {};
  const d = page.details || {};
  const val = (v) => (v && v !== '—' ? v : null);
  const field = (label, v) => `<tr><td class="ref-spec-key">${esc(label)}</td><td>${cell(v)}</td></tr>`;
  const specRows = [
    field('Provider', val(d.provider) ?? val(r.company)),
    field('Free Tier', val(d.free_tier) ?? val(r.free)),
    field('Card Required?', val(d.no_card)),
    field('Free Rate Limit', val(d.rate_limit)),
    field('Models Accessible', val(d.model_coverage)),
    field('Notes', val(d.notes)),
  ].join('');
  const sources = (d.sources && d.sources.length)
    ? `<span class="ref-cell">${d.sources.map(srcLink).join(' · ')}</span>`
    : PLACEHOLDER;
  const chips = [
    `<button type="button" class="ref-model-chip" data-api-chip="__overview__" data-help-title="Back to the overview comparison">← Overview</button>`,
    ...APIS_ROWS.map((m) => `<button type="button" class="ref-model-chip${m.provider === key ? ' active' : ''}" data-api-chip="${esc(m.provider)}" data-help-title="Open ${esc(m.provider)} page">${esc(m.provider)}</button>`),
  ].join('');
  const prov = val(d.provider) ?? val(r.company);
  return `
    <div class="ref-model-page">
      <div class="ref-model-strip">${chips}</div>
      <div class="ref-card">
        <div class="ref-card-head">
          <div class="ref-card-head-icon">${SVG_MONEY}</div>
          <h2>${esc(r.provider)}<span class="ref-sub">${prov ? esc(prov) : ''}</span></h2>
        </div>
        <div class="ref-card-body">
          <table class="ref-table ref-spec-table"><tbody>${specRows}<tr><td class="ref-spec-key">Sources</td><td>${sources}</td></tr></tbody></table>
        </div>
      </div>
      <div class="ref-card">
        <div class="ref-card-head">
          <div class="ref-card-head-icon">${SVG_INFO}</div>
          <h2>Quick Notes<span class="ref-sub">community tip</span></h2>
        </div>
        <div class="ref-card-body">
          <p class="ref-note">Free-tier policies rotate fast — re-check the gateway live list before pinning one as "the free tier." All ten providers above had a working free tier in the Oct 2026 gateway snapshot.</p>
        </div>
      </div>
    </div>`;
}

function openApiPage(key) {
  apiPageOpen = key;
  renderReferencesForm();
}

function bindApisNav() {
  const table = elements.actionPanel.querySelector('table[data-mtable="apis"]');
  if (table && !table.dataset.openBound) {
    table.dataset.openBound = '1';
    table.addEventListener('click', (e) => {
      const link = e.target.closest('[data-open-api]');
      if (link) openApiPage(link.getAttribute('data-open-api'));
    });
  }
  elements.actionPanel.querySelectorAll('[data-api-chip]').forEach((chip) => {
    chip.addEventListener('click', () => {
      const key = chip.getAttribute('data-api-chip');
      openApiPage(key === '__overview__' ? null : key);
    });
  });
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

/* ═══════════════════════════════════════════════
   Music Prompts — ACE-Step prompting cheat-sheet.
   Static doctrine (official Tutorial + community) + the full example bank
   harvested from local LoRA metadata (tools/gen_music_prompt_bank.py).
   Full-bleed workspace; cards cap their own line length (never the page).
   ═══════════════════════════════════════════════ */
const MU_DIMENSIONS = [
  ['Style / Genre', 'pop, rock, jazz, electronic, hip-hop, boom bap, lo-fi, synthwave'],
  ['Emotion / Atmosphere', 'melancholic, uplifting, energetic, dreamy, dark, nostalgic, intimate'],
  ['Instruments (name them)', 'fingerpicked acoustic guitar, felt piano, 808 drums, strings, brass'],
  ['Timbre / Texture', 'warm, bright, crisp, dusty, airy, punchy, vinyl crackle, compressed'],
  ['Era reference', '80s synth-pop, 90s grunge, vintage soul, modern trap'],
  ['Production', 'lo-fi, hi-fi, bedroom pop, studio-polished, analog warmth, wide stereo'],
  ['Vocals', 'female breathy vocal, male raspy vocal, choir, falsetto — or no vocals'],
  ['Speed / Rhythm', 'slow tempo, groovy, driving, laid-back (BPM itself goes in metas, not caption)'],
  ['Structure hints', 'building intro, catchy chorus, dramatic bridge, fade-out ending'],
];

const MU_GENRES = [
  ['Electronic', 'techno, progressive house, trance, drum and bass, breakcore, darkwave, synthwave'],
  ['Hip-hop', 'trap, boom bap, drill, phonk, lo-fi hip-hop, cloud rap, uk drill'],
  ['Rock', 'indie rock, post-rock, shoegaze, dream pop, post-punk, grunge, doom metal'],
  ['Pop', 'synth-pop, city pop, k-pop, j-pop, indie pop, hyperpop'],
  ['Jazz', 'bebop, fusion, smooth jazz, gypsy jazz, cool jazz'],
  ['Orchestral', 'cinematic, trailer music, orchestral score, baroque, minimalist'],
  ['Acoustic', 'indie folk, bluegrass, bossa nova, americana, sea shanty'],
  ['Ambient', 'dark ambient, drone, new age, evolving pads, ethereal textures'],
];

const MU_STRUCTURE = [
  ['[intro] / [outro]', 'opening / ending, establishes atmosphere'],
  ['[verse] / [chorus] / [bridge]', 'narrative / hook (repeat it) / contrasting section'],
  ['[inst]', 'instrumental passage — solos, breaks, interludes (marker alone = no vocals)'],
  ['[build-up] / [drop] / [breakdown]', 'rise / peak release / strip back (electronic arcs)'],
  ['Language', '[en] [zh] [ja]… at section start, never mid-line'],
];

function buildMusicSection() {
  const dims = MU_DIMENSIONS.map(([k, v]) =>
    `<tr><td><strong>${esc(k)}</strong></td><td>${esc(v)}</td></tr>`).join('');
  const genres = MU_GENRES.map(([k, v]) =>
    `<tr><td><strong>${esc(k)}</strong></td><td>${esc(v)}</td></tr>`).join('');
  const struct = MU_STRUCTURE.map(([k, v]) =>
    `<tr><td><code>${esc(k)}</code></td><td>${esc(v)}</td></tr>`).join('');
  const bank = MUSIC_PROMPT_EXAMPLES.map((e, i) => {
    const meta = [e.bpm ? `${e.bpm} bpm` : '', e.key || ''].filter(Boolean).join(' · ');
    return `<tr data-mu-bank="${i}">
      <td>${esc(e.caption)}${e.trigger ? ` <code>${esc(e.trigger)}</code>` : ''}</td>
      <td class="ref-nowrap">${esc(meta)}<br><span class="ref-muted">${esc((e.source || '').replace('.metadata', ''))}</span></td>
      <td class="ref-nowrap">
        <button class="btn" data-mu-copy="${i}" data-help-title="Copy caption">copy</button>
        <button class="btn" data-mu-send="${i}" data-help-title="Send to Music tab">→ Music</button>
      </td>
    </tr>`;
  }).join('');
  return `
  <div class="ref-music-grid">
    <div class="ref-card ref-music-card">
      <div class="ref-card-head"><div class="ref-card-head-icon">${SVG_INFO}</div><h4>Anatomy: caption / lyrics / metas</h4></div>
      <div class="ref-card-body">
        <p><strong>Caption</strong> = the sound (tags below). <strong>Lyrics</strong> = structure + words ([verse]/[chorus]/[inst]). <strong>Metas knobs</strong> (BPM/key/timesig on the Music tab) = musical facts. Never put BPM in the caption — it belongs in metas.</p>
        <p><strong>Granularity = control.</strong> Write less → surprises (seed rules). Write more → control. 5–12 keywords is the sweet spot; past 15 they dilute. One lead voice per short clip; conflicting styles degrade — evolve them over time instead ("starts strings, ends hip-hop").</p>
      </div>
    </div>
    <div class="ref-card ref-music-card">
      <div class="ref-card-head"><div class="ref-card-head-icon">${SVG_LAYERS}</div><h4>Caption dimensions</h4></div>
      <div class="ref-card-body"><table class="ref-table"><tbody>${dims}</tbody></table></div>
    </div>
    <div class="ref-card ref-music-card">
      <div class="ref-card-head"><div class="ref-card-head-icon">${SVG_FILM}</div><h4>Genre tag banks</h4></div>
      <div class="ref-card-body"><table class="ref-table"><tbody>${genres}</tbody></table></div>
    </div>
    <div class="ref-card ref-music-card">
      <div class="ref-card-head"><div class="ref-card-head-icon">${SVG_EYE}</div><h4>Structure &amp; lyric tags</h4></div>
      <div class="ref-card-body"><table class="ref-table"><tbody>${struct}</tbody></table>
        <p>Lines 4–8 syllables (6–10 for sung verses); repeat the chorus; keep caption↔lyrics consistent or the model gets confused. Instrumental = <code>[Instrumental]</code> lyrics + no vocal tags (never both).</p>
      </div>
    </div>
    <div class="ref-card ref-music-card">
      <div class="ref-card-head"><div class="ref-card-head-icon">${SVG_SHIELD}</div><h4>House rules (measured here)</h4></div>
      <div class="ref-card-body">
        <p>Seed = dice (same prompt+seed = bit-identical clip). CFG 5–7 loose/musical, 10–12 tight, 15+ rigid. LoRA trigger words prepend the caption. Turbo: 8 fixed steps, no CFG. Base/sft: 30–50 steps for finals.</p>
      </div>
    </div>
    <div class="ref-card ref-music-card">
      <div class="ref-card-head"><div class="ref-card-head-icon">${SVG_LAYERS}</div><h4>Official: the herd (LM planner + DiT executor)</h4></div>
      <div class="ref-card-body">
        <p>User input → <strong>5Hz LM</strong> (planner: CoT metas, caption rewrite, semantic codes) → <strong>DiT</strong> (executor: carves audio from noise). LM optional — Cover/Repaint replace planning with audio. We run DiT-only.</p>
        <table class="ref-table"><tbody>
          <tr><td><strong>No LM</strong></td><td>you plan (covers). Fastest.</td></tr>
          <tr><td><strong>0.6B / 1.7B / 4B</strong></td><td>basic / <strong>default pick</strong> / rich world knowledge</td></tr>
          <tr><td><strong>turbo / shift1 / shift3</strong></td><td>balanced 8-step / detail-rich / clear timbre, dry</td></tr>
          <tr><td><strong>sft / base</strong></td><td>CFG + 50 steps, detail / all tasks (extract, lego, complete)</td></tr>
        </tbody></table>
        <p class="ref-muted">Source: ACE-Step 1.5 Tutorial (full text below in spirit; upstream may update).</p>
      </div>
    </div>
    <div class="ref-card ref-music-card">
      <div class="ref-card-head"><div class="ref-card-head-icon">${SVG_EYE}</div><h4>Official: inference knobs</h4></div>
      <div class="ref-card-body">
        <table class="ref-table"><tbody>
          <tr><td><strong>steps</strong></td><td>8 turbo; 32–100 base. More = finer, slower.</td></tr>
          <tr><td><strong>guidance</strong></td><td>7 default; higher = adherence, may overfit. Base only.</td></tr>
          <tr><td><strong>shift</strong></td><td>big = structure first; small = detail-first (can noise).</td></tr>
          <tr><td><strong>ode / sde</strong></td><td>deterministic / extra randomness injections.</td></tr>
          <tr><td><strong>cover_strength</strong></td><td>0–1: higher = stick to source, lower = freer.</td></tr>
          <tr><td><strong>seed</strong></td><td>fix it while tuning (isolates knob effects); vary it to explore.</td></tr>
        </tbody></table>
      </div>
    </div>
    <div class="ref-card ref-music-card">
      <div class="ref-card-head"><div class="ref-card-head-icon">${SVG_FILM}</div><h4>Official: audio control</h4></div>
      <div class="ref-card-body">
        <p><strong>reference_audio</strong> = global timbre/mix (averaged over time). <strong>src_audio</strong> = melody/rhythm/chords for Cover. <strong>repaint</strong> = regenerate 3–90 s regions in context. <strong>lego/complete/extract</strong> (base only) = add tracks, finish songs, pull stems.</p>
      </div>
    </div>
    <div class="ref-card ref-music-card ref-music-bank">
      <div class="ref-card-head"><div class="ref-card-head-icon">${SVG_CHECK}</div><h4>Example bank · ${MUSIC_PROMPT_EXAMPLES.length} harvested prompts</h4></div>
      <div class="ref-card-body">
        <p><input type="text" id="muBankFilter" placeholder="filter (e.g. boom bap, 95, minor)…"></p>
        <div class="ref-table-scroll"><table class="ref-table"><tbody id="muBankBody">${bank}</tbody></table></div>
      </div>
    </div>
  </div>`;
}

function bindMusicBank() {
  const filter = document.getElementById('muBankFilter');
  if (filter) {
    filter.addEventListener('input', () => {
      const q = filter.value.trim().toLowerCase();
      document.querySelectorAll('#muBankBody tr').forEach((tr) => {
        tr.style.display = !q || tr.textContent.toLowerCase().includes(q) ? '' : 'none';
      });
    });
  }
  document.querySelectorAll('[data-mu-copy]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const e = MUSIC_PROMPT_EXAMPLES[parseInt(btn.getAttribute('data-mu-copy'), 10)];
      if (e) copyCellText(e.caption);
    });
  });
  document.querySelectorAll('[data-mu-send]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const e = MUSIC_PROMPT_EXAMPLES[parseInt(btn.getAttribute('data-mu-send'), 10)];
      if (!e) return;
      try {
        state.music = Object.assign({}, state.music, {
          prompt: (e.trigger ? e.trigger + ', ' : '') + e.caption,
          bpm: e.bpm != null ? String(e.bpm).replace(/\.0$/, '') : (state.music || {}).bpm || '',
          key: e.key || (state.music || {}).key || '',
        });
      } catch (_) { /* state unavailable */ }
      switchTab('music');
    });
  });
}

export { renderReferencesForm };
