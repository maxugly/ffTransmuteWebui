// Vectorize tab — vanilla ES6 (spec: docs/vectorize-tab-spec.md)
// Mounts into #actionPanelForm via renderVectorizeForm() (wired in app.js).
// Uses the global in/out system: input from bestInput() (top bar),
// output dir via globalInputs.pathOut (or next to source).
import { elements, bestInput } from '/app.js?v=4';
import { escapeHtml } from '/js/utils.js';
import { logConsole } from '/js/preview.js?v=2';

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

    <div class="svg-analyzer" id="svgAnalyzerBlock">
      <div class="panel-title-desc dense">
        <h3>SVG Analyzer</h3>
        <p class="dream-hint">Structure readout of the generated SVG — counts every element type, shows nesting depth, lists colors, and flags embedded images.</p>
      </div>
      <div class="form-row">
        <label for="vectorizeAnalyzePath">SVG path</label>
        <input type="text" id="vectorizeAnalyzePath" placeholder="/absolute/path/out.svg" autocomplete="off" spellcheck="false" data-help-title="SVG path — Analyze any SVG" data-help-text="Analyzes the generated SVG automatically after a run; you can also paste any .svg path here and press Analyze.">
        <button class="btn" type="button" id="btnVectorizeAnalyze">Analyze</button>
      </div>
      <div id="svgAnalyzerOut" class="svg-analyzer-out">
        <p class="form-row-hint">Run Vectorize (or paste any .svg path) to see the readout.</p>
      </div>
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
  bindSvgAnalyzer();
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

// ── SVG Analyzer (convertico-style readout) ────────────────────────────────

let _analyzerBound = false;

function basenameOf(p) {
  return String(p || '').split('/').filter(Boolean).pop() || p || '';
}

function fmtBytes(n) {
  if (typeof n !== 'number') return '?';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(2) + ' MB';
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (_) {
      return false;
    }
  }
}

async function analyzeSvgPath(path, engineLabel) {
  const out = document.getElementById('svgAnalyzerOut');
  if (!out) return;
  const pathInput = document.getElementById('vectorizeAnalyzePath');
  if (pathInput) pathInput.value = path;
  out.innerHTML = `<p class="form-row-hint">Analyzing <code>${escapeHtml(path)}</code>…</p>`;
  try {
    const res = await fetch('/vectorize/analyze?path=' + encodeURIComponent(path));
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      out.innerHTML = `<p class="sa-warn">Analysis failed: ${escapeHtml(detail || res.statusText)}</p>`;
      return;
    }
    renderAnalyzer(out, await res.json(), path, engineLabel || null);
  } catch (err) {
    out.innerHTML = `<p class="sa-warn">Analysis failed: ${escapeHtml(err.message)}</p>`;
  }
}

function renderAnalyzer(out, a, path, engineLabel) {
  if (!a || !a.ok) {
    out.innerHTML = `<p class="sa-warn">Analysis failed.</p>`;
    return;
  }
  const t = a.totals || {};
  const doc = a.document || {};
  const maxCount = Math.max(1, ...(a.element_counts || []).map((e) => e.count));
  const maxDepth = Math.max(1, ...(a.depth_histogram || []).map((h) => h.count));

  const chips = (a.flags || [])
    .map((f) => `<span class="sa-chip sa-warn-chip">${escapeHtml(f)}</span>`)
    .join(' ');
  const dims = (doc.width && doc.height)
    ? `${escapeHtml(doc.width)} × ${escapeHtml(doc.height)}`
    : (doc.view_box ? `viewBox ${escapeHtml(doc.view_box)}` : 'no dimensions');
  const engineLine = engineLabel
    ? `<span class="sa-chip">engine: ${escapeHtml(engineLabel)}</span>`
    : '';

  const elRows = (a.element_counts || []).map((e) => `
    <div class="sa-row">
      <span class="sa-tag">&lt;${escapeHtml(e.tag)}&gt;</span>
      <span class="sa-bar"><span class="sa-bar-fill" style="width:${((e.count / maxCount) * 100).toFixed(1)}%"></span></span>
      <span class="sa-count">${e.count}</span>
    </div>`).join('');

  const depthRows = (a.depth_histogram || []).map((h) => `
    <div class="sa-row">
      <span class="sa-tag">depth ${h.depth}</span>
      <span class="sa-bar"><span class="sa-bar-fill sa-bar-depth" style="width:${((h.count / maxDepth) * 100).toFixed(1)}%"></span></span>
      <span class="sa-count">${h.count}</span>
    </div>`).join('');

  const colorChips = (a.colors || []).map((c) => `
    <span class="sa-swatch" data-color="${escapeHtml(c.color)}" role="button" tabindex="0" title="Click to copy ${escapeHtml(c.color)}">
      <span class="sa-swatch-chip" style="background:${escapeHtml(c.color)}"></span>
      <span class="sa-swatch-hex">${escapeHtml(c.color)}</span>
      <span class="sa-swatch-count">×${c.count}</span>
    </span>`).join('');
  const sources = Object.entries(a.color_sources || {})
    .map(([k, v]) => `${escapeHtml(k)}: ${v}`)
    .join(' · ');

  let imageBlock = '';
  const images = a.embedded_images || [];
  if (images.length) {
    const rows = images.slice(0, 12).map((i) => `<li>${escapeHtml(i.kind)}${i.href_preview ? ' — <code>' + escapeHtml(i.href_preview) + '</code>' : ''}</li>`).join('');
    imageBlock = `<div class="sa-warn-box"><strong>⚠ ${images.length} embedded/referenced image(s)</strong><ul>${rows}</ul>${images.length > 12 ? `<p class="form-row-hint">…and ${images.length - 12} more</p>` : ''}</div>`;
  } else {
    imageBlock = `<p class="sa-ok">No embedded images — pure vector output.</p>`;
  }

  out.innerHTML = `
    <div class="sa-head">
      <span class="sa-title">${escapeHtml(basenameOf(path))}</span>
      ${engineLine}
      <span class="sa-meta">${fmtBytes(a.file_size_bytes)} · ${dims}</span>
    </div>
    ${chips ? `<div class="sa-chips">${chips}</div>` : ''}
    <p class="sa-summary">${t.elements} elements · ${t.distinct_tags} tag types · max nesting depth ${t.max_depth} · ${t.groups} groups · ${t.paths} paths · ${t.shapes} shapes · ${t.text_elements} text · ${t.gradients} gradients</p>
    <div class="sa-grid">
      <div class="sa-col">
        <h4 class="sa-h">Element counts</h4>
        ${elRows}
      </div>
      <div class="sa-col">
        <h4 class="sa-h">Nesting depth</h4>
        ${depthRows}
        <h4 class="sa-h">Colors (${a.colors ? a.colors.length : 0}${t.distinct_colors > (a.colors ? a.colors.length : 0) ? '+ shown' : ''})</h4>
        <div class="sa-swatches">${colorChips || '<p class="form-row-hint">no colors</p>'}</div>
        ${sources ? `<p class="form-row-hint">Sources: ${sources}</p>` : ''}
      </div>
    </div>
    ${imageBlock}
  `;
}

function renderEngineChoices(okResults) {
  const out = document.getElementById('svgAnalyzerOut');
  if (!out) return;
  const buttons = okResults.map((r) =>
    `<button class="btn sa-engine-btn" type="button" data-sa-path="${escapeHtml(r.svg_path)}" data-sa-engine="${escapeHtml(r.engine_id)}">${escapeHtml(r.engine_id)}</button>`
  ).join(' ');
  const holder = document.createElement('div');
  holder.className = 'sa-engine-row';
  holder.innerHTML = `<span class="form-row-hint">Generated by:</span> ${buttons}`;
  out.prepend(holder);
  holder.querySelectorAll('.sa-engine-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      holder.querySelectorAll('.sa-engine-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      analyzeSvgPath(btn.dataset.saPath, btn.dataset.saEngine);
    });
  });
}

function bindSvgAnalyzer() {
  const btn = document.getElementById('btnVectorizeAnalyze');
  btn?.addEventListener('click', () => {
    const path = (document.getElementById('vectorizeAnalyzePath')?.value || '').trim();
    if (!path) {
      const out = document.getElementById('svgAnalyzerOut');
      if (out) out.innerHTML = '<p class="sa-warn">Paste an .svg path first (or run Vectorize).</p>';
      return;
    }
    analyzeSvgPath(path);
  });
  const pathInput = document.getElementById('vectorizeAnalyzePath');
  pathInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btn?.click();
  });

  // Click a color swatch to copy its value (delegated; survives re-renders).
  const out = document.getElementById('svgAnalyzerOut');
  out?.addEventListener('click', async (e) => {
    const sw = e.target.closest('.sa-swatch');
    if (!sw || !sw.dataset.color) return;
    if (await copyText(sw.dataset.color)) {
      sw.classList.add('sa-copied');
      logConsole(`[COPIED]: ${sw.dataset.color}`);
      setTimeout(() => sw.classList.remove('sa-copied'), 900);
    }
  });
  out?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const sw = e.target.closest('.sa-swatch');
    if (sw) {
      e.preventDefault();
      sw.click();
    }
  });

  if (_analyzerBound) return;
  _analyzerBound = true;
  // Auto-analyze after a successful vectorize run (Run path only; queued
  // jobs report through the queue flow, manual Analyze covers those).
  window.addEventListener('mtapi:op-result', (ev) => {
    const res = ev.detail || {};
    if (res.operation !== 'vectorize' || !res.ok || res.dry_run) return;
    const okResults = ((res.meta && res.meta.results) || []).filter((r) => r.ok && r.svg_path);
    if (!okResults.length) return;
    const first = okResults[0];
    if (okResults.length > 1) renderEngineChoices(okResults);
    analyzeSvgPath(first.svg_path, first.engine_id);
  });
}
