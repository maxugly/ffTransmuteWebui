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
      <label for="fastsamDevice">Device</label>
      <select id="fastsamDevice">
        <option value="GPU" selected>GPU (Iris Xe)</option>
        <option value="CPU">CPU</option>
        <option value="AUTO">AUTO</option>
      </select>
      <p class="form-row-hint">Use GPU for best performance with Intel Iris Xe (FP16).</p>
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
  window.api.onSelectFile('btnFastsamBrowseIn', 'fastsamInput', false);
  window.api.onSelectFile('btnFastsamBrowseOut', 'fastsamOutput', true);
}

export function collectFastSAMBody() {
  var p = {
    input_path: (document.getElementById('fastsamInput') || {}).value || bestInput(''),
    output_dir: (document.getElementById('fastsamOutput') || {}).value || '',
    conf: parseFloat((document.getElementById('fastsamConf') || {}).value || '0.4'),
    iou: parseFloat((document.getElementById('fastsamIou') || {}).value || '0.9'),
    device: (document.getElementById('fastsamDevice') || {}).value || 'GPU',
    dry_run: ((document.getElementById('fastsamDryRun') || {}).value === '1'),
  };
  return withFrameRange(p);
}
