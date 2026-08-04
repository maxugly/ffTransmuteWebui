import { elements, bestInput } from '/app.js';
import { setupContinuousKnob, setupBinaryKnob, knobUnitHtml } from '/js/ui/knobs.js';
import { rifeModelSelectHtml } from '/js/ui/evolve-rife.js';

/**
 * RIFE Recoherence — two stills → conform → RIFE M=2 → img2img every mid → encode
 * Keeps all RIFE frames; endpoints copy through. Universal recoherence prompt defaults.
 */

var DEFAULT_POSITIVE = [
  'a single coherent object, well-composed scene, centered, sharp focus,',
  'highly detailed, intricate details, volumetric lighting, masterpiece,',
  'best quality, photorealistic'
].join(' ');

var DEFAULT_NEGATIVE = [
  'blurry, lowres, duplicate, double image, two images, split screen,',
  'collage, double exposure, ghosting, transparent, deformed, messy,',
  'incoherent, watermark, text'
].join(' ');

function renderRifeRecohereForm() {
  var html = `
    <div class="panel-title-desc dense">
      <h3>RIFE Recoherence · Ghost Collapse</h3>
      <p class="dream-hint">
        Two stills → conform → RIFE <strong>M=2</strong> (target A·mid·mid·B) → OpenVINO
        img2img on <strong>every mid</strong> → encode. Both intermediates kept and
        recohered; A/B unchanged.
      </p>
    </div>

    <div class="form-row">
      <label for="rrA">Image A</label>
      <div class="input-row">
        <input type="text" id="rrA" placeholder="/absolute/path/to/image_a.png">
        <button class="btn" type="button" id="btnRrBrowseA">Browse</button>
      </div>
    </div>

    <div class="form-row">
      <label for="rrB">Image B</label>
      <div class="input-row">
        <input type="text" id="rrB" placeholder="/absolute/path/to/image_b.png">
        <button class="btn" type="button" id="btnRrBrowseB">Browse</button>
      </div>
    </div>

    <div class="form-row">
      <label for="rrOutput">Output</label>
      <div class="input-row">
        <input type="text" id="rrOutput" placeholder="blank = auto next to image_a">
        <button class="btn" type="button" id="btnRrBrowseOut">Save As</button>
      </div>
    </div>

    <div id="rrPromptLib" class="prompt-library-bar" aria-label="Prompt library"></div>
    <div class="form-row">
      <label for="rrPrompt">Prompt</label>
      <input type="text" id="rrPrompt" value="${DEFAULT_POSITIVE.replace(/"/g, '&quot;').replace(/</g, '&lt;')}" style="flex:1 1 16rem">
    </div>
    <div class="form-row">
      <label for="rrNeg">Negative</label>
      <input type="text" id="rrNeg" value="${DEFAULT_NEGATIVE.replace(/"/g, '&quot;').replace(/</g, '&lt;')}" style="flex:1 1 16rem">
    </div>

    <div class="form-row">
      <label for="rrModel">Model</label>
      <select id="rrModel">
        <option value="rupeshs/LCM-dreamshaper-v7-openvino" selected>LCM-dreamshaper-v7-openvino (default)</option>
        <option value="rupeshs/sd-turbo-openvino">sd-turbo-openvino</option>
        <option value="rupeshs/sd15-lcm-square-openvino-int8">sd15-lcm-square-openvino-int8</option>
      </select>
    </div>

    ${rifeModelSelectHtml('rrRifeModel', {
      extraLabels: { 'rife-v4.6': 'rife-v4.6 (best)' },
    })}

    <div class="knob-row">
      <div class="knob-bank">
        ${knobUnitHtml({ id: 'rrStrength', label: 'Strength', value: '0.55' })}
        ${knobUnitHtml({ id: 'rrSteps', label: 'Steps', value: '8' })}
        ${knobUnitHtml({ id: 'rrGuidance', label: 'Guidance', value: '1.5' })}
        ${knobUnitHtml({ id: 'rrFps', label: 'FPS', value: '6' })}
        ${knobUnitHtml({ id: 'rrMaxSide', label: 'Max side', value: '0' })}
        ${knobUnitHtml({ id: 'rrSeed', label: 'Seed', value: '42' })}
      </div>
      <p class="knob-row-legend">
        <strong>Strength 0.55</strong> — sweet spot ~0.50–0.65 for ghost collapse.<br>
        <strong>Steps 8</strong> — more than turbo's 4 for coherent rewrite.<br>
        <strong>Guidance 1.5</strong> — LCM-friendly (classic CFG 6 is for non-LCM SD1.5).<br>
        <strong>FPS 6</strong> — 3 frames play slowly for inspection.<br>
        <strong>Seed 42</strong> — fixed for reproducibility.
      </p>
    </div>

    <div class="knob-row">
      <div class="knob-bank">
        ${knobUnitHtml({ id: 'rrTta', label: 'TTA', value: '0', binary: true, leftCap: 'Off', rightCap: 'On' })}
        ${knobUnitHtml({ id: 'rrUhd', label: 'UHD', value: '0', binary: true, leftCap: 'Off', rightCap: 'On' })}
        ${knobUnitHtml({ id: 'rrSaveStills', label: 'Save stills', value: '0', binary: true, leftCap: 'No', rightCap: 'PNGs' })}
        ${knobUnitHtml({ id: 'rrDryRun', label: 'Dry run', value: '0', binary: true, leftCap: 'Run', rightCap: 'Dry' })}
      </div>
      <p class="knob-row-legend">
        <strong>TTA / UHD</strong> — RIFE quality flags (slower).<br>
        <strong>Save stills</strong> — write all strip PNGs next to video.<br>
        <strong>Dry run</strong> — plan only, no processing.
      </p>
    </div>

    <section class="tool-docs" aria-label="About RIFE Recohere">
      <h4 class="tool-docs-title">About · RIFE Recoherence</h4>
      <p class="tool-docs-lede">
        When RIFE interpolates between <strong>unrelated</strong> stills, mids are often
        ghost blends. This pipe runs RIFE M=2 on two conformed keyframes (target
        <strong>4 frames</strong>: A · mid · mid · B), then OpenVINO img2img on
        <strong>every mid</strong> (both intermediates — nothing discarded).
        Endpoints A/B copy through. Encodes the full strip at configurable fps.
      </p>
      <dl class="tool-docs-dl">
        <dt>M=2 fixed</dt>
        <dd>Two inputs × 2 → about four frames; both mids are kept and recohered.</dd>
        <dt>All mids</dt>
        <dd>A and B unchanged; every in-between frame gets img2img (two runs when RIFE returns 4 frames).</dd>
        <dt>Dependencies</dt>
        <dd>FastSD GPU env (<code>MTAPI_FASTSD_ROOT</code>) + rife-ncnn-vulkan on PATH.</dd>
      </dl>
    </section>
  `;
  elements.actionPanel.innerHTML = html;

  // Prefill prompt/negative with defaults (escaping handled in template above)
  var promptEl = document.getElementById('rrPrompt');
  if (promptEl && !promptEl.value) promptEl.value = DEFAULT_POSITIVE;
  var negEl = document.getElementById('rrNeg');
  if (negEl && !negEl.value) negEl.value = DEFAULT_NEGATIVE;

  setupContinuousKnob({
    knobId: 'rrStrengthKnob', indicatorId: 'rrStrengthKnobInd',
    valueId: 'rrStrengthVal', hiddenId: 'rrStrength',
    min: 0.05, max: 0.95, step: 0.01, decimals: 2,
  });
  setupContinuousKnob({
    knobId: 'rrStepsKnob', indicatorId: 'rrStepsKnobInd',
    valueId: 'rrStepsVal', hiddenId: 'rrSteps',
    min: 1, max: 30, step: 1, decimals: 0,
  });
  setupContinuousKnob({
    knobId: 'rrGuidanceKnob', indicatorId: 'rrGuidanceKnobInd',
    valueId: 'rrGuidanceVal', hiddenId: 'rrGuidance',
    min: 0, max: 8, step: 0.1, decimals: 1,
  });
  setupContinuousKnob({
    knobId: 'rrFpsKnob', indicatorId: 'rrFpsKnobInd',
    valueId: 'rrFpsVal', hiddenId: 'rrFps',
    min: 1, max: 60, step: 1, decimals: 0,
  });
  setupContinuousKnob({
    knobId: 'rrMaxSideKnob', indicatorId: 'rrMaxSideKnobInd',
    valueId: 'rrMaxSideVal', hiddenId: 'rrMaxSide',
    min: 0, max: 1024, step: 64, decimals: 0,
  });
  setupContinuousKnob({
    knobId: 'rrSeedKnob', indicatorId: 'rrSeedKnobInd',
    valueId: 'rrSeedVal', hiddenId: 'rrSeed',
    min: 0, max: 999999, step: 1, decimals: 0,
  });
  setupBinaryKnob({
    knobId: 'rrTtaKnob', indicatorId: 'rrTtaKnobInd', hiddenId: 'rrTta',
    leftValue: '0', rightValue: '1', initial: '0',
  });
  setupBinaryKnob({
    knobId: 'rrUhdKnob', indicatorId: 'rrUhdKnobInd', hiddenId: 'rrUhd',
    leftValue: '0', rightValue: '1', initial: '0',
  });
  setupBinaryKnob({
    knobId: 'rrSaveStillsKnob', indicatorId: 'rrSaveStillsKnobInd', hiddenId: 'rrSaveStills',
    leftValue: '0', rightValue: '1', initial: '0',
  });
  setupBinaryKnob({
    knobId: 'rrDryRunKnob', indicatorId: 'rrDryRunKnobInd', hiddenId: 'rrDryRun',
    leftValue: '0', rightValue: '1', initial: '0',
  });

  // Prompt library
  import('/js/ui/prompt-library.js').then(function (m) {
    m.attachPromptLibrary({
      containerEl: document.getElementById('rrPromptLib'),
      positiveEl: document.getElementById('rrPrompt'),
      negativeEl: document.getElementById('rrNeg'),
      sourceTab: 'riferecohere',
    });
  });

  document.getElementById('btnRrBrowseA')?.addEventListener('click', function() {
    if (typeof openFileBrowser === 'function') {
      openFileBrowser('rrA', false, 'file', 'image');
    }
  });
  document.getElementById('btnRrBrowseB')?.addEventListener('click', function() {
    if (typeof openFileBrowser === 'function') {
      openFileBrowser('rrB', false, 'file', 'image');
    }
  });
  document.getElementById('btnRrBrowseOut')?.addEventListener('click', function() {
    if (typeof openFileBrowser === 'function') {
      openFileBrowser('rrOutput', false, 'file_save', 'all');
    }
  });
}

function collectRifeRecohereBody() {
  var a = (document.getElementById('rrA')?.value || '').trim();
  if (!a) {
    alert('Image A is required.');
    return null;
  }
  var b = (document.getElementById('rrB')?.value || '').trim();
  if (!b) {
    alert('Image B is required.');
    return null;
  }
  var prompt = (document.getElementById('rrPrompt')?.value || '').trim();
  if (!prompt) {
    alert('Prompt is required.');
    return null;
  }

  return {
    image_a: a,
    image_b: b,
    output_path: (document.getElementById('rrOutput')?.value || '').trim() || null,
    prompt: prompt,
    negative_prompt: (document.getElementById('rrNeg')?.value || '').trim(),
    strength: parseFloat(document.getElementById('rrStrength')?.value || '0.55'),
    inference_steps: parseInt(document.getElementById('rrSteps')?.value || '8', 10),
    guidance_scale: parseFloat(document.getElementById('rrGuidance')?.value || '1.5'),
    model_id: document.getElementById('rrModel')?.value || 'rupeshs/LCM-dreamshaper-v7-openvino',
    rife_model: document.getElementById('rrRifeModel')?.value || 'rife-v4.6',
    device: 'gpu',
    fps: parseFloat(document.getElementById('rrFps')?.value || '6'),
    max_side: parseInt(document.getElementById('rrMaxSide')?.value || '0', 10) || 0,
    seed: parseInt(document.getElementById('rrSeed')?.value || '42', 10),
    tta: document.getElementById('rrTta')?.value === '1',
    uhd: document.getElementById('rrUhd')?.value === '1',
    save_stills: document.getElementById('rrSaveStills')?.value === '1',
    dry_run: document.getElementById('rrDryRun')?.value === '1',
  };
}

export { renderRifeRecohereForm, collectRifeRecohereBody };
