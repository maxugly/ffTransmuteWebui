/**
 * Session-only per-tab scroll memory.
 *
 * Tab switches wipe #actionPanelForm innerHTML, which collapses content
 * height and resets the scroll container to 0. Remember the outer
 * #actionPanel scrollTop plus the inner pool grid scroller
 * (#poolGridWrap / #imgPoolGridWrap) per tab id, and restore after render.
 *
 * Runtime-only (Map). Nothing persisted to server or localStorage.
 */

const _mem = new Map(); // tabId -> { outer: number, grid: number }
let _raf = 0;

function _outerEl() {
  return document.getElementById('actionPanel') || null;
}

function _formEl() {
  return document.getElementById('actionPanelForm') || null;
}

function _gridEl() {
  return (
    document.getElementById('poolGridWrap') ||
    document.getElementById('imgPoolGridWrap') ||
    null
  );
}

function _read() {
  let outer = 0;
  let form = 0;
  let grid = 0;
  try {
    outer = Number(_outerEl()?.scrollTop) || 0;
  } catch (_) { /* ignore */ }
  try {
    form = Number(_formEl()?.scrollTop) || 0;
  } catch (_) { /* ignore */ }
  try {
    grid = Number(_gridEl()?.scrollTop) || 0;
  } catch (_) { /* ignore */ }
  return { outer, form, grid };
}

/** Save current scroll position under `tab`. No-op on bad input. */
function saveTabScroll(tab) {
  if (!tab || typeof tab !== 'string') return;
  try {
    _mem.set(tab, _read());
  } catch (_) { /* ignore */ }
}

/** Last-saved entry for `tab` (or null). */
function peekTabScroll(tab) {
  try {
    return _mem.get(tab) || null;
  } catch (_) {
    return null;
  }
}

function _apply(tab, entry) {
  const outerEl = _outerEl();
  const formEl = _formEl();
  const gridEl = _gridEl();
  if (outerEl && Number.isFinite(entry.outer)) {
    try {
      const max = Math.max(0, outerEl.scrollHeight - outerEl.clientHeight);
      outerEl.scrollTop = Math.min(Math.max(0, entry.outer), max);
    } catch (_) { /* ignore */ }
  }
  if (formEl && Number.isFinite(entry.form)) {
    try {
      const max = Math.max(0, formEl.scrollHeight - formEl.clientHeight);
      formEl.scrollTop = Math.min(Math.max(0, entry.form), max);
    } catch (_) { /* ignore */ }
  }
  if (gridEl && Number.isFinite(entry.grid) && entry.grid > 0) {
    try {
      const max = Math.max(0, gridEl.scrollHeight - gridEl.clientHeight);
      gridEl.scrollTop = Math.min(Math.max(0, entry.grid), max);
    } catch (_) { /* ignore */ }
  }
}

/**
 * Restore saved scroll for `tab` after the new form has laid out.
 * Double rAF so the virtual grid sync + images settle first.
 * Falls back to state.pool.gridScrollTop for pool tabs on first visit.
 */
function restoreTabScroll(tab) {
  if (!tab || typeof tab !== 'string') return;
  let entry = null;
  try {
    entry = _mem.get(tab) || null;
  } catch (_) { /* ignore */ }
  if (!entry) {
    // First visit to a pool tab after reload: reuse the desk-restored
    // grid offset instead of starting at 0. Session map wins afterwards.
    try {
      const g = Number(window.state?.pool?.gridScrollTop) || 0;
      if (g > 0 && (tab === 'pool' || tab === 'sequence' || tab === 'images')) {
        entry = { outer: 0, form: 0, grid: g };
      }
    } catch (_) { /* ignore */ }
  }
  if (!entry || (entry.outer <= 0 && entry.form <= 0 && entry.grid <= 0)) return;
  const run = () => {
    try {
      _apply(tab, entry);
    } catch (_) { /* ignore */ }
  };
  try {
    requestAnimationFrame(() => requestAnimationFrame(run));
  } catch (_) {
    try {
      setTimeout(run, 50);
    } catch (_) { /* ignore */ }
  }
}

/**
 * Track scrolling session-wide. Uses a capture-phase document listener so
 * it survives #actionPanelForm innerHTML rebuilds. Saves under the live
 * active tab (throttled via rAF).
 */
function initTabScroll(getActiveTab) {
  if (typeof document === 'undefined') return;
  if (document.__mtapiTabScrollInit) return;
  document.__mtapiTabScrollInit = true;
  const save = () => {
    _raf = 0;
    let tab = null;
    try {
      tab = typeof getActiveTab === 'function'
        ? getActiveTab()
        : (window.state?.activeTab || null);
    } catch (_) { /* ignore */ }
    if (tab) saveTabScroll(tab);
  };
  const schedule = () => {
    if (_raf) return;
    _raf = 1;
    try {
      requestAnimationFrame(save);
    } catch (_) {
      save();
    }
  };
  try {
    document.addEventListener('scroll', (e) => {
      const t = e && e.target;
      if (!t || t === document) return;
      if (t.id === 'actionPanel' || t.id === 'actionPanelForm' || t.id === 'poolGridWrap' || t.id === 'imgPoolGridWrap') {
        schedule();
      }
    }, { capture: true, passive: true });
  } catch (_) { /* ignore */ }
}

export { saveTabScroll, restoreTabScroll, peekTabScroll, initTabScroll };
