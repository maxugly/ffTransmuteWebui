/**
 * Notes tab — two plain text areas, full workspace, no media / no Run.
 * Proportional 50/50 layout (flex); browser zoom keeps relative sizes.
 * Content persisted in localStorage.
 */
import { state, elements } from '/app.js';

const STORAGE_KEY = 'mtapi.notes.v1';
let _saveTimer = null;

function ensureNotes() {
  if (!state.notes) {
    state.notes = { left: '', right: '' };
  }
  return state.notes;
}

function loadNotesFromStorage() {
  const n = ensureNotes();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (typeof data.left === 'string') n.left = data.left;
    if (typeof data.right === 'string') n.right = data.right;
  } catch (_) { /* ignore corrupt */ }
}

function saveNotesToStorage() {
  const n = ensureNotes();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      left: n.left || '',
      right: n.right || '',
    }));
  } catch (_) { /* quota / private mode */ }
}

function scheduleSave() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    saveNotesToStorage();
  }, 250);
}

function renderNotesForm() {
  loadNotesFromStorage();
  const n = ensureNotes();

  elements.actionPanel.innerHTML = `
    <div class="notes-workspace" id="notesWorkspace">
      <div class="notes-col">
        <label class="notes-label" for="notesLeft">Notes A</label>
        <textarea id="notesLeft" class="notes-area" spellcheck="true"
          placeholder="Type notes…">${escapeForTextarea(n.left)}</textarea>
      </div>
      <div class="notes-col">
        <label class="notes-label" for="notesRight">Notes B</label>
        <textarea id="notesRight" class="notes-area" spellcheck="true"
          placeholder="Type notes…">${escapeForTextarea(n.right)}</textarea>
      </div>
    </div>
  `;
  (elements.actionPanelRoot || elements.actionPanel).classList.add('notes-active');

  const left = document.getElementById('notesLeft');
  const right = document.getElementById('notesRight');
  left?.addEventListener('input', () => {
    ensureNotes().left = left.value;
    scheduleSave();
  });
  right?.addEventListener('input', () => {
    ensureNotes().right = right.value;
    scheduleSave();
  });
}

/** Escape for textarea text content (not HTML attributes). */
function escapeForTextarea(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export { renderNotesForm, ensureNotes };
