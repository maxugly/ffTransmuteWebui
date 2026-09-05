// Extracted from pool/sequence.js — see sequence.js barrel. Vanilla ES6, no framework.
import { state, logConsole } from '/app.js';
import { basename, escapeHtml } from '/js/utils.js';
import { normalizeAbsPath } from '/js/media-index.js';
import { fetchVariantsBatch } from '/js/repair-queue.js';
import { scheduleSavePoolState } from '/js/pool/persistence.js';
import { renderSequenceBox } from '/js/pool/sequence-composer.js';
import { refreshRifeNeed, _densityInfoForEntry, _bestHaveM } from '/js/pool/sequence-rife.js';

// ── Per-clip variant picker ─────────────────────────────────────────────

/** In-flight + short TTL cache — stops render storms from melting the server. */
const _variantsCache = new Map(); // normalized path → { at, data }
const _variantsInflight = new Map(); // normalized path → Promise
const VARIANTS_TTL_MS = 15000;
const VARIANT_BATCH_LIMIT = 100;

function _normVariantKey(path) {
  return normalizeAbsPath(path || '') || String(path || '');
}

function peekVariants(path) {
  if (!path) return null;
  const key = _normVariantKey(path);
  const hit = _variantsCache.get(key);
  if (hit && (Date.now() - hit.at) < VARIANTS_TTL_MS) return hit.data;
  return null;
}

function _putVariantsCache(path, variants) {
  const key = _normVariantKey(path);
  if (!key) return;
  _variantsCache.set(key, { at: Date.now(), data: variants || {} });
}

async function _fetchVariantsBatch(paths) {
  /* fetchVariantsBatch via static import (was dynamic) */
  const map = await fetchVariantsBatch(paths);
  const result = new Map();
  for (const [p, variants] of map) {
    if (variants && typeof variants === 'object') _putVariantsCache(p, variants);
    result.set(p, variants || peekVariants(p) || {});
  }
  return result;
}

async function _fetchVariants(path) {
  if (!path) return {};
  const key = _normVariantKey(path);
  const cached = peekVariants(key);
  if (cached) return cached;

  const pending = _variantsInflight.get(key);
  if (pending) return pending;

  const p = (async () => {
    try {
      const map = await _fetchVariantsBatch([key]);
      return map.get(key) || {};
    } catch {
      return peekVariants(key) || {};
    } finally {
      _variantsInflight.delete(key);
    }
  })();
  _variantsInflight.set(key, p);
  return p;
}

function _invalidateVariantsCache(path) {
  if (path) _variantsCache.delete(_normVariantKey(path));
  else _variantsCache.clear();
}

/**
 * Multiplier for a densify path from registry map (or filename fallback).
 */
function _multiplierForVariantPath(vPath, variants, entry) {
  if (!vPath || vPath === entry.path) return 0;
  const list = (variants && variants.rifed) || [];
  for (const v of list) {
    if (v && v.path === vPath) {
      const m = Number(v.detail && v.detail.multiplier);
      return Number.isFinite(m) && m >= 2 ? m : 2;
    }
  }
  // Same path already on entry
  if (entry.variantPath === vPath && _bestHaveM(entry) >= 2) {
    return _bestHaveM(entry);
  }
  // Filename heuristic: *_rife*.mp4 is densify
  if (/_rife/i.test(basename(vPath))) return 2;
  return 2;
}

function _showSeqVariantMenu(anchor, entry, variants, currentPath) {
  document.querySelectorAll('.seq-variant-menu').forEach(el => el.remove());
  const menu = document.createElement('div');
  menu.className = 'seq-variant-menu pool-context-menu';

  const makeRow = (vPath, kind, detail) => {
    const selected = currentPath === vPath;
    const base = basename(vPath);
    const m = detail && detail.multiplier != null ? Number(detail.multiplier) : '';
    const label = vPath === entry.path
      ? `Original — ${base}`
      : `${kind || 'variant'} — ${base}${detail ? ' · ' + Object.entries(detail).map(([k, val]) => `${k}=${val}`).join(' · ') : ''}`;
    const mAttr = (m >= 2) ? ` data-multiplier="${m}"` : '';
    return `<button type="button" class="seq-var-opt${selected ? ' selected' : ''}" data-vpath="${escapeHtml(vPath)}"${mAttr} data-kind="${escapeHtml(kind || '')}" title="${escapeHtml(vPath)}">${escapeHtml(label)}</button>`;
  };

  let rows = makeRow(entry.path, 'original', null);
  const seen = new Set([entry.path]);
  // Always list the active densified path even if /api/variants is empty
  if (entry.variantPath && entry.variantPath !== entry.path && !seen.has(entry.variantPath)) {
    rows += makeRow(entry.variantPath, 'rifed', entry._rifeMultiplier
      ? { multiplier: entry._rifeMultiplier } : null);
    seen.add(entry.variantPath);
  }
  for (const [kind, entries] of Object.entries(variants || {})) {
    for (const v of entries) {
      if (v.path && !seen.has(v.path)) {
        rows += makeRow(v.path, kind, v.detail || null);
        seen.add(v.path);
      }
    }
  }
  if (seen.size <= 1) {
    rows += `<div class="seq-var-empty">No densified file yet. Enable Instant RIFE (or Stitch with RIFE) when a clip shows NEED.</div>`;
  }

  menu.innerHTML = rows;
  const rect = anchor.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.left = `${rect.left}px`;
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.zIndex = '10000';
  document.body.appendChild(menu);

  const close = () => {
    menu.remove();
    document.removeEventListener('click', close, true);
  };
  menu.querySelectorAll('.seq-var-opt').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const vp = btn.dataset.vpath;
      const idx = state.pool.sequence.findIndex(s => s.id === entry.id);
      if (idx >= 0) {
        const ent = state.pool.sequence[idx];
        if (vp === entry.path) {
          // Stitch original — keep known densify M so Instant does not re-encode
          ent.variantPath = null;
          // do not clear _rifeMultiplier
          const dens = _densityInfoForEntry(ent);
          const needM = dens.needed ? (dens.multiplier || 2) : 0;
          ent._rifeStatus = (_bestHaveM(ent) >= needM && needM > 0) || (!_densityInfoForEntry(ent).needed)
            ? 'done'
            : ent._rifeStatus;
        } else {
          // Selecting densify file MUST record M — otherwise badge stays NEED×N forever
          const fromAttr = parseInt(btn.dataset.multiplier || '', 10);
          const m = (fromAttr >= 2)
            ? fromAttr
            : _multiplierForVariantPath(vp, variants, ent);
          ent.variantPath = vp;
          ent._rifeMultiplier = m;
          ent._rifeStatus = 'done';
          ent._rifeError = null;
          logConsole(
            `[SEQ]: ${ent.name} → use densify ${basename(vp)} (×${m})`,
          );
        }
        scheduleSavePoolState();
        renderSequenceBox({ skipInstantKick: true });
      }
      close();
    });
  });
  setTimeout(() => document.addEventListener('click', close, true), 0);
}

export { _normVariantKey, peekVariants, _fetchVariantsBatch, _fetchVariants, _invalidateVariantsCache, _multiplierForVariantPath, _showSeqVariantMenu };
