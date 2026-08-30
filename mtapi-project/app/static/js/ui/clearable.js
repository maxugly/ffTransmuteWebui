// ── Clearable inputs — reusable red ✕ for any text box ──────────────────────
// Drop-in usage: add `data-clearable` to any <input type="text"> or <textarea>.
// The ✕ appears whenever the field holds content, clears it on click (fires
// `input` + `change` so existing listeners — updateGlobalInputs, form capture,
// probe logic — keep working), and returns focus to the field.
//
// New elements anywhere are wired automatically via a MutationObserver, so
// adding the attribute to future markup is zero-JS. Programmatic upgrades:
//   makeClearable(el)      — upgrade one element (idempotent)
//   bindClearables(scope)  — upgrade every [data-clearable] inside scope

let _observerBound = false;
let _pollerBound = false;
const _fields = new Map(); // el -> lastValue (poller cache)

function isFilled(el) {
  return !!(el && typeof el.value === 'string' && el.value.trim().length > 0);
}

function paint(el) {
  const wrap = el._clearable;
  if (!wrap) return;
  wrap.classList.toggle('has-value', isFilled(el));
  const btn = wrap.querySelector('.clearable-clear');
  if (btn) {
    btn.setAttribute('aria-hidden', isFilled(el) ? 'false' : 'true');
    btn.tabIndex = isFilled(el) ? 0 : -1;
  }
}

function paintFromCache(el) {
  const v = (el.value || '');
  if (_fields.get(el) === v) return;
  _fields.set(el, v);
  paint(el);
}

function wirePoller() {
  if (_pollerBound) return;
  _pollerBound = true;
  setInterval(() => {
    if (!_fields.size) return;
    _fields.forEach((_old, el) => {
      if (el && el.isConnected) paintFromCache(el);
      else _fields.delete(el);
    });
  }, 250);
}

export function makeClearable(el) {
  if (!el || el._clearable) return null;
  if (el.nodeType !== 1) return null;
  const tag = String(el.tagName || '').toUpperCase();
  if (tag !== 'INPUT' && tag !== 'TEXTAREA') return null;

  const parent = el.parentNode;
  if (!parent) return null;

  const wrap = document.createElement('div');
  wrap.className = 'clearable-wrap';
  if (tag === 'TEXTAREA') wrap.classList.add('is-textarea');
  parent.insertBefore(wrap, el);
  wrap.appendChild(el);
  el.removeAttribute('data-clearable');
  el._clearable = wrap;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'clearable-clear';
  btn.setAttribute('aria-label', 'Clear field');
  btn.textContent = '✕';
  wrap.appendChild(btn);

  btn.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    el.value = '';
    paintFromCache(el);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.focus();
  });

  el.addEventListener('input', () => paintFromCache(el));
  el.addEventListener('change', () => paintFromCache(el));
  // Re-sync on blur catches programmatic value writes that never fire events.
  el.addEventListener('blur', () => paintFromCache(el));

  // Keep text clear of the ✕ regardless of host-page input padding rules.
  el.style.paddingRight = '30px';

  paintFromCache(el);
  _fields.set(el, el.value || '');
  return wrap;
}

export function bindClearables(scope = document) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return 0;
  let n = 0;
  scope.querySelectorAll('[data-clearable]').forEach((el) => {
    if (makeClearable(el)) n += 1;
  });
  return n;
}

function wireObserver() {
  if (_observerBound) return;
  _observerBound = true;
  try {
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (!n || n.nodeType !== 1) continue;
          if (n.matches && n.matches('[data-clearable]')) makeClearable(n);
          if (n.querySelectorAll) n.querySelectorAll('[data-clearable]').forEach(makeClearable);
        }
      }
    });
    mo.observe(document.documentElement || document.body, { childList: true, subtree: true });
  } catch (_) { /* observer is best-effort; bindClearables stays explicit */ }
}

// Auto-wire on load (module import side effect) + watch later-rendered markup.
function boot() {
  bindClearables();
  wireObserver();
  wirePoller();
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}