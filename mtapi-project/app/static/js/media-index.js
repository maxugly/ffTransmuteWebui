/**
 * RAM index of already-loaded pool records.
 *
 * Not a second source of truth — the persistent media cache / project JSON is.
 * This map only speeds lookups for records the desk already restored.
 *
 * Primary key: content hash.
 * Fallback: normalized absolute path + size + mtime_ns.
 */
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

function recordFromItem(item) {
  if (!item) return null;
  return {
    path: item.path || null,
    name: item.name || null,
    size: item.size ?? item.meta?.size ?? null,
    hash: item.hash || item.meta?.hash || null,
    meta: item.meta || null,
    meta_signature: item.meta_signature || null,
    phash: item.phash || item.meta?.phash || null,
    history_count: item.history_count ?? item.meta?.history_count ?? null,
    open_count: item.open_count ?? item.meta?.open_count ?? null,
  };
}

class GlobalMediaIndex {
  constructor() {
    this.byHash = new Map();
    this.byFallback = new Map();
  }

  get(itemOrHash) {
    if (!itemOrHash) return null;
    if (typeof itemOrHash === 'string') {
      return this.byHash.get(itemOrHash) || null;
    }
    const hash = itemOrHash.hash || itemOrHash.meta?.hash;
    if (hash && this.byHash.has(hash)) return this.byHash.get(hash);
    const k = fallbackKey(
      itemOrHash.path,
      itemOrHash.size ?? itemOrHash.meta?.size,
      itemOrHash.meta_signature?.mtime_ns,
    );
    return k ? (this.byFallback.get(k) || null) : null;
  }

  put(item) {
    const rec = recordFromItem(item);
    if (!rec || (!rec.hash && !rec.path)) return rec;
    if (rec.hash) this.byHash.set(rec.hash, rec);
    const k = fallbackKey(rec.path, rec.size, rec.meta_signature?.mtime_ns);
    if (k) this.byFallback.set(k, rec);
    return rec;
  }

  invalidate(itemOrHash) {
    if (!itemOrHash) return;
    if (typeof itemOrHash === 'string') {
      const rec = this.byHash.get(itemOrHash);
      this.byHash.delete(itemOrHash);
      if (rec) {
        const k = fallbackKey(rec.path, rec.size, rec.meta_signature?.mtime_ns);
        if (k) this.byFallback.delete(k);
      }
      return;
    }
    const hash = itemOrHash.hash || itemOrHash.meta?.hash;
    if (hash) this.byHash.delete(hash);
    const k = fallbackKey(
      itemOrHash.path,
      itemOrHash.size ?? itemOrHash.meta?.size,
      itemOrHash.meta_signature?.mtime_ns,
    );
    if (k) this.byFallback.delete(k);
  }

  seed(items) {
    for (const it of items || []) this.put(it);
  }

  stats() {
    return { hashes: this.byHash.size, fallbacks: this.byFallback.size };
  }
}

const index = new GlobalMediaIndex();

if (typeof window !== 'undefined') {
  window.globalMediaIndex = index;
  window.normalizeAbsPath = normalizeAbsPath;
}

export { index as globalMediaIndex, normalizeAbsPath, fallbackKey, GlobalMediaIndex };
