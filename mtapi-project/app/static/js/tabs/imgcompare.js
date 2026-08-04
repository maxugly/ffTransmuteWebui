/**
 * Image Compare tab — pick two stills, compare (separate / overlay / A/B),
 * rate with Image Sort distance metrics (pHash, aHash, colorhash, MSE, SSIM).
 *
 * Reuses:
 *   js/ui/image-compare.js  (same as Cut / Zoompan)
 *   POST /ops/imagesort_rank (pairwise score)
 */
import { state, elements, logConsole, switchTab, resolveGlobalImages } from '/app.js';
import { basename, escapeHtml, isImagePath } from '/js/utils.js';
import {
  defaultCompareState,
  normalizeCompareState,
  compareToolbarHtml,
  paintCompareView,
  paintSimpleImage,
  bindCompareControls,
} from '/js/ui/image-compare.js';

const ID_PREFIX = 'ic';
const SORT_MODES = [
  { id: 'phash', label: 'pHash — structure / layout' },
  { id: 'ahash', label: 'aHash — coarse brightness grid' },
  { id: 'colorhash', label: 'colorhash — palette mood' },
  { id: 'mse', label: 'MSE — pixel difference' },
  { id: 'ssim', label: 'SSIM — structural similarity (if installed)' },
];

let _compareCtl = null;
let _rateTimer = 0;
let _dims = { a: null, b: null }; // {w,h} after load

function ensureIc() {
  if (!state.imgCompare) {
    state.imgCompare = {
      pathA: null,
      pathB: null,
      sortMode: 'phash',
      lastScore: null,
      lastScoreMode: null,
      lastError: null,
      rating: null, // 'scoring' | null
      ...defaultCompareState(),
      compareMode: 'separate',
    };
  }
  normalizeCompareState(state.imgCompare);
  return state.imgCompare;
}

function thumbUrl(path) {
  if (!path) return '';
  return `/api/thumbnail?path=${encodeURIComponent(path)}&which=first&_t=${encodeURIComponent(path)}`;
}

function fullUrl(path) {
  if (!path) return '';
  return `/api/image?path=${encodeURIComponent(path)}&t=${Date.now()}`;
}

/** Prefer full image for compare quality; thumb is fine fallback. */
function displaySrc(path) {
  // Full image for accuracy; server streams file. For huge camera RAWs this
  // could be heavy — paths here are expected to be PNG/JPG work files.
  return fullUrl(path);
}

function _setPath(which, path) {
  const ic = ensureIc();
  const p = path ? String(path).trim() : null;
  if (which === 'A') {
    ic.pathA = p || null;
    _dims.a = null;
  } else {
    ic.pathB = p || null;
    _dims.b = null;
  }
  ic.lastScore = null;
  ic.lastError = null;
}

function _swap() {
  const ic = ensureIc();
  const t = ic.pathA;
  ic.pathA = ic.pathB;
  ic.pathB = t;
  const td = _dims.a;
  _dims.a = _dims.b;
  _dims.b = td;
  ic.lastScore = null;
}

function _pullFromGlobal() {
  const imgs = typeof resolveGlobalImages === 'function' ? resolveGlobalImages() : [];
  const ic = ensureIc();
  if (imgs[0] && !ic.pathA) ic.pathA = imgs[0];
  if (imgs[1] && !ic.pathB) ic.pathB = imgs[1];
  if (imgs[0] && !ic.pathB && ic.pathA && imgs[0] !== ic.pathA) ic.pathB = imgs[0];
  return !!(ic.pathA || ic.pathB);
}

function _scoreHint(mode, score) {
  if (score == null || !Number.isFinite(score)) return '';
  // Lower is closer for all current modes (SSIM is 1−ssim)
  if (mode === 'phash' || mode === 'ahash') {
    // Hamming on 8×8 hash → 0..64
    if (score <= 4) return 'near-duplicate / very similar structure';
    if (score <= 12) return 'related (same scene-ish)';
    if (score <= 24) return 'somewhat different';
    return 'quite different structure';
  }
  if (mode === 'colorhash') {
    if (score <= 2) return 'very similar palette';
    if (score <= 8) return 'related colors';
    return 'different color mood';
  }
  if (mode === 'mse') {
    if (score < 50) return 'very close pixels (after resize)';
    if (score < 500) return 'moderate pixel distance';
    if (score < 2000) return 'large pixel difference';
    return 'very far in pixel space';
  }
  if (mode === 'ssim') {
    // 0 = identical, 1 = totally dissimilar (we store 1−SSIM)
    if (score < 0.05) return 'nearly identical structure';
    if (score < 0.15) return 'highly similar';
    if (score < 0.4) return 'moderately different';
    return 'structurally far';
  }
  return '';
}

async function ratePair() {
  const ic = ensureIc();
  const a = ic.pathA;
  const b = ic.pathB;
  if (!a || !b) {
    ic.lastScore = null;
    ic.lastError = (!a && !b) ? 'Pick two images' : (!a ? 'Pick image A' : 'Pick image B');
    ic.rating = null;
    _paintScoreUi();
    return;
  }
  if (a === b) {
    ic.lastScore = 0;
    ic.lastScoreMode = ic.sortMode;
    ic.lastError = null;
    ic.rating = null;
    _paintScoreUi();
    return;
  }

  ic.rating = 'scoring';
  ic.lastError = null;
  _paintScoreUi();

  try {
    const res = await fetch('/ops/imagesort_rank', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image_paths: [a, b],
        sort_mode: ic.sortMode || 'phash',
        sort_order: 'nearest_first',
        sort_strategy: 'radial',
      }),
    });
    const data = await res.json();
    if (!data.ok) {
      ic.lastScore = null;
      ic.lastError = data.error || 'rank failed';
      ic.rating = null;
      _paintScoreUi();
      return;
    }
    // items: base + scored target(s)
    let score = null;
    const items = data.items || [];
    for (const it of items) {
      if (it.role !== 'base' && it.score != null) {
        score = Number(it.score);
        break;
      }
    }
    // Fallback: only one scored item after base
    if (score == null && items.length >= 2 && items[1].score != null) {
      score = Number(items[1].score);
    }
    ic.lastScore = Number.isFinite(score) ? score : null;
    ic.lastScoreMode = ic.sortMode;
    ic.lastError = ic.lastScore == null ? 'No score in response' : null;
    ic.rating = null;
    logConsole(
      `[COMPARE]: ${ic.sortMode} distance = ${ic.lastScore != null ? ic.lastScore.toFixed(4) : '?'}`
      + ` · ${basename(a)} ↔ ${basename(b)}`
    );
  } catch (err) {
    ic.lastScore = null;
    ic.lastError = err.message || String(err);
    ic.rating = null;
  }
  _paintScoreUi();
}

function scheduleRate() {
  if (_rateTimer) clearTimeout(_rateTimer);
  _rateTimer = setTimeout(() => {
    _rateTimer = 0;
    ratePair();
  }, 200);
}

function _paintScoreUi() {
  const el = document.getElementById('icScorePanel');
  if (!el) return;
  const ic = ensureIc();
  if (ic.rating === 'scoring') {
    el.innerHTML = `<span class="ic-score-muted">Scoring…</span>`;
    return;
  }
  if (ic.lastError && ic.lastScore == null) {
    el.innerHTML = `<span class="ic-score-err">${escapeHtml(ic.lastError)}</span>`;
    return;
  }
  if (ic.lastScore == null) {
    el.innerHTML = `<span class="ic-score-muted">Pick two images to rate</span>`;
    return;
  }
  const mode = ic.lastScoreMode || ic.sortMode;
  const hint = _scoreHint(mode, ic.lastScore);
  const fmt = (mode === 'mse' || mode === 'ssim')
    ? ic.lastScore.toFixed(4)
    : (Number.isInteger(ic.lastScore) ? String(ic.lastScore) : ic.lastScore.toFixed(2));
  el.innerHTML = `
    <span class="ic-score-mode">${escapeHtml(mode)}</span>
    <span class="ic-score-value" title="Lower = more similar for all modes">${escapeHtml(fmt)}</span>
    <span class="ic-score-hint">${escapeHtml(hint)}</span>
  `;
}

/**
 * Size the main compare host to source AR (letterbox inside available space).
 * Uses the larger of the two image aspect ratios' bounding box idea:
 * prefer base A dims; if only B, use B; if both, use max width/height box AR.
 */
function applyViewportAr() {
  const host = document.getElementById('icMainViewport');
  const stage = document.getElementById('icStage');
  if (!host || !stage) return;

  let w = 0;
  let h = 0;
  if (_dims.a && _dims.b) {
    // Fit both without crop: take max AR span
    w = Math.max(_dims.a.w, _dims.b.w);
    h = Math.max(_dims.a.h, _dims.b.h);
  } else if (_dims.a) {
    w = _dims.a.w;
    h = _dims.a.h;
  } else if (_dims.b) {
    w = _dims.b.w;
    h = _dims.b.h;
  }
  if (!w || !h) {
    host.style.removeProperty('--ic-ar');
    host.classList.remove('has-ar');
    return;
  }
  host.style.setProperty('--ic-ar', `${w} / ${h}`);
  host.classList.add('has-ar');

  // Also size separate-mode mini viewports
  document.querySelectorAll('.ic-sep-viewport').forEach((el) => {
    el.style.setProperty('--ic-ar', el.dataset.ar || `${w} / ${h}`);
  });
}

function _probeDims(which, path) {
  if (!path) return;
  const img = new Image();
  img.onload = () => {
    if (img.naturalWidth && img.naturalHeight) {
      _dims[which === 'A' ? 'a' : 'b'] = { w: img.naturalWidth, h: img.naturalHeight };
      applyViewportAr();
      _updateDimLabels();
    }
  };
  img.src = displaySrc(path);
}

function _updateDimLabels() {
  const la = document.getElementById('icDimA');
  const lb = document.getElementById('icDimB');
  if (la) {
    la.textContent = _dims.a ? `${_dims.a.w}×${_dims.a.h}` : '';
  }
  if (lb) {
    lb.textContent = _dims.b ? `${_dims.b.w}×${_dims.b.h}` : '';
  }
}

function _paintViews() {
  const ic = ensureIc();
  const mode = ic.mode || 'separate';
  const a = ic.pathA;
  const b = ic.pathB;
  const aSrc = a ? displaySrc(a) : '';
  const bSrc = b ? displaySrc(b) : '';

  if (mode === 'separate') {
    const va = document.getElementById('icSepA');
    const vb = document.getElementById('icSepB');
    paintSimpleImage(va, {
      src: aSrc,
      key: a || '',
      alt: 'A',
      emptyMsg: 'Image A',
      emptyClass: 'ic-empty',
    });
    paintSimpleImage(vb, {
      src: bSrc,
      key: b || '',
      alt: 'B',
      emptyMsg: 'Image B',
      emptyClass: 'ic-empty',
    });
    if (va && _dims.a) va.style.setProperty('--ic-ar', `${_dims.a.w} / ${_dims.a.h}`);
    if (vb && _dims.b) vb.style.setProperty('--ic-ar', `${_dims.b.w} / ${_dims.b.h}`);
  } else {
    const box = document.getElementById('icMainViewport');
    paintCompareView(box, {
      mode,
      baseSrc: aSrc,
      baseKey: a || '',
      refSrc: bSrc,
      opacity: ic.overlayOpacity,
      ab: ic.abPosition,
      baseLabel: 'A',
      refLabel: 'B',
      emptyMsg: 'Pick image A',
      missingRefMsg: 'Pick image B to compare',
      emptyClass: 'ic-empty',
    });
  }
  applyViewportAr();
}

function renderImgCompareForm() {
  const ic = ensureIc();
  if (_compareCtl) {
    try { _compareCtl.destroy(); } catch (_) { /* ignore */ }
    _compareCtl = null;
  }

  // Soft-fill from global image bar if empty
  if (!ic.pathA && !ic.pathB) _pullFromGlobal();

  const cmp = normalizeCompareState(ic);
  const mode = cmp.mode;
  const toolbar = compareToolbarHtml({
    idPrefix: ID_PREFIX,
    state: cmp,
    label: 'View',
    modeTitles: {
      separate: 'Side-by-side A and B (each keeps its AR)',
      overlay: 'Stack B on A; opacity slider',
      ab: 'Wipe: left = A, right = B',
    },
  });

  const modeOpts = SORT_MODES.map((m) =>
    `<option value="${m.id}" ${ic.sortMode === m.id ? 'selected' : ''}>${escapeHtml(m.label)}</option>`
  ).join('');

  const pathA = ic.pathA || '';
  const pathB = ic.pathB || '';

  const html = `
    <div class="ic-workspace">
      <div class="panel-title-desc dense">
        <h3>Image Compare</h3>
        <p class="dream-hint">
          Two stills · <strong>Separate</strong> / <strong>Overlay</strong> / <strong>A/B wipe</strong>
          (same control as Cut &amp; Zoompan) · rate with Image Sort metrics.
          Viewports <strong>letterbox to source AR</strong> — no stretch.
        </p>
      </div>

      <div class="ic-pick-row">
        <div class="ic-pick-card">
          <label class="ic-pick-label" for="icPathA">Image A <span class="ic-dim" id="icDimA"></span></label>
          <div class="input-row">
            <input type="text" id="icPathA" placeholder="/absolute/path/a.png"
              value="${escapeHtml(pathA)}">
            <button type="button" class="btn" id="btnIcBrowseA">Browse</button>
            <button type="button" class="btn" id="btnIcPoolA" title="Use Image Pool selection">Pool</button>
            <button type="button" class="btn" id="btnIcClearA" ${pathA ? '' : 'disabled'}>Clear</button>
          </div>
          <div class="ic-path-name" title="${escapeHtml(pathA)}">${escapeHtml(pathA ? basename(pathA) : '—')}</div>
        </div>
        <div class="ic-pick-mid">
          <button type="button" class="btn" id="btnIcSwap" title="Swap A ↔ B">⇄</button>
        </div>
        <div class="ic-pick-card">
          <label class="ic-pick-label" for="icPathB">Image B <span class="ic-dim" id="icDimB"></span></label>
          <div class="input-row">
            <input type="text" id="icPathB" placeholder="/absolute/path/b.png"
              value="${escapeHtml(pathB)}">
            <button type="button" class="btn" id="btnIcBrowseB">Browse</button>
            <button type="button" class="btn" id="btnIcPoolB" title="Use Image Pool selection">Pool</button>
            <button type="button" class="btn" id="btnIcClearB" ${pathB ? '' : 'disabled'}>Clear</button>
          </div>
          <div class="ic-path-name" title="${escapeHtml(pathB)}">${escapeHtml(pathB ? basename(pathB) : '—')}</div>
        </div>
      </div>

      <div class="ic-toolbar-row">
        ${toolbar}
        <div class="ic-rate-bar">
          <label for="icSortMode">Metric</label>
          <select id="icSortMode">${modeOpts}</select>
          <button type="button" class="btn btn-primary" id="btnIcRate">Rate</button>
          <div class="ic-score-panel" id="icScorePanel" aria-live="polite"></div>
        </div>
      </div>

      <div class="ic-stage" id="icStage">
        ${mode === 'separate' ? `
          <div class="ic-sep-grid">
            <div class="ic-sep-col">
              <div class="ic-sep-label">A</div>
              <div class="ic-sep-viewport img-compare-viewport" id="icSepA"></div>
            </div>
            <div class="ic-sep-col">
              <div class="ic-sep-label">B</div>
              <div class="ic-sep-viewport img-compare-viewport" id="icSepB"></div>
            </div>
          </div>
        ` : `
          <div class="ic-main-viewport img-compare-viewport" id="icMainViewport"></div>
        `}
      </div>

      <section class="tool-docs" aria-label="About Image Compare">
        <h4 class="tool-docs-title">About · Image Compare</h4>
        <p class="tool-docs-lede">
          Side-by-side and wipe/overlay comparison for two stills. Display uses
          <strong>object-fit: contain</strong> inside an AR-aware stage so nothing
          is stretched — same philosophy as the main media preview.
          Distance scores reuse Image Sort metrics via <code>imagesort_rank</code>
          (lower = more similar for every mode).
        </p>
        <h5 class="tool-docs-h">View modes</h5>
        <dl class="tool-docs-dl">
          <dt>Separate</dt>
          <dd>A and B side by side; each box uses that image’s aspect ratio.</dd>
          <dt>Overlay</dt>
          <dd>B stacked on A; opacity slider. Good for alignment / ghosting check.</dd>
          <dt>A/B wipe</dt>
          <dd>Drag the handle or use the slider: left of the line = A, right = B.</dd>
        </dl>
        <h5 class="tool-docs-h">Metrics (same as Image Sort)</h5>
        <dl class="tool-docs-dl">
          <dt>pHash</dt>
          <dd>Perceptual structure. Best general “are these the same picture?” score.</dd>
          <dt>aHash</dt>
          <dd>Coarse brightness grid. Faster, cruder.</dd>
          <dt>colorhash</dt>
          <dd>Palette / color mood more than shape.</dd>
          <dt>MSE</dt>
          <dd>Mean squared pixel error after resize — tight on near-duplicates.</dd>
          <dt>SSIM</dt>
          <dd>Structural similarity as distance (1 − SSIM). Needs scikit-image on the server.</dd>
        </dl>
      </section>
    </div>
  `;
  elements.actionPanel.innerHTML = html;

  // Inputs
  const bindPath = (id, which) => {
    const el = document.getElementById(id);
    el?.addEventListener('change', () => {
      const v = el.value.trim();
      _setPath(which, v || null);
      if (v && !isImagePath(v)) {
        logConsole(`[COMPARE]: Warning — ${basename(v)} may not be a still`);
      }
      _probeDims(which, v);
      _paintViews();
      scheduleRate();
      // refresh clear buttons without full re-render
      const clr = document.getElementById(which === 'A' ? 'btnIcClearA' : 'btnIcClearB');
      if (clr) clr.disabled = !v;
      const name = el.closest('.ic-pick-card')?.querySelector('.ic-path-name');
      if (name) {
        name.textContent = v ? basename(v) : '—';
        name.title = v || '';
      }
    });
    el?.addEventListener('input', () => {
      // live path typing — debounce paint
      if (el._icDeb) clearTimeout(el._icDeb);
      el._icDeb = setTimeout(() => el.dispatchEvent(new Event('change')), 400);
    });
  };
  bindPath('icPathA', 'A');
  bindPath('icPathB', 'B');

  document.getElementById('btnIcBrowseA')?.addEventListener('click', () => {
    openFileBrowser('icPathA', false, 'file', 'image');
  });
  document.getElementById('btnIcBrowseB')?.addEventListener('click', () => {
    openFileBrowser('icPathB', false, 'file', 'image');
  });
  document.getElementById('btnIcClearA')?.addEventListener('click', () => {
    _setPath('A', null);
    const el = document.getElementById('icPathA');
    if (el) el.value = '';
    renderImgCompareForm();
  });
  document.getElementById('btnIcClearB')?.addEventListener('click', () => {
    _setPath('B', null);
    const el = document.getElementById('icPathB');
    if (el) el.value = '';
    renderImgCompareForm();
  });
  document.getElementById('btnIcSwap')?.addEventListener('click', () => {
    _swap();
    renderImgCompareForm();
  });
  document.getElementById('btnIcPoolA')?.addEventListener('click', () => {
    const p = state.imagePool?.selectedPath || state.imagePool?.items?.[0]?.path;
    if (!p) {
      switchTab('images');
      alert('Select a still in Image Pool, then Pool → Compare A (or re-open Compare and click Pool).');
      return;
    }
    _setPath('A', p);
    renderImgCompareForm();
  });
  document.getElementById('btnIcPoolB')?.addEventListener('click', () => {
    const p = state.imagePool?.selectedPath || state.imagePool?.items?.[0]?.path;
    if (!p) {
      switchTab('images');
      alert('Select a still in Image Pool first.');
      return;
    }
    _setPath('B', p);
    renderImgCompareForm();
  });

  document.getElementById('icSortMode')?.addEventListener('change', (e) => {
    ensureIc().sortMode = e.target.value;
    scheduleRate();
  });
  document.getElementById('btnIcRate')?.addEventListener('click', () => ratePair());

  _compareCtl = bindCompareControls({
    idPrefix: ID_PREFIX,
    getState: () => normalizeCompareState(ensureIc()),
    setState: (partial) => {
      const s = ensureIc();
      Object.assign(s, partial);
      if (partial.mode != null) s.compareMode = partial.mode;
    },
    getViewports: () => [
      document.getElementById('icMainViewport'),
      document.getElementById('icSepA'),
      document.getElementById('icSepB'),
    ],
    onModeChange: () => {
      // separate vs composite needs layout rebuild
      renderImgCompareForm();
    },
  });

  _probeDims('A', ic.pathA);
  _probeDims('B', ic.pathB);
  _paintViews();
  _paintScoreUi();
  if (ic.pathA && ic.pathB) scheduleRate();
}

/** Called from Image Pool send-to. */
function applyImgComparePath(path, which) {
  if (!path) return;
  ensureIc();
  _setPath(which === 'B' ? 'B' : 'A', path);
  switchTab('imgcompare');
  logConsole(`[COMPARE]: Set ${which === 'B' ? 'B' : 'A'} → ${basename(path)}`);
}

export { renderImgCompareForm, ensureIc, applyImgComparePath };
