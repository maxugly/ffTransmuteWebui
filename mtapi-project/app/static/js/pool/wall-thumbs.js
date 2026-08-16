/**
 * Stable wall-preview <img> per clip.
 *
 * Card chrome is recycled. The image node is not.
 * src is assigned once and is never cleared because the user scrolled.
 * All tenants are created up front — no viewport-lazy, no unload.
 */
import { poolThumbUrl, itemShowsThumb, wallPreviewWhich } from '/js/pool/persistence.js';

const tenants = new Map(); // path → HTMLImageElement
let park = null;

function tenantKey(item) {
  if (!item) return '';
  return item.path || '';
}

function wallKind() {
  return wallPreviewWhich();
}

function wallFileReady(item) {
  if (!item) return false;
  const kind = wallKind();
  if (item.thumbs && item.thumbs[kind]) return true;
  if (kind === 'wall_pair') return !!(item.thumbs && item.thumbs.first && item.thumbs.last);
  return !!(item.thumbs && item.thumbs.first);
}

function wallUrl(item) {
  if (!item || !itemShowsThumb(item, 'wall')) return '';
  // Hash-only GET will not extract. Keep path= until first/last (or the
  // wall file) exist so a new import can generate, then switch to hash=.
  if (item.hash && wallFileReady(item)) return poolThumbUrl(item, 'wall');
  if (item.path) {
    const kind = wallKind();
    return `/api/thumbnail?path=${encodeURIComponent(item.path)}&which=${kind}&v=1`;
  }
  if (item.hash) return poolThumbUrl(item, 'wall');
  return '';
}

function _painted(img) {
  return !!(img && img.complete && img.naturalWidth > 0);
}

function getPark() {
  if (park && park.isConnected) return park;
  park = document.getElementById('wall-thumb-park');
  if (!park) {
    park = document.createElement('div');
    park.id = 'wall-thumb-park';
    park.setAttribute('aria-hidden', 'true');
    document.body.appendChild(park);
  }
  return park;
}

function _bindTenantEvents(img) {
  if (img.dataset.wallBound === '1') return;
  img.dataset.wallBound = '1';
  const done = () => {
    const frame = img.closest('.pool-frame');
    if (frame) frame.classList.remove('is-loading');
  };
  img.addEventListener('load', done);
  img.addEventListener('error', done);
}

function getTenant(item) {
  const key = tenantKey(item);
  if (!key) return null;
  let img = tenants.get(key);
  if (!img) {
    img = document.createElement('img');
    img.className = 'pool-thumb';
    img.alt = '';
    img.draggable = false;
    img.decoding = 'async';
    img.loading = 'eager';
    img.dataset.which = 'wall';
    img.dataset.tenantKey = key;
    _bindTenantEvents(img);
    tenants.set(key, img);
    getPark().appendChild(img);
  }
  applyWallSrc(item, img, { force: false });
  return img;
}

function applyWallSrc(item, img, { force = false } = {}) {
  if (!img) img = tenants.get(tenantKey(item));
  if (!img || !item) return;
  const url = wallUrl(item);
  if (!url) return;
  const failed = img.complete && img.naturalWidth === 0 && !!img.dataset.thumbKey;
  const inFlight = !!img.dataset.thumbKey && !img.complete;
  const prev = img.dataset.thumbKey || '';
  const upgrading = prev.includes('path=') && url.includes('hash=');
  if (!force && prev === url && !failed) return;
  if (!force && inFlight && upgrading) return;
  if (!force && _painted(img) && upgrading && !wallFileReady(item)) return;
  const next = (force || failed) && prev.split('&r=')[0] === url
    ? `${url}${url.includes('?') ? '&' : '?'}r=${Date.now()}`
    : url;
  img.src = next;
  img.dataset.thumbKey = url;
}

function forceWallSrc(item) {
  if (!item) return;
  const img = getTenant(item);
  applyWallSrc(item, img, { force: true });
  const frame = img?.closest('.pool-frame');
  if (frame && !_painted(img)) frame.classList.add('is-loading');
}

function refreshWallTenantSrcs() {
  const items = [
    ...(window.state?.pool?.items || []),
    ...(window.state?.imagePool?.items || []),
  ];
  const byPath = new Map(items.filter((it) => it && it.path).map((it) => [it.path, it]));
  for (const [path, img] of tenants) {
    const item = byPath.get(path);
    if (!item) continue;
    applyWallSrc(item, img, { force: false });
  }
}

function attachWallTenant(card, item) {
  const frame = card?.querySelector('.pool-frame');
  if (!frame || !item) return;
  const img = getTenant(item);
  if (!img) return;
  if (img.parentNode !== frame) frame.appendChild(img);
  if (img.complete && img.naturalWidth > 0) frame.classList.remove('is-loading');
  else frame.classList.add('is-loading');
}

function detachWallTenant(card) {
  if (!card) return;
  card.querySelectorAll('img.pool-thumb').forEach((img) => {
    if (img.dataset.thumbKey) getPark().appendChild(img);
  });
}

function prepareWallTenants(items) {
  if (!items || !items.length) return;
  for (const item of items) {
    if (item) getTenant(item);
  }
}

function dropWallTenant(key) {
  if (!key) return;
  const img = tenants.get(key);
  if (!img) return;
  tenants.delete(key);
  if (img.parentNode) img.parentNode.removeChild(img);
}

function wallTenantStats() {
  return { tenants: tenants.size, parked: getPark().childElementCount };
}

if (typeof window !== 'undefined') {
  window.__mtapiWallThumbs = {
    prepareWallTenants, attachWallTenant, detachWallTenant, dropWallTenant,
    refreshWallTenantSrcs, forceWallSrc, wallTenantStats,
  };
  window.addEventListener('mtapi.settingsChanged', () => {
    try { refreshWallTenantSrcs(); } catch (_) { /* ignore */ }
  });
}

export {
  prepareWallTenants,
  attachWallTenant,
  detachWallTenant,
  dropWallTenant,
  refreshWallTenantSrcs,
  forceWallSrc,
  wallTenantStats,
};
