import { state, elements, bestInput } from '/app.js?v=4';
import { setupBinaryKnob, knobUnitHtml } from '/js/ui/knobs.js?v=6';
import { withFrameRange } from '/js/utils.js';

export function renderDepthmapForm() {
  const html = `
    <div class="panel-title-desc dense">
      <h3>Depth Map · Depth Anything V2</h3>
      <p class="dream-hint">Estimates dense monocular depth maps via Depth Anything V2-S (OpenVINO INT8, ~1s). Outputs grayscale or false-color depth video/image.</p>
    </div>
    <div class="knob-row settings-inline-warm">
    </div>

    <div class="form-row">
      <label for="depthInput">Input</label>
      <div class="input-row">
        <input type="text" id="depthInput" placeholder="/absolute/path/to/image_or_video.mp4" data-help-title="Input — image or video" data-help-text="Absolute path to the source image or video to extract depth from.">
        <button class="btn" type="button" id="btnDepthBrowseIn" data-help-title="Browse input" data-help-text="Pick the source image or video file.">Browse</button>
      </div>
    </div>

    <div class="form-row">
      <label for="depthOutput">Output</label>
      <div class="input-row">
        <input type="text" id="depthOutput" placeholder="blank = next to source" data-help-title="Output — blank = next to source" data-help-text="Destination for the rendered depth map video (.mp4) or image. Blank writes next to source with _depth suffix.">
        <button class="btn" type="button" id="btnDepthBrowseOut" data-help-title="Browse output" data-help-text="Pick where the depth map output is written.">Save As</button>
      </div>
    </div>

    <div class="form-row">
      <label for="depthColormap">Colormap</label>
      <select id="depthColormap" data-help-title="Colormap — Grayscale / False-color" data-help-text="Grayscale outputs normalized depth (white=near, black=far) standard for displacement/parallax. Inferno, Magma, Plasma, and Viridis apply perceptual false-color gradients.">
        <option value="grayscale" selected>Grayscale (white=near, black=far)</option>
        <option value="inferno">Inferno (perceptual heat)</option>
        <option value="magma">Magma (purple-to-white)</option>
        <option value="plasma">Plasma (cyan-to-yellow)</option>
        <option value="viridis">Viridis (blue-to-yellow)</option>
      </select>
      <p class="form-row-hint">Grayscale is the standard depth map representation for 3D displacement, parallax, and masks.</p>
    </div>

    <div class="form-row">
      <label for="depthDevice">Device</label>
      <select id="depthDevice" data-help-title="Device — CPU / GPU / AUTO" data-help-text="CPU runs INT8 VNNI instructions at ~1s per frame. GPU compiles to Iris Xe shaders. AUTO lets OpenVINO decide.">
        <option value="CPU" selected>CPU (INT8 VNNI ~1s default)</option>
        <option value="GPU">GPU (Iris Xe)</option>
        <option value="AUTO">AUTO</option>
      </select>
      <p class="form-row-hint">INT8 is hardware-accelerated on modern Intel CPUs via VNNI vector instructions (~1s/frame).</p>
    </div>

    <div class="form-row">
      <label for="depthSize">Resolution</label>
      <select id="depthSize" data-help-title="Resolution — Model Input Size" data-help-text="Spatial size fed into the vision transformer (must be a multiple of 14). Output is upscaled back to original dimensions.">
        <option value="518" selected>518×518 (standard default)</option>
        <option value="392">392×392 (fast preview)</option>
        <option value="644">644×644 (high detail)</option>
      </select>
    </div>

    <div class="knob-row">
      <div class="knob-bank">
        ${knobUnitHtml({ id: 'depthInvert', label: 'Invert', value: '0', binary: true, leftCap: 'Normal', rightCap: 'Invert', helpTitle: 'Invert — Normal / Invert', helpText: 'Normal produces white=near, black=far. Invert produces black=near, white=far.' })}
        ${knobUnitHtml({ id: 'depthDryRun', label: 'Dry run', value: '0', binary: true, leftCap: 'Run', rightCap: 'Dry', helpTitle: 'Dry run — Run / Dry', helpText: 'Dry validates parameters and source paths without executing inference.' })}
      </div>
    </div>
  `;
  elements.actionPanel.innerHTML = html;

  setupBinaryKnob({
    knobId: 'depthInvertKnob', indicatorId: 'depthInvertKnobInd', valueId: 'depthInvertVal', hiddenId: 'depthInvert',
    initial: 0,
    onChange: () => {},
  });

  setupBinaryKnob({
    knobId: 'depthDryRunKnob', indicatorId: 'depthDryRunKnobInd', valueId: 'depthDryRunVal', hiddenId: 'depthDryRun',
    initial: 0,
    onChange: () => {},
  });

  const inputEl = document.getElementById('depthInput');
  if (inputEl && !inputEl.value) {
    const candidate = bestInput('depthInput');
    if (candidate) inputEl.value = candidate;
  }

  document.getElementById('btnDepthBrowseIn')?.addEventListener('click', () => {
    openFileBrowser('depthInput', false, 'file', 'all');
  });

  document.getElementById('btnDepthBrowseOut')?.addEventListener('click', () => {
    openFileBrowser('depthOutput', true, 'file', 'all');
  });
}

export function collectDepthmapBody() {
  const p = {
    input_path: (document.getElementById('depthInput') || {}).value || bestInput(''),
    output_dir: (document.getElementById('depthOutput') || {}).value || '',
    device: (document.getElementById('depthDevice') || {}).value || 'CPU',
    colormap: (document.getElementById('depthColormap') || {}).value || 'grayscale',
    invert: (document.getElementById('depthInvert') || {}).value === '1',
    input_size: parseInt((document.getElementById('depthSize') || {}).value || '518', 10),
    model_id: 'depth-anything-v2-small',
    dry_run: ((document.getElementById('depthDryRun') || {}).value === '1'),
    keep_model_warm: !!state.settings.warmModels?.depthmap,
  };
  return withFrameRange(p);
}
