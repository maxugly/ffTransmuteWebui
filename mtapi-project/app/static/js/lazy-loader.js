/**
 * Shared viewport lazy-loader for Video Pool and Image Pool cards.
 *
 * Cards register via observe(el, callback). The callback runs when the card
 * enters a 100px prefetch margin. If IntersectionObserver is missing, callbacks
 * run through a bounded queue (max 5 concurrent) so large pools cannot freeze.
 */

const PREFETCH_MARGIN = '100px 0px';
const MAX_CONCURRENT = 5;

const callbacks = new Map();
const pending = [];
const pendingSet = new Set();
let active = 0;
let observer = null;
let forceFallback = false;

function observerAvailable() {
  return !forceFallback && typeof IntersectionObserver !== 'undefined';
}

function getObserver() {
  if (!observerAvailable()) return null;
  if (!observer) {
    observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const el = entry.target;
        const cb = callbacks.get(el);
        if (!cb) {
          observer.unobserve(el);
          return;
        }
        observer.unobserve(el);
        enqueue(el, cb);
      });
    }, { rootMargin: PREFETCH_MARGIN });
  }
  return observer;
}

function runJob(el, cb) {
  active += 1;
  Promise.resolve()
    .then(() => cb(el))
    .catch((err) => {
      console.warn('[lazy-loader]', err);
    })
    .finally(() => {
      active -= 1;
      drainQueue();
    });
}

function enqueue(el, cb) {
  if (callbacks.get(el) !== cb) callbacks.set(el, cb);
  if (pendingSet.has(el)) return;
  pendingSet.add(el);
  pending.push(el);
  drainQueue();
}

function drainQueue() {
  while (active < MAX_CONCURRENT && pending.length) {
    const el = pending.shift();
    pendingSet.delete(el);
    const cb = callbacks.get(el);
    if (!cb) continue;
    runJob(el, cb);
  }
}

function observe(element, callback) {
  if (!element || typeof callback !== 'function') return;
  callbacks.set(element, callback);
  const obs = getObserver();
  if (obs) {
    obs.observe(element);
    return;
  }
  enqueue(element, callback);
}

function unobserve(element) {
  if (!element) return;
  callbacks.delete(element);
  if (observer) {
    try { observer.unobserve(element); } catch (_) { /* ignore */ }
  }
  if (pendingSet.has(element)) {
    pendingSet.delete(element);
    const i = pending.indexOf(element);
    if (i >= 0) pending.splice(i, 1);
  }
}

function clearPending() {
  pending.length = 0;
  pendingSet.clear();
}

function disconnectAll() {
  if (observer) {
    try { observer.disconnect(); } catch (_) { /* ignore */ }
  }
  callbacks.clear();
  clearPending();
}

/** Test hook: treat IntersectionObserver as missing. */
function setForceFallback(on) {
  forceFallback = !!on;
  if (forceFallback && observer) {
    try { observer.disconnect(); } catch (_) { /* ignore */ }
    observer = null;
    callbacks.forEach((cb, el) => enqueue(el, cb));
  }
  drainQueue();
}

function stats() {
  return {
    observed: callbacks.size,
    pending: pending.length,
    active,
    fallback: !observerAvailable(),
    maxConcurrent: MAX_CONCURRENT,
  };
}

if (typeof window !== 'undefined') {
  window.__mtapiLazyLoader = { observe, unobserve, clearPending, disconnectAll, setForceFallback, stats };
}

export {
  observe,
  unobserve,
  clearPending,
  disconnectAll,
  setForceFallback,
  stats,
  PREFETCH_MARGIN,
  MAX_CONCURRENT,
};
