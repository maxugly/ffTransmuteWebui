import { state, elements, escapeHtml, basename, resolveGlobalImages } from '/app.js';
import { setupContinuousKnob, setupBinaryKnob, knobUnitHtml } from '/js/ui/knobs.js';

// ── Style Transfer tab (Magenta arbitrary stylization) ───────────────────

function renderStyleTransferForm() {
  const contents = state.styleTransfer.contents || [];
  const stylePath = state.styleTransfer.stylePath;
  const listHtml = contents.length
    ? contents.map((it, i) => `
        <div class="fm-item" data-idx="${i}">
          <span class="fm-ord">${String(i + 1).padStart(2, '0')}</span>
          <span class="fm-name" title="${escapeHtml(it.path)}">${escapeHtml(it.name || basename(it.path))}</span>
          <button type="button" class="btn fm-rm" data-idx="${i}" data-st="1">✕</button>
        </div>`).join('')
    : `<div class="fm-empty">Add content photo(s). One style image paints them all.</div>`;

  const html = `
    <div class="panel-title-desc">
      <h3>Neural style transfer</h3>
      <p class="dream-hint">
        Magenta <strong>arbitrary stylization</strong> (TF-Hub) — one ~90&nbsp;MB model,
        unlimited styles via a reference image (painting, glass, texture…).
        Not DeepDream: no ImageNet dog faces.
      </p>
    </div>

    <div class="styletransfer-banner" style="background:rgba(234,179,8,0.12); border:1px solid rgba(234,179,8,0.3); border-radius:6px; padding:10px 14px; font-size:0.82rem; color:#facc15; margin-bottom:12px;">
      ⚠ Style Transfer uses a style reference image in addition to content images.
      Choose your content images in the global bar above, then pick a style image in the form below.
    </div>

    <div class="form-group">
      <label>Content images (${contents.length})</label>
      <div class="fm-list" id="stContentList">${listHtml}</div>
      <div class="input-row" style="margin-top:8px; flex-wrap:wrap;">
        <button type="button" class="btn btn-primary" id="btnStAddContent">+ Content</button>
        <button type="button" class="btn" id="btnStAddFolder">+ Folder</button>
        <button type="button" class="btn" id="btnStClearContent" ${contents.length ? '' : 'disabled'}>Clear</button>
      </div>
      <span class="field-desc">Blank output → each result is written next to its content as <code>*_styled.png</code> (never overwrites; uses <code>_0001</code>, …).</span>
    </div>

    <div class="form-group">
      <label>Style image (required)</label>
      <div class="input-row">
        <input type="text" id="stStylePath" placeholder="~/art/stained_glass.jpg"
          value="${stylePath ? escapeHtml(stylePath) : ''}">
        <button type="button" class="btn" id="btnStStyleBrowse">Browse</button>
      </div>
      <p class="dream-hint" style="margin-top:4px">
        Any RGB image: Van Gogh crop, brush texture, mosaic photo, UI mockup…
      </p>
    </div>

    <div class="form-group">
      <label>Output (optional — leave blank to write next to each content)</label>
      <div class="input-row">
        <input type="text" id="stOutput" placeholder="optional single-file Save As (still never overwrites)">
        <button type="button" class="btn" id="btnStOutBrowse">Save As</button>
      </div>
      <div class="input-row" style="margin-top:6px;">
        <input type="text" id="stOutputDir" placeholder="optional shared output folder for the whole batch">
        <button type="button" class="btn" id="btnStOutDirBrowse">Folder</button>
      </div>
    </div>

    <div class="dream-section-title">Knobs</div>
    <div class="knob-bank">
      ${knobUnitHtml({ id: 'stStrength', label: 'Strength', value: '1.0' })}
      ${knobUnitHtml({ id: 'stMaxSide', label: 'Max side', value: '1280' })}
      ${knobUnitHtml({ id: 'stDryRun', label: 'Dry run', value: '0', binary: true, leftCap: 'Run', rightCap: 'Dry' })}
    </div>
    <p class="dream-hint">
      Strength blends stylized with original (1 = full style).
      Max side caps content resolution for RAM/speed — 0 = full size.
      Model cache ~90&nbsp;MB; peak RAM usually ~1&nbsp;GB with TF.
    </p>
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
    try {
      const res = await fetch(`/api/picker?mode=files&filter=image&start_path=`);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      const paths = data.paths || (data.path ? [data.path] : []);
      paths.forEach((p) => {
        if (!p) return;
        if (state.styleTransfer.contents.some((x) => x.path === p)) return;
        state.styleTransfer.contents.push({ path: p, name: basename(p) });
      });
      renderStyleTransferForm();
    } catch (err) {
      alert(`Picker failed: ${err.message}`);
    }
  });
  document.getElementById('btnStAddFolder')?.addEventListener('click', async () => {
    try {
      // Pass folder path through; backend expands images in the directory
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
      renderStyleTransferForm();
    });
  });
}

function collectStyleTransferBody() {
  var contents = (state.styleTransfer.contents || []).map((x) => x.path).filter(Boolean);
  const style_path = (document.getElementById('stStylePath')?.value || state.styleTransfer.stylePath || '').trim();
  if (!contents.length) {
    var fallbacks = resolveGlobalImages();
    if (fallbacks.length) { contents = fallbacks; }
    else {
      alert('Add at least one content image or folder.');
      return null;
    }
  }
  if (!style_path) {
    alert('Pick a style image (painting / texture / etc.).');
    return null;
  }
  state.styleTransfer.stylePath = style_path;
  const output = document.getElementById('stOutput')?.value?.trim() || null;
  const output_dir = document.getElementById('stOutputDir')?.value?.trim() || null;
  // Always send content_paths so folders expand server-side the same as multi-select
  return {
    content_path: null,
    content_paths: contents,
    style_path,
    // Save As only applies as a file target when one content file (not a folder)
    output_path: output || null,
    output_dir: output_dir || null,
    strength: parseFloat(document.getElementById('stStrength')?.value || '1'),
    max_side: parseInt(document.getElementById('stMaxSide')?.value || '1280', 10),
    style_size: 256,
    suffix: '_styled',
    dry_run: document.getElementById('stDryRun')?.value === '1',
  };
}

export { renderStyleTransferForm, collectStyleTransferBody };
