import { elements, bestInput } from '/app.js';
import { setupContinuousKnob, setupBinaryKnob, knobUnitHtml } from '/js/ui/knobs.js';
import { withFrameRange } from '/js/utils.js';

// ── RIFE tab (AI frame interpolation) ─────────────────────────────────────

function renderRifeForm() {
  const html = `
    <div class="panel-title-desc">
      <h3>RIFE · AI Frame Interpolation</h3>
      <p class="dream-hint">
        <strong>RIFE</strong> (Real-Time Intermediate Flow Estimation) via ncnn-vulkan.
        GPU-accelerated AI slow-motion. Doubles or quadruples frame rate with
        neural in-between frames. Models: rife-v4.6 (newest, cleanest), v4, v2.4, v2.3.
      </p>
    </div>

    <div class="form-group">
      <label>Input video</label>
      <div class="input-row">
        <input type="text" id="rifeInput" placeholder="/absolute/path/to/video.mp4">
        <button class="btn" type="button" id="btnRifeBrowseIn">Browse</button>
      </div>
    </div>

    <div class="form-group">
      <label>Output path (blank = auto next to source)</label>
      <div class="input-row">
        <input type="text" id="rifeOutput" placeholder="auto: name_rife2x_rife-v4.6.mp4">
        <button class="btn" type="button" id="btnRifeBrowseOut">Save As</button>
      </div>
    </div>

    <div class="dream-section-title">Interpolation</div>
    <div class="knob-bank">
      ${knobUnitHtml({ id: 'rifeMultiplier', label: 'Multiplier', value: '2' })}
    </div>
    <p class="dream-hint">
      Frame multiplier. 2 = double FPS (one synthetic between each real),
      3 = triple, 4 = quadruple. 24fps × 4 = 96fps slow-mo.
    </p>

    <div class="form-group">
      <label>RIFE model</label>
      <select id="rifeModel">
        <option value="rife-v4.6" selected>rife-v4.6 — newest, cleanest (recommended)</option>
        <option value="rife-v4">rife-v4 — stable, slightly faster</option>
        <option value="rife-v2.4">rife-v2.4 — older variant</option>
        <option value="rife-v2.3">rife-v2.3 — oldest, fastest</option>
      </select>
    </div>

    <div class="dream-section-title">Quality</div>
    <div class="knob-bank">
      ${knobUnitHtml({ id: 'rifeTta', label: 'TTA', value: '0', binary: true, leftCap: 'Off', rightCap: 'On' })}
      ${knobUnitHtml({ id: 'rifeUhd', label: 'UHD', value: '0', binary: true, leftCap: 'Off', rightCap: 'On' })}
      ${knobUnitHtml({ id: 'rifeDryRun', label: 'Dry run', value: '0', binary: true, leftCap: 'Run', rightCap: 'Dry' })}
    </div>
    <p class="dream-hint">
      <strong>TTA</strong> (test-time augmentation) — spatial+temporal tiling, cleaner but ~2x slower.<br>
      <strong>UHD</strong> — ultra-high-def mode for 4K+ sources (higher VRAM).
    </p>
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
