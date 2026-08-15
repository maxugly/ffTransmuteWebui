/**
 * Shared card activator + thumbnail preload for Video Pool and Image Pool.
 *
 * Default mode is eager: once a pool is restored, every existing card is
 * queued with bounded concurrency. Scrolling is not the first time an
 * already-cached thumbnail is requested.
 *
 * Viewport-lazy loading exists only when settings.lazyThumbnails is true.
 *
 * Signature validation (when actually needed) is batched via
 * POST /api/media_signatures — never one request per card.
 */

const PREFETCH_MARGIN = '100px 0px';
const MAX_CONCURRENT = 5;
const SIGNATURE_BATCH_LIMIT = 100;
const SIGNATURE_FLUSH_MS = 100;

const callbacks = new Map();
const pending = [];
const pendingSet = new Set();
let active = 0;
let observer = null;
let forceFallback = false;

const pendingSignatureQueue = [];
const pendingSignatureSet = new Set();
const signatureWaiters = new Map(); // path → [resolve]
let signatureTimer = null;

const instrument = {
  signatureBatches: 0,
  signatureItems: 0,
  signatureFailures: 0,
  variantBatches: 0,
  variantItems: 0,
  variantFailures: 0,
};

function isLazyMode() {
  try {
    return !!(window.state?.settings?.lazyThumbnails);
  } catch (_) {
    return false;
  }
}

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
  if (isLazyMode()) {
    const obs = getObserver();
    if (obs) {
      obs.observe(element);
      return;
    }
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
  pendingSignatureQueue.length = 0;
  pendingSignatureSet.clear();
  signatureWaiters.clear();
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

function _scheduleSignatureFlush() {
  if (signatureTimer != null) return;
  signatureTimer = setTimeout(() => {
    signatureTimer = null;
    flushSignatureQueue();
  }, SIGNATURE_FLUSH_MS);
}

function enqueueSignature(path) {
  if (!path || pendingSignatureSet.has(path)) {
    return signatureWaiters.get(path)
      ? new Promise((resolve) => {
          const list = signatureWaiters.get(path) || [];
          list.push(resolve);
          signatureWaiters.set(path, list);
        })
      : Promise.resolve(null);
  }
  pendingSignatureSet.add(path);
  pendingSignatureQueue.push(path);
  const p = new Promise((resolve) => {
    const list = signatureWaiters.get(path) || [];
    list.push(resolve);
    signatureWaiters.set(path, list);
  });
  _scheduleSignatureFlush();
  return p;
}

function _resolveWaiters(path, value) {
  const list = signatureWaiters.get(path) || [];
  signatureWaiters.delete(path);
  for (const resolve of list) {
    try { resolve(value); } catch (_) { /* ignore */ }
  }
}

async function flushSignatureQueue() {
  if (!pendingSignatureQueue.length) return;
  const batch = pendingSignatureQueue.splice(0, SIGNATURE_BATCH_LIMIT);
  for (const p of batch) pendingSignatureSet.delete(p);
  if (pendingSignatureQueue.length) _scheduleSignatureFlush();
  instrument.signatureBatches += 1;
  instrument.signatureItems += batch.length;
  try {
    const res = await fetch('/api/media_signatures', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: batch }),
    });
    if (!res.ok) {
      instrument.signatureFailures += 1;
      const errText = await res.text().catch(() => res.statusText);
      console.warn('[lazy-loader] signature batch failed', res.status, errText);
      for (const p of batch) _resolveWaiters(p, null);
      return;
    }
    const data = await res.json();
    for (const p of batch) {
      const hit = data && Object.prototype.hasOwnProperty.call(data, p) ? data[p] : null;
      _resolveWaiters(p, hit);
    }
  } catch (err) {
    instrument.signatureFailures += 1;
    console.warn('[lazy-loader] signature batch error', err);
    for (const p of batch) _resolveWaiters(p, null);
  }
}

function recordVariantBatch(itemCount, failed) {
  instrument.variantBatches += 1;
  instrument.variantItems += itemCount;
  if (failed) instrument.variantFailures += 1;
}

function stats() {
  return {
    observed: callbacks.size,
    pending: pending.length,
    active,
    fallback: !observerAvailable() || !isLazyMode(),
    maxConcurrent: MAX_CONCURRENT,
    lazyMode: isLazyMode(),
    queueDepth: pendingSignatureQueue.length + pending.length,
    signatureQueue: pendingSignatureQueue.length,
    signatureBatches: instrument.signatureBatches,
    signatureItems: instrument.signatureItems,
    signatureFailures: instrument.signatureFailures,
    variantBatches: instrument.variantBatches,
    variantItems: instrument.variantItems,
    variantFailures: instrument.variantFailures,
  };
}

if (typeof window !== 'undefined') {
  window.__mtapiLazyLoader = {
    observe, unobserve, clearPending, disconnectAll, setForceFallback, stats,
    enqueueSignature, flushSignatureQueue, recordVariantBatch,
  };
}

export {
  observe,
  unobserve,
  clearPending,
  disconnectAll,
  setForceFallback,
  stats,
  enqueueSignature,
  flushSignatureQueue,
  recordVariantBatch,
  PREFETCH_MARGIN,
  MAX_CONCURRENT,
  SIGNATURE_BATCH_LIMIT,
};
