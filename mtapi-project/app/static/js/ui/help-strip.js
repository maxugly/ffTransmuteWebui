// ── Context-sensitive help strip (hover help bar) ───────────────────────────
//
// One persistent two-line strip at the bottom of the main area explains
// whatever the cursor is over. Replaces every native `title=` tooltip and
// every custom hover popup app-wide. Delegated listeners only — zero
// per-element wiring cost; dynamic content (knobs, pool cards) registers a
// resolver via HelpStrip.register().
//
// Line 1 (bold):   what it is — control name / action / range
// Line 2 (muted):  what it does, how to use, live value while dragging

const DEFAULT_IDLE_TITLE = 'ffTransmute — Hover for help';
const DEFAULT_IDLE_TEXT = 'Hover any control, knob, or pool item to see what it does. No popups.';
const IDLE_MS = 300;

const registry = new WeakMap();   // el -> { title, text, getDynamicText }
const roots = [];                 // delegation scopes: main, sidebar, file modal

let strip = null;
let titleEl = null;
let textEl = null;
let idleTimer = 0;
let rafPending = false;
let pendingTarget = null;
let currentEl = null;             // element whose help is on screen
let pinnedEl = null;              // drag-pinned element (knob drags)
let idleTitle = DEFAULT_IDLE_TITLE;
let idleText = DEFAULT_IDLE_TEXT;
let booted = false;

function clearTimeouts() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = 0; }
}

function isDisabled(el) {
  if (!el || el.nodeType !== 1) return false;
  if (el.disabled === true) return true;
  return !!el.closest('[disabled]');
}

function materialize(el, reg) {
  let title = typeof reg.title === 'function' ? reg.title(el) : (reg.title || '');
  let text = typeof reg.text === 'function' ? reg.text(el) : (reg.text || '');
  let dyn = '';
  if (reg.getDynamicText) {
    try { dyn = reg.getDynamicText(el, {}) || ''; } catch (_) { /* keep silent */ }
  }
  if (text && dyn) text = `${text} — ${dyn}`;
  else if (dyn) text = dyn;
  return { title: String(title || ''), text: String(text || '') };
}

function attrHelp(el) {
  const title = el.getAttribute('data-help-title');
  const text = el.getAttribute('data-help-text');
  const short = el.getAttribute('data-help');
  if (title == null && text == null && short == null) return null;
  if (title != null || text != null) return { title: title || '', text: text || '' };
  const i = short.indexOf('|');
  if (i < 0) return { title: short, text: '' };
  return { title: short.slice(0, i).trim(), text: short.slice(i + 1).trim() };
}

function rootOf(target) {
  for (const r of roots) {
    if (r && r.contains(target)) return r;
  }
  return null;
}

// Climb from `start` (inclusive) to its delegation root. Child help wins
// over parent help: the innermost registered/attributed element is used.
function resolveHelp(start) {
  if (!start || start.nodeType !== 1) return null;
  const root = rootOf(start);
  if (!root) return null;
  let el = start;
  while (el && el !== root) {
    const reg = registry.get(el);
    if (reg) { const m = materialize(el, reg); return { el, ...m }; }
    const a = attrHelp(el);
    if (a) return { el, ...a };
    el = el.parentElement;
  }
  return null;
}

function render(entry) {
  if (!strip) return;
  let text = entry.text;
  if (isDisabled(entry.el)) text = text ? `${text} (disabled)` : '(disabled)';
  titleEl.textContent = entry.title;
  textEl.textContent = text;
  currentEl = entry.el;
}

function goIdle() {
  if (!strip) return;
  titleEl.textContent = idleTitle;
  textEl.textContent = idleText;
  currentEl = null;
}

function scheduleIdle() {
  if (pinnedEl) return;
  clearTimeouts();
  idleTimer = setTimeout(goIdle, IDLE_MS);
}

function showEntry(entry) {
  clearTimeouts();
  render(entry);
}

// ── Event handlers (delegated) ─────────────────────────────────────────────

function onPointerOver(e) {
  if (pinnedEl || !strip) return;
  if (rafPending) { pendingTarget = e.target; return; }
  rafPending = true;
  pendingTarget = e.target;
  requestAnimationFrame(() => {
    rafPending = false;
    if (pinnedEl) return;
    const entry = resolveHelp(pendingTarget);
    if (entry) showEntry(entry);
    // No help under the cursor: keep current text — the mouseout idle timer
    // (300 ms) handles the eventual revert, so rapid crossings never flicker.
  });
}

function onPointerOut(e) {
  if (pinnedEl || !strip) return;
  if (currentEl && currentEl.getAttribute && currentEl.getAttribute('data-help-persist') === 'true') return;
  const to = e.relatedTarget;
  if (to && resolveHelp(to)) return;   // moving within / into another help el
  scheduleIdle();
}

function onFocusIn(e) {
  if (pinnedEl || !strip) return;
  const entry = resolveHelp(e.target);
  if (entry) showEntry(entry);
}

function onFocusOut(e) {
  if (pinnedEl || !strip) return;
  if (e.relatedTarget && resolveHelp(e.relatedTarget)) return;
  scheduleIdle();
}

function onTouchStart(e) {
  if (!strip) return;
  const entry = resolveHelp(e.target);
  if (entry) showEntry(entry);
  else goIdle();                       // tap elsewhere clears
}

function onWindowBlur() {
  if (!strip) return;
  clearTimeouts();
  goIdle();
}

// ── Public API ─────────────────────────────────────────────────────────────

const HelpStrip = {
  init(opts = {}) {
    if (booted) return;
    strip = document.getElementById('help-strip');
    if (!strip) return;                // fail silently when strip is absent
    booted = true;
    titleEl = strip.querySelector('.help-title');
    textEl = strip.querySelector('.help-text');
    idleTitle = opts.idleTitle || DEFAULT_IDLE_TITLE;
    idleText = opts.idleText || DEFAULT_IDLE_TEXT;
    goIdle();

    const main = document.querySelector('main');
    const sidebar = document.querySelector('.app-sidebar');
    const fbModal = document.getElementById('fbModal');
    for (const r of [main, sidebar, fbModal]) if (r) roots.push(r);

    for (const r of roots) {
      r.addEventListener('mouseover', onPointerOver);
      r.addEventListener('mouseout', onPointerOut);
      r.addEventListener('focusin', onFocusIn);
      r.addEventListener('focusout', onFocusOut);
      r.addEventListener('touchstart', onTouchStart, { passive: true });
    }
    window.addEventListener('blur', onWindowBlur);
    window.HelpStrip = this;           // console audit access
  },

  register(el, opts) {
    if (!el) return;
    registry.set(el, opts || {});
  },

  unregister(el) {
    if (el) registry.delete(el);
  },

  setIdle(title, text) {
    idleTitle = title != null ? title : DEFAULT_IDLE_TITLE;
    idleText = text != null ? text : DEFAULT_IDLE_TEXT;
    if (!currentEl) goIdle();
  },

  set(title, text) {
    if (!strip) return;
    clearTimeouts();
    titleEl.textContent = title || '';
    textEl.textContent = text || '';
    currentEl = null;
  },

  setFromElement(el) {
    const entry = resolveHelp(el);
    if (entry) showEntry(entry);
    return entry;
  },

  // Re-run dynamic text for `el` if it is what the strip is showing
  // (live knob values while dragging). Cheap no-op otherwise.
  update(el) {
    if (!strip || !el) return;
    if (pinnedEl ? el !== pinnedEl : el !== currentEl) return;
    const entry = resolveHelp(el);
    if (entry) render(entry);
  },

  // Drag support: pin the strip to `el` (suppresses hover churn + idle),
  // release with unpin().
  pin(el) {
    if (!strip || !el) return;
    const entry = resolveHelp(el);
    if (!entry) return;
    pinnedEl = entry.el;
    clearTimeouts();
    render(entry);
  },

  unpin() {
    pinnedEl = null;
    scheduleIdle();
  },

  clear() {
    if (!strip) return;
    clearTimeouts();
    pinnedEl = null;
    goIdle();
  },

  // Dev-only: elements still carrying a native title= under the main area.
  audit() {
    const out = [];
    const main = document.querySelector('main');
    if (!main) return out;
    main.querySelectorAll('[title]').forEach((el) => {
      out.push({ tag: el.tagName.toLowerCase(), id: el.id || '', title: el.getAttribute('title') });
    });
    if (out.length) console.warn('[HelpStrip] leftover native title= tooltips:', out);
    return out;
  },
};

export { HelpStrip };
