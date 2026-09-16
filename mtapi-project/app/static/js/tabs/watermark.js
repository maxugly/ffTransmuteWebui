import { state, elements, logConsole, bestInput } from '/app.js';
import { escapeHtml } from '/js/utils.js';
import { setupContinuousKnob, setupBinaryKnob, knobUnitHtml } from '/js/ui/knobs.js';
import { runOpWithCancel } from '/js/job-control.js';

// ── Watermark tab (Clean section) ─────────────────────────────────────────
// V1 engine: vendored gemini-watermark-remover (reverse alpha, file-to-file).
// Remove → watermark_remove (global Run + local button). Detect / Inspect
// are read-only side buttons with inline readouts (never touch pools).

function _wmFormState() {
  if (!state.formState) state.formState = {};
  if (!state.formState.watermark || typeof state.formState.watermark !== 'object') {
    state.formState.watermark = {};
  }
  return state.formState.watermark;
}

function _saved(id, fallback) {
  var fs = _wmFormState();
  if (fs[id] && fs[id].value != null) return fs[id].value;
  return fallback;
}

function _paintStatus(data) {
  var box = document.getElementById('wmStatusLine');
  if (!box) return;
  if (!data) {
    box.textContent = 'Status unavailable.';
    return;
  }
  var node = (data.node && data.node.found)
    ? ('node ' + (data.node.version || 'found')) : 'node MISSING';
  var gwr = (data.gwr && data.gwr.present)
    ? ('gwr ' + (data.gwr.tag || '') + ' @ ' + (data.gwr.commit || '?')) : 'gwr MISSING';
  var sharp = (data.sharp && data.sharp.present) ? 'sharp ok' : 'sharp MISSING (image file path needs it)';
  var pm = [];
  if (data.pm) {
    if (data.pm.pnpm) pm.push('pnpm');
    if (data.pm.npm) pm.push('npm');
  }
  box.textContent = node + ' · ' + gwr + ' · ' + sharp + ' · ' + (pm.join('/') || 'no js package manager');
  var lamaBox = document.getElementById('wmLamaStatusLine');
  if (lamaBox) {
    var lama = (data && data.lama) || {};
    var devs = (lama.devices && lama.devices.length) ? lama.devices.join('/') : 'no OV devices';
    if (lama.onnx_present && lama.ir_present) {
      lamaBox.textContent = 'LaMA ready · IR ok · ' + devs
        + (lama.sha256 ? ' · sha ' + String(lama.sha256).slice(0, 12) : '');
    } else if (lama.onnx_present) {
      lamaBox.textContent = 'LaMA ONNX present, IR missing — press Setup to convert.';
    } else {
      lamaBox.textContent = 'LaMA not installed — press Setup (downloads ~200MB + converts to IR).';
    }
  }
}

async function refreshWatermarkStatus() {
  var box = document.getElementById('wmStatusLine');
  if (box) box.textContent = 'Checking…';
  try {
    var res = await fetch('/api/watermark/status');
    var data = await res.json();
    _paintStatus(data);
  } catch (err) {
    if (box) box.textContent = 'Status check failed — ' + err.message;
  }
}

async function runWatermarkSetup(action) {
  var card = document.getElementById('wmInstallerCard');
  if (card) card.querySelectorAll('button').forEach(function(b) { b.disabled = true; });
  try {
    await runOpWithCancel('watermark_setup', { action: action, dry_run: false },
      { label: 'Watermark setup (' + action + ')…' });
  } catch (_) { /* logged */ }
  if (card) card.querySelectorAll('button').forEach(function(b) { b.disabled = false; });
  refreshWatermarkStatus();
}

function _readTimeout() {
  var raw = (document.getElementById('wmTimeout')?.value || '').trim();
  if (!raw) return null;
  var n = parseInt(raw, 10);
  return (isNaN(n) || n <= 0) ? null : n;
}

/** Body for watermark_remove (global Run + local Remove button). */
function collectWatermarkBody() {
  var input = '';
  try { input = bestInput(); } catch (_) { input = ''; }
  var outDir = (document.getElementById('wmOutDir')?.value || '').trim() || null;
  var bitrateRaw = parseFloat(document.getElementById('wmBitrate')?.value || '12');
  return {
    input_path: input,
    output_path: null,
    out_dir: outDir,
    engine: document.getElementById('wmEngine')?.value || 'gemini-reverse-alpha',
    video_bitrate_mbps: (isNaN(bitrateRaw) ? 12 : Math.min(40, Math.max(4, bitrateRaw))),
    video_timeout_ms: _readTimeout(),
    dry_run: document.getElementById('wmDryRun')?.value === '1',
  };
}

async function _runDetect() {
  var out = document.getElementById('wmDetectOut');
  var input = '';
  try { input = bestInput(); } catch (_) { input = ''; }
  if (!input) {
    if (out) out.textContent = 'No input — set a global Video/Image input above.';
    return;
  }
  var engine = document.getElementById('wmEngine')?.value || 'gemini-reverse-alpha';
  if (out) out.textContent = 'Detecting…';
  try {
    var res = await runOpWithCancel('watermark_detect',
      { input_path: input, engine: engine }, { label: 'Detecting watermark…' });
    var meta = (res && res.meta) || {};
    if (out) {
      out.textContent = 'found=' + meta.watermark_found
        + ' tier=' + (meta.tier || '?')
        + (meta.skipReason ? ' (' + meta.skipReason + ')' : '');
    }
  } catch (_) {
    if (out) out.textContent = 'Detect failed — see console.';
  }
}

async function _runInspect() {
  var out = document.getElementById('wmMetaOut');
  var input = '';
  try { input = bestInput(); } catch (_) { input = ''; }
  if (!input) {
    if (out) out.textContent = 'No input — set a global Video/Image input above.';
    return;
  }
  if (out) out.textContent = 'Inspecting…';
  try {
    var res = await runOpWithCancel('metadata_inspect', { input_path: input },
      { label: 'Inspecting metadata…' });
    var tags = (res && res.meta && res.meta.tags) || {};
    if (out) out.textContent = JSON.stringify(tags, null, 1).slice(0, 2000);
  } catch (_) {
    if (out) out.textContent = 'Inspect failed — see console.';
  }
}

async function _runStrip() {
  var input = '';
  try { input = bestInput(); } catch (_) { input = ''; }
  if (!input) {
    alert('No input selected. Use the global Video/Image inputs.');
    return;
  }
  var body = {
    input_path: input,
    output_path: null,
    dry_run: document.getElementById('wmDryRun')?.value === '1',
  };
  logConsole('[WATERMARK]: POST /ops/metadata_strip\n' + JSON.stringify(body, null, 2));
  try {
    await runOpWithCancel('metadata_strip', body, { label: 'Stripping metadata…' });
  } catch (_) { /* logged */ }
}

/** Body for watermark_lama_remove (global Run + LaMA button when engine matches). */
function collectWatermarkLamaBody() {
  var input = '';
  try { input = bestInput(); } catch (_) { input = ''; }
  var outDir = (document.getElementById('wmOutDir')?.value || '').trim() || null;
  function _num(id, fallback) {
    var v = parseFloat(document.getElementById(id)?.value || '');
    return isNaN(v) ? fallback : v;
  }
  var featherRaw = parseInt(document.getElementById('wmLamaFeather')?.value || '1', 10);
  var marginRaw = parseInt(document.getElementById('wmLamaMargin')?.value || '32', 10);
  var growRaw = parseInt(document.getElementById('wmLamaGrow')?.value || '0', 10);
  var sharpRaw = parseFloat(document.getElementById('wmLamaSharpen')?.value || '0');
  var sharpRRaw = parseFloat(document.getElementById('wmLamaSharpR')?.value || '1');
  var upRaw = parseFloat(document.getElementById('wmLamaUpscale')?.value || '1');
  var threshRaw = parseFloat(document.getElementById('wmLamaMaskThresh')?.value || '0.5');
  var blendSel = document.getElementById('wmLamaBlend')?.value || 'linear';
  var precSel = document.getElementById('wmLamaPrecision')?.value || 'fp16';
  return {
    input_path: input,
    output_path: null,
    out_dir: outDir,
    engine: 'lama-openvino',
    mask_x: Math.min(1, Math.max(0, _num('wmLamaX', 0.80))),
    mask_y: Math.min(1, Math.max(0, _num('wmLamaY', 0.84))),
    mask_w: Math.min(1, Math.max(0.001, _num('wmLamaW', 0.17))),
    mask_h: Math.min(1, Math.max(0.001, _num('wmLamaH', 0.12))),
    feather_px: isNaN(featherRaw) ? 1 : Math.min(8, Math.max(0, featherRaw)),
    margin_px: isNaN(marginRaw) ? 32 : Math.min(256, Math.max(0, marginRaw)),
    grow_px: isNaN(growRaw) ? 0 : Math.min(16, Math.max(0, growRaw)),
    sharpen: isNaN(sharpRaw) ? 0 : Math.min(2, Math.max(0, sharpRaw)),
    sharpen_radius: isNaN(sharpRRaw) ? 1 : Math.min(3, Math.max(0.5, sharpRRaw)),
    color_match: document.getElementById('wmLamaColorMatch')?.value === '1',
    mask_thresh: isNaN(threshRaw) ? 0.5 : Math.min(0.9, Math.max(0.1, threshRaw)),
    upscale: isNaN(upRaw) ? 1 : Math.min(4, Math.max(1, upRaw)),
    blend: (blendSel === 'poisson' || blendSel === 'mono') ? blendSel : 'linear',
    precision: precSel === 'fp32' ? 'fp32' : 'fp16',
    device: document.getElementById('wmLamaDevice')?.value || 'GPU',
    dry_run: document.getElementById('wmDryRun')?.value === '1',
  };
}

function _isLamaEngine() {
  return (document.getElementById('wmEngine')?.value || '') === 'lama-openvino';
}

/** Tab-local preview src: /api/thumbnail needs ?path= (or ?hash=) + 1-based &frame=. */
function _lamaPreviewUrl(input, mode, n) {
  if (!input) return '';
  var base = '/api/thumbnail?path=' + encodeURIComponent(input);
  if (mode === 'last') return base + '&which=last';
  var frame = 1;
  if (mode === 'n') {
    frame = parseInt(n, 10);
    if (!isFinite(frame) || frame < 1) frame = 1;
  } else if (mode === 'mid') {
    var total = parseInt((window.globalInputs && window.globalInputs.totalFrames) || '0', 10);
    frame = total > 1 ? Math.round(total / 2) : 1;
  }
  return base + '&frame=' + frame + '&_=' + frame;
}

/** Assign preview src once per frame-pick; never clear img.src (invariant 6). */
function _updateLamaPreview() {
  var img = document.getElementById('wmLamaPrev');
  var hint = document.getElementById('wmLamaPrevHint');
  if (!img) return;
  var input = '';
  try { input = bestInput(); } catch (_) { input = ''; }
  if (!input) {
    if (hint) hint.textContent = 'No input — set a global Video/Image input above.';
    return;
  }
  if (hint) hint.textContent = '';
  var mode = document.getElementById('wmLamaFrame')?.value || 'first';
  var n = document.getElementById('wmLamaFrameN')?.value || '1';
  var url = _lamaPreviewUrl(input, mode, n);
  if (url && img.getAttribute('src') !== url) img.setAttribute('src', url);
  _updateLamaOverlay();
}

function _updateLamaOverlay() {
  var box = document.getElementById('wmLamaRect');
  var readout = document.getElementById('wmLamaReadout');
  if (!box) return;
  function _num(id, fallback) {
    var v = parseFloat(document.getElementById(id)?.value || '');
    return isNaN(v) ? fallback : v;
  }
  var x = Math.min(1, Math.max(0, _num('wmLamaX', 0.80)));
  var y = Math.min(1, Math.max(0, _num('wmLamaY', 0.84)));
  var w = Math.min(1, Math.max(0, _num('wmLamaW', 0.17)));
  var h = Math.min(1, Math.max(0, _num('wmLamaH', 0.12)));
  box.style.left = (x * 100) + '%';
  box.style.top = (y * 100) + '%';
  box.style.width = (w * 100) + '%';
  box.style.height = (h * 100) + '%';
  if (readout) {
    var img = document.getElementById('wmLamaPrev');
    var nw = (img && img.naturalWidth) || 0;
    var nh = (img && img.naturalHeight) || 0;
    var pct = (w * h * 100).toFixed(1) + '% of frame';
    if (nw > 0 && nh > 0) {
      readout.textContent = Math.round(x * nw) + ',' + Math.round(y * nh) + ' '
        + Math.round(w * nw) + '×' + Math.round(h * nh) + ' px'
        + ' (' + nw + '×' + nh + ') · ' + pct;
    } else {
      readout.textContent = pct + ' (preview not loaded yet)';
    }
  }
}

async function runWatermarkLamaSetup() {
  var card = document.getElementById('wmLamaCard');
  if (card) card.querySelectorAll('button').forEach(function(b) { b.disabled = true; });
  try {
    await runOpWithCancel('watermark_lama_setup', { action: 'install', dry_run: false },
      { label: 'LaMA setup (download + convert + smoke)…' });
  } catch (_) { /* logged */ }
  if (card) card.querySelectorAll('button').forEach(function(b) { b.disabled = false; });
  refreshWatermarkStatus();
}

function _applyEngineVisibility() {
  var lama = _isLamaEngine();
  var card = document.getElementById('wmLamaCard');
  if (card) card.hidden = !lama;
  ['wmGwrBitrateRow', 'wmGwrTimeoutRow'].forEach(function(id) {
    var row = document.getElementById(id);
    if (row) row.style.display = lama ? 'none' : '';
  });
  var gwrBtns = document.getElementById('wmGwrButtons');
  if (gwrBtns) gwrBtns.style.display = lama ? 'none' : '';
  var removeBtn = document.getElementById('btnWmRemove');
  if (removeBtn) removeBtn.textContent = lama ? 'Remove (LaMA)' : 'Remove';
}

async function _runRemove() {
  var lama = _isLamaEngine();
  var body = lama ? collectWatermarkLamaBody() : collectWatermarkBody();
  if (!body.input_path) {
    alert('No input selected. Use the global Video/Image inputs.');
    return;
  }
  var opId = lama ? 'watermark_lama_remove' : 'watermark_remove';
  logConsole('[WATERMARK]: POST /ops/' + opId + '\n' + JSON.stringify(body, null, 2));
  try {
    await runOpWithCancel(opId, body, { label: 'Removing watermark…' });
  } catch (_) { /* logged */ }
}

function renderWatermarkForm() {
  var reminder = '';
  try { reminder = bestInput() || '(none — set a global input above)'; }
  catch (_) { reminder = '(none — set a global input above)'; }

  elements.actionPanel.innerHTML = ''
    + '<div class="panel-title-desc dense"><h3>Watermark</h3>'
    + '<p class="dream-hint">Clean Gemini visible watermarks + inspect/strip metadata. '
    + 'Runs on the <strong>global input</strong> (Video / Image bars above). '
    + 'Upstream: <code>GargantuaX/gemini-watermark-remover</code> (MIT, reverse alpha — exact, not inpainting).</p></div>'
    + '<div class="card" id="wmInstallerCard" style="margin-bottom:10px">'
    + '<div class="form-row"><label>Tool status</label>'
    + '<span class="form-row-hint" id="wmStatusLine">Checking…</span></div>'
    + '<div class="form-row"><button type="button" class="btn" id="btnWmInstall">Install</button> '
    + '<button type="button" class="btn" id="btnWmUpdate">Update</button> '
    + '<button type="button" class="btn" id="btnWmRefresh">Refresh</button></div>'
    + '</div>'
    + '<div class="form-row"><label for="wmEngine">Engine</label>'
    + '<select id="wmEngine">'
    + '<option value="gemini-reverse-alpha">gemini-reverse-alpha (vendored)</option>'
    + '<option value="lama-openvino">lama-openvino (LaMA inpaint)</option>'
    + '<option value="general-ai" disabled>general-ai (planned)</option>'
    + '<option value="synthid-detect" disabled>synthid-detect (report-only, planned)</option>'
    + '</select></div>'
    + '<div class="card" id="wmLamaCard" hidden style="margin:8px 0;border:1px solid rgba(255,255,255,0.12);padding:8px">'
    + '<div class="form-row"><label>LaMA inpaint</label>'
    + '<span class="form-row-hint">Static rectangle → LaMA fills from surrounding pixels (not pixel-exact like reverse-alpha). Moving watermarks are out of scope.</span></div>'
    + '<div class="form-row"><div id="wmLamaPrevWrap" style="position:relative;display:inline-block;max-width:100%">'
    + '<img id="wmLamaPrev" alt="LaMA preview" style="display:block;max-width:420px;width:100%">'
    + '<div id="wmLamaRect" style="position:absolute;border:2px solid #ff5a5a;box-shadow:0 0 0 9999px rgba(0,0,0,0.35);pointer-events:none"></div>'
    + '</div></div>'
    + '<div class="form-row"><span class="form-row-hint" id="wmLamaPrevHint"></span></div>'
    + '<div class="form-row"><label for="wmLamaFrame">Preview frame</label>'
    + '<select id="wmLamaFrame">'
    + '<option value="first">First</option><option value="last">Last</option>'
    + '<option value="mid">Mid</option><option value="n">N…</option>'
    + '</select> <input type="text" id="wmLamaFrameN" data-clearable placeholder="N" '
    + 'value="' + escapeHtml(_saved('wmLamaFrameN', '1')) + '" style="width:5em">'
    + ' <button type="button" class="btn" id="btnWmLamaPrev">Load frame</button></div>'
    + '<div class="knob-row"><div class="knob-bank">'
    + knobUnitHtml({ id: 'wmLamaX', label: 'Mask X', value: _saved('wmLamaX', '0.80') })
    + knobUnitHtml({ id: 'wmLamaY', label: 'Mask Y', value: _saved('wmLamaY', '0.84') })
    + knobUnitHtml({ id: 'wmLamaW', label: 'Mask W', value: _saved('wmLamaW', '0.17') })
    + knobUnitHtml({ id: 'wmLamaH', label: 'Mask H', value: _saved('wmLamaH', '0.12') })
    + knobUnitHtml({ id: 'wmLamaFeather', label: 'Feather px', value: _saved('wmLamaFeather', '1') })
    + knobUnitHtml({ id: 'wmLamaMargin', label: 'Crop margin px', value: _saved('wmLamaMargin', '32') })
    + knobUnitHtml({ id: 'wmLamaGrow', label: 'Grow px', value: _saved('wmLamaGrow', '0') })
    + knobUnitHtml({ id: 'wmLamaSharpen', label: 'Sharpen', value: _saved('wmLamaSharpen', '0') })
    + knobUnitHtml({ id: 'wmLamaUpscale', label: 'Detail ↑', value: _saved('wmLamaUpscale', '1') })
    + '</div><p class="knob-row-legend">Normalized 0–1 rect (one static box for the whole job). Area capped at 25% server-side. Margin = context window (0 = full-frame). Grow swallows text-edge halos. Sharpen de-blurs the fill. Detail ↑ upscales small crops into the model (1 = off).</p></div>'
    + '<span data-knob-spec="wmLamaX" data-min="0" data-max="1" data-step="0.005" data-dec="3" hidden></span>'
    + '<span data-knob-spec="wmLamaY" data-min="0" data-max="1" data-step="0.005" data-dec="3" hidden></span>'
    + '<span data-knob-spec="wmLamaW" data-min="0" data-max="1" data-step="0.005" data-dec="3" hidden></span>'
    + '<span data-knob-spec="wmLamaH" data-min="0" data-max="1" data-step="0.005" data-dec="3" hidden></span>'
    + '<span data-knob-spec="wmLamaFeather" data-min="0" data-max="8" data-step="1" data-dec="0" hidden></span>'
    + '<span data-knob-spec="wmLamaMargin" data-min="0" data-max="256" data-step="1" data-dec="0" hidden></span>'
    + '<span data-knob-spec="wmLamaGrow" data-min="0" data-max="16" data-step="1" data-dec="0" hidden></span>'
    + '<span data-knob-spec="wmLamaSharpen" data-min="0" data-max="2" data-step="0.1" data-dec="1" hidden></span>'
    + '<span data-knob-spec="wmLamaUpscale" data-min="1" data-max="4" data-step="0.5" data-dec="1" hidden></span>'
    + '<div class="form-row"><span class="form-row-hint" id="wmLamaReadout"></span></div>'
    + '<div class="form-row"><label for="wmLamaDevice">Device</label>'
    + '<select id="wmLamaDevice">'
    + '<option value="GPU">GPU</option><option value="CPU">CPU</option><option value="AUTO">AUTO</option>'
    + '</select> <label for="wmLamaPrecision" style="margin-left:8px">Precision</label> '
    + '<select id="wmLamaPrecision">'
    + '<option value="fp16">fp16</option><option value="fp32">fp32</option>'
    + '</select> <label for="wmLamaBlend" style="margin-left:8px">Blend</label> '
    + '<select id="wmLamaBlend">'
    + '<option value="linear">linear</option><option value="mono">mono (keeps color)</option><option value="poisson">poisson (full clone)</option>'
    + '</select></div>'
    + '<div class="form-row"><button type="button" class="btn" id="btnWmLamaAdv">Advanced ▸</button> '
    + '<span class="form-row-hint">Finish controls that stay out of the way until needed.</span></div>'
    + '<div id="wmLamaAdv" hidden style="margin:4px 0 4px 12px;padding-left:8px;border-left:2px solid rgba(255,255,255,0.12)">'
    + '<div class="knob-row"><div class="knob-bank">'
    + knobUnitHtml({ id: 'wmLamaSharpR', label: 'Sharp radius', value: _saved('wmLamaSharpR', '1') })
    + knobUnitHtml({ id: 'wmLamaColorMatch', label: 'Color match', value: _saved('wmLamaColorMatch', '0'), binary: true, leftCap: 'Off', rightCap: 'On' })
    + knobUnitHtml({ id: 'wmLamaMaskThresh', label: 'Mask thresh', value: _saved('wmLamaMaskThresh', '0.5') })
    + '</div><p class="knob-row-legend">Sharp radius = unsharp blur sigma. Color match = fill mean/std fitted to the surrounding ring (kills flat-tint boxes). Mask thresh = model-bound mask binarization (raise if the fill leaks, lower if edges starve).</p></div>'
    + '<span data-knob-spec="wmLamaSharpR" data-min="0.5" data-max="3" data-step="0.1" data-dec="1" hidden></span>'
    + '<span data-knob-spec="wmLamaMaskThresh" data-min="0.1" data-max="0.9" data-step="0.05" data-dec="2" hidden></span>'
    + '</div>'
    + '<div class="form-row"><button type="button" class="btn" id="btnWmLamaSetup">Setup</button> '
    + '<button type="button" class="btn" id="btnWmLamaRefresh">Refresh</button> '
    + '<span class="form-row-hint" id="wmLamaStatusLine">LaMA status unknown.</span></div>'
    + '<div class="form-row"><button type="button" class="btn btn-primary" id="btnWmLamaRemove">Remove with LaMA</button> '
    + '<span class="form-row-hint">Or global <strong>Run</strong> (= Remove with LaMA in this mode).</span></div>'
    + '</div>'
    + '<div class="form-row"><span class="form-row-hint" id="wmInputReminder">Current input: '
    + escapeHtml(reminder) + '</span></div>'
    + '<div class="form-row"><label for="wmOutDir">Output dir</label>'
    + '<div class="input-row"><input type="text" id="wmOutDir" data-clearable '
    + 'placeholder="(blank = next to input)" value="' + escapeHtml(_saved('wmOutDir', '')) + '">'
    + '<button type="button" class="btn" id="btnWmOutBrowse">Browse</button>'
    + '</div></div>'
    + '<div class="knob-row"><div class="knob-bank">'
    + knobUnitHtml({ id: 'wmDryRun', label: 'Dry run', value: _saved('wmDryRun', '0'), binary: true, leftCap: 'Run', rightCap: 'Dry' })
    + '</div><p class="knob-row-legend">Outputs never overwrite — collisions get _0001, _0002, … like every other tab. Dry = print command only.</p></div>'
    + '<div class="knob-row" id="wmGwrBitrateRow"><div class="knob-bank">'
    + knobUnitHtml({ id: 'wmBitrate', label: 'Video bitrate (Mbps)', value: _saved('wmBitrate', '12'), binary: false })
    + '</div><p class="knob-row-legend">Video only (default calibrated 12 Mbps AVC; quality-sensitive sources try 20). Images ignore it.</p></div>'
    + '<span data-knob-spec="wmBitrate" data-min="4" data-max="40" data-step="0.5" data-dec="1" hidden></span>'
    + '<div class="form-row" id="wmGwrTimeoutRow"><label for="wmTimeout">Video timeout (ms)</label>'
    + '<input type="text" id="wmTimeout" data-clearable placeholder="(blank = default)" '
    + 'value="' + escapeHtml(_saved('wmTimeout', '')) + '">'
    + '<span class="form-row-hint">Inactivity timeout — an export may run longer while frames keep advancing.</span></div>'
    + '<div class="form-row" id="wmGwrButtons"><button type="button" class="btn btn-primary" id="btnWmRemove">Remove</button> '
    + '<button type="button" class="btn" id="btnWmDetect">Detect</button> '
    + '<span class="form-row-hint" id="wmDetectOut"></span></div>'
    + '<div class="form-row"><button type="button" class="btn" id="btnWmInspect">Inspect metadata</button> '
    + '<button type="button" class="btn" id="btnWmStrip">Strip metadata</button></div>'
    + '<div class="form-row"><span class="form-row-hint" id="wmMetaOut" style="white-space:pre-wrap"></span></div>'
    + '<div class="form-row"><span class="form-row-hint">Or use the global <strong>Run</strong> button (= Remove).</span></div>'
    + '<section class="tool-docs" aria-label="About watermark removal">'
    + '<h4 class="tool-docs-title">About · Watermark</h4>'
    + '<p class="tool-docs-lede">Reverse alpha blending inverts the known logo composite '
    + '(<code>watermarked = α·logo + (1−α)·original</code>) — pixel-exact where the pattern matches.</p>'
    + '<p><strong>Limits:</strong> visible bottom-right logo only; '
    + '<strong>does not remove invisible/steganographic watermarks (no SynthID)</strong>; '
    + 'fails/skips on cropped/repainted/heavily recompressed or unknown Gemini formats; '
    + 'validated against the Gemini pattern through April 2026.</p>'
    + '<p>Bitrate/timeout are video-only. The vendored tool lives at '
    + '<code>mtapi-project/tools/gemini-watermark-remover/</code> (tag v1.0.43).</p>'
    + '<p><strong>LaMA inpaint</strong> (engine <code>lama-openvino</code>): Fourier-conv inpainting fills the '
    + 'rectangle from surrounding pixels — use for small static watermarks the reverse-alpha engine does not match '
    + '(corner bugs, overlays, burned-in text). Large/complex removals wait for <code>general-ai</code>. '
    + 'Frames are letterboxed into a 512×512 model canvas (mod-8 safe) and the hole is composited back at full '
    + 'resolution, so surviving pixels are never rescaled. Weights: '
    + '<code>mtapi-project/junk/models/lama/</code> (Carve/LaMa-ONNX, Apache-2.0).</p></section>';

  setupBinaryKnob({
    knobId: 'wmDryRunKnob', indicatorId: 'wmDryRunKnobInd', hiddenId: 'wmDryRun',
    leftValue: '0', rightValue: '1',
    initial: document.getElementById('wmDryRun')?.value || '0',
  });
  setupContinuousKnob({
    knobId: 'wmBitrateKnob', indicatorId: 'wmBitrateKnobInd',
    valueId: 'wmBitrateVal', hiddenId: 'wmBitrate',
    min: 4, max: 40, step: 0.5, decimals: 1,
  });
  [{ knob: 'wmLamaX', dec: 3 }, { knob: 'wmLamaY', dec: 3 },
   { knob: 'wmLamaW', dec: 3 }, { knob: 'wmLamaH', dec: 3 }].forEach(function(k) {
    setupContinuousKnob({
      knobId: k.knob + 'Knob', indicatorId: k.knob + 'KnobInd',
      valueId: k.knob + 'Val', hiddenId: k.knob,
      min: 0, max: 1, step: 0.005, decimals: k.dec,
    });
  });
  setupContinuousKnob({
    knobId: 'wmLamaFeatherKnob', indicatorId: 'wmLamaFeatherKnobInd',
    valueId: 'wmLamaFeatherVal', hiddenId: 'wmLamaFeather',
    min: 0, max: 8, step: 1, decimals: 0,
  });
  setupContinuousKnob({
    knobId: 'wmLamaMarginKnob', indicatorId: 'wmLamaMarginKnobInd',
    valueId: 'wmLamaMarginVal', hiddenId: 'wmLamaMargin',
    min: 0, max: 256, step: 1, decimals: 0,
  });
  setupContinuousKnob({
    knobId: 'wmLamaGrowKnob', indicatorId: 'wmLamaGrowKnobInd',
    valueId: 'wmLamaGrowVal', hiddenId: 'wmLamaGrow',
    min: 0, max: 16, step: 1, decimals: 0,
  });
  setupContinuousKnob({
    knobId: 'wmLamaSharpenKnob', indicatorId: 'wmLamaSharpenKnobInd',
    valueId: 'wmLamaSharpenVal', hiddenId: 'wmLamaSharpen',
    min: 0, max: 2, step: 0.1, decimals: 1,
  });
  setupContinuousKnob({
    knobId: 'wmLamaUpscaleKnob', indicatorId: 'wmLamaUpscaleKnobInd',
    valueId: 'wmLamaUpscaleVal', hiddenId: 'wmLamaUpscale',
    min: 1, max: 4, step: 0.5, decimals: 1,
  });
  setupContinuousKnob({
    knobId: 'wmLamaSharpRKnob', indicatorId: 'wmLamaSharpRKnobInd',
    valueId: 'wmLamaSharpRVal', hiddenId: 'wmLamaSharpR',
    min: 0.5, max: 3, step: 0.1, decimals: 1,
  });
  setupBinaryKnob({
    knobId: 'wmLamaColorMatchKnob', indicatorId: 'wmLamaColorMatchKnobInd', hiddenId: 'wmLamaColorMatch',
    leftValue: '0', rightValue: '1',
    initial: document.getElementById('wmLamaColorMatch')?.value || '0',
  });
  setupContinuousKnob({
    knobId: 'wmLamaMaskThreshKnob', indicatorId: 'wmLamaMaskThreshKnobInd',
    valueId: 'wmLamaMaskThreshVal', hiddenId: 'wmLamaMaskThresh',
    min: 0.1, max: 0.9, step: 0.05, decimals: 2,
  });
  document.getElementById('btnWmLamaAdv')?.addEventListener('click', function() {
    var adv = document.getElementById('wmLamaAdv');
    var btn = document.getElementById('btnWmLamaAdv');
    if (!adv || !btn) return;
    adv.hidden = !adv.hidden;
    btn.textContent = adv.hidden ? 'Advanced ▸' : 'Advanced ▾';
  });

  document.getElementById('btnWmInstall')?.addEventListener('click', function() { runWatermarkSetup('install'); });
  document.getElementById('btnWmUpdate')?.addEventListener('click', function() { runWatermarkSetup('update'); });
  document.getElementById('btnWmRefresh')?.addEventListener('click', function() { refreshWatermarkStatus(); });
  document.getElementById('btnWmRemove')?.addEventListener('click', _runRemove);
  document.getElementById('btnWmDetect')?.addEventListener('click', _runDetect);
  document.getElementById('btnWmInspect')?.addEventListener('click', _runInspect);
  document.getElementById('btnWmStrip')?.addEventListener('click', _runStrip);
  document.getElementById('btnWmOutBrowse')?.addEventListener('click', function() {
    try { window.openFileBrowser('wmOutDir', false, 'dirs', 'all'); }
    catch (err) { logConsole('[WATERMARK]: Browse failed — ' + err.message, 'error'); }
  });
  document.getElementById('wmEngine')?.addEventListener('change', function() {
    _applyEngineVisibility();
    if (_isLamaEngine()) _updateLamaPreview();
  });
  document.getElementById('btnWmLamaPrev')?.addEventListener('click', _updateLamaPreview);
  document.getElementById('wmLamaFrame')?.addEventListener('change', _updateLamaPreview);
  document.getElementById('btnWmLamaSetup')?.addEventListener('click', runWatermarkLamaSetup);
  document.getElementById('btnWmLamaRefresh')?.addEventListener('click', refreshWatermarkStatus);
  document.getElementById('btnWmLamaRemove')?.addEventListener('click', _runRemove);
  document.getElementById('wmLamaPrev')?.addEventListener('load', _updateLamaOverlay);
  ['wmLamaX', 'wmLamaY', 'wmLamaW', 'wmLamaH'].forEach(function(id) {
    // Knob drags/wheel write the hidden input with no DOM event, so sync
    // the overlay from the knob element + the numeric text input instead.
    var valInput = document.getElementById(id + 'Val');
    if (valInput) {
      valInput.addEventListener('change', function() {
        setTimeout(_updateLamaOverlay, 0);
      });
    }
    var knob = document.getElementById(id + 'Knob');
    if (knob) {
      knob.addEventListener('mouseup', function() {
        setTimeout(_updateLamaOverlay, 0);
      });
      knob.addEventListener('wheel', function() {
        setTimeout(_updateLamaOverlay, 0);
      }, { passive: true });
    }
    var hidden = document.getElementById(id);
    if (hidden) hidden.addEventListener('change', _updateLamaOverlay);
  });
  ['giVideo', 'giImage'].forEach(function(id) {
    document.getElementById(id)?.addEventListener('input', function() {
      if (state.activeTab !== 'watermark' || !_isLamaEngine()) return;
      _updateLamaPreview();
    });
  });
  _applyEngineVisibility();
  if (_isLamaEngine()) _updateLamaPreview();
  ['giVideo', 'giImage'].forEach(function(id) {
    document.getElementById(id)?.addEventListener('input', function() {
      if (state.activeTab !== 'watermark') return;
      var rem = document.getElementById('wmInputReminder');
      if (rem) {
        try { rem.textContent = 'Current input: ' + (bestInput() || '(none — set a global input above)'); }
        catch (_) { /* ignore */ }
      }
    });
  });

  refreshWatermarkStatus();
}

export { renderWatermarkForm, collectWatermarkBody, collectWatermarkLamaBody, refreshWatermarkStatus };
