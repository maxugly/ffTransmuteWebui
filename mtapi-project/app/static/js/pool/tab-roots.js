// Stateful tabs — permanent per-tab roots (Phase 1: pool, sequence, images).
//
// Each cached tab mounts once into a permanent child root of the form host
// (#actionPanelForm). Tab switches hide/show roots; nodes are never removed,
// so scroll, inputs, selection, badges and the wall persist exactly.
//
// Pool/sequence split (builder's call, recorded): pool owns toolbar + grid,
// sequence owns the resize handle + composer. The sequence view shows BOTH
// roots stacked (pool grid above composer), so no element id exists twice in
// the document and no lookup/binder needed re-scoping. Canonical DOM order
// (pool before sequence) is enforced on every attach.
//
// Uncached tabs keep the legacy destroy path. Because panel.innerHTML wipes
// would destroy cached roots, cached roots are detached into a module-held
// Map while an uncached tab is active (panel holds EITHER uncached content
// OR cached roots, never both). Detach preserves DOM state (scroll, inputs);
// no iframe lives in these roots, so no reload hazard. Reconciles §7
// (roots never detached) with §8 (uncached destroy path unchanged).
import { elements } from '/app.js';

/** Phase 1 cached tabs. Phase 2 adds op tabs one family per PR. */
const CACHED_TABS = new Set(['pool', 'sequence', 'images']);

/** Canonical attach order — pool grid must precede the sequence composer. */
const CACHED_ORDER = ['pool', 'sequence', 'images'];

/** Roots detached while an uncached tab owns the panel. */
const _detached = new Map();

function isCachedTab(tab) {
  return CACHED_TABS.has(tab);
}

function rootId(tab) {
  return `tabRoot-${tab}`;
}

function getAttachedRoot(tab) {
  if (!isCachedTab(tab)) return null;
  return document.getElementById(rootId(tab));
}

/** Attached or detached (held) root, or null if never built. */
function getTabRoot(tab) {
  return getAttachedRoot(tab) || _detached.get(tab) || null;
}

/**
 * Ensure an attached root for tab, in canonical order. Creates on first
 * visit; re-attaches a held root otherwise. Returns the root element.
 */
function ensureTabRoot(tab) {
  if (!isCachedTab(tab)) return null;
  let root = getAttachedRoot(tab) || _detached.get(tab) || null;
  if (!root) {
    root = document.createElement('div');
    root.className = 'tab-root';
    root.dataset.tab = tab;
    root.id = rootId(tab);
    root.hidden = true;
  } else {
    _detached.delete(tab);
  }
  const panel = elements.actionPanel;
  if (panel && root.parentNode !== panel) {
    const idx = CACHED_ORDER.indexOf(tab);
    const nextAttached = CACHED_ORDER.slice(idx + 1)
      .map((t) => getAttachedRoot(t))
      .find(Boolean) || null;
    panel.insertBefore(root, nextAttached);
  }
  return root;
}

/** All mounted roots (attached + detached-held), in canonical order. */
function mountedTabRoots() {
  const out = [];
  for (const tab of CACHED_ORDER) {
    const root = getAttachedRoot(tab) || _detached.get(tab) || null;
    if (root) out.push({ tab, root });
  }
  return out;
}

/** Move attached cached roots into the held Map (state-preserving). */
function detachCachedRoots() {
  for (const tab of CACHED_ORDER) {
    const root = getAttachedRoot(tab);
    if (root && root.parentNode) {
      root.parentNode.removeChild(root);
      _detached.set(tab, root);
    }
  }
}

/** Re-attach held roots in canonical order (hidden flags preserved). */
function reattachCachedRoots() {
  for (const tab of CACHED_ORDER) {
    const root = _detached.get(tab);
    if (!root) continue;
    _detached.delete(tab);
    const panel = elements.actionPanel;
    if (!panel) {
      _detached.set(tab, root);
      continue;
    }
    const idx = CACHED_ORDER.indexOf(tab);
    const nextAttached = CACHED_ORDER.slice(idx + 1)
      .map((t) => getAttachedRoot(t))
      .find(Boolean) || null;
    panel.insertBefore(root, nextAttached);
  }
}

/** Remove legacy uncached content (direct non-root children of the panel). */
function clearUncachedNodes() {
  const panel = elements.actionPanel;
  if (!panel) return;
  Array.from(panel.children).forEach((child) => {
    if (!child.classList || !child.classList.contains('tab-root')) {
      child.remove();
    }
  });
}

/**
 * Show the cached tab: hide every other root, show the visited set.
 * Sequence shows pool + sequence stacked (shared toolbar/grid above the
 * composer); pool and images show their own root only.
 */
function showCachedTab(tab) {
  const visible = tab === 'sequence' ? new Set(['pool', 'sequence']) : new Set([tab]);
  for (const t of CACHED_ORDER) {
    const root = getAttachedRoot(t) || _detached.get(t) || null;
    if (root && root.isConnected) root.hidden = !visible.has(t);
  }
  // Pool toolbar carries the sequence tools (single instance, no dup ids);
  // hide them on the pool tab so its chrome is byte-identical to before.
  try {
    const poolRoot = getAttachedRoot('pool');
    const seqTools = poolRoot
      ? ['btnSeqClear', 'btnTogglePool'].map((id) => poolRoot.querySelector(`#${id}`))
      : [];
    seqTools.forEach((el) => {
      if (el) el.hidden = tab !== 'sequence';
    });
  } catch (_) { /* best effort */ }
}

export {
  CACHED_TABS, CACHED_ORDER,
  isCachedTab, rootId,
  getTabRoot, ensureTabRoot, mountedTabRoots,
  detachCachedRoots, reattachCachedRoots, clearUncachedNodes,
  showCachedTab,
};
