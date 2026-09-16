// Sequence clip tag color + usage counter — vanilla ES6, no framework.
// Tag is per sequence ENTRY (each chip owns its own tagColor, null = untagged)
// so it survives ORIG↔RIFED↔conformed switches on the same chip. The usage
// counter groups by entry.path (original source), like sequencePositions().
// The tag never touches token background or duration colors — it renders only
// as the #-sized tag block + the picker's own fill.
import { state, logConsole } from '/app.js';
import { escapeHtml } from '/js/utils.js';
import { scheduleSavePoolState } from '/js/pool/persistence.js';
import { renderSequenceBox } from '/js/pool/sequence-composer.js';
import { updateSeqClipSettings } from '/js/pool/sequence-transport.js';

// Fixed 32-color grid (4 rows x 8). No color wheel by design (spec).
const SEQ_TAG_COLORS = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#22c55e', '#10b981', '#14b8a6',
  '#06b6d4', '#0ea5e9', '#3b82f6', '#6366f1', '#8b5cf6', '#a855f7', '#d946ef', '#ec4899',
  '#f43f5e', '#fb7185', '#fdba74', '#fde047', '#bef264', '#6ee7b7', '#5eead4', '#7dd3fc',
  '#93c5fd', '#c4b5fd', '#f0abfc', '#f9a8d4', '#a8a29e', '#78716c', '#e7e5e4', '#ffffff',
];

/** Normalize a tag color: lowercase #rrggbb or null. */
function normTagColor(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(s) ? s : null;
}

/**
 * Usage counts grouped by original path.
 * @returns {Map<string, {count:number, positions:number[]}>} positions are 1-based.
 */
function sequenceUseCounts() {
  const map = new Map();
  (state.pool.sequence || []).forEach((entry, i) => {
    if (!entry || !entry.path) return;
    let rec = map.get(entry.path);
    if (!rec) {
      rec = { count: 0, positions: [] };
      map.set(entry.path, rec);
    }
    rec.count += 1;
    rec.positions.push(i + 1);
  });
  return map;
}

/** Set (or clear with null) the tag on one entry by id. Persists + re-renders. */
function setEntryTagColor(entryId, color) {
  const seq = state.pool.sequence || [];
  const entry = seq.find((e) => String(e.id) === String(entryId));
  if (!entry) return false;
  const next = color == null ? null : normTagColor(color);
  if (color != null && next == null) return false;
  entry.tagColor = next;
  logConsole(next ? `[SEQ]: tag ${entry.name} ${next}` : `[SEQ]: tag cleared for ${entry.name}`);
  renderSequenceBox({ skipInstantKick: true });
  try { updateSeqClipSettings(); } catch (_) { /* panel optional */ }
  scheduleSavePoolState();
  return true;
}

function closeTagPicker() {
  document.querySelectorAll('.seq-tag-pop').forEach((el) => el.remove());
}

/**
 * Open the 32-color grid popover anchored under `anchorEl` for one entry.
 * Clicks stopPropagation so the token never treats them as selection.
 */
function openTagPicker(anchorEl, entryId) {
  closeTagPicker();
  const seq = state.pool.sequence || [];
  const entry = seq.find((e) => String(e.id) === String(entryId));
  if (!entry) return;
  const current = normTagColor(entry.tagColor);

  const pop = document.createElement('div');
  pop.className = 'seq-tag-pop';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', `Tag color for ${entry.name || 'clip'}`);
  const swatches = SEQ_TAG_COLORS.map((c) => {
    const sel = current === c ? ' is-selected' : '';
    return `<button type="button" class="seq-tag-swatch${sel}" data-tag="${c}"`
      + ` style="background:${c}" title="${c}" aria-label="Tag ${c}"></button>`;
  }).join('');
  pop.innerHTML = `
    <div class="seq-tag-grid">${swatches}</div>
    <button type="button" class="seq-tag-clear" title="Remove tag color">Clear</button>
  `;
  pop.addEventListener('click', (e) => e.stopPropagation());
  pop.querySelectorAll('.seq-tag-swatch').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      setEntryTagColor(entryId, btn.dataset.tag);
      closeTagPicker();
    });
  });
  const clearBtn = pop.querySelector('.seq-tag-clear');
  if (clearBtn) {
    clearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setEntryTagColor(entryId, null);
      closeTagPicker();
    });
  }
  document.body.appendChild(pop);
  try {
    const rect = anchorEl.getBoundingClientRect();
    const pw = pop.offsetWidth || 220;
    pop.style.position = 'fixed';
    pop.style.left = `${Math.max(4, Math.min(rect.left, window.innerWidth - pw - 8))}px`;
    pop.style.top = `${rect.bottom + 4}px`;
    pop.style.zIndex = '10000';
  } catch (_) { /* static fallback position from CSS */ }

  const onDoc = (e) => {
    if (!pop.isConnected) {
      document.removeEventListener('click', onDoc, true);
      return;
    }
    if (e.target.closest?.('.seq-tag-pop') || e.target.closest?.('.seq-token-tag') || e.target.closest?.('.seq-tag-btn')) return;
    closeTagPicker();
    document.removeEventListener('click', onDoc, true);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      closeTagPicker();
      document.removeEventListener('keydown', onKey, true);
    }
  };
  setTimeout(() => document.addEventListener('click', onDoc, true), 0);
  document.addEventListener('keydown', onKey, true);
}

export { SEQ_TAG_COLORS, normTagColor, sequenceUseCounts, setEntryTagColor, openTagPicker, closeTagPicker };
