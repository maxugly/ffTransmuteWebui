/**
 * Image compare — reusable dual-image viewer.
 *
 * Modes:
 *   separate — host decides layout (module only paints a single base image)
 *   overlay  — base + ref stacked; ref opacity 0–100
 *   ab       — wipe: left of handle = base, right = ref
 *
 * Pure UI helper. No Cut / pool / global-input knowledge.
 *
 * @example
 *   import {
 *     COMPARE_MODES, defaultCompareState, normalizeCompareState,
 *     compareToolbarHtml, paintCompareView, bindCompareControls,
 *   } from '/js/ui/image-compare.js';
 *
 *   const cmp = normalizeCompareState(host.compare);
 *   root.innerHTML = compareToolbarHtml({ idPrefix: 'my', state: cmp })
 *     + `<div class="img-compare-viewport" id="myView"></div>`;
 *   paintCompareView(document.getElementById('myView'), {
 *     mode: cmp.mode, baseSrc, refSrc, opacity: cmp.overlayOpacity, ab: cmp.abPosition,
 *   });
 *   bindCompareControls({
 *     idPrefix: 'my',
 *     getState: () => normalizeCompareState(host.compare),
 *     setState: (p) => Object.assign(host.compare, p),
 *     getViewports: () => [document.getElementById('myView')],
 *     onModeChange: () => reRender(),
 *   });
 */

import { escapeHtml } from '/js/utils.js';

export const COMPARE_MODES = Object.freeze(['separate', 'overlay', 'ab']);

const MODE_LABELS = {
  separate: '1 · Separate',
  overlay: '2 · Overlay',
  ab: '3 · A/B',
};

const MODE_TITLES = {
  separate: 'Show images separately',
  overlay: 'Stack ref on top of base; adjust transparency to align',
  ab: 'Wipe between base (left) and ref (right)',
};

/** @returns {{ mode: string, overlayOpacity: number, abPosition: number }} */
export function defaultCompareState() {
  return {
    mode: 'separate',
    overlayOpacity: 50,
    abPosition: 50,
  };
}

/**
 * Clamp / fill compare state in place (or on a copy if null).
 * Accepts legacy `compareMode` alias → writes `mode`.
 * @param {object|null|undefined} raw
 * @returns {{ mode: string, overlayOpacity: number, abPosition: number }}
 */
export function normalizeCompareState(raw) {
  const out = raw && typeof raw === 'object' ? raw : {};
  let mode = out.mode || out.compareMode || 'separate';
  if (!COMPARE_MODES.includes(mode)) mode = 'separate';
  out.mode = mode;
  // keep legacy key in sync when present on host objects
  if ('compareMode' in out || out.compareMode !== undefined) {
    out.compareMode = mode;
  }

  let op = parseInt(out.overlayOpacity, 10);
  if (!Number.isFinite(op)) op = 50;
  out.overlayOpacity = Math.min(100, Math.max(0, op));

  let ab = parseInt(out.abPosition, 10);
  if (!Number.isFinite(ab)) ab = 50;
  out.abPosition = Math.min(100, Math.max(0, ab));

  return out;
}

/**
 * Toolbar HTML: mode switch + opacity/wipe slider.
 * @param {{
 *   idPrefix: string,
 *   state: { mode: string, overlayOpacity: number, abPosition: number },
 *   label?: string,
 *   modeTitles?: Record<string, string>,
 *   className?: string,
 * }} opts
 */
export function compareToolbarHtml(opts) {
  const idPrefix = opts.idPrefix || 'cmp';
  const state = normalizeCompareState(opts.state || defaultCompareState());
  const label = opts.label != null ? opts.label : 'Compare';
  const titles = { ...MODE_TITLES, ...(opts.modeTitles || {}) };
  const mode = state.mode;
  const barClass = opts.className ? `img-compare-bar ${opts.className}` : 'img-compare-bar';

  const modeBtns = COMPARE_MODES.map((m) => {
    const active = mode === m ? ' active' : '';
    return (
      `<button type="button" class="img-compare-mode-btn${active}" data-mode="${m}" ` +
      `data-cmp-prefix="${escapeHtml(idPrefix)}" title="${escapeHtml(titles[m] || m)}">` +
      `${MODE_LABELS[m] || m}</button>`
    );
  }).join('');

  const sliderVal = mode === 'ab' ? state.abPosition : state.overlayOpacity;
  const sliderLabel = mode === 'ab' ? 'A/B wipe' : 'Ref opacity';

  return `
    <div class="${barClass}" data-cmp-bar="${escapeHtml(idPrefix)}">
      <label class="img-compare-bar-label">${escapeHtml(label)}</label>
      <div class="img-compare-mode-switch" role="group" aria-label="${escapeHtml(label)} mode">
        ${modeBtns}
      </div>
      <div class="img-compare-slider-row" id="${escapeHtml(idPrefix)}CompareSliderRow"
           ${mode === 'separate' ? 'hidden' : ''}>
        <span class="img-compare-slider-label" id="${escapeHtml(idPrefix)}CompareSliderLabel">
          ${escapeHtml(sliderLabel)}
        </span>
        <input type="range" class="img-compare-slider" id="${escapeHtml(idPrefix)}CompareSlider"
          min="0" max="100" value="${sliderVal}" aria-label="Compare amount"
          data-cmp-prefix="${escapeHtml(idPrefix)}">
        <span class="img-compare-slider-val" id="${escapeHtml(idPrefix)}CompareSliderVal">${sliderVal}%</span>
      </div>
    </div>
  `;
}

/**
 * Apply CSS variables for overlay / A/B on a viewport element.
 */
export function applyCompareVars(box, mode, opacity, ab) {
  if (!box) return;
  if (mode === 'overlay') {
    const o = Math.min(100, Math.max(0, parseInt(opacity, 10) || 0)) / 100;
    box.style.setProperty('--img-compare-opacity', String(o));
    box.style.removeProperty('--img-compare-ab-pct');
  } else if (mode === 'ab') {
    const p = Math.min(100, Math.max(0, parseInt(ab, 10) || 0));
    box.style.setProperty('--img-compare-ab-pct', `${p}%`);
    box.style.removeProperty('--img-compare-opacity');
  } else {
    box.style.removeProperty('--img-compare-opacity');
    box.style.removeProperty('--img-compare-ab-pct');
  }
}

/**
 * Sync toolbar active mode + slider from state (no re-render).
 * @param {string} idPrefix
 * @param {{ mode: string, overlayOpacity: number, abPosition: number }} state
 * @param {ParentNode} [root=document]
 */
export function syncCompareToolbar(idPrefix, state, root) {
  const doc = root || document;
  const s = normalizeCompareState(state);
  const mode = s.mode;

  doc.querySelectorAll(`.img-compare-mode-btn[data-cmp-prefix="${cssEscape(idPrefix)}"]`).forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-mode') === mode);
  });
  // also match buttons inside bar without relying only on attribute
  const bar = doc.querySelector(`[data-cmp-bar="${cssEscape(idPrefix)}"]`);
  if (bar) {
    bar.querySelectorAll('.img-compare-mode-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-mode') === mode);
    });
  }

  const sliderRow = doc.getElementById(`${idPrefix}CompareSliderRow`);
  const slider = doc.getElementById(`${idPrefix}CompareSlider`);
  const sliderLabel = doc.getElementById(`${idPrefix}CompareSliderLabel`);
  const sliderVal = doc.getElementById(`${idPrefix}CompareSliderVal`);
  if (!sliderRow || !slider) return;

  if (mode === 'separate') {
    sliderRow.hidden = true;
    return;
  }
  sliderRow.hidden = false;
  if (mode === 'overlay') {
    if (sliderLabel) sliderLabel.textContent = 'Ref opacity';
    slider.value = String(s.overlayOpacity);
    if (sliderVal) sliderVal.textContent = `${s.overlayOpacity}%`;
    slider.title = 'Reference transparency over the base (0 = base only, 100 = ref only)';
  } else {
    if (sliderLabel) sliderLabel.textContent = 'A/B wipe';
    slider.value = String(s.abPosition);
    if (sliderVal) sliderVal.textContent = `${s.abPosition}%`;
    slider.title = 'Wipe handle: left of line = base, right = reference';
  }
}

/**
 * Paint a single base image (separate mode / no ref).
 * @param {HTMLElement|null} box
 * @param {{ src?: string, key?: string|number, alt?: string, emptyMsg?: string, emptyClass?: string }} opts
 */
export function paintSimpleImage(box, opts) {
  if (!box) return;
  opts = opts || {};
  _clearCompareClasses(box);
  const emptyClass = opts.emptyClass || 'img-compare-empty';

  if (!opts.src) {
    box.innerHTML = `<div class="${emptyClass}">${escapeHtml(opts.emptyMsg || '…')}</div>`;
    return;
  }

  let img = box.querySelector('img.img-layer-base, img:not(.img-layer-ref)');
  if (!img || box.querySelector('.img-layer-ref') || box.querySelector('.img-compare-ab-handle')) {
    box.innerHTML = '';
    img = document.createElement('img');
    img.className = 'img-layer-base';
    img.alt = opts.alt || 'image';
    img.loading = 'lazy';
    img.addEventListener('error', () => img.classList.add('broken'));
    box.appendChild(img);
  }

  const key = opts.key != null ? String(opts.key) : '';
  const keyAttr = img.getAttribute('data-cmp-key');
  const srcChanged = img.getAttribute('data-src') !== opts.src;
  if (keyAttr !== key || srcChanged) {
    img.classList.remove('broken');
    if (key) img.setAttribute('data-cmp-key', key);
    else img.removeAttribute('data-cmp-key');
    img.setAttribute('data-src', opts.src);
    img.src = opts.src;
  }
}

/**
 * Paint dual-layer compare viewport (overlay or ab). For separate, use paintSimpleImage.
 *
 * @param {HTMLElement|null} box  element should be position:relative (see .img-compare-viewport)
 * @param {{
 *   mode: string,
 *   baseSrc?: string,
 *   baseKey?: string|number,
 *   refSrc?: string,
 *   opacity?: number,
 *   ab?: number,
 *   emptyMsg?: string,
 *   missingRefMsg?: string,
 *   baseLabel?: string,
 *   refLabel?: string,
 *   emptyClass?: string,
 * }} opts
 */
export function paintCompareView(box, opts) {
  if (!box) return;
  opts = opts || {};
  const mode = COMPARE_MODES.includes(opts.mode) ? opts.mode : 'separate';
  const emptyClass = opts.emptyClass || 'img-compare-empty';

  if (mode === 'separate') {
    paintSimpleImage(box, {
      src: opts.baseSrc,
      key: opts.baseKey,
      alt: opts.baseLabel || 'base',
      emptyMsg: opts.emptyMsg,
      emptyClass,
    });
    return;
  }

  if (!opts.baseSrc) {
    _clearCompareClasses(box);
    box.innerHTML = `<div class="${emptyClass}">${escapeHtml(opts.emptyMsg || '…')}</div>`;
    return;
  }

  const baseLabel = opts.baseLabel || 'Base';
  const refLabel = opts.refLabel || 'Ref';

  const needRebuild =
    !box.classList.contains('img-compare') ||
    (mode === 'overlay' && !box.classList.contains('mode-overlay')) ||
    (mode === 'ab' && !box.classList.contains('mode-ab')) ||
    (mode === 'overlay' && box.classList.contains('mode-ab')) ||
    (mode === 'ab' && box.classList.contains('mode-overlay'));

  box.classList.add('img-compare', 'img-compare-viewport');
  box.classList.toggle('mode-overlay', mode === 'overlay');
  box.classList.toggle('mode-ab', mode === 'ab');

  if (needRebuild) {
    box.innerHTML = `
      <img class="img-layer-base" alt="${escapeHtml(baseLabel)}" loading="lazy">
      <img class="img-layer-ref" alt="${escapeHtml(refLabel)}" loading="lazy">
      ${mode === 'ab'
        ? `<div class="img-compare-ab-handle" aria-hidden="true"></div>
           <div class="img-compare-ab-labels"><span>${escapeHtml(baseLabel)}</span><span>${escapeHtml(refLabel)}</span></div>`
        : ''}
      <div class="img-compare-hint" hidden></div>
    `;
    box.querySelectorAll('img').forEach((img) => {
      img.addEventListener('error', () => img.classList.add('broken'));
    });
  }

  const baseImg = box.querySelector('.img-layer-base');
  const refImg = box.querySelector('.img-layer-ref');
  const hint = box.querySelector('.img-compare-hint');

  if (baseImg) {
    const key = opts.baseKey != null ? String(opts.baseKey) : '';
    if (baseImg.getAttribute('data-cmp-key') !== key || baseImg.getAttribute('data-src') !== opts.baseSrc) {
      baseImg.classList.remove('broken');
      if (key) baseImg.setAttribute('data-cmp-key', key);
      baseImg.setAttribute('data-src', opts.baseSrc);
      baseImg.src = opts.baseSrc;
    }
  }

  if (refImg) {
    if (opts.refSrc) {
      refImg.hidden = false;
      if (refImg.getAttribute('data-src') !== opts.refSrc) {
        refImg.classList.remove('broken');
        refImg.setAttribute('data-src', opts.refSrc);
        refImg.src = opts.refSrc;
      }
    } else {
      refImg.hidden = true;
      refImg.removeAttribute('src');
      refImg.removeAttribute('data-src');
    }
  }

  if (hint) {
    if (!opts.refSrc) {
      hint.hidden = false;
      hint.textContent = opts.missingRefMsg || `Load ${refLabel} to compare`;
    } else {
      hint.hidden = true;
    }
  }

  applyCompareVars(box, mode, opts.opacity, opts.ab);
}

function _clearCompareClasses(box) {
  box.classList.remove('img-compare', 'mode-overlay', 'mode-ab');
  box.style.removeProperty('--img-compare-opacity');
  box.style.removeProperty('--img-compare-ab-pct');
}

/**
 * Wire mode buttons, slider, and optional A/B drag on viewports.
 *
 * @param {{
 *   idPrefix: string,
 *   getState: () => { mode?: string, compareMode?: string, overlayOpacity?: number, abPosition?: number },
 *   setState: (partial: { mode?: string, overlayOpacity?: number, abPosition?: number }) => void,
 *   getViewports: () => (HTMLElement|null)[],
 *   onModeChange?: (mode: string) => void,
 *   root?: ParentNode,
 * }} opts
 * @returns {{ destroy: () => void }}
 */
export function bindCompareControls(opts) {
  const idPrefix = opts.idPrefix || 'cmp';
  const root = opts.root || document;
  const listeners = [];

  function on(el, type, fn, capture) {
    if (!el) return;
    el.addEventListener(type, fn, capture);
    listeners.push(() => el.removeEventListener(type, fn, capture));
  }

  function read() {
    return normalizeCompareState(opts.getState());
  }

  function write(partial) {
    const next = { ...partial };
    if (next.mode != null) next.compareMode = next.mode;
    opts.setState(next);
  }

  function viewports() {
    return (opts.getViewports() || []).filter(Boolean);
  }

  function applyAll() {
    const s = read();
    viewports().forEach((box) => {
      if (box.classList.contains('img-compare')) {
        applyCompareVars(box, s.mode, s.overlayOpacity, s.abPosition);
      }
    });
    syncCompareToolbar(idPrefix, s, root);
  }

  const bar = root.querySelector(`[data-cmp-bar="${cssEscape(idPrefix)}"]`);
  const modeBtns = bar
    ? bar.querySelectorAll('.img-compare-mode-btn')
    : root.querySelectorAll(`.img-compare-mode-btn[data-cmp-prefix="${cssEscape(idPrefix)}"]`);

  modeBtns.forEach((btn) => {
    on(btn, 'click', () => {
      const next = btn.getAttribute('data-mode');
      if (!COMPARE_MODES.includes(next)) return;
      const cur = read();
      if (next === cur.mode) return;
      write({ mode: next });
      if (typeof opts.onModeChange === 'function') opts.onModeChange(next);
      else applyAll();
    });
  });

  const slider = root.getElementById
    ? root.getElementById(`${idPrefix}CompareSlider`)
    : document.getElementById(`${idPrefix}CompareSlider`);
  if (slider) {
    on(slider, 'input', () => {
      const s = read();
      const v = Math.min(100, Math.max(0, parseInt(slider.value, 10) || 0));
      if (s.mode === 'overlay') write({ overlayOpacity: v });
      else if (s.mode === 'ab') write({ abPosition: v });
      const valEl = document.getElementById(`${idPrefix}CompareSliderVal`);
      if (valEl) valEl.textContent = `${v}%`;
      const s2 = read();
      viewports().forEach((box) => {
        if (box.classList.contains('img-compare')) {
          applyCompareVars(box, s2.mode, s2.overlayOpacity, s2.abPosition);
        }
      });
    });
  }

  // A/B drag on each viewport
  viewports().forEach((box) => {
    let dragging = false;

    function setFromClientX(clientX) {
      const s = read();
      if (s.mode !== 'ab') return;
      const rect = box.getBoundingClientRect();
      if (rect.width <= 0) return;
      const pct = Math.round(((clientX - rect.left) / rect.width) * 100);
      const v = Math.min(100, Math.max(0, pct));
      write({ abPosition: v });
      const sl = document.getElementById(`${idPrefix}CompareSlider`);
      if (sl) sl.value = String(v);
      const valEl = document.getElementById(`${idPrefix}CompareSliderVal`);
      if (valEl) valEl.textContent = `${v}%`;
      viewports().forEach((b) => {
        if (b.classList.contains('img-compare')) {
          applyCompareVars(b, 'ab', s.overlayOpacity, v);
        }
      });
    }

    on(box, 'pointerdown', (e) => {
      const s = read();
      if (s.mode !== 'ab') return;
      if (e.button != null && e.button !== 0) return;
      dragging = true;
      try { box.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      setFromClientX(e.clientX);
      e.preventDefault();
    });
    on(box, 'pointermove', (e) => {
      if (!dragging) return;
      setFromClientX(e.clientX);
    });
    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      try { box.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    }
    on(box, 'pointerup', endDrag);
    on(box, 'pointercancel', endDrag);
  });

  // initial sync
  syncCompareToolbar(idPrefix, read(), root);

  return {
    destroy() {
      while (listeners.length) {
        try { listeners.pop()(); } catch (_) { /* ignore */ }
      }
    },
    applyAll,
  };
}

/** Safe enough for our id prefixes (alphanumeric). */
function cssEscape(s) {
  return String(s).replace(/["\\]/g, '\\$&');
}
