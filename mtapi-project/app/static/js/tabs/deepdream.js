import { state, elements, bestInput, logConsole } from '/app.js';
import { setupContinuousKnob, setupBinaryKnob, knobUnitHtml } from '/js/ui/knobs.js';

// ── DeepDream tab ─────────────────────────────────────────────────────────

/** Real nets + their custom-knob layers (must match deepdream_engine.py). */
const DREAM_MODELS = {
  inception_v3: {
    label: 'InceptionV3 (ImageNet) — classic Google DeepDream',
    layers: [
      { id: 'mixed3', label: 'mixed3', def: 0 },
      { id: 'mixed4', label: 'mixed4', def: 1.0 },
      { id: 'mixed5', label: 'mixed5', def: 1.5 },
      { id: 'mixed6', label: 'mixed6', def: 2.0 },
      { id: 'mixed7', label: 'mixed7', def: 2.5 },
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
    <div class="panel-title-desc">
      <h3>Google DeepDream</h3>
      <p class="dream-hint">
        Gradient ascent on a real CNN (pick the <strong>model</strong>, then which
        <strong>layers</strong> inside it). Image / video / Ouroboros. Knobs for continuous
        params; binary snap knobs for on/off.
      </p>
    </div>

    <div class="form-group">
      <label>Input (image or video)</label>
      <div class="input-row">
        <input type="text" id="dreamInput" placeholder="/absolute/path/to/image.png or video.mp4">
        <button class="btn" type="button" id="btnDreamBrowseIn">Browse</button>
      </div>
    </div>

    <div class="form-group">
      <label>Output path (blank = auto next to source)</label>
      <div class="input-row">
        <input type="text" id="dreamOutput" placeholder="auto: name_dream.png / name_dream.mp4">
        <button class="btn" type="button" id="btnDreamBrowseOut">Save As</button>
      </div>
    </div>

    <div class="form-group">
      <label>Guide image <span style="font-weight:normal;color:var(--text-muted)">(optional — guided dream)</span></label>
      <div class="input-row">
        <input type="text" id="dreamGuide" placeholder="Leave blank for classic L2 dream; pick image to steer features">
        <button class="btn" type="button" id="btnDreamBrowseGuide">Browse</button>
      </div>
      <p class="dream-hint" style="margin-top:6px">
        Guided dreaming (DeepDreamAnim / Google): match activations to the guide's features
        (flowers → floral patterns, faces → face-like forms, …).
      </p>
    </div>

    <div class="dream-section-title">Media</div>
    <div class="knob-bank">
      ${knobUnitHtml({ id: 'dreamMedia', label: 'Media', value: 'auto', binary: true, leftCap: 'Image', rightCap: 'Video' })}
      ${knobUnitHtml({ id: 'dreamAutoDetect', label: 'Detect', value: '1', binary: true, leftCap: 'Force', rightCap: 'Auto' })}
    </div>
    <p class="dream-hint">With Detect=Auto, extension picks image vs video. Force uses the Media knob.</p>

    <div class="dream-section-title">Ascent</div>
    <div class="knob-bank">
      ${knobUnitHtml({ id: 'dreamStep', label: 'Step', value: '0.01' })}
      ${knobUnitHtml({ id: 'dreamIters', label: 'Iterations', value: '20' })}
      ${knobUnitHtml({ id: 'dreamOctaves', label: 'Octaves', value: '3' })}
      ${knobUnitHtml({ id: 'dreamOctScale', label: 'Oct scale', value: '1.4' })}
      ${knobUnitHtml({ id: 'dreamMaxLoss', label: 'Max loss', value: '15' })}
      ${knobUnitHtml({ id: 'dreamBlend', label: 'Blend', value: '1.0' })}
      ${knobUnitHtml({ id: 'dreamPreviewW', label: 'Preview W', value: '0' })}
    </div>

    <div class="dream-section-title">Binary</div>
    <div class="knob-bank">
      ${knobUnitHtml({ id: 'dreamJitter', label: 'Jitter', value: '1', binary: true, leftCap: 'Off', rightCap: 'On' })}
      ${knobUnitHtml({ id: 'dreamDetail', label: 'Detail', value: '1', binary: true, leftCap: 'Off', rightCap: 'On' })}
      ${knobUnitHtml({ id: 'dreamAudio', label: 'Audio', value: '1', binary: true, leftCap: 'Drop', rightCap: 'Keep' })}
      ${knobUnitHtml({ id: 'dreamDryRun', label: 'Dry run', value: '0', binary: true, leftCap: 'Run', rightCap: 'Dry' })}
    </div>

    <div class="form-group">
      <label>Neural network (architecture)</label>
      <select id="dreamModel">
        <option value="inception_v3" selected>InceptionV3 (ImageNet) — classic Google DeepDream</option>
        <option value="vgg16">VGG16 (ImageNet) — hierarchical / classic NN dream look</option>
        <option value="resnet50">ResNet50 (ImageNet) — residual features, different creatures</option>
      </select>
      <p class="dream-hint" style="margin-top:6px">
        These are <strong>different models</strong>, not just labels. VGG/ResNet load separate ImageNet weights
        (first use may download once). Layer presets below map to that model's real layer names.
      </p>
    </div>

    <div class="form-group">
      <label>Layer preset <span style="font-weight:normal;color:var(--text-muted)">(within selected model)</span></label>
      <select id="dreamLayerPreset"></select>
    </div>

    <div class="dream-section-title dream-layer-weights" id="dreamLayerWeightsTitle">Custom layer weights</div>
    <div class="knob-bank dream-layer-weights" id="dreamLayerWeightsBank"></div>

    <div class="dream-section-title dream-video-only" id="dreamVideoTitle">DeepDream video (temporal)</div>
    <div class="knob-bank dream-video-only" id="dreamVideoBank">
      ${knobUnitHtml({ id: 'dreamFrameStep', label: 'Frame step', value: '1' })}
      ${knobUnitHtml({ id: 'dreamMaxFrames', label: 'Max frames', value: '0' })}
      ${knobUnitHtml({ id: 'dreamTemporalBlend', label: 'Temporal blend', value: '0.85' })}
      ${knobUnitHtml({ id: 'dreamOpticalFlow', label: 'Optical flow', value: '0', binary: true, leftCap: 'Off', rightCap: 'On' })}
      ${knobUnitHtml({ id: 'dreamLayerCycle', label: 'Layer cycle', value: '0', binary: true, leftCap: 'Off', rightCap: 'On' })}
    </div>
    <p class="dream-hint dream-video-only">
      <strong>Temporal blend</strong> (simple / gordicaleksa): alpha-mix last dream + current frame (0.85 classic; 1.0 = off).<br>
      <strong>Optical flow</strong> (DeepDreamAnim — different &amp; stronger): warp the
      <em>hallucination residual</em> with Farneback flow so patterns stick to motion.
      When flow is On, temporal blend is ignored.<br>
      <strong>Layer cycle</strong>: one layer per frame (DeepDreamAnim multi-layer loop).<br>
      Frame step &gt; 1 holds last dream. Preview W (Ascent section) speeds iteration.
    </p>

    <div class="dream-section-title">Ouroboros (zoom / spin / translate)</div>
    <div class="knob-bank">
      ${knobUnitHtml({ id: 'dreamOuro', label: 'Ouroboros', value: '0', binary: true, leftCap: 'Off', rightCap: 'On' })}
    </div>
    <p class="dream-hint">
      Feedback loop from a <strong>still image</strong>: dream → geometric transform → feed back
      (gordicaleksa/pytorch-deepdream). Writes a video even if input is a still.
    </p>
    <div class="dream-ouro-only" id="dreamOuroPanel">
      <div class="form-group">
        <label>Frame transform</label>
        <select id="dreamFrameTransform">
          <option value="zoom_rotate" selected>Zoom + Spin (classic spiral)</option>
          <option value="zoom">Zoom only</option>
          <option value="rotate">Spin only</option>
          <option value="translate">Translate (5px diagonal pan)</option>
          <option value="none">None (dream loop, no geometry)</option>
        </select>
      </div>
      <div class="knob-bank">
        ${knobUnitHtml({ id: 'dreamOuroLen', label: 'Frames', value: '30' })}
        ${knobUnitHtml({ id: 'dreamOuroFps', label: 'FPS', value: '30' })}
        ${knobUnitHtml({ id: 'dreamZoom', label: 'Zoom', value: '1.04' })}
        ${knobUnitHtml({ id: 'dreamSpin', label: 'Spin °', value: '1.5' })}
        ${knobUnitHtml({ id: 'dreamTx', label: 'Pan X', value: '5' })}
        ${knobUnitHtml({ id: 'dreamTy', label: 'Pan Y', value: '5' })}
      </div>
      <p class="dream-hint">
        <strong>Zoom</strong> &gt; 1 zooms in each frame; <strong>Spin</strong> is °/frame @ 30&nbsp;fps.
        <strong>Translate</strong>: +X/+Y = top-left → bottom-right (default 5&nbsp;px/frame, as in the README).
        Motion auto-scales with FPS.
      </p>
    </div>
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
    min: 0, max: 50, step: 0.5, decimals: 1, format: (v) => (v <= 0 ? 'off' : v.toFixed(1)),
  });
  setupContinuousKnob({
    knobId: 'dreamBlendKnob', indicatorId: 'dreamBlendKnobInd', valueId: 'dreamBlendVal', hiddenId: 'dreamBlend',
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

    const auto = document.getElementById('dreamAutoDetect')?.value === '1';
    const media = document.getElementById('dreamMedia')?.value || 'image';
    const input = document.getElementById('dreamInput')?.value || '';
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
  document.getElementById('dreamInput')?.addEventListener('input', syncDreamUiVisibility);

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

  return {
    input_path: input,
    output_path: output,
    media_kind,
    model_name,
    step: parseFloat(document.getElementById('dreamStep')?.value || '0.01'),
    iterations: parseInt(document.getElementById('dreamIters')?.value || '20', 10),
    num_octave: parseInt(document.getElementById('dreamOctaves')?.value || '3', 10),
    octave_scale: parseFloat(document.getElementById('dreamOctScale')?.value || '1.4'),
    max_loss: parseFloat(document.getElementById('dreamMaxLoss')?.value || '15'),
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
  };
}

export { DREAM_MODELS, renderDeepDreamForm, collectDeepDreamBody };
