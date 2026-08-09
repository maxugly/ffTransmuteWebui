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
    
    <div id="fastsamPreviewWrapper" style="display: none; text-align: center; margin: 10px 0;">
      <div style="display: inline-block; position: relative; max-width: 100%;">
        <img id="fastsamPreviewImg" style="max-width: 100%; max-height: 400px; cursor: crosshair; border: 1px solid var(--border-color); display: block;" />
        <div id="fastsamCrosshair" style="position: absolute; width: 12px; height: 12px; border: 2px solid #0f0; border-radius: 50%; box-shadow: 0 0 4px #000; transform: translate(-50%, -50%); pointer-events: none; display: none;"></div>
      </div>
      <p class="form-row-hint" style="margin-top: 5px;">Click on the image to set the Target X/Y coordinate.</p>
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

  const inputEl = document.getElementById('fastsamInput');
  inputEl.value = bestInput('');
  
  const previewWrapper = document.getElementById('fastsamPreviewWrapper');
  const previewImg = document.getElementById('fastsamPreviewImg');
  const crosshair = document.getElementById('fastsamCrosshair');
  const modeSelect = document.getElementById('fastsamMode');
  const xHidden = document.getElementById('fastsamTargetX');
  const yHidden = document.getElementById('fastsamTargetY');
  const xInd = document.getElementById('fastsamTargetXKnobInd');
  const yInd = document.getElementById('fastsamTargetYKnobInd');

  function updatePreview() {
    const p = inputEl.value;
    if (p && (p.toLowerCase().endsWith('.png') || p.toLowerCase().endsWith('.jpg') || p.toLowerCase().endsWith('.jpeg') || p.toLowerCase().endsWith('.webp'))) {
      previewImg.src = '/api/thumbnail?which=first&path=' + encodeURIComponent(p);
      previewWrapper.style.display = 'block';
      updateCrosshair();
    } else {
      previewWrapper.style.display = 'none';
    }
  }

  function updateCrosshair() {
    if (modeSelect.value === 'everything') {
      crosshair.style.display = 'none';
      return;
    }
    const x = parseFloat(xHidden.value || '0.5');
    const y = parseFloat(yHidden.value || '0.5');
    crosshair.style.left = (x * 100) + '%';
    crosshair.style.top = (y * 100) + '%';
    crosshair.style.display = 'block';
  }

  previewImg.addEventListener('click', (e) => {
    if (modeSelect.value === 'everything') return;
    const rect = previewImg.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    
    xHidden.value = x.toFixed(2);
    yHidden.value = y.toFixed(2);
    xInd.textContent = x.toFixed(2);
    yInd.textContent = y.toFixed(2);
    
    // dispatch events so the continuous knob logic fires if needed
    xHidden.dispatchEvent(new Event('change'));
    yHidden.dispatchEvent(new Event('change'));
    updateCrosshair();
  });

  inputEl.addEventListener('change', updatePreview);
  inputEl.addEventListener('input', updatePreview);
  modeSelect.addEventListener('change', updateCrosshair);
  xHidden.addEventListener('change', updateCrosshair);
  yHidden.addEventListener('change', updateCrosshair);
  
  // Also hook up standard knobs to update the crosshair when dragged
  const observer = new MutationObserver(updateCrosshair);
  observer.observe(xHidden, { attributes: true, attributeFilter: ['value'] });
  observer.observe(yHidden, { attributes: true, attributeFilter: ['value'] });

  document.getElementById('btnFastsamBrowseIn')?.addEventListener('click', () => {
    openFileBrowser('fastsamInput', false, 'file', 'all');
  });
  
  // Initial preview check
  setTimeout(updatePreview, 100);
  
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
