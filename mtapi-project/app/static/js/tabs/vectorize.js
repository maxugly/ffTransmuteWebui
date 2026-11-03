// Vectorize tab — vanilla ES6 (spec: docs/vectorize-tab-spec.md)
// Mounts into #actionPanelForm via renderVectorizeForm() (wired in app.js).
// Uses the global in/out system: input from bestInput() (top bar),
// output dir via globalInputs.pathOut (or next to source).
import { elements, bestInput } from '/app.js?v=4';

export function renderVectorizeForm() {
  const panel = elements.actionPanel || document.getElementById('actionPanelForm') || document.getElementById('actionPanel');
  if (!panel) return;

  const html = `
    <div class="panel-title-desc dense">
      <h3>Vectorize · Raster → SVG</h3>
      <p class="dream-hint">Convert raster images (.png, .jpg, .webp) to resolution-independent SVG vector graphics using VTracer or Inkscape. Runs on the <strong>global input</strong> (Image bar above).</p>
    </div>

    <div class="form-row">
      <label for="vectorizeEngine">Engine</label>
      <select id="vectorizeEngine" data-help-title="Engine — VTracer / Inkscape / All" data-help-text="Select tracing engine. VTracer is fast in-process Rust tracing with presets; Inkscape uses autotrace/potrace CLI; All runs every available engine concurrently.">
        <option value="vtracer" selected>VTracer (Fast Rust Tracing)</option>
        <option value="inkscape">Inkscape Trace</option>
        <option value="all">All Available Engines</option>
      </select>
      <p class="form-row-hint">VTracer runs in-process via fast Rust routines. Inkscape uses CLI vectorization.</p>
    </div>

    <div id="vtracerOptionsBlock">
      <div class="form-row" id="vectorizePresetRow">
        <label for="vectorizePreset">Preset</label>
        <select id="vectorizePreset" data-help-title="Preset — Photo / Poster / B&W" data-help-text="Photo preserves full color gradient details; Poster produces stylized, posterized cutouts; B&W traces high-contrast binary shapes.">
          <option value="photo" selected>Photo (Color, detailed)</option>
          <option value="poster">Poster (Color, stylized)</option>
          <option value="bw">Black & White (Binary)</option>
        </select>
      </div>

      <div class="form-row" id="vectorizeColorsRow">
        <label for="vectorizeColors">Colors</label>
        <input type="number" id="vectorizeColors" value="16" min="2" max="64" step="1" data-help-title="Colors — Dominant Color Count [2–64]" data-help-text="Number of dominant color layers to extract (default 16).">
        <p class="form-row-hint">Number of dominant color layers (default 16).</p>
      </div>

      <div class="form-row" id="vectorizeLayeringRow">
        <label for="vectorizeLayering">Layering</label>
        <select id="vectorizeLayering" data-help-title="Layering — Stacked / Cutout" data-help-text="Stacked layers colored shapes with underlying fills; Cutout punches out overlapping regions.">
          <option value="stacked" selected>Stacked (standard layered shapes)</option>
          <option value="cutout">Cutout (non-overlapping shapes)</option>
        </select>
      </div>

      <details class="vectorize-advanced-options" style="margin: 10px 0;">
        <summary style="cursor: pointer; opacity: 0.85; font-size: 13px; font-weight: 500;">Advanced VTracer Options</summary>
        <div style="margin-top: 8px;">
          <div class="form-row">
            <label for="vectorizeFilterSpeckle">Filter Speckle</label>
            <input type="number" id="vectorizeFilterSpeckle" value="0.5" min="0.0" max="1.0" step="0.1" data-help-title="Filter Speckle [0.0–1.0]" data-help-text="Cleans up isolated speckles and pixel noise (default 0.5).">
          </div>
          <div class="form-row">
            <label for="vectorizeCornerThreshold">Corner Threshold</label>
            <input type="number" id="vectorizeCornerThreshold" value="0.6" min="0.0" max="1.0" step="0.1" data-help-title="Corner Threshold [0.0–1.0]" data-help-text="Threshold for smoothing curves vs sharp corners (default 0.6).">
          </div>
          <div class="form-row">
            <label for="vectorizePathPrecision">Path Precision</label>
            <input type="number" id="vectorizePathPrecision" value="0.9" min="0.1" max="2.0" step="0.1" data-help-title="Path Precision [0.1–2.0]" data-help-text="Curve precision and path detail (default 0.9).">
          </div>
          <div class="form-row">
            <label for="vectorizeMaxIterations">Max Iterations</label>
            <input type="number" id="vectorizeMaxIterations" value="10" min="1" max="100" step="1" data-help-title="Max Iterations [1–100]" data-help-text="Maximum curve fitting iterations (default 10).">
          </div>
        </div>
      </details>
    </div>

    <div id="inkscapeOptionsBlock" style="display: none;">
      <div class="form-row">
        <label for="inkscapeMode">Trace Mode</label>
        <select id="inkscapeMode" data-help-title="Trace Mode — Tracing Algorithm" data-help-text="Colors quantizes and traces multiple color passes; Brightness Cutoff traces single threshold; Edge Detection traces outlines.">
          <option value="colors" selected>Colors (Multi-color quantization)</option>
          <option value="brightness-cutoff">Brightness Cutoff (Monochrome threshold)</option>
          <option value="edge-detection">Edge Detection (Outlines)</option>
        </select>
      </div>

      <div class="form-row">
        <label for="inkscapeColors">Colors</label>
        <input type="number" id="inkscapeColors" value="32" min="2" max="256" step="1" data-help-title="Inkscape Colors [2–256]" data-help-text="Number of colors for color-quantization mode (default 32).">
      </div>

      <div class="form-row">
        <label>
          <input type="checkbox" id="inkscapeSmooth" checked data-help-title="Smooth — Path Smoothing" data-help-text="Apply Gaussian smoothing to reduce jagged edges."> Smooth
        </label>
      </div>
    </div>

    <div class="form-row">
      <label>
        <input type="checkbox" id="vectorizeDryRun" data-help-title="Dry run — Validate Only" data-help-text="Validates parameters and engine availability without writing output files."> Dry run
      </label>
    </div>
  `;

  panel.innerHTML = html;

  const engineSelect = document.getElementById('vectorizeEngine');
  const vtracerBlock = document.getElementById('vtracerOptionsBlock');
  const inkscapeBlock = document.getElementById('inkscapeOptionsBlock');

  const updateEngineVisibility = () => {
    const val = engineSelect ? engineSelect.value : 'vtracer';
    if (vtracerBlock) vtracerBlock.style.display = (val === 'vtracer' || val === 'all') ? '' : 'none';
    if (inkscapeBlock) inkscapeBlock.style.display = (val === 'inkscape' || val === 'all') ? '' : 'none';
  };

  engineSelect?.addEventListener('change', updateEngineVisibility);
  updateEngineVisibility();
}

/**
 * Body for standard Run/Queue chain (resolveActiveOpAndBody in job-control.js).
 * Returns null when input path is empty.
 */
export function collectVectorizeBody() {
  let input = '';
  try { input = (bestInput() || '').trim(); } catch (_) { input = ''; }
  if (!input) return null;

  const output = ((window.globalInputs && window.globalInputs.pathOut) || '').trim() || null;

  const engine = document.getElementById('vectorizeEngine')?.value || 'vtracer';
  let enabled = [];
  if (engine === 'all') {
    enabled = ['vtracer', 'inkscape'];
  } else {
    enabled = [engine];
  }

  const vtracerOpts = {
    preset: document.getElementById('vectorizePreset')?.value || 'photo',
    color_count: parseInt(document.getElementById('vectorizeColors')?.value || '16', 10),
    layering: (document.getElementById('vectorizeLayering')?.value === 'cutout') ? 1 : 3,
    speckles_filter: parseFloat(document.getElementById('vectorizeFilterSpeckle')?.value || '0.5'),
    corner_threshold: parseFloat(document.getElementById('vectorizeCornerThreshold')?.value || '0.6'),
    path_precision: parseFloat(document.getElementById('vectorizePathPrecision')?.value || '0.9'),
    max_iterations: parseInt(document.getElementById('vectorizeMaxIterations')?.value || '10', 10),
  };

  const inkscapeOpts = {
    trace_mode: document.getElementById('inkscapeMode')?.value || 'colors',
    colors: parseInt(document.getElementById('inkscapeColors')?.value || '32', 10),
    smooth: document.getElementById('inkscapeSmooth')?.checked ?? true,
  };

  const dryRun = document.getElementById('vectorizeDryRun')?.checked ?? false;

  return {
    input_path: input,
    output_path: null,
    output_dir: output,
    enabled,
    dry_run: dryRun,
    options: {
      vtracer: vtracerOpts,
      inkscape: inkscapeOpts,
    },
  };
}
