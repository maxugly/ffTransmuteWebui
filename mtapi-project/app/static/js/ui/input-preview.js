/**
 * Bottom-of-panel input media preview.
 *
 * Shows the image/video path(s) the active tab will actually use, after all
 * form chrome (knobs, tool-docs, …). Dual inputs (style + content, A + B)
 * render side by side.
 *
 * Lives outside #actionPanelForm so tab re-renders do not wipe it.
 */
import {
  state, bestInput, resolveGlobalImages, resolveGlobalImage, showPreview,
} from '/app.js';
import { basename, escapeHtml, isVideoPath, isImagePath } from '/js/utils.js';

const HIDE_TABS = new Set([
  'pool', 'sequence', 'images', 'jobs', 'notes', 'watcher', 'txt2img',
]);

/** @typedef {{ label: string, path: string|null }} InputSlot */

function _field(id) {
  const el = document.getElementById(id);
  return el ? String(el.value || '').trim() : '';
}

function _firstLine(s) {
  return String(s || '').split('\n').map((l) => l.trim()).filter(Boolean)[0] || '';
}

function _globalVideo() {
  return _firstLine((window.globalInputs || {}).video || '');
}

function _globalImage() {
  try {
    const p = typeof resolveGlobalImage === 'function' ? resolveGlobalImage() : null;
    if (p) return String(p).trim();
  } catch (_) { /* ignore */ }
  return _firstLine((window.globalInputs || {}).image || '');
}

function _pick(localId) {
  if (localId) {
    const local = _field(localId);
    if (local) return local;
  }
  try {
    const b = typeof bestInput === 'function' ? bestInput(localId || undefined) : '';
    if (b) return String(b).trim();
  } catch (_) { /* ignore */ }
  return _globalVideo() || _globalImage() || '';
}

/**
 * Resolve the media slot(s) the active tab will use.
 * @param {string} [tab]
 * @returns {InputSlot[]}
 */
function resolveInputSlots(tab) {
  const t = tab || state.activeTab || '';
  if (HIDE_TABS.has(t)) return [];

  switch (t) {
    case 'mosh': {
      const slots = [{ label: 'Input', path: _pick('moshInput') || null }];
      // Hijack inject still (when present)
      const inject = _field('hijackImagePath');
      if (inject) slots.push({ label: 'Inject', path: inject });
      return slots;
    }

    case 'transmute':
      return [{ label: 'Input', path: _pick('transmuteInput') || null }];

    case 'multi': {
      const clips = state.multiClips || [];
      if (!clips.length) return [{ label: 'Clips', path: null }];
      // Show first two (stitch/grid starts with pair)
      return clips.slice(0, 2).map((p, i) => ({
        label: clips.length > 2 ? `Clip ${i + 1}/${clips.length}` : `Clip ${i + 1}`,
        path: p || null,
      }));
    }

    case 'deepdream': {
      const input = _pick('dreamInput') || null;
      const guide = _field('dreamGuide') || null;
      const slots = [{ label: 'Input', path: input }];
      if (guide) slots.push({ label: 'Guide', path: guide });
      return slots;
    }

    case 'facemorph': {
      const imgs = state.faceMorph?.images || [];
      if (!imgs.length) return [{ label: 'Faces', path: null }];
      const sel = state.faceMorph.selected | 0;
      const a = imgs[sel] || imgs[0];
      const b = imgs[sel + 1] || (imgs.length > 1 ? imgs[(sel + 1) % imgs.length] : null);
      const slots = [{ label: imgs.length > 1 ? 'Face A' : 'Face', path: a?.path || null }];
      if (b && b.path !== a?.path) slots.push({ label: 'Face B', path: b.path });
      return slots;
    }

    case 'withoutbg': {
      const imgs = state.withoutbg?.images || [];
      const sel = state.withoutbg?.selected | 0;
      const path = (imgs[sel] && imgs[sel].path)
        || (imgs[0] && imgs[0].path)
        || _globalImage()
        || _globalVideo()
        || null;
      return [{ label: 'Input', path }];
    }

    case 'styletransfer': {
      const contents = state.styleTransfer?.contents || [];
      const sel = state.styleTransfer?.selected | 0;
      let content = (contents[sel] && contents[sel].path)
        || (contents[0] && contents[0].path)
        || null;
      if (!content) {
        content = _globalVideo() || _globalImage() || null;
      }
      const style = _field('stStylePath')
        || (state.styleTransfer?.stylePath || '')
        || null;
      return [
        { label: 'Content', path: content },
        { label: 'Style', path: style || null },
      ];
    }

    case 'rife':
      return [{ label: 'Input', path: _pick('rifeInput') || null }];

    case 'img2img':
      return [{ label: 'Input', path: _pick('i2iInput') || null }];

    case 'upscale':
      return [{ label: 'Input', path: _pick('upInput') || null }];

    case 'riferecohere': {
      let a = _field('rrA');
      let b = _field('rrB');
      // Fall back to first two global images if fields empty
      if (!a || !b) {
        const imgs = typeof resolveGlobalImages === 'function'
          ? resolveGlobalImages()
          : [];
        if (!a && imgs[0]) a = imgs[0];
        if (!b && imgs[1]) b = imgs[1];
      }
      return [
        { label: 'Image A', path: a || null },
        { label: 'Image B', path: b || null },
      ];
    }

    case 'speedchange':
      return [{ label: 'Input', path: _pick('scInput') || null }];

    case 'convert':
      return [{ label: 'Input', path: _pick('convertInput') || null }];

    case 'cut':
      return [{ label: 'Video', path: _globalVideo() || _pick(null) || null }];

    case 'imagesort': {
      const imgs = state.imageSort?.images || [];
      const sel = state.imageSort?.selected | 0;
      const path = (imgs[sel] && imgs[sel].path)
        || (imgs[0] && imgs[0].path)
        || null;
      return [{ label: imgs.length > 1 ? `Still ${sel + 1}/${imgs.length}` : 'Still', path }];
    }

    case 'imgcompare': {
      const ic = state.imgCompare || {};
      return [
        { label: 'Image A', path: ic.pathA || null },
        { label: 'Image B', path: ic.pathB || null },
      ];
    }

    case 'zoompan': {
      let path = null;
      try {
        path = typeof resolveGlobalImage === 'function' ? resolveGlobalImage() : null;
      } catch (_) { /* ignore */ }
      if (!path) path = _globalImage();
      if (path && !isImagePath(path)) path = null;
      // Optional ref from zoompan state
      const ref = state.zoompan?.refPath || null;
      const slots = [{ label: 'Source', path: path || null }];
      if (ref) slots.push({ label: 'Ref', path: ref });
      return slots;
    }

    case 'agent': {
      const imgs = state.agent?.images || [];
      if (!imgs.length) return [{ label: 'Image', path: null }];
      return imgs.slice(0, 2).map((p, i) => ({
        label: imgs.length > 1 ? `Image ${i + 1}` : 'Image',
        path: p || null,
      }));
    }

    case 'quick':
      return [{ label: 'Video', path: _globalVideo() || null }];

    case 'advanced':
      return [{ label: 'Input', path: _pick('advInput') || null }];

    default:
      // Generic fallback for any other op tab
      return [{ label: 'Input', path: _pick(null) || null }];
  }
}

function _thumbUrl(path) {
  return `/api/thumbnail?path=${encodeURIComponent(path)}&which=first&_t=${encodeURIComponent(path)}`;
}

function _kindBadge(path) {
  if (isVideoPath(path)) return 'VIDEO';
  if (isImagePath(path)) return 'IMAGE';
  return 'FILE';
}

/**
 * Render slots into #toolInputPreview (or hide when N/A).
 */
function refreshInputPreview() {
  const host = document.getElementById('toolInputPreview');
  if (!host) return;

  const tab = state.activeTab || '';
  if (HIDE_TABS.has(tab)) {
    host.hidden = true;
    host.innerHTML = '';
    return;
  }

  const slots = resolveInputSlots(tab);
  if (!slots.length) {
    host.hidden = true;
    host.innerHTML = '';
    return;
  }

  const anyPath = slots.some((s) => s.path);
  // Always show the chrome so users know where input previews live
  const slotsHtml = slots.map((s) => {
    const label = escapeHtml(s.label || 'Input');
    if (!s.path) {
      return `
        <div class="tool-input-slot">
          <div class="tool-input-slot-label">${label}</div>
          <div class="tool-input-slot-frame tool-input-slot-empty">No input set</div>
        </div>`;
    }
    const name = escapeHtml(basename(s.path));
    const title = escapeHtml(s.path);
    const badge = _kindBadge(s.path);
    const src = _thumbUrl(s.path);
    return `
      <div class="tool-input-slot" data-path="${escapeHtml(s.path)}">
        <div class="tool-input-slot-label">${label}</div>
        <div class="tool-input-slot-frame" data-preview-path="${escapeHtml(s.path)}" title="${title}">
          <span class="tool-input-slot-badge">${badge}</span>
          <img src="${src}" alt="${name}" loading="lazy"
            onerror="this.style.display='none'; this.parentElement.classList.add('is-broken')">
        </div>
        <div class="tool-input-slot-name" title="${title}">${name}</div>
      </div>`;
  }).join('');

  host.innerHTML = `
    <h4 class="tool-input-preview-title">Input preview${anyPath ? '' : ' · set a path above'}</h4>
    <div class="tool-input-preview-slots">${slotsHtml}</div>
  `;
  host.hidden = false;
}

let _bound = false;
let _debounceTimer = null;

function _scheduleRefresh() {
  if (_debounceTimer) clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(() => {
    _debounceTimer = null;
    refreshInputPreview();
  }, 80);
}

/**
 * Wire listeners once: form path fields, global bars, click → main preview.
 * MutationObserver on the form host catches list re-renders (facemorph, style, …).
 */
function bindInputPreviewListeners() {
  if (_bound) return;
  _bound = true;

  const root = document.getElementById('actionPanel');
  if (root) {
    root.addEventListener('input', (e) => {
      const t = e.target;
      if (!t) return;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') {
        _scheduleRefresh();
      }
    });
    root.addEventListener('change', () => _scheduleRefresh());
    root.addEventListener('click', (e) => {
      const frame = e.target && e.target.closest
        ? e.target.closest('[data-preview-path]')
        : null;
      if (!frame) return;
      const path = frame.getAttribute('data-preview-path');
      if (path && typeof showPreview === 'function') {
        try { showPreview(path); } catch (_) { /* ignore */ }
      }
    });
  }

  const form = document.getElementById('actionPanelForm');
  if (form && typeof MutationObserver !== 'undefined') {
    const mo = new MutationObserver(() => _scheduleRefresh());
    mo.observe(form, { childList: true, subtree: false });
  }

  // Global video/image bars live outside the action panel
  ['giVideo', 'giImage'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => _scheduleRefresh());
    el.addEventListener('change', () => _scheduleRefresh());
  });
}

export {
  resolveInputSlots,
  refreshInputPreview,
  bindInputPreviewListeners,
};
