// Vectorize tab — vanilla ES6 (spec: docs/vectorize-tab-spec.md)
// Mounts into #actionPanelForm via renderVectorizeForm() (wired in app.js).
// Uses the global in/out system: input from bestInput() (top input bar),
// output dir via X-MTAPI-Output-Dir (window.globalInputs.pathOut).
import { logConsole } from '/js/preview.js?v=2';
import { bestInput } from '/app.js?v=4';

const API = '/vectorize';
let _state = { manifest: {}, engines: [], results: [] };

function el(id) { return document.getElementById(id); }
function fmtTime(s) { return (s || 0).toFixed(1) + 's'; }

async function fetchJSON(url, opts) {
  const r = await fetch(url, opts || {});
  return r.json();
}

function renderEnginePanels() {
  const box = el('v-engines');
  if (!box) return;
  box.innerHTML = _state.engines.map((e) => {
    const m = _state.manifest[e.id] || {};
    const opts = m.options || [];
    const disabled = !e.available;
    const optsHtml = opts.length ? `<details class="v-opts"><summary>Options</summary>` +
      opts.map((o) => {
        if (o.type === 'bool') {
          return `<label class="v-opt"><input type="checkbox" id="v-opt-${e.id}-${o.key}" ${o.default ? 'checked' : ''}/> ${o.key}</label>`;
        }
        if (o.type === 'select') {
          return `<label class="v-opt">${o.key}<select id="v-opt-${e.id}-${o.key}">` +
            (o.choices || []).map((c) => `<option ${c === o.default ? 'selected' : ''}>${c}</option>`).join('') +
            `</select></label>`;
        }
        return `<label class="v-opt">${o.key}<input type="number" id="v-opt-${e.id}-${o.key}" value="${o.default}" min="${o.min ?? ''}" max="${o.max ?? ''}" step="${o.step ?? (o.type === 'float' ? 0.01 : 1)}"/></label>`;
      }).join('') + `</details>` : '';
    return `<div class="v-engine-row">
      <label class="v-engine"><input type="checkbox" id="v-en-${e.id}" ${e.available ? 'checked' : ''} ${disabled ? 'disabled' : ''}/>
        <b>${e.name || e.id}</b>${disabled ? `<span class="v-bad">(${e.reason || 'unavailable'})</span>` : ''}</label>
      ${optsHtml}
    </div>`;
  }).join('');
}

function collectOptions() {
  const out = {};
  for (const [eid, m] of Object.entries(_state.manifest)) {
    const o = {};
    for (const opt of (m.options || [])) {
      const node = el(`v-opt-${eid}-${opt.key}`);
      if (!node) continue;
      if (opt.type === 'bool') o[opt.key] = node.checked;
      else if (opt.type === 'select') o[opt.key] = node.value;
      else o[opt.key] = Number(node.value);
    }
    out[eid] = o;
  }
  return out;
}

function collectEnabled() {
  return _state.engines
    .filter((e) => e.available)
    .map((e) => e.id)
    .filter((id) => { const n = el(`v-en-${id}`); return n && n.checked; });
}

function renderResults() {
  const out = el('v-results');
  if (!out) return;
  const rs = _state.results;
  if (!rs.length) { out.innerHTML = '<p class="v-empty">No results yet.</p>'; return; }
  out.innerHTML = `<div class="v-grid">` + rs.map((r) => {
    if (!r.ok) {
      return `<article class="v-card v-card-err"><h4>${r.engine_id}</h4>
        <p class="v-err">${r.error || 'failed'}</p></article>`;
    }
    const url = r.svg_url;
    return `<article class="v-card">
      <h4>${r.engine_id}</h4>
      <div class="v-preview" id="v-preview-${r.engine_id}">loading…</div>
      <div class="v-meta">${fmtTime(r.elapsed_s)} · ${r.bytes || 0} B</div>
      <a href="${url}" download="${r.engine_id}.svg">Download SVG</a>
    </article>`;
  }).join('') + `</div>`;

  // Inline-render each SVG (DOMParser + inject, per spec §4 results.js).
  rs.filter((r) => r.ok).forEach((r) => {
    const url = r.svg_url;
    fetch(url).then((resp) => resp.text()).then((txt) => {
      const host = el(`v-preview-${r.engine_id}`);
      if (host) host.innerHTML = txt;
    }).catch((e) => {
      const host = el(`v-preview-${r.engine_id}`);
      if (host) host.textContent = 'render failed: ' + e.message;
    });
  });
}

async function doRun() {
  const enabled = collectEnabled();
  if (!enabled.length) { logConsole('[vectorize] no engines enabled'); return null; }
  const headers = { 'Content-Type': 'application/json' };
  // Global output bar — same header every op sends (job-control.js).
  const out = (window.globalInputs && window.globalInputs.pathOut || '').trim();
  if (out) headers['X-MTAPI-Output-Dir'] = out;
  // Global input bar is the only input channel (repo standard).
  let inputPath = '';
  try { inputPath = (bestInput() || '').trim(); } catch (_) { inputPath = ''; }
  return fetchJSON(API + '/run', {
    method: 'POST',
    headers,
    body: JSON.stringify({ input_path: inputPath, enabled, options: collectOptions() }),
  });
}

async function init() {
  try {
    const m = await fetchJSON(API + '/manifest');
    _state.manifest = m.manifests || {};
  } catch (e) {
    logConsole(`[vectorize] manifest failed: ${e.message}`);
  }
  try {
    const s = await fetchJSON(API + '/status');
    _state.engines = s.engines || [];
    renderEnginePanels();
  } catch (e) {
    const host = el('v-engines');
    if (host) host.innerHTML = `<p class="v-err">Cannot reach server — ${e.message}</p>`;
    logConsole(`[vectorize] status failed: ${e.message}`);
  }
}

/** Mirror the global in/out bar into the tab (same UX as erase.js). */
function refreshGlobalIO() {
  const box = el('v-global-io');
  if (!box) return;
  let input = '';
  try { input = (bestInput() || '').trim(); } catch (_) { input = ''; }
  const out = ((window.globalInputs && window.globalInputs.pathOut) || '').trim();
  box.textContent =
    'Input: ' + (input || '(none — set a global input above)') +
    '  ·  Output: ' + (out || '(same folder as source)');
}

export function renderVectorizeForm() {
  const panel = document.getElementById('actionPanelForm') || document.getElementById('actionPanel');
  if (!panel) return;
  panel.innerHTML = `
    <div class="vectorize-tab">
      <h2>Vectorize · Raster → SVG</h2>
      <section class="v-io">
        <div id="v-global-io" class="v-status"></div>
      </section>
      <section class="v-engines">
        <h3>Engines</h3>
        <div id="v-engines"></div>
      </section>
      <section class="v-run">
        <button id="v-run-btn">Run enabled engines</button>
        <div id="v-run-status" class="v-status"></div>
      </section>
      <section id="v-results" class="v-results"></section>
    </div>`;

  refreshGlobalIO();
  el('v-run-btn').addEventListener('click', async () => {
    let input = '';
    try { input = (bestInput() || '').trim(); } catch (_) { input = ''; }
    if (!input) {
      el('v-run-status').textContent = 'Set a global input above.';
      return;
    }
    el('v-run-status').textContent = 'Running…';
    try {
      const res = await doRun();
      if (!res) { el('v-run-status').textContent = 'Nothing to run.'; return; }
      if (!res.ok) throw new Error(res.error || 'run failed');
      _state.results = res.results || [];
      const outNote = res.output_dir ? ` → ${res.output_dir}` : '';
      el('v-run-status').textContent = `Done — ${_state.results.length} engine(s).${outNote}`;
      renderResults();
    } catch (err) {
      el('v-run-status').textContent = 'Run error: ' + err.message;
      logConsole(`[vectorize] run error: ${err.message}`);
    }
  });

  init();
}
