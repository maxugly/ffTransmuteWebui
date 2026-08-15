/**
 * Browser decode-ready thumbnail cache for Video and Image Pool.
 *
 * Holds fetched JPEG blobs as object URLs after an offscreen Image.decode().
 * Visible <img> elements are assigned that object URL only after decode.
 * 128 MiB estimated-RGBA LRU; not the server 64 MiB JPEG cache.
 *
 * Placeholder chrome is for jump-to-unseen only. Ordinary scroll must not
 * hide a known thumb or reassign a card before the replacement is ready.
 */
import { state } from '/app.js';
import { poolThumbUrl, itemShowsThumb } from '/js/pool/persistence.js';

export const DECODE_BUDGET_BYTES = 128 * 1024 * 1024;
const PRELOAD_CONCURRENT = 8;

/** @type {Map<string, { objectUrl: string, bytes: number, lastUsed: number, w: number, h: number }>} */
const cache = new Map();
const inflight = new Map();
const decodedListeners = new Set();
let residentBytes = 0;
let evicted = 0;
let preloadActive = 0;
const preloadQ = [];

const paint = {
  blankMs: [],
  staleMs: [],
  holes: 0,
  holeSamples: [],
  blankOpen: new Map(),
  staleOpen: new Map(),
  pendingOrdinary: 0,
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

function urlInUse(objectUrl) {
  if (!objectUrl) return false;
  const imgs = document.querySelectorAll('img.pool-thumb');
  for (const img of imgs) {
    if (img.getAttribute('src') === objectUrl) return true;
  }
  return false;
}

function evictToFit(needed) {
  while (residentBytes + needed > DECODE_BUDGET_BYTES && cache.size) {
    let oldestKey = null;
    let oldestT = Infinity;
    for (const [k, v] of cache) {
      if (urlInUse(v.objectUrl)) continue;
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
    try { if (gone?.objectUrl) URL.revokeObjectURL(gone.objectUrl); } catch (_) { /* ignore */ }
  }
}

export function hasDecoded(key) {
  const ent = cache.get(key);
  return !!(ent && ent.objectUrl);
}

export function decodedObjectUrl(key) {
  const ent = cache.get(key);
  if (!ent) return null;
  touch(key);
  return ent.objectUrl;
}

export function neededThumbSlots(item) {
  const out = [];
  if (itemShowsThumb(item, 'first')) out.push('first');
  if (itemShowsThumb(item, 'last')) out.push('last');
  return out;
}

/** True when every known-available first/last slot has a decoded blob. */
export function itemDisplayReady(item) {
  if (!item) return false;
  const slots = neededThumbSlots(item);
  if (!slots.length) return true;
  return slots.every((w) => hasDecoded(thumbCacheKey(item, w)));
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

export function onThumbDecoded(fn) {
  if (typeof fn !== 'function') return () => {};
  decodedListeners.add(fn);
  return () => decodedListeners.delete(fn);
}

function notifyDecoded(key) {
  decodedListeners.forEach((fn) => {
    try { fn(key); } catch (_) { /* ignore */ }
  });
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
      run: () => loadBlobDecoded(key, url).then(resolve),
    });
    drainPreload();
  });
  inflight.set(key, p);
  p.finally(() => {
    if (inflight.get(key) === p) inflight.delete(key);
  });
  return p;
}

async function loadBlobDecoded(key, url) {
  try {
    const res = await fetch(url, { cache: 'force-cache' });
    if (!res.ok) return false;
    const blob = await res.blob();
    if (!blob || blob.size < 8) return false;
    const objectUrl = URL.createObjectURL(blob);
    const im = new Image();
    im.src = objectUrl;
    try {
      if (typeof im.decode === 'function') await im.decode();
      else await new Promise((resolve, reject) => {
        im.onload = resolve;
        im.onerror = reject;
      });
    } catch (_) {
      if (!im.naturalWidth) {
        try { URL.revokeObjectURL(objectUrl); } catch (__) { /* ignore */ }
        return false;
      }
    }
    if (!im.naturalWidth) {
      try { URL.revokeObjectURL(objectUrl); } catch (_) { /* ignore */ }
      return false;
    }
    const bytes = estimateBytes(im);
    evictToFit(bytes);
    const prev = cache.get(key);
    if (prev) {
      residentBytes -= prev.bytes;
      if (prev.objectUrl && prev.objectUrl !== objectUrl) {
        try { URL.revokeObjectURL(prev.objectUrl); } catch (_) { /* ignore */ }
      }
    }
    cache.set(key, {
      objectUrl,
      bytes,
      lastUsed: performance.now(),
      w: im.naturalWidth,
      h: im.naturalHeight,
    });
    residentBytes += bytes;
    notifyDecoded(key);
    return true;
  } catch (_) {
    return false;
  }
}

export function preloadItem(item) {
  if (!item) return;
  for (const w of neededThumbSlots(item)) {
    preloadThumb(thumbCacheKey(item, w), poolThumbUrl(item, w));
  }
}

export function preloadItems(items) {
  for (const item of items || []) preloadItem(item);
}

/**
 * Assign a already-decoded object URL to a visible or parked img.
 * Returns true only if the img is loaded+decoded after the assignment.
 */
export function applyDecodedSrc(img, key) {
  if (!img || !key) return false;
  const url = decodedObjectUrl(key);
  if (!url) return false;
  if (img.getAttribute('src') !== url) img.src = url;
  img.dataset.thumbKey = key;
  img.style.opacity = '';
  const frame = img.closest('.pool-frame');
  if (frame) {
    frame.classList.remove('is-pending', 'is-missing');
    frame.removeAttribute('data-pending-label');
  }
  return !!(img.complete && img.naturalWidth > 0);
}

function pendingLabel(item, which) {
  const name = item?.name || (item?.path || '').split('/').pop() || 'Loading';
  const tag = which === 'last' ? 'LAST' : (which === 'first' ? 'FIRST' : '');
  return tag ? `${name} · ${tag}` : name;
}

/** Offscreen / jump-only: strip any previous clip pixels, show labeled pending. */
export function applyPlaceholderFrame(img, item, which) {
  if (!img) return;
  const frame = img.closest('.pool-frame');
  img.removeAttribute('src');
  img.dataset.thumbKey = '';
  img.dataset.pendingKey = '';
  img.style.opacity = '';
  if (frame) {
    frame.classList.add('is-pending');
    frame.classList.remove('is-missing');
    frame.setAttribute('data-pending-label', pendingLabel(item, which));
  }
}

export function applyMissingFrame(img) {
  if (!img) return;
  const frame = img.closest('.pool-frame');
  img.removeAttribute('src');
  img.dataset.thumbKey = '';
  img.style.opacity = '';
  if (frame) {
    frame.classList.remove('is-pending');
    frame.classList.add('is-missing');
    frame.removeAttribute('data-pending-label');
  }
}

/** Apply decoded blobs to every known slot. Must be called while the card is offscreen if identity is changing. */
export function commitReadyThumbs(card, item) {
  if (!card || !item) return false;
  let ok = true;
  card.querySelectorAll('img.pool-thumb').forEach((img) => {
    const w = img.dataset.which || 'first';
    if (!itemShowsThumb(item, w)) {
      applyMissingFrame(img);
      return;
    }
    const key = thumbCacheKey(item, w);
    if (!applyDecodedSrc(img, key)) ok = false;
  });
  return ok;
}

export function commitPlaceholderThumbs(card, item) {
  if (!card || !item) return;
  card.querySelectorAll('img.pool-thumb').forEach((img) => {
    const w = img.dataset.which || 'first';
    if (!itemShowsThumb(item, w)) {
      applyMissingFrame(img);
      return;
    }
    applyPlaceholderFrame(img, item, w);
  });
}

export function thumbsPaintedFor(card, item) {
  if (!card || !item) return false;
  const imgs = card.querySelectorAll('img.pool-thumb');
  if (!imgs.length) return false;
  for (const img of imgs) {
    const w = img.dataset.which || 'first';
    if (!itemShowsThumb(item, w)) continue;
    const frame = img.closest('.pool-frame');
    if (frame?.classList.contains('is-pending') || frame?.classList.contains('is-missing')) return false;
    if (img.style.opacity === '0') return false;
    if (!img.getAttribute('src') || !img.complete || img.naturalWidth <= 0) return false;
    const key = thumbCacheKey(item, w);
    if ((img.dataset.thumbKey || '') !== key) return false;
  }
  return true;
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
      try { if (ent?.objectUrl) URL.revokeObjectURL(ent.objectUrl); } catch (_) { /* ignore */ }
    }
  }
}

function pushMs(arr, ms) {
  arr.push(ms);
  if (arr.length > 500) arr.splice(0, arr.length - 500);
}

/**
 * Sample actually visible cards. Counts blank (known thumb not showing pixels)
 * and stale (pixels do not match card hash/key).
 */
export function sampleVisibleThumbs(wrap) {
  if (!wrap || !wrap.getBoundingClientRect) return;
  const wr = wrap.getBoundingClientRect();
  const now = performance.now();
  wrap.querySelectorAll('.pool-card, .img-pool-card').forEach((card) => {
    const tf = card.style.transform || '';
    if (tf.includes('-10000px')) return;
    const cr = card.getBoundingClientRect();
    if (cr.bottom < wr.top || cr.top > wr.bottom || cr.width < 2) return;
    const hash = card.dataset.hash || '';
    card.querySelectorAll('img.pool-thumb').forEach((img) => {
      const frame = img.closest('.pool-frame');
      const missing = frame?.classList.contains('is-missing');
      if (missing) {
        paint.blankOpen.delete(img);
        paint.staleOpen.delete(img);
        return;
      }
      const pending = frame?.classList.contains('is-pending');
      const hidden = img.style.opacity === '0';
      const src = img.getAttribute('src') || '';
      const shown = !hidden && !pending && src && img.complete && img.naturalWidth > 0;
      const id = img.dataset.thumbKey || src || 'img';
      if (!shown) {
        if (!paint.blankOpen.has(img)) paint.blankOpen.set(img, now);
        paint.pendingOrdinary += pending ? 1 : 0;
      } else {
        const t0 = paint.blankOpen.get(img);
        if (t0 != null) {
          pushMs(paint.blankMs, now - t0);
          paint.blankOpen.delete(img);
        }
      }
      const key = img.dataset.thumbKey || '';
      const stale = shown && hash && key && !key.startsWith(`${hash}:`);
      if (stale) {
        if (!paint.staleOpen.has(img)) paint.staleOpen.set(img, now);
      } else {
        const t1 = paint.staleOpen.get(img);
        if (t1 != null) {
          pushMs(paint.staleMs, now - t1);
          paint.staleOpen.delete(img);
        }
      }
    });
  });
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
  const openBlank = [];
  paint.blankOpen.forEach((t0) => openBlank.push(performance.now() - t0));
  const openStale = [];
  paint.staleOpen.forEach((t0) => openStale.push(performance.now() - t0));
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
    blank_open: paint.blankOpen.size,
    blank_open_max_ms: openBlank.length ? Math.max(...openBlank) : 0,
    stale_samples: paint.staleMs.length,
    stale_p95_ms: pct(paint.staleMs, 95),
    stale_max_ms: paint.staleMs.length ? Math.max(...paint.staleMs) : 0,
    stale_open: paint.staleOpen.size,
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
