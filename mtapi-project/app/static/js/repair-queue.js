/**
 * Bounded background repair queues.
 *
 * Display / hover / scroll / select never call this. Work starts only after
 * hydration + first virtual window + no pending renders + an idle delay,
 * or when the user clicks Repair Metadata.
 *
 * Limits (independent):
 *   POST /api/thumbnails/ensure  ≤ 8
 *   GET  /api/media_info         ≤ 4
 *   GET  /api/media_hash         ≤ 2
 *   POST /api/variants/batch     ≤ 2 in flight, ≤ 100 paths each
 */

import { globalMediaIndex, currentThumbSize, normalizeAbsPath } from '/js/media-index.js';
import { recordVariantBatch } from '/js/lazy-loader.js';

const MAX_ENSURE = 8;
const MAX_PROBE = 4;
const MAX_HASH = 2;
const MAX_VARIANT_INFLIGHT = 2;
const VARIANT_BATCH_LIMIT = 100;
const IDLE_DELAY_MS = 2000;

const state = {
  enabled: true,
  hydrated: false,
  firstWindowReady: false,
  pendingRenders: 0,
  started: false,
  idleTimer: null,
  hashQueue: [],
  hashSet: new Set(),
  hashActive: 0,
  probeQueue: [],
  probeSet: new Set(),
  probeActive: 0,
  thumbQueue: [],
  thumbSet: new Set(),
  thumbActive: 0,
  variantActive: 0,
  variantWait: [],
};

function _pathOf(itemOrPath) {
  if (!itemOrPath) return '';
  if (typeof itemOrPath === 'string') return normalizeAbsPath(itemOrPath);
  return normalizeAbsPath(itemOrPath.path);
}

function _findItem(path) {
  const p = normalizeAbsPath(path);
  const items = [
    ...(window.state?.pool?.items || []),
    ...(window.state?.imagePool?.items || []),
  ];
  return items.find((it) => normalizeAbsPath(it.path) === p) || null;
}

function _notify() {
  try { window.dispatchEvent(new CustomEvent('mtapi.catalogRepair')); } catch (_) { /* ignore */ }
}

function canStartIdle() {
  return state.enabled
    && state.hydrated
    && state.firstWindowReady
    && state.pendingRenders === 0
    && !state.started;
}

function scheduleIdleStart() {
  if (!canStartIdle()) return;
  if (state.idleTimer != null) return;
  const kick = () => {
    state.idleTimer = null;
    if (!canStartIdle()) return;
    state.started = true;
    scanAllMissing();
    drainAll();
  };
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(() => {
      state.idleTimer = setTimeout(kick, IDLE_DELAY_MS);
    }, { timeout: IDLE_DELAY_MS + 1000 });
  } else {
    state.idleTimer = setTimeout(kick, IDLE_DELAY_MS);
  }
}

function markHydrated() {
  state.hydrated = true;
  scheduleIdleStart();
}

function markFirstWindowReady() {
  state.firstWindowReady = true;
  scheduleIdleStart();
}

function beginRender() {
  state.pendingRenders += 1;
}

function endRender() {
  state.pendingRenders = Math.max(0, state.pendingRenders - 1);
  scheduleIdleStart();
}

function setEnabled(on) {
  state.enabled = !!on;
  if (!state.enabled) {
    state.hashQueue.length = 0;
    state.hashSet.clear();
    state.probeQueue.length = 0;
    state.probeSet.clear();
    state.thumbQueue.length = 0;
    state.thumbSet.clear();
    if (state.idleTimer != null) {
      clearTimeout(state.idleTimer);
      state.idleTimer = null;
    }
  }
}

function enqueueHash(itemOrPath) {
  if (!state.enabled) return;
  const path = _pathOf(itemOrPath);
  if (!path || state.hashSet.has(path)) return;
  const rec = globalMediaIndex.ensure(path);
  if (rec.hash_state.status === 'known' && rec.hash_state.hash) return;
  if (rec.hash_state.status === 'repairing') return;
  state.hashSet.add(path);
  state.hashQueue.push(path);
  rec.hash_state.status = 'queued';
  _notify();
  drainHash();
}

function enqueueProbe(itemOrPath) {
  if (!state.enabled) return;
  const path = _pathOf(itemOrPath);
  if (!path || state.probeSet.has(path)) return;
  const rec = globalMediaIndex.ensure(path);
  if (rec.metadata_state.status === 'known' && rec.metadata_state.meta) return;
  if (rec.metadata_state.status === 'repairing') return;
  state.probeSet.add(path);
  state.probeQueue.push(path);
  rec.metadata_state.status = 'queued';
  _notify();
  drainProbe();
}

function enqueueThumb(itemOrPath, which) {
  if (!state.enabled) return;
  const path = _pathOf(itemOrPath);
  if (!path) return;
  const w = which === 'last' ? 'last' : 'first';
  const key = `${path}:${w}`;
  if (state.thumbSet.has(key)) return;
  const rec = globalMediaIndex.ensure(path);
  const size = currentThumbSize();
  if (rec.thumbnails_state[w][size] === 'available') return;
  if (rec.thumbnails_state[w][size] === 'failed') return;
  if (rec.thumbnails_state[w][size] === 'repairing') return;
  const item = _findItem(path) || { path, hash: rec.hash_state.hash };
  if (item.thumbsFailed && item.thumbsFailed[w]) return;
  state.thumbSet.add(key);
  state.thumbQueue.push({ path, which: w, hash: rec.hash_state.hash || item.hash || null });
  rec.thumbnails_state[w][size] = 'queued';
  _notify();
  drainThumb();
}

function repairItem(itemOrPath, { force = false } = {}) {
  const path = _pathOf(itemOrPath);
  if (!path) return;
  const rec = globalMediaIndex.ensure(path);
  if (force) {
    if (rec.hash_state.status === 'failed') rec.hash_state.status = 'missing';
    if (rec.metadata_state.status === 'failed') rec.metadata_state.status = 'missing';
    const size = currentThumbSize();
    for (const w of ['first', 'last']) {
      if (rec.thumbnails_state[w][size] === 'failed') rec.thumbnails_state[w][size] = 'missing';
    }
    const item = _findItem(path);
    if (item) item.metaError = null;
  }
  if (!rec.hash_state.hash) enqueueHash(path);
  if (rec.metadata_state.status !== 'known') enqueueProbe(path);
  const size = currentThumbSize();
  if (rec.thumbnails_state.first[size] !== 'available') enqueueThumb(path, 'first');
  if (rec.thumbnails_state.last[size] !== 'available') enqueueThumb(path, 'last');
}

function scanAllMissing() {
  if (!state.enabled) return;
  const items = [
    ...(window.state?.pool?.items || []),
    ...(window.state?.imagePool?.items || []),
  ];
  for (const it of items) {
    const rec = globalMediaIndex.get(it) || globalMediaIndex.put(it);
    if (!rec) continue;
    if (rec.hash_state.status === 'missing') enqueueHash(it);
    if (rec.metadata_state.status === 'missing') enqueueProbe(it);
    const size = currentThumbSize();
    if (rec.thumbnails_state.first[size] === 'missing') enqueueThumb(it, 'first');
    if (rec.thumbnails_state.last[size] === 'missing') enqueueThumb(it, 'last');
  }
}

function drainAll() {
  drainHash();
  drainProbe();
  drainThumb();
}

async function drainHash() {
  while (state.enabled && state.hashActive < MAX_HASH && state.hashQueue.length) {
    const path = state.hashQueue.shift();
    state.hashSet.delete(path);
    if (!path) continue;
    const rec = globalMediaIndex.ensure(path);
    rec.hash_state.status = 'repairing';
    state.hashActive += 1;
    _notify();
    _runHash(path).finally(() => {
      state.hashActive = Math.max(0, state.hashActive - 1);
      drainHash();
      _notify();
    });
  }
}

async function _runHash(path) {
  const rec = globalMediaIndex.ensure(path);
  const item = _findItem(path);
  try {
    const res = await fetch(`/api/media_hash?path=${encodeURIComponent(path)}`);
    if (!res.ok) throw new Error(`hash ${res.status}`);
    const data = await res.json();
    const hash = data.hash || data.content_hash;
    if (!hash) throw new Error(data.error || 'hash failed');
    rec.hash_state.hash = hash;
    rec.hash_state.status = 'known';
    globalMediaIndex.applyHash(path, hash, { status: 'known' });
    if (item) {
      item.hash = hash;
      if (data.size != null && item.size == null) item.size = data.size;
    }
    const size = currentThumbSize();
    if (rec.metadata_state.status === 'missing') enqueueProbe(path);
    if (rec.thumbnails_state.first[size] === 'missing') enqueueThumb(path, 'first');
    if (rec.thumbnails_state.last[size] === 'missing') enqueueThumb(path, 'last');
  } catch (err) {
    rec.hash_state.status = 'failed';
    rec.repair_errors.push(String(err.message || err));
    if (item) item.metaError = item.metaError || err.message;
  }
}

async function drainProbe() {
  while (state.enabled && state.probeActive < MAX_PROBE && state.probeQueue.length) {
    const path = state.probeQueue.shift();
    state.probeSet.delete(path);
    if (!path) continue;
    const rec = globalMediaIndex.ensure(path);
    rec.metadata_state.status = 'repairing';
    state.probeActive += 1;
    _notify();
    _runProbe(path).finally(() => {
      state.probeActive = Math.max(0, state.probeActive - 1);
      drainProbe();
      _notify();
    });
  }
}

async function _runProbe(path) {
  const rec = globalMediaIndex.ensure(path);
  const item = _findItem(path);
  try {
    const res = await fetch(`/api/media_info?path=${encodeURIComponent(path)}&ensure_thumbs=false`);
    const data = await res.json();
    if (data && data.ok) {
      rec.metadata_state.meta = data;
      rec.metadata_state.status = 'known';
      if (data.hash) globalMediaIndex.applyHash(path, data.hash, { status: 'known' });
      globalMediaIndex.applyMeta(path, data, { status: 'known' });
      if (item) {
        item.meta = data;
        item.hash = data.hash || item.hash;
        item.history_count = data.history_count;
        item.open_count = data.open_count;
        item.metaError = null;
        if (data.size != null) item.size = data.size;
        if (data.name) item.name = data.name;
      }
    } else {
      throw new Error(data?.error || 'probe failed');
    }
  } catch (err) {
    rec.metadata_state.status = 'failed';
    rec.repair_errors.push(String(err.message || err));
    if (item) item.metaError = err.message;
  }
}

async function drainThumb() {
  while (state.enabled && state.thumbActive < MAX_ENSURE && state.thumbQueue.length) {
    const job = state.thumbQueue.shift();
    if (!job) continue;
    state.thumbSet.delete(`${job.path}:${job.which}`);
    const rec = globalMediaIndex.ensure(job.path);
    const size = currentThumbSize();
    rec.thumbnails_state[job.which][size] = 'repairing';
    state.thumbActive += 1;
    _notify();
    const item = _findItem(job.path) || { path: job.path, hash: rec.hash_state.hash || job.hash };
    _runThumb(job, item, rec, size).finally(() => {
      state.thumbActive = Math.max(0, state.thumbActive - 1);
      drainThumb();
      _notify();
    });
  }
}

async function _runThumb(job, item, rec, size) {
  try {
    const res = await fetch('/api/thumbnails/ensure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: [{ hash: rec.hash_state.hash || item.hash || job.hash || null, path: job.path, which: job.which }],
      }),
    });
    const data = res.ok ? await res.json() : null;
    const row = (data && data.results && data.results[0]) || null;
    if (row && row.ok) {
      rec.thumbnails_state[job.which][size] = 'available';
      globalMediaIndex.applyThumb(job.path, job.which, size, 'available');
      if (item) {
        item.thumbs = item.thumbs || {};
        item.thumbs[job.which] = true;
      }
      document.querySelectorAll(`img.pool-thumb[data-which="${job.which}"]`).forEach((img) => {
        const card = img.closest('.pool-card, .img-pool-card');
        if (!card) return;
        if (item.hash && card.dataset.hash && card.dataset.hash !== String(item.hash)) return;
        if (job.path && card.dataset.path && card.dataset.path !== job.path) return;
        const src = img.getAttribute('src');
        const next = src && src.includes('hash=')
          ? src.replace(/([?&])m=\d+/, `$1m=${Date.now()}`) + (src.includes('m=') ? '' : `${src.includes('?') ? '&' : '?'}m=${Date.now()}`)
          : null;
        if (next) img.src = next;
      });
    } else {
      rec.thumbnails_state[job.which][size] = 'failed';
      if (item) {
        item.thumbsFailed = item.thumbsFailed || {};
        item.thumbsFailed[job.which] = true;
      }
    }
  } catch (err) {
    rec.thumbnails_state[job.which][size] = 'failed';
    rec.repair_errors.push(String(err?.message || err));
  }
}

function acquireVariantSlot() {
  if (state.variantActive < MAX_VARIANT_INFLIGHT) {
    state.variantActive += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    state.variantWait.push(resolve);
  }).then(() => {
    state.variantActive += 1;
  });
}

function releaseVariantSlot() {
  state.variantActive = Math.max(0, state.variantActive - 1);
  const next = state.variantWait.shift();
  if (next) next();
}

async function fetchVariantsBatch(paths) {
  const unique = [];
  const seen = new Set();
  for (const raw of paths || []) {
    const key = normalizeAbsPath(raw) || String(raw || '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(key);
  }
  const result = new Map();
  if (!unique.length) return result;

  const chunks = [];
  for (let i = 0; i < unique.length; i += VARIANT_BATCH_LIMIT) {
    chunks.push(unique.slice(i, i + VARIANT_BATCH_LIMIT));
  }

  async function runChunk(chunk) {
    await acquireVariantSlot();
    try {
      const res = await fetch('/api/variants/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: chunk }),
      });
      if (!res.ok) {
        recordVariantBatch(chunk.length, true);
        for (const p of chunk) result.set(p, null);
        return;
      }
      const data = await res.json();
      recordVariantBatch(chunk.length, false);
      for (const p of chunk) {
        const variants = data && data[p] != null ? data[p] : {};
        result.set(p, variants);
        globalMediaIndex.applyVariants(p, variants, { status: 'known' });
      }
    } catch (err) {
      recordVariantBatch(chunk.length, true);
      for (const p of chunk) result.set(p, null);
    } finally {
      releaseVariantSlot();
    }
  }

  const pending = [];
  for (const chunk of chunks) {
    pending.push(runChunk(chunk));
  }
  await Promise.all(pending);
  return result;
}

function stats() {
  return {
    enabled: state.enabled,
    hydrated: state.hydrated,
    firstWindowReady: state.firstWindowReady,
    pendingRenders: state.pendingRenders,
    started: state.started,
    hashQueued: state.hashQueue.length,
    hashActive: state.hashActive,
    hashMax: MAX_HASH,
    probeQueued: state.probeQueue.length,
    probeActive: state.probeActive,
    probeMax: MAX_PROBE,
    thumbQueued: state.thumbQueue.length,
    thumbActive: state.thumbActive,
    thumbMax: MAX_ENSURE,
    variantActive: state.variantActive,
    variantMax: MAX_VARIANT_INFLIGHT,
    variantBatchLimit: VARIANT_BATCH_LIMIT,
  };
}

function resetForTests() {
  state.started = false;
  state.hydrated = false;
  state.firstWindowReady = false;
  state.pendingRenders = 0;
  state.hashQueue.length = 0;
  state.hashSet.clear();
  state.hashActive = 0;
  state.probeQueue.length = 0;
  state.probeSet.clear();
  state.probeActive = 0;
  state.thumbQueue.length = 0;
  state.thumbSet.clear();
  state.thumbActive = 0;
  state.variantActive = 0;
  state.variantWait.length = 0;
  if (state.idleTimer != null) {
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
  }
}

if (typeof window !== 'undefined') {
  window.__mtapiRepairQueue = {
    setEnabled,
    markHydrated,
    markFirstWindowReady,
    beginRender,
    endRender,
    enqueueHash,
    enqueueProbe,
    enqueueThumb,
    repairItem,
    scanAllMissing,
    fetchVariantsBatch,
    stats,
    resetForTests,
    MAX_ENSURE,
    MAX_PROBE,
    MAX_HASH,
    MAX_VARIANT_INFLIGHT,
    VARIANT_BATCH_LIMIT,
  };
}

export {
  setEnabled,
  markHydrated,
  markFirstWindowReady,
  beginRender,
  endRender,
  enqueueHash,
  enqueueProbe,
  enqueueThumb,
  repairItem,
  scanAllMissing,
  fetchVariantsBatch,
  stats,
  resetForTests,
  MAX_ENSURE,
  MAX_PROBE,
  MAX_HASH,
  MAX_VARIANT_INFLIGHT,
  VARIANT_BATCH_LIMIT,
};
