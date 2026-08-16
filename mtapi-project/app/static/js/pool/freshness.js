/**
 * File-signature freshness helpers for both media pools.
 *
 * Restore is cache-first: existing records reuse path + filename + filesize
 * and never hit /api/media_signature. Validation is targeted (retry, missing
 * identity, optional lazy mode) and goes through the batch queue.
 *
 * Thumb assignment is assign-once: each <img> gets its URL at mount time via
 * assignThumbSrc (native loading=lazy) guarded by data-thumbKey so a card
 * never reassigns or clears its src on scroll.
 */
import { state } from '/app.js';
import { poolThumbUrl, itemShowsThumb } from '/js/pool/persistence.js';
import { enqueueSignature, assignThumbSrc } from '/js/lazy-loader.js';
import { globalMediaIndex } from '/js/media-index.js';

function signaturesEqual(a, b) {
  if (!a || !b) return false;
  return Number(a.size) === Number(b.size) && Number(a.mtime_ns) === Number(b.mtime_ns);
}

/**
 * Cheap restored identity: persisted path + filename + filesize plus cached
 * payload (hash and/or meta). Startup/project switch trusts this without
 * stating the file.
 */
function hasRestoredIdentity(item) {
  if (!item || !item.path) return false;
  // Hash or persisted probe is enough. Do not re-stat/re-probe for display.
  return !!(item.hash || item.meta);
}

function applySignature(item, sig) {
  if (!sig) return;
  item.meta_signature = { size: Number(sig.size), mtime_ns: Number(sig.mtime_ns) };
}

async function fetchMediaSignature(path) {
  if (!path) return null;
  return enqueueSignature(path);
}

/**
 * Compare stored meta_signature to disk via the batch endpoint.
 * Not used for ordinary restore of existing records.
 */
async function validateItemSignature(item, { force = false } = {}) {
  const sig = await fetchMediaSignature(item.path);
  if (!sig) {
    return { stale: true, missing: true, signature: null };
  }
  const prev = item.meta_signature;
  const stale = force || !prev || !signaturesEqual(prev, sig);
  if (stale) {
    item.meta = null;
    item.metaError = null;
    try { globalMediaIndex.invalidate(item); } catch (_) { /* ignore */ }
  }
  applySignature(item, sig);
  if (item.size == null && sig.size != null) item.size = sig.size;
  return { stale, missing: false, signature: item.meta_signature };
}

/**
 * Targeted hash recovery when cheap identity fails (moved/changed file).
 */
async function recoverItemByHash(item) {
  const hash = item?.hash || item?.meta?.hash;
  if (!hash && !item?.path) return null;
  try {
    const res = await fetch('/api/media/recover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hash: hash || null,
        last_path: item.path || null,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.found || !data.path) return null;
    if (data.path !== item.path) {
      item.path = data.path;
    }
    if (data.hash) item.hash = data.hash;
    try { globalMediaIndex.put(item); } catch (_) { /* ignore */ }
    return data;
  } catch (_) {
    return null;
  }
}

function thumbUrlWithBust(item, which, mtimeNs) {
  let url = poolThumbUrl(item, which);
  if (mtimeNs != null && Number.isFinite(Number(mtimeNs))) {
    url += (url.includes('?') ? '&' : '?') + `m=${mtimeNs}`;
  }
  return url;
}

/**
 * Assign thumb URLs to a card's <img> elements using assign-once semantics.
 * Each img is assigned at most once per card lifetime (guarded by data-thumbKey).
 * When the item hash is discovered later (path→hash URL upgrade), reloadImageCardThumbs
 * handles the transition via the standard assignThumbSrc path.
 */
function assignCardThumbs(card, item, { bust = false } = {}) {
  if (!card || !item) return;
  card.querySelectorAll('img.pool-thumb').forEach((img) => {
    const which = img.dataset.which || 'first';
    if (which === 'wall' || which === 'wall_pair') return;
    if (!itemShowsThumb(item, which)) {
      img.removeAttribute('src');
      img.dataset.thumbKey = '';
      return;
    }
    let url = poolThumbUrl(item, which);
    if (bust) url = thumbUrlWithBust(item, which);
    // Assign-once guard: never reassign or clear src already pointing at this URL.
    if (img.dataset.thumbKey === url) return;
    if (img.getAttribute('src') === url) {
      img.dataset.thumbKey = url;
      return;
    }
    assignThumbSrc(img, url);
    img.dataset.thumbKey = url;
  });
}

function refreshAssignedPoolThumbs() {
  document.querySelectorAll('.pool-card, .img-pool-card').forEach((card) => {
    const path = card.dataset.path;
    if (!path) return;
    const item = (state.pool?.items || []).find((i) => i.path === path)
      || (state.imagePool?.items || []).find((i) => i.path === path);
    if (!item) return;
    assignCardThumbs(card, item, { bust: false });
  });
}

function metaRetryHtml(error) {
  const msg = String(error || 'probe failed')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return `<span class="pool-meta-error">${msg}</span>`
    + `<button type="button" class="btn pool-info-mini pool-retry-meta">Retry Metadata</button>`;
}

export {
  fetchMediaSignature,
  validateItemSignature,
  hasRestoredIdentity,
  recoverItemByHash,
  assignCardThumbs,
  refreshAssignedPoolThumbs,
  thumbUrlWithBust,
  metaRetryHtml,
};
