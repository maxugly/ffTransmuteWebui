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

async function _runRemove() {
  var body = collectWatermarkBody();
  if (!body.input_path) {
    alert('No input selected. Use the global Video/Image inputs.');
    return;
  }
  logConsole('[WATERMARK]: POST /ops/watermark_remove\n' + JSON.stringify(body, null, 2));
  try {
    await runOpWithCancel('watermark_remove', body, { label: 'Removing watermark…' });
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
    + '<select id="wmEngine" data-help-title="Engine — reverse alpha" data-help-text="gemini-reverse-alpha inverts the known Gemini logo composite (pixel-exact where the pattern matches). Other engines are planned and not selectable yet.">'
    + '<option value="gemini-reverse-alpha">gemini-reverse-alpha (vendored)</option>'
    + '<option value="general-ai" disabled>general-ai (planned)</option>'
    + '<option value="synthid-detect" disabled>synthid-detect (report-only, planned)</option>'
    + '</select></div>'
    + '<div class="form-row"><span class="form-row-hint" id="wmInputReminder">Current input: '
    + escapeHtml(reminder) + '</span></div>'
    + '<div class="form-row"><label for="wmOutDir">Output dir</label>'
    + '<div class="input-row"><input type="text" id="wmOutDir" data-clearable '
    + 'placeholder="(blank = next to input)" value="' + escapeHtml(_saved('wmOutDir', '')) + '">'
    + '<button type="button" class="btn" id="btnWmOutBrowse">Browse</button>'
    + '</div></div>'
    + '<div class="knob-row"><div class="knob-bank">'
    + knobUnitHtml({ id: 'wmDryRun', label: 'Dry run', value: _saved('wmDryRun', '0'), binary: true, leftCap: 'Run', rightCap: 'Dry', helpTitle: 'Dry run — Run / Dry', helpText: 'Validates params and prints the command without writing output files.' })
    + '</div><p class="knob-row-legend">Outputs never overwrite — collisions get _0001, _0002, … like every other tab. Dry = print command only.</p></div>'
    + '<div class="knob-row"><div class="knob-bank">'
    + knobUnitHtml({ id: 'wmBitrate', label: 'Video bitrate (Mbps)', value: _saved('wmBitrate', '12'), binary: false, helpTitle: 'Video bitrate (Mbps) — output encode rate [4–40]', helpText: 'Rate of the output video encode in Mbps (AVC); video only, images ignore it. Sane: 8–20; default 12.' })
    + '</div><p class="knob-row-legend">Video only (default calibrated 12 Mbps AVC; quality-sensitive sources try 20). Images ignore it.</p></div>'
    + '<span data-knob-spec="wmBitrate" data-min="4" data-max="40" data-step="0.5" data-dec="1" hidden></span>'
    + '<div class="form-row"><label for="wmTimeout">Video timeout (ms)</label>'
    + '<input type="text" id="wmTimeout" data-clearable placeholder="(blank = default)" '
    + 'value="' + escapeHtml(_saved('wmTimeout', '')) + '">'
    + '<span class="form-row-hint">Inactivity timeout — an export may run longer while frames keep advancing.</span></div>'
    + '<div class="form-row"><button type="button" class="btn btn-primary" id="btnWmRemove">Remove</button> '
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
    + '<code>mtapi-project/tools/gemini-watermark-remover/</code> (tag v1.0.43).</p></section>';

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

export { renderWatermarkForm, collectWatermarkBody, refreshWatermarkStatus };
