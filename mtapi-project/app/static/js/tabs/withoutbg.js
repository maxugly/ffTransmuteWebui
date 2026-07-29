import { state, elements, resolveGlobalImages } from '/app.js';
import { basename, escapeHtml } from '/js/utils.js';
import { setupBinaryKnob, knobUnitHtml } from '/js/ui/knobs.js';

// ── withoutBG tab (background removal) ───────────────────────────────────

function renderWithoutBgForm() {
  const imgs = state.withoutbg.images || [];
  const listHtml = imgs.length
    ? imgs.map((it, i) => `
        <div class="fm-item" data-idx="${i}">
          <span class="fm-ord">${String(i + 1).padStart(2, '0')}</span>
          <span class="fm-name" title="${escapeHtml(it.path)}">${escapeHtml(it.name || basename(it.path))}</span>
          <button type="button" class="btn fm-rm" data-idx="${i}" data-wbg="1">✕</button>
        </div>`).join('')
    : `<div class="fm-empty">Add one or more images (or a folder). Output names use the prefix knob.</div>`;

  const html = `
    <div class="panel-title-desc">
      <h3>withoutBG · remove backgrounds</h3>
      <p class="dream-hint">
        <a href="https://github.com/withoutbg/withoutbg-python" target="_blank" rel="noopener">withoutbg-python</a>
        — local open weights (free, private, ~455&nbsp;MB once) or Cloud API.
        Saves cutout / mask / leftover background independently.
      </p>
    </div>

    <div class="form-group">
      <label>Images (${imgs.length})</label>
      <div class="fm-list" id="wbgList">${listHtml}</div>
      <div class="input-row" style="margin-top:8px; flex-wrap:wrap;">
        <button type="button" class="btn btn-primary" id="btnWbgAddFiles">+ Images</button>
        <button type="button" class="btn" id="btnWbgAddFolder">+ Folder</button>
        <button type="button" class="btn" id="btnWbgClear" ${imgs.length ? '' : 'disabled'}>Clear</button>
      </div>
    </div>

    <div class="form-group">
      <label>Output folder (blank = next to each source)</label>
      <div class="input-row">
        <input type="text" id="wbgOutputDir" placeholder="~/img/cutouts/">
        <button type="button" class="btn" id="btnWbgOutBrowse">Browse</button>
      </div>
    </div>

    <div class="dream-section-title">Backend</div>
    <div class="form-group">
      <label>Mode</label>
      <select id="wbgBackend">
        <option value="local" selected>Local open weights (CPU, free)</option>
        <option value="api">Cloud API (WITHOUTBG_API_KEY)</option>
      </select>
      <p class="dream-hint" style="margin-top:6px">
        First local run downloads model weights from Hugging Face (~455&nbsp;MB).
        Cloud needs <code>WITHOUTBG_API_KEY</code> in the server environment.
      </p>
    </div>
    <div class="form-group" id="wbgApiKeyRow">
      <label>API key (optional override)</label>
      <input type="password" id="wbgApiKey" placeholder="sk_… or leave blank to use env" autocomplete="off">
    </div>

    <div class="dream-section-title">What to save</div>
    <div class="knob-bank">
      ${knobUnitHtml({ id: 'wbgSaveCutout', label: 'Cutout', value: '1', binary: true, leftCap: 'Off', rightCap: 'On' })}
      ${knobUnitHtml({ id: 'wbgSaveMask', label: 'Mask', value: '0', binary: true, leftCap: 'Off', rightCap: 'On' })}
      ${knobUnitHtml({ id: 'wbgSaveBg', label: 'Background', value: '0', binary: true, leftCap: 'Off', rightCap: 'On' })}
      ${knobUnitHtml({ id: 'wbgDryRun', label: 'Dry run', value: '0', binary: true, leftCap: 'Run', rightCap: 'Dry' })}
    </div>
    <p class="dream-hint">
      <strong>Cutout</strong> = subject RGBA (transparent BG).<br>
      <strong>Mask</strong> = grayscale alpha (white = subject).<br>
      <strong>Background</strong> = leftover scene (subject punched out / transparent).
    </p>

    <div class="dream-section-title">Naming / format</div>
    <div class="form-group">
      <label>Filename prefix</label>
      <input type="text" id="wbgPrefix" value="withoutbg" placeholder="withoutbg">
      <p class="dream-hint" style="margin-top:4px">
        e.g. <code>photo.jpg</code> → <code>withoutbg-photo.png</code>,
        <code>…-mask.png</code>, <code>…-bg.png</code>
      </p>
    </div>
    <div class="form-group">
      <label>Format (cutout &amp; background; mask is always PNG)</label>
      <select id="wbgFmt">
        <option value="png" selected>PNG (lossless alpha)</option>
        <option value="webp">WebP (alpha, smaller)</option>
      </select>
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
      const listRes = await fetch(`/api/facemorph/list?path=${encodeURIComponent(data.path)}`);
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
      renderWithoutBgForm();
    });
  });
}

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
  return {
    image_paths: images.length ? images : null,
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
  };
}

export { renderWithoutBgForm, collectWithoutBgBody };
