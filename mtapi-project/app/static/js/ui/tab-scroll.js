/**
 * Per-tab scroll memory, persisted across sessions.
 *
 * Tab switches wipe #actionPanelForm innerHTML, which collapses content
 * height and resets the scroll container to 0. Remember the outer
 * #actionPanel scrollTop plus the inner pool grid scroller
 * (#poolGridWrap / #imgPoolGridWrap) per tab id, and restore after render.
 *
 * Browser-only: an in-memory Map fronted by localStorage (`mtapi_tab_scroll`).
 * Never written into named projects or the server session snapshot (same
 * class as prompt library / nav-section collapse).
 */

const STORAGE_KEY = 'mtapi_tab_scroll';
const STORAGE_VERSION = 1;
const MAX_TABS = 60;
const MAX_SCROLL = 100000;

const _mem = new Map(); // tabId -> { outer: number, form: number, grid: number }
let _raf = 0;
let _persistTimer = 0;

function _num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(0, n), MAX_SCROLL) : 0;
}

function _loadStored() {
  let raw = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch (_) {
    return;
  }
  if (!raw) return;
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return;
  }
  const tabs = parsed && typeof parsed === 'object' ? parsed.tabs : null;
  if (!tabs || typeof tabs !== 'object') return;
  try {
    for (const k of Object.keys(tabs)) {
      if (_mem.size >= MAX_TABS) break;
      const e = tabs[k];
      if (!e || typeof e !== 'object') continue;
      const entry = { outer: _num(e.outer), form: _num(e.form), grid: _num(e.grid) };
      if (entry.outer > 0 || entry.form > 0 || entry.grid > 0) _mem.set(k, entry);
    }
  } catch (_) { /* ignore */ }
}

function _flushStored() {
  _persistTimer = 0;
  let tabs = null;
  try {
    tabs = Object.fromEntries(_mem);
  } catch (_) {
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: STORAGE_VERSION, tabs }));
  } catch (_) { /* quota / private mode — memory still works for the session */ }
}

function _schedulePersist() {
  if (_persistTimer) return;
  try {
    _persistTimer = setTimeout(_flushStored, 400);
  } catch (_) {
    _flushStored();
  }
}

// Seed memory from the previous session before the first switchTab runs.
try {
  _loadStored();
} catch (_) { /* ignore */ }

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
    if (_mem.size > MAX_TABS) {
      const oldest = _mem.keys().next();
      if (!oldest.done) _mem.delete(oldest.value);
    }
    _schedulePersist();
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

function _applyPane(el, want) {
  if (!el || !Number.isFinite(want) || want <= 0) return true;
  try {
    const max = Math.max(0, el.scrollHeight - el.clientHeight);
    el.scrollTop = Math.min(Math.max(0, want), max);
    return el.scrollTop >= Math.min(want, max) - 1;
  } catch (_) {
    return false;
  }
}

/**
 * Apply `entry` to the live panes. Returns true when every pane with a
 * nonzero target reached it (or has no room to scroll). Late layout
 * (virtual-grid sync, images, fonts) can leave scrollHeight short on the
 * first pass, so callers retry until this returns true.
 */
function _apply(tab, entry) {
  const okOuter = _applyPane(_outerEl(), entry.outer);
  const okForm = _applyPane(_formEl(), entry.form);
  const okGrid = _applyPane(_gridEl(), entry.grid);
  return okOuter && okForm && okGrid;
}

/**
 * Restore saved scroll for `tab` after the new form has laid out.
 * Retries (double-rAF, then +200ms / +600ms) so late layout — virtual-grid
 * sync, images, fonts — that leaves scrollHeight short on the first pass
 * still converges on the saved position instead of clamping to 0.
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
    // grid offset instead of starting at 0. Stored map wins afterwards.
    try {
      const g = Number(window.state?.pool?.gridScrollTop) || 0;
      if (g > 0 && (tab === 'pool' || tab === 'sequence' || tab === 'images')) {
        entry = { outer: 0, form: 0, grid: g };
      }
    } catch (_) { /* ignore */ }
  }
  if (!entry || (entry.outer <= 0 && entry.form <= 0 && entry.grid <= 0)) return;
  let attempts = 0;
  const run = () => {
    attempts += 1;
    let done = false;
    try {
      done = _apply(tab, entry);
    } catch (_) { /* ignore */ }
    if (!done && attempts < 3) {
      try {
        setTimeout(run, attempts === 1 ? 200 : 600);
      } catch (_) { /* ignore */ }
    }
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
  // Flush the latest position before the page goes away so it survives
  // reload / browser restart. The trailing persist timer alone may not
  // fire on a fast tab close.
  const flush = () => {
    try {
      let tab = null;
      try {
        tab = typeof getActiveTab === 'function'
          ? getActiveTab()
          : (window.state?.activeTab || null);
      } catch (_) { /* ignore */ }
      if (tab) saveTabScroll(tab);
    } catch (_) { /* ignore */ }
    try {
      if (_persistTimer) {
        clearTimeout(_persistTimer);
        _persistTimer = 0;
      }
    } catch (_) { /* ignore */ }
    _flushStored();
  };
  try {
    window.addEventListener('pagehide', flush);
  } catch (_) { /* ignore */ }
  try {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
  } catch (_) { /* ignore */ }
}

export { saveTabScroll, restoreTabScroll, peekTabScroll, initTabScroll };
