/**
 * File-signature freshness helpers for both media pools.
 *
 * On viewport entry the caller fetches /api/media_signature (no ffmpeg).
 * A missing or changed signature clears meta so /api/media_info can run.
 * Unchanged metaError is not retried unless the user clicks Retry Metadata.
 */
import { state } from '/app.js';
import { poolThumbUrl } from '/js/pool/persistence.js';

const _sigInflight = new Map();

function signaturesEqual(a, b) {
  if (!a || !b) return false;
  return Number(a.size) === Number(b.size) && Number(a.mtime_ns) === Number(b.mtime_ns);
}

async function fetchMediaSignature(path) {
  if (!path) return null;
  if (_sigInflight.has(path)) return _sigInflight.get(path);
  const job = fetch(`/api/media_signature?path=${encodeURIComponent(path)}`)
    .then(async (res) => {
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    })
    .finally(() => _sigInflight.delete(path));
  _sigInflight.set(path, job);
  return job;
}

function applySignature(item, sig) {
  if (!sig) return;
  item.meta_signature = { size: Number(sig.size), mtime_ns: Number(sig.mtime_ns) };
}

/**
 * Compare stored meta_signature to disk.
 * Stale/null signatures clear meta + metaError so the caller can re-probe.
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
  }
  applySignature(item, sig);
  return { stale, missing: false, signature: item.meta_signature };
}

function thumbUrlWithBust(item, which, mtimeNs) {
  let url = poolThumbUrl(item, which);
  if (mtimeNs != null && Number.isFinite(Number(mtimeNs))) {
    url += (url.includes('?') ? '&' : '?') + `m=${mtimeNs}`;
  }
  return url;
}

function assignCardThumbs(card, item, { bust = false } = {}) {
  if (!card) return;
  const m = bust ? item.meta_signature?.mtime_ns : null;
  card.querySelectorAll('img.pool-thumb').forEach((img) => {
    const which = img.dataset.which || 'first';
    img.src = thumbUrlWithBust(item, which, m);
  });
}

function refreshAssignedPoolThumbs() {
  document.querySelectorAll('img.pool-thumb[src]').forEach((img) => {
    const card = img.closest('.pool-card, .img-pool-card');
    if (!card) return;
    const path = card.dataset.path;
    const item = (state.pool?.items || []).find((i) => i.path === path)
      || (state.imagePool?.items || []).find((i) => i.path === path);
    if (!item) return;
    const which = img.dataset.which || 'first';
    const m = item.meta_signature?.mtime_ns;
    img.src = thumbUrlWithBust(item, which, m);
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
  assignCardThumbs,
  refreshAssignedPoolThumbs,
  thumbUrlWithBust,
  metaRetryHtml,
};
