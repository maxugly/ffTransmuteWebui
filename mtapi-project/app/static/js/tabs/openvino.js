/**
 * OpenVINO Local LLM Server Tab (`openvino`)
 *
 * 2-Level State Controller:
 *   Level 1: Server Up / Down (`/admin/start`, `/admin/stop`, `/admin/status`)
 *   Level 2: Model Hot / Cold (`/admin/load`, `/admin/unload`)
 *
 * Model/engine scoped controls and exact-model presets are staged until Apply.
 * Generation defaults keep resident weights; runtime changes reload the server.
 * Client prompts, tools and explicit generation settings remain authoritative.
 *
 * Spec: docs/openvino-tab-spec.md
 */
import { escapeHtml } from '/js/utils.js';

let _pollTimer = null;
let _busy = false;
let _formHydrated = false;
let _dirty = false;
let _currentConfig = null;
let _lastStatus = null;
let _catalog = null;
let _catalogAt = 0;
let _catalogEvidence = null;
let _dailyCatalogTimer = null;
let _catalogFetching = false;
let _settingsDescriptor = null;
let _settingsRequest = 0;
let _appliedConfig = null;
let _stoppingWork = false;
let _keepChanging = false;
let _latestActivity = null;
let _activityReceivedAt = 0;
let _statusInFlight = false;
let _viewEngine = 'playground';
const _generationControls = {
  context_window: 'ov-context-window', max_tokens: 'ov-max-tokens',
  max_tokens_default: 'ov-max-tokens-default', temperature_default: 'ov-temperature',
  top_p_default: 'ov-top-p', top_k_default: 'ov-top-k',
  repetition_penalty_default: 'ov-repetition-penalty', enable_thinking_default: 'ov-enable-thinking',
};
const _runtimeControls = {
  device: 'ov-device', kv_cache_precision: 'ov-kv-precision',
  ovms_cache_size_gb: 'ov-cache-size', ovms_max_num_seqs: 'ov-max-seqs',
  ovms_max_num_batched_tokens: 'ov-batch-tokens', ovms_enable_prefix_caching: 'ov-prefix-cache',
  ovms_dynamic_split_fuse: 'ov-split-fuse',
};
const _clone = value => JSON.parse(JSON.stringify(value));

function _setBusy(value) {
  _busy = value;
  if (value) {
    for (const id of ['ov-btn-model-toggle', 'ov-btn-server-toggle']) if (_el(id)) _el(id).disabled = true;
  }
  for (const id of ['ov-btn-save-apply', 'ov-btn-save-card', 'ov-btn-defaults', 'ov-btn-preset-save', 'ov-btn-preset-overwrite', 'ov-btn-preset-delete', 'ov-profile-select']) {
    if (_el(id)) _el(id).disabled = value || !_settingsDescriptor;
  }
  if (_el('ov-btn-send-test')) _el('ov-btn-send-test').disabled = value;
  for (const id of ['ov-engine', 'ov-device']) if (_el(id)) _el(id).disabled = value;
  if (_el('ov-model-select')) _el('ov-model-select').disabled = value || !_catalog;
}

function _readControl(id) {
  const el = _el(id);
  if (el.type === 'checkbox') return el.checked;
  if (el.type === 'number') return el.value === '' ? null : Number(el.value);
  return el.value;
}
function _writeControl(id, value) {
  const el = _el(id);
  if (!el) return;
  if (el.type === 'checkbox') el.checked = !!value;
  else el.value = value ?? '';
}
function _readProfile() {
  const values = { runtime: {} };
  for (const key of _settingsDescriptor?.generation_keys || []) values[key] = _readControl(_generationControls[key]);
  for (const key of _settingsDescriptor?.runtime_keys || []) values.runtime[key] = _readControl(_runtimeControls[key]);
  return values;
}
function _pendingChanges() {
  const out = _el('ov-pending-changes');
  if (!out || !_currentConfig || !_appliedConfig) return;
  const active = _currentConfig.models.find(m => m.id === _currentConfig.active_model_id);
  const saved = _appliedConfig.models.find(m => m.id === active?.id);
  const changes = [];
  if (active?.id !== _appliedConfig.active_model_id) changes.push(`Model → ${active.id}`);
  for (const [key, id] of Object.entries(_generationControls)) {
    if (!_settingsDescriptor?.generation_keys.includes(key)) continue;
    const value = _readControl(id);
    if (value !== saved?.[key]) changes.push(`${_el(id).labels?.[0]?.textContent || key}: ${saved?.[key] ?? 'Automatic'} → ${value ?? 'Automatic'}`);
  }
  const engine = _el('ov-engine')?.value || 'playground';
  const oldRuntime = { ..._appliedConfig.runtime, ...saved?.runtime_profiles?.[engine] };
  for (const [key, id] of Object.entries(_runtimeControls)) {
    if (!_settingsDescriptor?.runtime_keys.includes(key)) continue;
    const value = _readControl(id);
    if (value !== oldRuntime[key]) changes.push(`${_el(id).labels?.[0]?.textContent || key}: ${oldRuntime[key]} → ${value}`);
  }
  if (engine !== _appliedConfig.runtime.engine) changes.push(`Engine → ${engine}`);
  out.textContent = changes.length ? `Pending — ${changes.join('; ')}. Apply to activate.` : 'Model settings match the applied configuration. Client request settings take precedence.';
}
function _stageProfile(values, label) {
  for (const [key, value] of Object.entries(values)) {
    if (_generationControls[key]) _writeControl(_generationControls[key], value);
  }
  for (const [key, value] of Object.entries(values.runtime || {})) {
    if (_runtimeControls[key]) _writeControl(_runtimeControls[key], value);
  }
  _syncActiveModelFieldsFromForm();
  _dirty = true;
  _pendingChanges();
  _showBanner(`${label} prepared. Review the pending changes, then Apply.`, 'info');
  _fetchSettingsDescriptor();
}
async function _fetchSettingsDescriptor() {
  if (!_currentConfig) return;
  const ticket = ++_settingsRequest;
  _settingsDescriptor = null;
  _setBusy(_busy);
  const model = _currentConfig.active_model_id;
  const engine = _el('ov-engine')?.value || 'playground';
  const device = _el('ov-device')?.value || 'GPU';
  try {
    const query = new URLSearchParams({ model_id: model, engine, device });
    const response = await fetch(`/api/openvino/model-settings?${query}`);
    const data = await response.json();
    if (ticket !== _settingsRequest) return;
    if (!data.ok) throw new Error(data.error);
    _settingsDescriptor = data;
    for (const [key, id] of Object.entries(_generationControls)) {
      const el = _el(id);
      const group = el?.closest(key === 'enable_thinking_default' ? '.ov-row' : '.ov-unit');
      if (group) group.hidden = !data.generation_keys.includes(key);
    }
    for (const [key, id] of Object.entries(_runtimeControls)) {
      const el = _el(id);
      const group = el?.closest(el.type === 'checkbox' ? 'label' : '.ov-unit');
      if (group) group.hidden = !data.runtime_keys.includes(key);
    }
    _el('ov-top-k').min = engine === 'playground' ? '-1' : '0';
    const devices = _el('ov-device');
    for (const option of devices.options) option.hidden = !data.devices.includes(option.value);
    for (const id of ['ov-context-window', 'ov-max-tokens', 'ov-max-tokens-default']) {
      _el(id).max = data.native_context_window;
      _el(id).step = '1';
    }
    for (const [cap, id] of Object.entries({streaming:'ov-cap-streaming',tools:'ov-cap-tools',reasoning:'ov-cap-reasoning',vision:'ov-cap-vision',prompt_cache:'ov-cap-prompt-cache'})) {
      const el = _el(id);
      el.checked = !!data.capabilities[cap];
      el.disabled = true;
      el.closest('label').hidden = !data.capabilities[cap];
    }
    const entry = _currentConfig.models.find(m => m.id === model);
    if (entry) entry.capabilities = data.capabilities;
    _el('ov-tool-parser').closest('.ov-row').hidden = true;
    _el('ov-reasoning-parser').closest('.ov-row').hidden = true;
    const selected = _el('ov-profile-select').value;
    const choices = '<option value="">Custom / current settings</option>'
      + `<optgroup label="Playground factory settings">${data.factory_profiles.map(p => `<option value="factory:${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('')}</optgroup>`
      + (data.presets.length ? `<optgroup label="Saved for this model">${data.presets.map(p => `<option value="saved:${escapeHtml(p.name)}">${escapeHtml(p.name)}</option>`).join('')}</optgroup>` : '');
    _el('ov-profile-select').innerHTML = choices;
    if ([..._el('ov-profile-select').options].some(o => o.value === selected)) _el('ov-profile-select').value = selected;
    if (!_el('ov-profile-select').value) {
      const current = _readProfile();
      const matches = p => data.generation_keys.every(k => current[k] === p.values[k])
        && data.runtime_keys.every(k => current.runtime[k] === p.values.runtime?.[k]);
      const saved = data.presets.find(matches);
      const factory = data.factory_profiles.find(matches);
      if (saved) { _el('ov-profile-select').value = `saved:${saved.name}`; _el('ov-preset-name').value = saved.name; }
      else if (factory) _el('ov-profile-select').value = `factory:${factory.id}`;
    }

    _el('ov-profile-note').textContent = `Presets are saved for this model and engine. Blank sampling values use native defaults${Object.keys(data.inherited_generation).length ? ': ' + Object.entries(data.inherited_generation).map(([k,v]) => `${k}=${v}`).join(', ') : ''}. Prompts and tools stay with your client.`;
    _setBusy(_busy);
    _pendingChanges();
  } catch (err) {
    if (ticket === _settingsRequest) {
      _settingsDescriptor = null;
      _el('ov-btn-defaults').disabled = true;
      _showBanner(`Model settings unavailable: ${err.message}`, 'error');
    }
  }
}
async function _managePreset(action) {
  if (!_settingsDescriptor || _busy) return;
  const name = _el('ov-preset-name').value.trim();
  if (!name) { _showBanner('Enter a preset name.', 'warn'); _el('ov-preset-name').focus(); return; }
  if (action === 'delete' && !window.confirm(`Delete preset “${name}” for this model?`)) return;
  const values = _readProfile();
  for (const id of [...Object.values(_generationControls), ...Object.values(_runtimeControls)]) {
    const el = _el(id);
    if (el && !el.closest('[hidden]') && !el.reportValidity()) return;
  }
  _setBusy(true);
  try {
    const response = await fetch('/api/openvino/presets', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({
      model_id: _currentConfig.active_model_id, engine: _el('ov-engine').value, name, values,
      overwrite: action === 'overwrite', delete: action === 'delete',
    }) });
    const data = await response.json();
    if (!data.ok) throw new Error(data.error);
    await _fetchSettingsDescriptor();
    _el('ov-profile-select').value = action === 'delete' ? '' : `saved:${name}`;
    _showBanner(`Preset ${action === 'delete' ? 'deleted' : 'saved'}. Running settings are unchanged until Apply.`, 'info');
  } catch (err) { _showBanner(err.message, 'error'); }
  finally { _setBusy(false); _renderModelPicker(); }
}


function _updateRuntimeControls() {
  const fixed = _el('ov-preflight-policy')?.value === 'fixed';
  if (_el('ov-preflight-mb')) _el('ov-preflight-mb').closest('.ov-unit').hidden = !fixed;
  const native = _el('ov-engine')?.value !== 'genai';
  if (_el('ov-playground-settings')) _el('ov-playground-settings').hidden = !native;
  if (_catalog) {
    for (const model of _catalog.models) {
      model.selectable = native || (model.source !== 'hf' && !model.supports_vision);
      model.entry.capabilities.vision = native && model.supports_vision;
    }
    _renderModelPicker();
  }
}

function _renderModelPicker() {
  const select = _el('ov-model-select');
  if (!select || !_currentConfig) return;
  const activeId = _currentConfig.active_model_id;
  const rows = _catalog?.models || [];
  const experimental = _el('ov-show-experimental')?.checked;
  const eligible = rows.filter(m => m.source !== 'hf' || !m.suitability?.experimental || experimental || m.installed || m.id === activeId);
  const option = (m) => `<option value="${escapeHtml(m.id)}"${m.selectable === false ? ' disabled' : ''}>${escapeHtml(m.id)} · ${m.verified ? 'Verified here' : m.installed ? 'Downloaded' : m.source === 'hf' ? m.suitability.label : 'Download needed'}</option>`;
  const knownIds = new Set(rows.map((m) => m.id));
  const custom = (_currentConfig.models || []).filter((m) => !knownIds.has(m.id));
  const groups = [
    ['Downloaded models', eligible.filter(m => m.installed && m.selectable)],
    ['Available · Intel AI Playground', eligible.filter(m => m.source !== 'hf' && !m.installed && m.selectable)],
    ['Available · Hugging Face', eligible.filter(m => m.source === 'hf' && !m.installed && m.selectable && !m.suitability.experimental)],
    ['Experimental · Hugging Face', eligible.filter(m => m.source === 'hf' && !m.installed && m.selectable && m.suitability.experimental)],
    ['Requires another engine', eligible.filter(m => !m.selectable)],
  ];
  let html = groups.filter(([, ms]) => ms.length).map(([label, ms]) => `<optgroup label="${label}">${ms.map(option).join('')}</optgroup>`).join('');
  if (custom.length) html += `<optgroup label="Configured models">${custom.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.id)}</option>`).join('')}</optgroup>`;
  if (select.innerHTML !== html) select.innerHTML = html;
  select.value = activeId;
  select.disabled = _busy || !_catalog;

  const selected = rows.find((m) => m.id === activeId);
  const download = _catalog?.download || {};
  const downloading = download.state === 'downloading';
  const button = _el('ov-btn-download-model');
  if (button) {
    button.hidden = !selected || selected.installed || !selected.selectable;
    button.disabled = downloading || _busy;
    button.textContent = downloading ? 'Downloading…' : '↓ Download';
  }
  const hint = _el('ov-model-picker-hint');
  if (hint) {
    const details = selected
      ? `${selected.repo_id} · native context ${selected.native_context_window.toLocaleString()} · ${selected.verified ? 'Verified here' : selected.installed ? 'Downloaded · unverified' : 'Download needed'}${selected.source === 'hf' ? ` · ${selected.variant} · ${(selected.download_bytes / 1073741824).toFixed(2)} GB download · ${selected.verified ? 'Completed an answer with this revision and saved settings; memory use still depends on the request.' : selected.suitability.explanation}${selected.update_available ? ' · New revision available; installed files preserved.' : ''}` : ''}`
      : 'Choose an Intel AI Playground model or keep a configured custom model.';
    hint.textContent = `${details}${_catalog?.warning ? ` · ${_catalog.warning}` : ''}`;
  }
  const progress = _el('ov-model-download-status');
  if (progress) {
    progress.hidden = !download.model_id;
    progress.textContent = download.model_id ? `${download.model_id}: ${download.message || download.state}` : '';
    progress.classList.toggle('ov-banner-error', download.state === 'error');
  }
  const bar = _el('ov-model-download-progress');
  if (bar) {
    bar.hidden = !downloading;
    if (download.bytes_total > 0) { bar.max = download.bytes_total; bar.value = Math.min(download.bytes_completed || 0, download.bytes_total); }
    else bar.removeAttribute('value');
  }
  _el('ov-btn-cancel-download').hidden = !downloading;
  const hf = _catalog?.hf;
  if (hf) {
    const refresh = hf.refresh;
    _el('ov-btn-refresh-models').disabled = refresh.state === 'refreshing';
    _el('ov-catalog-status').textContent = refresh.state === 'refreshing'
      ? `Checking HF${refresh.total ? ` · ${refresh.current}/${refresh.total} repositories · ${refresh.found} exports` : '…'}`
      : refresh.state === 'error' ? refresh.message
      : `${hf.stale ? 'HF list needs refresh' : 'HF list updated ' + new Date(hf.updated_at * 1000).toLocaleString()}${refresh.state === 'complete' ? ' · ' + refresh.message : ''}`;
  }

}

// Refresh once stale while the app is open, even when another tool tab is active.
export function initOpenVinoCatalogRefresh() {
  if (_dailyCatalogTimer) return;
  const check = async () => {
    if (document.hidden) return;
    try { await fetch('/api/openvino/models/refresh', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({force:false})}); }
    catch (_) { /* Cached catalog remains usable offline. */ }
  };
  check();
  _dailyCatalogTimer = setInterval(check, 60 * 60 * 1000);
  document.addEventListener('visibilitychange', check);
}

async function _fetchModelCatalog() {
  if (_catalogFetching) return;
  _catalogFetching = true;
  try {
    const response = await fetch('/api/openvino/models');
    const data = await response.json();
    if (!data.ok) throw new Error(data.error || 'Cannot read model list');
    _catalog = data;
    _catalogAt = Date.now();
    _renderModelPicker();

  } catch (err) {
    const hint = _el('ov-model-picker-hint');
    if (hint) hint.textContent = `Model list unavailable: ${err.message}. Click Refresh models to retry.`;
  } finally { _catalogFetching = false; }
}

function _chooseCatalogModel(id) {
  if (_busy || !_currentConfig) return;
  const row = _catalog?.models.find((m) => m.id === id);
  if (row && !row.selectable) return;
  if (row && !_currentConfig.models.some((m) => m.id === id)) {
    _currentConfig.models.push(JSON.parse(JSON.stringify(row.entry)));
  }
  _selectActiveModelId(id);
  _showBanner(`${id} selected.${row && !row.installed ? ' Download it first.' : ''} Click Save & Apply to switch the server; any resident model is unloaded first.`, 'info');
}

async function _downloadSelectedModel() {
  if (_busy || !_currentConfig) return;
  _setBusy(true);
  _renderModelPicker();
  try {
    const response = await fetch('/api/openvino/models/download', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_id: _currentConfig.active_model_id }),
    });
    const data = await response.json();
    if (!data.ok) throw new Error(data.error || 'Cannot start download');
    await _fetchModelCatalog();
  } catch (err) {
    _showBanner(`Download failed: ${err.message}`, 'error');
  } finally {
    _setBusy(false);
    _renderModelPicker();
  }
}

function _el(id) {
  return document.getElementById(id);
}

function _log(msg, kind = 'info') {
  try {
    if (typeof window.logConsole === 'function') {
      window.logConsole(msg, kind);
    }
  } catch (_) { /* ignore */ }
}

function _showBanner(text, tone = 'info') {
  const b = _el('ov-banner');
  if (!b) return;
  if (!text) {
    b.hidden = true;
    b.textContent = '';
    b.className = 'ov-banner';
    return;
  }
  b.hidden = false;
  b.textContent = text;
  b.className = 'ov-banner'
    + (tone === 'error' ? ' ov-banner-error' : tone === 'warn' ? ' ov-banner-warn' : '');
}

function _formatUptime(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (s <= 0) return '0s';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  if (h > 0) return `${h}h ${m}m ${rem}s`;
  if (m > 0) return `${m}m ${rem}s`;
  return `${rem}s`;
}

function _updateComputedUrls() {
  const host = (_el('ov-host')?.value || '127.0.0.1').trim() || '127.0.0.1';
  const port = (_el('ov-port')?.value || '2431').trim() || '2431';
  const baseEl = _el('ov-base-url');
  const modelsEl = _el('ov-model-source-url');
  if (baseEl) baseEl.value = `http://${host}:${port}/v1`;
  if (modelsEl) modelsEl.value = `http://${host}:${port}/v1/models`;
}

async function _copyText(text, btnEl) {
  if (!text) return;
  const orig = btnEl ? btnEl.textContent : '';
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    if (btnEl) {
      btnEl.textContent = '✓ Copied';
      setTimeout(() => { btnEl.textContent = orig; }, 1200);
    }
  } catch (err) {
    _showBanner(`Clipboard copy failed: ${err}`, 'error');
  }
}

function _syncActiveModelFieldsFromForm() {
  if (!_currentConfig || !Array.isArray(_currentConfig.models)) return;
  const activeId = _currentConfig.active_model_id;
  const entry = _currentConfig.models.find((m) => m.id === activeId) || _currentConfig.models[0];
  if (!entry) return;

  const engine = _el('ov-engine')?.value || 'playground';
  entry.runtime_profiles ||= {};
  entry.runtime_profiles[engine] = Object.fromEntries(Object.entries(_runtimeControls).map(([key,id]) => [key, _readControl(id)]));
  const cw = parseInt(_el('ov-context-window')?.value || '40960', 10);
  const mt = parseInt(_el('ov-max-tokens')?.value || '4096', 10);
  const mtd = parseInt(_el('ov-max-tokens-default')?.value || '1024', 10);
  const temp = parseFloat(_el('ov-temperature')?.value || '0.7');
  const topP = parseFloat(_el('ov-top-p')?.value || '0.95');
  const mPath = (_el('ov-model-path')?.value || '').trim();

  if (Number.isFinite(cw) && cw > 0) entry.context_window = cw;
  if (Number.isFinite(mt) && mt > 0) entry.max_tokens = mt;
  if (Number.isFinite(mtd) && mtd > 0) entry.max_tokens_default = mtd;
  for (const key of ['temperature_default', 'top_p_default', 'top_k_default', 'repetition_penalty_default']) {
    entry[key] = _readControl(_generationControls[key]);
  }
  if (mPath) entry.model_path = mPath;
  entry.tool_parser = (_el('ov-tool-parser')?.value || entry.tool_parser || 'hermes3').trim();
  entry.enable_thinking_default = !!_el('ov-enable-thinking')?.checked;

}

function _populateActiveModelFields(entry) {
  if (!entry) return;
  const setVal = (id, v) => { const el = _el(id); if (el && v !== undefined && v !== null) el.value = String(v); };
  const setChk = (id, v) => { const el = _el(id); if (el) el.checked = !!v; };

  setVal('ov-context-window', entry.context_window ?? 40960);
  setVal('ov-max-tokens', entry.max_tokens ?? 4096);
  setVal('ov-max-tokens-default', entry.max_tokens_default ?? 1024);
  for (const key of ['temperature_default', 'top_p_default', 'top_k_default', 'repetition_penalty_default']) _writeControl(_generationControls[key], entry[key]);
  const engine = _el('ov-engine')?.value || 'playground';
  _viewEngine = engine;
  const runtime = entry.runtime_profiles?.[engine] || _currentConfig.runtime;
  for (const [key,id] of Object.entries(_runtimeControls)) _writeControl(id, runtime[key]);
  _el('ov-profile-select').value = '';
  _fetchSettingsDescriptor();
  setVal('ov-tool-parser', entry.tool_parser || 'hermes3');
  if (entry.model_path) setVal('ov-model-path', entry.model_path);
  setChk('ov-enable-thinking', entry.enable_thinking_default);

  const caps = entry.capabilities || {};
  setChk('ov-cap-streaming', caps.streaming !== false);
  setChk('ov-cap-tools', caps.tools !== false);
  setChk('ov-cap-reasoning', caps.reasoning !== false);
  setChk('ov-cap-vision', !!caps.vision);
  setChk('ov-cap-prompt-cache', caps.prompt_cache !== false);
}

function _selectActiveModelId(id) {
  if (_busy) return;
  if (!_currentConfig || !Array.isArray(_currentConfig.models)) return;
  _syncActiveModelFieldsFromForm();
  _currentConfig.active_model_id = id;
  const entry = _currentConfig.models.find((m) => m.id === id);
  if (entry) _populateActiveModelFields(entry);
  _dirty = true;
  _renderModelPicker();
}

function _hydrateFormFromConfig(cfg) {
  if (!cfg) return;
  _currentConfig = _clone(cfg);
  _appliedConfig = _clone(cfg);

  const setVal = (id, v) => { const el = _el(id); if (el && v !== undefined && v !== null) el.value = String(v); };
  const setChk = (id, v) => { const el = _el(id); if (el) el.checked = !!v; };

  setVal('ov-host', cfg.host || '127.0.0.1');
  setVal('ov-port', cfg.port ?? 2431);
  setVal('ov-api-key', cfg.api_key ?? 'openvino-local');
  setChk('ov-enforce-apikey', cfg.enforce_api_key);
  setVal('ov-timeout-ms', cfg.timeout_ms ?? 300000);

  const rt = cfg.runtime || {};
  setVal('ov-model-path', rt.model_path || '');
  setVal('ov-cache-dir', rt.cache_dir || '');
  setVal('ov-device', rt.device || 'GPU');
  setVal('ov-kv-precision', rt.kv_cache_precision || 'u4');
  setVal('ov-preflight-mb', rt.preflight_min_mb ?? 8192);
  setVal('ov-engine', rt.engine || 'playground');
  setVal('ov-preflight-policy', rt.preflight_policy || 'playground');
  setVal('ov-rest-workers', rt.ovms_rest_workers ?? 4);
  setVal('ov-cache-size', rt.ovms_cache_size_gb ?? 0);
  setVal('ov-max-seqs', rt.ovms_max_num_seqs ?? 256);
  setVal('ov-batch-tokens', rt.ovms_max_num_batched_tokens ?? 0);
  setVal('ov-reasoning-parser', rt.ovms_reasoning_parser ?? 'qwen3');
  setChk('ov-prefix-cache', rt.ovms_enable_prefix_caching !== false);
  setChk('ov-split-fuse', rt.ovms_dynamic_split_fuse !== false);
  setChk('ov-auto-load-start', rt.auto_load_on_start);
  setChk('ov-auto-load-request', rt.auto_load_on_request !== false);
  setChk('ov-sse-keepalive', rt.enable_sse_keepalive !== false);
  setVal('ov-overlay-path', rt.runtime_overlay_path ?? '');

  const cage = cfg.cage || {};
  setVal('ov-cage-backend', cage.backend || 'auto');
  setVal('ov-memory-max', cage.memory_max || '9G');
  setVal('ov-memory-high', cage.memory_high || '8G');
  setVal('ov-memory-swap-max', cage.memory_swap_max ?? '0');
  setVal('ov-oom-score-adjust', cage.oom_score_adjust ?? 1000);
  setVal('ov-rss-cap-mb', cage.rss_cap_mb ?? 11500);
  setChk('ov-watchdog-floor', cage.watchdog_floor_enabled);
  setVal('ov-watchdog-min-mb', cage.watchdog_min_mb ?? 192);

  const models = Array.isArray(cfg.models) ? cfg.models : [];
  const active = models.find((m) => m.id === cfg.active_model_id) || models[0];
  if (active) _populateActiveModelFields(active);
  _updateRuntimeControls();

  _renderModelPicker();
  _updateComputedUrls();
  _formHydrated = true;
  _dirty = false;
}

function _collectConfigFromForm() {
  _syncActiveModelFieldsFromForm();
  const host = (_el('ov-host')?.value || '127.0.0.1').trim();
  const port = parseInt(_el('ov-port')?.value || '2431', 10);
  const apiKey = (_el('ov-api-key')?.value ?? '').trim();
  const enforceKey = !!_el('ov-enforce-apikey')?.checked;
  const timeoutMs = parseInt(_el('ov-timeout-ms')?.value || '300000', 10);

  const modelPath = (_el('ov-model-path')?.value || '').trim();
  const cacheDir = (_el('ov-cache-dir')?.value || '').trim();
  const device = (_el('ov-device')?.value || 'GPU').trim();
  const kvPrecision = (_el('ov-kv-precision')?.value || 'u4').trim();
  const preflightMb = parseInt(_el('ov-preflight-mb')?.value || '8192', 10);
  const autoLoadStart = !!_el('ov-auto-load-start')?.checked;
  const autoLoadReq = !!_el('ov-auto-load-request')?.checked;
  const sseKeepalive = !!_el('ov-sse-keepalive')?.checked;
  const overlayPath = (_el('ov-overlay-path')?.value || '').trim();

  const cageBackend = (_el('ov-cage-backend')?.value || 'auto').trim();
  const memMax = (_el('ov-memory-max')?.value || '9G').trim();
  const memHigh = (_el('ov-memory-high')?.value || '8G').trim();
  const memSwap = (_el('ov-memory-swap-max')?.value ?? '0').trim();
  const oomScore = parseInt(_el('ov-oom-score-adjust')?.value || '1000', 10);
  const rssCap = parseInt(_el('ov-rss-cap-mb')?.value || '11500', 10);
  const watchdogFloor = !!_el('ov-watchdog-floor')?.checked;
  const watchdogMinMb = parseInt(_el('ov-watchdog-min-mb')?.value || '192', 10);

  const models = (_currentConfig && Array.isArray(_currentConfig.models) && _currentConfig.models.length)
    ? _currentConfig.models
    : [{ id: 'Qwen3-8B-int4-ov', model_path: modelPath }];
  const activeModelId = (_currentConfig && _currentConfig.active_model_id) || models[0].id;
  const appliedModels = models.map(m => m.id === activeModelId ? m : (_appliedConfig?.models.find(saved => saved.id === m.id) || _catalog?.models.find(row => row.id === m.id)?.entry || m));

  return {
    host,
    port,
    api_key: apiKey,
    enforce_api_key: enforceKey,
    timeout_ms: timeoutMs,
    active_model_id: activeModelId,
    models: appliedModels,
    context_window: parseInt(_el('ov-context-window')?.value || '40960', 10),
    max_tokens: parseInt(_el('ov-max-tokens')?.value || '4096', 10),
    max_tokens_default: parseInt(_el('ov-max-tokens-default')?.value || '1024', 10),
    enable_thinking_default: !!_el('ov-enable-thinking')?.checked,
    temperature_default: _readControl('ov-temperature'),
    top_p_default: _readControl('ov-top-p'),
    top_k_default: _readControl('ov-top-k'),
    repetition_penalty_default: _readControl('ov-repetition-penalty'),
    runtime: {
      model_path: modelPath,
      cache_dir: cacheDir,
      device,
      kv_cache_precision: kvPrecision,
      preflight_min_mb: preflightMb,
      engine: _el('ov-engine')?.value || 'playground',
      preflight_policy: _el('ov-preflight-policy')?.value || 'playground',
      ovms_rest_workers: parseInt(_el('ov-rest-workers')?.value || '4', 10),
      ovms_cache_size_gb: parseInt(_el('ov-cache-size')?.value || '0', 10),
      ovms_max_num_seqs: parseInt(_el('ov-max-seqs')?.value || '256', 10),
      ovms_max_num_batched_tokens: parseInt(_el('ov-batch-tokens')?.value || '0', 10),
      ovms_reasoning_parser: (_el('ov-reasoning-parser')?.value || '').trim(),
      ovms_enable_prefix_caching: !!_el('ov-prefix-cache')?.checked,
      ovms_dynamic_split_fuse: !!_el('ov-split-fuse')?.checked,
      auto_load_on_start: autoLoadStart,
      auto_load_on_request: autoLoadReq,
      enable_sse_keepalive: sseKeepalive,
      sse_keepalive_interval_s: 5.0,
      runtime_overlay_path: overlayPath,
    },
    cage: {
      backend: cageBackend,
      memory_max: memMax,
      memory_high: memHigh,
      memory_swap_max: memSwap,
      oom_score_adjust: oomScore,
      rss_cap_mb: rssCap,
      watchdog_floor_enabled: watchdogFloor,
      watchdog_min_mb: watchdogMinMb,
    },
  };
}

function _paintActivity() {
  if (!_el('ov-work-phase') || !_latestActivity) return;
  const a = Date.now() - _activityReceivedAt > 5000 ? {phase:'unknown',detail:'No fresh status received for more than 5 seconds. Model progress cannot be confirmed.'} : _latestActivity;
  const ticking = ['loading','waiting','reasoning','answering','tools','unloading'].includes(a.phase);
  const elapsed = (a.elapsed_s || 0) + (ticking ? (Date.now() - _activityReceivedAt) / 1000 : 0);
  const names = {stopped:'Stopped',loading:'Loading model',loaded:'Loaded · reply not verified',ready:'Ready · reply verified',waiting:'Waiting for model output',reasoning:'Receiving reasoning',answering:'Receiving answer',tools:'Receiving tool request',unloading:'Releasing model memory',unloaded:'No model loaded',failed:'Failed',unknown:'Progress unknown'};
  _el('ov-work-phase').textContent = names[a.phase] || 'Progress unknown';
  _el('ov-work-elapsed').textContent = ticking ? `${_formatUptime(elapsed)} elapsed` : '';
  _el('ov-work-phase').dataset.phase = a.phase;
  _el('ov-work-detail').textContent = a.phase === 'waiting' ? `No output received for ${_formatUptime(elapsed)}. The backend has not exposed its internal progress.${elapsed >= 30 ? ' Progress cannot be confirmed; this may be stalled. Use Stop & release GPU to end it.' : ''}` : a.detail;
  if (a.release_pending) _el('ov-work-detail').textContent += ' Keep loaded is off; unload waits for this request to finish.';
  const last = a.last_request;
  _el('ov-work-detail').hidden = ['ready', 'stopped', 'unloaded'].includes(a.phase) && !a.release_pending;
  _el('ov-work-last').textContent = last ? `Last: ${last.message} · ${last.duration_s}s${last.finish_reason === 'length' ? ' · output limit reached' : ''}` : '';
  _el('ov-work-last').hidden = !last;
  _el('ov-work-last').setAttribute('data-help-text', last ? `Request ${last.id}: ${last.answer_chars} answer characters, ${last.reasoning_chars || 0} reasoning characters. ${last.message}` : 'No completed request recorded.');
}

function _paintStatus(data) {
  if (!data || typeof data !== 'object') return;
  _lastStatus = data;

  const srv = data.server || {};
  const mdl = data.model || {};
  const cfg = data.config || {};
  _latestActivity = !srv.running ? {phase:'stopped',detail:'API stopped. No model is loaded by this server.'}
    : mdl.activity ? {...mdl.activity, release_pending:mdl.release_pending} : {phase:'unknown',detail:'The server has not supplied model activity. Availability does not establish progress.'};
  _activityReceivedAt = Date.now();
  _paintActivity();
  if (_el('ov-keep-loaded') && !_keepChanging) _el('ov-keep-loaded').checked = !!mdl.keep_loaded;


  if (!_formHydrated && cfg.port) {
    _hydrateFormFromConfig(cfg);
  }

  // Level 1: Server Up / Down + Stray Detection
  const sState = String(srv.state || 'down').toLowerCase();
  const strays = Array.isArray(srv.stray_processes) ? srv.stray_processes : [];
  const conflict = srv.port_conflict || strays.find((s) => s && s.holds_port) || null;
  const sBadge = _el('ov-server-badge');
  if (sBadge) {
    if (!srv.running && conflict) {
      sBadge.className = 'ov-badge ov-badge-starting';
      sBadge.innerHTML = `<span class="ov-badge-dot" aria-hidden="true"></span><span>STRAY ON :${escapeHtml(String(srv.port || 2431))} (PID ${escapeHtml(String(conflict.pid))})</span>`;
    } else {
      sBadge.className = `ov-badge ov-badge-${sState}`;
      sBadge.innerHTML = `<span class="ov-badge-dot" aria-hidden="true"></span><span>SERVER ${escapeHtml(sState.toUpperCase())}</span>`;
    }
  }

  const setTxt = (id, v) => { const el = _el(id); if (el) el.textContent = String(v); };
  if (srv.pid) {
    setTxt('ov-stat-pid', String(srv.pid));
  } else if (conflict) {
    setTxt('ov-stat-pid', `${conflict.pid} (stray · ${conflict.rss_mb} MB)`);
  } else {
    setTxt('ov-stat-pid', '—');
  }
  setTxt('ov-stat-uptime', srv.running ? _formatUptime(srv.uptime_s) : '—');
  setTxt('ov-stat-port', `${srv.host || '127.0.0.1'}:${srv.port || 2431}`);

  const cage = srv.cage || cfg.cage || {};
  setTxt(
    'ov-stat-cage',
    `${cage.backend || 'systemd_scope'} (Max ${cage.memory_max || '9G'} · High ${cage.memory_high || '8G'} · Swap ${cage.memory_swap_max ?? '0'} · OOM ${cage.oom_score_adjust ?? 1000})`,
  );

  const srvBtn = _el('ov-btn-server-toggle');
  if (srvBtn) {
    srvBtn.disabled = _busy;
    if (srv.running) {
      srvBtn.textContent = '■ Stop Server';
      srvBtn.className = 'ov-btn ov-btn-danger';
      srvBtn.setAttribute('data-help-title', 'Stop OpenVINO Server');
      srvBtn.setAttribute('data-help-text', 'Unload any resident model and stop the caged uvicorn server process.');
    } else if (conflict) {
      srvBtn.textContent = `▶ Kill Stray & Start`;
      srvBtn.className = 'ov-btn ov-btn-success';
      srvBtn.setAttribute('data-help-title', 'Kill Stray Process & Start Server');
      srvBtn.setAttribute('data-help-text', `Terminate stray process PID ${conflict.pid} holding port ${srv.port || 2431} and launch the caged OpenVINO server.`);
    } else {
      srvBtn.textContent = '▶ Start Server';
      srvBtn.className = 'ov-btn ov-btn-success';
      srvBtn.setAttribute('data-help-title', 'Start OpenVINO Server');
      srvBtn.setAttribute('data-help-text', 'Spawn the uvicorn server inside the configured memory cage (starts in Model Cold state by default).');
    }
  }

  const killBtn = _el('ov-btn-kill-stray');
  if (killBtn) {
    const actionableStrays = strays.filter((s) => s.holds_port || s.kind === 'vinoapi' || s.kind === 'worker' || s.kind === 'ovms');
    killBtn.disabled = _busy;
    if (actionableStrays.length > 0) {
      const pidsLabel = actionableStrays.map((s) => s.pid).join(', ');
      killBtn.textContent = `🧹 Kill Stray (PID ${pidsLabel})`;
      killBtn.className = 'ov-btn ov-btn-danger';
      killBtn.hidden = false;
    } else {
      killBtn.textContent = '🧹 Sweep Strays';
      killBtn.className = 'ov-btn';
      killBtn.hidden = false;
    }
  }

  // Level 2: Model Hot / Cold
  const mState = String(mdl.state || 'cold').toLowerCase();
  const mBadge = _el('ov-model-badge');
  if (mBadge) {
    mBadge.className = `ov-badge ov-badge-${mState}`;
    mBadge.innerHTML = `<span class="ov-badge-dot" aria-hidden="true"></span><span>MODEL ${escapeHtml(mState.toUpperCase())}${mdl.generating ? ' · GENERATING' : ''}</span>`;
  }

  const stopWork = _el('ov-btn-stop-work');
  if (stopWork) stopWork.disabled = !srv.running || _stoppingWork;
  const active = mdl.request_active || mdl.generating;
  const elapsed = _formatUptime(mdl.request_elapsed_s || 0);
  setTxt('ov-generation-status', active
    ? `${mdl.release_pending ? 'Keep loaded off: unloads after this request. ' : ''}${mdl.reply_updates ? 'Generating reply' : 'Processing request · waiting for reply'} · ${elapsed} elapsed${mdl.reply_updates ? ` · ${mdl.reply_updates} reply updates · last update ${_formatUptime(mdl.last_reply_age_s)} ago` : ''}. Stop & release GPU ends this work.`
    : mdl.hot ? 'Idle · model loaded; no active request. Keep loaded controls whether it stays after a reply.'
    : 'No model loaded by this server.');

  setTxt('ov-stat-model-id', mdl.loaded_model_id || (mState === 'hot' ? cfg.active_model_id : 'None (Cold)'));
  const copyModel = _el('ov-copy-loaded-model');
  if (copyModel) {
    copyModel.dataset.modelId = mdl.hot ? (mdl.loaded_model_id || '') : '';
    copyModel.disabled = !copyModel.dataset.modelId;
  }
  setTxt('ov-stat-engine', `${(mdl.engine || cfg.runtime?.engine) === 'playground' ? 'Playground OVMS' : 'Python GenAI'}${mdl.engine_pid ? ` · PID ${mdl.engine_pid}` : ''}`);
  setTxt('ov-stat-device-kv', `${mdl.device || cfg.runtime?.device || 'GPU'} · KV ${mdl.kv_cache_precision || cfg.runtime?.kv_cache_precision || 'u4'}`);
  const rss = Number(mdl.process_rss_mb || 0);
  const delta = Number(mdl.model_mem_used_mb || 0);
  setTxt('ov-stat-mem-used', srv.running ? `${rss} MB${mdl.hot ? ` (+${delta} MB model)` : ' (idle)'}` : '0 MB');
  setTxt(
    'ov-stat-mem-avail',
    `${mdl.mem_available_mb ?? '—'} MB / ${mdl.mem_total_mb ?? '—'} MB${cfg.runtime?.preflight_policy === 'fixed' ? ` (minimum ${cfg.runtime.preflight_min_mb} MB)` : ' (Playground: no fixed RAM gate)'}`,
  );
  setTxt('ov-stat-load-time', mdl.load_duration_s != null ? `${mdl.load_duration_s}s` : '—');

  const mdlBtn = _el('ov-btn-model-toggle');
  if (mdlBtn) {
    mdlBtn.disabled = _busy || mdl.request_active || mState === 'loading' || mState === 'unloading';
    if (mdl.hot) {
      mdlBtn.textContent = '▼ Unload model';
      mdlBtn.className = 'ov-btn ov-btn-danger';
      mdlBtn.setAttribute('data-help-title', 'Unload Model from RAM/VRAM');
      mdlBtn.setAttribute('data-help-text', 'Free memory held by the model while leaving the API available. With auto-load enabled, the next client request can load it again.');
    } else {
      mdlBtn.textContent = mState === 'loading' ? '⏳ Loading Model…' : '▲ Load model';
      mdlBtn.className = 'ov-btn ov-btn-primary';
      mdlBtn.setAttribute('data-help-title', 'Load Model into RAM/VRAM');
      mdlBtn.setAttribute('data-help-text', 'Prepare the selected model for requests, starting the API if needed. This can take time and use substantial memory; loaded weights do not prove that a reply works.');
    }
  }

  // Stray port conflict, orphaned ovms, or crash warning
  if (srv.last_error) {
    _showBanner(srv.last_error, 'error');
  } else if (!srv.running && conflict) {
    _showBanner(
      `Stray process holding port ${srv.port || 2431}: PID ${conflict.pid} (${conflict.kind} · ${conflict.rss_mb} MB · ${conflict.cmdline}). Click "▶ Kill Stray & Start" or "🧹 Kill Stray" to reclaim the port.`,
      'warn',
    );
  } else if (Array.isArray(srv.orphaned_ovms) && srv.orphaned_ovms.length > 0) {
    const p = srv.orphaned_ovms.map((o) => `PID ${o.pid} (${o.rss_mb} MB)`).join(', ');
    _showBanner(
      `Warning: Intel AI Playground ovms process detected (${p}). Click "🧹 Kill Stray" or close AI Playground before loading an 8B model to avoid OOM.`,
      'warn',
    );
  }

  // Logs
  const logPre = _el('ov-log-output');
  if (logPre && Array.isArray(data.logs)) {
    const text = data.logs.length
      ? data.logs.join('\n')
      : 'Server is Down. Click "▶ Start Server" to launch the caged uvicorn worker.';
    if (logPre.textContent !== text) {
      logPre.textContent = text;
      logPre.scrollTop = logPre.scrollHeight;
    }
  }
  _renderModelPicker();
}

async function _pollStatus() {
  if (!document.body.classList.contains('openvino-tab-active') || _statusInFlight) return;
  _statusInFlight = true;
  try {
    const res = await fetch('/admin/status');
    const data = await res.json();
    _paintStatus(data);
    const evidence = data.model?.activity?.last_request;
    const newEvidence = evidence?.status === 'completed' && evidence.id !== _catalogEvidence;
    if (newEvidence) _catalogEvidence = evidence.id;
    if (newEvidence || !_catalog || _catalog.download?.state === 'downloading' || _catalog.hf?.refresh.state === 'refreshing' || Date.now() - _catalogAt > 60000) await _fetchModelCatalog();
  } catch (err) {
    _latestActivity = {phase:'unknown',detail:'Cannot reach the app for model status. No progress can be confirmed.'};
    _activityReceivedAt = Date.now();
    _paintActivity();
    _log(`openvino poll failed: ${err}`, 'error');
  } finally { _statusInFlight = false; }
}

async function _killStray() {
  if (_busy) return;
  _setBusy(true);
  _showBanner('Scanning and terminating stray vinoapi / worker / port-holding processes…', 'info');
  _paintStatus(_lastStatus);
  try {
    const res = await fetch('/admin/kill-stray', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ include_ovms: true }),
    });
    const data = await res.json();
    _paintStatus(data);
    const killed = Array.isArray(data.killed) ? data.killed : [];
    if (!data.ok) {
      _showBanner(data.error || 'Failed to terminate stray process', 'error');
    } else if (killed.length > 0) {
      const desc = killed.map((k) => `PID ${k.pid} (${k.kind}, ${k.rss_mb} MB)`).join(', ');
      _showBanner(`Terminated stray process(es): ${desc}. Port ${data.server?.port || 2431} is now free.`, 'info');
      _log(`openvino: killed stray process(es) ${desc}`, 'ok');
    } else {
      _showBanner('No stray vinoapi / worker processes found.', 'info');
    }
  } catch (err) {
    _showBanner(`Failed to kill stray processes: ${err}`, 'error');
  } finally {
    _setBusy(false);
    _paintStatus(_lastStatus);
  }
}

async function _toggleServer() {
  if (_busy) return;
  _setBusy(true);
  const isRunning = !!(_lastStatus && _lastStatus.server && _lastStatus.server.running);
  const endpoint = isRunning ? '/admin/stop' : '/admin/start';
  _showBanner(
    isRunning
      ? 'Stopping OpenVINO server…'
      : 'Starting caged OpenVINO server (automatically reclaiming port if held by stray process)…',
    'info',
  );
  _paintStatus(_lastStatus);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kill_stray: true }),
    });
    const data = await res.json();
    _paintStatus(data);
    if (!data.ok) {
      _showBanner(data.error || 'Server action failed', 'error');
      _log(`openvino: ${data.error || 'server action failed'}`, 'error');
    } else {
      _showBanner(
        isRunning
          ? 'Server stopped (Down).'
          : `Server started on ${data.server?.host}:${data.server?.port} (PID ${data.server?.pid}, Model ${data.model?.state?.toUpperCase()}).`,
        'info',
      );
      _log(`openvino: ${isRunning ? 'stopped' : 'started'}`, 'ok');
    }
  } catch (err) {
    _showBanner(`Request failed: ${err}`, 'error');
  } finally {
    _setBusy(false);
    _paintStatus(_lastStatus);
  }
}

async function _toggleModel() {
  if (_busy) return;
  if (!_lastStatus?.server?.running) {
    await _toggleServer();
    if (!_lastStatus?.server?.running) return;
  }
  if (!_lastStatus?.server?.running) {
    _showBanner('Server is Down — start the server first before loading a model.', 'warn');
    return;
  }
  const isHot = !!(_lastStatus && _lastStatus.model && _lastStatus.model.hot);
  if (!isHot && _dirty) {
    _showBanner('Click Save & Apply before loading the selected model.', 'warn');
    return;
  }
  _setBusy(true);
  const endpoint = isHot ? '/admin/unload' : '/admin/load';
  const payload = isHot
    ? {}
    : {
        model_id: _currentConfig?.active_model_id || undefined,
        model_path: (_el('ov-model-path')?.value || '').trim() || undefined,
        device: (_el('ov-device')?.value || 'GPU').trim(),
        kv_cache_precision: (_el('ov-kv-precision')?.value || 'u4').trim(),
      };
  _showBanner(
    isHot
      ? 'Unloading model from RAM/VRAM…'
      : `Loading model ${payload.model_id || ''} on ${payload.device}…`,
    'info',
  );
  _paintStatus(_lastStatus);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    _paintStatus(data);
    if (!data.ok) {
      _showBanner(data.error || 'Model operation failed', 'error');
      _log(`openvino model op: ${data.error}`, 'error');
    } else {
      _showBanner(
        isHot
          ? `Model unloaded (Cold). MemAvailable: ${data.model?.mem_available_mb} MB.`
          : `Model ${data.model?.loaded_model_id} is now HOT (${data.model?.load_duration_s}s, RSS ${data.model?.process_rss_mb} MB).`,
        'info',
      );
      _log(`openvino: model ${isHot ? 'unloaded' : 'loaded'}`, 'ok');
    }
  } catch (err) {
    _showBanner(`Model action failed: ${err}`, 'error');
  } finally {
    _setBusy(false);
    _paintStatus(_lastStatus);
  }
}

async function _saveAndApply() {
  if (!_settingsDescriptor) { _showBanner('Wait for the model settings to load.', 'warn'); return; }
  for (const el of document.querySelectorAll('#openvinoPanel input, #openvinoPanel select')) {
    if (!el.disabled && !el.closest('[hidden]') && !el.reportValidity()) return;
  }
  if (_busy) return;
  const selected = _catalog?.models.find((m) => m.id === _currentConfig?.active_model_id);
  if (selected && !selected.installed) {
    _showBanner('Download the selected model before applying it to the server.', 'warn');
    return;
  }
  _setBusy(true);
  _renderModelPicker();
  const cfgPayload = _collectConfigFromForm();
  // Browsing the picker must not advertise undownloaded HF drafts to clients.
  const configuredIds = new Set((_appliedConfig?.models || []).map(m => m.id));
  cfgPayload.models = cfgPayload.models.filter(m => {
    const candidate = _catalog?.models.find(row => row.id === m.id);
    return candidate?.source !== 'hf' || candidate.installed || configuredIds.has(m.id);
  });
  const wasUp = !!(_lastStatus && _lastStatus.server && _lastStatus.server.running);
  _showBanner(
    wasUp
      ? 'Applying settings; runtime changes may reload the model…'
      : 'Saving OpenVINO configuration…',
    'info',
  );
  try {
    const res = await fetch('/admin/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: cfgPayload, restart: true }),
    });
    const data = await res.json();
    if (!data.ok) {
      _showBanner(data.error || 'Failed to save configuration', 'error');
      _log(`openvino config error: ${data.error}`, 'error');
      return;
    }
    if (data.config) {
      const drafts = _clone(_currentConfig.models);
      _hydrateFormFromConfig(data.config);
      _currentConfig.models = _currentConfig.models.map(m => m.id === _currentConfig.active_model_id ? m : (drafts.find(d => d.id === m.id) || m));
    }
    await _fetchModelCatalog();
    _paintStatus(data);
    _showBanner(
      wasUp
        ? `Settings applied on ${data.server?.host}:${data.server?.port} (PID ${data.server?.pid}).`
        : `Settings saved (Base URL: ${data.server?.base_url}).`,
      'info',
    );
    _log('openvino: settings saved and applied', 'ok');
  } catch (err) {
    _showBanner(`Failed to save configuration: ${err}`, 'error');
  } finally {
    _setBusy(false);
    _paintStatus(_lastStatus);
    _renderModelPicker();
  }
}

async function _sendQuickTest() {
  if (_busy) return;
  const reply = _el('ov-test-reply');
  const reasoning = _el('ov-test-reasoning');
  reply.hidden = false; reply.textContent = 'Waiting for model output…';
  reasoning.hidden = true; reasoning.textContent = '';
  let answer = '', thoughts = '', done = false, failure = '', finishReason = '';
  _setBusy(true);
  try {
    const response = await fetch('/api/openvino/test/stream', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:_el('ov-test-prompt').value,max_tokens:Number(_el('ov-test-tokens').value)})});
    if (!response.headers.get('content-type')?.includes('text/event-stream')) {
      const data = await response.json(); throw new Error(data.error || 'Test did not return a stream');
    }
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const part = await reader.read();
      buffer += decoder.decode(part.value || new Uint8Array(), {stream:!part.done});
      const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        if (line.slice(6).trim() === '[DONE]') { done = true; continue; }
        const data = JSON.parse(line.slice(6));
        if (data.error) failure = data.error.message || String(data.error);
        for (const choice of data.choices || []) {
          answer += choice.delta?.content || '';
          thoughts += choice.delta?.reasoning_content || '';
          finishReason = choice.finish_reason || finishReason;
        }
        if (answer) reply.textContent = answer;
        if (thoughts) { reasoning.hidden = false; reasoning.textContent = 'Reasoning received from model:\n' + thoughts; }
      }
      if (part.done) break;
    }
    if (failure) throw new Error(failure);
    if (!done) throw new Error('Connection ended without a completion marker. Reply is incomplete.');
    if (!answer.trim()) throw new Error(thoughts ? 'Model returned reasoning but no answer. The reply token limit may have been exhausted.' : 'Model completed without returning answer text.');
    _showBanner(finishReason === 'length' ? 'Reply received, but the output token limit was reached.' : 'Test completed: answer text received.', 'info');
  } catch (err) {
    reply.textContent = `${answer ? answer + '\n\n' : ''}Test failed: ${err.message}`;
    _showBanner(`Test failed: ${err.message}`, 'error');
  } finally { _setBusy(false); await _pollStatus(); }
}

async function _previewV1Models() {
  const panel = _el('ov-model-info');
  if (!panel.hidden) { panel.hidden = true; return; }
  panel.hidden = false;
  const output = _el('ov-model-info-json');
  output.textContent = 'Reading model information…';
  try {
    const response = await fetch('/v1/models');
    output.textContent = JSON.stringify(await response.json(), null, 2);
  } catch (err) { output.textContent = `Cannot read model information: ${err.message}`; }
}

async function _stopWork() {
  if (_stoppingWork) return;
  _stoppingWork = true;
  _paintStatus(_lastStatus);
  _showBanner('Stopping generation and releasing the model. The API will stay stopped until you start it again.', 'warn');
  try {
    const response = await fetch('/admin/stop', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
    const data = await response.json();
    _paintStatus(data);
    if (!data.ok) throw new Error(data.error || 'Cannot stop server');
    _showBanner('Stopped. Model unloaded and API server down. Start Server when you are ready.', 'info');
  } catch (err) { _showBanner(err.message, 'error'); }
  finally { _stoppingWork = false; _paintStatus(_lastStatus); }
}

export function renderOpenVinoForm() {
  const host = document.getElementById('actionPanelForm') || document.getElementById('actionPanel');
  if (!host) return;
  _formHydrated = false;
  _catalog = null;
  _settingsDescriptor = null;
  _settingsRequest++;

  host.innerHTML = `
    <div id="openvinoPanel" class="ov-workspace">
      <div class="ov-topbar">
        <div class="panel-title-desc dense">
          <h3>OpenVINO · Local API Server</h3>
          <p>Model-specific settings and presets · staged Apply · protected memory limits</p>
        </div>
        <div class="ov-topbar-actions">
          <button type="button" id="ov-btn-refresh" class="ov-btn"
            data-help-title="Update Status Only"
            data-help-text="Fetch the latest activity now instead of waiting for the next automatic update. Running requests and settings are left alone.">Update status</button>
          <button type="button" id="ov-btn-preview-models" class="ov-btn"
            data-help-title="Preview /v1/models JSON"
            data-help-text="See the model limits and capabilities advertised to Cline. These describe what the API offers; they do not verify that generation works.">Model info</button>
          <button type="button" id="ov-btn-save-apply" class="ov-btn ov-btn-primary"
            data-help-title="Save &amp; Apply Settings"
            data-help-text="Make the staged settings take effect. Reply defaults can change with the model loaded; engine or memory changes require reloading.">💾 Save &amp; Apply</button>
        </div>
      </div>

      <div id="ov-banner" class="ov-banner" role="status" aria-live="polite" hidden></div>
      <section id="ov-model-info" class="ov-bottom-card" hidden aria-label="Model information for API clients">
        <p>Read-only model information advertised to API clients. This does not run a model.</p>
        <pre id="ov-model-info-json" class="ov-log-pre"></pre>
      </section>

      <!-- 2-Level State Deck -->
      <div class="ov-state-deck">
        <!-- Level 1: Server Up / Down -->
        <div class="ov-state-card" id="ov-card-level1">
          <div class="ov-state-head">
            <span class="ov-state-kicker">Level 1 · Server Process (Uvicorn)</span>
            <span id="ov-server-badge" class="ov-badge ov-badge-down">
              <span class="ov-badge-dot" aria-hidden="true"></span><span>SERVER DOWN</span>
            </span>
          </div>
          <div class="ov-telemetry-grid">
            <span class="ov-kv"><span class="ov-kv-label">PID:</span><span class="ov-kv-val" id="ov-stat-pid">—</span></span>
            <span class="ov-kv"><span class="ov-kv-label">Uptime:</span><span class="ov-kv-val" id="ov-stat-uptime">—</span></span>
            <span class="ov-kv"><span class="ov-kv-label">Bind:</span><span class="ov-kv-val" id="ov-stat-port">127.0.0.1:2431</span></span>
            <span class="ov-kv"><span class="ov-kv-label">Cage:</span><span class="ov-kv-val" id="ov-stat-cage">systemd_scope (Max 9G · High 8G · Swap 0)</span></span>
          </div>
          <div class="ov-state-controls">
            <button type="button" id="ov-btn-server-toggle" class="ov-btn ov-btn-success"
              data-help-title="Start / Stop OpenVINO Server"
              data-help-text="Toggle the caged uvicorn server process Up or Down. Automatically reclaims the port if a stray vinoapi/worker process is holding it.">▶ Start Server</button>
            <button type="button" id="ov-btn-kill-stray" class="ov-btn"
              data-help-title="Kill Stray Processes"
              data-help-text="Terminate any stray vinoapi, unmanaged uvicorn worker, or orphaned ovms process holding the port or unified RAM.">🧹 Sweep Strays</button>
            <span class="ov-guard-hint">Crash-not-global-OOM · no systemd .service file</span>
          </div>
        </div>

        <!-- Level 2: Model Hot / Cold -->
        <div class="ov-state-card" id="ov-card-level2">
          <div class="ov-state-head">
            <span class="ov-state-kicker">Level 2 · Model Pipeline (RAM / iGPU VRAM)</span>
            <span id="ov-model-badge" class="ov-badge ov-badge-cold">
              <span class="ov-badge-dot" aria-hidden="true"></span><span>MODEL COLD</span>
            </span>
          </div>
          <div class="ov-row ov-model-picker">
            <label for="ov-model-select" class="ov-kv-label">Model</label>
            <select id="ov-model-select" name="openvino-model" class="ov-select ov-input-mono ov-input-flex"
              aria-describedby="ov-model-picker-hint" disabled
              data-help-title="Intel AI Playground Model"
              data-help-text="Choose from the Intel AI Playground OpenVINO catalog. Download missing weights, then Save & Apply. Native OVMS supports vision entries; the legacy loader is text-only.">
              <option>Loading models…</option>
            </select>
            <button type="button" id="ov-btn-download-model" class="ov-btn ov-btn-mini" hidden
              data-help-title="Download Selected Model"
              data-help-text="Download the selected Intel AI Playground OpenVINO weights into its shared model folder. Does not load the model into RAM.">↓ Download</button>
          </div>
          <div class="ov-row">
            <button type="button" id="ov-btn-refresh-models" class="ov-btn ov-btn-mini" data-help-title="Refresh model discovery" data-help-text="Check Hugging Face for new OpenVINO exports. Existing files, selection and the running model are preserved.">Refresh models</button>
            <label class="ov-check" data-help-title="Uncertain candidates" data-help-text="Include complete exports whose architecture support or estimated memory fit is uncertain. These have not been proven to run here."><input id="ov-show-experimental" type="checkbox">Show experimental</label>
            <span id="ov-catalog-status" class="ov-card-sub" role="status" aria-live="polite"></span>
            <progress id="ov-model-download-progress" hidden aria-label="Model download bytes"></progress>
            <button type="button" id="ov-btn-cancel-download" class="ov-btn ov-btn-mini" hidden>Cancel download</button>
          </div>
          <fieldset class="ov-profile-controls">
            <legend>Model settings &amp; presets</legend>
            <div class="ov-row">
              <label for="ov-profile-select">Profile</label>
              <select id="ov-profile-select" class="ov-select ov-input-flex"><option value="">Custom / current settings</option></select>
              <button type="button" id="ov-btn-defaults" class="ov-btn" disabled>Defaults</button>
            </div>
            <div class="ov-row">
              <label for="ov-preset-name">Preset name</label>
              <input id="ov-preset-name" class="ov-input ov-input-flex" maxlength="80" autocomplete="off">
              <button type="button" id="ov-btn-preset-save" class="ov-btn">Save new</button>
              <button type="button" id="ov-btn-preset-overwrite" class="ov-btn">Overwrite</button>
              <button type="button" id="ov-btn-preset-delete" class="ov-btn">Delete</button>
            </div>
            <p id="ov-profile-note" class="ov-card-sub"></p>
            <p id="ov-pending-changes" role="status" aria-live="polite"></p>
          </fieldset>
          <div id="ov-model-picker-hint" class="ov-card-sub ov-model-hint"></div>
          <div id="ov-model-download-status" class="ov-banner" role="status" aria-live="polite" hidden></div>
          <div class="ov-telemetry-grid">
            <span class="ov-kv"><span class="ov-kv-label">Resident:</span><span class="ov-kv-val" id="ov-stat-model-id">None (Cold)</span><button type="button" id="ov-copy-loaded-model" class="ov-btn ov-btn-mini" disabled aria-label="Copy loaded model ID" data-help-title="Use in Cline" data-help-text="Copy the exact loaded model ID to paste into Cline’s model field. This follows the resident model, not a staged selection.">Copy</button></span>
            <span class="ov-kv"><span class="ov-kv-label">Engine:</span><span class="ov-kv-val" id="ov-stat-engine">Playground OVMS</span></span>
            <span class="ov-kv"><span class="ov-kv-label">Target:</span><span class="ov-kv-val" id="ov-stat-device-kv">GPU · KV u4</span></span>
            <span class="ov-kv"><span class="ov-kv-label">Mem Used:</span><span class="ov-kv-val" id="ov-stat-mem-used">0 MB</span></span>
            <span class="ov-kv"><span class="ov-kv-label">MemAvailable:</span><span class="ov-kv-val" id="ov-stat-mem-avail">—</span></span>
            <span class="ov-kv"><span class="ov-kv-label">Load Time:</span><span class="ov-kv-val" id="ov-stat-load-time">—</span></span>
          </div>
          <p id="ov-generation-status" class="ov-card-sub" role="status" aria-live="polite">Checking request activity…</p>
          <div class="ov-state-controls">
            <button type="button" id="ov-btn-stop-work" class="ov-btn ov-btn-danger" disabled
              data-help-title="Stop &amp; Release GPU"
              data-help-text="Stop generation, unload this model and stop the API server so client retries cannot immediately reload it. Start Server to accept requests again.">Stop &amp; release GPU</button>
            <button type="button" id="ov-btn-model-toggle" class="ov-btn ov-btn-primary" disabled
              data-help-title="Load / Unload Model Pipeline"
              data-help-text="Load the OpenVINO LLMPipeline into RAM/VRAM (Hot) or release it back to the OS (Cold) while keeping the server Up.">▲ Load model</button>
            <span class="ov-guard-hint">Max 1 model hot on 15 GB shared RAM</span>
          </div>
        </div>
      </div>

      <!-- 4 Editable Settings Cards -->
      <div class="ov-cards-grid">
        <!-- Card 1: Connection, URLs, API Key -->
        <div class="ov-card">
          <div class="ov-card-title">
            <span>1. Endpoint &amp; API Key</span>
            <span class="ov-card-sub">Cline Provider Connection</span>
          </div>

          <div class="ov-row">
            <div class="ov-unit">
              <label for="ov-host">Host</label>
              <input type="text" id="ov-host" class="ov-input ov-input-mono" style="width:105px" value="127.0.0.1"
                data-help-title="Bind Host"
                data-help-text="Choose which network interface accepts API connections. 127.0.0.1 restricts access to this computer; a network-facing address allows other devices to connect.">
            </div>
            <div class="ov-unit">
              <label for="ov-port">Port</label>
              <input type="number" id="ov-port" class="ov-input ov-input-short" min="1024" max="65535" value="2431"
                data-help-title="Server Port (Default 2431)"
                data-help-text="Custom port (default 2431) avoiding port 8000 collisions and Intel Playground ovms on 29000. Drives Base URL and Model Source URL.">
            </div>
            <div class="ov-unit ov-unit-grow">
              <label for="ov-api-key">API Key</label>
              <input type="text" id="ov-api-key" class="ov-input ov-input-mono ov-input-flex" value="openvino-local"
                data-help-title="API Key"
                data-help-text="Token string to paste into Cline’s required API Key field (default: openvino-local).">
              <button type="button" id="ov-copy-apikey" class="ov-btn ov-btn-mini"
                data-help-title="Copy API Key"
                data-help-text="Put the credential on your clipboard to paste into the client’s API Key field.">Copy</button>
            </div>
            <label class="ov-check"
              data-help-title="Enforce API Key"
              data-help-text="When checked, /v1/chat/completions rejects requests whose Authorization Bearer token does not match the configured API Key.">
              <input type="checkbox" id="ov-enforce-apikey">
              <span>Enforce</span>
            </label>
          </div>

          <div class="ov-url-box">
            <span class="ov-url-label">Base URL</span>
            <input type="text" id="ov-base-url" class="ov-url-readout" readonly value="http://127.0.0.1:2431/v1"
              data-help-title="OpenAI Base URL"
              data-help-text="Paste this URL into Cline’s OpenAI Compatible Base URL setting.">
            <button type="button" id="ov-copy-baseurl" class="ov-btn ov-btn-mini"
              data-help-title="Copy Base URL"
              data-help-text="Put the server address on your clipboard for the client’s OpenAI-compatible Base URL field.">Copy</button>
          </div>

          <div class="ov-url-box">
            <span class="ov-url-label">Model Source URL</span>
            <input type="text" id="ov-model-source-url" class="ov-url-readout" readonly value="http://127.0.0.1:2431/v1/models"
              data-help-title="Model Source URL (/v1/models)"
              data-help-text="Endpoint queried by Cline to discover model IDs, context_length, max_tokens, timeout_ms, and capabilities.">
            <button type="button" id="ov-copy-modelsurl" class="ov-btn ov-btn-mini"
              data-help-title="Copy Model Source URL"
              data-help-text="Put the model-discovery address on your clipboard for clients that accept a separate Model Source URL.">Copy</button>
          </div>

        </div>

        <!-- Card 2: Cline Limits & Capabilities -->
        <div class="ov-card">
          <div class="ov-card-title">
            <span>2. Model generation settings</span>
            <span class="ov-card-sub">Exported via /v1/models</span>
          </div>

          <div class="ov-row">
            <div class="ov-unit">
              <label for="ov-timeout-ms">Request timeout (ms)</label>
              <input type="number" id="ov-timeout-ms" class="ov-input ov-input-num" min="1000" max="3600000" step="1000" value="300000"
                data-help-title="Client / Request Timeout (ms) — Default 300000"
                data-help-text="Default 300000 ms (5 minutes). Native requests have this total time limit, including prompt processing and streaming; expiry unloads the model. Also advertised to API clients as their timeout.">
            </div>
            <div class="ov-unit">
              <label for="ov-context-window">Client context budget</label>
              <input type="number" id="ov-context-window" class="ov-input ov-input-num" min="512" max="2097152" step="512" value="40960"
                data-help-title="Context Window (context_length / contextWindow)"
                data-help-text="Reported to clients as their context budget, bounded by native model capacity. On NPU it also sets the load-time prompt limit. On CPU/GPU this does not reserve or hard-limit KV memory; use the runtime cache controls and memory cage.">
            </div>
          </div>

          <div class="ov-row">
            <div class="ov-unit">
              <label for="ov-max-tokens">Reply token cap</label>
              <input type="number" id="ov-max-tokens" class="ov-input ov-input-num" min="1" max="2097152" step="64" value="4096"
                data-help-title="Max Completion Tokens (maxTokens / max_tokens)"
                data-help-text="Advertised in /v1/models as max_tokens, maxTokens, and max_completion_tokens; caps per-response output tokens.">
            </div>
            <div class="ov-unit">
              <label for="ov-max-tokens-default">Default reply tokens</label>
              <input type="number" id="ov-max-tokens-default" class="ov-input ov-input-num" min="1" max="2097152" step="64" value="1024"
                data-help-title="Fallback max_new_tokens"
                data-help-text="Limit reply length when the client does not supply its own limit. Reasoning also consumes the reply budget on models that generate it.">
            </div>
            <div class="ov-unit">
              <label for="ov-temperature">Temp</label>
              <input type="number" id="ov-temperature" class="ov-input ov-input-short" min="0" max="2" step="any" placeholder="Automatic"
                data-help-title="Default Temperature"
                data-help-text="Lower values favor more predictable wording; higher values allow more variation. Used only when the client omits temperature. Blank inherits the model default.">
            </div>
            <div class="ov-unit">
              <label for="ov-top-p">Top P</label>
              <input type="number" id="ov-top-p" class="ov-input ov-input-short" min="0.000001" max="1" step="any" placeholder="Automatic"
                data-help-title="Default Top-P"
                data-help-text="Lower values narrow the choices of next word; values near 1 allow more variety. Used only when the client omits top-p. Blank inherits the model default.">
            </div>
          </div>

          <div class="ov-row">
            <div class="ov-unit"><label for="ov-top-k">Top K</label><input type="number" id="ov-top-k" class="ov-input ov-input-short" min="-1" max="1000000" step="1" placeholder="Automatic"></div>
            <div class="ov-unit"><label for="ov-repetition-penalty">Repetition penalty</label><input type="number" id="ov-repetition-penalty" class="ov-input ov-input-short" min="0.000001" max="10" step="any" placeholder="Automatic"></div>
          </div>
          <div class="ov-caps-row">
            <span class="ov-card-sub">Supported capabilities (read-only):</span>
            <label class="ov-check"
              data-help-title="Capability: Streaming"
              data-help-text="Whether this model can return output incrementally. Supported capability is read-only; it does not mean a request is currently producing output.">
              <input type="checkbox" id="ov-cap-streaming" checked><span>Streaming</span>
            </label>
            <label class="ov-check"
              data-help-title="Capability: Tools / Function Calling"
              data-help-text="Whether the model can request actions from clients such as Cline. The client executes the tools; the API serves the model’s requests.">
              <input type="checkbox" id="ov-cap-tools" checked><span>Tools</span>
            </label>
            <label class="ov-check"
              data-help-title="Capability: Reasoning"
              data-help-text="Whether the model supports reasoning output. This is a capability, not evidence that the current request is thinking.">
              <input type="checkbox" id="ov-cap-reasoning" checked><span>Reasoning</span>
            </label>
            <label class="ov-check"
              data-help-title="Capability: Vision"
              data-help-text="Whether the selected model accepts images as well as text. A text-only model cannot gain image support through settings.">
              <input type="checkbox" id="ov-cap-vision"><span>Vision</span>
            </label>
            <label class="ov-check"
              data-help-title="Capability: Prompt Cache"
              data-help-text="Whether the engine can reuse attention history. This describes support; it does not show how much memory is currently cached.">
              <input type="checkbox" id="ov-cap-prompt-cache" checked><span>Prompt Cache</span>
            </label>
          </div>

          <div class="ov-row">
            <label class="ov-check"
              data-help-title="Model Thinking Mode (enable_thinking)"
              data-help-text="Allow the model to spend reply tokens on reasoning before answering. This can delay the visible answer. An explicit client setting takes precedence.">
              <input type="checkbox" id="ov-enable-thinking">
              <span>Enable thinking by default</span>
            </label>
          </div>
        </div>

        <!-- Card 3: OpenVINO Runtime & Paths -->
        <div class="ov-card">
          <div class="ov-card-title">
            <span>3. OpenVINO Runtime &amp; Paths</span>
            <span class="ov-card-sub">Installed Intel AI Playground runtime</span>
          </div>

          <div class="ov-row">
            <div class="ov-unit ov-unit-grow">
              <label for="ov-engine">Engine</label>
              <select id="ov-engine" class="ov-select ov-input-flex" data-help-title="Serving Engine" data-help-text="Playground runs the installed OVMS executable and native model/tool parsers. Legacy uses the prototype Python GenAI loader.">
                <option value="playground">Intel Playground · OVMS</option><option value="genai">Legacy · Python GenAI</option>
              </select>
            </div>
          </div>
          <div class="ov-row">
            <div class="ov-unit ov-unit-grow">
              <label for="ov-preflight-policy">Load policy</label>
              <select id="ov-preflight-policy" class="ov-select ov-input-flex" data-help-title="Memory Admission Policy" data-help-text="Playground lets the actual model/runtime allocate memory without a fixed free-RAM minimum. The process memory cage stays active. Fixed minimum is an optional custom override.">
                <option value="playground">Playground · no fixed RAM gate</option><option value="fixed">Custom · fixed minimum</option>
              </select>
            </div>
          </div>
          <section id="ov-playground-settings" class="ov-models-wrap" aria-label="Advanced OVMS runtime settings"><div class="ov-card-sub">Advanced OVMS runtime settings</div>
            <div class="ov-row">
              <div class="ov-unit"><label for="ov-rest-workers">REST workers</label><input id="ov-rest-workers" type="number" class="ov-input ov-input-short" min="1" max="64" value="4" data-help-title="OVMS REST Workers" data-help-text="Threads accepting HTTP requests, not simultaneous model answers. Raising this does not make a single reply faster. Playground uses 4."></div>
              <div class="ov-unit"><label for="ov-cache-size">KV GB</label><input id="ov-cache-size" type="number" class="ov-input ov-input-short" min="0" max="64" value="0" data-help-title="OVMS KV Cache Size" data-help-text="Zero uses the installed Playground OVMS default: dynamic allocation. Positive values reserve that many GB."></div>
            </div>
            <div class="ov-row">
              <div class="ov-unit"><label for="ov-max-seqs">Max sequences</label><input id="ov-max-seqs" type="number" class="ov-input ov-input-short" min="1" max="4096" value="256" data-help-title="OVMS Max Sequences" data-help-text="Ceiling for sequences inside the native scheduler. This API accepts one chat request at a time; raising this does not enable parallel client chats or allocate that many contexts."></div>
              <div class="ov-unit"><label for="ov-batch-tokens">Batch tokens</label><input id="ov-batch-tokens" type="number" class="ov-input ov-input-short" min="0" max="2097152" value="0" data-help-title="OVMS Batched Tokens" data-help-text="Limit how many tokens the native scheduler processes in one batch. Larger batches can use more memory. Zero keeps the runtime default."></div>
            </div>
            <div class="ov-row"><label for="ov-tool-parser" class="ov-kv-label">Tool parser</label><input id="ov-tool-parser" readonly class="ov-input ov-input-flex" value="hermes3" data-help-title="Model Tool Parser" data-help-text="Copied from Playground model metadata (gptoss, mistral, qwen3coder) with hermes3 fallback. Saved per model."></div>
            <div class="ov-row"><label for="ov-reasoning-parser" class="ov-kv-label">Reasoning</label><input id="ov-reasoning-parser" readonly class="ov-input ov-input-flex" value="qwen3" data-help-title="Reasoning Parser" data-help-text="Playground starts its OpenVINO text server with the qwen3 reasoning parser."></div>
            <div class="ov-caps-row">
              <label class="ov-check" data-help-title="Prefix Caching" data-help-text="Reuse cached processing when requests start with the same instructions or history. This can speed repeated prompts but retains cache memory."><input id="ov-prefix-cache" type="checkbox" checked>Prefix cache</label>
              <label class="ov-check" data-help-title="Dynamic Split Fuse" data-help-text="Let the native scheduler combine prompt processing with generation work. Playground enables this; changing it affects scheduling, not reply style."><input id="ov-split-fuse" type="checkbox" checked>Dynamic split fuse</label>
            </div>
          </section>

          <div class="ov-row">
            <div class="ov-unit ov-unit-grow">
              <label for="ov-model-path">Model Path</label>
              <input type="text" id="ov-model-path" class="ov-input ov-input-mono ov-input-flex"
                value="/home/m/.local/share/ai-playground/resources/models/LLM/openvino/OpenVINO---Qwen3-8B-int4-ov"
                data-help-title="OpenVINO IR Model Directory"
                data-help-text="Absolute path to the folder containing openvino_model.xml, openvino_model.bin, and tokenizer files.">
              <button type="button" id="ov-browse-model-path" class="ov-btn ov-btn-mini"
                data-help-title="Browse Model Directory"
                data-help-text="Open the folder browser to choose an OpenVINO IR model directory.">Browse</button>
            </div>
          </div>

          <div class="ov-row">
            <div class="ov-unit ov-unit-grow">
              <label for="ov-cache-dir">Cache Dir</label>
              <input type="text" id="ov-cache-dir" class="ov-input ov-input-mono ov-input-flex"
                value="/home/m/.cache/vinoapi/ov_cache"
                data-help-title="Compiled Blob &amp; OpenCL Kernel Cache Directory"
                data-help-text="Store compiled model and GPU files for reuse on later loads. A compatible cache can reduce preparation time; the first load may still need compilation.">
              <button type="button" id="ov-browse-cache-dir" class="ov-btn ov-btn-mini"
                data-help-title="Browse Cache Directory"
                data-help-text="Open the folder browser to select the OpenVINO compiled blob cache directory.">Browse</button>
            </div>
          </div>

          <div class="ov-row">
            <div class="ov-unit">
              <label for="ov-device">Device</label>
              <select id="ov-device" class="ov-select"
                data-help-title="OpenVINO Target Device"
                data-help-text="Choose the processor used for inference. Changing it requires a reload; available choices depend on this model and engine.">
                <option value="GPU">GPU</option>
                <option value="CPU">CPU</option>
                <option value="NPU">NPU</option>
                <option value="AUTO">AUTO</option>
              </select>
            </div>
            <div class="ov-unit">
              <label for="ov-kv-precision">KV Cache</label>
              <select id="ov-kv-precision" class="ov-select"
                data-help-title="KV Cache Precision"
                data-help-text="Precision used to store attention history. Lower precision reduces cache memory and can affect quality. Auto lets the engine choose.">
                <option value="u4">u4 (4-bit · lowest RAM)</option>
                <option value="u8">u8 (8-bit)</option>
                <option value="f16">f16 (16-bit)</option>
                <option value="auto">auto</option>
              </select>
            </div>
            <div class="ov-unit">
              <label for="ov-preflight-mb">Preflight (MB)</label>
              <input type="number" id="ov-preflight-mb" class="ov-input ov-input-short" min="256" max="65536" step="1" value="8192"
                data-help-title="Preflight Minimum MemAvailable (MB)"
                data-help-text="Only used with Custom fixed minimum policy. Disabled in Playground policy; small models do not need an arbitrary 8 GB free.">
            </div>
          </div>

          <div class="ov-caps-row">
            <label class="ov-check"
              data-help-title="Auto-Load on Chat Request"
              data-help-text="If a /v1/chat/completions request arrives while the server is Up and the model is Cold, automatically run the preflight-guarded Load step.">
              <input type="checkbox" id="ov-auto-load-request" checked><span>Auto-load on request</span>
            </label>
            <label class="ov-check"
              data-help-title="Auto-Load on Server Start"
              data-help-text="Prepare the model as soon as the API starts, before a client asks for a reply. This uses model memory even while idle.">
              <input type="checkbox" id="ov-auto-load-start"><span>Auto-load on start</span>
            </label>
            <label class="ov-check"
              data-help-title="SSE Prefill Keep-Alive Heartbeats"
              data-help-text="Send connection heartbeats while the legacy engine prepares a reply. Heartbeats contain no model output and do not prove progress or prevent every client timeout.">
              <input type="checkbox" id="ov-sse-keepalive" checked><span>SSE prefill keep-alive</span>
            </label>
          </div>

          <div class="ov-row">
            <div class="ov-unit ov-unit-grow">
              <label for="ov-overlay-path">Runtime Overlay</label>
              <input type="text" id="ov-overlay-path" class="ov-input ov-input-mono ov-input-flex"
                placeholder="Optional ovms runtime path for .blob cache match (blank = pure .venv)"
                value="/home/m/.local/share/ai-playground/resources/OpenVINO/ovms"
                data-help-title="Optional OpenVINO Runtime Overlay Path"
                data-help-text="Optional path to an OpenVINO runtime (e.g. AI Playground ovms) whose exact build hash matches pre-compiled .blob caches. Leave blank on new machines to use mtapi-project/.venv packages directly.">
              <button type="button" id="ov-browse-overlay-path" class="ov-btn ov-btn-mini"
                data-help-title="Browse Runtime Overlay Directory"
                data-help-text="Select an optional OpenVINO runtime directory.">Browse</button>
            </div>
          </div>
        </div>

        <!-- Card 4: Memory Cage & Watchdog Guards -->
        <div class="ov-card">
          <div class="ov-card-title">
            <span>4. Memory Cage &amp; Watchdog Guards</span>
            <span class="ov-card-sub">systemd-run scope + Void Linux fallback</span>
          </div>

          <div class="ov-row">
            <div class="ov-unit ov-unit-grow">
              <label for="ov-cage-backend">Launcher</label>
              <select id="ov-cage-backend" class="ov-select ov-input-flex"
                data-help-title="Launch Cage Backend (Abstracted Interface)"
                data-help-text="auto/systemd_scope uses 'systemd-run --user --scope'; cgroup_prlimit uses prlimit + /proc/<pid>/oom_score_adj + direct cgroup v2 for Void Linux / no-systemd.">
                <option value="auto">auto (systemd-run --scope → Void/prlimit fallback)</option>
                <option value="systemd_scope">systemd_scope (systemd-run --user --scope)</option>
                <option value="cgroup_prlimit">cgroup_prlimit (Void Linux / no-systemd direct)</option>
                <option value="none">none (uncaged · debug only)</option>
              </select>
            </div>
          </div>

          <div class="ov-row">
            <div class="ov-unit">
              <label for="ov-memory-max">MemoryMax</label>
              <input type="text" id="ov-memory-max" class="ov-input ov-input-short" value="9G"
                data-help-title="Cage MemoryMax (-p MemoryMax=9G)"
                data-help-text="Maximum memory allowed for the worker group. Exceeding it can terminate the model and fail the request. A low cap can prevent a model from loading.">
            </div>
            <div class="ov-unit">
              <label for="ov-memory-high">MemoryHigh</label>
              <input type="text" id="ov-memory-high" class="ov-input ov-input-short" value="8G"
                data-help-title="Cage MemoryHigh (-p MemoryHigh=8G)"
                data-help-text="Memory level where the system starts reclaiming memory or slowing the worker. Setting it too low can cause long delays before the hard limit is reached.">
            </div>
            <div class="ov-unit">
              <label for="ov-memory-swap-max">MemorySwapMax</label>
              <input type="text" id="ov-memory-swap-max" class="ov-input ov-input-short" value="0"
                data-help-title="Cage MemorySwapMax (-p MemorySwapMax=0)"
                data-help-text="Maximum swap allowed for the worker group. Zero avoids swapping model memory but leaves less room before an out-of-memory failure.">
            </div>
            <div class="ov-unit">
              <label for="ov-oom-score-adjust">OOMScoreAdjust</label>
              <input type="number" id="ov-oom-score-adjust" class="ov-input ov-input-short" min="-1000" max="1000" value="1000"
                data-help-title="Cage OOMScoreAdjust (-p OOMScoreAdjust=1000)"
                data-help-text="Influence which process the system terminates under memory pressure. Higher values make this worker a more likely target; this is not a guarantee.">
            </div>
          </div>

          <div class="ov-row">
            <div class="ov-unit">
              <label for="ov-rss-cap-mb">Self-RSS Cap (MB)</label>
              <input type="number" id="ov-rss-cap-mb" class="ov-input ov-input-num" min="512" max="131072" step="1" value="11500"
                data-help-title="In-Process Self-RSS Watchdog Cap (MB)"
                data-help-text="Worker watchdog aborts cleanly (exit 4) if process VmRSS exceeds this cap (default 11500 MB).">
            </div>
            <label class="ov-check"
              data-help-title="Opt-In System MemAvailable Floor Watchdog"
              data-help-text="When enabled, aborts the worker if system MemAvailable stays below Floor Min MB for 5s.">
              <input type="checkbox" id="ov-watchdog-floor"><span>Floor Watchdog</span>
            </label>
            <div class="ov-unit">
              <label for="ov-watchdog-min-mb">Floor (MB)</label>
              <input type="number" id="ov-watchdog-min-mb" class="ov-input ov-input-short" min="32" max="16384" value="192"
                data-help-title="Floor Watchdog Threshold (MB)"
                data-help-text="System MemAvailable floor in MB (default 192 MB) when Floor Watchdog is enabled.">
            </div>
          </div>

          <div class="ov-row" style="justify-content: space-between; margin-top: 2px;">
            <span class="ov-card-sub">Apply activates changes. Runtime changes reload the model; sampling changes keep it warm.</span>
            <button type="button" id="ov-btn-save-card" class="ov-btn ov-btn-primary"
              data-help-title="Save &amp; Apply All Settings"
              data-help-text="Make the staged settings take effect. Reply defaults can change with the model loaded; engine or memory changes require reloading.">💾 Save &amp; Apply</button>
          </div>
        </div>
      </div>

      <!-- Bottom Card: Smoke Test & Live Server Logs -->
      <div class="ov-bottom-card">
        <div class="ov-card-title">
          <span>5. Quick Smoke Test &amp; Live Worker Log</span>
          <span class="ov-card-sub">POST /v1/chat/completions · tail of caged uvicorn stdout/stderr</span>
        </div>
        <div class="ov-row">
          <input type="text" id="ov-test-prompt" class="ov-input ov-input-flex"
            value="Reply with exactly OK."
            data-help-title="Smoke Test Prompt"
            data-help-text="Use a short instruction to check whether the model returns an answer. This test excludes Cline’s instructions, tools and conversation history.">
          <label for="ov-test-tokens">Reply tokens</label><input id="ov-test-tokens" class="ov-input ov-input-short" type="number" min="1" max="2048" value="64">
          <button type="button" id="ov-btn-send-test" class="ov-btn ov-btn-primary"
            data-help-title="Send Test Chat Completion"
            data-help-text="Run the prompt above and show arriving answer and reasoning text. A successful short test does not establish that a larger Cline request works.">▶ Send Test</button>
        </div>
        <pre id="ov-test-reasoning" class="ov-test-reply" hidden></pre>
        <div id="ov-test-reply" class="ov-test-reply" hidden></div>
        <pre id="ov-log-output" class="ov-log-pre"
          data-help-title="OpenVINO Worker Log"
          data-help-text="Live stdout/stderr lines from the caged uvicorn worker and supervisor.">Loading status…</pre>
      </div>
    </div>
  `;

  _el('ov-profile-select').addEventListener('change', e => {
    const value = e.target.value;
    const factory = _settingsDescriptor?.factory_profiles.find(p => `factory:${p.id}` === value);
    const saved = _settingsDescriptor?.presets.find(p => `saved:${p.name}` === value);
    const profile = factory || saved;
    if (saved) _el('ov-preset-name').value = saved.name;
    if (profile) _stageProfile(profile.values, profile.name);
  });
  _el('ov-btn-defaults').addEventListener('click', () => {
    const profile = _settingsDescriptor?.factory_profiles[0];
    if (profile) { _el('ov-profile-select').value = `factory:${profile.id}`; _stageProfile(profile.values, 'Playground defaults'); }
  });
  for (const action of ['save', 'overwrite', 'delete']) _el(`ov-btn-preset-${action}`).addEventListener('click', () => _managePreset(action));
  _el('ov-device').addEventListener('change', () => _fetchSettingsDescriptor());
  _el('ov-engine').addEventListener('change', () => {
    const entry = _currentConfig?.models.find(m => m.id === _currentConfig.active_model_id);
    if (!entry) return;
    entry.runtime_profiles ||= {};
    entry.runtime_profiles[_viewEngine] = Object.fromEntries(Object.entries(_runtimeControls).map(([k,id]) => [k,_readControl(id)]));
    _viewEngine = _el('ov-engine').value;
    const runtime = entry.runtime_profiles[_viewEngine] || _currentConfig.runtime;
    for (const [key,id] of Object.entries(_runtimeControls)) _writeControl(id, runtime[key]);
    _fetchSettingsDescriptor();
  });
  _el('openvinoPanel').addEventListener('input', e => {
    if (!e.target.matches('input,select') || ['ov-preset-name', 'ov-test-prompt', 'ov-test-tokens', 'ov-profile-select', 'ov-keep-loaded', 'ov-show-experimental'].includes(e.target.id)) return;
    _dirty = true;
    _el('ov-profile-select').value = '';
    _pendingChanges();
  });

  const mainCard = _el('ov-card-level2');
  const deck = mainCard.parentElement;
  deck.append(_el('ov-card-level1'));
  mainCard.querySelector('.ov-state-head').hidden = true;
  const status = document.createElement('section');
  status.className = 'ov-work-status';
  status.innerHTML = `<strong id="ov-work-phase" role="status" aria-live="polite">Checking model status…</strong> <span id="ov-work-elapsed" aria-live="off"></span>
    <p id="ov-work-detail"></p><p id="ov-work-last"></p>
    <label class="ov-check" for="ov-keep-loaded"><input type="checkbox" id="ov-keep-loaded">Keep loaded</label>`;
  deck.before(status);
  const controls = document.createElement('div');
  controls.className = 'ov-state-controls';
  const oldControls = _el('ov-btn-model-toggle').parentElement;
  controls.append(_el('ov-btn-model-toggle'), _el('ov-btn-stop-work'));
  const statusRow = document.createElement('div');
  statusRow.className = 'ov-work-row';
  statusRow.append(_el('ov-work-phase'), _el('ov-work-elapsed'), status.querySelector('label'), controls);
  status.prepend(statusRow);
  oldControls.hidden = true;
  _el('ov-generation-status').hidden = true;
  _el('ov-keep-loaded').addEventListener('change', async e => {
    if (_keepChanging) return;
    _keepChanging = true; e.target.disabled = true;
    try {
      const response = await fetch('/api/models/hot', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({tool:'openvino',enabled:e.target.checked})});
      const result = await response.json();
      if (!result.ok) throw new Error(result.error || 'Cannot save retention');
      await _pollStatus();
    } catch (err) { _showBanner(err.message, 'error'); await _pollStatus(); }
    finally { _keepChanging = false; if (_el('ov-keep-loaded')) _el('ov-keep-loaded').disabled = false; }
  });

  // Explain effects and tradeoffs in the shared help strip.
  const controlHelp = {
    "ov-profile-select": "Choose Playground settings or a preset saved for this exact model and engine. Selecting one stages changes; Save & Apply activates them.",
    "ov-btn-defaults": "Stage this model’s original Playground generation and runtime settings. Save & Apply activates them. Connection credentials and safety limits are preserved.",
    "ov-preset-name": "Name a reusable set of the generation and runtime settings currently shown for this model and engine.",
    "ov-btn-preset-save": "Store the settings currently shown under a new name for this model and engine. Saving a preset does not apply it to the server.",
    "ov-btn-preset-overwrite": "Replace the named saved preset with the settings currently shown. This changes the stored preset; applying server settings is separate.",
    "ov-btn-preset-delete": "Remove the named saved preset after confirmation. Current server settings and downloaded model files are preserved.",
    "ov-keep-loaded": "Keep weights in memory after a completed reply so the next request avoids reloading. Turning this off releases them after the current request finishes; use Stop to cancel work.",
    "ov-top-k": "Restrict each next-token choice to the highest-ranked candidates. Smaller values narrow variety. Blank inherits the native default; accepted disabling values depend on the engine.",
    "ov-repetition-penalty": "Discourage repeated tokens; values above 1 increase the penalty. Used only when omitted by the client. Blank inherits the model default.",
    "ov-test-tokens": "Maximum output for this quick test only, including reasoning tokens. A small budget may end before an answer appears; it does not change Cline settings."
};
  for (const [id, text] of Object.entries(controlHelp)) {
    const control = _el(id);
    if (!control) continue;
    control.setAttribute('data-help-title', 'What this changes');
    control.setAttribute('data-help-text', text);
    const hint = document.createElement('span');
    hint.id = `${id}-help`;
    hint.hidden = true;
    hint.textContent = control.getAttribute('data-help-text');
    control.after(hint);
    control.setAttribute('aria-describedby', [control.getAttribute('aria-describedby'), hint.id].filter(Boolean).join(' '));
  }

  // Wire events
  for (const id of ['ov-engine', 'ov-preflight-policy']) {
    _el(id)?.addEventListener('change', () => { _dirty = true; _updateRuntimeControls(); });
  }
  _el('ov-btn-refresh-models').addEventListener('click', async () => {
    try {
      const result = await (await fetch('/api/openvino/models/refresh', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({force:true})})).json();
      if (!result.ok) throw new Error(result.error);
      await _fetchModelCatalog();
    } catch (error) { _showBanner(error.message, 'error'); }
  });
  _el('ov-show-experimental').addEventListener('change', _renderModelPicker);
  _el('ov-btn-cancel-download').addEventListener('click', async () => {
    await fetch('/api/openvino/models/download/cancel', {method:'POST'});
    await _fetchModelCatalog();
  });
  _el('ov-model-select')?.addEventListener('change', (e) => _chooseCatalogModel(e.target.value));
  _el('ov-btn-download-model')?.addEventListener('click', () => _downloadSelectedModel());
  _el('ov-host')?.addEventListener('input', () => { _dirty = true; _updateComputedUrls(); });
  _el('ov-port')?.addEventListener('input', () => { _dirty = true; _updateComputedUrls(); });

  _el('ov-copy-loaded-model')?.addEventListener('click', (e) => {
    _copyText(e.currentTarget.dataset.modelId || '', e.currentTarget);
  });
  _el('ov-copy-apikey')?.addEventListener('click', (e) => {
    _copyText(_el('ov-api-key')?.value || '', e.currentTarget);
  });
  _el('ov-copy-baseurl')?.addEventListener('click', (e) => {
    _copyText(_el('ov-base-url')?.value || '', e.currentTarget);
  });
  _el('ov-copy-modelsurl')?.addEventListener('click', (e) => {
    _copyText(_el('ov-model-source-url')?.value || '', e.currentTarget);
  });

  _el('ov-btn-server-toggle')?.addEventListener('click', () => _toggleServer());
  _el('ov-btn-kill-stray')?.addEventListener('click', () => _killStray());
  _el('ov-btn-model-toggle')?.addEventListener('click', () => _toggleModel());
  _el('ov-btn-save-apply')?.addEventListener('click', () => _saveAndApply());
  _el('ov-btn-save-card')?.addEventListener('click', () => _saveAndApply());
  _el('ov-btn-refresh')?.addEventListener('click', async () => { await _pollStatus(); await _fetchModelCatalog(); _showBanner('Status updated. This does not restart the server or change settings.', 'info'); });
  _el('ov-btn-stop-work')?.addEventListener('click', () => _stopWork());
  _el('ov-btn-preview-models')?.addEventListener('click', () => _previewV1Models());
  _el('ov-btn-send-test')?.addEventListener('click', () => _sendQuickTest());

  if (_pollTimer) clearInterval(_pollTimer);
  _pollTimer = setInterval(() => { _paintActivity(); _pollStatus(); }, 1000);
  _pollStatus();
}
