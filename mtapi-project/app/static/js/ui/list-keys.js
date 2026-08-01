/**
 * Keyboard for multi-item lists + media frame nudge.
 *
 * Plain arrows  → navigate selection in the active tab’s list
 * Ctrl+arrows   → move the selected image/video in that list
 *               → if no list, nudge global frame range (video)
 *
 * Tabs register handlers via registerListKeys(tabId, api).
 */
import { state } from '/app.js';

/** @type {Record<string, ListKeyApi>} */
const handlers = {};

/**
 * @typedef {object} ListKeyApi
 * @property {() => Array<{path?: string, name?: string}>} getItems
 * @property {() => number} getSelected
 * @property {(i: number) => void} setSelected  select + preview if desired
 * @property {(from: number, to: number) => void} moveItem  reorder + re-render
 */

/**
 * @param {string} tabId
 * @param {ListKeyApi} api
 */
function registerListKeys(tabId, api) {
  handlers[tabId] = api;
}

function isTypingTarget(el) {
  if (!el || el === document.body) return false;
  const tag = (el.tagName || '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  return false;
}

function deltaFromKey(key) {
  if (key === 'ArrowUp' || key === 'ArrowLeft') return -1;
  if (key === 'ArrowDown' || key === 'ArrowRight') return 1;
  return 0;
}

/** Nudge global In/Out when no list owns the keys. */
function nudgeGlobalFrames(key, ctrl) {
  if (!ctrl) return false;
  const startEl = document.getElementById('giTimelineStart');
  const endEl = document.getElementById('giTimelineEnd');
  if (!startEl || !endEl) return false;

  const m = parseInt(window.globalInputs?.totalFrames, 10) || 2;
  let s = parseInt(startEl.value, 10);
  let e = parseInt(endEl.value, 10);
  if (isNaN(s)) s = 1;
  if (isNaN(e)) e = m;

  // Ctrl+Left/Right → In point; Ctrl+Up/Down → Out point
  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    const d = key === 'ArrowRight' ? 1 : -1;
    const next = Math.min(Math.max(1, s + d), e - 1);
    if (next === s) return true;
    startEl.value = String(next);
    startEl.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }
  if (key === 'ArrowUp' || key === 'ArrowDown') {
    const d = key === 'ArrowUp' ? 1 : -1;
    const next = Math.max(Math.min(m, e + d), s + 1);
    if (next === e) return true;
    endEl.value = String(next);
    endEl.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }
  return false;
}

function setupListKeys() {
  document.addEventListener('keydown', (e) => {
    const key = e.key;
    if (!key || !key.startsWith('Arrow')) return;
    if (isTypingTarget(e.target)) return;

    const delta = deltaFromKey(key);
    if (!delta) return;

    const api = handlers[state.activeTab];
    const ctrl = e.ctrlKey || e.metaKey;

    if (api) {
      const items = api.getItems() || [];
      if (!items.length) {
        if (nudgeGlobalFrames(key, ctrl)) {
          e.preventDefault();
        }
        return;
      }

      let sel = api.getSelected() | 0;
      if (sel < 0) sel = 0;
      if (sel >= items.length) sel = items.length - 1;

      if (ctrl) {
        // Move selected media in the list
        const to = sel + delta;
        if (to < 0 || to >= items.length) {
          e.preventDefault();
          return;
        }
        e.preventDefault();
        api.moveItem(sel, to);
        return;
      }

      // Navigate selection
      const next = Math.min(Math.max(0, sel + delta), items.length - 1);
      if (next === sel) {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      api.setSelected(next);
      return;
    }

    // No list on this tab — Ctrl+arrows still nudge frame range for video work
    if (nudgeGlobalFrames(key, ctrl)) {
      e.preventDefault();
    }
  });
}

export { registerListKeys, setupListKeys };
