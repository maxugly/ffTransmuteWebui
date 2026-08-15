/**
 * Authoritative in-memory catalog index.
 *
 * Primary identity is the canonical absolute path. Content hashes are a
 * secondary map (one hash → many paths) so duplicate files and moved-file
 * recovery stay independent of display.
 *
 * Display reads this index. Repair writes it. Hover / scroll / select never
 * mutate readiness by fetching.
 */

const RESOURCE_STATUSES = new Set(['known', 'missing', 'queued', 'repairing', 'failed']);
const SIGNATURE_STATUSES = new Set(['known', 'missing', 'stale', 'queued', 'repairing', 'failed']);
const THUMB_STATUSES = new Set(['available', 'missing', 'queued', 'repairing', 'failed']);
const THUMB_SIZES = ['L', 'M', 'H'];
const THUMB_WHICH = ['first', 'last'];

function normalizeAbsPath(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  if (!s) return '';
  s = s.replace(/\\/g, '/');
  const isAbs = s.startsWith('/');
  const parts = [];
  for (const seg of s.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (parts.length) parts.pop();
      continue;
    }
    parts.push(seg);
  }
  const joined = parts.join('/');
  return isAbs ? `/${joined}` : joined;
}

function fallbackKey(path, size, mtimeNs) {
  const p = normalizeAbsPath(path);
  if (!p || size == null || mtimeNs == null) return '';
  return `${p}_${Number(size)}_${Number(mtimeNs)}`;
}

function _thumbSlot() {
  return { L: 'missing', M: 'missing', H: 'missing' };
}

function emptyRecord(canonicalPath) {
  return {
    identity: { canonical_path: canonicalPath },
    hash_state: { hash: null, status: 'missing' },
    signature_state: { size: null, mtime_ns: null, status: 'missing' },
    metadata_state: { meta: null, status: 'missing' },
    variants_state: { variants: null, status: 'missing' },
    thumbnails_state: {
      first: _thumbSlot(),
      last: _thumbSlot(),
    },
    repair_errors: [],
    name: null,
    _searchString: '',
  };
}

function _normStatus(value, allowed, fallback) {
  const s = String(value || '').toLowerCase();
  return allowed.has(s) ? s : fallback;
}

function currentThumbSize() {
  try {
    const s = String(window.state?.settings?.thumbnailSize || 'H').toUpperCase();
    return THUMB_SIZES.includes(s) ? s : 'H';
  } catch (_) {
    return 'H';
  }
}

function computeSearchString(item, rec) {
  const meta = rec?.metadata_state?.meta || item?.meta || {};
  const hash = rec?.hash_state?.hash || item?.hash || meta.hash || '';
  const tags = Array.isArray(item?.tags) ? item.tags : [];
  return [
    item?.name || rec?.name,
    rec?.identity?.canonical_path || item?.path,
    hash,
    meta.hash,
    meta.video_codec,
    meta.audio_codec,
    meta.width && meta.height ? `${meta.width}x${meta.height}` : '',
    meta.fps != null ? String(meta.fps) : '',
    tags.join(' '),
  ].filter(Boolean).join(' ').toLowerCase();
}

function _thumbFromItem(item, which) {
  const w = which || 'first';
  const failed = item?.thumbsFailed || item?.thumbs_failed || {};
  if (failed[w]) return 'failed';
  if (item?.thumbs && item.thumbs[w] === false) return 'missing';
  if (item?.thumbs && item.thumbs[w] === true) return 'available';
  // Hash-known thumbs are displayable at any size (L/M may serve H)
  // unless the record explicitly says they are absent.
  if (item?.hash && failed[w] !== true && item?.thumbs?.[w] !== false) return 'available';
  return 'missing';
}

class GlobalMediaIndex {
  constructor() {
    /** @type {Map<string, object>} canonical path → record */
    this.byPath = new Map();
    /** @type {Map<string, object>} content hash → first record (compat) */
    this.byHash = new Map();
    /** @type {Map<string, string>} path_size_mtime → canonical path */
    this.byFallback = new Map();
    /** @type {Map<string, Set<string>>} hash → canonical paths */
    this.hashToPaths = new Map();
  }

  _rememberHash(hash, path) {
    if (!hash || !path) return;
    let set = this.hashToPaths.get(hash);
    if (!set) {
      set = new Set();
      this.hashToPaths.set(hash, set);
    }
    set.add(path);
    this.byHash.set(hash, this.byPath.get(path) || this.byHash.get(hash));
  }

  _forgetHash(hash, path) {
    if (!hash) return;
    const set = this.hashToPaths.get(hash);
    if (set) {
      set.delete(path);
      if (!set.size) this.hashToPaths.delete(hash);
    }
    if (this.byHash.get(hash)?.identity?.canonical_path === path) {
      const next = set && set.size ? this.byPath.get([...set][0]) : null;
      if (next) this.byHash.set(hash, next);
      else this.byHash.delete(hash);
    }
  }

  get(itemOrHashOrPath) {
    if (!itemOrHashOrPath) return null;
    if (typeof itemOrHashOrPath === 'string') {
      const key = normalizeAbsPath(itemOrHashOrPath);
      if (this.byPath.has(key)) return this.byPath.get(key);
      if (this.byHash.has(itemOrHashOrPath)) return this.byHash.get(itemOrHashOrPath);
      return null;
    }
    const path = normalizeAbsPath(itemOrHashOrPath.path || itemOrHashOrPath.identity?.canonical_path);
    if (path && this.byPath.has(path)) return this.byPath.get(path);
    const hash = itemOrHashOrPath.hash || itemOrHashOrPath.meta?.hash || itemOrHashOrPath.hash_state?.hash;
    if (hash && this.byHash.has(hash)) return this.byHash.get(hash);
    const k = fallbackKey(
      path || itemOrHashOrPath.path,
      itemOrHashOrPath.size ?? itemOrHashOrPath.meta?.size ?? itemOrHashOrPath.signature_state?.size,
      itemOrHashOrPath.meta_signature?.mtime_ns ?? itemOrHashOrPath.signature_state?.mtime_ns,
    );
    if (k && this.byFallback.has(k)) {
      const p = this.byFallback.get(k);
      return this.byPath.get(p) || null;
    }
    return null;
  }

  ensure(path) {
    const canonical = normalizeAbsPath(path);
    if (!canonical) return null;
    let rec = this.byPath.get(canonical);
    if (!rec) {
      rec = emptyRecord(canonical);
      this.byPath.set(canonical, rec);
    }
    return rec;
  }

  put(item) {
    if (!item) return null;
    const canonical = normalizeAbsPath(item.path || item.identity?.canonical_path);
    if (!canonical) return null;
    const rec = this.ensure(canonical);
    rec.name = item.name || rec.name || null;

    const hash = item.hash || item.meta?.hash || rec.hash_state.hash;
    if (hash) {
      if (rec.hash_state.hash && rec.hash_state.hash !== hash) {
        this._forgetHash(rec.hash_state.hash, canonical);
      }
      rec.hash_state.hash = hash;
      rec.hash_state.status = 'known';
      this._rememberHash(hash, canonical);
    } else if (rec.hash_state.status === 'known' && rec.hash_state.hash) {
      // keep
    } else if (rec.hash_state.status !== 'failed' && rec.hash_state.status !== 'queued' && rec.hash_state.status !== 'repairing') {
      rec.hash_state.status = 'missing';
    }

    const size = item.size ?? item.meta?.size ?? item.meta_signature?.size ?? rec.signature_state.size;
    const mtime = item.meta_signature?.mtime_ns ?? rec.signature_state.mtime_ns;
    if (size != null) rec.signature_state.size = Number(size);
    if (mtime != null) rec.signature_state.mtime_ns = Number(mtime);
    if (item.meta_signature && size != null && mtime != null) {
      rec.signature_state.status = 'known';
      const k = fallbackKey(canonical, size, mtime);
      if (k) this.byFallback.set(k, canonical);
    }

    if (item.meta && typeof item.meta === 'object') {
      rec.metadata_state.meta = item.meta;
      rec.metadata_state.status = 'known';
    } else if (item.metaError && rec.metadata_state.status !== 'known') {
      rec.metadata_state.status = 'failed';
      if (!rec.repair_errors.includes(String(item.metaError))) {
        rec.repair_errors.push(String(item.metaError));
      }
    } else if (rec.metadata_state.status !== 'known'
      && rec.metadata_state.status !== 'failed'
      && rec.metadata_state.status !== 'queued'
      && rec.metadata_state.status !== 'repairing') {
      rec.metadata_state.status = 'missing';
    }

    if (item.variants && typeof item.variants === 'object') {
      rec.variants_state.variants = item.variants;
      rec.variants_state.status = 'known';
    }

    for (const which of THUMB_WHICH) {
      const st = _thumbFromItem(item, which);
      for (const sizeKey of THUMB_SIZES) {
        if (st === 'available' || st === 'failed') {
          rec.thumbnails_state[which][sizeKey] = st;
        } else if (rec.thumbnails_state[which][sizeKey] !== 'available'
          && rec.thumbnails_state[which][sizeKey] !== 'failed'
          && rec.thumbnails_state[which][sizeKey] !== 'queued'
          && rec.thumbnails_state[which][sizeKey] !== 'repairing') {
          rec.thumbnails_state[which][sizeKey] = 'missing';
        }
      }
    }

    rec._searchString = computeSearchString(item, rec);
    if (item && item.path) item._searchString = rec._searchString;
    return rec;
  }

  applyHash(path, hash, { status = 'known' } = {}) {
    const rec = this.ensure(path);
    if (!rec) return null;
    const canonical = rec.identity.canonical_path;
    if (rec.hash_state.hash && rec.hash_state.hash !== hash) {
      this._forgetHash(rec.hash_state.hash, canonical);
    }
    rec.hash_state.hash = hash || rec.hash_state.hash;
    rec.hash_state.status = _normStatus(status, RESOURCE_STATUSES, rec.hash_state.status);
    if (rec.hash_state.hash && rec.hash_state.status === 'known') {
      this._rememberHash(rec.hash_state.hash, canonical);
    }
    rec._searchString = computeSearchString({ path: canonical, name: rec.name, hash: rec.hash_state.hash }, rec);
    return rec;
  }

  applyMeta(path, meta, { status = 'known', error = null } = {}) {
    const rec = this.ensure(path);
    if (!rec) return null;
    if (meta && typeof meta === 'object') rec.metadata_state.meta = meta;
    rec.metadata_state.status = _normStatus(status, RESOURCE_STATUSES, rec.metadata_state.status);
    if (error) rec.repair_errors.push(String(error));
    rec._searchString = computeSearchString({ path: rec.identity.canonical_path, name: rec.name, hash: rec.hash_state.hash, meta }, rec);
    return rec;
  }

  applySignature(path, sig, { status = 'known' } = {}) {
    const rec = this.ensure(path);
    if (!rec) return null;
    if (sig) {
      if (sig.size != null) rec.signature_state.size = Number(sig.size);
      if (sig.mtime_ns != null) rec.signature_state.mtime_ns = Number(sig.mtime_ns);
    }
    rec.signature_state.status = _normStatus(status, SIGNATURE_STATUSES, rec.signature_state.status);
    if (rec.signature_state.size != null && rec.signature_state.mtime_ns != null) {
      const k = fallbackKey(rec.identity.canonical_path, rec.signature_state.size, rec.signature_state.mtime_ns);
      if (k) this.byFallback.set(k, rec.identity.canonical_path);
    }
    return rec;
  }

  applyVariants(path, variants, { status = 'known' } = {}) {
    const rec = this.ensure(path);
    if (!rec) return null;
    if (variants && typeof variants === 'object') rec.variants_state.variants = variants;
    rec.variants_state.status = _normStatus(status, RESOURCE_STATUSES, rec.variants_state.status);
    return rec;
  }

  applyThumb(path, which, size, status) {
    const rec = this.ensure(path);
    if (!rec) return null;
    const w = which === 'last' ? 'last' : 'first';
    const sizes = size ? [String(size).toUpperCase()] : THUMB_SIZES;
    const st = _normStatus(status, THUMB_STATUSES, 'missing');
    for (const s of sizes) {
      if (THUMB_SIZES.includes(s)) rec.thumbnails_state[w][s] = st;
    }
    return rec;
  }

  setResourceStatus(path, kind, status, error) {
    const rec = this.ensure(path);
    if (!rec) return null;
    const allowed = kind === 'signature' ? SIGNATURE_STATUSES : RESOURCE_STATUSES;
    const st = _normStatus(status, allowed, 'missing');
    if (kind === 'hash') rec.hash_state.status = st;
    else if (kind === 'signature') rec.signature_state.status = st;
    else if (kind === 'metadata') rec.metadata_state.status = st;
    else if (kind === 'variants') rec.variants_state.status = st;
    if (error) rec.repair_errors.push(String(error));
    return rec;
  }

  pathsForHash(hash) {
    if (!hash) return [];
    const set = this.hashToPaths.get(hash);
    return set ? [...set] : [];
  }

  recoverPathByHash(hash) {
    const paths = this.pathsForHash(hash);
    return paths[0] || null;
  }

  invalidate(itemOrHash) {
    if (!itemOrHash) return;
    if (typeof itemOrHash === 'string') {
      if (this.byPath.has(itemOrHash) || this.byPath.has(normalizeAbsPath(itemOrHash))) {
        const path = this.byPath.has(itemOrHash) ? itemOrHash : normalizeAbsPath(itemOrHash);
        const rec = this.byPath.get(path);
        this.byPath.delete(path);
        if (rec?.hash_state?.hash) this._forgetHash(rec.hash_state.hash, path);
        return;
      }
      const rec = this.byHash.get(itemOrHash);
      this.byHash.delete(itemOrHash);
      const set = this.hashToPaths.get(itemOrHash);
      if (set) {
        for (const p of set) {
          const r = this.byPath.get(p);
          if (r) {
            r.hash_state.hash = null;
            r.hash_state.status = 'missing';
          }
        }
        this.hashToPaths.delete(itemOrHash);
      }
      if (rec) {
        const k = fallbackKey(rec.identity?.canonical_path, rec.signature_state?.size, rec.signature_state?.mtime_ns);
        if (k) this.byFallback.delete(k);
      }
      return;
    }
    const path = normalizeAbsPath(itemOrHash.path);
    if (path) {
      const rec = this.byPath.get(path);
      this.byPath.delete(path);
      const hash = itemOrHash.hash || rec?.hash_state?.hash;
      if (hash) this._forgetHash(hash, path);
    }
  }

  seed(items) {
    for (const it of items || []) this.put(it);
  }

  refreshSearchString(item) {
    const rec = this.get(item);
    const s = computeSearchString(item, rec);
    if (rec) rec._searchString = s;
    if (item) item._searchString = s;
    return s;
  }

  thumbsReadyAtSize(rec, size) {
    if (!rec) return false;
    const s = String(size || currentThumbSize()).toUpperCase();
    const first = rec.thumbnails_state.first[s];
    const last = rec.thumbnails_state.last[s];
    return first === 'available' && last === 'available';
  }

  recordHasMissing(rec, size) {
    if (!rec) return true;
    const s = String(size || currentThumbSize()).toUpperCase();
    if (rec.hash_state.status === 'missing') return true;
    if (rec.metadata_state.status === 'missing') return true;
    if (rec.thumbnails_state.first[s] === 'missing') return true;
    if (rec.thumbnails_state.last[s] === 'missing') return true;
    return false;
  }

  recordHasStatus(rec, status) {
    if (!rec) return false;
    if (rec.hash_state.status === status) return true;
    if (rec.signature_state.status === status) return true;
    if (rec.metadata_state.status === status) return true;
    if (rec.variants_state.status === status) return true;
    for (const which of THUMB_WHICH) {
      for (const s of THUMB_SIZES) {
        if (rec.thumbnails_state[which][s] === status) return true;
      }
    }
    return false;
  }

  catalogCounts(items, size) {
    const sz = String(size || currentThumbSize()).toUpperCase();
    const out = {
      restored: 0,
      knownMetadata: 0,
      knownThumbnails: 0,
      missing: 0,
      queued: 0,
      repairing: 0,
      failed: 0,
    };
    const list = items || [];
    out.restored = list.length;
    for (const it of list) {
      const rec = this.get(it) || this.put(it);
      if (!rec) continue;
      if (rec.metadata_state.status === 'known') out.knownMetadata += 1;
      if (this.thumbsReadyAtSize(rec, sz)) out.knownThumbnails += 1;
      if (this.recordHasMissing(rec, sz)) out.missing += 1;
      if (this.recordHasStatus(rec, 'queued')) out.queued += 1;
      if (this.recordHasStatus(rec, 'repairing')) out.repairing += 1;
      if (this.recordHasStatus(rec, 'failed') || rec.thumbnails_state.first[sz] === 'failed'
        || rec.thumbnails_state.last[sz] === 'failed') {
        out.failed += 1;
      }
    }
    return out;
  }

  stats() {
    return {
      hashes: this.byHash.size,
      fallbacks: this.byFallback.size,
      paths: this.byPath.size,
      hashMappings: this.hashToPaths.size,
    };
  }
}

const index = new GlobalMediaIndex();

if (typeof window !== 'undefined') {
  window.globalMediaIndex = index;
  window.hashToPaths = index.hashToPaths;
  window.normalizeAbsPath = normalizeAbsPath;
}

export {
  index as globalMediaIndex,
  normalizeAbsPath,
  fallbackKey,
  GlobalMediaIndex,
  computeSearchString,
  currentThumbSize,
  THUMB_SIZES,
  THUMB_WHICH,
};
