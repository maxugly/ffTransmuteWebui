const STORAGE_KEY = 'mtapi_nav_sections';

function readStored() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed;
    return {};
  } catch (_) {
    return {};
  }
}

function saveNavSectionState() {
  const state = {};
  document.querySelectorAll('.nav-section').forEach(function (sec) {
    const id = sec.getAttribute('data-section');
    if (id) state[id] = sec.classList.contains('collapsed');
  });
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (_) {}
}

function loadNavSectionState() {
  const stored = readStored();
  document.querySelectorAll('.nav-section').forEach(function (sec) {
    const id = sec.getAttribute('data-section');
    if (!id) return;
    const collapsed = !!stored[id];
    const header = sec.querySelector('.nav-header');
    if (collapsed) {
      sec.classList.add('collapsed');
      if (header) header.setAttribute('aria-expanded', 'false');
    } else {
      sec.classList.remove('collapsed');
      if (header) header.setAttribute('aria-expanded', 'true');
    }
  });
}

let _navSectionsBound = false;

function setupNavSectionCollapse() {
  if (_navSectionsBound) return;
  _navSectionsBound = true;

  const onClickOrKey = function (e) {
    if (e.type === 'keydown') {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
    }
    const sec = e.currentTarget.closest('.nav-section');
    if (!sec) return;
    const collapsed = sec.classList.toggle('collapsed');
    e.currentTarget.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    saveNavSectionState();
  };

  document.querySelectorAll('.nav-header').forEach(function (header) {
    header.addEventListener('click', onClickOrKey);
    header.addEventListener('keydown', onClickOrKey);
  });

  loadNavSectionState();
}

function ensureNavSectionForTab(tab) {
  var item;
  try {
    item = document.querySelector('.nav-item[data-tab="' + CSS.escape(tab) + '"]');
  } catch (_) {
    return;
  }
  if (!item) return;
  const sec = item.closest('.nav-section');
  if (!sec) return;
  if (sec.classList.contains('collapsed')) {
    sec.classList.remove('collapsed');
    const h = sec.querySelector('.nav-header');
    if (h) h.setAttribute('aria-expanded', 'true');
    saveNavSectionState();
  }
}

export {
  saveNavSectionState,
  loadNavSectionState,
  setupNavSectionCollapse,
  ensureNavSectionForTab,
};
