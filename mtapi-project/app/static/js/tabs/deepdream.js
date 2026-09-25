import { state, elements, bestInput, logConsole } from '/app.js';
import { setupContinuousKnob, setupBinaryKnob, knobUnitHtml } from '/js/ui/knobs.js';
import { runOpWithCancel } from '/js/job-control.js';
import {
  evolveRifeModelSelectHtml,
  evolveRifeKnobUnitsHtml,
  setupEvolveRifeKnobs,
  collectEvolveRifeFields,
  setupEvolveMasterToggle,
} from '/js/ui/evolve-rife.js';
import { withFrameRange } from '/js/utils.js';

// ── DeepDream tab ─────────────────────────────────────────────────────────

/** Real nets + their custom-knob layers (must match deepdream_engine.py). */
const DREAM_MODELS = {
  inception_v3: {
    label: 'InceptionV3 (ImageNet) — classic Google DeepDream',
    layers: [
      { id: 'mixed0', label: 'mixed0', def: 0 },
      { id: 'mixed1', label: 'mixed1', def: 0 },
      { id: 'mixed2', label: 'mixed2', def: 0 },
      { id: 'mixed3', label: 'mixed3', def: 0 },
      { id: 'mixed4', label: 'mixed4', def: 1.0 },
      { id: 'mixed5', label: 'mixed5', def: 1.5 },
      { id: 'mixed6', label: 'mixed6', def: 2.0 },
      { id: 'mixed7', label: 'mixed7', def: 2.5 },
      { id: 'mixed8', label: 'mixed8', def: 0 },
      { id: 'mixed9', label: 'mixed9', def: 0 },
      { id: 'mixed10', label: 'mixed10', def: 0 },
    ],
    presets: {
      shallow: 'Shallow — mixed3–4 (fine textures)',
      mid: 'Mid — mixed4–6',
      deep: 'Deep — mixed5–7 (large forms)',
      classic: 'Classic — mixed4–7 (Google-style)',
      full: 'Full — mixed3–7',
      custom: 'Custom weights (knobs below)',
    },
  },
  vgg16: {
    label: 'VGG16 (ImageNet) — hierarchical / classic NN dream look',
    layers: [
      { id: 'block2_conv2', label: 'b2c2', def: 0 },
      { id: 'block3_conv3', label: 'b3c3', def: 0.5 },
      { id: 'block4_conv3', label: 'b4c3', def: 1.0 },
      { id: 'block5_conv1', label: 'b5c1', def: 1.5 },
      { id: 'block5_conv2', label: 'b5c2', def: 0 },
      { id: 'block5_conv3', label: 'b5c3', def: 2.0 },
    ],
    presets: {
      shallow: 'Shallow — block2–3 (edges / textures)',
      mid: 'Mid — block3–4',
      deep: 'Deep — block4–5 (objects / eyes)',
      classic: 'Classic — block3/4/5 mix',
      full: 'Full — block2–5',
      custom: 'Custom weights (knobs below)',
    },
  },
  resnet50: {
    label: 'ResNet50 (ImageNet) — residual features, different "creatures"',
    layers: [
      { id: 'conv2_block3_out', label: 'c2b3', def: 0 },
      { id: 'conv3_block4_out', label: 'c3b4', def: 0.8 },
      { id: 'conv4_block1_out', label: 'c4b1', def: 1.0 },
      { id: 'conv4_block6_out', label: 'c4b6', def: 1.5 },
      { id: 'conv5_block3_out', label: 'c5b3', def: 2.0 },
    ],
    presets: {
      shallow: 'Shallow — conv2–3',
      mid: 'Mid — conv3–4',
      deep: 'Deep — conv4–5',
      classic: 'Classic — conv3/4/5 mix',
      full: 'Full — conv2–5',
      custom: 'Custom weights (knobs below)',
    },
  },
};

function renderDeepDreamForm() {
  const html = `
    <div class="panel-title-desc dense">
      <h3>Google DeepDream</h3>
      <p class="dream-hint">CNN gradient ascent — pick model + layers. Image / video / Ouroboros.
        GPU V1/V2 = OpenVINO static dream; GPU V3 = dynamic Mixed_5b/5c/6a/6b/6c weighting with
        optional forward-only Turbo. Fixed 512/1.4 pyramid; other models/guides stay CPU-only.</p>
    </div>
    <div class="form-row">
      <label for="dreamEngine">Engine</label>
      <select id="dreamEngine" data-help-title="Engine — CPU / OpenVINO" data-help-text="CPU · TF nets = full knobs. GPU V1/V2 use static OpenVINO graphs. GPU V3 uses runtime Mixed_5b/5c/6a/6b/6c weights and can use the forward-only Turbo graph; V3 needs its exported artifacts.">
        <option value="cpu">CPU · TF nets (full knobs)</option>
        <option value="gpu">GPU V1 · OpenVINO static (iGPU)</option>
        <option value="gpu_v2">GPU V2 · OpenVINO optimized (iGPU)</option>
        <option value="gpu_v3">GPU V3 · OpenVINO dynamic (iGPU)</option>
      </select>
      <span class="form-row-hint" id="dreamOvStatus">GPU status: checking…</span>
    </div>
    <div class="form-row dream-gpu-only hidden" id="dreamGpuSetupRow">
      <button type="button" class="btn" id="btnDreamOvSetup">GPU Setup</button>
      <button type="button" class="btn" id="btnDreamOvRefresh">Refresh</button>
      <span class="form-row-hint">One-time IR install + CPU smoke + GPU probe.</span>
    </div>
    <div class="knob-row settings-inline-warm">
      <div class="knob-bank">${knobUnitHtml({ id: 'dreamWarm', label: 'Keep warm', value: state.settings?.warmModels?.deepdream ? '1' : '0', binary: true, leftCap: 'Off', rightCap: 'On', helpTitle: 'Keep warm — Off / On', helpText: 'Keeps the DeepDream model resident between runs. On = faster repeat runs, holds VRAM.' })}</div>
      <p class="knob-row-legend">Keep the DeepDream model resident between runs (uses VRAM).</p>
    </div>

    <div class="knob-row dream-turbo-only">
      <div class="knob-bank">
        ${knobUnitHtml({ id: 'dreamTurbo', label: 'Turbo', value: '0', binary: true, leftCap: 'Off', rightCap: 'On', helpTitle: 'Turbo — forward-only saliency', helpText: 'GPU V3 only. Replaces gradient ascent with a forward activation stamp: much faster, flatter texture, less recursive fractal depth.' })}
        <div class="dream-turbo-strength">${knobUnitHtml({ id: 'dreamTurboStrength', label: 'Stamp', value: '0.5', helpTitle: 'Turbo stamp strength [0–1]', helpText: 'How strongly the GPU V3 Turbo saliency map is stamped onto the image. 0 = no change, 1 = full stamp.' })}</div>
      </div>
      <p class="knob-row-legend">Turbo uses the V3 forward-only graph; Stamp controls the saliency overlay.</p>
    </div>

    <div class="form-row">
      <label for="dreamInput">Input</label>
      <div class="input-row">
        <input type="text" id="dreamInput" placeholder="image.png or video.mp4" data-help-title="Input — image or video" data-help-text="Absolute path to a still (PNG/JPG/…) or video (MP4/…). Blank falls back to the global Video/Image bar.">
        <button class="btn" type="button" id="btnDreamBrowseIn" data-help-title="Browse input" data-help-text="Pick the source still or video file.">Browse</button>
      </div>
    </div>
    <div class="form-row">
      <label for="dreamOutput">Output</label>
      <div class="input-row">
        <input type="text" id="dreamOutput" placeholder="blank = auto next to source" data-help-title="Output — blank = next to source" data-help-text="Where to write. Blank = next to the source (_dream.png / _dream.mp4 / _ouroboros.mp4).">
        <button class="btn" type="button" id="btnDreamBrowseOut" data-help-title="Browse output" data-help-text="Pick where the dream result is written (blank = next to source).">Save As</button>
      </div>
    </div>
    <div class="form-row">
      <label for="dreamGuide">Guide</label>
      <div class="input-row">
        <input type="text" id="dreamGuide" placeholder="optional — steer features (blank = classic L2)" data-help-title="Guide — steer features (optional)" data-help-text="A second still whose features steer the dream (blank = classic L2). Guide is a target in feature space, not a paste; works best as a clear photo.">
        <button class="btn" type="button" id="btnDreamBrowseGuide" data-help-title="Browse guide" data-help-text="Pick the guide image whose features steer the dream.">Browse</button>
      </div>
      <p class="form-row-hint">Match activations to guide (flowers → floral, faces → face-like…)</p>
    </div>

    <div class="knob-row">
      <div class="knob-bank">
        ${knobUnitHtml({ id: 'dreamMedia', label: 'Media', value: 'auto', binary: true, leftCap: 'Image', rightCap: 'Video', helpTitle: 'Media — Image / Video', helpText: 'Tells the op to treat the path as a still or as a video. Only used when Detect is Force; with Auto (default) the file extension wins and this knob is ignored.' })}
        ${knobUnitHtml({ id: 'dreamAutoDetect', label: 'Detect', value: '1', binary: true, leftCap: 'Force', rightCap: 'Auto', helpTitle: 'Detect — Force / Auto', helpText: 'Auto (default) decides by file extension; Force honors the Media knob instead. Use Force if a still is mis-detected or you opened a frames folder-like name.' })}
        ${knobUnitHtml({ id: 'dreamJitter', label: 'Jitter', value: '1', binary: true, leftCap: 'Off', rightCap: 'On', helpTitle: 'Jitter — Off / On', helpText: 'Random pixel shift each ascent step (classic DeepDream trick). On (default) reduces tile seams and grid artifacts; Off can look sharper but more gridlocked.' })}
        ${knobUnitHtml({ id: 'dreamDetail', label: 'Detail', value: '1', binary: true, leftCap: 'Off', rightCap: 'On', helpTitle: 'Detail — Off / On', helpText: 'Reinjects high-frequency detail between octaves so it is not lost when scaling down. On (default) = richer texture; Off = smoother, more smudged.' })}
        ${knobUnitHtml({ id: 'dreamAudio', label: 'Audio', value: '1', binary: true, leftCap: 'Drop', rightCap: 'Keep', helpTitle: 'Audio — Drop / Keep', helpText: 'Video only. Keep (default) muxes original audio onto the encoded result; Drop = silent video. Stills ignore this.' })}
        ${knobUnitHtml({ id: 'dreamDryRun', label: 'Dry run', value: '0', binary: true, leftCap: 'Run', rightCap: 'Dry', helpTitle: 'Dry run — Run / Dry', helpText: 'Dry validates params and paths without running inference. No output files are written.' })}
        ${knobUnitHtml({ id: 'dreamDynamic', label: 'Dynamic', value: '0', binary: true, leftCap: 'Off', rightCap: 'On', helpTitle: 'Dynamic — Off / On', helpText: 'Video only. When On, the start ascent values above lerp per frame across the clip to their “→” end values. Off (default) = fixed values throughout.' })}
      </div>
      <p class="knob-row-legend">Detect=Auto uses extension. Force uses Media knob.</p>
    </div>

    <div class="knob-row">
      <div class="knob-bank">
        ${knobUnitHtml({ id: 'dreamStep', label: 'Step', value: '0.01', helpTitle: 'Step — gradient step size [0.001–0.1]', helpText: 'How far each ascent step moves toward more activation. Higher = faster, stronger, easier to blow out into noise; lower = slower, subtler. Engine scales per model so strength feels comparable. Sane: 0.005–0.03; default 0.01.' })}
        ${knobUnitHtml({ id: 'dreamIters', label: 'Iterations', value: '20', helpTitle: 'Iterations — gradient steps per octave [1–100]', helpText: 'Gradient steps per octave. More = denser patterns, longer runtime. Try 10 for previews, 20–40 for a solid still; keep modest on long clips. Sane: 10–40; default 20.' })}
        ${knobUnitHtml({ id: 'dreamOctaves', label: 'Octaves', value: '3', helpTitle: 'Octaves — pyramid depth [1–8]', helpText: 'How many resolution scales to climb. 1 = single scale (faster, flatter); 3 = classic multi-scale look. More octaves = more structure, time, VRAM. Sane: 2–5; default 3.' })}
        ${knobUnitHtml({ id: 'dreamOctScale', label: 'Oct scale', value: '1.4', helpTitle: 'Oct scale — per-octave downscale [1.1–2.0]', helpText: 'Size ratio between successive octaves. Closer to 1.1 = more gradual; closer to 2 = dramatic scale hops; 1.4 is Google-ish. Sane: 1.2–1.7; default 1.4.' })}
        ${knobUnitHtml({ id: 'dreamMaxLoss', label: 'Max loss', value: '0', helpTitle: 'Max loss — early-stop ceiling [0–50]', helpText: 'Absolute ceiling on the ascent objective; when loss climbs past this, that octave stops early. 0 = off (recommended default; leave off for VGG/ResNet). Sane: 15–25 on Inception; default off (0).' })}
        ${knobUnitHtml({ id: 'dreamBlend', label: 'Blend', value: '1.0', helpTitle: 'Blend — dream vs original mix [0–1]', helpText: 'How much of the dreamed image to keep vs the original at the end of the pass. 1.0 = full dream; 0.5 = half original, half dream (gentler filter look). Sane: 0.6–1.0; default 1.0.' })}
        ${knobUnitHtml({ id: 'dreamPreviewW', label: 'Preview W', value: '0', helpTitle: 'Preview W — render max width [0–1280]', helpText: 'If > 0, dream at this max width (height scales); 0 = full native resolution. Use 480–640 to iterate knobs quickly, full for the final export. Sane: 480–640; default 0 (full).' })}
      </div>
      <p class="knob-row-legend">Ascent knobs. Preview W 0 = full width.</p>
    </div>

    <div class="knob-row dream-dynamic-only" id="dreamDynamicRampRow">
      <div class="knob-bank">
        ${knobUnitHtml({ id: 'dreamStepTo', label: 'Step →', value: '0.01', helpTitle: 'Step → — dynamic end step [0.001–0.1]', helpText: 'End value the Step knob lerps to per frame across the clip when Dynamic is On (video only). Sane: 0.005–0.03; default 0.01.' })}
        ${knobUnitHtml({ id: 'dreamItersTo', label: 'Iters →', value: '20', helpTitle: 'Iters → — dynamic end iterations [1–100]', helpText: 'End value Iterations lerps to per frame across the clip when Dynamic is On (video only). Sane: 10–40; default 20.' })}
        ${knobUnitHtml({ id: 'dreamOctavesTo', label: 'Octaves →', value: '3', helpTitle: 'Octaves → — dynamic end octaves [1–8]', helpText: 'End value Octaves lerps to per frame across the clip when Dynamic is On (video only). Sane: 2–5; default 3.' })}
        ${knobUnitHtml({ id: 'dreamOctScaleTo', label: 'OctScale →', value: '1.4', helpTitle: 'OctScale → — dynamic end scale [1.1–2.0]', helpText: 'End value Oct scale lerps to per frame across the clip when Dynamic is On (video only). Sane: 1.2–1.7; default 1.4.' })}
        ${knobUnitHtml({ id: 'dreamMaxLossTo', label: 'MaxLoss →', value: '0', helpTitle: 'MaxLoss → — dynamic end ceiling [0–50]', helpText: 'End value Max loss lerps to per frame across the clip when Dynamic is On (video only). 0 = off. Sane: 15–25 on Inception; default off (0).' })}
        ${knobUnitHtml({ id: 'dreamBlendTo', label: 'Blend →', value: '1.0', helpTitle: 'Blend → — dynamic end blend [0–1]', helpText: 'End value Blend lerps to per frame across the clip when Dynamic is On (video only). Sane: 0.6–1.0; default 1.0.' })}
      </div>
      <p class="knob-row-legend dream-dynamic-only">
        <strong>Dynamic ramp</strong> (video only): the start values above lerp to
        these end values per frame across the clip.
      </p>
    </div>

    <div class="form-row">
      <label for="dreamModel">Model</label>
      <select id="dreamModel" data-help-title="Model — InceptionV3 / VGG16 / ResNet50" data-help-text="Which ImageNet CNN provides the features; different nets give different creatures and textures. Weights may download once on first use. InceptionV3 (default) is the classic Google look.">
        <option value="inception_v3" selected>InceptionV3 — classic</option>
        <option value="vgg16">VGG16 — hierarchical</option>
        <option value="resnet50">ResNet50 — residual</option>
      </select>
      <label for="dreamLayerPreset">Layers</label>
      <select id="dreamLayerPreset" data-help-title="Layers — preset layer mix" data-help-text="Presets pick a weighted mix of real layers for the current model. Deeper = bigger, weirder forms; shallower = more filigree. Custom shows per-layer weight knobs (0–5)."></select>
      <p class="form-row-hint">Real architectures (weights may download once). Preset maps to that net’s layers.</p>
    </div>

    <div class="dream-section-title dream-layer-weights" id="dreamLayerWeightsTitle">Custom layer weights</div>
    <div class="knob-bank dream-layer-weights" id="dreamLayerWeightsBank"></div>

    <div class="dream-section-title dream-layer-weights dream-dynamic-only" id="dreamLayerWeightsTitleTo">Custom layer weights → (end)</div>
    <div class="knob-bank dream-layer-weights dream-dynamic-only" id="dreamLayerWeightsBankTo"></div>

    <div class="knob-row dream-video-only" id="dreamVideoBank">
      <div class="knob-bank">
        ${knobUnitHtml({ id: 'dreamFrameStep', label: 'Frame step', value: '1', helpTitle: 'Frame step — frame skip per dream [1–30]', helpText: '1 = dream every dumped frame; 2 = dream every other frame and hold the last dream on skipped frames (cheaper, slightly stepped motion). Higher = faster, choppier. Sane: 1–6; default 1.' })}
        ${knobUnitHtml({ id: 'dreamMaxFrames', label: 'Max frames', value: '0', helpTitle: 'Max frames — frame cap [0–500]', helpText: 'Cap how many frames to process after dump/range. 0 = all. Set 24–48 to test settings on a short slice before a full render. Sane: 24–120 when scouting; default 0 (all).' })}
        ${knobUnitHtml({ id: 'dreamTemporalBlend', label: 'Temporal blend', value: '0.85', helpTitle: 'Temporal blend — previous-dream carry [0–1]', helpText: 'Mixes the previous frame’s dream into the next start so the trip does not flicker. 0.85 = classic sticky; 1 = off (no mix). Ignored when Optical flow is On. Sane: 0.75–0.95; default 0.85.' })}
        ${knobUnitHtml({ id: 'dreamOpticalFlow', label: 'Optical flow', value: '0', binary: true, leftCap: 'Off', rightCap: 'On', helpTitle: 'Optical flow — Off / On', helpText: 'When On, estimates motion between frames and warps the dream residual so patterns stick to moving objects. Heavier; overrides temporal blend while enabled; best on smooth camera moves.' })}
        ${knobUnitHtml({ id: 'dreamLayerCycle', label: 'Layer cycle', value: '0', binary: true, leftCap: 'Off', rightCap: 'On', helpTitle: 'Layer cycle — Off / On', helpText: 'When On, each frame optimizes one layer in a loop instead of the full weighted mix (DeepDreamAnim-style), morphing which creature dominates. Off (default) = same layer mix every frame.' })}
      </div>
      <p class="knob-row-legend dream-video-only">
        <strong>Temporal blend</strong> 0.85 classic · 1 = off.
        <strong>Optical flow</strong> warps residual (ignores blend when on).
        <strong>Layer cycle</strong> = one layer/frame. Step &gt; 1 holds last dream.
      </p>
    </div>

    <div class="knob-row">
      <div class="knob-bank">
        ${knobUnitHtml({ id: 'dreamOuro', label: 'Ouroboros', value: '0', binary: true, leftCap: 'Off', rightCap: 'On', helpTitle: 'Ouroboros — Off / On', helpText: 'Turns one still into a feedback clip: dream, transform, feed the result back. On reveals the transform + length knobs, hides the video bank, and always writes a video (no source audio).' })}
      </div>
      <p class="knob-row-legend">Still → dream → transform → feedback loop (writes video).</p>
    </div>
    <div class="dream-ouro-only" id="dreamOuroPanel">
      <div class="form-row">
        <label for="dreamFrameTransform">Transform</label>
        <select id="dreamFrameTransform" data-help-title="Transform — ouroboros drift per frame" data-help-text="Applied after each dreamed frame, before the next loop. Zoom + Spin (default) is the classic tunnel; None = pure feedback without geometric drift.">
          <option value="zoom_rotate" selected>Zoom + Spin</option>
          <option value="zoom">Zoom only</option>
          <option value="rotate">Spin only</option>
          <option value="translate">Translate</option>
          <option value="none">None</option>
        </select>
      </div>
      <div class="knob-row">
        <div class="knob-bank">
          ${knobUnitHtml({ id: 'dreamOuroLen', label: 'Frames', value: '30', helpTitle: 'Frames — feedback loop length [1–300]', helpText: 'How many feedback steps / output frames. 30 @ 30 FPS ≈ 1 second; longer = longer trip and much more total dream time. Sane: 30–120; default 30.' })}
          ${knobUnitHtml({ id: 'dreamOuroFps', label: 'FPS', value: '30', helpTitle: 'FPS — playback rate [1–60]', helpText: 'Playback rate of the written video. Transform amounts scale with FPS so per-second motion stays similar. Sane: 24–30; default 30.' })}
          ${knobUnitHtml({ id: 'dreamZoom', label: 'Zoom', value: '1.04', helpTitle: 'Zoom — scale per frame [0.9–1.15]', helpText: 'Scale factor per frame when zoom is in the transform. > 1 = zoom in (default mild crawl); < 1 = zoom out. Tiny changes compound over dozens of frames. Sane: 1.01–1.06; default 1.04.' })}
          ${knobUnitHtml({ id: 'dreamSpin', label: 'Spin °', value: '1.5', helpTitle: 'Spin ° — rotation per frame [-15–15]', helpText: 'Rotation degrees per frame. Positive / negative = direction; small values accumulate into a full spin over the clip. Sane: 0.5–3; default 1.5.' })}
          ${knobUnitHtml({ id: 'dreamTx', label: 'Pan X', value: '5', helpTitle: 'Pan X — horizontal pan px/frame [-20–20]', helpText: 'Pixel translation per frame when Translate (or a transform that uses it) is active. Positive X pans content left-ish — tweak by eye. Sane: 0–10; default 5.' })}
          ${knobUnitHtml({ id: 'dreamTy', label: 'Pan Y', value: '5', helpTitle: 'Pan Y — vertical pan px/frame [-20–20]', helpText: 'Pixel translation per frame when Translate (or a transform that uses it) is active. Sane: 0–10; default 5.' })}
        </div>
        <p class="knob-row-legend">
          Zoom &gt; 1 in/frame · Spin °/frame · Translate +X/+Y pan (default 5px). Scales with FPS.
        </p>
      </div>
    </div>

    <div class="knob-row">
      <div class="knob-bank">
        ${knobUnitHtml({ id: 'dreamEvolve', label: 'Evolve', value: '0', binary: true, leftCap: 'Off', rightCap: 'On', helpTitle: 'Evolve — Off / On', helpText: 'When On, captures mid-ascent frames, drops near-dups (Image Sort metrics), optional RIFE, then encodes *_dream_evolve.mp4. v1 is still images only.' })}
      </div>
      <p class="knob-row-legend">
        Capture mid-ascent frames → drop near-dups (Image Sort metrics) → optional RIFE →
        <code>*_dream_evolve.mp4</code> (still export unchanged).
      </p>
    </div>
    <div class="dream-evolve-only hidden" id="dreamEvolvePanel">
      <div class="form-row">
        <label for="dreamEvolveMetric">Metric</label>
        <select id="dreamEvolveMetric" data-help-title="Evolve metric — near-dup detector" data-help-text="Dedup metric for mid-ascent frames: pHash structure (default, thr 4), aHash coarse brightness, colorhash palette, MSE pixel distance, SSIM (if installed).">
          <option value="phash" selected>pHash — structure (default thr 4)</option>
          <option value="ahash">aHash — coarse brightness</option>
          <option value="colorhash">colorhash — palette</option>
          <option value="mse">MSE — pixel distance</option>
          <option value="ssim">SSIM distance (if installed)</option>
        </select>
      </div>
      ${evolveRifeModelSelectHtml('dreamEvolve')}
      <div class="knob-row">
        <div class="knob-bank">
          ${knobUnitHtml({ id: 'dreamEvolveFps', label: 'FPS', value: '12', helpTitle: 'Evolve FPS — playback rate [1–60]', helpText: 'Playback rate of the *_dream_evolve.mp4. Sane: 10–24; default 12.' })}
          ${knobUnitHtml({ id: 'dreamEvolveThr', label: 'Min dist', value: '4', helpTitle: 'Min dist — duplicate threshold [0–32]', helpText: 'Minimum Image-Sort distance between kept frames. 0 = keep all; pHash ~4 default; higher = fewer frames. Sane: 3–8; default 4.' })}
          ${knobUnitHtml({ id: 'dreamEvolveCapN', label: 'Every N', value: '0', helpTitle: 'Every N — publish cadence [0–20]', helpText: '0 = live cadence (default); else keep a frame every N ascent publishes. Sane: 0–10; default 0.' })}
          ${evolveRifeKnobUnitsHtml('dreamEvolve')}
        </div>
        <p class="knob-row-legend">
          <strong>Min dist</strong> 0 = keep all · pHash ~4 default · higher = fewer frames.
          <strong>Every N</strong> 0 = live cadence · else every N ascent publishes.
          <strong>RIFE</strong> fills between kept keyframes (shared UI + bookend).
        </p>
      </div>
    </div>

    <div class="knob-row">
      <div class="knob-bank">
        <button type="button" class="btn" id="btnDreamExportSettings">⤓ Export settings (JSON)</button>
      </div>
      <p class="knob-row-legend">
        Serializes the current panel exactly as Run would POST it — a reusable script body for
        <code>curl</code>/python. No backend change; the server already speaks this JSON.
      </p>
    </div>

    <section class="tool-docs" aria-label="About DeepDream">
      <h4 class="tool-docs-title">About · DeepDream</h4>
      <p class="tool-docs-lede">
        <strong>DeepDream</strong> is reverse engineering of a vision network’s imagination.
        You start from a real photo or video frame. A CNN (trained on ImageNet to recognize
        dogs, buildings, textures…) looks at the pixels and lights up internal “feature”
        maps. Instead of asking “what is this?”, we <em>maximize</em> those activations —
        gradient ascent on the image itself — so the pixels morph until the net “sees”
        more of whatever patterns that layer cares about. Edges become eyes, bark becomes
        fur, clouds become architecture. That is the classic 2015 Google look.
      </p>
      <p class="tool-docs-lede">
        This tab runs that idea three ways: <strong>still image</strong> (one dream),
        <strong>video</strong> (dream every frame, with options so the trip stays coherent
        across time), and <strong>Ouroboros</strong> (dream a still → warp it → feed the
        result back → write a clip). Video uses the filter platform
        (dump → per-frame dream → encode). First ImageNet weight download can take a while;
        after that, cost is mostly GPU/CPU per frame × octaves × iterations.
      </p>

      <h5 class="tool-docs-h">If you are new — try this first</h5>
      <ol class="tool-docs-ol">
        <li>Put a <strong>still</strong> in Input (or the global Image bar). Leave Ouroboros <strong>Off</strong>.</li>
        <li>Model <strong>InceptionV3</strong>, Layers <strong>Classic</strong>.</li>
        <li>Leave defaults: Step 0.01, Iterations 20, Octaves 3, Jitter/Detail On.</li>
        <li>Optional: set <strong>Preview W</strong> to ~640 for a faster test render.</li>
        <li>Run. If it is too mild, raise Iterations or use Layers <strong>Deep</strong>.
            If it is pure noise soup, lower Step, or use <strong>Shallow</strong> layers.
            Leave <strong>Max loss off</strong> unless you know Inception-scale losses.</li>
      </ol>

      <h5 class="tool-docs-h">Paths</h5>
      <dl class="tool-docs-dl">
        <dt>Input</dt>
        <dd>Absolute path to a still (PNG/JPG/…) or video (MP4/…). Blank local field falls back to the global Video/Image bar.</dd>
        <dt>Output</dt>
        <dd>Where to write. Blank = next to the source (<code>*_dream.png</code> / <code>*_dream.mp4</code> / <code>*_ouroboros.mp4</code>).</dd>
        <dt>Guide (optional)</dt>
        <dd>A second still whose <em>features</em> steer the dream. Blank = classic L2
          “amplify whatever is already firing.” With a guide, ascent tries to match the
          guide’s activations — flowers push floral textures, a face pushes face-like
          structure. Guide is not a paste/composite; it is a target in feature space.
          Works best as a clear photo, not a blank or pure noise.</dd>
      </dl>

      <h5 class="tool-docs-h">Mode switches (top binary row)</h5>
      <dl class="tool-docs-dl">
        <dt>Media · Image | Video</dt>
        <dd>Only used when Detect is <strong>Force</strong>. Tells the op “treat this path
          as a still” or “as a video” even if the extension is weird. With Detect <strong>Auto</strong>
          (default), the file extension wins and this knob is ignored.</dd>
        <dt>Detect · Force | Auto</dt>
        <dd><strong>Auto</strong> (default): <code>.mp4</code>/<code>.mov</code>/… → video path;
          image extensions → still. <strong>Force</strong>: honor the Media knob instead.
          Use Force if a still is mis-detected or you opened a frames folder-like name.</dd>
        <dt>Jitter · Off | On</dt>
        <dd>Random pixel shift each ascent step (classic DeepDream trick).
          <strong>On</strong> (default) reduces tile seams and “grid” artifacts; slightly
          softer / more organic. Off can look sharper but more gridlocked.</dd>
        <dt>Detail · Off | On</dt>
        <dd><strong>Reinject detail between octaves.</strong> DeepDream works multi-scale
          (see Octaves). When On (default), high-frequency detail lost when scaling is
          mixed back in — richer texture. Off = smoother, more “smudged” dream.</dd>
        <dt>Audio · Drop | Keep</dt>
        <dd>Video only. <strong>Keep</strong> (default) muxes original audio onto the
          encoded result. Drop = silent video. Stills ignore this.</dd>
        <dt>Dry run · Run | Dry</dt>
        <dd><strong>Dry</strong> plans paths/params and returns without dreaming — use to
          check wiring. <strong>Run</strong> does the real job.</dd>
      </dl>

      <h5 class="tool-docs-h">Ascent knobs (how hard / how multi-scale)</h5>
      <p>
        Think of one “dream pass” as: for each <strong>octave</strong> (scale), take
        <strong>Iterations</strong> gradient steps of size <strong>Step</strong>, then
        move to a larger scale. Total work ≈ octaves × iterations × resolution.
      </p>
      <dl class="tool-docs-dl">
        <dt>Step (default 0.01)</dt>
        <dd>How far each ascent step moves in the “more activation” direction.
          Higher = faster, stronger, easier to blow out into noise.
          Lower = slower, subtler. Range ~0.001–0.1.
          The engine scales step per model (VGG/ResNet need a larger internal
          multiplier than Inception) so the same knob strength is roughly comparable.
          If results look like colorful static, cut Step first. If nothing changes,
          check <strong>Max loss is off</strong> and raise Step slightly.</dd>
        <dt>Iterations (default 20)</dt>
        <dd>Gradient steps <em>per octave</em>. More = denser patterns, longer runtime.
          Try 10 for previews, 20–40 for a solid still, higher only when you know Step
          is stable. Video multiplies this by frame count — keep modest on long clips.</dd>
        <dt>Octaves (default 3)</dt>
        <dd>How many resolution scales to climb. 1 = single scale (faster, flatter).
          3 is the classic multi-scale look (fine texture + large shapes).
          More octaves = more structure at more sizes, more time, more VRAM pressure.</dd>
        <dt>Oct scale (default 1.4)</dt>
        <dd>Size ratio between successive octaves (~1.1–2.0). Larger scale steps =
          bigger jump between “fine” and “coarse” levels. 1.4 is Google-ish.
          Closer to 1.1 = more gradual; closer to 2 = dramatic scale hops.</dd>
        <dt>Max loss (default <strong>off</strong>)</dt>
        <dd>Absolute ceiling on the ascent objective. When loss climbs past this,
          that octave stops early. <strong>Leave off (0) for VGG/ResNet</strong> —
          their losses are often hundreds of thousands; a ceiling of 15 stops after
          <em>one step</em> and the output looks like the original. Inception
          classic losses are smaller (often O(1–20)); a value like 15–25 can make
          sense there. Engine also auto-ignores max_loss if baseline loss already
          exceeds the threshold (wrong scale for the model).</dd>
        <dt>Blend (default 1.0)</dt>
        <dd>How much of the dreamed image to keep vs the original, at the end of the pass.
          <strong>1.0</strong> = full dream. <strong>0.5</strong> = half original, half dream
          (gentler “filter” look). <strong>0</strong> would be “no dream” (pointless).
          Useful when full dream is too aggressive for a photo you still want recognizable.</dd>
        <dt>Preview W (default full)</dt>
        <dd>If &gt; 0, dream at this max width (height scales). <strong>full</strong> = native
          resolution. Use 480–640 to iterate knobs quickly; set full for the final export.
          Does not change the “style” of layers, only how many pixels you pay for.</dd>
      </dl>

      <h5 class="tool-docs-h">Model</h5>
      <p>
        Which ImageNet CNN provides the features. Different nets → different “creatures”
        and textures. Weights may download once on first use.
      </p>
      <dl class="tool-docs-dl">
        <dt>InceptionV3 (default) — classic</dt>
        <dd>The Google DeepDream poster child. Mixed layers give that famous recursive
          dog-slug-architecture look. Best starting point for “looks like DeepDream.”</dd>
        <dt>VGG16 — hierarchical</dt>
        <dd>Older, very layered stack. Often cleaner edges / more “painterly” hierarchy.
          Shallow blocks = edges and textures; deep blocks = object-ish blobs and eyes.</dd>
        <dt>ResNet50 — residual</dt>
        <dd>Different residual features → different menagerie. Try when Inception feels
          samey or you want another aesthetic. Engine uses a higher internal step
          scale than Inception so UI Step feels similar; leave <strong>Max loss off</strong>
          (ResNet objectives are large — a low ceiling early-stops after one step).</dd>
      </dl>

      <h5 class="tool-docs-h">Layers (preset)</h5>
      <p>
        CNNs are a stack: early layers = edges, colors, small textures; late layers =
        larger shapes, object parts, whole-scene structure. Presets pick a weighted mix
        of real layers for the <em>current</em> model. “Deeper” = bigger, weirder forms;
        “shallower” = more filigree and surface.
      </p>
      <dl class="tool-docs-dl">
        <dt>Shallow</dt>
        <dd>Early layers only — fine textures, strokes, noise patterns. Subtle or
          psychedelic grit without huge floating dogs.</dd>
        <dt>Mid</dt>
        <dd>Middle of the net — balanced detail and structure.</dd>
        <dt>Deep</dt>
        <dd>Late layers — large forms, eyes, animals, architecture. Strong “hallucination.”</dd>
        <dt>Classic (default)</dt>
        <dd>Hand-tuned mid→deep mix in the spirit of public DeepDream demos.
          Good default for stills and video.</dd>
        <dt>Full</dt>
        <dd>Many layers at once — densest, busiest, often heaviest. Can overcook.</dd>
        <dt>Custom</dt>
        <dd>Shows per-layer weight knobs (0–5). <strong>0</strong> = that layer off.
          Higher weight = that layer pulls harder. Start from a preset’s idea, then
          zero what you hate and boost what you like. Only positive weights are sent.</dd>
      </dl>

      <h5 class="tool-docs-h">Video-only knobs</h5>
      <p>
        Visible when the input is treated as video and Ouroboros is off. Global
        <strong>frame range</strong> (bar above) still limits which portion of the clip
        is dumped. Dreaming every frame of a long HD clip can take a long time — use
        Max frames / Frame step / Preview W to scout.
      </p>
      <dl class="tool-docs-dl">
        <dt>Frame step (default 1)</dt>
        <dd><strong>1</strong> = dream every dumped frame. <strong>2</strong> = dream every
          other frame and hold the last dream on skipped frames (cheaper, slightly
          stepped motion). Higher = faster, choppier dream updates.</dd>
        <dt>Max frames (default all)</dt>
        <dd>Cap how many frames to process after dump/range. <strong>all</strong> = whole
          selection. Set 24–48 to test settings on a short slice before a full render.</dd>
        <dt>Temporal blend (default 0.85)</dt>
        <dd>Mixes the previous frame’s dream into the next start so the trip does not
          flicker randomly each frame. <strong>0.85</strong> is the classic “sticky”
          look. Lower = more independent per-frame dreams (flicker / strobe).
          <strong>off</strong> (≈1.0 on the knob format) = no temporal mix.
          Ignored when Optical flow is On (flow replaces this strategy).</dd>
        <dt>Optical flow · Off | On</dt>
        <dd>When On, estimates motion between frames and warps the dream residual so
          patterns stick to moving objects instead of swimming in place.
          Heavier and can glitch on hard cuts / pure noise; great on smooth camera moves.
          Overrides temporal blend while enabled.</dd>
        <dt>Layer cycle · Off | On</dt>
        <dd>When On, each frame optimizes <em>one</em> layer in a loop instead of the full
          weighted mix every frame (DeepDreamAnim-style). Creates a rhythmic morph of
          which “creature” dominates. Off (default) = same layer mix every frame
          (stable look). Fun for music-video energy; less for a single locked style.</dd>
      </dl>

      <h5 class="tool-docs-h">Ouroboros (still → feedback video)</h5>
      <p>
        Turns <strong>one still</strong> into a clip without a source video: dream the
        image, apply a small transform, use the result as the next input, repeat.
        Patterns crawl, zoom, and spin into infinity — the “endless zoom” DeepDream videos.
        Audio is not carried (there is no source soundtrack). Output is always a video.
      </p>
      <dl class="tool-docs-dl">
        <dt>Ouroboros · Off | On</dt>
        <dd>Master switch. On reveals transform + length knobs and hides the video-only
          bank (you are not processing a source clip).</dd>
        <dt>Transform</dt>
        <dd>
          Applied after each dreamed frame, before the next loop:
          <strong>Zoom + Spin</strong> (default) classic tunnel;
          <strong>Zoom only</strong> / <strong>Spin only</strong>;
          <strong>Translate</strong> pan by Pan X/Y;
          <strong>None</strong> pure feedback without geometric drift (patterns intensify in place).
        </dd>
        <dt>Frames (default 30)</dt>
        <dd>How many feedback steps / output frames. 30 @ 30 FPS ≈ 1 second. Longer =
          longer trip and much more total dream time (each frame is a full still dream).</dd>
        <dt>FPS (default 30)</dt>
        <dd>Playback rate of the written video. Transform amounts are scaled with FPS so
          “per second” motion stays similar if you change frame rate thoughtfully.</dd>
        <dt>Zoom (default 1.04)</dt>
        <dd>Scale factor per frame when zoom is in the transform. <strong>&gt; 1</strong> =
          zoom in (default mild crawl). <strong>&lt; 1</strong> = zoom out. Tiny changes
          compound over dozens of frames — 1.04 is already strong over 30–100 frames.</dd>
        <dt>Spin ° (default 1.5)</dt>
        <dd>Rotation degrees per frame. Positive / negative = direction. Small values
          accumulate into a full spin over the clip.</dd>
        <dt>Pan X / Pan Y (default 5)</dt>
        <dd>Pixel translation per frame when Translate (or a transform that uses them)
          is active. Positive X ≈ pan content left-ish (image shifts right depending on
          implementation convention); tweak by eye. Large pans + high Frames = content
          flies off-frame unless Zoom pulls new pixels from edges.</dd>
      </dl>

      <h5 class="tool-docs-h">Cost, cancel, and sanity</h5>
      <ul class="tool-docs-ul">
        <li><strong>Stills</strong> are the cheap playground. <strong>Video</strong> ≈ still cost × frame count (after range / max / step).</li>
        <li><strong>Ouroboros</strong> ≈ still cost × Frames — easy to underestimate.</li>
        <li>Use <strong>Preview W</strong>, <strong>Max frames</strong>, and low Iterations to scout; then full res.</li>
        <li><strong>Stop</strong> cancels between frames / during long jobs where the server checks cancel.</li>
        <li>If VRAM dies: lower Preview W, Octaves, or resolution of the source; close other GPU apps.</li>
        <li>Global frame range applies to video dreams (start/end on the bar above).</li>
      </ul>

      <h5 class="tool-docs-h">Evolve video</h5>
      <p>
        When <strong>Evolve</strong> is on, mid-ascent frames are saved, near-duplicates
        dropped with the same metrics as Image Sort (default pHash, min distance 4),
        optional RIFE fills gaps, then encodes <code>*_dream_evolve.mp4</code>.
        Frame 0 is the original; the final dream is always kept. Use this when ascent
        “spins its wheels” — progress climbs but the image barely changes.
        v1 is <strong>still images</strong> only (not video/ouro batches).
      </p>

      <h5 class="tool-docs-h">Recipe cheat-sheet</h5>
      <dl class="tool-docs-dl">
        <dt>Subtle texture pass</dt>
        <dd>Inception · Shallow · Iterations 10–15 · Blend 0.4–0.7 · Jitter On.</dd>
        <dt>Classic still</dt>
        <dd>Inception · Classic · defaults · full width.</dd>
        <dt>Heavy hallucination</dt>
        <dd>Deep or Full · Iterations 30–50 · slightly higher Step · watch Max loss.</dd>
        <dt>Guided “make it floral”</dt>
        <dd>Set Guide to a flower photo · Classic · mid Iterations · Blend ~0.8–1.</dd>
        <dt>Stable video trip</dt>
        <dd>Temporal blend ~0.85 · Optical flow Off first · Frame step 1 · short Max frames test.</dd>
        <dt>Flow-locked motion</dt>
        <dd>Optical flow On · smooth source (not hard cuts) · Classic layers.</dd>
        <dt>Ouroboros tunnel</dt>
        <dd>Ouroboros On · Zoom+Spin · Zoom 1.03–1.05 · Spin 1–2° · Frames 60–120 · Preview W while testing.</dd>
      </dl>
    </section>
  `;
  elements.actionPanel.innerHTML = html;

  // Continuous knobs
  setupContinuousKnob({
    knobId: 'dreamStepKnob', indicatorId: 'dreamStepKnobInd', valueId: 'dreamStepVal', hiddenId: 'dreamStep',
    min: 0.001, max: 0.1, step: 0.001, decimals: 3,
  });
  setupContinuousKnob({
    knobId: 'dreamItersKnob', indicatorId: 'dreamItersKnobInd', valueId: 'dreamItersVal', hiddenId: 'dreamIters',
    min: 1, max: 100, step: 1, decimals: 0,
  });
  setupContinuousKnob({
    knobId: 'dreamOctavesKnob', indicatorId: 'dreamOctavesKnobInd', valueId: 'dreamOctavesVal', hiddenId: 'dreamOctaves',
    min: 1, max: 8, step: 1, decimals: 0,
  });
  setupContinuousKnob({
    knobId: 'dreamOctScaleKnob', indicatorId: 'dreamOctScaleKnobInd', valueId: 'dreamOctScaleVal', hiddenId: 'dreamOctScale',
    min: 1.1, max: 2.0, step: 0.05, decimals: 2,
  });
  setupContinuousKnob({
    knobId: 'dreamMaxLossKnob', indicatorId: 'dreamMaxLossKnobInd', valueId: 'dreamMaxLossVal', hiddenId: 'dreamMaxLoss',
    // Absolute ceiling on ascent objective. 0 = off (recommended).
    // Inception often O(1–20); VGG can be O(1e5+) — low values early-stop after 1 step.
    min: 0, max: 50, step: 0.5, decimals: 1, format: (v) => (v <= 0 ? 'off' : v.toFixed(1)),
  });
  setupContinuousKnob({
    knobId: 'dreamBlendKnob', indicatorId: 'dreamBlendKnobInd', valueId: 'dreamBlendVal', hiddenId: 'dreamBlend',
    min: 0, max: 1, step: 0.05, decimals: 2,
  });
  setupContinuousKnob({
    knobId: 'dreamStepToKnob', indicatorId: 'dreamStepToKnobInd', valueId: 'dreamStepToVal', hiddenId: 'dreamStepTo',
    min: 0.001, max: 0.1, step: 0.001, decimals: 3,
  });
  setupContinuousKnob({
    knobId: 'dreamItersToKnob', indicatorId: 'dreamItersToKnobInd', valueId: 'dreamItersToVal', hiddenId: 'dreamItersTo',
    min: 1, max: 100, step: 1, decimals: 0,
  });
  setupContinuousKnob({
    knobId: 'dreamOctavesToKnob', indicatorId: 'dreamOctavesToKnobInd', valueId: 'dreamOctavesToVal', hiddenId: 'dreamOctavesTo',
    min: 1, max: 8, step: 1, decimals: 0,
  });
  setupContinuousKnob({
    knobId: 'dreamOctScaleToKnob', indicatorId: 'dreamOctScaleToKnobInd', valueId: 'dreamOctScaleToVal', hiddenId: 'dreamOctScaleTo',
    min: 1.1, max: 2.0, step: 0.05, decimals: 2,
  });
  setupContinuousKnob({
    knobId: 'dreamMaxLossToKnob', indicatorId: 'dreamMaxLossToKnobInd', valueId: 'dreamMaxLossToVal', hiddenId: 'dreamMaxLossTo',
    min: 0, max: 50, step: 0.5, decimals: 1, format: (v) => (v <= 0 ? 'off' : v.toFixed(1)),
  });
  setupContinuousKnob({
    knobId: 'dreamBlendToKnob', indicatorId: 'dreamBlendToKnobInd', valueId: 'dreamBlendToVal', hiddenId: 'dreamBlendTo',
    min: 0, max: 1, step: 0.05, decimals: 2,
  });
  setupContinuousKnob({
    knobId: 'dreamFrameStepKnob', indicatorId: 'dreamFrameStepKnobInd', valueId: 'dreamFrameStepVal', hiddenId: 'dreamFrameStep',
    min: 1, max: 30, step: 1, decimals: 0,
  });
  setupContinuousKnob({
    knobId: 'dreamMaxFramesKnob', indicatorId: 'dreamMaxFramesKnobInd', valueId: 'dreamMaxFramesVal', hiddenId: 'dreamMaxFrames',
    min: 0, max: 500, step: 1, decimals: 0, format: (v) => (v <= 0 ? 'all' : String(Math.round(v))),
  });
  setupContinuousKnob({
    knobId: 'dreamTemporalBlendKnob', indicatorId: 'dreamTemporalBlendKnobInd',
    valueId: 'dreamTemporalBlendVal', hiddenId: 'dreamTemporalBlend',
    min: 0, max: 1, step: 0.05, decimals: 2,
    format: (v) => (v >= 0.999 ? 'off' : v.toFixed(2)),
  });
  setupContinuousKnob({
    knobId: 'dreamPreviewWKnob', indicatorId: 'dreamPreviewWKnobInd',
    valueId: 'dreamPreviewWVal', hiddenId: 'dreamPreviewW',
    min: 0, max: 1280, step: 20, decimals: 0,
    format: (v) => (v <= 0 ? 'full' : String(Math.round(v))),
  });
  setupContinuousKnob({
    knobId: 'dreamOuroLenKnob', indicatorId: 'dreamOuroLenKnobInd', valueId: 'dreamOuroLenVal', hiddenId: 'dreamOuroLen',
    min: 1, max: 300, step: 1, decimals: 0,
  });
  setupContinuousKnob({
    knobId: 'dreamOuroFpsKnob', indicatorId: 'dreamOuroFpsKnobInd', valueId: 'dreamOuroFpsVal', hiddenId: 'dreamOuroFps',
    min: 1, max: 60, step: 1, decimals: 0,
  });
  setupContinuousKnob({
    knobId: 'dreamZoomKnob', indicatorId: 'dreamZoomKnobInd', valueId: 'dreamZoomVal', hiddenId: 'dreamZoom',
    min: 0.9, max: 1.15, step: 0.005, decimals: 3,
  });
  setupContinuousKnob({
    knobId: 'dreamSpinKnob', indicatorId: 'dreamSpinKnobInd', valueId: 'dreamSpinVal', hiddenId: 'dreamSpin',
    min: -15, max: 15, step: 0.1, decimals: 1,
  });
  setupContinuousKnob({
    knobId: 'dreamTxKnob', indicatorId: 'dreamTxKnobInd', valueId: 'dreamTxVal', hiddenId: 'dreamTx',
    min: -20, max: 20, step: 0.5, decimals: 1,
  });
  setupContinuousKnob({
    knobId: 'dreamTyKnob', indicatorId: 'dreamTyKnobInd', valueId: 'dreamTyVal', hiddenId: 'dreamTy',
    min: -20, max: 20, step: 0.5, decimals: 1,
  });

  // Binary knobs
  // Media: store image|video; Detect: 0=force 1=auto
  setupBinaryKnob({
    knobId: 'dreamWarmKnob', indicatorId: 'dreamWarmKnobInd', hiddenId: 'dreamWarm',
    leftValue: '0', rightValue: '1', initial: state.settings?.warmModels?.deepdream ? '1' : '0',
  });
  setupBinaryKnob({
    knobId: 'dreamTurboKnob', indicatorId: 'dreamTurboKnobInd', hiddenId: 'dreamTurbo',
    leftValue: '0', rightValue: '1', initial: '0',
  });
  setupContinuousKnob({
    knobId: 'dreamTurboStrengthKnob', indicatorId: 'dreamTurboStrengthKnobInd',
    valueId: 'dreamTurboStrengthVal', hiddenId: 'dreamTurboStrength',
    min: 0, max: 1, step: 0.05, decimals: 2,
  });
  document.getElementById('dreamWarm')?.addEventListener('change', (e) => {
    state.settings.warmModels.deepdream = e.target.value === '1';
    try { localStorage.setItem('mtapi.settings', JSON.stringify(state.settings)); } catch (_) {}
  });
  setupBinaryKnob({
    knobId: 'dreamMediaKnob', indicatorId: 'dreamMediaKnobInd', hiddenId: 'dreamMedia',
    leftValue: 'image', rightValue: 'video', leftLabel: 'Image', rightLabel: 'Video',
    initial: 'image',
  });
  setupBinaryKnob({
    knobId: 'dreamAutoDetectKnob', indicatorId: 'dreamAutoDetectKnobInd', hiddenId: 'dreamAutoDetect',
    leftValue: '0', rightValue: '1', initial: '1',
  });
  setupBinaryKnob({
    knobId: 'dreamJitterKnob', indicatorId: 'dreamJitterKnobInd', hiddenId: 'dreamJitter',
    leftValue: '0', rightValue: '1', initial: '1',
  });
  setupBinaryKnob({
    knobId: 'dreamDetailKnob', indicatorId: 'dreamDetailKnobInd', hiddenId: 'dreamDetail',
    leftValue: '0', rightValue: '1', initial: '1',
  });
  setupBinaryKnob({
    knobId: 'dreamAudioKnob', indicatorId: 'dreamAudioKnobInd', hiddenId: 'dreamAudio',
    leftValue: '0', rightValue: '1', initial: '1',
  });
  setupBinaryKnob({
    knobId: 'dreamDryRunKnob', indicatorId: 'dreamDryRunKnobInd', hiddenId: 'dreamDryRun',
    leftValue: '0', rightValue: '1', initial: '0',
  });
  setupBinaryKnob({
    knobId: 'dreamDynamicKnob', indicatorId: 'dreamDynamicKnobInd', hiddenId: 'dreamDynamic',
    leftValue: '0', rightValue: '1', initial: '0',
  });
  setupBinaryKnob({
    knobId: 'dreamOuroKnob', indicatorId: 'dreamOuroKnobInd', hiddenId: 'dreamOuro',
    leftValue: '0', rightValue: '1', initial: '0',
  });
  setupBinaryKnob({
    knobId: 'dreamOpticalFlowKnob', indicatorId: 'dreamOpticalFlowKnobInd', hiddenId: 'dreamOpticalFlow',
    leftValue: '0', rightValue: '1', initial: '0',
  });
  setupBinaryKnob({
    knobId: 'dreamLayerCycleKnob', indicatorId: 'dreamLayerCycleKnobInd', hiddenId: 'dreamLayerCycle',
    leftValue: '0', rightValue: '1', initial: '0',
  });
  setupEvolveMasterToggle('dreamEvolve', '.dream-evolve-only');
  setupEvolveRifeKnobs('dreamEvolve');
  setupContinuousKnob({
    knobId: 'dreamEvolveFpsKnob', indicatorId: 'dreamEvolveFpsKnobInd',
    valueId: 'dreamEvolveFpsVal', hiddenId: 'dreamEvolveFps',
    min: 1, max: 60, step: 1, decimals: 0,
  });
  setupContinuousKnob({
    knobId: 'dreamEvolveThrKnob', indicatorId: 'dreamEvolveThrKnobInd',
    valueId: 'dreamEvolveThrVal', hiddenId: 'dreamEvolveThr',
    min: 0, max: 32, step: 0.5, decimals: 1,
    format: (v) => (v <= 0 ? 'all' : v.toFixed(1)),
  });
  setupContinuousKnob({
    knobId: 'dreamEvolveCapNKnob', indicatorId: 'dreamEvolveCapNKnobInd',
    valueId: 'dreamEvolveCapNVal', hiddenId: 'dreamEvolveCapN',
    min: 0, max: 20, step: 1, decimals: 0,
    format: (v) => (v <= 0 ? 'auto' : String(Math.round(v))),
  });

  function rebuildLayerUiForModel(modelKey, { keepPreset = true } = {}) {
    const spec = DREAM_MODELS[modelKey] || DREAM_MODELS.inception_v3;
    const presetSel = document.getElementById('dreamLayerPreset');
    const prevPreset = keepPreset ? (presetSel?.value || 'classic') : 'classic';
    if (presetSel) {
      presetSel.innerHTML = Object.entries(spec.presets)
        .map(([k, label]) => `<option value="${k}">${label}</option>`)
        .join('');
      if (spec.presets[prevPreset]) presetSel.value = prevPreset;
      else presetSel.value = 'classic';
    }
    const bank = document.getElementById('dreamLayerWeightsBank');
    if (bank) {
      bank.innerHTML = spec.layers.map((L) => {
        const safeId = `dreamL_${L.id.replace(/[^a-zA-Z0-9_]/g, '_')}`;
        return knobUnitHtml({ id: safeId, label: L.label, value: String(L.def) });
      }).join('');
      spec.layers.forEach((L) => {
        const safeId = `dreamL_${L.id.replace(/[^a-zA-Z0-9_]/g, '_')}`;
        setupContinuousKnob({
          knobId: `${safeId}Knob`,
          indicatorId: `${safeId}KnobInd`,
          valueId: `${safeId}Val`,
          hiddenId: safeId,
          min: 0, max: 5, step: 0.1, decimals: 1,
        });
        // store real layer name for collect
        const hid = document.getElementById(safeId);
        if (hid) hid.dataset.layerName = L.id;
      });
    }
    const bankTo = document.getElementById('dreamLayerWeightsBankTo');
    if (bankTo) {
      bankTo.innerHTML = spec.layers.map((L) => {
        const safeId = `dreamLTo_${L.id.replace(/[^a-zA-Z0-9_]/g, '_')}`;
        return knobUnitHtml({ id: safeId, label: L.label, value: String(L.def) });
      }).join('');
      spec.layers.forEach((L) => {
        const safeId = `dreamLTo_${L.id.replace(/[^a-zA-Z0-9_]/g, '_')}`;
        setupContinuousKnob({
          knobId: `${safeId}Knob`,
          indicatorId: `${safeId}KnobInd`,
          valueId: `${safeId}Val`,
          hiddenId: safeId,
          min: 0, max: 5, step: 0.1, decimals: 1,
        });
        const hid = document.getElementById(safeId);
        if (hid) hid.dataset.layerName = L.id;
      });
    }
  }

  function syncDreamUiVisibility() {
    const preset = document.getElementById('dreamLayerPreset')?.value;
    const custom = preset === 'custom';
    document.querySelectorAll('.dream-layer-weights').forEach((el) => {
      el.classList.toggle('hidden', !custom);
    });

    const ouro = document.getElementById('dreamOuro')?.value === '1';
    document.querySelectorAll('.dream-ouro-only').forEach((el) => {
      el.classList.toggle('hidden', !ouro);
    });

    // evolve panel: setupEvolveMasterToggle keeps .dream-evolve-only in sync

    const auto = document.getElementById('dreamAutoDetect')?.value === '1';
    const media = document.getElementById('dreamMedia')?.value || 'image';
    // Resolve input the SAME way collectDeepDreamBody does (local box → global bar).
    // Without this, a video fed through #giVideo hides the whole video bank.
    const input = bestInput('dreamInput') || '';
    let showVideo = false;
    if (!ouro) {
      if (auto) {
        showVideo = /\.(mp4|m4v|mov|mkv|webm|avi|mpg|mpeg)$/i.test(input);
      } else {
        showVideo = media === 'video';
      }
    }
    document.querySelectorAll('.dream-video-only').forEach((el) => {
      el.classList.toggle('hidden', !showVideo);
    });

    const dynamic = document.getElementById('dreamDynamic')?.value === '1';
    document.querySelectorAll('.dream-dynamic-only').forEach((el) => {
      el.classList.toggle('hidden', !(dynamic && showVideo));
    });

    const v3 = document.getElementById('dreamEngine')?.value === 'gpu_v3';
    const turbo = document.getElementById('dreamTurbo')?.value === '1';
    document.querySelectorAll('.dream-turbo-only').forEach((el) => {
      el.classList.toggle('hidden', !v3);
    });
    document.querySelectorAll('.dream-turbo-strength').forEach((el) => {
      el.classList.toggle('hidden', !turbo);
    });
  }

  rebuildLayerUiForModel(document.getElementById('dreamModel')?.value || 'inception_v3');

  document.getElementById('dreamModel')?.addEventListener('change', (e) => {
    rebuildLayerUiForModel(e.target.value);
    syncDreamUiVisibility();
    logConsole(`[DEEPDREAM]: Model → ${e.target.value}`);
  });
  document.getElementById('dreamLayerPreset')?.addEventListener('change', syncDreamUiVisibility);
  document.getElementById('dreamAutoDetect')?.addEventListener('change', syncDreamUiVisibility);
  document.getElementById('dreamMedia')?.addEventListener('change', syncDreamUiVisibility);
  document.getElementById('dreamOuro')?.addEventListener('change', syncDreamUiVisibility);
  document.getElementById('dreamDynamic')?.addEventListener('change', syncDreamUiVisibility);
  document.getElementById('dreamTurbo')?.addEventListener('change', syncDreamUiVisibility);
  document.getElementById('dreamInput')?.addEventListener('input', syncDreamUiVisibility);

  // Global bar (#giVideo) drives bestInput too — re-sync when it changes.
  // Delegated on document (the bar is persistent) so it never stacks per-render.
  const giVideo = document.getElementById('giVideo');
  if (giVideo && !giVideo._dreamVisBound) {
    giVideo._dreamVisBound = true;
    giVideo.addEventListener('input', () => {
      if (state.activeTab === 'deepdream') syncDreamUiVisibility();
    });
  }

  document.getElementById('btnDreamBrowseIn')?.addEventListener('click', () => {
    // Prefer all files so both images and videos are visible
    openFileBrowser('dreamInput', false, 'file', 'all');
  });
  document.getElementById('btnDreamBrowseOut')?.addEventListener('click', () => {
    openFileBrowser('dreamOutput', false, 'file_save', 'all');
  });
  document.getElementById('btnDreamBrowseGuide')?.addEventListener('click', () => {
    openFileBrowser('dreamGuide', false, 'file', 'image');
  });
  document.getElementById('btnDreamExportSettings')?.addEventListener('click', exportDeepDreamSettings);

  // ── Engine dropdown (CPU TF nets vs GPU OpenVINO static) ──
  const dreamEng = document.getElementById('dreamEngine');
  if (dreamEng) {
    try {
      dreamEng.value = localStorage.getItem('mtapi.dreamEngine') || 'cpu';
    } catch (_) { dreamEng.value = 'cpu'; }
    _syncDreamGpuRow();
    dreamEng.addEventListener('change', () => {
      try { localStorage.setItem('mtapi.dreamEngine', dreamEng.value); } catch (_) {}
      if (dreamEng.value === 'gpu_v3' && document.getElementById('dreamModel')?.value !== 'inception_v3') {
        const model = document.getElementById('dreamModel');
        if (model) model.value = 'inception_v3';
        document.getElementById('dreamModel')?.dispatchEvent(new Event('change'));
      }
      _syncDreamGpuRow();
      syncDreamUiVisibility();
      if (dreamEng.value.startsWith('gpu')) _refreshDreamOvStatus();
    });
  }
  document.getElementById('btnDreamOvSetup')?.addEventListener('click', async () => {
    try {
      await runOpWithCancel('deepdream_ov_setup', { action: 'install', dry_run: false },
        { label: 'DeepDream GPU setup (IR install + smoke)…' });
    } catch (_) { /* logged */ }
    _refreshDreamOvStatus();
  });
  document.getElementById('btnDreamOvRefresh')?.addEventListener('click', _refreshDreamOvStatus);
  _refreshDreamOvStatus();

  // Apply pending send-to path
  if (state.pendingInputPath && state.pendingInputTarget === 'deepdream') {
    const inp = document.getElementById('dreamInput');
    if (inp) {
      inp.value = state.pendingInputPath;
      inp.dispatchEvent(new Event('input'));
    }
    state.pendingInputPath = null;
    state.pendingInputTarget = null;
  }

  syncDreamUiVisibility();
}

function _syncDreamGpuRow() {
  const val = document.getElementById('dreamEngine')?.value || 'cpu';
  const show = val.startsWith('gpu');
  document.getElementById('dreamGpuSetupRow')?.classList.toggle('hidden', !show);
}

async function _refreshDreamOvStatus() {
  const box = document.getElementById('dreamOvStatus');
  if (!box) return;
  box.textContent = 'GPU status: checking…';
  try {
    const res = await fetch('/api/deepdream_ov/status');
    const data = await res.json();
    const baked = data.baked ? ` ${data.baked.model}/${data.baked.layer}` : '';
    const v3 = data.v3 || {};
    const v3Text = v3.ir_present ? ` · V3 ${v3.turbo_present ? 'ascent+Turbo' : 'ascent'}` : ' · V3 MISSING';
    box.textContent = 'GPU status: V1 IR ' + (data.ir_present ? `ok${baked}` : 'MISSING — run GPU Setup')
      + v3Text + ' · devices ' + ((data.devices || []).join('/') || '?');
  } catch (err) {
    box.textContent = 'GPU status check failed — ' + err.message;
  }
}

function collectDeepDreamBody() {
  const input = bestInput('dreamInput');
  const output = document.getElementById('dreamOutput')?.value?.trim() || null;
  if (!input) {
    alert('Please provide an input image or video path.');
    return null;
  }

  const auto = document.getElementById('dreamAutoDetect')?.value === '1';
  const mediaKnob = document.getElementById('dreamMedia')?.value || 'image';
  let media_kind = 'auto';
  if (!auto) media_kind = mediaKnob === 'video' ? 'video' : 'image';

  const maxFramesRaw = parseFloat(document.getElementById('dreamMaxFrames')?.value || '0');
  const max_frames = maxFramesRaw > 0 ? Math.round(maxFramesRaw) : null;
  const ouroboros = document.getElementById('dreamOuro')?.value === '1';
  const guide = document.getElementById('dreamGuide')?.value?.trim() || null;
  const previewW = parseInt(document.getElementById('dreamPreviewW')?.value || '0', 10);
  const model_name = document.getElementById('dreamModel')?.value || 'inception_v3';
  const layer_preset = document.getElementById('dreamLayerPreset')?.value || 'classic';

  // Collect custom layer knobs (real names in data-layer-name)
  const custom_layer_weights = {};
  document.querySelectorAll('#dreamLayerWeightsBank input[type="hidden"][data-layer-name]').forEach((el) => {
    const name = el.dataset.layerName;
    const w = parseFloat(el.value);
    if (name && Number.isFinite(w) && w > 0) custom_layer_weights[name] = w;
  });

  const dynamic = document.getElementById('dreamDynamic')?.value === '1';

  const body = withFrameRange({
    engine: document.getElementById('dreamEngine')?.value || 'cpu',
    turbo: document.getElementById('dreamTurbo')?.value === '1',
    turbo_strength: parseFloat(document.getElementById('dreamTurboStrength')?.value || '0.5'),
    input_path: input,
    output_path: output,
    media_kind,
    model_name,
    step: parseFloat(document.getElementById('dreamStep')?.value || '0.01'),
    iterations: parseInt(document.getElementById('dreamIters')?.value || '20', 10),
    num_octave: parseInt(document.getElementById('dreamOctaves')?.value || '3', 10),
    octave_scale: parseFloat(document.getElementById('dreamOctScale')?.value || '1.4'),
    max_loss: parseFloat(document.getElementById('dreamMaxLoss')?.value || '0'),
    blend: parseFloat(document.getElementById('dreamBlend')?.value || '1'),
    jitter: document.getElementById('dreamJitter')?.value === '1',
    reinject_detail: document.getElementById('dreamDetail')?.value === '1',
    keep_audio: document.getElementById('dreamAudio')?.value === '1',
    layer_preset,
    custom_layer_weights: layer_preset === 'custom' ? custom_layer_weights : null,
    frame_step: parseInt(document.getElementById('dreamFrameStep')?.value || '1', 10),
    max_frames,
    temporal_blend: parseFloat(document.getElementById('dreamTemporalBlend')?.value || '0.85'),
    optical_flow: document.getElementById('dreamOpticalFlow')?.value === '1',
    layer_cycle: document.getElementById('dreamLayerCycle')?.value === '1',
    guide_path: guide,
    preview_width: previewW > 0 ? previewW : 0,
    ouroboros,
    ouroboros_length: parseInt(document.getElementById('dreamOuroLen')?.value || '30', 10),
    ouroboros_fps: parseFloat(document.getElementById('dreamOuroFps')?.value || '30'),
    frame_transform: document.getElementById('dreamFrameTransform')?.value || 'zoom_rotate',
    zoom: parseFloat(document.getElementById('dreamZoom')?.value || '1.04'),
    rotation_deg: parseFloat(document.getElementById('dreamSpin')?.value || '1.5'),
    translate_x: parseFloat(document.getElementById('dreamTx')?.value || '5'),
    translate_y: parseFloat(document.getElementById('dreamTy')?.value || '5'),
    dry_run: document.getElementById('dreamDryRun')?.value === '1',
    keep_model_warm: document.getElementById('dreamWarm')?.value === '1',
    evolve_enabled: document.getElementById('dreamEvolve')?.value === '1',
    evolve_fps: parseFloat(document.getElementById('dreamEvolveFps')?.value || '12'),
    evolve_metric: document.getElementById('dreamEvolveMetric')?.value || 'phash',
    evolve_threshold: parseFloat(document.getElementById('dreamEvolveThr')?.value || '4'),
    evolve_capture_every: parseInt(document.getElementById('dreamEvolveCapN')?.value || '0', 10),
    evolve_max_candidates: 500,
    ...collectEvolveRifeFields('dreamEvolve'),
  });

  // Dynamic ramp: emit *_to endpoints ONLY when Dynamic is On.
  // Off → body is byte-identical to the pre-ramp payload (no *_to keys).
  if (dynamic) {
    body.step_to = parseFloat(document.getElementById('dreamStepTo')?.value || body.step);
    body.iterations_to = parseInt(document.getElementById('dreamItersTo')?.value || body.iterations, 10);
    body.num_octave_to = parseInt(document.getElementById('dreamOctavesTo')?.value || body.num_octave, 10);
    body.octave_scale_to = parseFloat(document.getElementById('dreamOctScaleTo')?.value || body.octave_scale);
    body.max_loss_to = parseFloat(document.getElementById('dreamMaxLossTo')?.value || body.max_loss);
    body.blend_to = parseFloat(document.getElementById('dreamBlendTo')?.value || body.blend);
    if (layer_preset === 'custom') {
      const toWeights = {};
      document.querySelectorAll('#dreamLayerWeightsBankTo input[type="hidden"][data-layer-name]').forEach((el) => {
        const name = el.dataset.layerName;
        const w = parseFloat(el.value);
        if (name && Number.isFinite(w) && w > 0) toWeights[name] = w;
      });
      body.custom_layer_weights_to = toWeights;
    }
  }

  return body;
}

function exportDeepDreamSettings() {
  const body = collectDeepDreamBody();
  if (!body) return; // collector already alerted
  const json = JSON.stringify(body, null, 2);
  // Copy to clipboard (best-effort)
  if (navigator.clipboard) {
    navigator.clipboard.writeText(json).then(
      () => logConsole('[DEEPDREAM]: settings JSON copied to clipboard'),
      () => {},
    );
  }
  // Trigger a download
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'deepdream-settings.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  logConsole('[DEEPDREAM]: exported settings → deepdream-settings.json (+ clipboard)');
}

export { DREAM_MODELS, renderDeepDreamForm, collectDeepDreamBody, exportDeepDreamSettings };
