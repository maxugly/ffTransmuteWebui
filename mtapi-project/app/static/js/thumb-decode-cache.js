/**
 * Browser decode-ready thumbnail cache for Video and Image Pool.
 *
 * Separate from the server 64 MiB JPEG ByteLRU. Holds decoded bitmaps
 * (estimated RGBA bytes) under a 128 MiB LRU. Viewport + overscan only.
 *
 * Recycle protocol: never assign a new visible identity until that
 * position's image is decoded, or show a labeled pending placeholder.
 * Never leave a previous clip's pixels on a new identity.
 */
import { state } from '/app.js';
import { poolThumbUrl, itemShowsThumb } from '/js/pool/persistence.js';

export const DECODE_BUDGET_BYTES = 128 * 1024 * 1024;
const PRELOAD_CONCURRENT = 8;

const cache = new Map(); // key -> { bytes, lastUsed, ready }
const inflight = new Map(); // key -> Promise<boolean>
let residentBytes = 0;
let evicted = 0;
let preloadActive = 0;
const preloadQ = [];

const paint = {
  blankMs: [],
  staleMs: [],
  holes: 0,
  holeSamples: [],
  blankOpen: new WeakMap(),
  staleOpen: new WeakMap(),
};

function selectedSize() {
  return String(state.settings?.thumbnailSize || 'H').toUpperCase();
}

export function thumbCacheKey(item, which) {
  const w = which || 'first';
  const size = selectedSize();
  const rev = item?.thumb_rev && item.thumb_rev[w] != null ? item.thumb_rev[w] : 3;
  const id = item?.hash || item?.path || '';
  return `${id}:${w}:${size}:${rev}`;
}

function estimateBytes(img) {
  const w = img.naturalWidth || 0;
  const h = img.naturalHeight || 0;
  return Math.max(1, w * h * 4);
}

function touch(key) {
  const ent = cache.get(key);
  if (!ent) return;
  ent.lastUsed = performance.now();
}

function evictToFit(needed) {
  while (residentBytes + needed > DECODE_BUDGET_BYTES && cache.size) {
    let oldestKey = null;
    let oldestT = Infinity;
    for (const [k, v] of cache) {
      if (v.lastUsed < oldestT) {
        oldestT = v.lastUsed;
        oldestKey = k;
      }
    }
    if (!oldestKey) break;
    const gone = cache.get(oldestKey);
    cache.delete(oldestKey);
    residentBytes -= gone?.bytes || 0;
    evicted += 1;
  }
}

function putReady(key, img) {
  const bytes = estimateBytes(img);
  evictToFit(bytes);
  if (bytes > DECODE_BUDGET_BYTES) return;
  const prev = cache.get(key);
  if (prev) residentBytes -= prev.bytes;
  cache.set(key, { bytes, lastUsed: performance.now(), ready: true });
  residentBytes += bytes;
}

export function hasDecoded(key) {
  return !!(key && cache.get(key)?.ready);
}

function drainPreload() {
  while (preloadActive < PRELOAD_CONCURRENT && preloadQ.length) {
    const job = preloadQ.shift();
    preloadActive += 1;
    job.run().finally(() => {
      preloadActive -= 1;
      drainPreload();
    });
  }
}

export function preloadThumb(key, url) {
  if (!key || !url) return Promise.resolve(false);
  if (hasDecoded(key)) {
    touch(key);
    return Promise.resolve(true);
  }
  const existing = inflight.get(key);
  if (existing) return existing;
  const p = new Promise((resolve) => {
    preloadQ.push({
      run: () => loadOffscreen(key, url).then(resolve),
    });
    drainPreload();
  });
  inflight.set(key, p);
  p.finally(() => {
    if (inflight.get(key) === p) inflight.delete(key);
  });
  return p;
}

function loadOffscreen(key, url) {
  return new Promise((resolve) => {
    const im = new Image();
    im.decoding = 'async';
    const finish = (ok) => {
      if (ok) putReady(key, im);
      resolve(!!ok);
    };
    im.onload = () => {
      if (typeof im.decode === 'function') {
        im.decode().then(() => finish(im.naturalWidth > 0)).catch(() => finish(im.naturalWidth > 0));
      } else {
        finish(im.naturalWidth > 0);
      }
    };
    im.onerror = () => finish(false);
    im.src = url;
  });
}

function noteBlankStart(img) {
  if (!paint.blankOpen.has(img)) paint.blankOpen.set(img, performance.now());
}

function noteBlankEnd(img) {
  const t0 = paint.blankOpen.get(img);
  if (t0 == null) return;
  paint.blankMs.push(performance.now() - t0);
  if (paint.blankMs.length > 400) paint.blankMs.splice(0, paint.blankMs.length - 400);
  paint.blankOpen.delete(img);
}

function noteStaleStart(img) {
  if (!paint.staleOpen.has(img)) paint.staleOpen.set(img, performance.now());
}

function noteStaleEnd(img) {
  const t0 = paint.staleOpen.get(img);
  if (t0 == null) return;
  paint.staleMs.push(performance.now() - t0);
  if (paint.staleMs.length > 400) paint.staleMs.splice(0, paint.staleMs.length - 400);
  paint.staleOpen.delete(img);
}

function pendingLabel(item, which) {
  const name = item?.name || (item?.path || '').split('/').pop() || 'Loading';
  const tag = which === 'last' ? 'LAST' : (which === 'first' ? 'FIRST' : '');
  return tag ? `${name} · ${tag}` : name;
}

function setFrameState(img, frame, kind, label) {
  if (!frame) return;
  frame.classList.toggle('is-pending', kind === 'pending');
  frame.classList.toggle('is-missing', kind === 'missing');
  if (kind === 'pending') frame.setAttribute('data-pending-label', label || 'Loading');
  else frame.removeAttribute('data-pending-label');
  if (kind === 'ready') {
    img.style.opacity = '';
    noteBlankEnd(img);
    noteStaleEnd(img);
  } else if (kind === 'pending') {
    img.style.opacity = '0';
    noteBlankStart(img);
  } else if (kind === 'missing') {
    img.style.opacity = '';
    noteBlankEnd(img);
    noteStaleEnd(img);
  }
}

/**
 * Commit one first/last image. First and last are independent.
 * Same identity keeps pixels. New identity + decoded → atomic src.
 * New identity + not decoded → labeled pending, never old face.
 */
export function commitFrame(img, item, which) {
  if (!img) return;
  const frame = img.closest('.pool-frame');
  const w = which || img.dataset.which || 'first';

  if (!itemShowsThumb(item, w)) {
    img.removeAttribute('src');
    img.dataset.thumbKey = '';
    img.dataset.pendingKey = '';
    setFrameState(img, frame, 'missing');
    return;
  }

  const url = poolThumbUrl(item, w);
  const key = thumbCacheKey(item, which === undefined ? w : which);
  const prevKey = img.dataset.thumbKey || '';

  if (prevKey === key && img.getAttribute('src') === url && img.complete && img.naturalWidth > 0) {
    img.dataset.pendingKey = '';
    setFrameState(img, frame, 'ready');
    touch(key);
    return;
  }

  if (hasDecoded(key)) {
    if (prevKey && prevKey !== key) img.style.opacity = '0';
    img.dataset.thumbKey = key;
    img.dataset.pendingKey = '';
    if (img.getAttribute('src') !== url) img.src = url;
    setFrameState(img, frame, 'ready');
    touch(key);
    return;
  }

  if (prevKey && prevKey !== key) {
    img.style.opacity = '0';
    noteStaleEnd(img);
  }
  img.dataset.pendingKey = key;
  setFrameState(img, frame, 'pending', pendingLabel(item, w));
  preloadThumb(key, url).then((ok) => {
    if (img.dataset.pendingKey !== key) return;
    if (!ok) {
      img.removeAttribute('src');
      img.dataset.thumbKey = '';
      img.dataset.pendingKey = '';
      setFrameState(img, frame, 'missing');
      return;
    }
    img.dataset.thumbKey = key;
    img.dataset.pendingKey = '';
    if (img.getAttribute('src') !== url) img.src = url;
    setFrameState(img, frame, 'ready');
  });
}

export function commitItemThumbs(card, item) {
  if (!card || !item) return;
  card.querySelectorAll('img.pool-thumb').forEach((img) => {
    commitFrame(img, item, img.dataset.which || 'first');
  });
}

export function preloadItem(item) {
  if (!item) return;
  const cardHint = item._imageOnly ? ['first'] : ['first', 'last'];
  for (const w of cardHint) {
    if (!itemShowsThumb(item, w)) continue;
    preloadThumb(thumbCacheKey(item, w), poolThumbUrl(item, w));
  }
}

export function preloadItems(items) {
  for (const item of items || []) preloadItem(item);
}

export function dropDecodedSizesExcept(keepSize) {
  const keep = String(keepSize || selectedSize()).toUpperCase();
  for (const key of [...cache.keys()]) {
    const parts = key.split(':');
    const sizeTok = parts.length >= 3 ? parts[parts.length - 2] : '';
    if (sizeTok && sizeTok !== keep) {
      const ent = cache.get(key);
      cache.delete(key);
      residentBytes -= ent?.bytes || 0;
      evicted += 1;
    }
  }
}

export function noteVisibleHoles(count) {
  const n = Math.max(0, Number(count) || 0);
  paint.holes = n;
  paint.holeSamples.push(n);
  if (paint.holeSamples.length > 200) paint.holeSamples.shift();
}

function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i];
}

export function decodeCacheStats() {
  return {
    budget_bytes: DECODE_BUDGET_BYTES,
    resident_entries: cache.size,
    resident_bytes: residentBytes,
    evicted,
    inflight: inflight.size,
    preload_pending: preloadQ.length,
    blank_samples: paint.blankMs.length,
    blank_p95_ms: pct(paint.blankMs, 95),
    blank_max_ms: paint.blankMs.length ? Math.max(...paint.blankMs) : 0,
    stale_samples: paint.staleMs.length,
    stale_p95_ms: pct(paint.staleMs, 95),
    stale_max_ms: paint.staleMs.length ? Math.max(...paint.staleMs) : 0,
    holes: paint.holes,
    hole_p95: pct(paint.holeSamples, 95),
  };
}

if (typeof window !== 'undefined') {
  window.__mtapiThumbPaint = decodeCacheStats;
  window.addEventListener('mtapi.settingsChanged', (ev) => {
    const size = ev?.detail?.thumbnailSize;
    if (size) dropDecodedSizesExcept(size);
  });
}
