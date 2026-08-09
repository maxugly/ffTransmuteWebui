import { elements, bestInput } from '/app.js';
import { setupContinuousKnob, setupBinaryKnob, knobUnitHtml } from '/js/ui/knobs.js';
import { withFrameRange } from '/js/utils.js';

export function renderFastSAMForm() {
  const html = `
    <div class="panel-title-desc dense">
      <h3>FastSAM (OV) · asset extraction</h3>
      <p class="dream-hint">Uses OpenVINO optimized FastSAM model to extract subjects (FP16 on Iris Xe). Outputs transparent PNG or video.</p>
    </div>

    <div class="form-row">
      <label for="fastsamInput">Input</label>
      <div class="input-row">
        <input type="text" id="fastsamInput" placeholder="/absolute/path/to/image_or_video.mp4">
        <button class="btn" type="button" id="btnFastsamBrowseIn">Browse</button>
      </div>
    </div>
    
    <div class="form-row">
      <label for="fastsamOutput">Output</label>
      <div class="input-row">
        <input type="text" id="fastsamOutput" placeholder="blank = next to source">
        <button class="btn" type="button" id="btnFastsamBrowseOut">Save As</button>
      </div>
    </div>
    
    <div class="form-row">
      <label for="fastsamMode">Mode</label>
      <select id="fastsamMode">
        <option value="target" selected>Target (X,Y)</option>
        <option value="everything">Segment Everything</option>
      </select>
      <p class="form-row-hint">Target mode extracts a single object at the X/Y point. Everything mode saves all objects to a folder.</p>
    </div>

    <div class="form-row">
      <label for="fastsamDevice">Device</label>
      <select id="fastsamDevice">
        <option value="GPU" selected>GPU (Iris Xe)</option>
        <option value="CPU">CPU</option>
        <option value="AUTO">AUTO</option>
      </select>
    </div>

    <div class="knob-row">
      <div class="knob-bank">
        ${knobUnitHtml({ id: 'fastsamTargetX', label: 'Target X', value: '0.50' })}
        ${knobUnitHtml({ id: 'fastsamTargetY', label: 'Target Y', value: '0.50' })}
      </div>
    </div>

    <div class="knob-row">
      <div class="knob-bank">
        ${knobUnitHtml({ id: 'fastsamConf', label: 'Confidence', value: '0.40' })}
        ${knobUnitHtml({ id: 'fastsamIou', label: 'IoU', value: '0.90' })}
        ${knobUnitHtml({ id: 'fastsamDryRun', label: 'Dry run', value: '0', binary: true, leftCap: 'Run', rightCap: 'Dry' })}
      </div>
    </div>
  `;
  elements.actionPanel.innerHTML = html;

  setupContinuousKnob({
    knobId: 'fastsamTargetXKnob', indicatorId: 'fastsamTargetXKnobInd', hiddenId: 'fastsamTargetX',
    min: 0.0, max: 1.0, initial: 0.5, step: 0.05,
    format: (v) => v.toFixed(2),
  });

  setupContinuousKnob({
    knobId: 'fastsamTargetYKnob', indicatorId: 'fastsamTargetYKnobInd', hiddenId: 'fastsamTargetY',
    min: 0.0, max: 1.0, initial: 0.5, step: 0.05,
    format: (v) => v.toFixed(2),
  });

  setupContinuousKnob({
    knobId: 'fastsamConfKnob', indicatorId: 'fastsamConfKnobInd', hiddenId: 'fastsamConf',
    min: 0.1, max: 0.99, initial: 0.4, step: 0.05,
    format: (v) => v.toFixed(2),
  });

  setupContinuousKnob({
    knobId: 'fastsamIouKnob', indicatorId: 'fastsamIouKnobInd', hiddenId: 'fastsamIou',
    min: 0.1, max: 0.99, initial: 0.9, step: 0.05,
    format: (v) => v.toFixed(2),
  });

  setupBinaryKnob({
    knobId: 'fastsamDryRunKnob', indicatorId: 'fastsamDryRunKnobInd', hiddenId: 'fastsamDryRun',
    leftValue: '0', rightValue: '1', initial: '0',
  });

  document.getElementById('fastsamInput').value = bestInput('');
  document.getElementById('btnFastsamBrowseIn')?.addEventListener('click', () => {
    openFileBrowser('fastsamInput', false, 'file', 'all');
  });
  document.getElementById('btnFastsamBrowseOut')?.addEventListener('click', () => {
    openFileBrowser('fastsamOutput', true, 'file', 'all');
  });
}

export function collectFastSAMBody() {
  var p = {
    input_path: (document.getElementById('fastsamInput') || {}).value || bestInput(''),
    output_dir: (document.getElementById('fastsamOutput') || {}).value || '',
    mode: (document.getElementById('fastsamMode') || {}).value || 'target',
    target_x: parseFloat((document.getElementById('fastsamTargetX') || {}).value || '0.5'),
    target_y: parseFloat((document.getElementById('fastsamTargetY') || {}).value || '0.5'),
    conf: parseFloat((document.getElementById('fastsamConf') || {}).value || '0.4'),
    iou: parseFloat((document.getElementById('fastsamIou') || {}).value || '0.9'),
    device: (document.getElementById('fastsamDevice') || {}).value || 'GPU',
    dry_run: ((document.getElementById('fastsamDryRun') || {}).value === '1'),
  };
  return withFrameRange(p);
}
