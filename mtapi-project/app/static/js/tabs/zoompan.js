/**
 * Pan & Zoom (zoompan) — still → video between two viewports.
 *
 * Source: global Image bar.
 * Reference (optional): second still for scene-match alignment (Image Pool / Browse).
 *
 * Zoomed Out  = full source + draggable AR-locked box
 * Zoomed In   = pixels inside the box (canvas crop from UI-sized thumb — safe/fast)
 *
 * UI never draws full multi‑megapixel bitmaps on the main thread. Layout is
 * rAF-coalesced so zoom mode toggles cannot stack and freeze the tab.
 *
 * Spec: docs/zoompan-spec.md
 */
import {
  state, elements, logConsole, switchTab, resolveGlobalImage,
} from '/app.js';
import { escapeHtml, basename, isImagePath } from '/js/utils.js';
import {
  defaultCompareState,
  normalizeCompareState,
  compareToolbarHtml,
  paintCompareView,
  bindCompareControls,
} from '/js/ui/image-compare.js';
import { ensureImagePool } from '/js/pool/image-pool.js';

const ASPECTS = {
  '16:9': 16 / 9,
  '9:16': 9 / 16,
  '4:3': 4 / 3,
  '1:1': 1,
  '21:9': 21 / 9,
};

/** Compare pair when overlay/ab is active */
const COMPARE_TARGETS = {
  end_ref: 'Last vs Reference',
  start_ref: 'Start vs Reference',
  both_ref: 'Both vs Reference',
  start_end: 'Start vs Last',
};

const ZP_COMPARE_PREFIX = 'zp';
/** Cap on-canvas UI work so mode switches stay snappy */
const UI_CROP_MAX_CSS = 420;
const UI_CROP_MAX_DPR = 1.25;

/** @type {{ destroy: () => void } | null} */
let _compareCtl = null;
let _imgListenersBound = false;
let _imgRefreshTimer = null;
let _resizeBound = false;

/** UI-sized source/ref (thumbnail API) — never full camera originals in canvas */
const _srcImg = new Image();
const _refImg = new Image();
_srcImg.decoding = 'async';
_refImg.decoding = 'async';
_srcImg.loading = 'eager';
_refImg.loading = 'eager';

/** rAF layout coalescing */
let _layoutRaf = 0;
/** @type {Set<string>} */
const _layoutSides = new Set();
let _layoutWantCompare = false;
let _compareTimer = 0;
let _layoutGen = 0;
/** @type {Record<string, number>} */
const _placeGen = { start: 0, end: 0 };
/** @type {Map<string, string>} */
const _cropUrlCache = new Map();

function ensureZoompan() {
  if (!state.zoompan) {
    state.zoompan = {
      imagePath: null,
      refPath: null,
      imageW: 0,
      imageH: 0,
      startBox: null,
      endBox: null,
      durationSec: 5,
      fps: 24,
      aspect: '16:9',
      viewModeStart: 'full',
      viewModeEnd: 'zoomed', // end often used for match-to-ref
      compareTarget: 'end_ref',
      outputWidth: null,
      outputHeight: null,
      ...defaultCompareState(),
    };
  }
  const z = state.zoompan;
  normalizeCompareState(z);
  if (!ASPECTS[z.aspect]) z.aspect = '16:9';
  z.durationSec = Math.min(600, Math.max(0.1, parseFloat(z.durationSec) || 5));
  z.fps = Math.min(120, Math.max(1, parseFloat(z.fps) || 24));
  if (z.viewModeStart !== 'zoomed') z.viewModeStart = 'full';
  if (z.viewModeEnd !== 'zoomed') z.viewModeEnd = 'full';
  if (!COMPARE_TARGETS[z.compareTarget]) {
    z.compareTarget = z.refPath ? 'end_ref' : 'start_end';
  }
  return z;
}

function resolveZoompanImage() {
  const fromGlobal = (typeof resolveGlobalImage === 'function') ? resolveGlobalImage() : null;
  if (fromGlobal && isImagePath(fromGlobal)) return fromGlobal.trim();
  const gi = (window.globalInputs?.image || '').trim();
  if (!gi) return null;
  const line = gi.split('\n').map(l => l.trim()).find(Boolean);
  return (line && isImagePath(line)) ? line : null;
}

function fullImageUrl(path) {
  return `/api/image?path=${encodeURIComponent(path)}`;
}

function thumbUrl(path) {
  return `/api/thumbnail?path=${encodeURIComponent(path)}&which=first&_t=${encodeURIComponent(path)}`;
}

/** Display URL for UI (always thumb — cheap decode). */
function displayUrl(path) {
  return thumbUrl(path);
}

/**
 * Coalesce layout work onto one animation frame.
 * @param {string|string[]|null} sides  'start' | 'end' | both
 * @param {{ compare?: boolean }} [opts]
 */
function scheduleLayout(sides, opts) {
  opts = opts || {};
  if (sides == null || sides === 'both') {
    _layoutSides.add('start');
    _layoutSides.add('end');
  } else if (Array.isArray(sides)) {
    sides.forEach((s) => _layoutSides.add(s));
  } else {
    _layoutSides.add(sides);
  }
  if (opts.compare) _layoutWantCompare = true;
  if (_layoutRaf) return;
  const gen = _layoutGen;
  _layoutRaf = requestAnimationFrame(() => {
    _layoutRaf = 0;
    if (gen !== _layoutGen) return; // form was torn down / re-rendered
    const todo = Array.from(_layoutSides);
    _layoutSides.clear();
    const wantCmp = _layoutWantCompare;
    _layoutWantCompare = false;
    try {
      todo.forEach((s) => {
        try { _layoutSide(s); } catch (err) {
          console.error('[ZOOMPAN] layoutSide', s, err);
        }
      });
    } catch (err) {
      console.error('[ZOOMPAN] layout', err);
    }
    if (wantCmp) scheduleCompareHost();
  });
}

function scheduleCompareHost() {
  if (_compareTimer) clearTimeout(_compareTimer);
  _compareTimer = setTimeout(() => {
    _compareTimer = 0;
    try { _refreshCompareHost(); } catch (err) {
      console.error('[ZOOMPAN] compare host', err);
    }
  }, 80);
}

function invalidateCropCache() {
  _cropUrlCache.clear();
}

function bumpLayoutGen() {
  _layoutGen += 1;
  if (_layoutRaf) {
    cancelAnimationFrame(_layoutRaf);
    _layoutRaf = 0;
  }
  _layoutSides.clear();
  _layoutWantCompare = false;
  if (_compareTimer) {
    clearTimeout(_compareTimer);
    _compareTimer = 0;
  }
}

function aspectRatio() {
  return ASPECTS[ensureZoompan().aspect] || (16 / 9);
}

function maxAreaBox(iw, ih, ar) {
  let w = iw;
  let h = w / ar;
  if (h > ih) {
    h = ih;
    w = h * ar;
  }
  return clampBox({ x: (iw - w) / 2, y: (ih - h) / 2, w, h }, iw, ih);
}

function scaleBoxFrom(base, factor, iw, ih) {
  const w = Math.max(8, base.w * factor);
  const h = w / aspectRatio();
  const cx = base.x + base.w / 2;
  const cy = base.y + base.h / 2;
  return clampBox({ x: cx - w / 2, y: cy - h / 2, w, h }, iw, ih);
}

function clampBox(box, iw, ih) {
  const ar = aspectRatio();
  let w = Math.min(Math.max(8, box.w), iw);
  let h = w / ar;
  if (h > ih) {
    h = ih;
    w = h * ar;
  }
  if (w > iw) {
    w = iw;
    h = w / ar;
  }
  let x = Math.min(Math.max(0, box.x), Math.max(0, iw - w));
  let y = Math.min(Math.max(0, box.y), Math.max(0, ih - h));
  if (x + w > iw) x = Math.max(0, iw - w);
  if (y + h > ih) y = Math.max(0, ih - h);
  return { x, y, w, h };
}

function ensureBoxes() {
  const z = ensureZoompan();
  if (!z.imageW || !z.imageH) return;
  if (!z.startBox) z.startBox = maxAreaBox(z.imageW, z.imageH, aspectRatio());
  else z.startBox = clampBox(z.startBox, z.imageW, z.imageH);
  if (!z.endBox) z.endBox = scaleBoxFrom(z.startBox, 0.5, z.imageW, z.imageH);
  else z.endBox = clampBox(z.endBox, z.imageW, z.imageH);
}

async function probeImagePixels(path) {
  try {
    const res = await fetch(`/api/probe?path=${encodeURIComponent(path)}`);
    if (res.ok) {
      const data = await res.json();
      const w = data.width || data.w;
      const h = data.height || data.h;
      if (w && h) return { w: parseInt(w, 10), h: parseInt(h, 10) };
    }
  } catch (_) { /* ignore */ }
  return null;
}

function loadDisplayImage(imgEl, path) {
  return new Promise((resolve) => {
    if (!path) {
      try { imgEl.removeAttribute('src'); } catch (_) { /* ignore */ }
      delete imgEl.dataset.path;
      resolve(false);
      return;
    }
    const url = displayUrl(path);
    if (imgEl.dataset.path === path && imgEl.complete && imgEl.naturalWidth > 0) {
      resolve(true);
      return;
    }
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      if (ok) imgEl.dataset.path = path;
      resolve(ok);
    };
    // Hard timeout so a hung decode never freezes the tab forever
    const t = setTimeout(() => done(imgEl.complete && imgEl.naturalWidth > 0), 4000);
    imgEl.addEventListener('load', () => { clearTimeout(t); done(true); }, { once: true });
    imgEl.addEventListener('error', () => { clearTimeout(t); done(false); }, { once: true });
    try {
      imgEl.src = url;
    } catch (_) {
      clearTimeout(t);
      done(false);
    }
    if (imgEl.complete && imgEl.naturalWidth > 0 && imgEl.dataset.path === path) {
      clearTimeout(t);
      done(true);
    }
  });
}

function _bindGlobalImageListener() {
  if (_imgListenersBound) return;
  _imgListenersBound = true;
  const gi = document.getElementById('giImage');
  if (!gi) return;
  const onImg = () => {
    if (state.activeTab !== 'zoompan') return;
    if (_imgRefreshTimer) clearTimeout(_imgRefreshTimer);
    _imgRefreshTimer = setTimeout(() => renderZoompanForm(), 200);
  };
  gi.addEventListener('input', onImg);
  gi.addEventListener('change', onImg);
}

function boxInputsHtml(side, box) {
  const b = box || { x: 0, y: 0, w: 0, h: 0 };
  const pre = side === 'start' ? 'zpStart' : 'zpEnd';
  return `
    <div class="zp-box-nums" data-side="${side}">
      <label>x <input type="number" id="${pre}X" step="1" value="${Math.round(b.x)}"></label>
      <label>y <input type="number" id="${pre}Y" step="1" value="${Math.round(b.y)}"></label>
      <label>w <input type="number" id="${pre}W" step="1" value="${Math.round(b.w)}"></label>
      <label>h <input type="number" id="${pre}H" step="1" value="${Math.round(b.h)}" readonly title="Locked to aspect ratio"></label>
    </div>
  `;
}

function viewportCardHtml(side, label, viewMode) {
  const z = ensureZoompan();
  const box = side === 'start' ? z.startBox : z.endBox;
  const fullActive = viewMode === 'full' ? ' active' : '';
  const zoomActive = viewMode === 'zoomed' ? ' active' : '';
  const id = side === 'start' ? 'Start' : 'End';
  return `
    <div class="zp-card" data-side="${side}">
      <div class="zp-card-head">
        <div class="zp-card-title">${escapeHtml(label)}</div>
        <div class="zp-view-toggle" role="group" aria-label="${escapeHtml(label)} view mode">
          <button type="button" class="zp-view-btn${fullActive}" data-side="${side}" data-mode="full"
            title="Full source image with viewport box">Zoomed Out</button>
          <button type="button" class="zp-view-btn${zoomActive}" data-side="${side}" data-mode="zoomed"
            title="Exactly the pixels inside the box (output frame)">Zoomed In</button>
        </div>
      </div>
      <div class="zp-viewport" id="zpView${id}" data-side="${side}" data-view="${viewMode}">
        <div class="zp-stage" id="zpStage${id}">
          <!-- full mode -->
          <img class="zp-img zp-full-img" alt="${escapeHtml(label)}" draggable="false" hidden>
          <div class="zp-box" hidden>
            <span class="zp-box-handle n" data-h="n"></span>
            <span class="zp-box-handle s" data-h="s"></span>
            <span class="zp-box-handle e" data-h="e"></span>
            <span class="zp-box-handle w" data-h="w"></span>
            <span class="zp-box-handle nw" data-h="nw"></span>
            <span class="zp-box-handle ne" data-h="ne"></span>
            <span class="zp-box-handle sw" data-h="sw"></span>
            <span class="zp-box-handle se" data-h="se"></span>
          </div>
          <!-- zoomed mode: exact crop + optional ref layer -->
          <canvas class="zp-crop-canvas" hidden></canvas>
          <img class="zp-ref-layer" alt="reference" draggable="false" hidden>
          <div class="zp-ab-handle" hidden aria-hidden="true"></div>
          <div class="zp-layer-labels" hidden><span>Crop</span><span>Ref</span></div>
          <div class="zp-empty" hidden>Set global Image</div>
        </div>
      </div>
      ${boxInputsHtml(side, box)}
    </div>
  `;
}

async function renderZoompanForm() {
  _bindGlobalImageListener();
  bumpLayoutGen();
  invalidateCropCache();
  if (_compareCtl) {
    try { _compareCtl.destroy(); } catch (_) { /* ignore */ }
    _compareCtl = null;
  }

  // pending ref from Image Pool
  if (state._zoompanPendingRef && state.imagePool?.selectedPath) {
    const p = state.imagePool.selectedPath;
    if (isImagePath(p)) {
      ensureZoompan().refPath = p;
      logConsole(`[ZOOMPAN]: Reference ← ${basename(p)}`);
    }
    state._zoompanPendingRef = false;
  }

  const z = ensureZoompan();
  const path = resolveZoompanImage();
  z.imagePath = path;

  if (path) {
    try {
      const dims = await probeImagePixels(path);
      if (dims && dims.w > 0 && dims.h > 0) {
        const sizeChanged = z.imageW !== dims.w || z.imageH !== dims.h || z._loadedPath !== path;
        z.imageW = dims.w;
        z.imageH = dims.h;
        if (sizeChanged) {
          z._loadedPath = path;
          z.startBox = null;
          z.endBox = null;
          invalidateCropCache();
        }
      }
      // UI bitmap only (thumb). Full res stays on the server for encode.
      await loadDisplayImage(_srcImg, path);
    } catch (err) {
      logConsole(`[ZOOMPAN]: source load failed — ${err.message}`, 'error');
    }
  } else {
    z.imageW = 0;
    z.imageH = 0;
    z.startBox = null;
    z.endBox = null;
    z._loadedPath = null;
    await loadDisplayImage(_srcImg, null);
  }

  if (z.refPath) {
    try {
      await loadDisplayImage(_refImg, z.refPath);
    } catch (err) {
      logConsole(`[ZOOMPAN]: ref load failed — ${err.message}`, 'error');
    }
  } else {
    await loadDisplayImage(_refImg, null);
  }

  ensureBoxes();

  const cmp = {
    mode: z.mode || 'separate',
    overlayOpacity: z.overlayOpacity,
    abPosition: z.abPosition,
  };
  const mode = cmp.mode;

  const toolbar = compareToolbarHtml({
    idPrefix: ZP_COMPARE_PREFIX,
    state: cmp,
    label: 'Compare',
    modeTitles: {
      separate: 'Edit Start / Last (and view Reference alone)',
      overlay: 'Stack reference on the crop for alignment',
      ab: 'Wipe between crop (left) and reference (right)',
    },
  });

  const targetOpts = Object.entries(COMPARE_TARGETS).map(([k, lab]) => {
    const dis = (k !== 'start_end' && !z.refPath) ? ' disabled' : '';
    return `<option value="${k}"${z.compareTarget === k ? ' selected' : ''}${dis}>${lab}</option>`;
  }).join('');

  const html = `
    <div class="zp-workspace">
      <div class="panel-title-desc">
        <h3>Pan &amp; Zoom</h3>
        <p>
          Match two scenes that share content but don’t line up: set a
          <strong>Reference</strong> still, place Start/Last viewports on the source,
          use <strong>Zoomed In + Overlay/A/B</strong> to align, then Run to render
          the pan/zoom between boxes.
        </p>
      </div>

      <div class="zp-source-row">
        <label class="zp-field-label">Source</label>
        <div class="zp-global-path" id="zpImagePath" title="${escapeHtml(path || '')}">
          ${escapeHtml(path || '— set Image in the global bar above —')}
        </div>
        <span class="zp-meta-line" id="zpImageMeta">
          ${path && z.imageW ? `${z.imageW}×${z.imageH}px` : (path ? '…' : 'no image')}
        </span>
      </div>

      <div class="zp-source-row zp-ref-row">
        <label class="zp-field-label">Reference</label>
        <div class="zp-global-path" id="zpRefPath" title="${escapeHtml(z.refPath || '')}">
          ${escapeHtml(z.refPath || '— optional: still from the other scene to match against —')}
        </div>
        <div class="zp-ref-actions">
          <button type="button" class="btn btn-sm" id="btnZpRefPool">Image Pool</button>
          <button type="button" class="btn btn-sm" id="btnZpRefBrowse">Browse…</button>
          <button type="button" class="btn btn-sm" id="btnZpRefClear" ${z.refPath ? '' : 'disabled'}>Clear</button>
        </div>
      </div>

      <div class="zp-params-row">
        <label>Duration (s)
          <input type="number" id="zpDuration" min="0.1" max="600" step="0.1" value="${z.durationSec}">
        </label>
        <label>FPS
          <input type="number" id="zpFps" min="1" max="120" step="1" value="${z.fps}">
        </label>
        <label>Aspect
          <select id="zpAspect">
            ${Object.keys(ASPECTS).map(k =>
              `<option value="${k}"${z.aspect === k ? ' selected' : ''}>${k}</option>`
            ).join('')}
          </select>
        </label>
        <span class="zp-frame-count" id="zpFrameCount">
          ${Math.max(2, Math.round(z.durationSec * z.fps))} frames
        </span>
      </div>

      <div class="zp-compare-controls">
        ${toolbar}
        <label class="zp-pair-label">Pair
          <select id="zpCompareTarget" title="What Overlay / A/B compares">
            ${targetOpts}
          </select>
        </label>
      </div>

      <div class="zp-frames-grid" id="zpFramesGrid">
        ${viewportCardHtml('start', 'Start Frame', z.viewModeStart)}
        ${viewportCardHtml('end', 'Last Frame', z.viewModeEnd)}
      </div>

      <div class="zp-compare-host" id="zpCompareHost" hidden>
        <div class="zp-card-title" id="zpCompareHostTitle">Compare</div>
        <div class="zp-viewport img-compare-viewport" id="zpCompareView"></div>
      </div>

      <div class="zp-footer-hint">
        <p>
          <strong>Zoomed Out</strong> — drag/resize the blue box on the full source.
          <strong>Zoomed In</strong> — shows <em>only</em> pixels inside that box (true output frame).
          Load a <strong>Reference</strong>, set Compare to Overlay or A/B, Pair =
          “Last vs Reference”, then nudge the Last box until it matches. Run encodes
          Start → Last pan/zoom.
        </p>
      </div>
    </div>
  `;

  elements.actionPanel.innerHTML = html;
  _bindZoompanForm();
  await _paintAllViewports();
}

function _bindZoompanForm() {
  const z = ensureZoompan();

  document.getElementById('zpDuration')?.addEventListener('input', (e) => {
    z.durationSec = Math.min(600, Math.max(0.1, parseFloat(e.target.value) || 5));
    _updateFrameCount();
  });
  document.getElementById('zpFps')?.addEventListener('input', (e) => {
    z.fps = Math.min(120, Math.max(1, parseFloat(e.target.value) || 24));
    _updateFrameCount();
  });
  document.getElementById('zpAspect')?.addEventListener('change', (e) => {
    z.aspect = e.target.value;
    if (z.imageW && z.imageH) {
      z.startBox = z.startBox
        ? clampBox({ ...z.startBox, h: z.startBox.w / aspectRatio() }, z.imageW, z.imageH)
        : maxAreaBox(z.imageW, z.imageH, aspectRatio());
      z.endBox = z.endBox
        ? clampBox({ ...z.endBox, h: z.endBox.w / aspectRatio() }, z.imageW, z.imageH)
        : scaleBoxFrom(z.startBox, 0.5, z.imageW, z.imageH);
    }
    renderZoompanForm();
  });

  document.getElementById('zpCompareTarget')?.addEventListener('change', (e) => {
    z.compareTarget = e.target.value;
    invalidateCropCache();
    scheduleLayout('both', { compare: true });
  });

  document.querySelectorAll('.zp-view-btn').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const side = btn.getAttribute('data-side');
      const mode = btn.getAttribute('data-mode');
      if (!side || !mode) return;
      const cur = side === 'start' ? z.viewModeStart : z.viewModeEnd;
      if (cur === mode) return; // no-op re-click
      if (side === 'start') z.viewModeStart = mode;
      else z.viewModeEnd = mode;
      document.querySelectorAll(`.zp-view-btn[data-side="${side}"]`).forEach((b) => {
        b.classList.toggle('active', b.getAttribute('data-mode') === mode);
      });
      const vp = document.getElementById(side === 'start' ? 'zpViewStart' : 'zpViewEnd');
      if (vp) vp.setAttribute('data-view', mode);
      // Cheap: one side only, compare host debounced (not sync toDataURL)
      scheduleLayout(side, { compare: true });
    });
  });

  ['start', 'end'].forEach((side) => {
    const pre = side === 'start' ? 'zpStart' : 'zpEnd';
    const commit = () => {
      const box = {
        x: parseFloat(document.getElementById(`${pre}X`)?.value) || 0,
        y: parseFloat(document.getElementById(`${pre}Y`)?.value) || 0,
        w: parseFloat(document.getElementById(`${pre}W`)?.value) || 8,
        h: 0,
      };
      box.h = box.w / aspectRatio();
      const clamped = clampBox(box, z.imageW || 1, z.imageH || 1);
      if (side === 'start') z.startBox = clamped;
      else z.endBox = clamped;
      _syncBoxInputs(side);
      invalidateCropCache();
      scheduleLayout(side, { compare: true });
    };
    ['X', 'Y', 'W'].forEach((k) => {
      document.getElementById(`${pre}${k}`)?.addEventListener('change', commit);
    });
  });

  document.getElementById('btnZpRefPool')?.addEventListener('click', () => {
    const ip = ensureImagePool();
    if (ip.selectedPath && isImagePath(ip.selectedPath)) {
      z.refPath = ip.selectedPath;
      logConsole(`[ZOOMPAN]: Reference ← ${basename(ip.selectedPath)}`);
      renderZoompanForm();
      return;
    }
    if (ip.items.length === 1) {
      z.refPath = ip.items[0].path;
      ip.selectedPath = ip.items[0].path;
      logConsole(`[ZOOMPAN]: Reference ← ${basename(ip.items[0].path)}`);
      renderZoompanForm();
      return;
    }
    state._zoompanPendingRef = true;
    if (ip.items.length === 0) {
      alert('Image Pool is empty. Import a still from the other scene, select it — it becomes the Reference.');
    } else {
      alert('Click an image in the Image Pool to set the Zoompan Reference.');
    }
    switchTab('images');
  });

  document.getElementById('btnZpRefBrowse')?.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/picker?mode=file&filter=image');
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      if (!data.path) return;
      if (!isImagePath(data.path)) {
        alert('Pick an image file.');
        return;
      }
      z.refPath = data.path;
      try {
        const { addPathsToImagePool } = await import('/js/pool/image-pool.js');
        addPathsToImagePool([data.path]);
      } catch (_) { /* ignore */ }
      logConsole(`[ZOOMPAN]: Reference ← ${data.path}`);
      renderZoompanForm();
    } catch (err) {
      logConsole(`[ZOOMPAN]: Browse failed — ${err.message}`, 'error');
    }
  });

  document.getElementById('btnZpRefClear')?.addEventListener('click', () => {
    z.refPath = null;
    if (z.compareTarget !== 'start_end') z.compareTarget = 'start_end';
    renderZoompanForm();
  });

  _compareCtl = bindCompareControls({
    idPrefix: ZP_COMPARE_PREFIX,
    getState: () => {
      const zz = ensureZoompan();
      return {
        mode: zz.mode || 'separate',
        overlayOpacity: zz.overlayOpacity,
        abPosition: zz.abPosition,
      };
    },
    setState: (partial) => {
      const zz = ensureZoompan();
      if (partial.mode != null) zz.mode = partial.mode;
      if (partial.overlayOpacity != null) zz.overlayOpacity = partial.overlayOpacity;
      if (partial.abPosition != null) zz.abPosition = partial.abPosition;
    },
    getViewports: () => [
      document.getElementById('zpViewStart'),
      document.getElementById('zpViewEnd'),
      document.getElementById('zpCompareView'),
    ],
    onModeChange: () => {
      // Separate/overlay/ab — layout only, no full form rebuild
      invalidateCropCache();
      scheduleLayout('both', { compare: true });
    },
  });

  // Opacity / A/B slider: update CSS layers only (no canvas redraw / toDataURL)
  const slider = document.getElementById(`${ZP_COMPARE_PREFIX}CompareSlider`);
  if (slider && !slider.dataset.zpExtra) {
    slider.dataset.zpExtra = '1';
    slider.addEventListener('input', () => {
      _applyRefLayerCss('start');
      _applyRefLayerCss('end');
      // host compare uses paintCompareView — light debounce
      scheduleCompareHost();
    });
  }
}

function _updateFrameCount() {
  const z = ensureZoompan();
  const el = document.getElementById('zpFrameCount');
  if (el) el.textContent = `${Math.max(2, Math.round(z.durationSec * z.fps))} frames`;
}

function _syncBoxInputs(side) {
  const z = ensureZoompan();
  const box = side === 'start' ? z.startBox : z.endBox;
  if (!box) return;
  const pre = side === 'start' ? 'zpStart' : 'zpEnd';
  const set = (id, v) => {
    const el = document.getElementById(id);
    if (el && document.activeElement !== el) el.value = String(Math.round(v));
  };
  set(`${pre}X`, box.x);
  set(`${pre}Y`, box.y);
  set(`${pre}W`, box.w);
  set(`${pre}H`, box.h);
}

function _imageContentRect(stage, img) {
  if (!stage || !img) return null;
  const sw = stage.clientWidth;
  const sh = stage.clientHeight;
  const nw = img.naturalWidth || 1;
  const nh = img.naturalHeight || 1;
  const scale = Math.min(sw / nw, sh / nh);
  const dw = nw * scale;
  const dh = nh * scale;
  return {
    ox: (sw - dw) / 2,
    oy: (sh - dh) / 2,
    dw, dh, sw, sh, scale, nw, nh,
  };
}

/**
 * Draw box region onto canvas (UI thumb source). Caps pixel work hard.
 */
function _drawExactCrop(canvas, box) {
  const z = ensureZoompan();
  if (!canvas || !box || !_srcImg.naturalWidth || !z.imageW) return false;
  const stage = canvas.parentElement;
  if (!stage) return false;
  let sw = stage.clientWidth;
  let sh = stage.clientHeight;
  if (sw < 2 || sh < 2) return false;

  // Cap CSS size we actually rasterize
  const cap = UI_CROP_MAX_CSS;
  if (sw > cap || sh > cap) {
    const sc = Math.min(cap / sw, cap / sh);
    sw = Math.max(2, Math.round(sw * sc));
    sh = Math.max(2, Math.round(sh * sc));
  }

  const dpr = Math.min(UI_CROP_MAX_DPR, window.devicePixelRatio || 1);
  const bw = Math.round(sw * dpr);
  const bh = Math.round(sh * dpr);
  // Skip resize if identical (avoids clearing GPU memory every toggle)
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  canvas.style.width = '100%';
  canvas.style.height = '100%';

  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return false;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0a0e16';
  ctx.fillRect(0, 0, sw, sh);

  const nw = _srcImg.naturalWidth;
  const nh = _srcImg.naturalHeight;
  const sx = (box.x / z.imageW) * nw;
  const sy = (box.y / z.imageH) * nh;
  const sww = Math.max(1, (box.w / z.imageW) * nw);
  const shh = Math.max(1, (box.h / z.imageH) * nh);

  const scale = Math.min(sw / box.w, sh / box.h);
  const dw = box.w * scale;
  const dh = box.h * scale;
  const dx = (sw - dw) / 2;
  const dy = (sh - dh) / 2;

  try {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'medium';
    ctx.drawImage(_srcImg, sx, sy, sww, shh, dx, dy, dw, dh);
    return true;
  } catch (_) {
    return false;
  }
}

/** Update ref opacity / wipe without redrawing crop canvas. */
function _applyRefLayerCss(side) {
  const z = ensureZoompan();
  const stage = document.getElementById(side === 'start' ? 'zpStageStart' : 'zpStageEnd');
  if (!stage || !stage.classList.contains('has-ref-overlay')) return;
  const refLayer = stage.querySelector('.zp-ref-layer');
  const abHandle = stage.querySelector('.zp-ab-handle');
  const labels = stage.querySelector('.zp-layer-labels');
  const mode = z.mode || 'separate';
  if (!refLayer || refLayer.hidden) return;
  if (mode === 'overlay') {
    refLayer.style.opacity = String(Math.min(100, Math.max(0, z.overlayOpacity)) / 100);
    refLayer.style.clipPath = '';
    if (abHandle) abHandle.hidden = true;
    if (labels) labels.hidden = true;
  } else if (mode === 'ab') {
    const p = Math.min(100, Math.max(0, z.abPosition));
    refLayer.style.opacity = '1';
    refLayer.style.clipPath = `inset(0 0 0 ${p}%)`;
    if (abHandle) {
      abHandle.hidden = false;
      abHandle.style.left = `${p}%`;
    }
    if (labels) labels.hidden = false;
  }
}

function _sideUsesRefOverlay(side) {
  const z = ensureZoompan();
  const mode = z.mode || 'separate';
  if (mode === 'separate' || !z.refPath) return false;
  const t = z.compareTarget || 'end_ref';
  if (t === 'both_ref') return true;
  if (t === 'start_ref') return side === 'start';
  if (t === 'end_ref') return side === 'end';
  return false; // start_end uses host compare
}

function _layoutSide(side) {
  const z = ensureZoompan();
  const viewMode = side === 'start' ? z.viewModeStart : z.viewModeEnd;
  const stage = document.getElementById(side === 'start' ? 'zpStageStart' : 'zpStageEnd');
  if (!stage) return;

  const fullImg = stage.querySelector('.zp-full-img');
  const boxEl = stage.querySelector('.zp-box');
  const canvas = stage.querySelector('.zp-crop-canvas');
  const refLayer = stage.querySelector('.zp-ref-layer');
  const abHandle = stage.querySelector('.zp-ab-handle');
  const labels = stage.querySelector('.zp-layer-labels');
  const empty = stage.querySelector('.zp-empty');
  const box = side === 'start' ? z.startBox : z.endBox;
  const mode = z.mode || 'separate';

  stage.classList.toggle('is-zoomed', viewMode === 'zoomed');
  stage.classList.toggle('is-full', viewMode === 'full');
  stage.classList.remove('has-ref-overlay');

  if (!z.imagePath || !z.imageW) {
    if (fullImg) fullImg.hidden = true;
    if (boxEl) boxEl.hidden = true;
    if (canvas) canvas.hidden = true;
    if (refLayer) refLayer.hidden = true;
    if (abHandle) abHandle.hidden = true;
    if (labels) labels.hidden = true;
    if (empty) { empty.hidden = false; empty.textContent = 'Set global Image'; }
    return;
  }
  if (empty) empty.hidden = true;

  if (viewMode === 'full') {
    if (canvas) canvas.hidden = true;
    if (refLayer) refLayer.hidden = true;
    if (abHandle) abHandle.hidden = true;
    if (labels) labels.hidden = true;
    if (fullImg) {
      fullImg.hidden = false;
      // Always thumb for UI — never swap to multi‑MB /api/image mid-toggle
      const prefer = displayUrl(z.imagePath);
      if (fullImg.dataset.src !== prefer) {
        fullImg.dataset.src = prefer;
        fullImg.src = prefer;
      }
      fullImg.style.cssText = 'width:100%;height:100%;object-fit:contain;object-position:center;display:block;pointer-events:none;';
    }
    if (boxEl && box && fullImg) {
      const gen = ++_placeGen[side];
      const place = () => {
        if (gen !== _placeGen[side]) return;
        const zz = ensureZoompan();
        if ((side === 'start' ? zz.viewModeStart : zz.viewModeEnd) !== 'full') return;
        boxEl.hidden = false;
        const r = _imageContentRect(stage, fullImg);
        if (!r || r.dw < 1) return;
        boxEl.style.left = `${r.ox + (box.x / zz.imageW) * r.dw}px`;
        boxEl.style.top = `${r.oy + (box.y / zz.imageH) * r.dh}px`;
        boxEl.style.width = `${(box.w / zz.imageW) * r.dw}px`;
        boxEl.style.height = `${(box.h / zz.imageH) * r.dh}px`;
      };
      if (fullImg.complete && fullImg.naturalWidth) place();
      else fullImg.addEventListener('load', place, { once: true });
    }
    return;
  }

  // ── Zoomed In: box contents (UI thumb crop) ───────────────────────────
  if (fullImg) fullImg.hidden = true;
  if (boxEl) boxEl.hidden = true;
  if (canvas) {
    canvas.hidden = false;
    _drawExactCrop(canvas, box);
  }

  const useRef = _sideUsesRefOverlay(side) && _refImg.complete && _refImg.naturalWidth > 0;
  if (refLayer) {
    if (useRef) {
      stage.classList.add('has-ref-overlay');
      refLayer.hidden = false;
      const refDisp = displayUrl(z.refPath);
      if (refLayer.dataset.path !== z.refPath) {
        refLayer.dataset.path = z.refPath;
        refLayer.src = refDisp;
      }
      refLayer.classList.toggle('mode-overlay', mode === 'overlay');
      refLayer.classList.toggle('mode-ab', mode === 'ab');
      _applyRefLayerCss(side);
    } else {
      refLayer.hidden = true;
      refLayer.style.opacity = '';
      refLayer.style.clipPath = '';
      if (abHandle) abHandle.hidden = true;
      if (labels) labels.hidden = true;
    }
  }

  if (useRef && mode === 'ab') {
    _bindAbOnStage(stage);
  }
}

function _bindAbOnStage(stage) {
  if (stage.dataset.abBound === '1') return;
  stage.dataset.abBound = '1';
  let dragging = false;
  stage.addEventListener('pointerdown', (e) => {
    const z = ensureZoompan();
    if ((z.mode || 'separate') !== 'ab') return;
    if (!stage.classList.contains('is-zoomed') || !stage.classList.contains('has-ref-overlay')) return;
    if (e.button != null && e.button !== 0) return;
    dragging = true;
    try { stage.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    _setAbFromClientX(stage, e.clientX);
    e.preventDefault();
  });
  stage.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    _setAbFromClientX(stage, e.clientX);
  });
  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    try { stage.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
}

function _setAbFromClientX(stage, clientX) {
  const z = ensureZoompan();
  const rect = stage.getBoundingClientRect();
  if (rect.width <= 0) return;
  const v = Math.min(100, Math.max(0, Math.round(((clientX - rect.left) / rect.width) * 100)));
  if (v === z.abPosition) return;
  z.abPosition = v;
  const slider = document.getElementById(`${ZP_COMPARE_PREFIX}CompareSlider`);
  if (slider) slider.value = String(v);
  const valEl = document.getElementById(`${ZP_COMPARE_PREFIX}CompareSliderVal`);
  if (valEl) valEl.textContent = `${v}%`;
  // CSS only — never redraw canvas / toDataURL while dragging
  _applyRefLayerCss('start');
  _applyRefLayerCss('end');
}

function _refreshAllLayouts() {
  scheduleLayout('both', { compare: true });
}

/**
 * Host compare panel for Start vs Last (or when pair needs a third view).
 */
function _refreshCompareHost() {
  const z = ensureZoompan();
  const host = document.getElementById('zpCompareHost');
  const view = document.getElementById('zpCompareView');
  const title = document.getElementById('zpCompareHostTitle');
  if (!host || !view) return;

  const mode = z.mode || 'separate';
  const target = z.compareTarget || 'end_ref';

  // In-viewport ref overlay covers start_ref / end_ref / both_ref when zoomed
  // Show host panel for start_end, or when user is in overlay/ab with full (not zoomed) modes
  const needsHost =
    mode !== 'separate' &&
    (target === 'start_end' ||
      (target === 'start_ref' && z.viewModeStart === 'full') ||
      (target === 'end_ref' && z.viewModeEnd === 'full') ||
      (target === 'both_ref' && (z.viewModeStart === 'full' || z.viewModeEnd === 'full')));

  if (!needsHost) {
    host.hidden = true;
    return;
  }
  host.hidden = false;

  let baseSrc = '';
  let refSrc = '';
  let baseLabel = 'Base';
  let refLabel = 'Ref';

  if (target === 'start_end') {
    baseSrc = _cropDataUrl('start');
    refSrc = _cropDataUrl('end');
    baseLabel = 'Start';
    refLabel = 'Last';
    if (title) title.textContent = 'Start vs Last (crops)';
  } else if (target === 'start_ref') {
    baseSrc = _cropDataUrl('start');
    refSrc = z.refPath ? fullImageUrl(z.refPath) : '';
    baseLabel = 'Start crop';
    refLabel = 'Reference';
    if (title) title.textContent = 'Start crop vs Reference';
  } else if (target === 'end_ref') {
    baseSrc = _cropDataUrl('end');
    refSrc = z.refPath ? fullImageUrl(z.refPath) : '';
    baseLabel = 'Last crop';
    refLabel = 'Reference';
    if (title) title.textContent = 'Last crop vs Reference';
  } else {
    // both_ref but one side full — show end vs ref as host helper
    baseSrc = _cropDataUrl('end');
    refSrc = z.refPath ? fullImageUrl(z.refPath) : '';
    baseLabel = 'Crop';
    refLabel = 'Reference';
    if (title) title.textContent = 'Crop vs Reference';
  }

  paintCompareView(view, {
    mode,
    baseSrc,
    baseKey: baseLabel,
    refSrc,
    opacity: z.overlayOpacity,
    ab: z.abPosition,
    baseLabel,
    refLabel,
    emptyMsg: 'Need source + boxes',
    missingRefMsg: 'Load a Reference still',
    emptyClass: 'zp-empty-msg',
  });
}

function _cropDataUrl(side) {
  const z = ensureZoompan();
  const box = side === 'start' ? z.startBox : z.endBox;
  if (!box || !_srcImg.naturalWidth || !z.imageW) return '';

  const key = [
    side,
    z.imagePath || '',
    Math.round(box.x), Math.round(box.y), Math.round(box.w), Math.round(box.h),
  ].join('|');
  if (_cropUrlCache.has(key)) return _cropUrlCache.get(key);

  const nw = _srcImg.naturalWidth;
  const nh = _srcImg.naturalHeight;
  const sx = (box.x / z.imageW) * nw;
  const sy = (box.y / z.imageH) * nh;
  const sw = Math.max(1, (box.w / z.imageW) * nw);
  const sh = Math.max(1, (box.h / z.imageH) * nh);

  const maxSide = 320; // host compare only — keep tiny
  const sc = Math.min(1, maxSide / Math.max(box.w, box.h, 1));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(2, Math.round(box.w * sc));
  canvas.height = Math.max(2, Math.round(box.h * sc));
  const ctx = canvas.getContext('2d');
  let url = '';
  try {
    ctx.drawImage(_srcImg, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    url = canvas.toDataURL('image/jpeg', 0.75);
  } catch (_) {
    url = '';
  }
  if (url) {
    if (_cropUrlCache.size > 12) _cropUrlCache.clear();
    _cropUrlCache.set(key, url);
  }
  return url;
}

async function _paintAllViewports() {
  for (const side of ['start', 'end']) {
    _bindBoxInteraction(side);
  }
  scheduleLayout('both', { compare: true });

  if (!_resizeBound) {
    _resizeBound = true;
    let resizeT = 0;
    window.addEventListener('resize', () => {
      if (state.activeTab !== 'zoompan') return;
      if (resizeT) clearTimeout(resizeT);
      resizeT = setTimeout(() => {
        resizeT = 0;
        invalidateCropCache();
        scheduleLayout('both', { compare: true });
      }, 120);
    });
  }
}

function _bindBoxInteraction(side) {
  const z = ensureZoompan();
  const stage = document.getElementById(side === 'start' ? 'zpStageStart' : 'zpStageEnd');
  if (!stage) return;
  const boxEl = stage.querySelector('.zp-box');
  const fullImg = stage.querySelector('.zp-full-img');
  if (!boxEl || boxEl.dataset.bound === '1') return;
  boxEl.dataset.bound = '1';

  let drag = null;

  function getBox() {
    return side === 'start' ? ensureZoompan().startBox : ensureZoompan().endBox;
  }
  function setBox(b) {
    const zz = ensureZoompan();
    const c = clampBox(b, zz.imageW, zz.imageH);
    if (side === 'start') zz.startBox = c;
    else zz.endBox = c;
    _syncBoxInputs(side);
    invalidateCropCache();
    // During drag: only this side, skip expensive compare host until pointerup
    scheduleLayout(side, { compare: false });
  }

  function clientToImage(clientX, clientY) {
    const img = stage.querySelector('.zp-full-img');
    const r = _imageContentRect(stage, img);
    if (!r) return { x: 0, y: 0 };
    const rect = stage.getBoundingClientRect();
    const lx = clientX - rect.left;
    const ly = clientY - rect.top;
    const zz = ensureZoompan();
    return {
      x: ((lx - r.ox) / r.dw) * zz.imageW,
      y: ((ly - r.oy) / r.dh) * zz.imageH,
    };
  }

  boxEl.addEventListener('pointerdown', (e) => {
    const zz = ensureZoompan();
    const viewMode = side === 'start' ? zz.viewModeStart : zz.viewModeEnd;
    if (viewMode !== 'full') return;
    if (e.button != null && e.button !== 0) return;
    const handle = e.target?.getAttribute?.('data-h') || null;
    const b = getBox();
    if (!b) return;
    drag = { handle, startPt: clientToImage(e.clientX, e.clientY), orig: { ...b } };
    try { boxEl.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    e.preventDefault();
    e.stopPropagation();
  });

  boxEl.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const pt = clientToImage(e.clientX, e.clientY);
    const dx = pt.x - drag.startPt.x;
    const dy = pt.y - drag.startPt.y;
    const o = drag.orig;
    const ar = aspectRatio();
    let next = { ...o };

    if (!drag.handle) {
      next.x = o.x + dx;
      next.y = o.y + dy;
    } else {
      const h = drag.handle;
      let w = o.w;
      let x = o.x;
      let y = o.y;
      if (h.includes('e')) w = o.w + dx;
      if (h.includes('w')) { w = o.w - dx; x = o.x + dx; }
      if (h.includes('s') && !h.includes('e') && !h.includes('w')) w = (o.h + dy) * ar;
      if (h.includes('n') && !h.includes('e') && !h.includes('w')) {
        w = (o.h - dy) * ar;
        y = o.y + dy;
      }
      if (w < 8) w = 8;
      const hh = w / ar;
      if (h.includes('w')) x = o.x + o.w - w;
      if (h.includes('n')) y = o.y + o.h - hh;
      next = { x, y, w, h: hh };
    }
    setBox(next);
  });

  function endDrag(e) {
    if (!drag) return;
    drag = null;
    try { boxEl.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    invalidateCropCache();
    scheduleLayout('both', { compare: true });
  }
  boxEl.addEventListener('pointerup', endDrag);
  boxEl.addEventListener('pointercancel', endDrag);

  stage.addEventListener('pointerdown', (e) => {
    const zz = ensureZoompan();
    const viewMode = side === 'start' ? zz.viewModeStart : zz.viewModeEnd;
    if (viewMode !== 'full') return;
    if (e.target !== stage && !e.target.classList?.contains('zp-full-img')) return;
    if (e.button != null && e.button !== 0) return;
    const b = getBox();
    if (!b) return;
    const pt = clientToImage(e.clientX, e.clientY);
    setBox({ x: pt.x - b.w / 2, y: pt.y - b.h / 2, w: b.w, h: b.h });
    scheduleLayout(side, { compare: true });
  });
}

function collectZoompanBody() {
  const z = ensureZoompan();
  const path = resolveZoompanImage();
  if (!path) {
    alert('Set a still image in the global Image bar (source to pan/zoom).');
    return null;
  }
  if (!isImagePath(path)) {
    alert('Zoompan source must be an image file.');
    return null;
  }
  ensureBoxes();
  if (!z.startBox || !z.endBox) {
    alert('Could not initialize viewports.');
    return null;
  }

  const durEl = document.getElementById('zpDuration');
  const fpsEl = document.getElementById('zpFps');
  if (durEl) z.durationSec = Math.min(600, Math.max(0.1, parseFloat(durEl.value) || 5));
  if (fpsEl) z.fps = Math.min(120, Math.max(1, parseFloat(fpsEl.value) || 24));

  return {
    input_path: path,
    start_box: { x: z.startBox.x, y: z.startBox.y, w: z.startBox.w, h: z.startBox.h },
    end_box: { x: z.endBox.x, y: z.endBox.y, w: z.endBox.w, h: z.endBox.h },
    duration_sec: z.durationSec,
    fps: z.fps,
    output_width: Math.round(z.startBox.w),
    output_height: Math.round(z.startBox.h),
    output_path: null,
    dry_run: false,
  };
}

export { renderZoompanForm, collectZoompanBody, ensureZoompan, resolveZoompanImage };
