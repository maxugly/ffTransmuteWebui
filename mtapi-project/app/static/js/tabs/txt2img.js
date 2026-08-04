import { elements } from '/app.js';
import { setupContinuousKnob, setupBinaryKnob, knobUnitHtml } from '/js/ui/knobs.js';

function renderTxt2ImgForm() {
  const html = `
    <div class="panel-title-desc dense">
      <h3>Txt2Img · OpenVINO (GPU)</h3>
      <p class="dream-hint">
        Text-to-image via FastSD OpenVINO on <strong>GPU</strong>. No input image — just a prompt.
        Writes PNG(s) under <code>/tmp/mtapi_gen</code> if output is blank.
      </p>
    </div>

    <div class="form-row">
      <label for="t2iPrompt">Prompt</label>
      <input type="text" id="t2iPrompt" placeholder="a red fox in misty forest, cinematic" style="flex:1 1 16rem">
    </div>
    <div class="form-row">
      <label for="t2iNeg">Negative</label>
      <input type="text" id="t2iNeg" placeholder="blurry, low quality (optional)" style="flex:1 1 16rem">
    </div>

    <div class="form-row">
      <label for="t2iOutput">Output</label>
      <div class="input-row">
        <input type="text" id="t2iOutput" placeholder="blank = /tmp/mtapi_gen/…">
        <button class="btn" type="button" id="btnT2iBrowseOut">Save As</button>
      </div>
    </div>

    <div class="form-row">
      <label for="t2iModel">Model</label>
      <select id="t2iModel">
        <option value="rupeshs/sd-turbo-openvino" selected>sd-turbo-openvino (default)</option>
        <option value="rupeshs/LCM-dreamshaper-v7-openvino">LCM-dreamshaper-v7-openvino</option>
        <option value="rupeshs/sd15-lcm-square-openvino-int8">sd15-lcm-square-openvino-int8</option>
      </select>
    </div>

    <div class="knob-row">
      <div class="knob-bank">
        ${knobUnitHtml({ id: 't2iWidth', label: 'Width', value: '512' })}
        ${knobUnitHtml({ id: 't2iHeight', label: 'Height', value: '512' })}
        ${knobUnitHtml({ id: 't2iSteps', label: 'Steps', value: '4' })}
        ${knobUnitHtml({ id: 't2iGuidance', label: 'Guidance', value: '1.0' })}
        ${knobUnitHtml({ id: 't2iCount', label: 'Count', value: '1' })}
        ${knobUnitHtml({ id: 't2iDryRun', label: 'Dry run', value: '0', binary: true, leftCap: 'Run', rightCap: 'Dry' })}
      </div>
      <p class="knob-row-legend">
        Size snapped to multiples of 8. <strong>Count</strong> 1–8 images (seed+i).
        Turbo models like few steps + guidance ≈ 1.
      </p>
    </div>

    <div class="form-row">
      <label for="t2iSeed">Seed</label>
      <input type="text" id="t2iSeed" placeholder="blank = random" style="flex:0 1 8rem">
    </div>

    <section class="tool-docs" aria-label="About txt2img">
      <h4 class="tool-docs-title">About · Txt2Img</h4>
      <p class="tool-docs-lede">
        Uses the same FastSD OpenVINO stack as Img2Img
        (<code>OVStableDiffusionPipeline</code>, default <code>rupeshs/sd-turbo-openvino</code>).
        Requires FastSD’s Python env — not mtapi’s slim venv.
      </p>
    </section>
  `;
  elements.actionPanel.innerHTML = html;

  setupContinuousKnob({
    knobId: 't2iWidthKnob', indicatorId: 't2iWidthKnobInd',
    valueId: 't2iWidthVal', hiddenId: 't2iWidth',
    min: 256, max: 1024, step: 64, decimals: 0,
  });
  setupContinuousKnob({
    knobId: 't2iHeightKnob', indicatorId: 't2iHeightKnobInd',
    valueId: 't2iHeightVal', hiddenId: 't2iHeight',
    min: 256, max: 1024, step: 64, decimals: 0,
  });
  setupContinuousKnob({
    knobId: 't2iStepsKnob', indicatorId: 't2iStepsKnobInd',
    valueId: 't2iStepsVal', hiddenId: 't2iSteps',
    min: 1, max: 30, step: 1, decimals: 0,
  });
  setupContinuousKnob({
    knobId: 't2iGuidanceKnob', indicatorId: 't2iGuidanceKnobInd',
    valueId: 't2iGuidanceVal', hiddenId: 't2iGuidance',
    min: 0, max: 8, step: 0.1, decimals: 1,
  });
  setupContinuousKnob({
    knobId: 't2iCountKnob', indicatorId: 't2iCountKnobInd',
    valueId: 't2iCountVal', hiddenId: 't2iCount',
    min: 1, max: 8, step: 1, decimals: 0,
  });
  setupBinaryKnob({
    knobId: 't2iDryRunKnob', indicatorId: 't2iDryRunKnobInd', hiddenId: 't2iDryRun',
    leftValue: '0', rightValue: '1', initial: '0',
  });

  document.getElementById('btnT2iBrowseOut')?.addEventListener('click', function() {
    if (typeof openFileBrowser === 'function') {
      openFileBrowser('t2iOutput', false, 'file_save', 'all');
    }
  });
}

function collectTxt2ImgBody() {
  var prompt = (document.getElementById('t2iPrompt')?.value || '').trim();
  if (!prompt) {
    alert('Prompt is required.');
    return null;
  }
  var seedRaw = (document.getElementById('t2iSeed')?.value || '').trim();
  var seed = null;
  if (seedRaw !== '') {
    seed = parseInt(seedRaw, 10);
    if (isNaN(seed)) seed = null;
  }
  return {
    prompt: prompt,
    negative_prompt: (document.getElementById('t2iNeg')?.value || '').trim(),
    output_path: (document.getElementById('t2iOutput')?.value || '').trim() || null,
    width: parseInt(document.getElementById('t2iWidth')?.value || '512', 10),
    height: parseInt(document.getElementById('t2iHeight')?.value || '512', 10),
    inference_steps: parseInt(document.getElementById('t2iSteps')?.value || '4', 10),
    guidance_scale: parseFloat(document.getElementById('t2iGuidance')?.value || '1'),
    model_id: document.getElementById('t2iModel')?.value || 'rupeshs/sd-turbo-openvino',
    device: 'gpu',
    count: parseInt(document.getElementById('t2iCount')?.value || '1', 10),
    seed: seed,
    dry_run: document.getElementById('t2iDryRun')?.value === '1',
  };
}

export { renderTxt2ImgForm, collectTxt2ImgBody };
