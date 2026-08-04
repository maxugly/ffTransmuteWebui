/**
 * Prompt Library — save/load positive+negative prompt pairs.
 * Shared across img2img, txt2img, riferecohere tabs.
 * Storage: localStorage key mtapi_prompt_library.
 */
const STORAGE_KEY = 'mtapi_prompt_library';
const MAX_ENTRIES = 200;
const MAX_FIELD = 4000;
const MAX_NAME = 80;

const SEED_ENTRIES = [
  {
    id: '__seed_recohere',
    name: 'Universal Recoherence',
    positive: 'a single coherent object, well-composed scene, centered, sharp focus, highly detailed, intricate details, volumetric lighting, masterpiece, best quality, photorealistic',
    negative: 'blurry, lowres, duplicate, double image, two images, split screen, collage, double exposure, ghosting, transparent, deformed, messy, incoherent, watermark, text',
    source_tab: 'riferecohere',
  },
  {
    id: '__seed_photoreal',
    name: 'Clean photoreal',
    positive: 'photorealistic, highly detailed, sharp focus, 8k, professional lighting, masterpiece, best quality',
    negative: 'blurry, low quality, distorted, deformed, ugly, bad anatomy, watermark, text',
    source_tab: 'seed',
  },
];

// ── store helpers ─────────────────────────────────────────────────────

function _generateId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'pl_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

function _isoNow() {
  return new Date().toISOString();
}

function loadStore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null || raw === undefined) {
      return null; // never set
    }
    if (!raw || raw === 'null') {
      return [];
    }
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) {
      console.warn('[prompt-library]: stored data is not an array — resetting to []');
      return [];
    }
    return data;
  } catch (_) {
    console.warn('[prompt-library]: corrupt localStorage — resetting to []');
    return [];
  }
}

function saveStore(entries) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch (e) {
    alert('Could not save prompt library — storage quota exceeded or private mode.');
    console.warn('[prompt-library]: localStorage setItem failed', e);
  }
}

function ensureSeeded() {
  const existing = localStorage.getItem(STORAGE_KEY);
  if (existing !== null && existing !== undefined) {
    // Key exists — do not re-seed. (Empty [] after user deleted everything is fine.)
    return;
  }
  const now = _isoNow();
  const seeds = SEED_ENTRIES.map(function (s) {
    return {
      id: s.id,
      name: s.name,
      positive: s.positive,
      negative: s.negative,
      created_at: now,
      updated_at: now,
      source_tab: s.source_tab,
    };
  });
  saveStore(seeds);
}

// ── public API ─────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {HTMLElement} opts.containerEl
 * @param {HTMLInputElement|HTMLTextAreaElement} opts.positiveEl
 * @param {HTMLInputElement|HTMLTextAreaElement} opts.negativeEl
 * @param {string} opts.sourceTab
 */
export function attachPromptLibrary({ containerEl, positiveEl, negativeEl, sourceTab }) {
  if (!containerEl || !positiveEl || !negativeEl) return;

  ensureSeeded();

  // ── build toolbar ──
  containerEl.innerHTML = '';

  var selectEl = document.createElement('select');
  selectEl.setAttribute('aria-label', 'Load prompt');
  var placeholderOpt = document.createElement('option');
  placeholderOpt.value = '';
  placeholderOpt.textContent = '\u2014 Load prompt \u2014';
  selectEl.appendChild(placeholderOpt);

  var saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'btn';
  saveBtn.textContent = 'Save';

  var deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'btn';
  deleteBtn.textContent = 'Delete';

  var activeSpan = document.createElement('span');
  activeSpan.className = 'prompt-lib-active';

  containerEl.appendChild(selectEl);
  containerEl.appendChild(saveBtn);
  containerEl.appendChild(deleteBtn);
  containerEl.appendChild(activeSpan);

  // ── helpers ──

  function _refreshSelect() {
    var entries = loadStore();
    if (!entries) entries = [];
    entries.sort(function (a, b) {
      return (b.updated_at || '').localeCompare(a.updated_at || '');
    });
    var curVal = selectEl.value;
    while (selectEl.options.length > 1) {
      selectEl.remove(1);
    }
    entries.forEach(function (e) {
      var opt = document.createElement('option');
      opt.value = e.id;
      opt.textContent = e.name;
      selectEl.appendChild(opt);
    });
    if (curVal && entries.some(function (e) { return e.id === curVal; })) {
      selectEl.value = curVal;
    }
  }

  function _updateActiveLabel() {
    var pos = positiveEl.value;
    var neg = negativeEl.value;
    var entries = loadStore();
    if (!entries) entries = [];
    var match = null;
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].positive === pos && entries[i].negative === neg) {
        match = entries[i];
        break;
      }
    }
    if (match) {
      activeSpan.textContent = match.name;
      selectEl.value = match.id;
    } else {
      activeSpan.textContent = '';
      selectEl.value = '';
    }
  }

  function _loadEntry(id) {
    var entries = loadStore();
    if (!entries) entries = [];
    var entry = null;
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].id === id) { entry = entries[i]; break; }
    }
    if (!entry) return;
    positiveEl.value = entry.positive;
    negativeEl.value = entry.negative;
    activeSpan.textContent = entry.name;
    // Fire input events so any listeners know fields changed
    positiveEl.dispatchEvent(new Event('input', { bubbles: true }));
    negativeEl.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function _doSave() {
    var pos = positiveEl.value;
    var neg = negativeEl.value;
    var posTrim = (pos || '').trim();
    var negTrim = (neg || '').trim();

    if (!posTrim && !negTrim) {
      alert('Both prompt fields are empty — nothing to save.');
      return;
    }
    if (pos.length > MAX_FIELD) {
      alert('Positive prompt exceeds ' + MAX_FIELD + ' characters. Shorten it before saving.');
      return;
    }
    if (neg.length > MAX_FIELD) {
      alert('Negative prompt exceeds ' + MAX_FIELD + ' characters. Shorten it before saving.');
      return;
    }

    var name = prompt('Name for this prompt pair:');
    if (name === null) return;
    name = name.trim();
    if (!name) {
      alert('Name is required.');
      return;
    }
    if (name.length > MAX_NAME) {
      alert('Name must be ' + MAX_NAME + ' characters or fewer.');
      return;
    }

    var entries = loadStore();
    if (!entries) entries = [];
    var existing = null;
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].name === name) { existing = entries[i]; break; }
    }

    if (existing) {
      if (!confirm('A prompt named "' + name + '" already exists. Overwrite it?')) return;
      existing.positive = pos;
      existing.negative = neg;
      existing.updated_at = _isoNow();
      existing.source_tab = sourceTab;
    } else {
      if (entries.length >= MAX_ENTRIES) {
        alert('Prompt library is full (' + MAX_ENTRIES + ' entries). Delete some prompts first.');
        return;
      }
      entries.push({
        id: _generateId(),
        name: name,
        positive: pos,
        negative: neg,
        created_at: _isoNow(),
        updated_at: _isoNow(),
        source_tab: sourceTab,
      });
    }

    saveStore(entries);
    _refreshSelect();
    _updateActiveLabel();
    selectEl.value = existing ? existing.id : entries[entries.length - 1].id;
  }

  function _doDelete() {
    var selId = selectEl.value;
    if (!selId) {
      // Try active match
      var pos = positiveEl.value;
      var neg = negativeEl.value;
      var entries = loadStore();
      if (!entries) entries = [];
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].positive === pos && entries[i].negative === neg) {
          selId = entries[i].id;
          break;
        }
      }
    }
    if (!selId) {
      alert('Select a prompt from the list to delete, or load one first.');
      return;
    }
    var entries = loadStore();
    if (!entries) entries = [];
    var entry = null;
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].id === selId) { entry = entries[i]; break; }
    }
    if (!entry) return;
    if (!confirm('Delete prompt "' + entry.name + '"?')) return;

    var filtered = [];
    for (var j = 0; j < entries.length; j++) {
      if (entries[j].id !== selId) filtered.push(entries[j]);
    }
    saveStore(filtered);
    _refreshSelect();
    selectEl.value = '';
    activeSpan.textContent = '';
  }

  // ── wire events ──

  saveBtn.addEventListener('click', _doSave);

  deleteBtn.addEventListener('click', _doDelete);

  selectEl.addEventListener('change', function () {
    var id = selectEl.value;
    if (!id) return;
    _loadEntry(id);
  });

  positiveEl.addEventListener('input', _updateActiveLabel);
  negativeEl.addEventListener('input', _updateActiveLabel);

  // ── initial UI state ──
  _refreshSelect();
  _updateActiveLabel();
}
