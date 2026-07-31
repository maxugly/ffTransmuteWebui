/**
 * Pan & Zoom (zoompan) — still image → video between two viewports.
 *
 * Source: global Image bar (window.globalInputs.image).
 * Compare: shared js/ui/image-compare.js (Start vs Last).
 * Boxes: draggable/resizable, aspect-locked; Full vs Zoomed toggle per side.
 *
 * Spec: docs/zoompan-spec.md
 */
import {
  state, elements, logConsole, showPreview, resolveGlobalImage,
} from '/app.js';
import { escapeHtml, basename, isImagePath } from '/js/utils.js';
import {
  defaultCompareState,
  normalizeCompareState,
  compareToolbarHtml,
  paintCompareView,
  bindCompareControls,
} from '/js/ui/image-compare.js';

const ASPECTS = {
  '16:9': 16 / 9,
  '9:16': 9 / 16,
  '4:3': 4 / 3,
  '1:1': 1,
  '21:9': 21 / 9,
};

const ZP_COMPARE_PREFIX = 'zp';

/** @type {{ destroy: () => void } | null} */
let _compareCtl = null;
let _imgListenersBound = false;
let _imgRefreshTimer = null;
/** @type {WeakMap<HTMLElement, object>} */
const _boxDrag = new WeakMap();

function ensureZoompan() {
  if (!state.zoompan) {
    state.zoompan = {
      imagePath: null,
      imageW: 0,
      imageH: 0,
      startBox: null,
      endBox: null,
      durationSec: 5,
      fps: 24,
      aspect: '16:9',
      viewModeStart: 'full', // full | zoomed
      viewModeEnd: 'full',
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

function aspectRatio() {
  return ASPECTS[ensureZoompan().aspect] || (16 / 9);
}

/** Max-area AR-locked box centered in image. */
function maxAreaBox(iw, ih, ar) {
  let w = iw;
  let h = w / ar;
  if (h > ih) {
    h = ih;
    w = h * ar;
  }
  const x = (iw - w) / 2;
  const y = (ih - h) / 2;
  return clampBox({ x, y, w, h }, iw, ih);
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
  let x = box.x;
  let y = box.y;
  if (x < 0) x = 0;
  if (y < 0) y = 0;
  if (x + w > iw) x = Math.max(0, iw - w);
  if (y + h > ih) y = Math.max(0, ih - h);
  return { x, y, w, h };
}

function ensureBoxes() {
  const z = ensureZoompan();
  if (!z.imageW || !z.imageH) return;
  if (!z.startBox) {
    z.startBox = maxAreaBox(z.imageW, z.imageH, aspectRatio());
  } else {
    z.startBox = clampBox(z.startBox, z.imageW, z.imageH);
  }
  if (!z.endBox) {
    z.endBox = scaleBoxFrom(z.startBox, 0.45, z.imageW, z.imageH);
  } else {
    z.endBox = clampBox(z.endBox, z.imageW, z.imageH);
  }
}

function loadImageMeta(path) {
  return new Promise((resolve, reject) => {
    if (!path) {
      resolve(null);
      return;
    }
    const img = new Image();
    img.onload = () => resolve({
      w: img.naturalWidth || img.width,
      h: img.naturalHeight || img.height,
    });
    img.onerror = () => reject(new Error('Failed to load image for sizing'));
    // cache-bust path for local API thumbnails not needed — file:// won't work;
    // browser loads via /api if we use thumbnail, but natural size needs the file.
    // Server serves files only through media; use thumbnail endpoint? Better: direct
    // path won't load (security). Use /api/thumbnail?which=first which is same aspect.
    // For true pixel coords we need real dimensions — probe via fetch or thumbnail
    // with known size from Image after loading through API.
    img.src = `/api/thumbnail?path=${encodeURIComponent(path)}&which=first&_=${Date.now()}`;
  });
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
  } catch (_) { /* fall through */ }
  return loadImageMeta(path);
}

function thumbUrl(path) {
  return `/api/thumbnail?path=${encodeURIComponent(path)}&which=first&_t=${encodeURIComponent(path)}`;
}

function _bindGlobalImageListener() {
  if (_imgListenersBound) return;
  _imgListenersBound = true;
  const gi = document.getElementById('giImage');
  if (!gi) return;
  const onImg = () => {
    if (state.activeTab !== 'zoompan') return;
    if (_imgRefreshTimer) clearTimeout(_imgRefreshTimer);
    _imgRefreshTimer = setTimeout(() => {
      _imgRefreshTimer = null;
      renderZoompanForm();
    }, 200);
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
  return `
    <div class="zp-card" data-side="${side}">
      <div class="zp-card-head">
        <div class="zp-card-title">${escapeHtml(label)}</div>
        <div class="zp-view-toggle" role="group" aria-label="${escapeHtml(label)} view mode">
          <button type="button" class="zp-view-btn${fullActive}" data-side="${side}" data-mode="full"
            title="Full image with viewport box">Zoomed Out</button>
          <button type="button" class="zp-view-btn${zoomActive}" data-side="${side}" data-mode="zoomed"
            title="Only the box contents (output frame)">Zoomed In</button>
        </div>
      </div>
      <div class="zp-viewport img-compare-viewport" id="zpView${side === 'start' ? 'Start' : 'End'}"
           data-side="${side}" data-view="${viewMode}">
        <div class="zp-stage" id="zpStage${side === 'start' ? 'Start' : 'End'}">
          <img class="zp-img" alt="${escapeHtml(label)}" draggable="false">
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
          <div class="zp-empty" hidden>Set global Image</div>
        </div>
      </div>
      ${boxInputsHtml(side, box)}
    </div>
  `;
}

async function renderZoompanForm() {
  _bindGlobalImageListener();
  if (_compareCtl) {
    try { _compareCtl.destroy(); } catch (_) { /* ignore */ }
    _compareCtl = null;
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
          // Reset boxes when image changes
          z.startBox = null;
          z.endBox = null;
        }
      }
    } catch (err) {
      logConsole(`[ZOOMPAN]: size probe failed — ${err.message}`, 'error');
    }
  } else {
    z.imageW = 0;
    z.imageH = 0;
    z.startBox = null;
    z.endBox = null;
    z._loadedPath = null;
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
      separate: 'Edit Start and Last side by side',
      overlay: 'Stack Last over Start (alignment check)',
      ab: 'Wipe between Start and Last',
    },
  });

  const gridClass = mode === 'separate'
    ? 'zp-frames-grid'
    : 'zp-frames-grid zp-frames-grid-compare';

  const html = `
    <div class="zp-workspace">
      <div class="panel-title-desc">
        <h3>Pan &amp; Zoom</h3>
        <p>
          Animate a pan/zoom between two viewports on a single still.
          Source is the global <strong>Image</strong> bar (same pattern as Cut + Video).
          Draw boxes on Start and Last, set duration/FPS, Run.
        </p>
      </div>

      <div class="zp-source-row">
        <label class="zp-field-label">Image (from global)</label>
        <div class="zp-global-path" id="zpImagePath" title="${escapeHtml(path || '')}">
          ${escapeHtml(path || '— set Image in the global bar above —')}
        </div>
        <div class="zp-meta-line">
          <span id="zpImageMeta">
            ${path && z.imageW
              ? `${z.imageW}×${z.imageH}px`
              : (path ? 'probing…' : 'no image')}
          </span>
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

      ${toolbar}

      <div class="${gridClass}" id="zpFramesGrid">
        ${viewportCardHtml('start', 'Start Frame', z.viewModeStart)}
        ${viewportCardHtml('end', 'Last Frame', z.viewModeEnd)}
      </div>

      <div class="zp-compare-host" id="zpCompareHost" ${mode === 'separate' ? 'hidden' : ''}>
        <div class="zp-card-title">Compare preview (Start vs Last · zoomed crops)</div>
        <div class="zp-viewport img-compare-viewport" id="zpCompareView"></div>
      </div>

      <div class="zp-footer-hint">
        <p>
          <strong>Zoomed Out</strong> — full image + draggable box (aspect locked).
          <strong>Zoomed In</strong> — box contents as the output frame.
          Compare uses the shared image-compare module.
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
      // Re-lock both boxes to new AR around center
      z.startBox = z.startBox
        ? clampBox({ ...z.startBox, h: z.startBox.w / aspectRatio() }, z.imageW, z.imageH)
        : maxAreaBox(z.imageW, z.imageH, aspectRatio());
      z.endBox = z.endBox
        ? clampBox({ ...z.endBox, h: z.endBox.w / aspectRatio() }, z.imageW, z.imageH)
        : scaleBoxFrom(z.startBox, 0.45, z.imageW, z.imageH);
    }
    renderZoompanForm();
  });

  document.querySelectorAll('.zp-view-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const side = btn.getAttribute('data-side');
      const mode = btn.getAttribute('data-mode');
      if (side === 'start') z.viewModeStart = mode;
      else z.viewModeEnd = mode;
      renderZoompanForm();
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
      _layoutBox(side);
      _refreshComparePreview();
    };
    ['X', 'Y', 'W'].forEach((k) => {
      document.getElementById(`${pre}${k}`)?.addEventListener('change', commit);
    });
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
    getViewports: () => [document.getElementById('zpCompareView')],
    onModeChange: () => renderZoompanForm(),
  });
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

/**
 * Map image pixel box → CSS % relative to the contained image rect inside stage.
 */
function _imageContentRect(stage, img) {
  if (!stage || !img) return null;
  const sw = stage.clientWidth;
  const sh = stage.clientHeight;
  const nw = img.naturalWidth || 1;
  const nh = img.naturalHeight || 1;
  const scale = Math.min(sw / nw, sh / nh);
  const dw = nw * scale;
  const dh = nh * scale;
  const ox = (sw - dw) / 2;
  const oy = (sh - dh) / 2;
  return { ox, oy, dw, dh, sw, sh, scale, nw, nh };
}

function _layoutBox(side) {
  const z = ensureZoompan();
  const viewMode = side === 'start' ? z.viewModeStart : z.viewModeEnd;
  const stage = document.getElementById(side === 'start' ? 'zpStageStart' : 'zpStageEnd');
  if (!stage) return;
  const img = stage.querySelector('.zp-img');
  const boxEl = stage.querySelector('.zp-box');
  const empty = stage.querySelector('.zp-empty');
  const box = side === 'start' ? z.startBox : z.endBox;

  if (!z.imagePath || !z.imageW) {
    if (img) img.hidden = true;
    if (boxEl) boxEl.hidden = true;
    if (empty) { empty.hidden = false; empty.textContent = 'Set global Image'; }
    return;
  }
  if (empty) empty.hidden = true;
  if (img) img.hidden = false;

  if (viewMode === 'zoomed') {
    if (boxEl) boxEl.hidden = true;
    // object-fit via CSS zoom crop — use object-position + scale trick on img
    _applyZoomedImg(img, box, z.imageW, z.imageH);
    return;
  }

  // Full image + box overlay
  if (img) {
    img.style.width = '100%';
    img.style.height = '100%';
    img.style.objectFit = 'contain';
    img.style.objectPosition = 'center';
    img.style.transform = '';
  }
  if (!boxEl || !box || !img) return;
  boxEl.hidden = false;

  const r = _imageContentRect(stage, img);
  if (!r || r.dw < 1) return;
  const left = r.ox + (box.x / z.imageW) * r.dw;
  const top = r.oy + (box.y / z.imageH) * r.dh;
  const width = (box.w / z.imageW) * r.dw;
  const height = (box.h / z.imageH) * r.dh;
  boxEl.style.left = `${left}px`;
  boxEl.style.top = `${top}px`;
  boxEl.style.width = `${width}px`;
  boxEl.style.height = `${height}px`;
}

function _applyZoomedImg(img, box, iw, ih) {
  if (!img || !box || !iw || !ih) return;
  // Show only the box region using object-fit: none + positioning
  // Easier: use a wrapper clip. Stage already overflows hidden.
  // Scale so box.w maps to stage width.
  img.style.objectFit = 'none';
  img.style.objectPosition = '0 0';
  img.style.width = 'auto';
  img.style.height = 'auto';
  img.style.maxWidth = 'none';
  img.style.maxHeight = 'none';

  const stage = img.parentElement;
  if (!stage) return;
  const sw = stage.clientWidth;
  const sh = stage.clientHeight;
  if (sw < 1 || sh < 1) return;

  const scale = Math.min(sw / box.w, sh / box.h);
  const dw = iw * scale;
  const dh = ih * scale;
  img.style.width = `${dw}px`;
  img.style.height = `${dh}px`;
  const ox = (sw - box.w * scale) / 2 - box.x * scale;
  const oy = (sh - box.h * scale) / 2 - box.y * scale;
  img.style.transform = `translate(${ox}px, ${oy}px)`;
}

async function _paintAllViewports() {
  const z = ensureZoompan();
  const path = z.imagePath;
  const src = path ? thumbUrl(path) : '';

  for (const side of ['start', 'end']) {
    const stage = document.getElementById(side === 'start' ? 'zpStageStart' : 'zpStageEnd');
    if (!stage) continue;
    const img = stage.querySelector('.zp-img');
    if (img && src) {
      await new Promise((resolve) => {
        const done = () => { img.removeEventListener('load', done); resolve(); };
        img.addEventListener('load', done);
        img.src = src;
        if (img.complete) done();
      });
    }
    _layoutBox(side);
    _bindBoxInteraction(side);
  }

  // reflow boxes after layout
  requestAnimationFrame(() => {
    _layoutBox('start');
    _layoutBox('end');
    _refreshComparePreview();
  });

  window.addEventListener('resize', _onResizeBoxes);
}

function _onResizeBoxes() {
  if (state.activeTab !== 'zoompan') return;
  _layoutBox('start');
  _layoutBox('end');
}

function _bindBoxInteraction(side) {
  const z = ensureZoompan();
  const stage = document.getElementById(side === 'start' ? 'zpStageStart' : 'zpStageEnd');
  if (!stage) return;
  const boxEl = stage.querySelector('.zp-box');
  const img = stage.querySelector('.zp-img');
  if (!boxEl || !img) return;

  // avoid double-binding
  if (boxEl.dataset.bound === '1') return;
  boxEl.dataset.bound = '1';

  let drag = null;

  function getBox() {
    return side === 'start' ? z.startBox : z.endBox;
  }
  function setBox(b) {
    const c = clampBox(b, z.imageW, z.imageH);
    if (side === 'start') z.startBox = c;
    else z.endBox = c;
    _syncBoxInputs(side);
    _layoutBox(side);
  }

  function clientToImage(clientX, clientY) {
    const r = _imageContentRect(stage, img);
    if (!r) return { x: 0, y: 0 };
    const rect = stage.getBoundingClientRect();
    const lx = clientX - rect.left;
    const ly = clientY - rect.top;
    const ix = ((lx - r.ox) / r.dw) * z.imageW;
    const iy = ((ly - r.oy) / r.dh) * z.imageH;
    return { x: ix, y: iy };
  }

  boxEl.addEventListener('pointerdown', (e) => {
    const viewMode = side === 'start' ? z.viewModeStart : z.viewModeEnd;
    if (viewMode !== 'full') return;
    if (e.button != null && e.button !== 0) return;
    const handle = e.target?.getAttribute?.('data-h') || null;
    const b = getBox();
    if (!b) return;
    const pt = clientToImage(e.clientX, e.clientY);
    drag = {
      handle,
      startPt: pt,
      orig: { ...b },
    };
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
      // move
      next.x = o.x + dx;
      next.y = o.y + dy;
    } else {
      const h = drag.handle;
      // resize from edges/corners; keep AR via width
      let w = o.w;
      let x = o.x;
      let y = o.y;
      if (h.includes('e')) w = o.w + dx;
      if (h.includes('w')) { w = o.w - dx; x = o.x + dx; }
      if (h.includes('s') && !h.includes('e') && !h.includes('w')) {
        // pure south: grow height, convert to width via AR
        const nh = o.h + dy;
        w = nh * ar;
      }
      if (h.includes('n') && !h.includes('e') && !h.includes('w')) {
        const nh = o.h - dy;
        w = nh * ar;
        y = o.y + dy;
      }
      // corners already adjust w; recompute h from AR
      if (w < 8) w = 8;
      const hh = w / ar;
      // anchor opposite corner when resizing from n/w
      if (h.includes('w')) x = o.x + o.w - w;
      if (h.includes('n')) y = o.y + o.h - hh;
      if (h.includes('e') || h.includes('s') || h.includes('w') || h.includes('n')) {
        next = { x, y, w, h: hh };
      }
    }
    setBox(next);
  });

  function endDrag(e) {
    if (!drag) return;
    drag = null;
    try { boxEl.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    _refreshComparePreview();
  }
  boxEl.addEventListener('pointerup', endDrag);
  boxEl.addEventListener('pointercancel', endDrag);

  // Click-drag on empty stage to reposition box center (optional)
  stage.addEventListener('pointerdown', (e) => {
    const viewMode = side === 'start' ? z.viewModeStart : z.viewModeEnd;
    if (viewMode !== 'full') return;
    if (e.target !== stage && e.target !== img) return;
    if (e.button != null && e.button !== 0) return;
    const b = getBox();
    if (!b) return;
    const pt = clientToImage(e.clientX, e.clientY);
    setBox({
      x: pt.x - b.w / 2,
      y: pt.y - b.h / 2,
      w: b.w,
      h: b.h,
    });
    _refreshComparePreview();
  });
}

/**
 * Draw zoomed crop of box to a canvas data URL for image-compare.
 */
function _cropDataUrl(side) {
  const z = ensureZoompan();
  const box = side === 'start' ? z.startBox : z.endBox;
  const stage = document.getElementById(side === 'start' ? 'zpStageStart' : 'zpStageEnd');
  const img = stage?.querySelector('.zp-img');
  if (!img || !box || !img.naturalWidth) return '';

  // Thumbnail may not match full pixel size — map box fractionally
  const nw = img.naturalWidth;
  const nh = img.naturalHeight;
  const sx = (box.x / z.imageW) * nw;
  const sy = (box.y / z.imageH) * nh;
  const sw = (box.w / z.imageW) * nw;
  const sh = (box.h / z.imageH) * nh;

  const canvas = document.createElement('canvas');
  const outW = Math.max(2, Math.round(box.w));
  const outH = Math.max(2, Math.round(box.h));
  // Cap canvas size for UI
  const maxSide = 640;
  const sc = Math.min(1, maxSide / Math.max(outW, outH));
  canvas.width = Math.max(2, Math.round(outW * sc));
  canvas.height = Math.max(2, Math.round(outH * sc));
  const ctx = canvas.getContext('2d');
  try {
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  } catch (_) {
    return '';
  }
  try {
    return canvas.toDataURL('image/jpeg', 0.85);
  } catch (_) {
    return '';
  }
}

function _refreshComparePreview() {
  const z = ensureZoompan();
  const mode = z.mode || 'separate';
  const host = document.getElementById('zpCompareHost');
  const view = document.getElementById('zpCompareView');
  if (!host || !view) return;
  if (mode === 'separate') {
    host.hidden = true;
    return;
  }
  host.hidden = false;
  const baseSrc = _cropDataUrl('start');
  const refSrc = _cropDataUrl('end');
  paintCompareView(view, {
    mode,
    baseSrc,
    baseKey: 'start',
    refSrc,
    opacity: z.overlayOpacity,
    ab: z.abPosition,
    baseLabel: 'Start',
    refLabel: 'Last',
    emptyMsg: 'Need image + boxes',
    missingRefMsg: 'Need Last box',
    emptyClass: 'zp-empty-msg',
  });
}

/**
 * Body for POST /ops/zoompan (also used by job-control).
 */
function collectZoompanBody() {
  const z = ensureZoompan();
  const path = resolveZoompanImage();
  if (!path) {
    alert('Set a still image in the global Image bar.');
    return null;
  }
  if (!isImagePath(path)) {
    alert('Zoompan needs an image file (PNG/JPG/WebP/…).');
    return null;
  }
  ensureBoxes();
  if (!z.startBox || !z.endBox) {
    alert('Could not initialize viewports — is the image readable?');
    return null;
  }

  const durEl = document.getElementById('zpDuration');
  const fpsEl = document.getElementById('zpFps');
  if (durEl) z.durationSec = Math.min(600, Math.max(0.1, parseFloat(durEl.value) || 5));
  if (fpsEl) z.fps = Math.min(120, Math.max(1, parseFloat(fpsEl.value) || 24));

  const outW = Math.round(z.startBox.w);
  const outH = Math.round(z.startBox.h);

  return {
    input_path: path,
    start_box: {
      x: z.startBox.x,
      y: z.startBox.y,
      w: z.startBox.w,
      h: z.startBox.h,
    },
    end_box: {
      x: z.endBox.x,
      y: z.endBox.y,
      w: z.endBox.w,
      h: z.endBox.h,
    },
    duration_sec: z.durationSec,
    fps: z.fps,
    output_width: outW,
    output_height: outH,
    output_path: null,
    dry_run: false,
  };
}

export { renderZoompanForm, collectZoompanBody, ensureZoompan, resolveZoompanImage };
