import { elements, bestInput } from '/app.js';
import { setupContinuousKnob, setupBinaryKnob, knobUnitHtml } from '/js/ui/knobs.js';
import { withFrameRange } from '/js/utils.js';

// ── RIFE tab (AI frame interpolation) ─────────────────────────────────────

function renderRifeForm() {
  const html = `
    <div class="panel-title-desc dense">
      <h3>RIFE · AI frame interpolation</h3>
      <p class="dream-hint">ncnn-vulkan slow-mo — neural in-betweens. Models: v4.6 (cleanest), v4, v2.4, v2.3.</p>
    </div>

    <div class="form-row">
      <label for="rifeInput">Input</label>
      <div class="input-row">
        <input type="text" id="rifeInput" placeholder="/absolute/path/to/video.mp4">
        <button class="btn" type="button" id="btnRifeBrowseIn">Browse</button>
      </div>
    </div>
    <div class="form-row">
      <label for="rifeOutput">Output</label>
      <div class="input-row">
        <input type="text" id="rifeOutput" placeholder="blank = auto next to source">
        <button class="btn" type="button" id="btnRifeBrowseOut">Save As</button>
      </div>
    </div>

    <div class="form-row">
      <label for="rifeModel">Model</label>
      <select id="rifeModel">
        <option value="rife-v4.6" selected>rife-v4.6 — newest, cleanest</option>
        <option value="rife-v4">rife-v4 — stable, faster</option>
        <option value="rife-v2.4">rife-v2.4</option>
        <option value="rife-v2.3">rife-v2.3 — fastest</option>
      </select>
    </div>

    <div class="knob-row">
      <div class="knob-bank">
        ${knobUnitHtml({ id: 'rifeMultiplier', label: 'Multiplier', value: '2' })}
        ${knobUnitHtml({ id: 'rifeTta', label: 'TTA', value: '0', binary: true, leftCap: 'Off', rightCap: 'On' })}
        ${knobUnitHtml({ id: 'rifeUhd', label: 'UHD', value: '0', binary: true, leftCap: 'Off', rightCap: 'On' })}
        ${knobUnitHtml({ id: 'rifeDryRun', label: 'Dry run', value: '0', binary: true, leftCap: 'Run', rightCap: 'Dry' })}
      </div>
      <p class="knob-row-legend">
        <strong>Multiplier</strong> — 2 = double FPS, 4 = quadruple (24→96).<br>
        <strong>TTA</strong> — cleaner, ~2× slower. <strong>UHD</strong> — 4K+ (more VRAM).
      </p>
    </div>
  `;
  elements.actionPanel.innerHTML = html;

  setupContinuousKnob({
    knobId: 'rifeMultiplierKnob', indicatorId: 'rifeMultiplierKnobInd', valueId: 'rifeMultiplierVal', hiddenId: 'rifeMultiplier',
    min: 2, max: 8, step: 1, decimals: 0,
  });
  setupBinaryKnob({
    knobId: 'rifeTtaKnob', indicatorId: 'rifeTtaKnobInd', hiddenId: 'rifeTta',
    leftValue: '0', rightValue: '1', initial: '0',
  });
  setupBinaryKnob({
    knobId: 'rifeUhdKnob', indicatorId: 'rifeUhdKnobInd', hiddenId: 'rifeUhd',
    leftValue: '0', rightValue: '1', initial: '0',
  });
  setupBinaryKnob({
    knobId: 'rifeDryRunKnob', indicatorId: 'rifeDryRunKnobInd', hiddenId: 'rifeDryRun',
    leftValue: '0', rightValue: '1', initial: '0',
  });

  document.getElementById('btnRifeBrowseIn')?.addEventListener('click', () => {
    openFileBrowser('rifeInput', false, 'file', 'video');
  });
  document.getElementById('btnRifeBrowseOut')?.addEventListener('click', () => {
    openFileBrowser('rifeOutput', true, 'file', 'video');
  });
}

function collectRifeBody() {
  const input = bestInput('rifeInput');
  if (!input) {
    alert('Please provide an input video path.');
    return null;
  }
  const output = document.getElementById('rifeOutput')?.value?.trim() || null;
  const multiplier = parseInt(document.getElementById('rifeMultiplier')?.value || '2', 10);
  const model = document.getElementById('rifeModel')?.value || 'rife-v4.6';
  const tta = document.getElementById('rifeTta')?.value === '1';
  const uhd = document.getElementById('rifeUhd')?.value === '1';
  const dryRun = document.getElementById('rifeDryRun')?.value === '1';

  return withFrameRange({
    input_path: input,
    output_path: output,
    multiplier,
    model,
    tta,
    uhd,
    dry_run: dryRun,
  });
}

export { renderRifeForm, collectRifeBody };
