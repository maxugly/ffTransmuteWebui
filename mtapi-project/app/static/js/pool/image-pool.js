/**
 * Image Pool — stills library (separate from Video Pool).
 *
 * State: state.imagePool { items, selectedPath, filterQuery }
 * Persist: same session/project file under key `images` (see video-image-pools-spec).
 */
import { state, elements, logConsole, showPreview, checkHealth, switchTab, formatBytes } from '/app.js';
import { isImagePath, basename, escapeHtml } from '/js/utils.js';
import {
  scheduleSavePoolState, poolThumbUrl, shortHash, projectLabel,
  projectNew, projectOpen, projectSave,
} from '/js/pool/persistence.js';
import { observe as lazyObserve, unobserve as lazyUnobserve, clearPending as lazyClearPending } from '/js/lazy-loader.js';
import { validateItemSignature, assignCardThumbs, metaRetryHtml } from '/js/pool/freshness.js';

const _observedImageCards = new Set();

function releaseObservedImageCards() {
  for (const el of _observedImageCards) lazyUnobserve(el);
  _observedImageCards.clear();
}

// ── helpers ──────────────────────────────────────────────────────────────

function ensureImagePool() {
  if (!state.imagePool) {
    state.imagePool = { items: [], selectedPath: null, filterQuery: '', loading: false };
  }
  if (!Array.isArray(state.imagePool.items)) state.imagePool.items = [];
  return state.imagePool;
}

function imageThumbUrl(item) {
  // Single still — use first-frame thumbnail pipeline (works for images via ffmpeg)
  return poolThumbUrl(item, 'first');
}

function fuzzyMatch(query, text) {
  if (!query) return true;
  const q = String(query).toLowerCase().trim();
  if (!q) return true;
  const t = String(text || '').toLowerCase();
  if (!t) return false;
  if (t.includes(q)) return true;
  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length > 1) {
    return tokens.every((tok) => t.includes(tok) || _fuzzySubseq(tok, t));
  }
  return _fuzzySubseq(q, t);
}

function _fuzzySubseq(q, t) {
  let qi = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) qi++;
  }
  return qi === q.length;
}

function imageSearchText(item) {
  const m = item.meta || {};
  return [
    item.name,
    item.path,
    item.hash,
    m.hash,
    m.width && m.height ? `${m.width}x${m.height}` : '',
  ].filter(Boolean).join(' ');
}

function filteredImageItems() {
  const ip = ensureImagePool();
  const q = ip.filterQuery || '';
  const items = ip.items || [];
  if (!String(q).trim()) return items.slice();
  return items.filter((it) => fuzzyMatch(q, imageSearchText(it)));
}

function WORKSPACE_HINT() {
  const ip = ensureImagePool();
  if (ip.selectedPath) {
    const p = ip.selectedPath;
    return p.substring(0, p.lastIndexOf('/')) || '';
  }
  if (ip.items.length > 0) {
    const p = ip.items[0].path;
    return p.substring(0, p.lastIndexOf('/')) || '';
  }
  if (state.pool?.selectedPath) {
    const p = state.pool.selectedPath;
    return p.substring(0, p.lastIndexOf('/')) || '';
  }
  return '';
}

// ── meta ─────────────────────────────────────────────────────────────────

async function loadImageItemMeta(item) {
  try {
    const res = await fetch(`/api/media_info?path=${encodeURIComponent(item.path)}&ensure_thumbs=true`);
    const data = await res.json();
    if (data && data.ok) {
      item.meta = data;
      item.hash = data.hash || item.hash;
      item.history_count = data.history_count;
      item.open_count = data.open_count;
      item.metaError = null;
      if (data.size != null) item.size = data.size;
      if (data.name) item.name = data.name;
      if (item.hash) scheduleSavePoolState();
    } else {
      item.metaError = data?.error || 'probe failed';
    }
  } catch (err) {
    item.metaError = err.message;
  }
  if (state.activeTab === 'images') {
    const card = Array.from(document.querySelectorAll('.img-pool-card'))
      .find(c => c.dataset.path === item.path);
    if (card) {
      const metaEl = card.querySelector('.img-pool-meta');
      if (metaEl) metaEl.innerHTML = buildImageMetaHtml(item);
      if (item.hash) {
        const img = card.querySelector('img.pool-thumb');
        if (img && img.getAttribute('src')) img.src = imageThumbUrl(item);
      }
    }
  }
}

async function activateImageCard(card, item, { force = false } = {}) {
  if (!card || !item) return;
  const ip = ensureImagePool();
  if (!(ip.items.includes(item) || ip.items.some((i) => i.path === item.path))) return;
  let stale = force;
  try {
    const result = await validateItemSignature(item, { force });
    stale = result.stale;
    if (result.missing) {
      item.metaError = item.metaError || 'file not found';
      const el = card.querySelector('.img-pool-meta');
      if (el) el.innerHTML = metaRetryHtml(item.metaError);
      bindImageRetry(card, item);
      return;
    }
  } catch (err) {
    item.metaError = item.metaError || err.message || 'signature failed';
    const el = card.querySelector('.img-pool-meta');
    if (el) el.innerHTML = metaRetryHtml(item.metaError);
    bindImageRetry(card, item);
    assignCardThumbs(card, item, { bust: true });
    return;
  }

  if (item.meta && !stale) {
    const el = card.querySelector('.img-pool-meta');
    if (el) el.innerHTML = buildImageMetaHtml(item);
    assignCardThumbs(card, item, { bust: false });
    return;
  }
  if (item.metaError && !stale && !force) {
    const el = card.querySelector('.img-pool-meta');
    if (el) el.innerHTML = metaRetryHtml(item.metaError);
    bindImageRetry(card, item);
    assignCardThumbs(card, item, { bust: false });
    return;
  }

  await loadImageItemMeta(item);
  const el = card.querySelector('.img-pool-meta');
  if (el) {
    el.innerHTML = (item.metaError && !item.meta)
      ? metaRetryHtml(item.metaError)
      : buildImageMetaHtml(item);
  }
  bindImageRetry(card, item);
  assignCardThumbs(card, item, { bust: stale || force });
}

function bindImageRetry(card, item) {
  card.querySelectorAll('.pool-retry-meta').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      activateImageCard(card, item, { force: true });
    });
  });
}

function buildImageMetaHtml(item) {
  const m = item.meta || {};
  const name = item.name || basename(item.path);
  const dims = m.width && m.height ? `${m.width}×${m.height}` : '';
  const size = m.size != null ? formatBytes(m.size) : (item.size != null ? formatBytes(item.size) : '');
  const hash = item.hash || m.hash || '';
  const parts = [
    `<div class="pool-meta-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>`,
  ];
  const row = [];
  if (dims) row.push(`<span>${dims}</span>`);
  if (size) row.push(`<span>${size}</span>`);
  if (hash) row.push(`<span class="pool-hash" title="${escapeHtml(hash)}">#${escapeHtml(shortHash(hash))}</span>`);
  if (row.length) parts.push(`<div class="pool-meta-row">${row.join('')}</div>`);
  return parts.join('');
}

// ── CRUD ─────────────────────────────────────────────────────────────────

function addPathsToImagePool(paths) {
  const ip = ensureImagePool();
  let added = 0;
  let skipped = 0;
  const existing = new Set(ip.items.map(i => i.path));
  let firstNew = null;

  for (const raw of paths) {
    if (!raw) continue;
    const path = String(raw).trim();
    if (!path) continue;
    if (!isImagePath(path)) {
      skipped++;
      continue;
    }
    if (existing.has(path)) {
      skipped++;
      continue;
    }
    existing.add(path);
    const item = {
      path,
      name: basename(path),
      size: null,
      meta: null,
      hash: null,
    };
    ip.items.push(item);
    if (!firstNew) firstNew = path;
    added++;
  }

  logConsole(`[IMAGE POOL]: +${added} image(s)${skipped ? `, skipped ${skipped}` : ''}`);
  if (added > 0) scheduleSavePoolState();
  return { added, firstNew };
}

function selectImageItem(path) {
  const ip = ensureImagePool();
  if (!path) return;
  ip.selectedPath = path;
  showPreview(path);
  scheduleSavePoolState();

  // If Cut asked for a ref slot, fill it and jump back
  if (state._cutPendingRef === 'refA' || state._cutPendingRef === 'refB') {
    if (!state.cut) {
      state.cut = { refA: null, refB: null, mode: 'separate', compareMode: 'separate', overlayOpacity: 50, abPosition: 50 };
    }
    const slot = state._cutPendingRef;
    state.cut[slot] = path;
    state._cutPendingRef = null;
    logConsole(`[CUT]: Ref ${slot === 'refA' ? 'A' : 'B'} ← ${basename(path)}`);
    switchTab('cut');
    return;
  }

  if (state.activeTab === 'images') {
    renderImagePoolGrid();
    const card = Array.from(document.querySelectorAll('.img-pool-card')).find(c => c.dataset.path === path);
    if (card?.scrollIntoView) card.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

function removeImageItem(idx) {
  const ip = ensureImagePool();
  const removed = ip.items[idx];
  if (!removed) return;
  ip.items.splice(idx, 1);
  if (ip.selectedPath === removed.path) ip.selectedPath = null;
  logConsole(`[IMAGE POOL]: Removed ${removed.name || removed.path}`);
  scheduleSavePoolState();
  if (state.activeTab === 'images') renderImagePoolForm();
}

function clearImagePool() {
  const ip = ensureImagePool();
  if (ip.items.length === 0) return;
  if (!confirm(`Clear all ${ip.items.length} images from the Image Pool?`)) return;
  releaseObservedImageCards();
  lazyClearPending();
  ip.items = [];
  ip.selectedPath = null;
  logConsole('[IMAGE POOL]: Cleared');
  scheduleSavePoolState();
  if (state.activeTab === 'images') renderImagePoolForm();
}

async function importImageFiles() {
  elements.statusDot.className = 'status-dot loading';
  elements.statusText.textContent = 'Waiting for file picker…';
  try {
    const res = await fetch(
      `/api/picker?mode=files&filter=image&start_path=${encodeURIComponent(WORKSPACE_HINT())}`
    );
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    const paths = Array.isArray(data.paths) && data.paths.length
      ? data.paths
      : (data.path ? [data.path] : []);
    if (paths.length === 0) {
      logConsole('[IMAGE POOL]: File import cancelled');
      return;
    }
    const { firstNew } = addPathsToImagePool(paths);
    if (state.activeTab === 'images') {
      renderImagePoolForm();
      if (firstNew) selectImageItem(firstNew);
    }
  } catch (err) {
    logConsole(`[IMAGE POOL ERROR]: ${err.message}`, 'error');
    alert(`Could not open file picker: ${err.message}`);
  } finally {
    await checkHealth();
  }
}

async function importImageFolder() {
  elements.statusDot.className = 'status-dot loading';
  elements.statusText.textContent = 'Waiting for folder picker…';
  try {
    const res = await fetch(`/api/picker?mode=dir&start_path=${encodeURIComponent(WORKSPACE_HINT())}`);
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    const dir = data.path;
    if (!dir) {
      logConsole('[IMAGE POOL]: Folder import cancelled');
      return;
    }
    logConsole(`[IMAGE POOL]: Scanning ${dir}…`);
    const recursive = document.getElementById('imgPoolRecursiveScan')?.checked ? 'true' : 'false';
    const scanRes = await fetch(
      `/api/pool/scan?path=${encodeURIComponent(dir)}&recursive=${recursive}&kind=image`
    );
    if (!scanRes.ok) throw new Error(await scanRes.text());
    const scan = await scanRes.json();
    if (!scan.ok) throw new Error(scan.error || 'scan failed');
    const paths = (scan.images || []).map(v => v.path);
    if (paths.length === 0) {
      logConsole(`[IMAGE POOL]: No images found in ${dir}`);
      alert('No image files found in that folder.');
      return;
    }
    const scanData = new Map((scan.images || []).map(v => [v.path, v]));
    const { added, firstNew } = addPathsToImagePool(paths);
    ensureImagePool().items.forEach(item => {
      const data = scanData.get(item.path);
      if (data) {
        if (item.size == null) item.size = data.size;
        if (data.hash) item.hash = data.hash;
        if (data.meta) item.meta = data.meta;
        if (data.thumbs) item.thumbs = data.thumbs;
        if (data.history_count != null) item.history_count = data.history_count;
        if (data.open_count != null) item.open_count = data.open_count;
        if (data.cached) item.cached = data.cached;
      }
    });
    logConsole(`[IMAGE POOL]: Folder import from ${dir} (${added} new)`);
    if (state.activeTab === 'images') {
      renderImagePoolForm();
      if (firstNew) selectImageItem(firstNew);
    }
  } catch (err) {
    logConsole(`[IMAGE POOL ERROR]: ${err.message}`, 'error');
    alert(`Folder import failed: ${err.message}`);
  } finally {
    await checkHealth();
  }
}

// ── send to tools ────────────────────────────────────────────────────────

function sendImagePathTo(path, target) {
  if (!path || !target) return;
  selectImageItem(path);

  if (target === 'preview') {
    showPreview(path);
    return;
  }

  if (target === 'cut_ref_a' || target === 'cut_ref_b') {
    if (!state.cut) {
      state.cut = { refA: null, refB: null, mode: 'separate', compareMode: 'separate', overlayOpacity: 50, abPosition: 50 };
    }
    if (target === 'cut_ref_a') state.cut.refA = path;
    else state.cut.refB = path;
    logConsole(`[IMAGE POOL]: Set Cut ${target === 'cut_ref_a' ? 'Ref A' : 'Ref B'} → ${basename(path)}`);
    switchTab('cut');
    return;
  }

  if (target === 'compare_a' || target === 'compare_b') {
    import('/js/tabs/imgcompare.js').then((m) => {
      m.applyImgComparePath(path, target === 'compare_b' ? 'B' : 'A');
    }).catch((err) => {
      logConsole(`[IMAGE POOL ERROR]: Compare send failed — ${err.message}`, 'error');
    });
    return;
  }

  if (target === 'zoompan_ref') {
    if (!state.zoompan) {
      state.zoompan = { refPath: null, mode: 'overlay', overlayOpacity: 50, abPosition: 50, compareTarget: 'end_ref' };
    }
    state.zoompan.refPath = path;
    if (!state.zoompan.compareTarget || state.zoompan.compareTarget === 'start_end') {
      state.zoompan.compareTarget = 'end_ref';
    }
    if (state.zoompan.mode === 'separate') state.zoompan.mode = 'overlay';
    logConsole(`[IMAGE POOL]: Set Pan & Zoom Reference → ${basename(path)}`);
    switchTab('zoompan');
    return;
  }

  if (target === 'facemorph') {
    if (!state.faceMorph.images.some(x => x.path === path)) {
      state.faceMorph.images.push({ path, name: basename(path) });
    }
    switchTab('facemorph');
    logConsole(`[IMAGE POOL]: Sent to Face Morph → ${path}`);
    return;
  }

  if (target === 'withoutbg') {
    if (!state.withoutbg.images.some(x => x.path === path)) {
      state.withoutbg.images.push({ path, name: basename(path) });
    }
    switchTab('withoutbg');
    logConsole(`[IMAGE POOL]: Sent to withoutBG → ${path}`);
    return;
  }

  if (target === 'style_content') {
    if (!state.styleTransfer.contents.some(x => x.path === path)) {
      state.styleTransfer.contents.push({ path, name: basename(path) });
    }
    switchTab('styletransfer');
    logConsole(`[IMAGE POOL]: Sent to Style content → ${path}`);
    return;
  }

  if (target === 'style_ref') {
    state.styleTransfer.stylePath = path;
    switchTab('styletransfer');
    logConsole(`[IMAGE POOL]: Sent to Style ref → ${path}`);
    return;
  }

  if (target === 'deepdream') {
    switchTab('deepdream');
    const input = document.getElementById('dreamInput');
    if (input) {
      input.value = path;
      input.dispatchEvent(new Event('input'));
    }
    const gi = document.getElementById('giImage');
    if (gi) {
      gi.value = path;
      gi.dispatchEvent(new Event('input'));
    }
    logConsole(`[IMAGE POOL]: Sent to DeepDream → ${path}`);
    return;
  }

  if (target === 'upscale') {
    switchTab('upscale');
    const input = document.getElementById('upInput');
    if (input) {
      input.value = path;
      input.dispatchEvent(new Event('input'));
    }
    logConsole(`[IMAGE POOL]: Sent to Upscale → ${path}`);
    return;
  }

  if (target === 'fastsam') {
    switchTab('fastsam');
    const input = document.getElementById('fastsamInput');
    if (input) {
      input.value = path;
      input.dispatchEvent(new Event('input'));
    }
    logConsole(`[IMAGE POOL]: Sent to FastSAM → ${path}`);
    return;
  }

  if (target === 'convert') {
    switchTab('convert');
    const input = document.getElementById('convertInput');
    if (input) {
      input.value = path;
      input.dispatchEvent(new Event('input'));
    }
    logConsole(`[IMAGE POOL]: Sent to Convert → ${path}`);
    return;
  }

  if (target === 'img2img') {
    switchTab('img2img');
    const input = document.getElementById('i2iInput');
    if (input) {
      input.value = path;
      input.dispatchEvent(new Event('input'));
    }
    logConsole(`[IMAGE POOL]: Sent to Img2Img → ${path}`);
    return;
  }

  if (target === 'agent') {
    if (!state.agent) state.agent = { backend: 'deepseek', skill: 'chat', model: '', images: [], history: [] };
    if (!state.agent.images.includes(path)) {
      state.agent.images.push(path);
    }
    switchTab('agent');
    logConsole(`[IMAGE POOL]: Sent to Agent → ${path}`);
    return;
  }

  if (target === 'imagesort') {
    if (!state.imageSort) state.imageSort = { images: [], sortMode: 'radial', sortOrder: 'score_asc', sortStrategy: 'balanced', output: '', selected: 0 };
    if (!state.imageSort.images.some((x) => x.path === path)) {
      state.imageSort.images.push({ path, name: basename(path), score: null });
    }
    switchTab('imagesort');
    logConsole(`[IMAGE POOL]: Sent to Image Sort → ${path}`);
    return;
  }

  if (target === 'zoompan') {
    if (!state.zoompan) {
      state.zoompan = { refPath: null, mode: 'overlay', overlayOpacity: 50, abPosition: 50, compareTarget: 'end_ref' };
    }
    state.zoompan.refPath = path;
    if (!state.zoompan.compareTarget || state.zoompan.compareTarget === 'start_end') {
      state.zoompan.compareTarget = 'end_ref';
    }
    if (state.zoompan.mode === 'separate') state.zoompan.mode = 'overlay';
    switchTab('zoompan');
    logConsole(`[IMAGE POOL]: Sent to Pan & Zoom → ${path}`);
    return;
  }

  if (target === 'global_image') {
    const gi = document.getElementById('giImage');
    if (gi) {
      const existing = (gi.value || '').trim();
      gi.value = existing ? `${existing}\n${path}` : path;
      gi.dispatchEvent(new Event('input'));
    }
    logConsole(`[IMAGE POOL]: Added to global Image → ${path}`);
    return;
  }

  logConsole(`[IMAGE POOL]: Unknown send target: ${target}`, 'error');
}

// ── UI ───────────────────────────────────────────────────────────────────

function renderImagePoolForm() {
  const ip = ensureImagePool();
  const count = ip.items.length;
  const selected = ip.selectedPath;
  const q = ip.filterQuery || '';

  const html = `
    <div class="pool-workspace-inner img-pool-workspace">
      <div class="pool-top">
        <div class="pool-toolbar">
          <div class="pool-toolbar-actions">
            <div class="pool-project-group">
              <button type="button" class="btn" id="btnProjectNew" title="New empty project">New</button>
              <button type="button" class="btn" id="btnProjectOpen" title="Open .ffproject.json">Open…</button>
              <button type="button" class="btn btn-primary" id="btnProjectSave" title="Save project (includes image pool)">Save</button>
              <button type="button" class="btn" id="btnProjectSaveAs" title="Save project as…">Save As…</button>
              <span class="pool-project-name" id="poolProjectName" title="${escapeHtml(state.project.path || '')}">${escapeHtml(projectLabel())}</span>
            </div>
            <input type="search" class="pool-filter-input" id="imgPoolFilterInput"
              placeholder="Filter images…" value="${escapeHtml(q)}"
              title="Instant fuzzy filter (name, path, hash…)"
              autocomplete="off" spellcheck="false">
            <button class="btn btn-primary" id="btnImgPoolImportFiles" type="button">+ Files</button>
            <button class="btn" id="btnImgPoolImportFolder" type="button">+ Folder</button>
            <label class="pool-recursive-toggle" title="Also scan subdirectories">
              <input type="checkbox" id="imgPoolRecursiveScan"> Subfolders
            </label>
            <button class="btn" id="btnImgPoolClear" type="button" ${count === 0 ? 'disabled' : ''}>Clear</button>
          </div>
          <div class="pool-toolbar-meta">
            <span class="pool-count" id="imgPoolCount">${count} in image pool</span>
            ${selected ? `
              <div class="pool-use-wrap">
                <label for="imgPoolUseTarget" class="pool-use-label">Send to</label>
                <select id="imgPoolUseTarget" class="pool-use-select">
                  <option value="">— target —</option>
                  <option value="global_image">Global Image</option>
                  <option value="facemorph">Face Morph</option>
                  <option value="withoutbg">withoutBG</option>
                  <option value="style_content">Style content</option>
                  <option value="style_ref">Style reference</option>
                  <option value="deepdream">DeepDream</option>
                  <option value="cut_ref_a">Cut · Ref A</option>
                  <option value="cut_ref_b">Cut · Ref B</option>
                  <option value="compare_a">Compare · Image A</option>
                  <option value="compare_b">Compare · Image B</option>
                  <option value="zoompan_ref">Pan &amp; Zoom · Reference</option>
                  <option value="preview">Preview</option>
                </select>
                <button class="btn btn-primary" id="btnImgPoolUse" type="button">Apply</button>
              </div>
            ` : ''}
          </div>
        </div>
        <div class="pool-grid-wrap">
          <div class="pool-grid img-pool-grid" id="imgPoolGrid"></div>
        </div>
      </div>
    </div>
  `;

  elements.actionPanel.innerHTML = html;
  (elements.actionPanelRoot || elements.actionPanel).classList.add('pool-active');

  document.getElementById('btnProjectNew')?.addEventListener('click', projectNew);
  document.getElementById('btnProjectOpen')?.addEventListener('click', projectOpen);
  document.getElementById('btnProjectSave')?.addEventListener('click', () => projectSave(false));
  document.getElementById('btnProjectSaveAs')?.addEventListener('click', () => projectSave(true));
  document.getElementById('btnImgPoolImportFiles')?.addEventListener('click', importImageFiles);
  document.getElementById('btnImgPoolImportFolder')?.addEventListener('click', importImageFolder);
  document.getElementById('btnImgPoolClear')?.addEventListener('click', clearImagePool);
  document.getElementById('btnImgPoolUse')?.addEventListener('click', () => {
    const target = document.getElementById('imgPoolUseTarget')?.value;
    if (!target) {
      alert('Choose a destination.');
      return;
    }
    sendImagePathTo(ip.selectedPath, target);
  });

  const filterEl = document.getElementById('imgPoolFilterInput');
  if (filterEl) {
    filterEl.addEventListener('input', () => {
      ensureImagePool().filterQuery = filterEl.value;
      renderImagePoolGrid();
      _updateImageFilterCount();
    });
    filterEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        filterEl.value = '';
        ensureImagePool().filterQuery = '';
        renderImagePoolGrid();
        _updateImageFilterCount();
        e.preventDefault();
      }
    });
  }

  renderImagePoolGrid();
}

function _updateImageFilterCount() {
  const el = document.getElementById('imgPoolCount');
  if (!el) return;
  const total = ensureImagePool().items.length;
  const shown = filteredImageItems().length;
  const q = (ensureImagePool().filterQuery || '').trim();
  el.textContent = q
    ? `${shown} shown · ${total} in image pool`
    : `${total} in image pool`;
}

function renderImagePoolGrid() {
  const grid = document.getElementById('imgPoolGrid');
  if (!grid) return;
  const ip = ensureImagePool();
  releaseObservedImageCards();

  if (ip.items.length === 0) {
    lazyClearPending();
    grid.innerHTML = `
      <div class="pool-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <circle cx="8.5" cy="8.5" r="1.5"/>
          <polyline points="21 15 16 10 5 21"/>
        </svg>
        <p>No images in the Image Pool.</p>
        <p class="pool-empty-hint">Import stills (PNG/JPG/WebP/…) for cut refs, facemorph, style, and more.</p>
      </div>
    `;
    _updateImageFilterCount();
    return;
  }

  const items = filteredImageItems();
  if (items.length === 0) {
    const q = escapeHtml(ip.filterQuery || '');
    grid.innerHTML = `
      <div class="pool-empty">
        <p>No images match <strong>${q}</strong>.</p>
        <p class="pool-empty-hint">Clear the filter (Esc) or try a shorter query.</p>
      </div>
    `;
    _updateImageFilterCount();
    return;
  }

  grid.innerHTML = '';
  items.forEach((item) => {
    const idx = ip.items.indexOf(item);
    const card = document.createElement('article');
    const isSelected = ip.selectedPath === item.path;
    card.className = `pool-card img-pool-card${isSelected ? ' selected' : ''}`;
    card.dataset.path = item.path;
    card.dataset.idx = String(idx >= 0 ? idx : 0);

    const metaHtml = item.metaError && !item.meta
      ? metaRetryHtml(item.metaError)
      : (item.meta
        ? buildImageMetaHtml(item)
        : '<span class="pool-meta-loading">probing…</span>');

    card.innerHTML = `
      <div class="pool-card-actions">
        <div class="pool-send-wrap">
          <button type="button" class="btn pool-send-btn" title="Send this image">Send to ▾</button>
        </div>
        <button class="pool-card-remove" type="button" title="Remove from image pool" data-remove="${idx}">✕</button>
      </div>
      <div class="pool-frames img-pool-single">
        <div class="pool-frame">
          <img class="pool-thumb" alt="${escapeHtml(item.name || '')}" loading="lazy" data-which="first" draggable="false"
               onerror="this.classList.add('broken'); this.alt='no image';">
        </div>
      </div>
      <div class="pool-overlay">
        <div class="pool-overlay-text img-pool-meta">
          ${metaHtml}
        </div>
      </div>
    `;

    card.addEventListener('click', (e) => {
      if (e.target.closest('.pool-card-remove, .pool-send-wrap')) return;
      selectImageItem(item.path);
    });

    card.querySelector('.pool-card-remove')?.addEventListener('click', (e) => {
      e.stopPropagation();
      removeImageItem(idx);
    });

    // lightweight send menu
    card.querySelector('.pool-send-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      _showImageSendMenu(e.currentTarget, item.path);
    });

    grid.appendChild(card);
    if (item.metaError && !item.meta) bindImageRetry(card, item);
    lazyObserve(card, () => activateImageCard(card, item));
    _observedImageCards.add(card);
  });

  _updateImageFilterCount();
}

function _showImageSendMenu(anchor, path) {
  document.querySelectorAll('.img-pool-send-menu').forEach(el => el.remove());
  const menu = document.createElement('div');
  menu.className = 'img-pool-send-menu pool-context-menu';
  menu.innerHTML = `
    <button type="button" data-t="global_image">Global Image</button>
    <button type="button" data-t="facemorph">Face Morph</button>
    <button type="button" data-t="withoutbg">withoutBG</button>
    <button type="button" data-t="style_content">Style content</button>
    <button type="button" data-t="style_ref">Style reference</button>
    <button type="button" data-t="deepdream">DeepDream</button>
    <button type="button" data-t="upscale">Upscale</button>
    <button type="button" data-t="fastsam">FastSAM</button>
    <button type="button" data-t="img2img">Img2Img</button>
    <button type="button" data-t="agent">Agent</button>
    <button type="button" data-t="imagesort">Image Sort</button>
    <button type="button" data-t="zoompan">Pan &amp; Zoom</button>
    <button type="button" data-t="convert">Convert / Export</button>
    <button type="button" data-t="cut_ref_a">Cut · Ref A</button>
    <button type="button" data-t="cut_ref_b">Cut · Ref B</button>
    <button type="button" data-t="preview">Preview</button>
  `;
  const rect = anchor.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.left = `${rect.left}px`;
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.zIndex = '10000';
  document.body.appendChild(menu);

  const close = () => {
    menu.remove();
    document.removeEventListener('click', close, true);
  };
  menu.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      sendImagePathTo(path, btn.dataset.t);
      close();
    });
  });
  setTimeout(() => document.addEventListener('click', close, true), 0);
}

/** Public helper for other tabs (e.g. future pause → image pool). */
function addImageToPool(path) {
  return addPathsToImagePool([path]);
}

export {
  ensureImagePool,
  renderImagePoolForm,
  renderImagePoolGrid,
  addPathsToImagePool,
  addImageToPool,
  selectImageItem,
  removeImageItem,
  clearImagePool,
  importImageFiles,
  importImageFolder,
  sendImagePathTo,
  imageThumbUrl,
  loadImageItemMeta,
};
