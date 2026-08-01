import { state, elements, logConsole, showPreview } from '/app.js';
import { basename, escapeHtml } from '/js/utils.js';
import { setupContinuousKnob, setupBinaryKnob, knobUnitHtml } from '/js/ui/knobs.js';

function _durationEst() {
  var K = (state.imageSort.images || []).length;
  if (K < 2) return '—';
  var useRife = document.getElementById('isUseRife')?.value === '1';
  var M = useRife ? parseInt(document.getElementById('isMultiplier')?.value || '2', 10) : 1;
  var fps = parseFloat(document.getElementById('isFps')?.value || '24');
  return ((K * M) / Math.max(fps, 1e-9)).toFixed(2);
}

function _updateDurHint() {
  var el = document.getElementById('isDurHint');
  if (el) el.textContent = _durationEst();
  var el2 = document.getElementById('isDurHint2');
  if (el2) el2.textContent = _durationEst();
}

function _clampSelected() {
  var n = (state.imageSort.images || []).length;
  if (n <= 0) {
    state.imageSort.selected = 0;
    return;
  }
  var s = state.imageSort.selected | 0;
  if (s < 0) s = 0;
  if (s >= n) s = n - 1;
  state.imageSort.selected = s;
}

function _selectIndex(i, preview) {
  var imgs = state.imageSort.images || [];
  if (!imgs.length) return;
  if (i < 0) i = 0;
  if (i >= imgs.length) i = imgs.length - 1;
  state.imageSort.selected = i;
  var list = document.getElementById('isList');
  if (list) {
    list.querySelectorAll('.is-row').forEach(function(row) {
      var idx = parseInt(row.dataset.idx, 10);
      row.classList.toggle('is-selected', idx === i);
    });
  }
  _syncOrderButtons();
  if (preview !== false && imgs[i]) {
    showPreview(imgs[i].path);
  }
}

function _syncOrderButtons() {
  var imgs = state.imageSort.images || [];
  var i = state.imageSort.selected | 0;
  var has = imgs.length > 0;
  var atTop = !has || i <= 0;
  var atBtm = !has || i >= imgs.length - 1;
  var map = {
    btnIsTop: atTop,
    btnIsUp: atTop,
    btnIsDown: atBtm,
    btnIsBtm: atBtm,
    btnIsRm: !has,
  };
  Object.keys(map).forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.disabled = map[id];
  });
  var label = document.getElementById('isSelLabel');
  if (label) {
    if (!has) label.textContent = 'none selected';
    else {
      var name = imgs[i].name || basename(imgs[i].path);
      label.textContent = '#' + String(i + 1).padStart(2, '0') + ' · ' + name;
    }
  }
}

function _moveSelected(action) {
  var imgs = state.imageSort.images || [];
  var i = state.imageSort.selected | 0;
  if (!imgs.length || i < 0 || i >= imgs.length) return;

  if (action === 'rm') {
    imgs.splice(i, 1);
    if (i >= imgs.length) i = Math.max(0, imgs.length - 1);
    state.imageSort.selected = i;
    renderImageSortForm();
    return;
  }
  if (action === 'top' && i > 0) {
    var item = imgs.splice(i, 1)[0];
    imgs.unshift(item);
    state.imageSort.selected = 0;
    renderImageSortForm();
    return;
  }
  if (action === 'btm' && i < imgs.length - 1) {
    var item2 = imgs.splice(i, 1)[0];
    imgs.push(item2);
    state.imageSort.selected = imgs.length - 1;
    renderImageSortForm();
    return;
  }
  if (action === 'up' && i > 0) {
    var a = imgs[i - 1];
    imgs[i - 1] = imgs[i];
    imgs[i] = a;
    state.imageSort.selected = i - 1;
    renderImageSortForm();
    return;
  }
  if (action === 'down' && i < imgs.length - 1) {
    var b = imgs[i + 1];
    imgs[i + 1] = imgs[i];
    imgs[i] = b;
    state.imageSort.selected = i + 1;
    renderImageSortForm();
  }
}

function renderImageSortForm() {
  var images = state.imageSort.images || [];
  _clampSelected();
  var sel = state.imageSort.selected | 0;

  var listHtml = images.length
    ? images.map(function(it, i) {
        var scoreStr = it.score != null ? ' <span class="is-score">(' + Number(it.score).toFixed(1) + ')</span>' : '';
        var baseBadge = i === 0 ? ' <span class="is-base-badge">BASE</span>' : '';
        var classes = 'is-row' + (i === 0 ? ' is-base' : '') + (i === sel ? ' is-selected' : '');
        return `
        <div class="${classes}" data-idx="${i}" role="option" aria-selected="${i === sel ? 'true' : 'false'}">
          <span class="fm-ord">${String(i + 1).padStart(2, '0')}</span>
          <span class="fm-name" title="${escapeHtml(it.path)}">${escapeHtml(it.name || basename(it.path))}${scoreStr}${baseBadge}</span>
        </div>`;
      }).join('')
    : `<div class="fm-empty is-empty-hint">Add 2+ images. Slot #1 is the base (sort anchor + size reference). Click a row to select, then reorder with the buttons below.</div>`;

  var dur = _durationEst();
  var selName = images.length
    ? ('#' + String(sel + 1).padStart(2, '0') + ' · ' + (images[sel].name || basename(images[sel].path)))
    : 'none selected';

  var html = `
    <div class="panel-title-desc dense">
      <h3>Image Sort → Video</h3>
      <p class="dream-hint">
        <strong>#1 = base</strong> · sort #2…N · optional RIFE · encode.
        Duration = K × M ÷ fps (~<span id="isDurHint">${dur}</span>s).
      </p>
    </div>

    <div class="form-group" style="margin-bottom:6px">
      <div class="form-row" style="margin-bottom:3px">
        <label>Stills (${images.length})</label>
        <div class="sort-toolbar" style="margin:0; flex:1">
          <button type="button" class="btn btn-primary" id="btnIsAddFiles">+ Images</button>
          <button type="button" class="btn" id="btnIsAddFolder">+ Folder</button>
          <button type="button" class="btn" id="btnIsSort" ${images.length < 2 ? 'disabled' : ''}>Sort</button>
          <button type="button" class="btn" id="btnIsClear" ${images.length ? '' : 'disabled'}>Clear</button>
        </div>
        <p class="form-row-hint">Click row = select + preview · Sort re-ranks #2…N only</p>
      </div>
      <div class="fm-list" id="isList" role="listbox">${listHtml}</div>
      <div class="is-order-bar" id="isOrderBar">
        <span class="is-order-label" id="isSelLabel">${escapeHtml(selName)}</span>
        <button type="button" class="btn" id="btnIsTop" title="To top (new base)" ${!images.length || sel <= 0 ? 'disabled' : ''}>⤒</button>
        <button type="button" class="btn" id="btnIsUp" title="Up" ${!images.length || sel <= 0 ? 'disabled' : ''}>↑</button>
        <button type="button" class="btn" id="btnIsDown" title="Down" ${!images.length || sel >= images.length - 1 ? 'disabled' : ''}>↓</button>
        <button type="button" class="btn" id="btnIsBtm" title="To bottom" ${!images.length || sel >= images.length - 1 ? 'disabled' : ''}>⤓</button>
        <button type="button" class="btn" id="btnIsRm" title="Remove" ${!images.length ? 'disabled' : ''}>✕</button>
      </div>
    </div>

    <div class="form-row">
      <label for="isOutput">Output</label>
      <div class="input-row">
        <input type="text" id="isOutput" placeholder="blank = auto">
        <button type="button" class="btn" id="btnIsOutBrowse">Save As</button>
      </div>
    </div>

    <div class="form-row">
      <label for="isSortMode">Mode</label>
      <select id="isSortMode">
        <option value="phash" selected>pHash</option>
        <option value="ahash">aHash</option>
        <option value="colorhash">colorhash</option>
        <option value="mse">MSE</option>
        <option value="ssim">SSIM</option>
      </select>
      <label for="isSortOrder">Order</label>
      <select id="isSortOrder">
        <option value="nearest_first" selected>Nearest first</option>
        <option value="farthest_first">Farthest first</option>
      </select>
      <label for="isFit">Fit</label>
      <select id="isFit">
        <option value="letterbox" selected>Letterbox</option>
        <option value="crop">Crop</option>
        <option value="stretch">Stretch</option>
      </select>
    </div>

    <div class="knob-row">
      <div class="knob-bank">
        ${knobUnitHtml({ id: 'isUseRife', label: 'Use RIFE', value: '1', binary: true, leftCap: 'Off', rightCap: 'On' })}
        ${knobUnitHtml({ id: 'isMultiplier', label: 'Multiplier', value: '2' })}
        ${knobUnitHtml({ id: 'isRifeTta', label: 'TTA', value: '0', binary: true, leftCap: 'Off', rightCap: 'On' })}
        ${knobUnitHtml({ id: 'isRifeUhd', label: 'UHD', value: '0', binary: true, leftCap: 'Off', rightCap: 'On' })}
        ${knobUnitHtml({ id: 'isFps', label: 'FPS', value: '24' })}
        ${knobUnitHtml({ id: 'isCrf', label: 'CRF', value: '18' })}
        ${knobUnitHtml({ id: 'isKeepFrames', label: 'Keep PNG', value: '0', binary: true, leftCap: 'No', rightCap: 'Yes' })}
        ${knobUnitHtml({ id: 'isDryRun', label: 'Dry run', value: '0', binary: true, leftCap: 'Run', rightCap: 'Dry' })}
      </div>
      <p class="knob-row-legend" id="isRifeHint">
        RIFE multiplies keyframes. ~duration <span id="isDurHint2">${dur}</span>s.
        FPS is absolute (not scaled by M). CRF 0 = lossless · 18 ≈ near-lossless.
      </p>
    </div>
    <div class="form-row" id="isRifeOpts">
      <label for="isRifeModel">RIFE model</label>
      <select id="isRifeModel">
        <option value="rife-v4.6" selected>rife-v4.6</option>
        <option value="rife-v4">rife-v4</option>
        <option value="rife-v2.4">rife-v2.4</option>
        <option value="rife-v2.3">rife-v2.3</option>
      </select>
    </div>
  `;
  elements.actionPanel.innerHTML = html;

  // knobs
  setupBinaryKnob({
    knobId: 'isUseRifeKnob', indicatorId: 'isUseRifeKnobInd', hiddenId: 'isUseRife',
    leftValue: '0', rightValue: '1', initial: '1',
  });
  setupContinuousKnob({
    knobId: 'isMultiplierKnob', indicatorId: 'isMultiplierKnobInd', valueId: 'isMultiplierVal', hiddenId: 'isMultiplier',
    min: 2, max: 8, step: 1, decimals: 0,
  });
  setupBinaryKnob({
    knobId: 'isRifeTtaKnob', indicatorId: 'isRifeTtaKnobInd', hiddenId: 'isRifeTta',
    leftValue: '0', rightValue: '1', initial: '0',
  });
  setupBinaryKnob({
    knobId: 'isRifeUhdKnob', indicatorId: 'isRifeUhdKnobInd', hiddenId: 'isRifeUhd',
    leftValue: '0', rightValue: '1', initial: '0',
  });
  setupContinuousKnob({
    knobId: 'isFpsKnob', indicatorId: 'isFpsKnobInd', valueId: 'isFpsVal', hiddenId: 'isFps',
    min: 1, max: 120, step: 1, decimals: 0,
  });
  setupContinuousKnob({
    knobId: 'isCrfKnob', indicatorId: 'isCrfKnobInd', valueId: 'isCrfVal', hiddenId: 'isCrf',
    min: 0, max: 28, step: 1, decimals: 0,
  });
  setupBinaryKnob({
    knobId: 'isKeepFramesKnob', indicatorId: 'isKeepFramesKnobInd', hiddenId: 'isKeepFrames',
    leftValue: '0', rightValue: '1', initial: '0',
  });
  setupBinaryKnob({
    knobId: 'isDryRunKnob', indicatorId: 'isDryRunKnobInd', hiddenId: 'isDryRun',
    leftValue: '0', rightValue: '1', initial: '0',
  });

  // RIFE visibility
  (function syncRifeOpts() {
    var use = document.getElementById('isUseRife')?.value === '1';
    var opts = document.getElementById('isRifeOpts');
    if (opts) opts.style.display = use ? '' : 'none';
  })();
  document.getElementById('isUseRifeKnob')?.addEventListener('click', function() {
    setTimeout(function() {
      var use = document.getElementById('isUseRife')?.value === '1';
      var opts = document.getElementById('isRifeOpts');
      if (opts) opts.style.display = use ? '' : 'none';
      _updateDurHint();
    }, 100);
  });

  ['isMultiplierKnob', 'isFpsKnob', 'isUseRifeKnob'].forEach(function(id) {
    document.getElementById(id)?.addEventListener('click', function() {
      setTimeout(_updateDurHint, 100);
    });
  });

  // Shared order controls (one set for the selected row)
  document.getElementById('btnIsTop')?.addEventListener('click', function() { _moveSelected('top'); });
  document.getElementById('btnIsUp')?.addEventListener('click', function() { _moveSelected('up'); });
  document.getElementById('btnIsDown')?.addEventListener('click', function() { _moveSelected('down'); });
  document.getElementById('btnIsBtm')?.addEventListener('click', function() { _moveSelected('btm'); });
  document.getElementById('btnIsRm')?.addEventListener('click', function() { _moveSelected('rm'); });

  // Sort button
  document.getElementById('btnIsSort')?.addEventListener('click', async function() {
    var imgs = state.imageSort.images || [];
    if (imgs.length < 2) { alert('Need at least 2 images to sort.'); return; }
    var paths = imgs.map(function(x) { return x.path; });
    var mode = document.getElementById('isSortMode')?.value || 'phash';
    var order = document.getElementById('isSortOrder')?.value || 'nearest_first';
    logConsole('[IMAGESORT]: sorting ' + imgs.length + ' images with ' + mode + '…');
    try {
      var res = await fetch('/ops/imagesort_rank', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_paths: paths, sort_mode: mode, sort_order: order }),
      });
      var data = await res.json();
      if (!data.ok) { alert('Sort failed: ' + (data.error || 'unknown')); return; }
      if (data.stdout) logConsole('[IMAGESORT-RANK]:\n' + data.stdout);
      var ordered = data.ordered_paths || [];
      var items = data.items || [];
      var newImages = [];
      var scoreMap = {};
      items.forEach(function(it) { if (it.score != null) scoreMap[it.path] = it.score; });
      var selectedPath = imgs[state.imageSort.selected | 0] && imgs[state.imageSort.selected | 0].path;
      ordered.forEach(function(p) {
        var existing = imgs.find(function(x) { return x.path === p; });
        if (existing) {
          newImages.push({ path: p, name: existing.name, score: scoreMap[p] != null ? scoreMap[p] : null });
        } else {
          newImages.push({ path: p, name: basename(p), score: scoreMap[p] != null ? scoreMap[p] : null });
        }
      });
      state.imageSort.images = newImages;
      // Keep selection on the same path if still present
      var newSel = 0;
      if (selectedPath) {
        var found = newImages.findIndex(function(x) { return x.path === selectedPath; });
        if (found >= 0) newSel = found;
      }
      state.imageSort.selected = newSel;
      renderImageSortForm();
    } catch (err) {
      alert('Sort request failed: ' + err.message);
    }
  });

  // + Images
  document.getElementById('btnIsAddFiles')?.addEventListener('click', async function() {
    try {
      var res = await fetch('/api/picker?mode=files&filter=image&start_path=');
      if (!res.ok) throw new Error(await res.text());
      var data = await res.json();
      var paths = data.paths || (data.path ? [data.path] : []);
      var added = 0;
      var firstNew = -1;
      paths.forEach(function(p) {
        if (!p) return;
        if (state.imageSort.images.some(function(x) { return x.path === p; })) return;
        state.imageSort.images.push({ path: p, name: basename(p), score: null });
        if (firstNew < 0) firstNew = state.imageSort.images.length - 1;
        added++;
      });
      if (added) {
        if (firstNew >= 0) state.imageSort.selected = firstNew;
        renderImageSortForm();
      }
    } catch (err) {
      alert('Picker failed: ' + err.message);
    }
  });

  // + Folder — expand stills into the sequence list
  document.getElementById('btnIsAddFolder')?.addEventListener('click', async function() {
    try {
      var res = await fetch('/api/picker?mode=dir&start_path=');
      if (!res.ok) throw new Error(await res.text());
      var data = await res.json();
      if (!data.path) return;
      logConsole('[IMAGESORT]: Listing images in ' + data.path + '…');
      // Prefer generic image list; fall back to pool scan (same source of truth as Image Pool)
      var files = [];
      var listRes = await fetch('/api/images/list?path=' + encodeURIComponent(data.path));
      if (listRes.ok) {
        var listed = await listRes.json();
        files = listed.files || [];
      } else {
        var scanRes = await fetch(
          '/api/pool/scan?path=' + encodeURIComponent(data.path) + '&recursive=false&kind=image'
        );
        if (scanRes.ok) {
          var scan = await scanRes.json();
          files = (scan.images || []).map(function(v) { return v.path; });
        } else {
          throw new Error('Could not list folder images (list + scan both failed)');
        }
      }
      var added = 0;
      var firstNew = -1;
      files.forEach(function(p) {
        if (!p) return;
        if (state.imageSort.images.some(function(x) { return x.path === p; })) return;
        state.imageSort.images.push({ path: p, name: basename(p), score: null });
        if (firstNew < 0) firstNew = state.imageSort.images.length - 1;
        added++;
      });
      if (added) {
        logConsole('[IMAGESORT]: Folder ' + data.path + ' — added ' + added + ' image(s) (' + state.imageSort.images.length + ' total)');
        if (firstNew >= 0) state.imageSort.selected = firstNew;
      } else if (!files.length) {
        logConsole('[IMAGESORT]: Folder ' + data.path + ' — no image files found');
        alert('No image files found in that folder.');
      } else {
        logConsole('[IMAGESORT]: Folder ' + data.path + ' — all images already in list');
      }
      state.imageSort.folder = null;
      renderImageSortForm();
    } catch (err) {
      alert('Folder pick failed: ' + err.message);
      logConsole('[IMAGESORT ERROR]: ' + err.message, 'error');
    }
  });

  // Clear
  document.getElementById('btnIsClear')?.addEventListener('click', function() {
    state.imageSort.images = [];
    state.imageSort.folder = null;
    state.imageSort.selected = 0;
    renderImageSortForm();
  });

  // Output browse
  document.getElementById('btnIsOutBrowse')?.addEventListener('click', function() {
    openFileBrowser('isOutput', false, 'file_save', 'all');
  });

  // Click row → select + preview
  var list = document.getElementById('isList');
  if (list) {
    list.addEventListener('click', function(e) {
      var row = e.target.closest('.is-row');
      if (!row) return;
      var i = parseInt(row.dataset.idx, 10);
      if (isNaN(i)) return;
      _selectIndex(i, true);
    });
  }

  // Preview current selection after re-render (no flash if empty)
  if (images.length) {
    _selectIndex(sel, true);
  } else {
    _syncOrderButtons();
  }
}

function collectImageSortBody() {
  var images = (state.imageSort.images || []).map(function(x) { return x.path; });
  var folder = state.imageSort.folder || null;

  if (images.length < 2 && !folder) {
    alert('Add at least 2 images to the sequence list (or a folder with 2+ images).');
    return null;
  }
  if (images.length === 1 && !folder) {
    alert('Need at least 2 images. Slot #1 is base — add more stills.');
    return null;
  }

  var useRife = document.getElementById('isUseRife')?.value === '1';
  var body = {
    image_paths: images.length >= 2 ? images : null,
    image_dir: images.length < 2 ? folder : null,
    sort_mode: document.getElementById('isSortMode')?.value || 'phash',
    sort_order: document.getElementById('isSortOrder')?.value || 'nearest_first',
    auto_sort: false,
    use_rife: useRife,
    multiplier: parseInt(document.getElementById('isMultiplier')?.value || '2', 10),
    model: document.getElementById('isRifeModel')?.value || 'rife-v4.6',
    tta: document.getElementById('isRifeTta')?.value === '1',
    uhd: document.getElementById('isRifeUhd')?.value === '1',
    fps: parseFloat(document.getElementById('isFps')?.value || '24'),
    fit: document.getElementById('isFit')?.value || 'letterbox',
    output_path: document.getElementById('isOutput')?.value?.trim() || null,
    crf: parseInt(document.getElementById('isCrf')?.value || '18', 10),
    keep_frames: document.getElementById('isKeepFrames')?.value === '1',
    dry_run: document.getElementById('isDryRun')?.value === '1',
  };
  return body;
}

export { renderImageSortForm, collectImageSortBody };
