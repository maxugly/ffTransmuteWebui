import { state } from '/app.js';
import { POOL_LAYOUT_DEFAULTS } from '/js/pool/constants.js';
import { scheduleSavePoolState } from '/js/pool/persistence.js';

// ── Pool layout / dock resize helpers ─────────────────────────────────────

function ensurePoolLayout() {
  if (!state.pool.layout) state.pool.layout = { ...POOL_LAYOUT_DEFAULTS, collapsed: { ...POOL_LAYOUT_DEFAULTS.collapsed } };
  const L = state.pool.layout;
  L.collapsed = L.collapsed || { ...POOL_LAYOUT_DEFAULTS.collapsed };
  for (const k of ['sequence', 'selection', 'matches', 'pool']) {
    if (L.collapsed[k] === undefined) L.collapsed[k] = false;
  }
  return L;
}

function applyPoolLayout() {
  const L = ensurePoolLayout();
  const compose = document.getElementById('poolCompose');
  const focus = document.getElementById('poolFocusPanel');
  const frame = document.getElementById('poolFocusFrame');
  const matchResults = document.getElementById('poolMatchResults');
  const selectionBody = document.getElementById('poolSelectionBody');
  const seqPanel = document.getElementById('poolSequencePanel');
  const matchBlock = document.getElementById('poolMatchBlock');

  if (compose) {
    if (L.collapsed.pool) {
      compose.style.flex = '1 1 auto';
      compose.style.height = '';
    } else {
      compose.style.height = `${L.composeHeight}px`;
      compose.style.flex = `0 0 ${L.composeHeight}px`;
    }
  }
  if (focus) {
    focus.style.width = `${L.focusWidth}px`;
    focus.style.flex = `0 0 ${L.focusWidth}px`;
  }
  if (frame && !L.collapsed.selection) {
    if (L.selectionHeight && L.selectionHeight > 0) {
      frame.dataset.manualH = '1';
      frame.style.setProperty('--sel-h', `${L.selectionHeight}px`);
      frame.style.height = `${L.selectionHeight}px`;
    } else {
      frame.dataset.manualH = '0';
      frame.style.removeProperty('--sel-h');
      frame.style.height = '';
      frame.style.minHeight = '';
    }
  }
  if (matchResults && !L.collapsed.matches) {
    matchResults.style.flex = '1 1 auto';
    matchResults.style.minHeight = '80px';
    matchResults.style.maxHeight = 'none';
    if (L.matchHeight) {
      matchResults.style.height = `${L.matchHeight}px`;
    }
  }

  if (seqPanel) seqPanel.classList.toggle('is-collapsed', !!L.collapsed.sequence);
  if (selectionBody) selectionBody.classList.toggle('is-collapsed', !!L.collapsed.selection);
  if (matchBlock) matchBlock.classList.toggle('is-collapsed', !!L.collapsed.matches);

  const gridWrap = document.querySelector('.pool-grid-wrap');
  if (gridWrap) gridWrap.classList.toggle('is-collapsed', !!L.collapsed.pool);

  const poolTop = document.querySelector('.pool-top');
  if (poolTop) poolTop.classList.toggle('pool-collapsed', !!L.collapsed.pool);

  const toggleBtn = document.getElementById('btnTogglePool');
  if (toggleBtn) {
    toggleBtn.innerHTML = L.collapsed.pool ? '\u25C9 Show Pool' : '\u25C7 Hide Pool';
  }

  document.querySelectorAll('[data-collapse]').forEach(head => {
    const key = head.getAttribute('data-collapse');
    const chev = head.querySelector('.pool-collapse-chevron');
    const btn = head.querySelector('.pool-collapse-btn');
    const collapsed = !!L.collapsed[key];
    if (chev) chev.textContent = collapsed ? '▸' : '▾';
    if (btn) btn.setAttribute('aria-expanded', String(!collapsed));
  });
}

function togglePoolSection(key) {
  const L = ensurePoolLayout();
  L.collapsed[key] = !L.collapsed[key];
  applyPoolLayout();
  scheduleSavePoolState();
}

function expandMatchesRoom() {
  const L = ensurePoolLayout();
  L.collapsed.selection = true;
  L.collapsed.matches = false;
  L.composeHeight = Math.max(L.composeHeight, 360);
  L.focusWidth = Math.max(L.focusWidth, 380);
  L.matchHeight = Math.max(L.matchHeight, 240);
  applyPoolLayout();
  scheduleSavePoolState();
}

function setupPoolLayoutChrome() {
  installPoolScrollPaint();
  applyPoolLayout();

  document.querySelectorAll('[data-collapse]').forEach(head => {
    const key = head.getAttribute('data-collapse');
    const onToggle = (e) => {
      if (e.target.closest('.seq-transport, .pool-match-controls, #btnExpandMatches, select, input, a')) return;
      e.preventDefault();
      togglePoolSection(key);
    };
    head.addEventListener('click', onToggle);
  });

  document.getElementById('btnExpandMatches')?.addEventListener('click', (e) => {
    e.stopPropagation();
    expandMatchesRoom();
  });

  bindPoolDragResize(document.getElementById('poolVResize'), {
    axis: 'y',
    onMove: (dy, start) => {
      const L = ensurePoolLayout();
      const next = Math.max(140, Math.min(window.innerHeight * 0.75, start.composeHeight - dy));
      L.composeHeight = Math.round(next);
      applyPoolLayout();
    },
    startVals: () => ({ composeHeight: ensurePoolLayout().composeHeight }),
  });

  bindPoolDragResize(document.getElementById('poolHResize'), {
    axis: 'x',
    onMove: (dx, start) => {
      const L = ensurePoolLayout();
      const compose = document.getElementById('poolCompose');
      const maxW = compose ? compose.clientWidth - 160 : 600;
      L.focusWidth = Math.round(Math.max(220, Math.min(maxW, start.focusWidth - dx)));
      applyPoolLayout();
    },
    startVals: () => ({ focusWidth: ensurePoolLayout().focusWidth }),
  });

  bindPoolDragResize(document.getElementById('poolSelMatchResize'), {
    axis: 'y',
    onMove: (dy, start) => {
      const L = ensurePoolLayout();
      if (L.collapsed.selection || L.collapsed.matches) return;
      const baseH = start.selectionHeight > 0
        ? start.selectionHeight
        : (document.getElementById('poolFocusFrame')?.offsetHeight || 96);
      L.selectionHeight = Math.round(Math.max(48, Math.min(280, baseH + dy)));
      L.matchHeight = Math.round(Math.max(80, start.matchHeight - dy));
      applyPoolLayout();
    },
    startVals: () => {
      const L = ensurePoolLayout();
      const frameEl = document.getElementById('poolFocusFrame');
      return {
        selectionHeight: L.selectionHeight > 0 ? L.selectionHeight : (frameEl?.offsetHeight || 0),
        matchHeight: L.matchHeight,
      };
    },
  });
}

// Fast scroll must not restyle the wall. Hover/transform on 900+ cards
// blanks already-decoded thumbs until the pointer stops.
const SCROLL_IDLE_MS = 140;
let _scrollPaintInstalled = false;
let _gridScrolling = false;
let _scrollIdleTimer = null;
let _lastPtr = { x: 0, y: 0 };
let _onScrollIdle = null;

function isPoolGridScrolling() {
  return _gridScrolling;
}

function lastPoolPointer() {
  return _lastPtr;
}

function _setGridScrolling(on) {
  if (_gridScrolling === on) return;
  _gridScrolling = on;
  document.querySelectorAll('.pool-grid-wrap').forEach((el) => {
    el.classList.toggle('is-scrolling', on);
  });
}

function _onGridScroll() {
  if (!_gridScrolling) _setGridScrolling(true);
  clearTimeout(_scrollIdleTimer);
  _scrollIdleTimer = setTimeout(() => {
    _setGridScrolling(false);
    try { if (typeof _onScrollIdle === 'function') _onScrollIdle(); } catch (_) { /* ignore */ }
  }, SCROLL_IDLE_MS);
}

function installPoolScrollPaint(onIdle) {
  if (typeof onIdle === 'function') _onScrollIdle = onIdle;
  if (_scrollPaintInstalled) return;
  _scrollPaintInstalled = true;
  document.addEventListener('scroll', (e) => {
    const t = e.target;
    if (!t || t === document || t === document.documentElement || t === document.body) return;
    if (t.classList?.contains('pool-grid-wrap') || t.closest?.('.pool-grid-wrap')) {
      _onGridScroll();
    }
  }, { capture: true, passive: true });
  document.addEventListener('pointermove', (e) => {
    _lastPtr = { x: e.clientX, y: e.clientY };
  }, { passive: true });
}

function bindPoolDragResize(el, { axis, onMove, startVals }) {
  if (!el) return;
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const startPtr = axis === 'y' ? e.clientY : e.clientX;
    const start = startVals();
    document.body.classList.add('pool-resizing');

    const onMovePtr = (ev) => {
      const cur = axis === 'y' ? ev.clientY : ev.clientX;
      const delta = cur - startPtr;
      onMove(delta, start);
    };
    const onUp = () => {
      el.releasePointerCapture(e.pointerId);
      el.removeEventListener('pointermove', onMovePtr);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      document.body.classList.remove('pool-resizing');
      scheduleSavePoolState();
    };
    el.addEventListener('pointermove', onMovePtr);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  });
}

export {
  ensurePoolLayout, applyPoolLayout, togglePoolSection,
  expandMatchesRoom, setupPoolLayoutChrome, bindPoolDragResize,
  isPoolGridScrolling, installPoolScrollPaint, lastPoolPointer,
};
