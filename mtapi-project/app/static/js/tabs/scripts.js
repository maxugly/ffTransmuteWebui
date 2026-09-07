import { state, elements, logConsole, bestInput } from '/app.js';
import { escapeHtml, globalFrameRange } from '/js/utils.js';
import { setupContinuousKnob, setupBinaryKnob, knobUnitHtml } from '/js/ui/knobs.js';
import { runOpWithCancel } from '/js/job-control.js';

// ── Script Runner tab ────────────────────────────────────────────────────
// Generic runner over GET /api/scripts/catalog. V1: read-only catalog,
// single-input scripts consume the global input; execution goes through
// runOpWithCancel (job machinery: progress / cancel / displayOpResult).

var scriptCatalog = [];
var activeScriptId = null;
var _catalogAt = 0;
var _CATALOG_TTL = 5 * 60 * 1000;
var _giHooked = false;

function _scriptsFormState() {
  if (!state.formState) state.formState = {};
  if (!state.formState.scripts || typeof state.formState.scripts !== 'object') {
    state.formState.scripts = {};
  }
  return state.formState.scripts;
}

function activeScriptDef() {
  for (var i = 0; i < scriptCatalog.length; i++) {
    if (scriptCatalog[i].id === activeScriptId) return scriptCatalog[i];
  }
  return null;
}

function activeScriptOp() {
  var def = activeScriptDef();
  if (!def) return '';
  return def.op || def.id || '';
}

function _readCatalogCache() {
  try {
    var raw = sessionStorage.getItem('mtapi_scripts_catalog');
    if (!raw) return null;
    var data = JSON.parse(raw);
    if (!data || !data.at || !Array.isArray(data.scripts)) return null;
    if (Date.now() - data.at > _CATALOG_TTL) return null;
    return data.scripts;
  } catch (_) {
    return null;
  }
}

function _writeCatalogCache(scripts) {
  try {
    sessionStorage.setItem('mtapi_scripts_catalog',
      JSON.stringify({ at: Date.now(), scripts: scripts }));
  } catch (_) { /* ignore */ }
}

async function _fetchCatalog() {
  if (scriptCatalog.length && Date.now() - _catalogAt < _CATALOG_TTL) return scriptCatalog;
  var cached = _readCatalogCache();
  if (cached) {
    scriptCatalog = cached;
    _catalogAt = Date.now();
    return scriptCatalog;
  }
  var res = await fetch('/api/scripts/catalog');
  if (!res.ok) throw new Error('HTTP ' + res.status);
  var data = await res.json();
  scriptCatalog = (data && data.scripts) || [];
  _catalogAt = Date.now();
  _writeCatalogCache(scriptCatalog);
  return scriptCatalog;
}

/** Saved DOM control values for this tab (generic form-state capture). */
function _savedValues() {
  var fs = _scriptsFormState();
  var out = {};
  Object.keys(fs).forEach(function(id) {
    if (id.indexOf('scriptParam_') === 0 && fs[id] && fs[id].value != null) {
      out[id.slice('scriptParam_'.length)] = fs[id].value;
    }
  });
  return out;
}

function _paramDefault(p) {
  if (p.default !== undefined && p.default !== null) return String(p.default);
  if (p.type === 'binary') return '0';
  return '';
}

function _optValue(o) {
  return (o && typeof o === 'object') ? o.value : o;
}

function _optLabel(o) {
  if (o && typeof o === 'object') return o.label != null ? o.label : String(o.value);
  return String(o);
}

function _groupOf(def, p) {
  return p.group || '';
}

function _groupsOf(def) {
  var seen = [];
  (def.parameters || []).forEach(function(p) {
    var g = _groupOf(def, p);
    if (seen.indexOf(g) < 0) seen.push(g);
  });
  var declared = def.groups || [];
  var ordered = [];
  declared.forEach(function(g) {
    var id = (g && g.id) || g;
    if (seen.indexOf(id) >= 0) ordered.push(g);
  });
  seen.forEach(function(g) {
    var found = ordered.some(function(x) { return ((x && x.id) || x) === g; });
    if (!found) ordered.push(g);
  });
  return ordered;
}

function _groupLabel(g) {
  if (g && typeof g === 'object') return g.label || g.id || '';
  if (!g) return 'Parameters';
  return String(g);
}

function _groupId(g) {
  if (g && typeof g === 'object') return g.id || g.label || '';
  return g || '';
}

function _renderParamControl(p, value) {
  var id = 'scriptParam_' + p.name;
  var legend = p.legend
    ? '<p class="knob-row-legend">' + escapeHtml(p.legend) + '</p>' : '';
  if (p.type === 'knob') {
    var min = Number(p.min != null ? p.min : 0);
    var max = Number(p.max != null ? p.max : 100);
    var step = Number(p.step != null ? p.step : 0.01);
    var dec = (p.decimals != null) ? Number(p.decimals)
      : (String(step).split('.')[1] || '').length;
    return '<div class="knob-row"><div class="knob-bank">'
      + knobUnitHtml({ id: id, label: p.label || p.name, value: value, binary: false })
      + '</div>' + legend + '</div>'
      + '<span data-knob-spec="' + escapeHtml(id) + '"'
      + ' data-min="' + min + '" data-max="' + max + '"'
      + ' data-step="' + step + '" data-dec="' + dec + '" hidden></span>';
  }
  if (p.type === 'binary') {
    var on = (value === '1' || value === 'true');
    return '<div class="knob-row"><div class="knob-bank">'
      + knobUnitHtml({ id: id, label: p.label || p.name, value: on ? '1' : '0',
                       binary: true, leftCap: 'Off', rightCap: 'On' })
      + '</div>' + legend + '</div>';
  }
  if (p.type === 'select') {
    var opts = (p.options || []).map(function(o) {
      var v = String(_optValue(o));
      return '<option value="' + escapeHtml(v) + '"'
        + (v === value ? ' selected' : '') + '>'
        + escapeHtml(_optLabel(o)) + '</option>';
    }).join('');
    return '<div class="form-row"><label for="' + escapeHtml(id) + '">'
      + escapeHtml(p.label || p.name) + '</label>'
      + '<select id="' + escapeHtml(id) + '">' + opts + '</select></div>'
      + legend;
  }
  if (p.type === 'file') {
    return '<div class="form-row"><label for="' + escapeHtml(id) + '">'
      + escapeHtml(p.label || p.name) + '</label>'
      + '<div class="input-row"><input type="text" id="' + escapeHtml(id) + '"'
      + ' data-clearable placeholder="(uses global input when blank)"'
      + ' value="' + escapeHtml(value) + '">'
      + '<button type="button" class="btn" data-browse-for="' + escapeHtml(id) + '">Browse</button>'
      + '</div></div>' + legend;
  }
  // text
  return '<div class="form-row"><label for="' + escapeHtml(id) + '">'
    + escapeHtml(p.label || p.name) + '</label>'
    + '<input type="text" id="' + escapeHtml(id) + '" data-clearable'
    + ' value="' + escapeHtml(value) + '"></div>' + legend;
}

function _wireParamControl(p) {
  var id = 'scriptParam_' + p.name;
  if (p.type === 'knob') {
    var spec = document.querySelector('[data-knob-spec="' + id + '"]');
    setupContinuousKnob({
      knobId: id + 'Knob', indicatorId: id + 'KnobInd',
      valueId: id + 'Val', hiddenId: id,
      min: Number(spec ? spec.dataset.min : (p.min != null ? p.min : 0)),
      max: Number(spec ? spec.dataset.max : (p.max != null ? p.max : 100)),
      step: Number(spec ? spec.dataset.step : (p.step != null ? p.step : 0.01)),
      decimals: Number(spec ? spec.dataset.dec : (p.decimals != null ? p.decimals : 2)),
    });
  } else if (p.type === 'binary') {
    setupBinaryKnob({
      knobId: id + 'Knob', indicatorId: id + 'KnobInd', hiddenId: id,
      leftValue: '0', rightValue: '1',
      initial: document.getElementById(id)?.value || '0',
    });
  }
}

/** Read current extras DOM values {name: value}. */
function _readExtrasValues() {
  var out = {};
  document.querySelectorAll('[id^="scriptParam_"]').forEach(function(el) {
    out[el.id.slice('scriptParam_'.length)] = el.value;
  });
  return out;
}

function updateScriptExtras(overrides) {
  var def = activeScriptDef();
  var box = document.getElementById('scriptExtras');
  var framesRow = document.getElementById('giFramesRow');
  if (framesRow) {
    framesRow.style.display = (def && def.uses_frame_range) ? '' : 'none';
  }
  if (!box) return;
  if (!def) {
    box.innerHTML = '<div class="form-row-hint">No script selected.</div>';
    return;
  }
  var saved = _savedValues();
  var values = {};
  (def.parameters || []).forEach(function(p) {
    values[p.name] = _paramDefault(p);
  });
  // restore same-script values (tab remount); overrides win (preset autofill)
  var sameScript = !_scriptsFormState().scriptSelect
    || (_scriptsFormState().scriptSelect.value === def.id);
  if (sameScript) {
    Object.keys(saved).forEach(function(k) {
      if (k in values) values[k] = saved[k];
    });
  }
  if (overrides) {
    Object.keys(overrides).forEach(function(k) {
      if (k in values) values[k] = String(overrides[k]);
    });
  }

  var groups = _groupsOf(def);
  var html = groups.map(function(g, gi) {
    var gid = _groupId(g);
    var params = (def.parameters || []).filter(function(p) {
      return _groupOf(def, p) === gid;
    });
    if (!params.length) return '';
    var body = params.map(function(p) {
      return _renderParamControl(p, values[p.name] != null ? values[p.name] : _paramDefault(p));
    }).join('');
    if (groups.length <= 1 && !gid) return body;
    return '<details class="card" style="margin-bottom:10px"' + (gi === 0 ? ' open' : '') + '>'
      + '<summary style="cursor:pointer;font-weight:600;padding:2px 0">'
      + escapeHtml(_groupLabel(g)) + '</summary>'
      + '<div style="margin-top:8px">' + body + '</div></details>';
  }).join('');
  box.innerHTML = html || '<div class="form-row-hint">No parameters.</div>';

  (def.parameters || []).forEach(_wireParamControl);

  box.querySelectorAll('[data-browse-for]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      try {
        window.openFileBrowser(btn.dataset.browseFor, false, 'files', 'all');
      } catch (err) {
        logConsole('[SCRIPTS]: Browse failed — ' + err.message, 'error');
      }
    });
  });

  // Preset autofill: resolution preset fills w/h, custom keeps manual.
  var presetEl = document.getElementById('scriptParam_preset');
  if (presetEl) {
    presetEl.addEventListener('change', function() {
      var preset = String(presetEl.value || 'custom').toLowerCase();
      var table = { '144p': [192, 144], '240p': [320, 240], '320p': [432, 320],
                    'vga': [640, 480], '1mp': [1024, 768], '720p': [960, 720] };
      if (!table[preset]) return; // custom keeps manual values
      var cur = _readExtrasValues();
      cur.width = String(table[preset][0]);
      cur.height = String(table[preset][1]);
      updateScriptExtras(cur);
    });
  }
}

function _dropdownHtml() {
  var byCat = {};
  var order = [];
  scriptCatalog.forEach(function(s) {
    var c = s.category || '';
    if (!byCat[c]) { byCat[c] = []; order.push(c); }
    byCat[c].push(s);
  });
  return order.map(function(c) {
    var opts = byCat[c].map(function(s) {
      return '<option value="' + escapeHtml(s.id) + '"'
        + (s.id === activeScriptId ? ' selected' : '') + '>'
        + escapeHtml(s.label || s.id) + '</option>';
    }).join('');
    if (!c) return opts;
    return '<optgroup label="' + escapeHtml(c) + '">' + opts + '</optgroup>';
  }).join('');
}

function _hookGlobalInputs() {
  if (_giHooked) return;
  _giHooked = true;
  // _syncTabInputFromGlobal hides #giFramesRow for non-range tabs on every
  // global edit; re-assert the active script's opt-in while Scripts is open.
  ['giVideo', 'giImage'].forEach(function(id) {
    document.getElementById(id)?.addEventListener('input', function() {
      if (state.activeTab !== 'scripts') return;
      var def = activeScriptDef();
      var row = document.getElementById('giFramesRow');
      if (row) row.style.display = (def && def.uses_frame_range) ? '' : 'none';
      var rem = document.getElementById('scriptInputReminder');
      if (rem) rem.textContent = 'Current input: ' + (bestInput() || '(none — set a global input above)');
    });
  });
}

function renderScriptsForm() {
  var fs = _scriptsFormState();
  var savedScript = (fs.scriptSelect && fs.scriptSelect.value) || fs.activeScriptId || null;
  if (savedScript) activeScriptId = savedScript;

  elements.actionPanel.innerHTML = ''
    + '<div class="panel-title-desc dense"><h3>Script Runner</h3>'
    + '<p class="dream-hint">Run a catalog script on the <strong>global input</strong> '
    + '(Video / Image bars above). Zero tweaks = the default look.</p></div>'
    + '<div class="form-row"><label for="scriptSelect">Script</label>'
    + '<select id="scriptSelect"><option value="">loading…</option></select></div>'
    + '<div class="form-row"><span class="form-row-hint" id="scriptInputReminder"></span></div>'
    + '<div class="form-row"><span class="form-row-hint" id="scriptDesc"></span></div>'
    + '<div class="knob-row"><div class="knob-bank">'
    + knobUnitHtml({ id: 'scriptDryRun', label: 'Dry run', value: '0', binary: true, leftCap: 'Run', rightCap: 'Dry' })
    + '</div><p class="knob-row-legend">Dry = print command only, no file written.</p></div>'
    + '<div id="scriptExtras"></div>'
    + '<div class="form-row"><button type="button" class="btn btn-primary" id="btnScriptRun">Run script</button> '
    + '<span class="form-row-hint">Or use the global <strong>Run</strong> button.</span></div>'
    + '<section class="tool-docs" aria-label="About scripts">'
    + '<h4 class="tool-docs-title">About · Script Runner</h4>'
    + '<p class="tool-docs-lede">Scripts are server-side ops with a JSON control panel '
    + '(read-only catalog in V1). Single-input scripts use the global input; '
    + 'frame range applies when the script opts in. Same job machinery as every '
    + 'other tab: progress, cancel, auto-add.</p></section>';

  setupBinaryKnob({
    knobId: 'scriptDryRunKnob', indicatorId: 'scriptDryRunKnobInd', hiddenId: 'scriptDryRun',
    leftValue: '0', rightValue: '1',
    initial: (fs.scriptDryRun && fs.scriptDryRun.value) || '0',
  });

  _hookGlobalInputs();

  document.getElementById('scriptSelect')?.addEventListener('change', function(e) {
    activeScriptId = e.target.value || null;
    _scriptsFormState().activeScriptId = activeScriptId;
    _paintScriptMeta();
    updateScriptExtras();
  });
  document.getElementById('btnScriptRun')?.addEventListener('click', function() {
    runScript();
  });

  _paintScriptMeta();
  updateScriptExtras();

  _fetchCatalog().then(function() {
    if (!activeScriptId || !scriptCatalog.some(function(s) { return s.id === activeScriptId; })) {
      activeScriptId = scriptCatalog.length ? scriptCatalog[0].id : null;
      _scriptsFormState().activeScriptId = activeScriptId;
    }
    var sel = document.getElementById('scriptSelect');
    if (sel) {
      sel.innerHTML = scriptCatalog.length ? _dropdownHtml()
        : '<option value="">(no scripts in catalog)</option>';
      sel.value = activeScriptId || '';
    }
    _paintScriptMeta();
    updateScriptExtras();
  }).catch(function(err) {
    var sel = document.getElementById('scriptSelect');
    if (sel) sel.innerHTML = '<option value="">(catalog failed to load)</option>';
    logConsole('[SCRIPTS]: catalog load failed — ' + err.message, 'error');
    updateScriptExtras();
  });
}

function _paintScriptMeta() {
  var def = activeScriptDef();
  var desc = document.getElementById('scriptDesc');
  if (desc) desc.textContent = def ? (def.description || '') : '';
  var rem = document.getElementById('scriptInputReminder');
  if (rem) {
    try {
      rem.textContent = 'Current input: ' + (bestInput() || '(none — set a global input above)');
    } catch (_) {
      rem.textContent = '';
    }
  }
}

/** Spec §3.4 + globalFrameRange() when the script opts in. */
function collectScriptBody() {
  var def = activeScriptDef();
  if (!def) return null;
  var dryParam = def.dry_run_param || 'dry_run';
  var dryEl = document.getElementById('scriptDryRun');
  var body = {};
  body[dryParam] = dryEl ? (dryEl.value === '1') : false;

  if (def.input_mode === 'single') {
    try {
      body.input_path = bestInput();
    } catch (_) {
      body.input_path = '';
    }
  }
  if (def.input_mode === 'multi') {
    (def.parameters || []).filter(function(p) { return p.type === 'file'; })
      .forEach(function(p) {
        var val = document.getElementById('scriptParam_' + p.name)?.value.trim();
        if (val) body[p.name] = val;
      });
    if (!body.input_path) {
      try {
        body.input_path = bestInput();
      } catch (_) {
        body.input_path = '';
      }
    }
  }
  (def.parameters || []).filter(function(p) { return p.type !== 'file'; })
    .forEach(function(p) {
      var el = document.getElementById('scriptParam_' + p.name);
      if (el) body[p.name] = el.value;
    });

  if (def.uses_frame_range) {
    Object.assign(body, globalFrameRange());
  }
  return body;
}

async function runScript() {
  var def = activeScriptDef();
  if (!def) {
    alert('No script selected.');
    return;
  }
  var body = collectScriptBody();
  if (!body) return;
  if (!body.input_path && def.accepts !== 'none') {
    alert('No input selected. Use the global Video/Image inputs.');
    return;
  }
  var op = activeScriptOp();
  logConsole('[SCRIPT]: POST /ops/' + op + '\n' + JSON.stringify(body, null, 2));
  try {
    await runOpWithCancel(op, body, { label: 'Running ' + (def.label || op) + '…' });
  } catch (_) { /* logged */ }
}

export { renderScriptsForm, updateScriptExtras, collectScriptBody, activeScriptDef, activeScriptOp, runScript };
