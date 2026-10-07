/** CDP Sound Tools tab — Phase 2 (spec: docs/cdp-integration-spec.md §3, §5, §9).
 *
 * Two modes over one menu:
 *   Tool     — single tool page (Phase-1 surface, now over the FULL catalog:
 *              232 curated effects + raw programs with verbatim man usage)
 *   Pipeline — linear chain builder (§5.2–5.4): ordered steps, bypass/reorder,
 *              multi-input steps, per-step artifacts, schema-versioned save/load.
 *
 * Execution is client-side in a dedicated Worker; the server only prepares
 * canonical WAV inputs (limits enforced, §7.3) and ingests artifacts (§6).
 * Favorites/recents/pipeline autosave live in localStorage (server mirror is
 * the settings route's business, not this tab's).
 */
import { state, elements, logConsole } from '/app.js?v=2';
import { escapeHtml } from '/js/utils.js';
import {
  CDP_VENDOR_URL, CDP_MAN_URL, buildCatalog, argvPreview, parseManUsage,
} from '/js/cdp/tools.js';
import {
  newPipeline, newStep, stepInType, stepOutType,
  validatePipeline, slimStep, pipelineToJSON, pipelineFromJSON,
} from '/js/cdp/pipeline.js';

const MANIFEST_URL = '/vendor/cdp-wasm-0.7.0/wasm/manifest.json';

let catalog = { curated: [], raw: [], missing: [] };
let toolsById = new Map();       // id -> merged entry (curated + raw)
let rawPrograms = [];            // manifest program list (generic raw runner)
let mode = 'tool';               // 'tool' | 'pipeline'
let selected = null;             // tool entry (tool mode)
let selectedRawProg = null;      // {program, usage} (tool mode, generic raw)
let prepared = null;             // single-tool token bundle
let favs = new Set();            // tool ids
let recents = [];                // tool ids, most recent first
let pipeline = null;             // pipeline model
let pipelineTokens = null;       // {main, in2}
let pipelinePrepNote = '';       // real numbers from the last successful prepare
let worker = null;
let runSeq = 0;
let elapsedTimer = null;

const LS = {
  tool: 'cdp_last_tool', input: 'cdp_input_path',
  favs: 'cdp_favs', recents: 'cdp_recents',
  pipeline: 'cdp_pipeline_autosave',
  params: (id) => `cdp_params_${id}`,
};

function _el(id) { return document.getElementById(id); }
function _esc(s) { return escapeHtml(String(s == null ? '' : s)); }
function _log(msg, kind) { try { logConsole(msg, kind); } catch (_) { /* ignore */ } }

/* ── boot / render ──────────────────────────────────────────────────── */

async function loadRuntime() {
  const mod = await import(CDP_VENDOR_URL);
  catalog = buildCatalog(mod.EFFECTS || []);
  toolsById = new Map([...catalog.curated, ...catalog.raw].map((t) => [t.id, t]));
  // bpCapable: params the wrapper accepts as time-varying envelopes (§4.1)
  const bp = mod.ENVELOPE_PARAMS || {};
  for (const t of catalog.curated) {
    t.bpParams = bp[t.id] || [];
  }
  try {
    const res = await fetch(MANIFEST_URL);
    const man = await res.json();
    rawPrograms = man.programs || [];
  } catch (_) { rawPrograms = []; }
}

export function renderCdpForm() {
  favs = new Set(JSON.parse(localStorage.getItem(LS.favs) || '[]'));
  recents = JSON.parse(localStorage.getItem(LS.recents) || '[]');
  pipeline = null;
  pipelineTokens = null;
  selected = null;
  selectedRawProg = null;
  prepared = null;

  elements.actionPanel.innerHTML = `
    <div class="cdp-workspace">
      <div class="cdp-topbar">
        <span class="panel-title-desc dense">CDP Sound Tools — Composers Desktop Project offline transforms, in-browser</span>
        <span class="cdp-modes">
          <button type="button" class="btn cdp-mode active" id="cdpModeTool" data-help-title="Tool mode" data-help-text="Run one tool with its full parameter form.">Tool</button>
          <button type="button" class="btn cdp-mode" id="cdpModePipe" data-help-title="Pipeline mode" data-help-text="Build a linear chain: each step renders, its artifact is saved, and the next step feeds on it.">Pipeline</button>
        </span>
        <span class="cdp-pill" id="cdpStatus">checking runtime…</span>
        <span class="cdp-native-group" id="cdpNativeGroup">
          <span class="cdp-pill" id="cdpNativeStatus">checking native CLI…</span>
          <a href="https://github.com/ComposersDesktop/CDP8" target="_blank" rel="noopener" class="cdp-gh-link" data-help-title="CDP8 GitHub" data-help-text="Official Composers Desktop Project Release 8 repository on GitHub">GitHub</a>
        </span>
      </div>
      <div class="cdp-cols" id="cdpCols">
        <section class="cdp-menu card">
          <label for="cdpSearch" class="cdp-menu-label">Search <span id="cdpMenuCount"></span></label>
          <input type="text" id="cdpSearch" placeholder="name, group, or tag — Enter opens first hit"
                 data-help-title="Tool search" data-help-text="Filters the whole catalog: curated effects, raw modes, and raw programs." />
          <div class="cdp-tool-list" id="cdpToolList"></div>
        </section>
        <section class="cdp-page card" id="cdpPage">
          <div class="cdp-empty">loading catalog…</div>
        </section>
      </div>
    </div>`;

  refreshStatus();
  _el('cdpSearch')?.addEventListener('input', renderMenu);
  _el('cdpSearch')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = document.querySelector('#cdpToolList .cdp-tool:not([hidden])');
      if (first) first.click();
    }
  });
  _el('cdpModeTool')?.addEventListener('click', () => setMode('tool'));
  _el('cdpModePipe')?.addEventListener('click', () => setMode('pipeline'));

  loadRuntime().then(() => {
    refreshStatus();
    renderMenu();
    if (catalog.missing.length) {
      _log(`[CDP] catalog drift: ${catalog.missing.join(', ')}`, 'error');
    }
    // Deep Dive hands off here: "Open in CDP pipeline mode" lands the tab in
    // pipeline mode with the echoed chain already autosaved.
    if (localStorage.getItem('cdp_start_mode') === 'pipeline') {
      localStorage.removeItem('cdp_start_mode');
      setMode('pipeline');
      return;
    }
    if (mode === 'pipeline') { setMode('pipeline'); return; }
    const last = localStorage.getItem(LS.tool);
    const pick = toolsById.get(last);
    if (pick) selectTool(pick.id);
    else renderToolEmpty();
  }).catch(() => {
    const list = _el('cdpToolList');
    if (list) list.innerHTML = '<div class="cdp-menu-empty">runtime unavailable</div>';
    const page = _el('cdpPage');
    if (page) {
      page.innerHTML = `<div class="cdp-empty">CDP runtime not vendored.<br>
        Run <code>mtapi-project/scripts/update_cdp_wasm.sh</code>, then reload.</div>`;
    }
  });
}

function setMode(m) {
  mode = m;
  _el('cdpModeTool')?.classList.toggle('active', m === 'tool');
  _el('cdpModePipe')?.classList.toggle('active', m === 'pipeline');
  _el('cdpMenuCount').textContent = m === 'pipeline' ? ' — click a tool to add a step' : '';
  if (m === 'pipeline') {
    if (!pipeline) {
      pipeline = newPipeline();
      const saved = localStorage.getItem(LS.pipeline);
      if (saved) {
        try { pipeline = pipelineFromJSON(saved); } catch (_) { /* fresh */ }
      }
    }
    pipelineTokens = null;
    renderPipelinePage();
  } else if (selected) {
    renderToolPage();
  } else {
    renderToolEmpty();
  }
  _log(`[CDP]: mode ${m}`);
}

function renderToolEmpty() {
  const page = _el('cdpPage');
  if (page) page.innerHTML = '<div class="cdp-empty">select a tool from the menu</div>';
}

async function refreshStatus() {
  const pill = _el('cdpStatus');
  if (pill) {
    try {
      const j = await (await fetch('/api/cdp/status')).json();
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
  await refreshNativeStatus();
}

async function refreshNativeStatus() {
  const container = _el('cdpNativeStatus');
  if (!container) return;
  try {
    const j = await (await fetch('/api/cdp/native-status')).json();
    if (j.ok && j.installed) {
      container.textContent = `Native CLI ✓ (${j.toolCount} tools)`;
      container.className = 'cdp-pill ok';
    } else {
      container.className = 'cdp-native-install-wrap';
      container.innerHTML = `<button type="button" class="btn btn-sm cdp-btn-install" id="btnCdpInstallNative" data-help-title="Install Native CDP" data-help-text="Build and install full ~500 tool native CDP8 CLI suite into ~/.local/share/cdp with launcher ~/.local/bin/cdp">Install Native CDP8 (500+ tools)</button>`;
      _el('btnCdpInstallNative')?.addEventListener('click', installNativeCdp);
    }
  } catch (_) {
    container.textContent = 'native CLI check failed';
    container.className = 'cdp-pill bad';
  }
}

async function installNativeCdp() {
  const btn = _el('btnCdpInstallNative');
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = 'Building & installing CDP8…';
  try {
    const res = await (await fetch('/api/cdp/native-install', { method: 'POST' })).json();
    if (res.ok && res.installed) {
      _log(`[CDP] Native CLI installed: ${res.toolCount} tools ready at ${res.launcher}`);
      await refreshNativeStatus();
    } else {
      _log(`[CDP] Native install failed: ${res.error || 'unknown error'}`, 'error');
      btn.disabled = false;
      btn.textContent = 'Install failed (Retry)';
    }
  } catch (err) {
    _log(`[CDP] Native install error: ${err.message}`, 'error');
    btn.disabled = false;
    btn.textContent = 'Install failed (Retry)';
  }
}

/* ── menu ───────────────────────────────────────────────────────────── */

function renderMenu() {
  const list = _el('cdpToolList');
  if (!list) return;
  const q = (_el('cdpSearch')?.value || '').trim().toLowerCase();
  list.innerHTML = '';

  // span, not button: rows are <button>s and nested buttons are invalid HTML
  const star = (id) => `<span class="cdp-star${favs.has(id) ? ' on' : ''}" data-fav="${_esc(id)}" role="button" title="favorite">★</span>`;
  const row = (t) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cdp-tool' + ((mode === 'tool' && selected && selected.id === t.id) ? ' active' : '');
    b.dataset.toolId = t.id;
    b.innerHTML = `${star(t.id)}<span class="cdp-tool-label">${_esc(t.label)}</span><span class="cdp-tool-id">${_esc(t.id)}</span>`;
    b.addEventListener('click', (e) => {
      if (e.target.closest('.cdp-star')) { toggleFav(t.id); return; }
      if (mode === 'pipeline') addStepToPipeline(t);
      else if (t.kind === 'effect' || t.kind === 'raw' || t.kind === 'info') selectTool(t.id);
    });
    return b;
  };

  const match = (t) => !q || `${t.id} ${t.label} ${t.group} ${(t.tags || []).join(' ')} ${t.blurb || ''}`.toLowerCase().includes(q);
  const curated = catalog.curated.filter(match);
  const raw = catalog.raw.filter(match);

  const section = (label) => {
    const h = document.createElement('div');
    h.className = 'cdp-group-head';
    h.textContent = label;
    list.appendChild(h);
  };

  if (favs.size) {
    section('★ favorites');
    const favTools = [...favs].map((id) => toolsById.get(id)).filter(Boolean).filter(match);
    favTools.forEach((t) => list.appendChild(row(t)));
  }
  if (recents.length) {
    section('⏱ recent');
    recents.slice(0, 8).map((id) => toolsById.get(id)).filter(Boolean).filter(match)
      .forEach((t) => list.appendChild(row(t)));
  }

  // Curated: category → program → modes (L1 → L2 → L3)
  let lastCat = null, lastProg = null;
  for (const t of curated) {
    if (t.group !== lastCat) {
      lastCat = t.group; lastProg = null;
      const h = document.createElement('div');
      h.className = 'cdp-group-head cat';
      h.textContent = t.group;
      list.appendChild(h);
    }
    if (t.program !== lastProg) {
      lastProg = t.program;
      const h = document.createElement('div');
      h.className = 'cdp-prog-head';
      h.textContent = t.program;
      list.appendChild(h);
    }
    list.appendChild(row(t));
  }

  if (raw.length) {
    section('raw modes (disclosed)');
    raw.forEach((t) => list.appendChild(row(t)));
  }

  // Generic raw programs from the build manifest (man-page usage)
  const rawProgs = q ? rawPrograms.filter((p) => p.includes(q)) : rawPrograms;
  if (rawProgs.length) {
    section(`raw programs (${rawProgs.length} — verbatim man usage)`);
    for (const p of rawProgs) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cdp-tool rawprog';
      b.dataset.rawProg = p;
      b.innerHTML = `<span class="cdp-tool-label">${_esc(p)}</span><span class="cdp-tool-id">raw · 1-in/1-out</span>`;
      b.addEventListener('click', () => { if (mode === 'tool') selectRawProgram(p); });
      list.appendChild(b);
    }
  }

  const count = _el('cdpMenuCount');
  if (count && q) count.textContent = `· ${curated.length + raw.length + rawProgs.length} hits`;
  if (!list.children.length) list.innerHTML = '<div class="cdp-menu-empty">no tool matches</div>';
}

function toggleFav(id) {
  if (favs.has(id)) favs.delete(id); else favs.add(id);
  localStorage.setItem(LS.favs, JSON.stringify([...favs]));
  renderMenu();
}

function pushRecent(id) {
  recents = [id, ...recents.filter((x) => x !== id)].slice(0, 15);
  localStorage.setItem(LS.recents, JSON.stringify(recents));
  renderMenu();
}

/* ── tool mode: full form ───────────────────────────────────────────── */

function selectTool(id) {
  const t = toolsById.get(id);
  if (!t) return;
  selected = t;
  selectedRawProg = null;
  prepared = null;
  localStorage.setItem(LS.tool, id);
  renderMenu();
  renderToolPage();
  _log(`[CDP]: tool ${id}`);
}

async function selectRawProgram(program) {
  selected = null;
  selectedRawProg = { program, usage: '', args: '' };
  prepared = null;
  renderMenu();
  const page = _el('cdpPage');
  page.innerHTML = `<div class="cdp-empty">fetching man page…</div>`;
  let usage = '';
  try {
    const res = await fetch(CDP_MAN_URL(program));
    usage = parseManUsage(await res.text());
  } catch (_) { usage = ''; }
  selectedRawProg.usage = usage;
  renderRawProgramPage();
}

function badges(t) {
  const out = [];
  if (t.kind === 'effect' && t.spectral) out.push('spectral · auto pvoc wrap');
  if (t.kind === 'effect') out.push('curated catalog');
  if (t.kind === 'raw') out.push('raw CDP mode');
  if (t.kind === 'info') out.push('info-only (text out)');
  if (t.inputs2) out.push('2-input (uses Input 2)');
  if (t.mono) out.push('mono / per-channel');
  if (t.nondeterministic) out.push('nondeterministic (CDP rand)');
  if (t.inExt === 'ana' || t.outExt === 'ana') out.push('.ana spectral I/O');
  return out;
}

function paramRow(p, val) {
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
}

function renderToolPage() {
  const page = _el('cdpPage');
  if (!page || !selected) return;
  const t = selected;
  const saved = JSON.parse(localStorage.getItem(LS.params(t.id)) || '{}');
  const savedInput = localStorage.getItem(LS.input) || '';
  const paramRows = (t.params || []).map((p) => paramRow(p, saved[p.name] ?? p.default)).join('');
  const bpRows = (t.bpParams || []).map((name) => `
    <div class="cdp-bp" data-bp="${_esc(name)}">
      <label class="cdp-bp-toggle">
        <input type="checkbox" id="cdpBpOn_${_esc(name)}" />
        envelope on <code>${_esc(name)}</code>
      </label>
      <textarea id="cdpBp_${_esc(name)}" rows="3" style="display:none" spellcheck="false"
        placeholder="time value per line, e.g.&#10;0 1&#10;2 0.5"
        data-help-title="Breakpoint envelope for ${_esc(name)}" data-help-text="Time-varying values in CDP breakpoint text format: one 'time value' pair per line, times increasing. Passed to CDP verbatim."></textarea>
    </div>`).join('');
  const starOn = favs.has(t.id);

  page.innerHTML = `
    <div class="cdp-tool-head">
      <h3>${_esc(t.label)}</h3>
      <span class="cdp-tool-group">${_esc(t.group)}</span>
      <button type="button" class="cdp-star big${starOn ? ' on' : ''}" id="cdpFavBtn" title="favorite">★</button>
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
    ${t.inputs2 ? `
    <div class="cdp-field">
      <label for="cdpInput2">Input 2 — second source (${_esc(t.label)})</label>
      <div class="cdp-input-row">
        <input type="text" id="cdpInput2" placeholder="/absolute/path/to/second.wav"
               data-help-title="Second input" data-help-text="Two-input tools (morph, vocode, combine…) analyse or mix this against the main input." />
        <button type="button" class="btn" id="btnCdpPick2" data-help-title="Browse second input" data-help-text="Open the in-app file picker for the second input.">Browse…</button>
      </div>
    </div>` : ''}

    ${t.params && t.params.length ? `<div class="cdp-params">${paramRows}${bpRows}</div>` : `<div class="cdp-params">${bpRows}</div>`}

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
    inp.addEventListener('input', () => { syncSlider(inp); saveParams(); updateArgvPreview(); });
  });
  page.querySelectorAll('.cdp-param input[type=range]').forEach((r) => {
    r.addEventListener('input', () => {
      const num = _el(r.id.replace('_r', ''));
      if (num) { num.value = r.value; saveParams(); updateArgvPreview(); }
    });
  });
  (t.bpParams || []).forEach((name) => {
    _el(`cdpBpOn_${name}`)?.addEventListener('change', (e) => {
      const ta = _el(`cdpBp_${name}`);
      if (ta) {
        ta.style.display = e.target.checked ? '' : 'none';
        if (e.target.checked && !ta.value) {
          const v = collectValues()[name];
          ta.value = `0 ${v != null ? v : 1}\n1 ${v != null ? v : 1}`;
        }
      }
    });
  });
  _el('cdpInput')?.addEventListener('change', () => {
    localStorage.setItem(LS.input, _el('cdpInput').value.trim());
    prepared = null;
    const note = _el('cdpPrepNote');
    if (note) { note.textContent = 'not prepared'; note.className = 'cdp-prepare-note'; }
  });
  _el('cdpFavBtn')?.addEventListener('click', () => toggleFav(t.id));
  _el('btnCdpPick')?.addEventListener('click', () => pickFile('cdpInput'));
  _el('btnCdpPick2')?.addEventListener('click', () => pickFile('cdpInput2'));
  _el('btnCdpPrepare')?.addEventListener('click', prepareInput);
  _el('btnCdpRun')?.addEventListener('click', runTool);
  _el('btnCdpCancel')?.addEventListener('click', cancelRun);
  updateArgvPreview();
}

function renderRawProgramPage() {
  const page = _el('cdpPage');
  if (!page || !selectedRawProg) return;
  const rp = selectedRawProg;
  page.innerHTML = `
    <div class="cdp-tool-head">
      <h3>${_esc(rp.program)}</h3>
      <span class="cdp-tool-group">raw program</span>
    </div>
    <p class="cdp-blurb">Generic raw runner: one soundfile in, one out, arguments passed through to CDP untouched (zero-interpretation passthrough). Type the arguments exactly as the usage line shows — file tokens stay as <code>$IN</code>/<code>$OUT</code>.</p>
    ${rp.usage ? `<div class="cdp-usage verbatim"><span class="cdp-usage-label">man usage</span><pre class="cdp-man-usage">${_esc(rp.usage)}</pre></div>` : '<div class="cdp-prepare-note">no man page vendored for this program — check the CDP manual</div>'}
    <div class="cdp-field">
      <label for="cdpRawArgs">Arguments (after the program name)</label>
      <input type="text" id="cdpRawArgs" spellcheck="false" placeholder="mode … $IN $OUT …" value="${_esc(rp.args)}"
             data-help-title="Raw arguments" data-help-text="Whitespace-split argument list. $IN and $OUT are the staged input and output paths." />
    </div>
    <div class="cdp-field">
      <label for="cdpInput">Input file (audio)</label>
      <div class="cdp-input-row">
        <input type="text" id="cdpInput" placeholder="/absolute/path/to/sound.wav" />
        <button type="button" class="btn" id="btnCdpPick" data-help-title="Browse" data-help-text="Open the in-app file picker.">Browse…</button>
        <button type="button" class="btn" id="btnCdpPrepare" data-help-title="Prepare" data-help-text="Validate and decode the input.">Prepare</button>
      </div>
      <div class="cdp-prepare-note" id="cdpPrepNote">not prepared</div>
    </div>
    <div class="cdp-run-row">
      <button type="button" class="btn primary" id="btnCdpRun" data-help-title="Run" data-help-text="Run the raw program in the Worker.">Run</button>
      <button type="button" class="btn" id="btnCdpCancel" style="display:none">Cancel</button>
      <span class="cdp-progress" id="cdpProgress"></span>
    </div>
    <div class="cdp-result" id="cdpResult"></div>`;

  _el('cdpRawArgs')?.addEventListener('input', () => { selectedRawProg.args = _el('cdpRawArgs').value; });
  _el('btnCdpPick')?.addEventListener('click', () => pickFile('cdpInput'));
  _el('btnCdpPrepare')?.addEventListener('click', prepareInput);
  _el('btnCdpRun')?.addEventListener('click', runRawProgram);
  _el('btnCdpCancel')?.addEventListener('click', cancelRun);
}

/* ── params / argv ──────────────────────────────────────────────────── */

function collectValues() {
  const vals = {};
  if (!selected) return vals;
  for (const p of selected.params || []) {
    const raw = _el(`cdpP_${p.name}`)?.value;
    vals[p.name] = raw === '' || raw == null ? p.default : Number(raw);
  }
  return vals;
}

function collectBrk() {
  const brk = {};
  if (!selected || !selected.bpParams) return brk;
  for (const name of selected.bpParams) {
    if (_el(`cdpBpOn_${name}`)?.checked) {
      const text = (_el(`cdpBp_${name}`)?.value || '').trim();
      if (text) brk[name] = text;
    }
  }
  return brk;
}

function saveParams() {
  if (!selected) return;
  localStorage.setItem(LS.params(selected.id), JSON.stringify(collectValues()));
}

function syncSlider(numInput) {
  const r = _el(`${numInput.id}_r`);
  if (r) r.value = numInput.value;
}

function updateArgvPreview() {
  const code = _el('cdpArgv');
  if (!code || !selected) return;
  const argv = argvPreview(selected, collectValues());
  code.textContent = JSON.stringify(argv);
}

/* ── input prepare ──────────────────────────────────────────────────── */

async function pickFile(targetId) {
  const res = await fetch('/api/picker?mode=file');
  if (!res.ok) return;
  const data = await res.json();
  if (!data.path) return;
  const input = _el(targetId);
  if (input) {
    input.value = data.path;
    if (targetId === 'cdpInput') {
      localStorage.setItem(LS.input, data.path);
      prepared = null;
      const note = _el('cdpPrepNote');
      if (note) { note.textContent = 'not prepared'; note.className = 'cdp-prepare-note'; }
    }
  }
}

async function preparePath(path, noteEl) {
  const res = await fetch('/api/cdp/prepare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  const j = await res.json();
  if (!j.ok && noteEl) {
    noteEl.textContent = j.error;
    noteEl.className = 'cdp-prepare-note bad';
    _log(`[CDP]: prepare refused — ${j.error}`, 'error');
  }
  return j;
}

async function prepareInput() {
  const note = _el('cdpPrepNote');
  const btn = _el('btnCdpPrepare');
  const path = (_el('cdpInput')?.value || '').trim();
  if (!path) { if (note) note.textContent = 'set an input path first'; return; }
  localStorage.setItem(LS.input, path);
  if (btn) btn.disabled = true;
  if (note) { note.textContent = 'probing + decoding…'; note.className = 'cdp-prepare-note'; }
  try {
    const j = await preparePath(path, note);
    if (!j.ok) { prepared = null; return; }
    prepared = { main: j };
    if (note) {
      note.className = 'cdp-prepare-note ok';
      note.textContent = j.spectral
        ? `spectral input ready · ${(j.decodedBytes / 1048576).toFixed(1)} MB pass-through`
        : `ready · ${j.durationSec} s · ${j.channels} ch · ${j.sampleRate} Hz · decoded ${(j.decodedBytes / 1048576).toFixed(1)} MB`;
    }
    if (selected && selected.kind === 'raw' && selected.mono && !j.spectral && j.channels > 1) {
      note.className = 'cdp-prepare-note bad';
      note.textContent = `${j.channels} ch input — ${selected.id} is mono-only; mix down first`;
    }
    _log(`[CDP]: prepared ${path}`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* ── run / cancel (tool + raw program) ──────────────────────────────── */

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

async function prepareIfNeeded() {
  if (prepared) return prepared;
  await prepareInput();
  return prepared;
}

async function runTool() {
  if (!selected) return;
  const t = selected;
  if (!prepared) {
    await prepareIfNeeded();
    if (!prepared) return;
  }
  const note = _el('cdpPrepNote');
  if (t.kind === 'raw' && t.mono && prepared.main && prepared.main.channels > 1) {
    if (note) { note.className = 'cdp-prepare-note bad'; note.textContent = `${prepared.main.channels} ch input — ${t.id} is mono-only; mix down first`; }
    return;
  }
  pushRecent(t.id);
  const runId = ++runSeq;
  const result = _el('cdpResult');
  if (result) result.innerHTML = '';
  setRunning(true, 'starting worker');
  _log(`[CDP]: run ${t.id}`);
  const w = ensureWorker();
  w.onmessage = (ev) => {
    const d = ev.data || {};
    if (d.runId !== runId) return;
    if (d.type === 'stage') {
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
      if (result) result.innerHTML = `<div class="cdp-error">render failed: ${_esc(d.message)}</div>`;
      _log(`[CDP]: ${t.id} failed — ${d.message}`, 'error');
    }
  };
  w.onerror = (e) => {
    setRunning(false);
    if (result) result.innerHTML = `<div class="cdp-error">worker error: ${_esc(e.message || 'unknown')}</div>`;
    _log(`[CDP]: worker error — ${e.message || 'unknown'}`, 'error');
  };
  // Slim descriptor: EFFECTS entries carry function-valued params that cannot
  // be cloned; the Worker re-looks the entry up in its own catalog.
  const token2 = t.inputs2 && _el('cdpInput2')?.value?.trim()
    ? (await preparePath(_el('cdpInput2').value.trim(), note))?.token : null;
  w.postMessage({
    cmd: 'run', runId,
    tool: { id: t.id, kind: t.kind, program: t.program, argv: t.argv, inExt: t.inExt, outExt: t.outExt },
    values: collectValues(), brk: collectBrk(),
    token: prepared.main.token, token2,
  });
}

async function runRawProgram() {
  if (!selectedRawProg) return;
  if (!prepared) {
    await prepareIfNeeded();
    if (!prepared) return;
  }
  const rp = selectedRawProg;
  const args = (rp.args || '').trim().split(/\s+/).filter(Boolean);
  if (!args.some((a) => a === '$IN') || !args.some((a) => a === '$OUT')) {
    const result = _el('cdpResult');
    if (result) result.innerHTML = '<div class="cdp-error">arguments must contain $IN and $OUT — they are the staged input and output paths</div>';
    return;
  }
  pushRecent(`rawprog:${rp.program}`);
  const runId = ++runSeq;
  const result = _el('cdpResult');
  if (result) result.innerHTML = '';
  setRunning(true, 'starting worker');
  _log(`[CDP]: raw ${rp.program} ${args.join(' ')}`);
  const w = ensureWorker();
  w.onmessage = (ev) => {
    const d = ev.data || {};
    if (d.runId !== runId) return;
    if (d.type === 'stage') setRunning(true, d.detail || d.stage);
    else if (d.type === 'done') {
      setRunning(false);
      showAudioResult(d);
      _log(`[CDP]: raw ${rp.program} → ${d.path}`);
    } else if (d.type === 'error') {
      setRunning(false);
      if (result) result.innerHTML = `<div class="cdp-error">render failed: ${_esc(d.message)}</div>`;
      _log(`[CDP]: raw ${rp.program} failed — ${d.message}`, 'error');
    }
  };
  w.onerror = (e) => {
    setRunning(false);
    if (result) result.innerHTML = `<div class="cdp-error">worker error: ${_esc(e.message || 'unknown')}</div>`;
  };
  w.postMessage({
    cmd: 'run', runId,
    tool: { id: `rawprog.${rp.program}`, kind: 'raw', program: rp.program, argv: args, inExt: 'wav', outExt: 'wav' },
    values: {}, token: prepared.main.token,
  });
}

function cancelRun() {
  if (worker) { worker.terminate(); worker = null; }
  setRunning(false);
  const result = _el('cdpResult');
  if (result) result.innerHTML = '<div class="cdp-cancelled">cancelled — finished artifacts (already saved) survive</div>';
  _log('[CDP]: run cancelled (worker terminated)', 'error');
}

/* ── results ────────────────────────────────────────────────────────── */

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
        · ${d.catalogStamped ? '✦ stamped in Media Catalog (generated)' : `<span title="${_esc(d.catalogError || '')}">catalog stamp skipped</span>`}</div>
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

/* ── pipeline mode ──────────────────────────────────────────────────── */

function autosavePipeline() {
  if (pipeline) localStorage.setItem(LS.pipeline, pipelineToJSON(pipeline));
}

function addStepToPipeline(t) {
  if (!pipeline) return;
  if (t.kind === 'info') {
    _log('[CDP]: info tools cannot sit in a chain (text out, not audio)', 'error');
    return;
  }
  pipeline.steps.push(newStep(t));
  autosavePipeline();
  renderPipelinePage();
  _log(`[CDP]: pipeline + step ${pipeline.steps.length}: ${t.id}`);
}

function renderPipelinePage() {
  const page = _el('cdpPage');
  if (!page || !pipeline) return;
  const stepsHtml = pipeline.steps.map((s, i) => {
    const t = toolsById.get(s.toolId);
    const paramSummary = t ? (t.params || []).map((p) => {
      const v = s.values[p.name] ?? p.default;
      return `<label class="cdp-step-p">${_esc(p.label)} <input type="number" step="${p.step ?? 'any'}" data-step="${i}" data-param="${_esc(p.name)}" value="${v}" /></label>`;
    }).join('') : `<span class="cdp-out-meta">unknown tool ${_esc(s.toolId)}</span>`;
    return `
      <div class="cdp-step${s.enabled === false ? ' off' : ''}" data-uid="${_esc(s.uid)}">
        <div class="cdp-step-head">
          <span class="cdp-step-n">${i + 1}</span>
          <span class="cdp-step-tool">${_esc(t ? t.label : s.toolId)}</span>
          <span class="cdp-step-type">${_esc(stepInType(t || { kind: 'effect' }))}→${_esc(stepOutType(t || { kind: 'effect' }) || '?')}</span>
          <label class="cdp-step-en"><input type="checkbox" data-en="${i}" ${s.enabled !== false ? 'checked' : ''} /> on</label>
          <button type="button" class="btn mini" data-up="${i}" title="move up">↑</button>
          <button type="button" class="btn mini" data-down="${i}" title="move down">↓</button>
          <button type="button" class="btn mini" data-del="${i}" title="remove">✕</button>
        </div>
        <div class="cdp-step-params">${paramSummary}</div>
        ${s.note ? `<div class="cdp-out-meta">${_esc(s.note)}</div>` : ''}
      </div>`;
  }).join('');

  const validation = validatePipeline(pipeline, toolsById, { hasInput2: !!pipeline.input2Path });
  const needsIn2 = pipeline.steps.some((s) => s.enabled !== false && toolsById.get(s.toolId)?.inputs2);
  const stepsWanted = pipeline.steps.length > 0;

  page.innerHTML = `
    <div class="cdp-tool-head">
      <h3>Pipeline</h3>
      <input type="text" id="cdpPipeName" value="${_esc(pipeline.name)}" spellcheck="false"
             data-help-title="Pipeline name" data-help-text="Stored in the saved JSON." />
    </div>
    <p class="cdp-blurb">Linear chain (§5.2): each step renders, its artifact is saved beside the input, and the next step feeds on the bytes. Types are explicit — a step expecting .ana after a .wav step is refused with the fix.</p>

    <div class="cdp-field">
      <label for="cdpInput">Input file (audio)</label>
      <div class="cdp-input-row">
        <input type="text" id="cdpInput" placeholder="/absolute/path/to/sound.wav" value="${_esc(pipeline.inputPath)}" />
        <button type="button" class="btn" id="btnCdpPick" data-help-title="Browse" data-help-text="Open the in-app file picker.">Browse…</button>
        <button type="button" class="btn" id="btnCdpPrepare" data-help-title="Prepare" data-help-text="Validate and decode the input for the chain.">Prepare</button>
      </div>
      <div class="cdp-prepare-note" id="cdpPrepNote">${pipelineTokens ? (pipelinePrepNote || 'input prepared ✓') : 'not prepared'}</div>
    </div>
    ${needsIn2 ? `
    <div class="cdp-field">
      <label for="cdpInput2">Input 2 — second source for the 2-input steps</label>
      <div class="cdp-input-row">
        <input type="text" id="cdpInput2" placeholder="/absolute/path/to/second.wav" value="${_esc(pipeline.input2Path)}" />
        <button type="button" class="btn" id="btnCdpPick2" data-help-title="Browse second input" data-help-text="Open the in-app file picker for the second input.">Browse…</button>
      </div>
    </div>` : ''}

    <div class="cdp-steps">${stepsHtml || '<div class="cdp-empty">no steps — click tools in the menu to add them</div>'}</div>
    ${stepsWanted && !validation.ok ? `<div class="cdp-error">${validation.errors.map((e) => `step ${e.index + 1}: ${_esc(e.message)}`).join('<br>')}</div>` : ''}
    ${stepsWanted && validation.ok ? `<div class="cdp-prepare-note ok">chain valid · output .${_esc(validation.outType)}</div>` : ''}

    <div class="cdp-run-row">
      <button type="button" class="btn primary" id="btnCdpRun" data-help-title="Run pipeline" data-help-text="Render every enabled step in order; each artifact is saved as it completes.">Run pipeline</button>
      <button type="button" class="btn" id="btnCdpCancel" style="display:none">Cancel</button>
      <button type="button" class="btn" id="btnCdpSave" data-help-title="Save JSON" data-help-text="Download the pipeline as a schema-versioned JSON file.">Save JSON</button>
      <button type="button" class="btn" id="btnCdpLoad" data-help-title="Load JSON" data-help-text="Load a pipeline JSON file and rebuild the steps.">Load JSON…</button>
      <button type="button" class="btn" id="btnCdpClear" data-help-title="Clear" data-help-text="Remove all steps.">Clear</button>
      <input type="file" id="cdpPipeFile" accept=".json,application/json" style="display:none" />
      <span class="cdp-progress" id="cdpProgress"></span>
    </div>
    <div class="cdp-result" id="cdpResult"></div>`;

  _el('cdpPipeName')?.addEventListener('change', () => { pipeline.name = _el('cdpPipeName').value; autosavePipeline(); });
  _el('cdpInput')?.addEventListener('change', () => {
    pipeline.inputPath = _el('cdpInput').value.trim();
    pipelineTokens = null;
    autosavePipeline();
  });
  _el('cdpInput2')?.addEventListener('change', () => {
    // state only — a full renderPipelinePage() here replaces the button the
    // user is mid-click on (the change fires from the blur of this very click)
    pipeline.input2Path = _el('cdpInput2').value.trim();
    autosavePipeline();
  });
  _el('btnCdpPick')?.addEventListener('click', async () => {
    await pickFile('cdpInput');
    pipeline.inputPath = _el('cdpInput')?.value.trim() || '';
    autosavePipeline();
  });
  _el('btnCdpPick2')?.addEventListener('click', async () => {
    await pickFile('cdpInput2');
    pipeline.input2Path = _el('cdpInput2')?.value.trim() || '';
    autosavePipeline();
    renderPipelinePage();
  });
  _el('btnCdpPrepare')?.addEventListener('click', preparePipelineInputs);
  page.querySelectorAll('.cdp-step input[type=number]').forEach((inp) => {
    inp.addEventListener('change', () => {
      const s = pipeline.steps[Number(inp.dataset.step)];
      if (s) s.values[inp.dataset.param] = Number(inp.value);
      autosavePipeline();
    });
  });
  page.querySelectorAll('[data-en]').forEach((cb) => cb.addEventListener('change', () => {
    pipeline.steps[Number(cb.dataset.en)].enabled = cb.checked;
    autosavePipeline();
    renderPipelinePage();
  }));
  page.querySelectorAll('[data-up]').forEach((b) => b.addEventListener('click', () => {
    const i = Number(b.dataset.up);
    if (i > 0) { [pipeline.steps[i - 1], pipeline.steps[i]] = [pipeline.steps[i], pipeline.steps[i - 1]]; autosavePipeline(); renderPipelinePage(); }
  }));
  page.querySelectorAll('[data-down]').forEach((b) => b.addEventListener('click', () => {
    const i = Number(b.dataset.down);
    if (i < pipeline.steps.length - 1) { [pipeline.steps[i + 1], pipeline.steps[i]] = [pipeline.steps[i], pipeline.steps[i + 1]]; autosavePipeline(); renderPipelinePage(); }
  }));
  page.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => {
    pipeline.steps.splice(Number(b.dataset.del), 1);
    autosavePipeline();
    renderPipelinePage();
  }));
  _el('btnCdpRun')?.addEventListener('click', runPipeline);
  _el('btnCdpCancel')?.addEventListener('click', cancelRun);
  _el('btnCdpSave')?.addEventListener('click', savePipelineJSON);
  _el('btnCdpLoad')?.addEventListener('click', () => _el('cdpPipeFile').click());
  _el('cdpPipeFile')?.addEventListener('change', loadPipelineJSON);
  _el('btnCdpClear')?.addEventListener('click', () => {
    pipeline = newPipeline();
    autosavePipeline();
    renderPipelinePage();
  });
}

async function preparePipelineInputs() {
  const note = _el('cdpPrepNote');
  const path = (_el('cdpInput')?.value || '').trim();
  if (!path) { if (note) note.textContent = 'set an input path first'; return; }
  pipeline.inputPath = path;
  if (note) { note.textContent = 'probing + decoding…'; note.className = 'cdp-prepare-note'; }
  const j = await preparePath(path, note);
  if (!j.ok) { pipelineTokens = null; return; }
  pipelineTokens = { main: j.token };
  let in2ok = true;
  if (pipeline.input2Path) {
    const j2 = await preparePath(pipeline.input2Path, note);
    if (j2.ok) pipelineTokens.in2 = j2.token; else in2ok = false;
  }
  if (note && in2ok) {
    pipelinePrepNote = j.spectral
      ? `ready · spectral pass-through · ${(j.decodedBytes / 1048576).toFixed(1)} MB`
      : `ready · ${j.durationSec} s · ${j.channels} ch`;
    note.className = 'cdp-prepare-note ok';
    note.textContent = pipelinePrepNote;
  }
  // re-render so the validation note reflects Input 2 / prepared state
  renderPipelinePage();
  _log(`[CDP]: pipeline input prepared (${path})`);
}

async function runPipeline() {
  if (!pipeline) return;
  if (!pipelineTokens) {
    await preparePipelineInputs();
    if (!pipelineTokens) return;
  }
  const validation = validatePipeline(pipeline, toolsById, { hasInput2: !!pipeline.input2Path });
  if (!validation.ok) {
    renderPipelinePage();
    return;
  }
  const runId = ++runSeq;
  const result = _el('cdpResult');
  if (result) result.innerHTML = '';
  setRunning(true, 'starting pipeline worker');
  _log(`[CDP]: pipeline run "${pipeline.name}" (${pipeline.steps.length} steps)`);
  const w = ensureWorker();
  const stepResults = [];
  w.onmessage = (ev) => {
    const d = ev.data || {};
    if (d.runId !== runId) return;
    if (d.type === 'stage') {
      setRunning(true, d.detail || d.stage);
      if (d.type === 'stage' && d.index != null) {
        const el = document.querySelector(`.cdp-step[data-uid="${pipeline.steps[d.index]?.uid}"]`);
        if (el) el.classList.add('running');
      }
    } else if (d.type === 'step-skip') {
      stepResults[d.index] = { skipped: true };
    } else if (d.type === 'step-done') {
      stepResults[d.index] = d;
      const list = stepResults.filter(Boolean).map((r) =>
        `<div class="cdp-out-path" title="${_esc(r.path)}">step ${d.index + 1}: ${_esc(r.path)} · ${(r.size / 1048576).toFixed(2)} MB</div>`).join('');
      if (result) {
        result.innerHTML = `<div class="cdp-out"><div class="cdp-out-meta">artifacts so far:</div>${list}</div>`;
      }
      _log(`[CDP]: step ${d.index + 1} (${d.toolId}) → ${d.path}`);
    } else if (d.type === 'done-pipeline') {
      setRunning(false);
      renderPipelineResult(stepResults);
      _log(`[CDP]: pipeline done (${d.steps} steps, output .${d.finalType})`);
    } else if (d.type === 'error') {
      setRunning(false);
      if (result) result.innerHTML += `<div class="cdp-error">pipeline failed: ${_esc(d.message)}</div>`;
      _log(`[CDP]: pipeline failed — ${d.message}`, 'error');
    }
  };
  w.onerror = (e) => {
    setRunning(false);
    if (result) result.innerHTML += `<div class="cdp-error">worker error: ${_esc(e.message || 'unknown')}</div>`;
  };
  const slim = pipeline.steps.map((s) => {
    const t = toolsById.get(s.toolId);
    return { ...slimStep(s, t || { kind: s.kind, program: s.toolId }), enabled: s.enabled !== false };
  });
  w.postMessage({ cmd: 'pipeline', runId, steps: slim, token: pipelineTokens.main, token2: pipelineTokens.in2 || null });
}

function renderPipelineResult(stepResults) {
  const result = _el('cdpResult');
  if (!result) return;
  const done = stepResults.filter((r) => r && !r.skipped);
  const last = done[done.length - 1];
  if (!last) {
    result.innerHTML = '<div class="cdp-cancelled">no enabled steps produced output</div>';
    return;
  }
  const list = done.map((r, i) =>
    `<div class="cdp-out-path" title="${_esc(r.path)}">step artifact: ${_esc(r.path)} · ${(r.size / 1048576).toFixed(2)} MB${r.catalogStamped ? ' · ✦' : ''}</div>`).join('');
  const isWav = last.path.toLowerCase().endsWith('.wav');
  result.innerHTML = `
    <div class="cdp-out">
      <div class="cdp-out-meta">pipeline complete — ${done.length} artifacts saved beside the input</div>
      ${list}
      ${isWav ? `<audio controls src="/api/video?path=${encodeURIComponent(last.path)}"></audio>` : '<div class="cdp-out-meta">final output is .ana — append a pvoc synth step to listen</div>'}
    </div>`;
}

function savePipelineJSON() {
  const blob = new Blob([pipelineToJSON(pipeline)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${(pipeline.name || 'pipeline').replace(/[^a-z0-9]+/gi, '_')}.cdp.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  _log(`[CDP]: pipeline saved — ${a.download}`);
}

function loadPipelineJSON(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      pipeline = pipelineFromJSON(String(reader.result));
      pipelineTokens = null;
      autosavePipeline();
      renderPipelinePage();
      _log(`[CDP]: pipeline loaded — ${pipeline.name} (${pipeline.steps.length} steps)`);
      if (pipeline.unknown?.length) _log(`[CDP]: skipped non-audio steps: ${pipeline.unknown.join(', ')}`, 'error');
    } catch (err) {
      _log(`[CDP]: load failed — ${err.message}`, 'error');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
}
