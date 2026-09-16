import { state, elements, logConsole, bestInput } from '/app.js';
import { escapeHtml } from '/js/utils.js';
import { setupContinuousKnob, setupBinaryKnob, knobUnitHtml } from '/js/ui/knobs.js';
import { runOpWithCancel } from '/js/job-control.js';

// ── Erase tab (Clean section) ───────────────────────────────────────────
// lama-cleaner erase settings, nothing else: binary mask exactly as drawn,
// HD strategies Original/Crop/Resize (trigger 800 / margin 128 / limit
// 1280), masked-area-only composite. Paint once on the preview — the same
// mask runs on every frame automatically.

var _brush = {
  size: 24, eraseMode: false, painting: false, erasing: false, dirty: false,
  undo: [], // mask-store dataURLs, capped
};

function _eraseFormState() {
  if (!state.formState) state.formState = {};
  if (!state.formState.erase || typeof state.formState.erase !== 'object') {
    state.formState.erase = {};
  }
  return state.formState.erase;
}

function _saved(id, fallback) {
  var fs = _eraseFormState();
  if (fs[id] && fs[id].value != null) return fs[id].value;
  return fallback;
}

function _num(id, fallback) {
  var v = parseFloat(document.getElementById(id)?.value || '');
  return isNaN(v) ? fallback : v;
}

/** Body for erase_remove (global Run + local Remove button). */
function collectEraseBody() {
  var input = '';
  try { input = bestInput(); } catch (_) { input = ''; }
  var outDir = (document.getElementById('erOutDir')?.value || '').trim() || null;
  var hd = document.getElementById('erHd')?.value || 'Crop';
  if (hd !== 'Original' && hd !== 'Resize') hd = 'Crop';
  var trigRaw = parseInt(document.getElementById('erTrigger')?.value || '800', 10);
  var margRaw = parseInt(document.getElementById('erMargin')?.value || '128', 10);
  var limRaw = parseInt(document.getElementById('erLimit')?.value || '1280', 10);
  return {
    input_path: input,
    output_path: null,
    out_dir: outDir,
    dry_run: document.getElementById('erDryRun')?.value === '1',
    mask_b64: _maskDataUrl(),
    mask_x: Math.min(1, Math.max(0, _num('erX', 0.80))),
    mask_y: Math.min(1, Math.max(0, _num('erY', 0.84))),
    mask_w: Math.min(1, Math.max(0.001, _num('erW', 0.17))),
    mask_h: Math.min(1, Math.max(0.001, _num('erH', 0.12))),
    hd_strategy: hd,
    crop_trigger: isNaN(trigRaw) ? 800 : Math.min(4096, Math.max(256, trigRaw)),
    crop_margin: isNaN(margRaw) ? 128 : Math.min(512, Math.max(0, margRaw)),
    resize_limit: isNaN(limRaw) ? 1280 : Math.min(4096, Math.max(512, limRaw)),
    device: document.getElementById('erDevice')?.value || 'GPU',
    save_debug_mask: document.getElementById('erDebugMask')?.checked === true,
  };
}

// ── Brush mask ──────────────────────────────────────────────────────────

function _maskStore() {
  return document.getElementById('erMaskStore');
}

function _maskSize() {
  var img = document.getElementById('erPrev');
  var nw = (img && img.naturalWidth) || 0;
  var nh = (img && img.naturalHeight) || 0;
  return { w: nw, h: nh };
}

function _ensureMaskStore() {
  var store = _maskStore();
  var sz = _maskSize();
  if (!store || !sz.w || !sz.h) return null;
  if (store.width !== sz.w || store.height !== sz.h) {
    // Fresh canvas is transparent black = empty mask. NEVER fill it
    // opaque: opaque black would tint the whole overlay red.
    store.width = sz.w;
    store.height = sz.h;
    _brush.dirty = false;
    _brush.undo = [];
  }
  return store;
}

function _fitOverlay() {
  var img = document.getElementById('erPrev');
  var ov = document.getElementById('erOverlay');
  if (!img || !ov) return;
  var r = img.getBoundingClientRect();
  var wrapR = ov.parentElement.getBoundingClientRect();
  ov.width = Math.max(1, Math.round(r.width));
  ov.height = Math.max(1, Math.round(r.height));
  ov.style.left = (r.left - wrapR.left) + 'px';
  ov.style.top = (r.top - wrapR.top) + 'px';
  _redrawOverlay();
}

function _redrawOverlay() {
  var ov = document.getElementById('erOverlay');
  var store = _maskStore();
  if (!ov || !store) return;
  var cx = ov.getContext('2d');
  cx.clearRect(0, 0, ov.width, ov.height);
  var tmp = document.createElement('canvas');
  tmp.width = store.width;
  tmp.height = store.height;
  var tcx = tmp.getContext('2d');
  tcx.drawImage(store, 0, 0);
  tcx.globalCompositeOperation = 'source-in';
  tcx.fillStyle = 'rgba(255,60,60,0.55)';
  tcx.fillRect(0, 0, tmp.width, tmp.height);
  cx.imageSmoothingEnabled = true;
  cx.drawImage(tmp, 0, 0, ov.width, ov.height);
  var readout = document.getElementById('erMaskInfo');
  if (readout) {
    readout.textContent = _brush.dirty
      ? 'painted mask active (' + _brush.size + 'px brush)'
      : 'no paint yet — rect fallback below applies';
  }
}

function _pushUndo() {
  var store = _ensureMaskStore();
  if (!store) return;
  _brush.undo.push(store.toDataURL());
  if (_brush.undo.length > 25) _brush.undo.shift();
}

function _paintAt(ev) {
  var ov = document.getElementById('erOverlay');
  var store = _ensureMaskStore();
  if (!ov || !store) return;
  var r = ov.getBoundingClientRect();
  var dx = (ev.clientX - r.left) / Math.max(1, r.width);
  var dy = (ev.clientY - r.top) / Math.max(1, r.height);
  var nx = Math.round(dx * store.width);
  var ny = Math.round(dy * store.height);
  var cx = store.getContext('2d');
  // Latched at pointerdown: pointermove events report button -1, so the
  // event itself canNOT be trusted mid-stroke (right-drag moves would
  // otherwise paint white instead of erasing).
  var erasing = !!_brush.erasing;
  // Eraser removes paint (destination-out → transparent); paint lays
  // white. Never fill opaque black: transparent = empty mask.
  cx.globalCompositeOperation = erasing ? 'destination-out' : 'source-over';
  cx.strokeStyle = '#fff';
  cx.fillStyle = '#fff';
  cx.lineWidth = Math.max(1, _brush.size);
  cx.lineCap = 'round';
  cx.lineJoin = 'round';
  if (_brush.last) {
    cx.beginPath();
    cx.moveTo(_brush.last.x, _brush.last.y);
    cx.lineTo(nx, ny);
    cx.stroke();
  } else {
    cx.beginPath();
    cx.arc(nx, ny, Math.max(0.5, _brush.size / 2), 0, Math.PI * 2);
    cx.fill();
  }
  _brush.last = { x: nx, y: ny };
  _brush.dirty = true;
  _redrawOverlay();
}

function _maskDataUrl() {
  if (!_brush.dirty) return null;
  var store = _maskStore();
  if (!store || !store.width) return null;
  // Empty check: any painted pixel at all?
  var cx = store.getContext('2d');
  var d;
  try {
    d = cx.getImageData(0, 0, store.width, store.height).data;
  } catch (_) { return null; }
  var painted = false;
  for (var i = 0; i < d.length; i += 401 * 4) {
    if (d[i] > 0) { painted = true; break; }
  }
  return painted ? store.toDataURL('image/png') : null;
}

function _syncBrushKnob() {
  var hidden = document.getElementById('erBrush');
  var disp = document.getElementById('erBrushVal');
  var ind = document.getElementById('erBrushKnobInd');
  if (hidden) hidden.value = String(_brush.size);
  if (disp) disp.value = String(_brush.size);
  if (ind) {
    var pct = (_brush.size - 2) / (128 - 2);
    ind.style.transform = 'translate(-50%, -100%) rotate(' + (-135 + pct * 270) + 'deg)';
  }
  var readout = document.getElementById('erMaskInfo');
  if (readout && _brush.dirty) {
    readout.textContent = 'painted mask active (' + _brush.size + 'px brush)';
  }
}

// ── Preview / status / run ──────────────────────────────────────────────

function _lcPreviewUrl(input, mode, n) {
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
function _updateErasePreview() {
  var img = document.getElementById('erPrev');
  var hint = document.getElementById('erPrevHint');
  if (!img) return;
  var input = '';
  try { input = bestInput(); } catch (_) { input = ''; }
  if (!input) {
    if (hint) hint.textContent = 'No input — set a global Video/Image input above.';
    return;
  }
  if (hint) hint.textContent = '';
  var mode = document.getElementById('erFrame')?.value || 'first';
  var n = document.getElementById('erFrameN')?.value || '1';
  var url = _lcPreviewUrl(input, mode, n);
  if (url && img.getAttribute('src') !== url) img.setAttribute('src', url);
  _fitOverlay();
}

function _updateEraseRectOverlay() {
  // Rect fallback outline (thin, no dim) + readout; paint overlay is separate.
  var box = document.getElementById('erRect');
  var readout = document.getElementById('erReadout');
  if (!box) return;
  var x = Math.min(1, Math.max(0, _num('erX', 0.80)));
  var y = Math.min(1, Math.max(0, _num('erY', 0.84)));
  var w = Math.min(1, Math.max(0, _num('erW', 0.17)));
  var h = Math.min(1, Math.max(0, _num('erH', 0.12)));
  box.style.left = (x * 100) + '%';
  box.style.top = (y * 100) + '%';
  box.style.width = (w * 100) + '%';
  box.style.height = (h * 100) + '%';
  if (readout) {
    var img = document.getElementById('erPrev');
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

async function _refreshEraseStatus() {
  var box = document.getElementById('erStatusLine');
  if (box) box.textContent = 'Checking…';
  try {
    var res = await fetch('/api/erase/status');
    var data = await res.json();
    if (box) {
      box.textContent = 'onnx ' + (data.onnx_present ? 'ok' : 'MISSING')
        + ' · IR ' + (data.ir_present ? 'ok' : 'MISSING')
        + ' · devices ' + ((data.devices || []).join('/') || '?');
    }
  } catch (err) {
    if (box) box.textContent = 'Status check failed — ' + err.message;
  }
}

async function _runEraseSetup() {
  var card = document.getElementById('erCard');
  if (card) card.querySelectorAll('button').forEach(function(b) { b.disabled = true; });
  try {
    await runOpWithCancel('erase_setup', { action: 'install', dry_run: false },
      { label: 'Erase setup (download + convert + smoke)…' });
  } catch (_) { /* logged */ }
  if (card) card.querySelectorAll('button').forEach(function(b) { b.disabled = false; });
  _refreshEraseStatus();
}

async function _runRemove() {
  var wrap = document.getElementById('erPrevWrap');
  var body = collectEraseBody();
  if (!body.input_path) {
    alert('No input selected. Use the global Video/Image inputs.');
    return;
  }
  if (wrap) wrap.classList.add('erasing');
  logConsole('[ERASE]: POST /ops/erase_remove\n' + JSON.stringify(
    Object.assign({}, body, { mask_b64: body.mask_b64 ? ('<png ' + body.mask_b64.length + ' chars>') : null }), null, 2));
  try {
    await runOpWithCancel('erase_remove', body, { label: 'Erasing watermark…' });
  } catch (_) { /* logged */ }
  if (wrap) wrap.classList.remove('erasing');
}

function renderEraseForm() {
  var reminder = '';
  try { reminder = bestInput() || '(none — set a global input above)'; }
  catch (_) { reminder = '(none — set a global input above)'; }

  elements.actionPanel.innerHTML = ''
    + '<style>#erPrevWrap.erasing #erOverlay{animation:er-pulse 0.9s ease-in-out infinite}'
    + '@keyframes er-pulse{0%,100%{opacity:1}50%{opacity:0.35}}</style>'
    + '<div class="panel-title-desc dense"><h3>Erase</h3>'
    + '<p class="dream-hint">Paint the watermark out with LaMA — draw once on the preview, '
    + 'the same mask runs on <strong>every frame</strong> automatically. '
    + 'Runs on the <strong>global input</strong> (Video / Image bars above).</p></div>'
    + '<div class="card" id="erCard" style="margin-bottom:10px">'
    + '<div class="form-row"><span class="form-row-hint" id="erStatusLine">Checking…</span></div>'
    + '<div class="form-row"><button type="button" class="btn" id="btnErSetup">Setup</button> '
    + '<button type="button" class="btn" id="btnErRefresh">Refresh</button></div>'
    + '</div>'
    + '<div class="form-row"><div id="erPrevWrap" style="position:relative;display:inline-block;max-width:100%">'
    + '<img id="erPrev" alt="Erase preview" style="display:block;max-width:420px;width:100%">'
    + '<canvas id="erOverlay" style="position:absolute;pointer-events:auto;cursor:crosshair;touch-action:none"></canvas>'
    + '<div id="erRect" style="position:absolute;border:1px dashed rgba(255,255,255,0.6);pointer-events:none"></div>'
    + '</div></div>'
    + '<div class="form-row"><span class="form-row-hint" id="erPrevHint"></span></div>'
    + '<div class="form-row"><label for="erFrame">Preview frame</label>'
    + '<select id="erFrame">'
    + '<option value="first">First</option><option value="last">Last</option>'
    + '<option value="mid">Mid</option><option value="n">N…</option>'
    + '</select> <input type="text" id="erFrameN" data-clearable placeholder="N" '
    + 'value="' + escapeHtml(_saved('erFrameN', '1')) + '" style="width:5em">'
    + ' <button type="button" class="btn" id="btnErPrev">Load frame</button></div>'
    + '<div class="form-row"><span class="form-row-hint" id="erMaskInfo">no paint yet — rect fallback below applies</span></div>'
    + '<div class="form-row"><button type="button" class="btn" id="btnErUndo">Undo stroke</button> '
    + '<button type="button" class="btn" id="btnErClear">Clear mask</button> '
    + '<button type="button" class="btn" id="btnErEraser">Eraser: off</button></div>'
    + '<div class="knob-row"><div class="knob-bank">'
    + knobUnitHtml({ id: 'erBrush', label: 'Brush px', value: _saved('erBrush', '24') })
    + '</div><p class="knob-row-legend">Left-drag paints, right-drag erases, wheel resizes the brush. Painted mask beats the rect below.</p></div>'
    + '<span data-knob-spec="erBrush" data-min="2" data-max="128" data-step="1" data-dec="0" hidden></span>'
    + '<div class="knob-row"><div class="knob-bank">'
    + knobUnitHtml({ id: 'erX', label: 'Rect X', value: _saved('erX', '0.80') })
    + knobUnitHtml({ id: 'erY', label: 'Rect Y', value: _saved('erY', '0.84') })
    + knobUnitHtml({ id: 'erW', label: 'Rect W', value: _saved('erW', '0.17') })
    + knobUnitHtml({ id: 'erH', label: 'Rect H', value: _saved('erH', '0.12') })
    + '</div><p class="knob-row-legend">Fallback when nothing is painted (normalized 0–1, area capped at 25% server-side).</p></div>'
    + '<span data-knob-spec="erX" data-min="0" data-max="1" data-step="0.005" data-dec="3" hidden></span>'
    + '<span data-knob-spec="erY" data-min="0" data-max="1" data-step="0.005" data-dec="3" hidden></span>'
    + '<span data-knob-spec="erW" data-min="0" data-max="1" data-step="0.005" data-dec="3" hidden></span>'
    + '<span data-knob-spec="erH" data-min="0" data-max="1" data-step="0.005" data-dec="3" hidden></span>'
    + '<div class="form-row"><span class="form-row-hint" id="erReadout"></span></div>'
    + '<div class="form-row"><label for="erHd">HD strategy</label>'
    + '<select id="erHd">'
    + '<option value="Crop">Crop (default)</option>'
    + '<option value="Original">Original</option>'
    + '<option value="Resize">Resize</option>'
    + '</select></div>'
    + '<div class="knob-row"><div class="knob-bank">'
    + knobUnitHtml({ id: 'erTrigger', label: 'Crop trigger px', value: _saved('erTrigger', '800') })
    + knobUnitHtml({ id: 'erMargin', label: 'Crop margin px', value: _saved('erMargin', '128') })
    + knobUnitHtml({ id: 'erLimit', label: 'Resize limit px', value: _saved('erLimit', '1280') })
    + '</div><p class="knob-row-legend">Crop runs when the longer side tops the trigger, with margin context around the mask. Resize scales the longer side to the limit first.</p></div>'
    + '<span data-knob-spec="erTrigger" data-min="256" data-max="4096" data-step="16" data-dec="0" hidden></span>'
    + '<span data-knob-spec="erMargin" data-min="0" data-max="512" data-step="8" data-dec="0" hidden></span>'
    + '<span data-knob-spec="erLimit" data-min="512" data-max="4096" data-step="64" data-dec="0" hidden></span>'
    + '<div class="form-row"><label for="erDevice">Device</label>'
    + '<select id="erDevice">'
    + '<option value="GPU">GPU</option><option value="CPU">CPU</option><option value="AUTO">AUTO</option>'
    + '</select></div>'
    + '<div class="form-row"><label for="erOutDir">Output dir</label>'
    + '<div class="input-row"><input type="text" id="erOutDir" data-clearable '
    + 'placeholder="(blank = next to input)" value="' + escapeHtml(_saved('erOutDir', '')) + '">'
    + '<button type="button" class="btn" id="btnErOutBrowse">Browse</button>'
    + '</div></div>'
    + '<div class="form-row"><label><input type="checkbox" id="erDebugMask" '
    + (_saved('erDebugMask', false) ? 'checked' : '') + '> Save exact mask for troubleshooting</label>'
    + '<span class="form-row-hint">Writes a PNG to <code>mtapi-project/junk/</code>.</span></div>'
    + '<div class="knob-row"><div class="knob-bank">'
    + knobUnitHtml({ id: 'erDryRun', label: 'Dry run', value: _saved('erDryRun', '0'), binary: true, leftCap: 'Run', rightCap: 'Dry' })
    + '</div><p class="knob-row-legend">Outputs never overwrite — collisions get _0001, _0002, … like every other tab. Dry = print command only.</p></div>'
    + '<div class="form-row"><button type="button" class="btn btn-primary" id="btnErRemove">Remove</button> '
    + '<span class="form-row-hint">Or use the global <strong>Run</strong> button (= Remove).</span></div>'
    + '<div class="form-row"><span class="form-row-hint" id="erInputReminder">Current input: '
    + escapeHtml(reminder) + '</span></div>'
    + '<section class="tool-docs" aria-label="About erase">'
    + '<h4 class="tool-docs-title">About · Erase</h4>'
    + '<p class="tool-docs-lede">LaMA inpainting with lama-cleaner erase settings: '
    + 'binary mask exactly as painted, HD strategies, masked-area-only composite.</p>'
    + '<p><strong>Limits:</strong> one static mask for the whole job (moving marks out of scope); '
    + 'rect fallback area capped at 25% server-side; model canvas is fixed 512×512 (Crop keeps small marks near-native).</p>'
    + '<p>Weights: <code>mtapi-project/junk/models/lama/</code> (Carve/LaMa-ONNX, Apache-2.0). '
    + 'Pipeline: Sanster/iopaint erase path (Apache-2.0).</p></section>'
    + '<canvas id="erMaskStore" hidden></canvas>';

  setupBinaryKnob({
    knobId: 'erDryRunKnob', indicatorId: 'erDryRunKnobInd', hiddenId: 'erDryRun',
    leftValue: '0', rightValue: '1',
    initial: document.getElementById('erDryRun')?.value || '0',
  });
  setupContinuousKnob({
    knobId: 'erBrushKnob', indicatorId: 'erBrushKnobInd',
    valueId: 'erBrushVal', hiddenId: 'erBrush',
    min: 2, max: 128, step: 1, decimals: 0,
    onChange: function(v) { _brush.size = Math.round(v); },
  });
  _brush.size = parseInt(document.getElementById('erBrush')?.value || '24', 10) || 24;
  [{ knob: 'erX', dec: 3 }, { knob: 'erY', dec: 3 },
   { knob: 'erW', dec: 3 }, { knob: 'erH', dec: 3 }].forEach(function(k) {
    setupContinuousKnob({
      knobId: k.knob + 'Knob', indicatorId: k.knob + 'KnobInd',
      valueId: k.knob + 'Val', hiddenId: k.knob,
      min: 0, max: 1, step: 0.005, decimals: k.dec,
      onChange: function() { _updateEraseRectOverlay(); },
    });
  });
  setupContinuousKnob({
    knobId: 'erTriggerKnob', indicatorId: 'erTriggerKnobInd',
    valueId: 'erTriggerVal', hiddenId: 'erTrigger',
    min: 256, max: 4096, step: 16, decimals: 0,
  });
  setupContinuousKnob({
    knobId: 'erMarginKnob', indicatorId: 'erMarginKnobInd',
    valueId: 'erMarginVal', hiddenId: 'erMargin',
    min: 0, max: 512, step: 8, decimals: 0,
  });
  setupContinuousKnob({
    knobId: 'erLimitKnob', indicatorId: 'erLimitKnobInd',
    valueId: 'erLimitVal', hiddenId: 'erLimit',
    min: 512, max: 4096, step: 64, decimals: 0,
  });

  // ── Brush wiring ──
  var ov = document.getElementById('erOverlay');
  if (ov) {
    ov.addEventListener('contextmenu', function(e) { e.preventDefault(); });
    ov.addEventListener('pointerdown', function(e) {
      if (e.button !== 0 && e.button !== 2) return;
      _pushUndo();
      _brush.painting = true;
      _brush.erasing = _brush.eraseMode || e.button === 2;
      _brush.last = null;
      try { ov.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      _paintAt(e);
      e.preventDefault();
    });
    ov.addEventListener('pointermove', function(e) {
      if (!_brush.painting) return;
      var evts = (typeof e.getCoalescedEvents === 'function') ? e.getCoalescedEvents() : [e];
      for (var i = 0; i < evts.length; i++) _paintAt(evts[i]);
      e.preventDefault();
    });
    var endStroke = function() {
      _brush.painting = false;
      _brush.erasing = false;
      _brush.last = null;
    };
    ov.addEventListener('pointerup', endStroke);
    ov.addEventListener('pointercancel', endStroke);
    ov.addEventListener('wheel', function(e) {
      e.preventDefault();
      e.stopPropagation();
      var dir = e.deltaY < 0 ? 1 : e.deltaY > 0 ? -1 : 0;
      if (!dir) return;
      _brush.size = Math.min(128, Math.max(2, _brush.size + dir * (e.shiftKey ? 1 : 4)));
      _syncBrushKnob();
    }, { passive: false });
  }
  document.getElementById('btnErUndo')?.addEventListener('click', function() {
    var store = _ensureMaskStore();
    if (!store || !_brush.undo.length) return;
    var url = _brush.undo.pop();
    var pic = new Image();
    pic.onload = function() {
      store.getContext('2d').clearRect(0, 0, store.width, store.height);
      store.getContext('2d').drawImage(pic, 0, 0);
      if (!_brush.undo.length) _brush.dirty = false;
      _redrawOverlay();
    };
    pic.src = url;
  });
  document.getElementById('btnErClear')?.addEventListener('click', function() {
    var store = _ensureMaskStore();
    if (!store) return;
    _pushUndo();
    store.getContext('2d').clearRect(0, 0, store.width, store.height);
    _brush.dirty = false;
    _redrawOverlay();
  });
  document.getElementById('btnErEraser')?.addEventListener('click', function() {
    _brush.eraseMode = !_brush.eraseMode;
    this.textContent = 'Eraser: ' + (_brush.eraseMode ? 'on' : 'off');
  });

  document.getElementById('btnErSetup')?.addEventListener('click', _runEraseSetup);
  document.getElementById('btnErRefresh')?.addEventListener('click', _refreshEraseStatus);
  document.getElementById('btnErRemove')?.addEventListener('click', _runRemove);
  document.getElementById('btnErPrev')?.addEventListener('click', _updateErasePreview);
  document.getElementById('erFrame')?.addEventListener('change', _updateErasePreview);
  document.getElementById('erPrev')?.addEventListener('load', function() {
    _fitOverlay();
    _updateEraseRectOverlay();
  });
  window.addEventListener('resize', function() {
    if (state.activeTab === 'erase') _fitOverlay();
  });
  ['erX', 'erY', 'erW', 'erH'].forEach(function(id) {
    var valInput = document.getElementById(id + 'Val');
    if (valInput) {
      valInput.addEventListener('change', function() {
        setTimeout(_updateEraseRectOverlay, 0);
      });
    }
  });
  document.getElementById('btnErOutBrowse')?.addEventListener('click', function() {
    try { window.openFileBrowser('erOutDir', false, 'dirs', 'all'); }
    catch (err) { logConsole('[ERASE]: Browse failed — ' + err.message, 'error'); }
  });
  ['giVideo', 'giImage'].forEach(function(id) {
    document.getElementById(id)?.addEventListener('input', function() {
      if (state.activeTab !== 'erase') return;
      var rem = document.getElementById('erInputReminder');
      if (rem) {
        try { rem.textContent = 'Current input: ' + (bestInput() || '(none — set a global input above)'); }
        catch (_) { /* ignore */ }
      }
    });
  });

  _refreshEraseStatus();
}

export { renderEraseForm, collectEraseBody };
