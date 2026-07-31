/**
 * Pan & Zoom (zoompan) — still → video between two viewports.
 *
 * Source: global Image bar.
 * Reference (optional): second still for scene-match alignment (Image Pool / Browse).
 *
 * Zoomed Out  = full source + draggable AR-locked box
 * Zoomed In   = **exactly** the box contents (canvas crop from full /api/image)
 *
 * Compare (image-compare toolbar state):
 *   separate — edit Start/Last (+ show Ref card)
 *   overlay / A/B — stack crop vs reference (or Start vs Last if no ref)
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

/** @type {{ destroy: () => void } | null} */
let _compareCtl = null;
let _imgListenersBound = false;
let _imgRefreshTimer = null;
let _resizeBound = false;

/** Full-res source & ref images for accurate crops */
const _srcImg = new Image();
const _refImg = new Image();
_srcImg.decoding = 'async';
_refImg.decoding = 'async';
let _srcLoadGen = 0;
let _refLoadGen = 0;

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

function loadFullImage(imgEl, path) {
  return new Promise((resolve, reject) => {
    if (!path) {
      imgEl.removeAttribute('src');
      resolve(false);
      return;
    }
    const url = fullImageUrl(path);
    if (imgEl.src && imgEl.complete && imgEl.naturalWidth && imgEl.dataset.path === path) {
      resolve(true);
      return;
    }
    const onLoad = () => {
      imgEl.removeEventListener('error', onErr);
      imgEl.dataset.path = path;
      resolve(true);
    };
    const onErr = () => {
      imgEl.removeEventListener('load', onLoad);
      reject(new Error('Failed to load ' + path));
    };
    imgEl.addEventListener('load', onLoad, { once: true });
    imgEl.addEventListener('error', onErr, { once: true });
    imgEl.src = url;
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
        }
      }
      await loadFullImage(_srcImg, path);
    } catch (err) {
      logConsole(`[ZOOMPAN]: source load failed — ${err.message}`, 'error');
    }
  } else {
    z.imageW = 0;
    z.imageH = 0;
    z.startBox = null;
    z.endBox = null;
    z._loadedPath = null;
    _srcImg.removeAttribute('src');
    delete _srcImg.dataset.path;
  }

  if (z.refPath) {
    try {
      await loadFullImage(_refImg, z.refPath);
    } catch (err) {
      logConsole(`[ZOOMPAN]: ref load failed — ${err.message}`, 'error');
    }
  } else {
    _refImg.removeAttribute('src');
    delete _refImg.dataset.path;
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
    _refreshAllLayouts();
  });

  document.querySelectorAll('.zp-view-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const side = btn.getAttribute('data-side');
      const mode = btn.getAttribute('data-mode');
      if (side === 'start') z.viewModeStart = mode;
      else z.viewModeEnd = mode;
      // avoid full re-render: update buttons + layout
      document.querySelectorAll(`.zp-view-btn[data-side="${side}"]`).forEach((b) => {
        b.classList.toggle('active', b.getAttribute('data-mode') === mode);
      });
      const vp = document.getElementById(side === 'start' ? 'zpViewStart' : 'zpViewEnd');
      if (vp) vp.setAttribute('data-view', mode);
      _layoutSide(side);
      _refreshCompareHost();
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
      _layoutSide(side);
      _refreshCompareHost();
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
      // live switch without full re-probe
      _refreshAllLayouts();
    },
  });

  // When opacity/ab changes, also refresh custom ref layers
  const slider = document.getElementById(`${ZP_COMPARE_PREFIX}CompareSlider`);
  if (slider && !slider.dataset.zpExtra) {
    slider.dataset.zpExtra = '1';
    slider.addEventListener('input', () => {
      _layoutSide('start');
      _layoutSide('end');
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
 * Draw box region of full-res source onto canvas, filling the stage (contain).
 */
function _drawExactCrop(canvas, box) {
  const z = ensureZoompan();
  if (!canvas || !box || !_srcImg.naturalWidth || !z.imageW) return false;
  const stage = canvas.parentElement;
  if (!stage) return false;
  const sw = stage.clientWidth;
  const sh = stage.clientHeight;
  if (sw < 2 || sh < 2) return false;

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(sw * dpr);
  canvas.height = Math.round(sh * dpr);
  canvas.style.width = `${sw}px`;
  canvas.style.height = `${sh}px`;

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, sw, sh);
  ctx.fillStyle = '#0a0e16';
  ctx.fillRect(0, 0, sw, sh);

  // Source crop in full-image pixels (probe size). Map onto natural if mismatch.
  const nw = _srcImg.naturalWidth;
  const nh = _srcImg.naturalHeight;
  const sx = (box.x / z.imageW) * nw;
  const sy = (box.y / z.imageH) * nh;
  const sww = (box.w / z.imageW) * nw;
  const shh = (box.h / z.imageH) * nh;

  // Contain crop into stage
  const scale = Math.min(sw / box.w, sh / box.h);
  const dw = box.w * scale;
  const dh = box.h * scale;
  const dx = (sw - dw) / 2;
  const dy = (sh - dh) / 2;

  try {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(_srcImg, sx, sy, sww, shh, dx, dy, dw, dh);
    return true;
  } catch (_) {
    return false;
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
  stage.classList.toggle('has-ref-overlay', false);

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
      // Prefer full image for accurate box mapping once loaded
      const prefer = (_srcImg.complete && _srcImg.naturalWidth)
        ? fullImageUrl(z.imagePath)
        : thumbUrl(z.imagePath);
      if (fullImg.dataset.src !== prefer) {
        fullImg.dataset.src = prefer;
        fullImg.src = prefer;
      }
      fullImg.style.cssText = 'width:100%;height:100%;object-fit:contain;object-position:center;display:block;';
    }
    if (boxEl && box && fullImg) {
      const place = () => {
        boxEl.hidden = false;
        const r = _imageContentRect(stage, fullImg);
        if (!r || r.dw < 1) return;
        boxEl.style.left = `${r.ox + (box.x / z.imageW) * r.dw}px`;
        boxEl.style.top = `${r.oy + (box.y / z.imageH) * r.dh}px`;
        boxEl.style.width = `${(box.w / z.imageW) * r.dw}px`;
        boxEl.style.height = `${(box.h / z.imageH) * r.dh}px`;
      };
      if (fullImg.complete && fullImg.naturalWidth) place();
      else fullImg.onload = place;
    }
    return;
  }

  // ── Zoomed In: exact box contents ─────────────────────────────────────
  if (fullImg) fullImg.hidden = true;
  if (boxEl) boxEl.hidden = true;
  if (canvas) {
    canvas.hidden = false;
    _drawExactCrop(canvas, box);
  }

  const useRef = _sideUsesRefOverlay(side) && _refImg.complete && _refImg.naturalWidth;
  if (refLayer) {
    if (useRef) {
      stage.classList.add('has-ref-overlay');
      refLayer.hidden = false;
      if (refLayer.dataset.path !== z.refPath) {
        refLayer.dataset.path = z.refPath;
        refLayer.src = fullImageUrl(z.refPath);
      }
      refLayer.classList.toggle('mode-overlay', mode === 'overlay');
      refLayer.classList.toggle('mode-ab', mode === 'ab');
      if (mode === 'overlay') {
        const o = Math.min(100, Math.max(0, z.overlayOpacity)) / 100;
        refLayer.style.opacity = String(o);
        refLayer.style.clipPath = '';
      } else if (mode === 'ab') {
        refLayer.style.opacity = '1';
        const p = Math.min(100, Math.max(0, z.abPosition));
        refLayer.style.clipPath = `inset(0 0 0 ${p}%)`;
      }
    } else {
      refLayer.hidden = true;
      refLayer.style.opacity = '';
      refLayer.style.clipPath = '';
    }
  }
  if (abHandle) {
    if (useRef && mode === 'ab') {
      abHandle.hidden = false;
      abHandle.style.left = `${Math.min(100, Math.max(0, z.abPosition))}%`;
    } else {
      abHandle.hidden = true;
    }
  }
  if (labels) {
    labels.hidden = !(useRef && mode === 'ab');
  }

  // A/B drag on zoomed stage when ref overlay
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
  z.abPosition = v;
  const slider = document.getElementById(`${ZP_COMPARE_PREFIX}CompareSlider`);
  if (slider) slider.value = String(v);
  const valEl = document.getElementById(`${ZP_COMPARE_PREFIX}CompareSliderVal`);
  if (valEl) valEl.textContent = `${v}%`;
  _layoutSide('start');
  _layoutSide('end');
  _refreshCompareHost();
}

function _refreshAllLayouts() {
  _layoutSide('start');
  _layoutSide('end');
  _refreshCompareHost();
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

  const nw = _srcImg.naturalWidth;
  const nh = _srcImg.naturalHeight;
  const sx = (box.x / z.imageW) * nw;
  const sy = (box.y / z.imageH) * nh;
  const sw = (box.w / z.imageW) * nw;
  const sh = (box.h / z.imageH) * nh;

  const maxSide = 720;
  const sc = Math.min(1, maxSide / Math.max(box.w, box.h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(2, Math.round(box.w * sc));
  canvas.height = Math.max(2, Math.round(box.h * sc));
  const ctx = canvas.getContext('2d');
  try {
    ctx.drawImage(_srcImg, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.9);
  } catch (_) {
    return '';
  }
}

async function _paintAllViewports() {
  const z = ensureZoompan();
  // Ensure full imgs get a source for full mode
  for (const side of ['start', 'end']) {
    _bindBoxInteraction(side);
    _layoutSide(side);
  }
  _refreshCompareHost();

  if (!_resizeBound) {
    _resizeBound = true;
    window.addEventListener('resize', () => {
      if (state.activeTab !== 'zoompan') return;
      _refreshAllLayouts();
    });
  }
  requestAnimationFrame(() => _refreshAllLayouts());
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
    _layoutSide(side);
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
    // Re-layout zoomed peers + compare (exact crop updates)
    _layoutSide(side === 'start' ? 'end' : 'start');
    _refreshCompareHost();
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
    _refreshCompareHost();
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
