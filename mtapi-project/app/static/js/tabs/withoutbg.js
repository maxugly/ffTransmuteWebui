import { state, elements, resolveGlobalImages, showPreview } from '/app.js';
import { basename, escapeHtml, withFrameRange, isVideoPath } from '/js/utils.js';
import { setupBinaryKnob, knobUnitHtml } from '/js/ui/knobs.js';
import { registerListKeys } from '/js/ui/list-keys.js';

// ── withoutBG tab (background removal) ───────────────────────────────────

function renderWithoutBgForm() {
  const imgs = state.withoutbg.images || [];
  if (state.withoutbg.selected == null) state.withoutbg.selected = 0;
  if (imgs.length && state.withoutbg.selected >= imgs.length) {
    state.withoutbg.selected = imgs.length - 1;
  }
  const sel = state.withoutbg.selected | 0;
  const listHtml = imgs.length
    ? imgs.map((it, i) => `
        <div class="fm-item${i === sel ? ' is-selected' : ''}" data-idx="${i}">
          <span class="fm-ord">${String(i + 1).padStart(2, '0')}</span>
          <span class="fm-name" title="${escapeHtml(it.path)}">${escapeHtml(it.name || basename(it.path))}</span>
          <button type="button" class="btn fm-rm" data-idx="${i}" data-wbg="1">✕</button>
        </div>`).join('')
    : `<div class="fm-empty">Add images or a folder. Arrows select · Ctrl+arrows reorder.</div>`;

  const html = `
    <div class="panel-title-desc dense">
      <h3>withoutBG · remove backgrounds</h3>
      <p class="dream-hint">
        <a href="https://github.com/withoutbg/withoutbg-python" target="_blank" rel="noopener">withoutbg-python</a>
        — local open weights (~455&nbsp;MB once) or Cloud API. Cutout / mask / leftover BG.
      </p>
    </div>

    <div class="form-group" style="margin-bottom:6px">
      <div class="form-row" style="margin-bottom:3px">
        <label>Images (${imgs.length})</label>
        <div class="sort-toolbar" style="margin:0; flex:1">
          <button type="button" class="btn btn-primary" id="btnWbgAddFiles">+ Images</button>
          <button type="button" class="btn" id="btnWbgAddFolder">+ Folder</button>
          <button type="button" class="btn" id="btnWbgClear" ${imgs.length ? '' : 'disabled'}>Clear</button>
        </div>
      </div>
      <div class="fm-list" id="wbgList">${listHtml}</div>
    </div>

    <div class="form-row">
      <label for="wbgOutputDir">Output</label>
      <div class="input-row">
        <input type="text" id="wbgOutputDir" placeholder="blank = next to each source">
        <button type="button" class="btn" id="btnWbgOutBrowse">Browse</button>
      </div>
    </div>

    <div class="form-row">
      <label for="wbgBackend">Mode</label>
      <select id="wbgBackend">
        <option value="local" selected>Local (CPU, free)</option>
        <option value="api">Cloud API</option>
      </select>
      <p class="form-row-hint">First local run pulls HF weights (~455&nbsp;MB). Cloud needs <code>WITHOUTBG_API_KEY</code>.</p>
    </div>
    <div class="form-row hidden" id="wbgApiKeyRow">
      <label for="wbgApiKey">API key</label>
      <input type="password" id="wbgApiKey" placeholder="sk_… or blank = env" autocomplete="off">
      <p class="form-row-hint">Optional override of server env key.</p>
    </div>

    <div class="knob-row">
      <div class="knob-bank">
        ${knobUnitHtml({ id: 'wbgSaveCutout', label: 'Cutout', value: '1', binary: true, leftCap: 'Off', rightCap: 'On' })}
        ${knobUnitHtml({ id: 'wbgSaveMask', label: 'Mask', value: '0', binary: true, leftCap: 'Off', rightCap: 'On' })}
        ${knobUnitHtml({ id: 'wbgSaveBg', label: 'Background', value: '0', binary: true, leftCap: 'Off', rightCap: 'On' })}
        ${knobUnitHtml({ id: 'wbgDryRun', label: 'Dry run', value: '0', binary: true, leftCap: 'Run', rightCap: 'Dry' })}
      </div>
      <p class="knob-row-legend">
        <strong>Cutout</strong> = subject RGBA (transparent BG).<br>
        <strong>Mask</strong> = grayscale alpha (white = subject).<br>
        <strong>Background</strong> = leftover scene (subject punched out).
      </p>
    </div>

    <div class="form-row">
      <label for="wbgPrefix">Prefix</label>
      <input type="text" id="wbgPrefix" value="withoutbg" placeholder="withoutbg">
      <p class="form-row-hint"><code>photo.jpg</code> → <code>withoutbg-photo.png</code>, <code>…-mask.png</code>, <code>…-bg.png</code></p>
    </div>
    <div class="form-row">
      <label for="wbgFmt">Format</label>
      <select id="wbgFmt">
        <option value="png" selected>PNG (lossless alpha)</option>
        <option value="webp">WebP (alpha, smaller)</option>
      </select>
      <p class="form-row-hint">Cutout &amp; background only — mask is always PNG.</p>
    </div>
  `;
  elements.actionPanel.innerHTML = html;

  setupBinaryKnob({
    knobId: 'wbgSaveCutoutKnob', indicatorId: 'wbgSaveCutoutKnobInd', hiddenId: 'wbgSaveCutout',
    leftValue: '0', rightValue: '1', initial: '1',
  });
  setupBinaryKnob({
    knobId: 'wbgSaveMaskKnob', indicatorId: 'wbgSaveMaskKnobInd', hiddenId: 'wbgSaveMask',
    leftValue: '0', rightValue: '1', initial: '0',
  });
  setupBinaryKnob({
    knobId: 'wbgSaveBgKnob', indicatorId: 'wbgSaveBgKnobInd', hiddenId: 'wbgSaveBg',
    leftValue: '0', rightValue: '1', initial: '0',
  });
  setupBinaryKnob({
    knobId: 'wbgDryRunKnob', indicatorId: 'wbgDryRunKnobInd', hiddenId: 'wbgDryRun',
    leftValue: '0', rightValue: '1', initial: '0',
  });

  const syncApi = () => {
    const api = document.getElementById('wbgBackend')?.value === 'api';
    document.getElementById('wbgApiKeyRow')?.classList.toggle('hidden', !api);
  };
  document.getElementById('wbgBackend')?.addEventListener('change', syncApi);
  syncApi();

  document.getElementById('btnWbgAddFiles')?.addEventListener('click', async () => {
    try {
      const res = await fetch(`/api/picker?mode=files&filter=image&start_path=`);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      const paths = data.paths || (data.path ? [data.path] : []);
      paths.forEach((p) => {
        if (!p) return;
        if (state.withoutbg.images.some((x) => x.path === p)) return;
        state.withoutbg.images.push({ path: p, name: basename(p) });
      });
      renderWithoutBgForm();
    } catch (err) {
      alert(`Picker failed: ${err.message}`);
    }
  });
  document.getElementById('btnWbgAddFolder')?.addEventListener('click', async () => {
    try {
      const res = await fetch(`/api/picker?mode=dir&start_path=`);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      if (!data.path) return;
      const listRes = await fetch(`/api/images/list?path=${encodeURIComponent(data.path)}`);
      if (listRes.ok) {
        const listed = await listRes.json();
        (listed.files || []).forEach((p) => {
          if (state.withoutbg.images.some((x) => x.path === p)) return;
          state.withoutbg.images.push({ path: p, name: basename(p) });
        });
      } else {
        state.withoutbg.folder = data.path;
      }
      renderWithoutBgForm();
    } catch (err) {
      alert(`Folder pick failed: ${err.message}`);
    }
  });
  document.getElementById('btnWbgClear')?.addEventListener('click', () => {
    state.withoutbg.images = [];
    state.withoutbg.folder = null;
    renderWithoutBgForm();
  });
  document.getElementById('btnWbgOutBrowse')?.addEventListener('click', () => {
    openFileBrowser('wbgOutputDir', true, 'dir', 'all');
  });
  document.querySelectorAll('.fm-rm[data-wbg]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.dataset.idx, 10);
      state.withoutbg.images.splice(i, 1);
      if (state.withoutbg.selected >= state.withoutbg.images.length) {
        state.withoutbg.selected = Math.max(0, state.withoutbg.images.length - 1);
      }
      renderWithoutBgForm();
    });
  });
  document.getElementById('wbgList')?.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    const row = e.target.closest('.fm-item');
    if (!row) return;
    const i = parseInt(row.dataset.idx, 10);
    if (isNaN(i)) return;
    state.withoutbg.selected = i;
    document.querySelectorAll('#wbgList .fm-item').forEach((el, idx) => {
      el.classList.toggle('is-selected', idx === i);
    });
    const it = state.withoutbg.images[i];
    if (it?.path) showPreview(it.path);
  });
}

registerListKeys('withoutbg', {
  getItems: () => state.withoutbg.images || [],
  getSelected: () => state.withoutbg.selected | 0,
  setSelected: (i) => {
    state.withoutbg.selected = i;
    document.querySelectorAll('#wbgList .fm-item').forEach((el, idx) => {
      el.classList.toggle('is-selected', idx === i);
    });
    const it = state.withoutbg.images[i];
    if (it?.path) showPreview(it.path);
  },
  moveItem: (from, to) => {
    const a = state.withoutbg.images || [];
    if (from < 0 || to < 0 || from >= a.length || to >= a.length) return;
    const item = a.splice(from, 1)[0];
    a.splice(to, 0, item);
    state.withoutbg.selected = to;
    renderWithoutBgForm();
  },
});

function collectWithoutBgBody() {
  var images = (state.withoutbg.images || []).map((x) => x.path);
  if (!images.length && !state.withoutbg.folder) {
    var fallbacks = resolveGlobalImages();
    if (fallbacks.length) { images = fallbacks; }
    else { alert('Add at least one image (or a folder).'); return null; }
  }
  const save_cutout = document.getElementById('wbgSaveCutout')?.value === '1';
  const save_mask = document.getElementById('wbgSaveMask')?.value === '1';
  const save_background = document.getElementById('wbgSaveBg')?.value === '1';
  if (!save_cutout && !save_mask && !save_background) {
    alert('Turn on at least one of: Cutout, Mask, Background.');
    return null;
  }
  const apiKey = document.getElementById('wbgApiKey')?.value?.trim() || null;
  const singleVideo = images.length === 1 && isVideoPath(images[0]);
  return withFrameRange({
    input_path: singleVideo ? images[0] : null,
    image_paths: singleVideo ? null : (images.length ? images : null),
    image_dir: images.length ? null : (state.withoutbg.folder || null),
    output_dir: document.getElementById('wbgOutputDir')?.value?.trim() || null,
    backend: document.getElementById('wbgBackend')?.value || 'local',
    api_key: apiKey,
    save_cutout,
    save_mask,
    save_background,
    prefix: document.getElementById('wbgPrefix')?.value ?? 'withoutbg',
    suffix: '',
    fmt: document.getElementById('wbgFmt')?.value || 'png',
    dry_run: document.getElementById('wbgDryRun')?.value === '1',
  });
}

export { renderWithoutBgForm, collectWithoutBgBody };
