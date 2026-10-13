import { escapeHtml } from '/js/utils.js';
import { bindReferenceTableScroll } from '/js/ui/reference-table-scroll.js';
import { createCellShading } from '/js/ui/reference-cell-shading.js';

function createReferenceRenderer(config) {
  const KEY = config.key;
  const API = config.api;
  const esc = (value) => escapeHtml(String(value ?? ''));
  const help = (title, text = title) => `data-help-title="${esc(title)}" data-help-text="${esc(text)}"`;
  let prefs;
  try { prefs = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (_) { prefs = {}; }
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) prefs = {};
  prefs.scale = Math.max(70, Math.min(160, Number(prefs.scale) || 100));
  let data = null;
  let generation = 0;
  const drafts = new Map();

  function remember() {
    try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch (_) { /* private browser */ }
  }

  async function api(path, body) {
    const response = await fetch(API + path, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Reference request failed (${response.status})`);
    const result = await response.json();
    if (!result.ok) throw new Error(result.error || 'Reference request failed');
    return result;
  }

  function message(host, text, error = false) {
    const el = host.querySelector('.amr-status');
    if (el) { el.textContent = text; el.classList.toggle('amr-error', error); }
  }

  function draftKey(id) { return `${KEY}.draft.${id}`; }
  function readDraft(id) {
    if (drafts.has(id)) return drafts.get(id);
    try { return JSON.parse(localStorage.getItem(draftKey(id)) || 'null'); } catch (_) { return null; }
  }
  function writeDraft(id, value) {
    drafts.set(id, value);
    try { localStorage.setItem(draftKey(id), JSON.stringify(value)); } catch (_) { /* memory fallback */ }
  }

  function fields(model, indexes) {
    return `<dl>${indexes.filter(i => model.values[i] && model.values[i] !== 'Not supplied').map(i =>
      `<dt>${esc(data.columns[i])}</dt><dd>${esc(model.values[i])}</dd>`).join('')}</dl>`;
  }
  function card(title, body, attrs = '') {
    return `<section class="amr-card" ${attrs}><h4>${esc(title)}</h4>${body}</section>`;
  }
  function button(text, attrs, description = text) {
    return `<button type="button" ${attrs} ${help(text, description)}>${esc(text)}</button>`;
  }

  async function renderReferences(host, overview = false) {
    const epoch = ++generation;
    if (overview) { prefs.selected = ''; remember(); }
    host.className = 'amr-workspace';
    host.innerHTML = `<p class="amr-status" role="status">Loading ${esc(config.title)}…</p>`;
    try {
      if (!data) data = await api('');
      if (!host.isConnected || generation !== epoch) return;
      render(host);
    } catch (err) {
      if (host.isConnected && generation === epoch) {
        message(host, err.message, true);
        host.insertAdjacentHTML('beforeend', button('Retry', 'id="arRetry"'));
        host.querySelector('#arRetry').onclick = () => renderReferences(host);
      }
    }
  }

  function render(host) {
    const epoch = ++generation;
    const model = data.models.find(m => m.id === prefs.selected);
    host.style.fontSize = `${0.75 * prefs.scale / 100}rem`;
    host.innerHTML = `
      <div class="amr-toolbar">
        <div class="amr-subtabs" role="tablist" aria-label="${esc(config.title)} pages">
          ${button(config.overview, `role="tab" aria-selected="${!model}" id="arOverview"`)}
          ${model ? button(model.name, 'role="tab" aria-selected="true" id="arModelTab"') : ''}
        </div>
        <label class="amr-zoom" ${help('Card zoom', 'Scale text, card widths, spacing and controls together. Rows reflow at every size.')}>
          Zoom <input id="arZoom" type="range" min="70" max="160" step="5" value="${prefs.scale}" aria-label="Card zoom"><output id="arZoomValue">${prefs.scale}%</output>
        </label>
        ${button('100%', 'id="arResetZoom"', 'Reset card and text size to 100 percent')}
      </div>
      <p class="amr-status" role="status" aria-live="polite"></p>
      ${model ? detailMarkup(model) : overviewMarkup()}`;
    host.querySelector('#arOverview').onclick = () => { prefs.selected = ''; remember(); render(host); };
    const scale = value => {
      prefs.scale = Number(value); remember(); host.style.fontSize = `${0.75 * prefs.scale / 100}rem`;
      host.querySelector('#arZoom').value = prefs.scale;
      host.querySelector('#arZoomValue').textContent = `${prefs.scale}%`;
    };
    host.querySelector('#arZoom').oninput = e => scale(e.target.value);
    host.querySelector('#arResetZoom').onclick = () => scale(100);
    if (model) bindDetail(host, model, epoch);
    else bindOverview(host);
  }

  function overviewMarkup() {
    return `<div class="amr-toolbar">
      <label class="amr-search" ${help('Search models', 'Search every comparison field, including tasks, outputs, licenses and hardware.')}>
        Search <input id="arSearch" type="search" value="${esc(prefs.search || '')}" placeholder="${esc(config.placeholder)}"></label>
      <label ${help('View', 'Choose the full comparison table or compact model cards.')}>
        View <select id="arView"><option value="table" ${prefs.view !== 'cards' ? 'selected' : ''}>Table</option><option value="cards" ${prefs.view === 'cards' ? 'selected' : ''}>Cards</option></select></label>
      ${data.categories ? `<label ${help('Task filter', 'Show models and tools that perform this listening task. A model can have several tasks.')}>
        Task <select id="arTask"><option value="">All tasks</option>${data.categories.map(task => `<option value="${esc(task)}" ${prefs.task === task ? 'selected' : ''}>${esc(task)}</option>`).join('')}</select></label>` : ''}
      <span id="arCount"></span>
      <label ${help('Cell shading', 'Shade repeated values, comparable numeric values and yes/no states. Warnings take priority in red; missing values stay neutral.')}><input id="arShading" type="checkbox" ${prefs.shading !== false ? 'checked' : ''}> Shade cells</label>
      <a href="${API}/source/${config.csv}" ${help('Download CSV', 'Download every comparison field, including source evidence when available.')}>CSV</a>
    </div><p class="amr-caption">${data.models.length} models, services and tools • ${esc(config.evidence)}. Click a model for every detail, notes and tagged files.</p>
    ${data.glossary ? `<details class="amr-glossary"><summary ${help('Listening task glossary', 'Explain diarization, ASR, VAD, captioning, MIDI and related audio tasks.')}>Task glossary — what each output means</summary><div class="amr-grid">${data.glossary.map(([term, text]) => card(term, `<p>${esc(text)}</p>`)).join('')}</div></details>` : ''}
    <div id="arResults"></div>`;
  }

  function bindOverview(host) {
    const results = host.querySelector('#arResults');
    const shade = createCellShading(data.columns, data.models.map(model => model.values));
    let disposeTable;
    const show = () => {
      disposeTable?.();
      const search = (prefs.search || '').trim().toLowerCase();
      const models = data.models.filter(m => m.values.join(' ').toLowerCase().includes(search) && (!prefs.task || (m.tasks || []).includes(prefs.task)));
      host.querySelector('#arCount').textContent = `${models.length} / ${data.models.length}`;
      const open = m => button(m.name, `data-model="${esc(m.id)}" class="amr-model-link"`, 'Open model details, notes and tagged files');
      const tableName = m => open(m).replace(`>${esc(m.name)}</button>`, `>${esc(m.name).replace(' (', '<br> (')}</button>`);
      if (prefs.view === 'cards') {
        results.innerHTML = `<div class="amr-grid">${models.map(m =>
          `<section class="amr-card" data-model-card="${esc(m.id)}"><h4>${open(m)}</h4>${fields(m, [1, 2, 4, 5])}</section>`).join('')}</div>`;
      } else {
        const cell = (value, index, model) => {
          const color = prefs.shading !== false ? shade(value, index) : {kind:'neutral',label:'Cell shading off'};
          return `<td data-shade="${color.kind}" ${color.hue !== undefined ? `style="--amr-cell-hue:${color.hue}"` : ''} ${help(data.columns[index], color.label)}>${index === 0 ? tableName(model) : esc(value)}</td>`;
        };
        results.innerHTML = `${prefs.shading !== false ? `<div class="amr-shade-legend" aria-label="Cell shading legend"><span data-shade="yes">Yes</span><span data-shade="warning">No / warnings</span><span data-shade="partial">Partial</span><span data-shade="conditional">Conditional</span><span>— neutral</span><span class="amr-number-legend" ${help('Numeric spectrum', 'Blue = low; yellow = high within comparable units in each full-catalog column. Larger does not mean better. Ranges use their midpoint.')}>Numeric low → high</span><span ${help('Repeated text', 'Matching text has a consistent tint across the full catalog. Colors remain stable during filtering.')}>Repeated text = same tint</span></div>` : ''}
          <div class="amr-table-scroll" role="region" aria-label="Complete model comparison table" tabindex="0" ${help('Model comparison', 'Scroll the table for all comparison fields; click a model to open its cards.')}>
          <table class="amr-table"><thead><tr>${data.columns.map(c => `<th scope="col">${esc(c)}</th>`).join('')}</tr></thead>
          <tbody>${models.map(m => `<tr>${m.values.map((v, i) => cell(v, i, m)).join('')}</tr>`).join('')}</tbody></table></div>`;
      }
      if (!models.length) results.innerHTML = '<p>No models match this search.</p>';
      results.querySelectorAll('[data-model]').forEach(b => {
        b.onclick = () => { prefs.selected = b.dataset.model; remember(); render(host); };
      });
      const table = results.querySelector('.amr-table-scroll');
      if (table) disposeTable = bindReferenceTableScroll(table, {
        initialLeft: prefs.scrollX,
        onScroll: left => { prefs.scrollX = left; remember(); },
      });
    };
    host.querySelector('#arSearch').oninput = e => { prefs.search = e.target.value; remember(); show(); };
    host.querySelector('#arView').onchange = e => { prefs.view = e.target.value; remember(); show(); };
    host.querySelector('#arShading').onchange = e => { prefs.shading = e.target.checked; remember(); show(); };
    if (data.categories) host.querySelector('#arTask').onchange = e => { prefs.task = e.target.value; remember(); show(); };
    show();
  }

  function detailMarkup(model) {
    const groups = data.groups || [['Overview', [1, 2, 3, 11]], ['Voice & controls', [5, 9]],
      ['Performance & hardware', [6, 7, 8]], ['License & evidence', [4, 10]]];
    return `<div class="amr-grid" id="arDetailGrid">
      ${groups.map(([title, indexes]) => card(title, fields(model, indexes))).join('')}
      ${card('My notes', `<label class="amr-sr-only" for="arNotes">Notes for ${esc(model.name)}</label>
        <textarea id="arNotes" rows="7" disabled ${help('Model notes', 'Drafts survive tab switches and reloads. Save notes stores them on the server.')}></textarea>
        <div class="amr-toolbar">${button('Save notes', 'id="arSaveNotes" disabled')}${button('Load saved', 'id="arLoadNotes" disabled', 'Load the saved server version into this editor, replacing this local draft.')}
        <span id="arNoteStatus">Loading…</span></div>`, 'id="arNotesCard"')}
      ${card('Tag a file', `<p>Associate a file with ${esc(model.name)}. A file can have several model tags.</p>
        <label>File path <input id="arFilePath" type="text" placeholder="Absolute path" ${help('File path', 'Choose a generated file, reference, recipe or other local artifact.')}></label>
        <div class="amr-toolbar">${button('Browse', 'id="arBrowse"')}<label>Kind <select id="arFileKind" ${help('File kind')}><option value="output">Made / output</option><option value="reference">Reference</option><option value="recipe">Recipe</option><option value="other">Other</option></select></label></div>
        <label>Label <input id="arFileLabel" type="text" maxlength="300" placeholder="File name by default" ${help('File label')}></label>
        ${button('Tag file', 'id="arTagFile"')}`, 'id="arTagCard"')}
      ${card('Sources & reference files', `${model.sources ? `<p>Primary documentation checked ${esc(model.checked)}.</p><div class="amr-source-links">${model.sources.filter(source => /^https:\/\//.test(source.url)).map(source => `<a href="${esc(source.url)}" target="_blank" rel="noopener noreferrer" ${help(source.label, source.url)}>${esc(source.label)}</a>`).join('')}</div>` : '<p>The merged table and original supplied research include this model.</p>'}
        <div class="amr-source-links">${data.source_files.map(file => `<a href="${API}/source/${encodeURIComponent(file.name)}" ${help(file.label, 'Download the reference document associated with this model.')}>${esc(file.label)}</a>`).join('')}</div>
        <p>${esc(data.source_note)}</p>`)}
    </div><div class="amr-file-heading"><h4>Tagged files</h4><span id="arFileCount">Loading…</span></div><div class="amr-grid" id="arFiles"></div>`;
  }

  async function bindDetail(host, model, epoch) {
    const current = () => host.isConnected && generation === epoch;
    const notes = host.querySelector('#arNotes');
    const save = host.querySelector('#arSaveNotes');
    const load = host.querySelector('#arLoadNotes');
    const noteStatus = host.querySelector('#arNoteStatus');
    let revision = 0;
    function applyNote(note, force = false) {
      const draft = force ? null : readDraft(model.id);
      revision = draft?.revision ?? note.revision;
      notes.value = draft?.text ?? note.text;
      notes.disabled = save.disabled = load.disabled = false;
      noteStatus.textContent = draft ? 'Local draft' : 'Saved';
      if (force) {
        drafts.delete(model.id);
        try { localStorage.removeItem(draftKey(model.id)); } catch (_) { /* no storage */ }
      }
    }
    notes.oninput = () => {
      writeDraft(model.id, {text: notes.value, revision});
      noteStatus.textContent = 'Local draft • save to server';
    };
    save.onclick = async () => {
      save.disabled = true;
      const text = notes.value;
      try {
        const result = await api(`/model/${model.id}/note`, { text, revision });
        revision = result.revision;
        if (notes.value === text) {
          drafts.delete(model.id);
          try { localStorage.removeItem(draftKey(model.id)); } catch (_) { /* no storage */ }
        } else writeDraft(model.id, {text: notes.value, revision});
        if (current()) noteStatus.textContent = notes.value === text ? 'Saved to server' : 'Newer local draft';
      } catch (err) { if (current()) message(host, err.message, true); }
      finally { if (current()) save.disabled = false; }
    };
    load.onclick = async () => {
      try {
        const result = await api(`/model/${model.id}`);
        if (current()) { applyNote(result.note, true); message(host, 'Loaded saved notes.'); }
      } catch (err) { if (current()) message(host, err.message, true); }
    };
    const fileDraft = prefs.files?.[model.id] || {};
    for (const [id, key] of [['arFilePath', 'path'], ['arFileKind', 'kind'], ['arFileLabel', 'label']]) {
      const el = host.querySelector(`#${id}`);
      if (fileDraft[key]) el.value = fileDraft[key];
      el.oninput = el.onchange = () => {
        prefs.files ||= {}; prefs.files[model.id] ||= {};
        prefs.files[model.id][key] = el.value; remember();
      };
    }
    host.querySelector('#arBrowse').onclick = () => window.openFileBrowser('arFilePath', false, 'files', 'all');
    const refreshFiles = async () => {
      const result = await api(`/model/${model.id}`);
      if (current()) renderFiles(host, model, result.files, refreshFiles, current);
      return result;
    };
    host.querySelector('#arTagFile').onclick = async e => {
      const btn = e.currentTarget; btn.disabled = true;
      try {
        await api(`/model/${model.id}/file`, { path: host.querySelector('#arFilePath').value,
          label: host.querySelector('#arFileLabel').value, kind: host.querySelector('#arFileKind').value });
        await refreshFiles();
        if (current()) message(host, 'File tagged. The source file is unchanged.');
      } catch (err) { if (current()) message(host, err.message, true); }
      finally { if (current()) btn.disabled = false; }
    };
    try {
      const result = await refreshFiles();
      if (current()) applyNote(result.note);
    } catch (err) { if (current()) { message(host, err.message, true); noteStatus.textContent = 'Unavailable'; } }
  }

  function renderFiles(host, model, files, refresh, current) {
    host.querySelector('#arFileCount').textContent = `${files.length} associated with ${model.name}`;
    host.querySelector('#arFiles').innerHTML = files.length ? files.map(file => card(file.label,
      `<p class="amr-file-path" ${help('Full file path', file.path)}>${esc(file.path)}</p><p>${esc(file.kind)}${file.exists ? '' : ' • Missing on disk'}</p>
      <div class="amr-tags">${file.tags.map(tag => {
        const target = data.models.find(m => m.id === tag);
        return button(target?.name || tag, `data-file-model="${esc(tag)}"`, 'Open this model reference');
      }).join('')}</div><div class="amr-toolbar">
      ${file.exists ? `<a href="${API}/model/${model.id}/file/${file.id}" ${help('Download tagged file')}>Download</a>` : ''}
      ${button('Untag', `data-untag="${file.id}"`, 'Remove only this model association. Keep the file and other model tags.')}</div>`, `data-file-id="${file.id}"`)).join('') : '<p>No files tagged yet. Use “Tag a file” to associate an output, recipe or reference.</p>';
    host.querySelectorAll('[data-file-model]').forEach(btn => {
      btn.onclick = () => { prefs.selected = btn.dataset.fileModel; remember(); render(host); };
    });
    host.querySelectorAll('[data-untag]').forEach(btn => {
      btn.onclick = async () => {
        btn.disabled = true;
        try { await api(`/model/${model.id}/file/${btn.dataset.untag}/untag`, {}); await refresh(); }
        catch (err) { if (current()) { message(host, err.message, true); btn.disabled = false; } }
      };
    });
  }

  return renderReferences;
}

export const renderTtsReferences = createReferenceRenderer({
  key: 'mtapi.ttsReferences.v1', api: '/api/tts-references', title: 'TTS',
  overview: 'All TTS models', csv: 'tts-supertable.csv', placeholder: 'Model, CPU, cloning, license…',
  evidence: 'Supplied research, not independently verified',
});
export const renderVoiceModReferences = createReferenceRenderer({
  key: 'mtapi.voiceModReferences.v1', api: '/api/voicemod-references', title: 'Voice Mod',
  overview: 'All Voice Mod models', csv: 'voicemod-supertable.csv', placeholder: 'Model, RVC, SVC, changer, real-time…',
  evidence: 'Supplied research, not independently verified',
});
export const renderAudioReferences = renderTtsReferences;
export const renderListeningReferences = createReferenceRenderer({
  key: 'mtapi.listeningReferences.v1', api: '/api/listening-references', title: 'Listening Models',
  overview: 'All listening models', csv: 'listening-supertable.csv', placeholder: 'Wake words, diarization, music, MIDI…',
  evidence: 'Primary sources checked 2026-10-10',
});

