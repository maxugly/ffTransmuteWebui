import { elements, state, logConsole } from '/app.js';
import { escapeHtml } from '/js/utils.js';

/**
 * Skills tab — upload (.md/.txt/.zip/paste), model-assisted install,
 * list / read / copy / export as .md/.txt. Server store (shared).
 */

var _list = [];
var _detail = null; // { skill, files }
var _viewFile = 'SKILL.md';
var _pending = null; // { name, kind: 'text'|'zip', text?, b64? }

function _ensureSkillsState() {
  if (!state.skills) state.skills = { selectedId: null };
  return state.skills;
}

function _status(msg, isErr) {
  var el = document.getElementById('skStatus');
  if (el) {
    el.textContent = msg || '';
    el.classList.toggle('form-row-error', !!isErr);
  }
  if (msg) logConsole('[SKILLS]: ' + msg, isErr ? 'error' : undefined);
}

function _backendOptions(selected) {
  var opts = [
    ['deepseek', 'DeepSeek API (text)'],
    ['grok', 'grok CLI'],
    ['agy', 'agy CLI'],
    ['openrouter', 'OpenRouter API'],
    ['xai', 'xAI Grok API'],
    ['openai', 'OpenAI API'],
    ['groq', 'Groq API (text)'],
    ['stub', 'stub (offline)'],
  ];
  return opts.map(function(o) {
    return `<option value="${o[0]}" ${selected === o[0] ? 'selected' : ''}>${o[1]}</option>`;
  }).join('');
}

function renderSkillsForm() {
  var s = _ensureSkillsState();
  var html = `
    <div class="panel-title-desc dense">
      <h3>Skills · AI model skills</h3>
      <p class="dream-hint">
        Upload a <strong>.md</strong> / <strong>.txt</strong> skill, a <strong>.zip</strong> bundle
        (SKILL.md + files), or paste text. A model normalizes it, extracts
        <code>name</code> / <code>description</code>, then it is saved to the shared library.
      </p>
    </div>

    <div class="card" style="margin-bottom:12px">
      <div class="form-row">
        <label for="skFile">File</label>
        <input type="file" id="skFile" accept=".md,.markdown,.txt,.zip" style="flex:1 1 14rem">
        <span class="form-row-hint" id="skPicked">no file chosen</span>
      </div>
      <div class="form-row">
        <label for="skPaste">Or paste</label>
        <textarea id="skPaste" rows="3" placeholder="Paste skill markdown here…" style="flex:1 1 14rem"></textarea>
      </div>
      <div class="form-row">
        <label for="skBackend">Backend</label>
        <select id="skBackend">${_backendOptions('deepseek')}</select>
        <label>Mode</label>
        <label style="font-weight:normal"><input type="radio" name="skMode" value="normalize" checked> Normalize</label>
        <label style="font-weight:normal"><input type="radio" name="skMode" value="custom"> Custom</label>
      </div>
      <div class="form-row" id="skCustomRow" style="display:none">
        <label for="skCustom">Instruction</label>
        <input type="text" id="skCustom" placeholder="e.g. summarize aggressively, translate to German…" style="flex:1 1 14rem">
      </div>
      <div class="form-row">
        <button type="button" class="btn btn-primary" id="btnSkInstall">Install skill</button>
        <span class="form-row-hint" id="skStatus" role="status"></span>
      </div>
    </div>

    <div class="form-row">
      <label for="skSearch">Skills</label>
      <input type="text" id="skSearch" placeholder="filter by name or description…" style="flex:1 1 14rem">
      <span class="form-row-hint" id="skCount"></span>
    </div>

    <div class="skills-cols">
      <div class="skills-list" id="skList"></div>
      <div class="skills-reader" id="skReader">
        <div class="form-row-hint">Select a skill to read it.</div>
      </div>
    </div>

    <section class="tool-docs" aria-label="About skills">
      <h4 class="tool-docs-title">About · Skills</h4>
      <p class="tool-docs-lede">
        Skills are SKILL.md documents (single file or zip bundle). Normalize cleans and
        extracts metadata; Custom applies your instruction too. Copy puts the viewed
        file on the clipboard; Export downloads it as .md or .txt.
      </p>
    </section>
  `;
  elements.actionPanel.innerHTML = html;

  document.querySelectorAll('input[name="skMode"]').forEach(function(r) {
    r.addEventListener('change', function() {
      var custom = document.querySelector('input[name="skMode"]:checked')?.value === 'custom';
      var row = document.getElementById('skCustomRow');
      if (row) row.style.display = custom ? '' : 'none';
    });
  });
  document.getElementById('skFile')?.addEventListener('change', _onFilePicked);
  document.getElementById('skSearch')?.addEventListener('input', _paintList);
  document.getElementById('btnSkInstall')?.addEventListener('click', function() { installSkill(false); });

  _fetchList().then(function() {
    if (s.selectedId && _list.some((e) => e.id === s.selectedId)) {
      selectSkill(s.selectedId);
    }
  });
}

function _onFilePicked(e) {
  var f = e.target.files && e.target.files[0];
  _pending = null;
  var label = document.getElementById('skPicked');
  if (!f) {
    if (label) label.textContent = 'no file chosen';
    return;
  }
  var isZip = /\.zip$/i.test(f.name);
  if (label) label.textContent = `${f.name} (${Math.round(f.size / 1024)} KB)`;
  var rd = new FileReader();
  rd.onload = function() {
    if (isZip) {
      var dataUrl = String(rd.result || '');
      _pending = { name: f.name, kind: 'zip', b64: dataUrl.split(',')[1] || '' };
    } else {
      _pending = { name: f.name, kind: 'text', text: String(rd.result || '') };
    }
  };
  rd.onerror = function() {
    _status('Could not read file', true);
    _pending = null;
  };
  if (isZip) rd.readAsDataURL(f);
  else rd.readAsText(f);
}

async function _fetchList() {
  try {
    var res = await fetch('/api/skills');
    var data = await res.json();
    _list = (data && data.skills) || [];
  } catch (err) {
    _list = [];
    _status('Could not load skills: ' + err.message, true);
  }
  _paintList();
}

function _paintList() {
  var box = document.getElementById('skList');
  if (!box) return;
  var s = _ensureSkillsState();
  var q = (document.getElementById('skSearch')?.value || '').toLowerCase();
  var items = _list.filter(function(e) {
    if (!q) return true;
    return ((e.name || '') + ' ' + (e.description || '')).toLowerCase().includes(q);
  });
  var count = document.getElementById('skCount');
  if (count) count.textContent = `${items.length} / ${_list.length}`;
  if (!items.length) {
    box.innerHTML = '<div class="form-row-hint">No skills yet — install one above.</div>';
    return;
  }
  box.innerHTML = items.map(function(e) {
    var n = Object.keys(e.files || {}).length;
    var upd = String(e.updated_at || '').slice(0, 10);
    var active = s.selectedId === e.id ? ' skill-row-active' : '';
    return `<div class="skill-row${active}" data-id="${escapeHtml(e.id)}" role="button" tabindex="0" title="${escapeHtml(e.description || '')}">
      <div class="skill-row-main">
        <span class="skill-row-name">${escapeHtml(e.name || '(unnamed)')}</span>
        <span class="skill-row-meta">${n} file${n === 1 ? '' : 's'} · ${escapeHtml(upd)}</span>
      </div>
      <div class="skill-row-desc">${escapeHtml(e.description || '')}</div>
    </div>`;
  }).join('');
  box.querySelectorAll('.skill-row').forEach(function(row) {
    row.addEventListener('click', function() { selectSkill(row.dataset.id); });
    row.addEventListener('keydown', function(ev) {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); selectSkill(row.dataset.id); }
    });
  });
}

async function selectSkill(id) {
  _ensureSkillsState().selectedId = id;
  _detail = null;
  _paintList();
  var reader = document.getElementById('skReader');
  if (reader) reader.innerHTML = '<div class="form-row-hint">Loading…</div>';
  try {
    var res = await fetch('/api/skills/' + encodeURIComponent(id));
    var data = await res.json();
    if (!data || !data.ok) {
      if (reader) reader.innerHTML = '<div class="form-row-hint">Skill not found.</div>';
      return;
    }
    _detail = data;
    var files = Object.keys(data.files || {});
    _viewFile = files.includes('SKILL.md') ? 'SKILL.md' : (files[0] || 'SKILL.md');
    _paintReader();
  } catch (err) {
    if (reader) reader.innerHTML = `<div class="form-row-hint">Load failed: ${escapeHtml(err.message)}</div>`;
  }
}

function _viewText() {
  if (!_detail || !_detail.files) return '';
  return _detail.files[_viewFile] ?? '';
}

function _paintReader() {
  var reader = document.getElementById('skReader');
  if (!reader || !_detail) return;
  var sk = _detail.skill || {};
  var files = Object.keys(_detail.files || {});
  var tabs = files.map(function(f) {
    return `<button type="button" class="btn${f === _viewFile ? ' btn-primary' : ''}" data-file="${escapeHtml(f)}">${escapeHtml(f)}</button>`;
  }).join('');
  reader.innerHTML = `
    <div class="skill-reader-head">
      <strong>${escapeHtml(sk.name || '')}</strong>
      <span class="form-row-hint">${escapeHtml(sk.description || '')}</span>
      <span class="form-row-hint">${escapeHtml(sk.source || '')} · updated ${escapeHtml(String(sk.updated_at || '').slice(0, 10))}</span>
    </div>
    ${files.length > 1 ? `<div class="sort-toolbar" style="margin:6px 0">${tabs}</div>` : ''}
    <pre class="skill-reader-pre" id="skPre">${escapeHtml(_viewText())}</pre>
    <div class="form-row">
      <button type="button" class="btn btn-primary" id="btnSkCopy">Copy</button>
      <button type="button" class="btn" id="btnSkExpMd">Export .md</button>
      <button type="button" class="btn" id="btnSkExpTxt">Export .txt</button>
      <button type="button" class="btn" id="btnSkDel">Delete</button>
      <span class="form-row-hint" id="skReaderStatus" role="status"></span>
    </div>
  `;
  reader.querySelectorAll('[data-file]').forEach(function(b) {
    b.addEventListener('click', function() { _viewFile = b.dataset.file; _paintReader(); });
  });
  document.getElementById('btnSkCopy')?.addEventListener('click', copySkill);
  document.getElementById('btnSkExpMd')?.addEventListener('click', function() { exportSkill('md'); });
  document.getElementById('btnSkExpTxt')?.addEventListener('click', function() { exportSkill('txt'); });
  document.getElementById('btnSkDel')?.addEventListener('click', deleteSkill);
}

function _readerStatus(msg, isErr) {
  var el = document.getElementById('skReaderStatus');
  if (el) el.textContent = msg || '';
  if (msg) logConsole('[SKILLS]: ' + msg, isErr ? 'error' : undefined);
}

async function copySkill() {
  var text = _viewText();
  if (!text) {
    _readerStatus('Nothing to copy', true);
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    var ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (_) { /* ignore */ }
    ta.remove();
  }
  _readerStatus(`Copied ${_viewFile} (${text.length} chars)`);
}

function exportSkill(format) {
  if (!_detail) return;
  var sk = _detail.skill || {};
  var text, fname;
  if (format === 'txt' && Object.keys(_detail.files || {}).length > 1) {
    text = Object.keys(_detail.files).map(function(f) {
      return `\n\n=== ${f} ===\n${_detail.files[f]}`;
    }).join('').replace(/^\n\n/, '');
    fname = `${sk.name || 'skill'}.txt`;
  } else {
    text = _viewText();
    fname = `${sk.name || 'skill'}.${format}`;
  }
  if (!text) {
    _readerStatus('Nothing to export', true);
    return;
  }
  var blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fname;
  document.body.appendChild(a);
  a.click();
  setTimeout(function() { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  _readerStatus(`Exported ${fname} (${text.length} chars)`);
}

async function deleteSkill() {
  if (!_detail) return;
  var sk = _detail.skill || {};
  if (!confirm(`Delete skill '${sk.name}'?`)) return;
  try {
    var res = await fetch('/api/skills/' + encodeURIComponent(sk.id), { method: 'DELETE' });
    var data = await res.json();
    if (!data || !data.ok) {
      _readerStatus('Delete failed: ' + ((data && data.error) || 'unknown'), true);
      return;
    }
  } catch (err) {
    _readerStatus('Delete failed: ' + err.message, true);
    return;
  }
  _detail = null;
  _ensureSkillsState().selectedId = null;
  var reader = document.getElementById('skReader');
  if (reader) reader.innerHTML = '<div class="form-row-hint">Select a skill to read it.</div>';
  await _fetchList();
  _readerStatus('');
}

async function installSkill(overwrite) {
  var backend = document.getElementById('skBackend')?.value || 'deepseek';
  var mode = document.querySelector('input[name="skMode"]:checked')?.value || 'normalize';
  var custom = (document.getElementById('skCustom')?.value || '').trim();
  var paste = (document.getElementById('skPaste')?.value || '').trim();

  if (mode === 'custom' && !custom) {
    _status('Custom mode needs an instruction for the model', true);
    return;
  }
  var body = { backend, mode, custom_prompt: custom, overwrite: !!overwrite, dry_run: false };
  if (_pending && _pending.kind === 'zip') {
    if (!paste && !_pending.b64) {
      _status('Zip not finished reading — wait a moment and retry', true);
      return;
    }
    body.content_b64 = _pending.b64;
    body.filename = _pending.name;
    body.source = 'upload-zip';
  } else if (_pending && _pending.kind === 'text') {
    body.content_text = _pending.text;
    body.filename = _pending.name;
    body.source = 'upload-single';
  } else if (paste) {
    body.content_text = paste;
    body.filename = 'pasted.md';
    body.source = 'pasted';
  } else {
    _status('Choose a file or paste skill text first', true);
    return;
  }

  _status(`Installing via ${backend} / ${mode}…`);
  var btn = document.getElementById('btnSkInstall');
  if (btn) btn.disabled = true;
  try {
    var { runOpWithCancel } = await import('/js/job-control.js');
    var data = await runOpWithCancel('skills_install', body, { label: 'Installing skill…' });
    if (!data || !data.ok) {
      var meta = (data && data.meta) || {};
      if (meta.conflict && !overwrite) {
        if (confirm(`A skill named '${meta.name}' already exists. Overwrite it?`)) {
          if (btn) btn.disabled = false;
          await installSkill(true);
          return;
        }
        _status('Install cancelled — kept existing skill');
        return;
      }
      _status('Install failed: ' + ((data && data.error) || 'unknown'), true);
      return;
    }
    var item = (data.items && data.items[0]) || {};
    var warn = (data.meta && data.meta.warning) ? ` (${data.meta.warning})` : '';
    _status(`Installed '${item.name || '?'}'${item.overwrote ? ' (overwrote)' : ''}${warn}`);
    _pending = null;
    var fi = document.getElementById('skFile');
    if (fi) fi.value = '';
    var pl = document.getElementById('skPicked');
    if (pl) pl.textContent = 'no file chosen';
    var pt = document.getElementById('skPaste');
    if (pt && !overwrite) pt.value = '';
    await _fetchList();
    if (item.id) await selectSkill(item.id);
  } catch (err) {
    _status('Install failed: ' + err.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

export { renderSkillsForm, selectSkill };
