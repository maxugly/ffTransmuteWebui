/** CDP Sound Tools tab — Phase 1 "run ten tools well" (spec §9).
 *
 * Menu + schema-rendered tool pages over the vendored cdp-wasm runtime.
 * Execution is client-side in a dedicated Worker (spec §7.1 path (i)); the
 * server only prepares canonical WAV inputs (limits enforced, §7.3) and
 * ingests rendered artifacts (beside the source, catalog-stamped, §6).
 *
 * Adding a tool = adding data in js/cdp/tools.js. No per-tool code here.
 */
import { state, elements, logConsole } from '/app.js?v=2';
import { escapeHtml } from '/js/utils.js';
import { CDP_VENDOR_URL, mergeTools, argvPreview } from '/js/cdp/tools.js';

let toolsCache = null;      // merged tool entries (from EFFECTS + CDP_TOOLS)
let selected = null;        // the selected tool entry
let prepared = null;        // {token, durationSec, channels, spectral, ...}
let worker = null;          // reused across runs; killed on cancel
let runSeq = 0;             // guards stale worker messages
let elapsedTimer = null;

const LS = {
  tool: 'cdp_last_tool',
  input: 'cdp_input_path',
  params: (id) => `cdp_params_${id}`,
};

function _el(id) { return document.getElementById(id); }
function _esc(s) { return escapeHtml(String(s == null ? '' : s)); }
function _log(msg, kind) { try { logConsole(msg, kind); } catch (_) { /* ignore */ } }

/* ── runtime status ─────────────────────────────────────────────────── */

async function loadRuntime() {
  // One dynamic import arms both the EFFECTS catalog and, implicitly, the
  // vendored-file presence check (a missing vendor dir fails the import).
  const mod = await import(CDP_VENDOR_URL);
  const { tools, missing } = mergeTools(mod.EFFECTS || []);
  return { tools, missing };
}

async function refreshStatus() {
  const pill = _el('cdpStatus');
  if (!pill) return;
  try {
    const res = await fetch('/api/cdp/status');
    const j = await res.json();
    if (j.ok && j.vendored) {
      pill.textContent = `cdp-wasm ${j.version} · vendored ✓`;
      pill.className = 'cdp-pill ok';
    } else {
      pill.textContent = j.hint || 'CDP runtime not vendored';
      pill.className = 'cdp-pill bad';
    }
  } catch (_) {
    pill.textContent = 'status check failed';
    pill.className = 'cdp-pill bad';
  }
}

/* ── render ─────────────────────────────────────────────────────────── */

export function renderCdpForm() {
  elements.actionPanel.innerHTML = `
    <div class="cdp-workspace">
      <div class="cdp-topbar">
        <span class="panel-title-desc dense">CDP Sound Tools — Composers Desktop Project offline transforms, in-browser</span>
        <span class="cdp-pill" id="cdpStatus">checking runtime…</span>
      </div>
      <div class="cdp-cols" id="cdpCols">
        <section class="cdp-menu card">
          <label for="cdpSearch" class="cdp-menu-label">Search tools</label>
          <input type="text" id="cdpSearch" placeholder="name, group, or tag — / focuses"
                 data-help-title="Tool search" data-help-text="Filters the menu by tool name, CDP group code, or tag. Enter opens the first hit." />
          <div class="cdp-tool-list" id="cdpToolList"></div>
        </section>
        <section class="cdp-page card" id="cdpPage">
          <div class="cdp-empty">select a tool from the menu</div>
        </section>
      </div>
    </div>`;

  selected = null;
  prepared = null;
  refreshStatus();
  loadRuntime().then(({ tools, missing }) => {
    toolsCache = tools;
    renderMenu();
    if (missing && missing.length) {
      _log(`[CDP] tools not in the vendored catalog: ${missing.join(', ')}`, 'error');
    }
    const last = localStorage.getItem(LS.tool);
    const pick = tools.find((t) => t.id === last) || tools[0];
    if (pick) selectTool(pick.id);
  }).catch(() => {
    const list = _el('cdpToolList');
    if (list) list.innerHTML = '<div class="cdp-menu-empty">runtime unavailable</div>';
    const page = _el('cdpPage');
    if (page) {
      page.innerHTML = `<div class="cdp-empty">CDP runtime not vendored.<br>
        Run <code>mtapi-project/scripts/update_cdp_wasm.sh</code>, then reload.</div>`;
    }
  });

  _el('cdpSearch')?.addEventListener('input', renderMenu);
  _el('cdpSearch')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = document.querySelector('#cdpToolList .cdp-tool:not([hidden])');
      if (first) first.click();
    }
  });
  _el('btnCdpPick')?.addEventListener('click', pickFile);
}

function renderMenu() {
  const list = _el('cdpToolList');
  if (!list || !toolsCache) return;
  const q = (_el('cdpSearch')?.value || '').trim().toLowerCase();
  list.innerHTML = '';
  let lastGroup = null;
  for (const t of toolsCache) {
    const hay = `${t.id} ${t.label} ${t.group} ${(t.tags || []).join(' ')} ${t.blurb || ''}`.toLowerCase();
    if (q && !hay.includes(q)) continue;
    if (t.group !== lastGroup) {
      lastGroup = t.group;
      const h = document.createElement('div');
      h.className = 'cdp-group-head';
      h.textContent = t.group;
      list.appendChild(h);
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cdp-tool' + (selected && selected.id === t.id ? ' active' : '');
    b.dataset.toolId = t.id;
    b.innerHTML = `${_esc(t.label)}<span class="cdp-tool-id">${_esc(t.id)}</span>`;
    b.addEventListener('click', () => selectTool(t.id));
    list.appendChild(b);
  }
  if (!list.children.length) {
    list.innerHTML = '<div class="cdp-menu-empty">no tool matches</div>';
  }
}

function selectTool(id) {
  const t = (toolsCache || []).find((x) => x.id === id);
  if (!t) return;
  selected = t;
  prepared = null;
  localStorage.setItem(LS.tool, id);
  renderMenu();
  renderToolPage();
  _log(`[CDP]: tool ${id}`);
}

function badges(t) {
  const out = [];
  if (t.kind === 'effect' && /spectral/i.test(t.group || '')) out.push('spectral · auto pvoc wrap');
  if (t.kind === 'effect') out.push('curated catalog');
  if (t.kind === 'raw') out.push('raw CDP mode');
  if (t.kind === 'info') out.push('info-only (text out)');
  if (t.mono) out.push('mono / per-channel');
  if (t.nondeterministic) out.push('nondeterministic (CDP rand)');
  if (t.inExt === 'ana' || t.outExt === 'ana') out.push('.ana spectral I/O');
  return out;
}

function renderToolPage() {
  const page = _el('cdpPage');
  if (!page || !selected) return;
  const t = selected;
  const saved = JSON.parse(localStorage.getItem(LS.params(t.id)) || '{}');
  const savedInput = localStorage.getItem(LS.input) || '';
  const paramRows = (t.params || []).map((p) => {
    const val = saved[p.name] ?? p.default;
    const slider = (p.min != null && p.max != null)
      ? `<input type="range" id="cdpP_${_esc(p.name)}_r" min="${p.min}" max="${p.max}" step="${p.step ?? 'any'}" value="${val}"
             data-help-title="${_esc(p.label)}" data-help-text="${_esc(p.help || '')}" />`
      : '';
    return `
      <div class="cdp-param" data-param="${_esc(p.name)}">
        <label for="cdpP_${_esc(p.name)}">${_esc(p.label)}</label>
        <div class="cdp-param-ctl">
          <input type="number" id="cdpP_${_esc(p.name)}" value="${val}"
                 ${p.min != null ? `min="${p.min}"` : ''} ${p.max != null ? `max="${p.max}"` : ''}
                 step="${p.step ?? 'any'}"
                 data-help-title="${_esc(p.label)}" data-help-text="${_esc(p.help || '')}" />
          ${slider}
        </div>
      </div>`;
  }).join('');

  page.innerHTML = `
    <div class="cdp-tool-head">
      <h3>${_esc(t.label)}</h3>
      <span class="cdp-tool-group">${_esc(t.group)}</span>
    </div>
    <p class="cdp-blurb">${_esc(t.blurb)}</p>
    <div class="cdp-badges">${badges(t).map((b) => `<span class="cdp-badge">${_esc(b)}</span>`).join('')}</div>

    <div class="cdp-field">
      <label for="cdpInput">Input file ${t.inExt === 'ana' ? '(.ana spectral)' : '(audio)'}</label>
      <div class="cdp-input-row">
        <input type="text" id="cdpInput" placeholder="/absolute/path/to/sound.wav" value="${_esc(savedInput)}"
               data-help-title="Input path" data-help-text="Absolute path. The server validates it against the Phase-1 limits (≤60 s, ≤200 MB decoded) and decodes it to canonical 44.1 kHz WAV for the browser." />
        <button type="button" class="btn" id="btnCdpPick" data-help-title="Browse" data-help-text="Open the in-app file picker.">Browse…</button>
        <button type="button" class="btn" id="btnCdpPrepare" data-help-title="Prepare" data-help-text="Validate the input and decode it for the Worker. The numbers shown are the real probe values.">Prepare</button>
      </div>
      <div class="cdp-prepare-note" id="cdpPrepNote">not prepared</div>
    </div>

    ${t.params && t.params.length ? `<div class="cdp-params">${paramRows}</div>` : '<div class="cdp-params"></div>'}

    <div class="cdp-usage">
      <span class="cdp-usage-label">CDP usage</span>
      <code id="cdpUsage">${_esc(t.usage)}</code>
    </div>
    <div class="cdp-usage">
      <span class="cdp-usage-label">Raw argv</span>
      <code id="cdpArgv"></code>
    </div>

    <div class="cdp-run-row">
      <button type="button" class="btn primary" id="btnCdpRun" data-help-title="Run" data-help-text="Render in the browser Worker. Long renders show elapsed time; cancel kills the Worker between stages and keeps finished artifacts.">Run</button>
      <button type="button" class="btn" id="btnCdpCancel" style="display:none" data-help-title="Cancel" data-help-text="Terminate the Worker. Nothing partial is saved; already-ingested outputs survive.">Cancel</button>
      <span class="cdp-progress" id="cdpProgress"></span>
    </div>
    <div class="cdp-result" id="cdpResult"></div>`;

  page.querySelectorAll('.cdp-param input[type=number]').forEach((inp) => {
    inp.addEventListener('input', () => {
      syncSlider(inp);
      saveParams();
      updateArgvPreview();
    });
  });
  page.querySelectorAll('.cdp-param input[type=range]').forEach((r) => {
    r.addEventListener('input', () => {
      const num = _el(`cdpP_${r.id.replace('cdpP_', '').replace('_r', '')}`);
      if (num) { num.value = r.value; saveParams(); updateArgvPreview(); }
    });
  });
  _el('cdpInput')?.addEventListener('change', () => {
    localStorage.setItem(LS.input, _el('cdpInput').value.trim());
    prepared = null;
    const note = _el('cdpPrepNote');
    if (note) note.textContent = 'not prepared';
  });
  _el('btnCdpPick')?.addEventListener('click', pickFile);
  _el('btnCdpPrepare')?.addEventListener('click', prepareInput);
  _el('btnCdpRun')?.addEventListener('click', runTool);
  _el('btnCdpCancel')?.addEventListener('click', cancelRun);
  updateArgvPreview();
}

/* ── params ─────────────────────────────────────────────────────────── */

function collectValues() {
  const vals = {};
  if (!selected) return vals;
  for (const p of selected.params || []) {
    const raw = _el(`cdpP_${p.name}`)?.value;
    vals[p.name] = raw === '' || raw == null ? p.default : Number(raw);
  }
  return vals;
}

function saveParams() {
  if (!selected) return;
  localStorage.setItem(LS.params(selected.id), JSON.stringify(collectValues()));
}

function syncSlider(numInput) {
  const r = _el(`cdpP_${numInput.id.replace('cdpP_', '')}_r`);
  if (r) r.value = numInput.value;
}

function updateArgvPreview() {
  const code = _el('cdpArgv');
  if (!code || !selected) return;
  const argv = argvPreview(selected, collectValues());
  code.textContent = JSON.stringify(argv);
}

/* ── input prepare ──────────────────────────────────────────────────── */

async function pickFile() {
  const res = await fetch('/api/picker?mode=file');
  if (!res.ok) return;
  const data = await res.json();
  if (!data.path) return;
  const input = _el('cdpInput');
  if (input) {
    input.value = data.path;
    localStorage.setItem(LS.input, data.path);
    prepared = null;
    const note = _el('cdpPrepNote');
    if (note) note.textContent = 'not prepared';
  }
}

async function prepareInput() {
  const note = _el('cdpPrepNote');
  const btn = _el('btnCdpPrepare');
  const path = (_el('cdpInput')?.value || '').trim();
  if (!path) { if (note) note.textContent = 'set an input path first'; return; }
  localStorage.setItem(LS.input, path);
  if (btn) btn.disabled = true;
  if (note) note.textContent = 'probing + decoding…';
  try {
    const res = await fetch('/api/cdp/prepare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    const j = await res.json();
    if (!j.ok) {
      prepared = null;
      if (note) { note.textContent = j.error; note.className = 'cdp-prepare-note bad'; }
      _log(`[CDP]: prepare refused — ${j.error}`, 'error');
      return;
    }
    prepared = j;
    if (note) {
      note.className = 'cdp-prepare-note ok';
      note.textContent = j.spectral
        ? `spectral input ready · ${(j.decodedBytes / 1048576).toFixed(1)} MB pass-through`
        : `ready · ${j.durationSec} s · ${j.channels} ch · ${j.sampleRate} Hz · decoded ${(j.decodedBytes / 1048576).toFixed(1)} MB`;
    }
    // Mono-only raw tools cannot take stereo (measured: pvoc anal refuses it).
    if (selected && selected.kind === 'raw' && selected.mono && !j.spectral && j.channels > 1) {
      if (note) {
        note.className = 'cdp-prepare-note bad';
        note.textContent = `${j.channels} ch input — ${selected.id} is mono-only; mix down first`;
      }
    }
    _log(`[CDP]: prepared ${path} (${j.spectral ? 'spectral pass-through' : `${j.durationSec}s ${j.channels}ch`})`);
  } catch (e) {
    if (note) { note.textContent = String(e.message || e); note.className = 'cdp-prepare-note bad'; }
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* ── run / cancel ───────────────────────────────────────────────────── */

function setRunning(on, stageText) {
  const run = _el('btnCdpRun');
  const cancel = _el('btnCdpCancel');
  const prog = _el('cdpProgress');
  if (run) run.disabled = on;
  if (cancel) cancel.style.display = on ? '' : 'none';
  if (prog) prog.textContent = on ? (stageText || '') : '';
  if (on) {
    const started = Date.now();
    elapsedTimer = setInterval(() => {
      if (prog) prog.textContent = `${stageText || 'rendering'} · ${((Date.now() - started) / 1000).toFixed(0)} s`;
    }, 500);
  } else if (elapsedTimer) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
}

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker('/js/cdp/worker.js', { type: 'module' });
  return worker;
}

async function runTool() {
  if (!selected) return;
  if (!prepared) {
    const note = _el('cdpPrepNote');
    if (note) note.textContent = 'run Prepare first';
    return;
  }
  const t = selected;
  const runId = ++runSeq;
  const result = _el('cdpResult');
  if (result) result.innerHTML = '';
  setRunning(true, 'starting worker');
  _log(`[CDP]: run ${t.id}`);
  const w = ensureWorker();
  w.onmessage = (ev) => {
    const d = ev.data || {};
    if (d.runId !== runId) return; // stale message from a cancelled run
    if (d.type === 'stage') {
      const prog = _el('cdpProgress');
      if (prog) prog.dataset.stage = d.stage;
      setRunning(true, d.detail || d.stage);
    } else if (d.type === 'done') {
      setRunning(false);
      showAudioResult(d);
      _log(`[CDP]: ${t.id} → ${d.path} (${(d.size / 1048576).toFixed(2)} MB, ${(d.ms / 1000).toFixed(1)} s)`);
    } else if (d.type === 'done-info') {
      setRunning(false);
      showInfoResult(d);
      _log(`[CDP]: ${t.id} info read (${(d.ms / 1000).toFixed(1)} s)`);
    } else if (d.type === 'error') {
      setRunning(false);
      if (result) {
        result.innerHTML = `<div class="cdp-error">render failed: ${_esc(d.message)}</div>`;
      }
      _log(`[CDP]: ${t.id} failed — ${d.message}`, 'error');
    }
  };
  w.onerror = (e) => {
    setRunning(false);
    if (result) result.innerHTML = `<div class="cdp-error">worker error: ${_esc(e.message || 'unknown')}</div>`;
    _log(`[CDP]: worker error — ${e.message || 'unknown'}`, 'error');
  };
  // The full EFFECTS entry carries function-valued source-relative params
  // (0.7.0 srcMin/srcDefault) — un-cloneable via postMessage, and the Worker
  // re-looks the entry up in its own catalog anyway. Send only the shape.
  const slim = {
    id: t.id, kind: t.kind, program: t.program,
    argv: t.argv, inExt: t.inExt, outExt: t.outExt,
  };
  w.postMessage({ cmd: 'run', runId, tool: slim, values: collectValues(), token: prepared.token });
}

function cancelRun() {
  if (worker) {
    worker.terminate();
    worker = null;
  }
  setRunning(false);
  const result = _el('cdpResult');
  if (result) result.innerHTML = '<div class="cdp-cancelled">cancelled — finished artifacts (already saved) survive</div>';
  _log('[CDP]: run cancelled (worker terminated)', 'error');
}

function showAudioResult(d) {
  const result = _el('cdpResult');
  if (!result) return;
  const ext = d.path.toLowerCase().endsWith('.ana') ? 'ana' : 'wav';
  if (ext === 'ana') {
    result.innerHTML = `
      <div class="cdp-out">
        <div class="cdp-out-path" title="${_esc(d.path)}">${_esc(d.path)}</div>
        <div class="cdp-out-meta">${(d.size / 1048576).toFixed(2)} MB · spectral .ana — not listenable; run <code>pvoc.synth</code> on it</div>
      </div>`;
    return;
  }
  result.innerHTML = `
    <div class="cdp-out">
      <div class="cdp-out-path" title="${_esc(d.path)}">${_esc(d.path)}</div>
      <div class="cdp-out-meta">${(d.size / 1048576).toFixed(2)} MB · render ${(d.ms / 1000).toFixed(1)} s
        · ${d.catalogStamped ? '✦ stamped in Media Catalog (generated)' : '<span title="' + _esc(d.catalogError || '') + '">catalog stamp skipped</span>'}</div>
      <audio controls src="/api/video?path=${encodeURIComponent(d.path)}"></audio>
    </div>`;
}

function showInfoResult(d) {
  const result = _el('cdpResult');
  if (!result) return;
  result.innerHTML = `
    <div class="cdp-out">
      <div class="cdp-out-meta">info output · exit ${d.exitCode}</div>
      <pre class="cdp-info-text">${_esc(d.stdout)}</pre>
    </div>`;
}
