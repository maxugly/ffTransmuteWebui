import { state, elements, resolveGlobalImages, bestInput, showPreview } from '/app.js';
import { basename, escapeHtml, withFrameRange, isVideoPath, isImagePath } from '/js/utils.js';
import { setupContinuousKnob, setupBinaryKnob, knobUnitHtml } from '/js/ui/knobs.js';
import { registerListKeys } from '/js/ui/list-keys.js';

// ── Style Transfer tab (Magenta arbitrary stylization) ───────────────────
// Images: batch stills via engine. Video: dump → filters.styletransfer → encode.

function renderStyleTransferForm() {
  const contents = state.styleTransfer.contents || [];
  if (state.styleTransfer.selected == null) state.styleTransfer.selected = 0;
  if (contents.length && state.styleTransfer.selected >= contents.length) {
    state.styleTransfer.selected = contents.length - 1;
  }
  const sel = state.styleTransfer.selected | 0;
  const stylePath = state.styleTransfer.stylePath;
  const listHtml = contents.length
    ? contents.map((it, i) => {
        const kind = isVideoPath(it.path) ? 'video' : (isImagePath(it.path) ? 'image' : 'path');
        return `
        <div class="fm-item${i === sel ? ' is-selected' : ''}" data-idx="${i}">
          <span class="fm-ord">${String(i + 1).padStart(2, '0')}</span>
          <span class="fm-badge" title="${kind}">${kind === 'video' ? '▶' : '🖼'}</span>
          <span class="fm-name" title="${escapeHtml(it.path)}">${escapeHtml(it.name || basename(it.path))}</span>
          <button type="button" class="btn fm-rm" data-idx="${i}" data-st="1">✕</button>
        </div>`;
      }).join('')
    : `<div class="fm-empty">Add content photo(s) and/or one video. Arrows select · Ctrl+arrows reorder.</div>`;

  const hasVideo = contents.some((c) => isVideoPath(c.path));

  const html = `
    <div class="panel-title-desc dense">
      <h3>Neural style transfer</h3>
      <p class="dream-hint">
        Magenta arbitrary stylization (~90&nbsp;MB). Stills batch · video = dump → per-frame → encode.
        ${hasVideo ? ' <strong>Video mode:</strong> one clip (not mixed with stills).' : ''}
      </p>
    </div>

    <div class="form-group" style="margin-bottom:6px">
      <div class="form-row" style="margin-bottom:3px">
        <label>Content (${contents.length})</label>
        <div class="sort-toolbar" style="margin:0; flex:1">
          <button type="button" class="btn btn-primary" id="btnStAddContent">+ Images</button>
          <button type="button" class="btn" id="btnStAddVideo">+ Video</button>
          <button type="button" class="btn" id="btnStAddFolder">+ Folder</button>
          <button type="button" class="btn" id="btnStFromGlobal">Globals</button>
          <button type="button" class="btn" id="btnStClearContent" ${contents.length ? '' : 'disabled'}>Clear</button>
        </div>
        <p class="form-row-hint">stills → <code>*_styled.png</code> · video → <code>*_styled.mp4</code></p>
      </div>
      <div class="fm-list" id="stContentList">${listHtml}</div>
    </div>

    <div class="form-row">
      <label for="stStylePath">Style</label>
      <div class="input-row">
        <input type="text" id="stStylePath" placeholder="required: painting / texture still"
          value="${stylePath ? escapeHtml(stylePath) : ''}">
        <button type="button" class="btn" id="btnStStyleBrowse">Browse</button>
      </div>
    </div>
    <div class="form-row">
      <label for="stOutput">Output</label>
      <div class="input-row">
        <input type="text" id="stOutput" placeholder="blank = next to source">
        <button type="button" class="btn" id="btnStOutBrowse">Save As</button>
      </div>
    </div>
    <div class="form-row">
      <label for="stOutputDir">Batch dir</label>
      <div class="input-row">
        <input type="text" id="stOutputDir" placeholder="optional shared folder for stills">
        <button type="button" class="btn" id="btnStOutDirBrowse">Folder</button>
      </div>
    </div>

    <div class="knob-row">
      <div class="knob-bank">
        ${knobUnitHtml({ id: 'stStrength', label: 'Strength', value: '1.0' })}
        ${knobUnitHtml({ id: 'stMaxSide', label: 'Max side', value: '1280' })}
        ${knobUnitHtml({ id: 'stDryRun', label: 'Dry run', value: '0', binary: true, leftCap: 'Run', rightCap: 'Dry' })}
      </div>
      <p class="knob-row-legend">
        <strong>Strength</strong> 1 = full style. <strong>Max side</strong> 0 = full res (video: per frame).
      </p>
    </div>
  `;
  elements.actionPanel.innerHTML = html;

  setupContinuousKnob({
    knobId: 'stStrengthKnob', indicatorId: 'stStrengthKnobInd', valueId: 'stStrengthVal', hiddenId: 'stStrength',
    min: 0, max: 1, step: 0.05, decimals: 2,
  });
  setupContinuousKnob({
    knobId: 'stMaxSideKnob', indicatorId: 'stMaxSideKnobInd', valueId: 'stMaxSideVal', hiddenId: 'stMaxSide',
    min: 0, max: 2048, step: 64, decimals: 0,
    format: (v) => (v <= 0 ? 'full' : String(Math.round(v))),
  });
  setupBinaryKnob({
    knobId: 'stDryRunKnob', indicatorId: 'stDryRunKnobInd', hiddenId: 'stDryRun',
    leftValue: '0', rightValue: '1', initial: '0',
  });

  document.getElementById('stStylePath')?.addEventListener('change', (e) => {
    state.styleTransfer.stylePath = e.target.value.trim() || null;
  });

  document.getElementById('btnStAddContent')?.addEventListener('click', async () => {
    await _addPathsFromPicker('files', 'image');
  });
  document.getElementById('btnStAddVideo')?.addEventListener('click', async () => {
    await _addPathsFromPicker('files', 'video');
  });
  document.getElementById('btnStAddFolder')?.addEventListener('click', async () => {
    try {
      const res = await fetch(`/api/picker?mode=dir&filter=all&start_path=`);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      const p = data.path || (data.paths && data.paths[0]);
      if (!p) return;
      if (state.styleTransfer.contents.some((x) => x.path === p)) return;
      state.styleTransfer.contents.push({ path: p, name: basename(p) + '/' });
      renderStyleTransferForm();
    } catch (err) {
      alert(`Picker failed: ${err.message}`);
    }
  });
  document.getElementById('btnStFromGlobal')?.addEventListener('click', () => {
    const added = _pullFromGlobals();
    if (!added) {
      alert('Global Video / Image bars are empty.');
      return;
    }
    renderStyleTransferForm();
  });
  document.getElementById('btnStClearContent')?.addEventListener('click', () => {
    state.styleTransfer.contents = [];
    renderStyleTransferForm();
  });
  document.getElementById('btnStStyleBrowse')?.addEventListener('click', async () => {
    try {
      const res = await fetch(`/api/picker?mode=files&filter=image&start_path=`);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      const p = (data.paths && data.paths[0]) || data.path;
      if (p) {
        state.styleTransfer.stylePath = p;
        const el = document.getElementById('stStylePath');
        if (el) el.value = p;
      }
    } catch (err) {
      alert(`Picker failed: ${err.message}`);
    }
  });
  document.getElementById('btnStOutBrowse')?.addEventListener('click', () => {
    openFileBrowser('stOutput', false, 'file_save', 'all');
  });
  document.getElementById('btnStOutDirBrowse')?.addEventListener('click', () => {
    openFileBrowser('stOutputDir', true, 'dir', 'all');
  });
  document.querySelectorAll('.fm-rm[data-st]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.dataset.idx, 10);
      state.styleTransfer.contents.splice(i, 1);
      if (state.styleTransfer.selected >= state.styleTransfer.contents.length) {
        state.styleTransfer.selected = Math.max(0, state.styleTransfer.contents.length - 1);
      }
      renderStyleTransferForm();
    });
  });
  document.getElementById('stContentList')?.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    const row = e.target.closest('.fm-item');
    if (!row) return;
    const i = parseInt(row.dataset.idx, 10);
    if (isNaN(i)) return;
    state.styleTransfer.selected = i;
    document.querySelectorAll('#stContentList .fm-item').forEach((el, idx) => {
      el.classList.toggle('is-selected', idx === i);
    });
    const it = state.styleTransfer.contents[i];
    if (it?.path) showPreview(it.path);
  });
}

registerListKeys('styletransfer', {
  getItems: () => state.styleTransfer.contents || [],
  getSelected: () => state.styleTransfer.selected | 0,
  setSelected: (i) => {
    state.styleTransfer.selected = i;
    document.querySelectorAll('#stContentList .fm-item').forEach((el, idx) => {
      el.classList.toggle('is-selected', idx === i);
    });
    const it = state.styleTransfer.contents[i];
    if (it?.path) showPreview(it.path);
  },
  moveItem: (from, to) => {
    const a = state.styleTransfer.contents || [];
    if (from < 0 || to < 0 || from >= a.length || to >= a.length) return;
    const item = a.splice(from, 1)[0];
    a.splice(to, 0, item);
    state.styleTransfer.selected = to;
    renderStyleTransferForm();
  },
});

async function _addPathsFromPicker(mode, filter) {
  try {
    const res = await fetch(`/api/picker?mode=${mode}&filter=${filter}&start_path=`);
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    const paths = data.paths || (data.path ? [data.path] : []);
    let n = 0;
    paths.forEach((p) => {
      if (!p) return;
      if (state.styleTransfer.contents.some((x) => x.path === p)) return;
      state.styleTransfer.contents.push({ path: p, name: basename(p) });
      n += 1;
    });
    if (n) renderStyleTransferForm();
  } catch (err) {
    alert(`Picker failed: ${err.message}`);
  }
}

/** Pull paths from global video + image bars into the content list. */
function _pullFromGlobals() {
  let n = 0;
  const add = (p) => {
    if (!p) return;
    if (state.styleTransfer.contents.some((x) => x.path === p)) return;
    state.styleTransfer.contents.push({ path: p, name: basename(p) });
    n += 1;
  };
  const gi = window.globalInputs || {};
  String(gi.video || '').split('\n').map((l) => l.trim()).filter(Boolean).forEach(add);
  String(gi.image || '').split('\n').map((l) => l.trim()).filter(Boolean).forEach(add);
  // also first bestInput-style line
  try {
    const b = typeof bestInput === 'function' ? bestInput() : '';
    if (b) add(b.trim());
  } catch (_) { /* ignore */ }
  return n;
}

function collectStyleTransferBody() {
  var contents = (state.styleTransfer.contents || []).map((x) => x.path).filter(Boolean);
  const style_path = (document.getElementById('stStylePath')?.value || state.styleTransfer.stylePath || '').trim();

  if (!contents.length) {
    // Prefer explicit global video for single-clip video runs, then images
    const gi = window.globalInputs || {};
    const vids = String(gi.video || '').split('\n').map((l) => l.trim()).filter(Boolean);
    const imgs = resolveGlobalImages();
    if (vids.length === 1 && !imgs.length) {
      contents = [vids[0]];
    } else if (vids.length && !imgs.length) {
      // multi video lines — take first as primary (batch video not supported in one POST)
      contents = [vids[0]];
    } else if (imgs.length) {
      contents = imgs;
    } else if (vids.length) {
      contents = [vids[0]];
    } else {
      alert('Add content (images and/or one video), or set the global Video / Image bars.');
      return null;
    }
  }

  if (!style_path) {
    alert('Pick a style image (painting / texture / etc.).');
    return null;
  }
  state.styleTransfer.stylePath = style_path;

  const videos = contents.filter(isVideoPath);
  const stills = contents.filter((p) => !isVideoPath(p));
  if (videos.length && stills.length) {
    alert('Run video and stills separately — mix is not supported in one job.\nClear the list or remove one type.');
    return null;
  }
  if (videos.length > 1) {
    alert('Style transfer video mode handles one clip at a time. Keep a single video in the content list.');
    return null;
  }

  const output = document.getElementById('stOutput')?.value?.trim() || null;
  const output_dir = document.getElementById('stOutputDir')?.value?.trim() || null;
  const singleVideo = videos.length === 1;

  return withFrameRange({
    content_path: singleVideo ? videos[0] : (contents.length === 1 ? contents[0] : null),
    content_paths: singleVideo ? null : contents,
    style_path,
    output_path: output || null,
    output_dir: output_dir || null,
    strength: parseFloat(document.getElementById('stStrength')?.value || '1'),
    max_side: parseInt(document.getElementById('stMaxSide')?.value || '1280', 10),
    style_size: 256,
    suffix: '_styled',
    dry_run: document.getElementById('stDryRun')?.value === '1',
  });
}

export { renderStyleTransferForm, collectStyleTransferBody };
