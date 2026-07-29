// State
import { isVideoPath, basename, formatDurationExact, escapeHtml } from '/js/utils.js';
import { setupContinuousKnob, setupBinaryKnob, knobUnitHtml } from '/js/ui/knobs.js';
import { POOL_LAYOUT_DEFAULTS, VIDEO_EXTS, TILE_INFO_FIELDS, POOL_ZOOM } from '/js/pool/constants.js';
import { ensurePoolLayout } from '/js/pool/layout.js';
import {
  projectNew, projectOpen, projectSave,
  savePoolStateNow, restorePoolState,
  scheduleSavePoolState, buildPoolStatePayload,
  applyPoolData, stitchPoolSequence,
  markProjectDirty, updateProjectNameUI,
  refreshPoolToolbarCounts, ensureVideoOutputPath,
  projectLabel,
  poolThumbUrl, shortHash, buildPoolMetaHtml,
  _poolSeqId, _poolSaveTimer, _poolPersistReady,
} from '/js/pool/persistence.js';
import {
  runOpWithCancel, runActiveOperation, stopActiveOperation,
  displayOpResult, setRunUiBusy,
  formatJobLine, stopJobProgressPoll, startJobProgressPoll,
  newJobToken,
} from '/js/job-control.js';
import { renderMoshForm, updateMoshParams } from '/js/tabs/datamosh.js';
import { renderDeepDreamForm, collectDeepDreamBody } from '/js/tabs/deepdream.js';
import { renderTransmuteForm, renderMultiForm, renderAdvancedForm, addMultiClipPath } from '/js/tabs/transmute.js';
import { renderFaceMorphForm, collectFaceMorphBody } from '/js/tabs/facemorph.js';
import { renderWithoutBgForm, collectWithoutBgBody } from '/js/tabs/withoutbg.js';
import { renderStyleTransferForm, collectStyleTransferBody } from '/js/tabs/styletransfer.js';
import { renderRifeForm, collectRifeBody } from '/js/tabs/rife.js';
import { loadQuickSettings, renderQuickTransmuteForm, runQuickTransmute, quickTransmuteLabel } from '/js/tabs/quick.js';
import { renderWatcherForm } from '/js/tabs/watcher.js';
import {
  findPoolItem, displayFocusPath, setPoolHover, clearPoolHover,
  setPoolFocus, updateSelectionHighlights, updatePoolFocusFrame,
  setupSequenceDropZone, addPathToSequence, removeSequenceAt,
  clearSequence, renderSequenceBox,
  updateSeqTransportUI, findSelectedSeqIndex,
  moveSelectedInSequence, updateSeqClipSettings,
  onSeqClipDurationChange, applySeqTokenTimeStyles,
  seqPlay, seqPause, seqStop, seqPrev, seqNext,
} from '/js/pool/sequence.js';
import { setupPoolLayoutChrome, applyPoolLayout, bindPoolDragResize } from '/js/pool/layout.js';
import {
  loadPoolItemMeta, selectPoolItem, removePoolItem, clearPool,
  addPathsToPool, importPoolFiles, importPoolFolder,
  sendPoolPathTo, savePoolFramePng, applyPoolAsInput,
} from '/js/pool/items.js';
let state = {
  activeTab: 'mosh',
  operations: {},
  health: { ok: true, warnings: [] },
  fb: {
    currentPath: '',
    selectedPath: '',
    selectedName: '',
    selectedIsDir: false,
    targetInputId: '',
    selectDirOnly: false,
    resolveMode: 'file' // 'file' or 'dir'
  },
  multiClips: [],
  selectedMoshMode: 'melt', // 'melt' or 'classic'
  moshVideoFrames: 100,
  // Named project file (.ffproject.json)
  project: {
    path: null,
    name: null,
    dirty: false,
  },
  // Face morph chain
  faceMorph: {
    images: [], // {path, name}[]
    folder: null,
  },
  // withoutBG batch
  withoutbg: {
    images: [], // {path, name}[]
    folder: null,
  },
  // Neural style transfer (content list + one style image)
  styleTransfer: {
    contents: [], // {path, name}[]
    stylePath: null,
  },
  // Quick Transmute: one-click right-click reformat (same Fit/AR as sequence)
  quick: {
    reconcile: 'pad',   // pad | crop | stretch
    aspect: 'auto',     // auto|1:1|16:9|…|custom
    aspectCustom: '',
  },
  // Folder watcher (ingest → DNxHR); server defaults enabled=false
  watcher: {
    enabled: false,
    in_dir: '',
    out_dir: '',
    resize_mode: 'letterbox',
    status: null,
    pollTimer: null,
  },
  pool: {
    items: [], // { path, name, size?, meta?, hash? }
    selectedPath: null, // sticky selection (click) — syncs library ↔ sequence
    selectedSeqId: null, // precise sequence entry id when a token is selected
    hoverPath: null,    // temporary hover only (does not change selection)
    loading: false,
    // Sequence composer: ordered clips to stitch
    sequence: [], // { id, path, name, targetDuration? }
    focusPath: null, // deprecated alias; display uses hoverPath || selectedPath
    seqDragId: null,
    reconcile: 'pad',
    aspect: 'auto',       // auto|1:1|16:9|…|custom
    aspectCustom: '',     // when aspect === 'custom': W:H or WxH
    outputPath: '',
    // Sequence preview playback
    playback: {
      playing: false,
      index: 0,
      loop: false,
      video: null, // HTMLVideoElement while active
    },
    // Tile display
    tileZoom: 200, // minmax track size in px (reset = current default)
    tileInfo: null, // filled from defaultTileInfo()
    tileInfoMenuOpen: false,
    // Frame match (pHash next-clip finder)
    matchMaxDistance: 10,
    matchMode: 'next', // next | prev | both
    matchResults: null, // last API response
    matchLoading: false,
    // Resizable / collapsible dock layout
    layout: {
      composeHeight: 280,
      focusWidth: 340,
      selectionHeight: 0, // 0 = auto aspect-ratio (no dead space)
      matchHeight: 180,
      collapsed: {
        sequence: false,
        selection: false,
        matches: false,
      },
    },
  }
};


function defaultTileInfo() {
  const o = {};
  TILE_INFO_FIELDS.forEach(f => { o[f.key] = true; });
  return o;
}

function ensureTileInfo() {
  if (!state.pool.tileInfo) state.pool.tileInfo = defaultTileInfo();
  // fill any new keys added later
  TILE_INFO_FIELDS.forEach(f => {
    if (state.pool.tileInfo[f.key] === undefined) state.pool.tileInfo[f.key] = true;
  });
  return state.pool.tileInfo;
}

// init defaults
state.pool.tileInfo = defaultTileInfo();
state.pool.tileZoom = POOL_ZOOM.reset;

// DOM Elements
const elements = {
  statusDot: document.getElementById('statusDot'),
  statusText: document.getElementById('statusText'),
  tabTitle: document.getElementById('tabTitle'),
  btnRun: document.getElementById('btnRun'),
  btnStop: document.getElementById('btnStop'),
  actionPanel: document.getElementById('actionPanel'),
  mediaViewer: document.getElementById('mediaViewer'),
  mediaInfo: document.getElementById('mediaInfo'),
  mediaName: document.getElementById('mediaName'),
  mediaPath: document.getElementById('mediaPath'),
  consoleBody: document.getElementById('consoleBody'),
  btnClearConsole: document.getElementById('btnClearConsole'),
  btnOpenFolder: document.getElementById('btnOpenFolder'),
  
  // Modal File Browser
  fbModal: document.getElementById('fbModal'),
  fbUpBtn: document.getElementById('fbUpBtn'),
  fbPathInput: document.getElementById('fbPathInput'),
  fbShortcuts: document.getElementById('fbShortcuts'),
  fbList: document.getElementById('fbList'),
  btnCloseFb: document.getElementById('btnCloseFb'),
  btnCancelFb: document.getElementById('btnCancelFb'),
  btnConfirmFb: document.getElementById('btnConfirmFb')
};

// ── Global shared inputs — persist across all tabs ──────────────────────
window.globalInputs = {
  video:   '',   // newline-separated video paths
  image:   '',   // newline-separated image paths
  pathIn:  '',   // input directory
  pathOut: '',   // output directory
  frameStart: 1,      // global frame range start (for datamosh tabs)
  frameEnd:   100,    // global frame range end
  totalFrames: 100,   // probed from video
};

// ── Tab type declarations — what each tab accepts ────────────────────────
// Used to validate the global path input against the current tab.
const TAB_ACCEPTS = {
  mosh:        'video',
  transmute:   'video',
  multi:       'video',
  deepdream:   'any',
  facemorph:   'image',
  withoutbg:   'image',
  styletransfer:'image',
  rife:        'video',
  advanced:    'video',
  quick:       'video',
};

// Initialize
// ── Global path helpers ──────────────────────────────────────────────────

function detectFileType(path) {
  if (!path) return null;
  const ext = path.split('.').pop().toLowerCase();
  const videoExts = ['mp4','mkv','avi','mov','m4v','webm','mpg','mpeg','wmv','flv','ts','m2ts'];
  const imageExts = ['png','jpg','jpeg','webp','bmp','gif','tif','tiff','ppm','pgm','svg'];
  if (videoExts.includes(ext)) return 'video';
  if (imageExts.includes(ext)) return 'image';
  return null;
}

// ── Global inputs sync ──────────────────────────────────────────────────

function updateGlobalInputs() {
  window.globalInputs.video   = document.getElementById('giVideo')?.value || '';
  window.globalInputs.image   = document.getElementById('giImage')?.value || '';
  window.globalInputs.pathIn  = document.getElementById('giPathIn')?.value || '';
  window.globalInputs.pathOut = document.getElementById('giPathOut')?.value || '';
  updateStatusIndicators();
  // Sync per-tab local fields from global inputs + show/hide frame row
  _syncTabInputFromGlobal();
}

function _syncTabInputFromGlobal() {
  const tab = state.activeTab;
  const gi = window.globalInputs;

  // Show/hide global frame row
  var framesRow = document.getElementById('giFramesRow');
  if (framesRow) framesRow.style.display = (tab === 'mosh') ? '' : 'none';

  if (tab === 'mosh' && gi.video.trim()) {
    var lines = gi.video.split('\n').map(function(l) { return l.trim(); }).filter(Boolean);
    if (lines.length) {
      var probePath = lines[0];
      if (probePath !== gi._lastProbedPath) {
        probeGlobalVideo(probePath);
      }
    }
  }
}

function updateStatusIndicators() {
  const tab = state.activeTab;
  const accepts = TAB_ACCEPTS[tab] || 'any';
  const gi = window.globalInputs;
  var rows = [
    { key: 'video',   elId: 'giVideoStatus',   needs: (accepts === 'video' || accepts === 'any') },
    { key: 'image',   elId: 'giImageStatus',   needs: (accepts === 'image' || accepts === 'any') }
  ];
  rows.forEach(function(r) {
    var el = document.getElementById(r.elId);
    if (!el) return;
    var val = (gi[r.key] || '').trim();
    if (!r.needs)      { el.textContent = '\u274C'; el.title = 'Not used by this tab'; }
    else if (val)      { el.textContent = '\u2705'; el.title = 'Active'; }
    else               { el.textContent = ''; el.title = ''; }
  });
}

function bestInput(fieldId) {
  const tab = state.activeTab;
  const accepts = TAB_ACCEPTS[tab] || 'any';
  const gi = window.globalInputs;
  var lines;
  if ((accepts === 'video' || accepts === 'any') && gi.video.trim()) {
    lines = gi.video.split('\n').map(function(l) { return l.trim(); }).filter(Boolean);
    if (lines.length) return lines[0];
  }
  if ((accepts === 'image' || accepts === 'any') && gi.image.trim()) {
    lines = gi.image.split('\n').map(function(l) { return l.trim(); }).filter(Boolean);
    if (lines.length) return lines[0];
  }
  const el = document.getElementById(fieldId);
  return el ? (el.value || '').trim() : '';
}

function bestOutput(fieldId) {
  const el = document.getElementById(fieldId);
  const explicit = el ? (el.value || '').trim() : '';
  return explicit || null;
}

function resolveGlobalImage() {
  return resolveGlobalImages()[0] || null;
}

function resolveGlobalImages() {
  return window.globalInputs.image.split('\n').map(function(l) { return l.trim(); }).filter(Boolean);
}

async function init() {
  loadQuickSettings();
  setupGlobalTimeline();
  setupEventListeners();
  setupPreviewConsoleResize();
  await checkHealth();
  await fetchOperations();
  await restorePoolState();
  switchTab('mosh');
  // Fit empty viewer once layout settles
  requestAnimationFrame(() => fitPreviewViewer());
}

// Event Listeners
function setupEventListeners() {
  // Navigation Tabs
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
      const tab = e.currentTarget.getAttribute('data-tab');
      switchTab(tab);
    });
  });

  // Action Buttons
  elements.btnRun.addEventListener('click', runActiveOperation);
  elements.btnStop?.addEventListener('click', stopActiveOperation);
  elements.btnClearConsole.addEventListener('click', () => {
    elements.consoleBody.innerHTML = '~ terminal cleared';
  });

  // Folder Opening Shortcut (Simulated info)
  elements.btnOpenFolder.addEventListener('click', () => {
    const path = elements.mediaPath.textContent;
    if (path) {
      logConsole(`Output folder: ${path.substring(0, path.lastIndexOf('/'))}`);
    }
  });

  // File Browser Modal Buttons
  elements.btnCloseFb.addEventListener('click', closeFbModal);
  elements.btnCancelFb.addEventListener('click', closeFbModal);
  elements.fbUpBtn.addEventListener('click', navigateUpFb);
  elements.btnConfirmFb.addEventListener('click', confirmFbSelection);
  // Global inputs
  var giIds = ['giVideo', 'giImage', 'giPathIn', 'giPathOut'];
  giIds.forEach(function(id) {
    var el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', updateGlobalInputs);
      el.addEventListener('change', updateGlobalInputs);
    }
  });
  var btnGiVideoBrowse = document.getElementById('btnGiVideoBrowse');
  if (btnGiVideoBrowse) {
    btnGiVideoBrowse.addEventListener('click', function() {
      window.openFileBrowser('giVideo', false, 'files', 'video');
    });
  }
  var btnGiImageBrowse = document.getElementById('btnGiImageBrowse');
  if (btnGiImageBrowse) {
    btnGiImageBrowse.addEventListener('click', function() {
      window.openFileBrowser('giImage', false, 'files', 'image');
    });
  }
  var btnGiPathInBrowse = document.getElementById('btnGiPathInBrowse');
  if (btnGiPathInBrowse) {
    btnGiPathInBrowse.addEventListener('click', function() {
      window.openFileBrowser('giPathIn', true, 'dir', 'all');
    });
  }
  var btnGiPathOutBrowse = document.getElementById('btnGiPathOutBrowse');
  if (btnGiPathOutBrowse) {
    btnGiPathOutBrowse.addEventListener('click', function() {
      window.openFileBrowser('giPathOut', true, 'dir', 'all');
    });
  }
  // Chevron toggle
  var btnToggle = document.getElementById('btnGlobalToggle');
  if (btnToggle) {
    btnToggle.addEventListener('click', function() {
      var inner = document.getElementById('globalInputsInner');
      if (inner) {
        var collapsed = inner.classList.toggle('collapsed');
        btnToggle.textContent = collapsed ? '\u25B6' : '\u25BC';
        btnToggle.title = collapsed ? 'Expand global inputs' : 'Collapse global inputs';
      }
    });
  }
}

// API Calls
async function checkHealth() {
  try {
    const response = await fetch('/health');
    const data = await response.json();
    state.health = data;
    if (data.warnings && data.warnings.length > 0) {
      elements.statusDot.className = 'status-dot loading';
      elements.statusText.textContent = `${data.warnings.length} Warnings`;
      logConsole(`[HEALTH WARNINGS]:\n${data.warnings.join('\n')}`);
    } else {
      elements.statusDot.className = 'status-dot';
      elements.statusText.textContent = 'System Ready';
    }
  } catch (err) {
    elements.statusDot.className = 'status-dot error';
    elements.statusText.textContent = 'Offline';
    logConsole(`[HEALTH ERROR]: Cannot connect to API backend: ${err.message}`);
  }
}

async function fetchOperations() {
  try {
    const response = await fetch('/ops');
    const data = await response.json();
    state.operations = data;
  } catch (err) {
    logConsole(`[ERROR]: Failed to load operations spec: ${err.message}`);
  }
}

// Tab Switching
function switchTab(tab) {
  state.activeTab = tab;
  
  // Update Active Link UI
  document.querySelectorAll('.nav-item').forEach(item => {
    if (item.getAttribute('data-tab') === tab) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });

  // Update Page Title
  let title = 'Operations';
  if (tab === 'mosh') title = 'Datamosh Smear';
  if (tab === 'deepdream') title = 'Google DeepDream';
  if (tab === 'facemorph') title = 'Face Morph';
  if (tab === 'withoutbg') title = 'withoutBG · Remove Background';
  if (tab === 'styletransfer') title = 'Style Transfer · Magenta';
  if (tab === 'rife') title = 'RIFE · AI Frame Interpolation';
  if (tab === 'transmute') title = 'Single-Clip Transmutations';
  if (tab === 'multi') title = 'Layout Templates (Join / Grid)';
  if (tab === 'quick') title = 'Quick Transmute';
  if (tab === 'watcher') title = 'Folder Watcher';
  if (tab === 'advanced') title = 'Advanced (Raw CLI)';
  // Pool tab: drop the big header title (sidebar already shows active item)
  if (tab === 'pool') title = '';
  elements.tabTitle.textContent = title;

  // Hide Run on library / settings-only tabs
  if (elements.btnRun) {
    elements.btnRun.style.display = (tab === 'pool' || tab === 'quick' || tab === 'watcher') ? 'none' : '';
  }

  // Stop watcher status polling when leaving the tab
  if (tab !== 'watcher' && state.watcher.pollTimer) {
    clearInterval(state.watcher.pollTimer);
    state.watcher.pollTimer = null;
  }

  // Pool takes most of the workspace
  const appContent = document.querySelector('.app-content');
  if (appContent) {
    appContent.classList.toggle('pool-workspace', tab === 'pool');
  }

  // Render Form for the Tab
  renderTabForm(tab);
  updateStatusIndicators();
  // Show/hide global frame row per tab
  var framesRow = document.getElementById('giFramesRow');
  if (framesRow) framesRow.style.display = (tab === 'mosh') ? '' : 'none';
}

// Render Specific Tab Forms
function renderTabForm(tab) {
  elements.actionPanel.innerHTML = '';
  elements.actionPanel.classList.remove('pool-active');

  if (tab === 'mosh') {
    renderMoshForm();
  } else if (tab === 'deepdream') {
    renderDeepDreamForm();
  } else if (tab === 'facemorph') {
    renderFaceMorphForm();
  } else if (tab === 'withoutbg') {
    renderWithoutBgForm();
  } else if (tab === 'styletransfer') {
    renderStyleTransferForm();
  } else if (tab === 'rife') {
    renderRifeForm();
  } else if (tab === 'transmute') {
    renderTransmuteForm();
  } else if (tab === 'multi') {
    renderMultiForm();
  } else if (tab === 'quick') {
    renderQuickTransmuteForm();
  } else if (tab === 'watcher') {
    renderWatcherForm();
  } else if (tab === 'advanced') {
    renderAdvancedForm();
  } else if (tab === 'pool') {
    renderPoolForm();
  }
}
// ── Global video probe → populates global frame range ─────────────────────

async function probeGlobalVideo(path) {
  if (!path) return;
  var gi = window.globalInputs;
  if (path === gi._lastProbedPath) return;
  gi._lastProbedPath = path;

  try {
    const res = await fetch(`/api/probe?path=${encodeURIComponent(path)}`);
    if (!res.ok) return;
    const data = await res.json();
    if (data.ok && data.frames) {
      gi.totalFrames = data.frames;
      gi.frameEnd = data.frames;
      if (gi.frameStart < 1 || gi.frameStart > data.frames) gi.frameStart = 1;

      var totalEl = document.getElementById('giTotalFrames');
      if (totalEl) totalEl.textContent = data.frames;

      var startEl = document.getElementById('giTimelineStart');
      var endEl   = document.getElementById('giTimelineEnd');
      var valS    = document.getElementById('giValStartFrame');
      var valE    = document.getElementById('giValEndFrame');
      if (startEl && endEl) {
        startEl.max = data.frames;
        endEl.max = data.frames;
        startEl.value = gi.frameStart;
        endEl.value   = gi.frameEnd;
        if (valS) valS.value = gi.frameStart;
        if (valE) valE.value = gi.frameEnd;
        startEl.dispatchEvent(new Event('input'));
      }
    }
  } catch (err) {
    console.error("Failed to probe video:", err);
  }
}

// ── Global timeline slider setup ──────────────────────────────────────────

function setupGlobalTimeline() {
  var startEl = document.getElementById('giTimelineStart');
  var endEl   = document.getElementById('giTimelineEnd');
  var rangeEl = document.getElementById('giTimelineRange');
  var valS    = document.getElementById('giValStartFrame');
  var valE    = document.getElementById('giValEndFrame');
  if (!startEl || !endEl || !rangeEl) return;

  function maxFrames() {
    var m = parseInt(window.globalInputs.totalFrames, 10);
    return (m > 1) ? m : 2;
  }

  function sync() {
    var m = maxFrames();
    startEl.min = 1; startEl.max = m;
    endEl.min   = 1; endEl.max   = m;

    var s = parseInt(startEl.value, 10);
    var e = parseInt(endEl.value, 10);
    if (isNaN(s)) s = 1;
    if (isNaN(e)) e = m;
    if (s >= e) { s = Math.max(1, e - 1); startEl.value = s; }
    if (e <= s) { e = Math.min(m, s + 1); endEl.value = e; }

    var span = Math.max(1, m - 1);
    var pL   = ((s - 1) / span) * 100;
    var pW   = Math.max(0, ((e - 1) / span) * 100 - pL);
    rangeEl.style.left  = pL + '%';
    rangeEl.style.width = pW + '%';

    if (valS && document.activeElement !== valS) valS.value = s;
    if (valE && document.activeElement !== valE) valE.value = e;

    window.globalInputs.frameStart = s;
    window.globalInputs.frameEnd   = e;
  }

  startEl.addEventListener('input', sync);
  endEl.addEventListener('input', sync);

  // Range dragging: drag the blue bar to slide the whole window
  var rangeDragging = false;
  var dragStartX = 0;
  var dragStartValL = 0;
  var dragStartValR = 0;

  function onRangeMouseDown(e) {
    if (e.target !== rangeEl) return;
    rangeDragging = true;
    dragStartX = e.clientX;
    dragStartValL = parseInt(startEl.value, 10);
    dragStartValR = parseInt(endEl.value, 10);
    rangeEl.classList.add('active');
    window.addEventListener('mousemove', onRangeMouseMove);
    window.addEventListener('mouseup', onRangeMouseUp);
    e.preventDefault();
    e.stopPropagation();
  }

  function onRangeMouseMove(e) {
    if (!rangeDragging) return;
    var m = maxFrames();
    var trackRect = startEl.getBoundingClientRect();
    var trackWidth = trackRect.width;
    if (trackWidth <= 0) return;
    var deltaX = e.clientX - dragStartX;
    var deltaFrames = Math.round((deltaX / trackWidth) * Math.max(1, m - 1));
    var span = dragStartValR - dragStartValL;
    var ns = dragStartValL + deltaFrames;
    var ne = dragStartValR + deltaFrames;
    if (ns < 1) { ns = 1; ne = ns + span; }
    if (ne > m) { ne = m; ns = ne - span; }
    startEl.value = ns;
    endEl.value = ne;
    sync();
  }

  function onRangeMouseUp() {
    rangeDragging = false;
    rangeEl.classList.remove('active');
    window.removeEventListener('mousemove', onRangeMouseMove);
    window.removeEventListener('mouseup', onRangeMouseUp);
  }

  rangeEl.addEventListener('mousedown', onRangeMouseDown);

  // Touch support for the blue range handle
  rangeEl.addEventListener('touchstart', function(e) {
    if (!e.touches || !e.touches[0]) return;
    var t = e.touches[0];
    rangeDragging = true;
    dragStartX = t.clientX;
    dragStartValL = parseInt(startEl.value, 10);
    dragStartValR = parseInt(endEl.value, 10);
    rangeEl.classList.add('active');
    var onMove = function(ev) {
      if (!rangeDragging || !ev.touches || !ev.touches[0]) return;
      onRangeMouseMove({ clientX: ev.touches[0].clientX });
      ev.preventDefault();
    };
    var onEnd = function() {
      onRangeMouseUp();
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
    };
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onEnd);
    e.preventDefault();
  }, { passive: false });

  [valS, valE].forEach(function(el) {
    if (!el) return;
    function commit() {
      var raw = parseInt(String(el.value).replace(/[^0-9]/g, ''), 10);
      var m = maxFrames();
      if (isNaN(raw)) raw = (el === valS ? 1 : m);
      if (el === valS) {
        raw = Math.min(Math.max(1, raw), parseInt(endEl.value, 10) - 1);
        startEl.value = raw;
      } else {
        raw = Math.max(Math.min(m, raw), parseInt(startEl.value, 10) + 1);
        endEl.value = raw;
      }
      sync();
    }
    el.addEventListener('change', commit);
    el.addEventListener('blur', commit);
    el.addEventListener('keydown', function(e) { if (e.key === 'Enter') { el.blur(); e.preventDefault(); } });
  });

  sync();
}

function setupTimelineSlider(hiddenStartId, hiddenEndId, defaultStart, defaultEnd) {
  const startInput = document.getElementById('timelineStart');
  const endInput = document.getElementById('timelineEnd');
  const rangeHighlight = document.getElementById('timelineRange');
  const valStart = document.getElementById('valStartFrame');
  const valEnd = document.getElementById('valEndFrame');

  const hiddenStart = document.getElementById(hiddenStartId);
  const hiddenEnd = document.getElementById(hiddenEndId);

  if (!startInput || !endInput || !rangeHighlight || !hiddenStart || !hiddenEnd || !valStart || !valEnd) return;

  function currentMaxFrames() {
    const fromState = parseInt(state.moshVideoFrames, 10);
    const fromDom = parseInt(startInput.max, 10);
    const max = fromState || fromDom || 100;
    return max > 1 ? max : 2; // avoid divide-by-zero in percent math
  }

  function applyMax(maxFrames) {
    startInput.min = 1;
    startInput.max = maxFrames;
    endInput.min = 1;
    endInput.max = maxFrames;
  }

  let maxFrames = currentMaxFrames();
  applyMax(maxFrames);

  let initStart = parseInt(hiddenStart.value, 10) || defaultStart;
  let initEnd = parseInt(hiddenEnd.value, 10) || defaultEnd;

  if (initStart > maxFrames) initStart = 1;
  if (initEnd > maxFrames || initEnd === 999999) initEnd = maxFrames;
  if (initStart < 1) initStart = 1;
  if (initEnd <= initStart) initEnd = Math.min(maxFrames, initStart + 1);

  startInput.value = initStart;
  endInput.value = initEnd;

  function updateTimeline() {
    maxFrames = currentMaxFrames();
    applyMax(maxFrames);

    let startVal = parseInt(startInput.value, 10);
    let endVal = parseInt(endInput.value, 10);
    if (isNaN(startVal)) startVal = 1;
    if (isNaN(endVal)) endVal = maxFrames;

    // Keep at least 1 frame of distance
    if (startVal >= endVal) {
      if (this === startInput) {
        startVal = Math.max(1, endVal - 1);
        startInput.value = startVal;
      } else {
        endVal = Math.min(maxFrames, startVal + 1);
        endInput.value = endVal;
      }
    }

    const span = Math.max(1, maxFrames - 1);
    const percentLeft = ((startVal - 1) / span) * 100;
    const percentRight = ((endVal - 1) / span) * 100;
    const widthPct = Math.max(0, percentRight - percentLeft);

    rangeHighlight.style.left = `${percentLeft}%`;
    rangeHighlight.style.width = `${widthPct}%`;

    if (document.activeElement !== valStart) {
      valStart.value = startVal;
    }
    if (document.activeElement !== valEnd) {
      valEnd.value = endVal;
    }

    hiddenStart.value = startVal;
    hiddenEnd.value = endVal;
  }

  startInput.addEventListener('input', updateTimeline);
  endInput.addEventListener('input', updateTimeline);

  // Range dragging: drag the blue bar to slide the whole window
  let rangeDragging = false;
  let dragStartX = 0;
  let dragStartValL = 0;
  let dragStartValR = 0;

  function onRangeMouseDown(e) {
    // Ignore if a thumb is the real target (they sit above the bar)
    if (e.target !== rangeHighlight) return;

    rangeDragging = true;
    dragStartX = e.clientX;
    dragStartValL = parseInt(startInput.value, 10);
    dragStartValR = parseInt(endInput.value, 10);

    rangeHighlight.classList.add('active');

    window.addEventListener('mousemove', onRangeMouseMove);
    window.addEventListener('mouseup', onRangeMouseUp);
    e.preventDefault();
    e.stopPropagation();
  }

  function onRangeMouseMove(e) {
    if (!rangeDragging) return;

    maxFrames = currentMaxFrames();
    const trackRect = startInput.getBoundingClientRect();
    const trackWidth = trackRect.width;
    if (trackWidth <= 0) return;

    const deltaX = e.clientX - dragStartX;
    const deltaFrames = Math.round((deltaX / trackWidth) * Math.max(1, maxFrames - 1));

    let newStart = dragStartValL + deltaFrames;
    let newEnd = dragStartValR + deltaFrames;
    const rangeSpan = dragStartValR - dragStartValL;

    if (newStart < 1) {
      newStart = 1;
      newEnd = newStart + rangeSpan;
    }
    if (newEnd > maxFrames) {
      newEnd = maxFrames;
      newStart = newEnd - rangeSpan;
    }

    startInput.value = newStart;
    endInput.value = newEnd;

    updateTimeline();
  }

  function onRangeMouseUp() {
    rangeDragging = false;
    rangeHighlight.classList.remove('active');
    window.removeEventListener('mousemove', onRangeMouseMove);
    window.removeEventListener('mouseup', onRangeMouseUp);
  }

  rangeHighlight.addEventListener('mousedown', onRangeMouseDown);
  // Touch support for the blue range handle
  rangeHighlight.addEventListener('touchstart', (e) => {
    if (!e.touches || !e.touches[0]) return;
    const t = e.touches[0];
    rangeDragging = true;
    dragStartX = t.clientX;
    dragStartValL = parseInt(startInput.value, 10);
    dragStartValR = parseInt(endInput.value, 10);
    rangeHighlight.classList.add('active');
    const onMove = (ev) => {
      if (!rangeDragging || !ev.touches || !ev.touches[0]) return;
      onRangeMouseMove({ clientX: ev.touches[0].clientX });
      ev.preventDefault();
    };
    const onEnd = () => {
      onRangeMouseUp();
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
    };
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onEnd);
    e.preventDefault();
  }, { passive: false });

  // Editable inputs key listeners
  function onTextSubmit() {
    maxFrames = currentMaxFrames();
    let sVal = parseInt(String(valStart.value).replace(/[^0-9]/g, ''), 10);
    let eVal = parseInt(String(valEnd.value).replace(/[^0-9]/g, ''), 10);

    if (isNaN(sVal)) sVal = 1;
    if (isNaN(eVal)) eVal = maxFrames;

    if (sVal < 1) sVal = 1;
    if (eVal > maxFrames) eVal = maxFrames;

    if (sVal >= eVal) {
      if (this === valStart) {
        sVal = Math.max(1, eVal - 1);
      } else {
        eVal = Math.min(maxFrames, sVal + 1);
      }
    }

    startInput.value = sVal;
    endInput.value = eVal;

    updateTimeline();
  }

  valStart.addEventListener('change', onTextSubmit);
  valStart.addEventListener('blur', onTextSubmit);
  valStart.addEventListener('keydown', (e) => { if (e.key === 'Enter') { valStart.blur(); e.preventDefault(); } });

  valEnd.addEventListener('change', onTextSubmit);
  valEnd.addEventListener('blur', onTextSubmit);
  valEnd.addEventListener('keydown', (e) => { if (e.key === 'Enter') { valEnd.blur(); e.preventDefault(); } });

  // Initial update — paints the blue selected-range bar
  updateTimeline();
}

import {
  renderPoolForm, renderPoolGrid, sequencePositions,
} from '/js/pool/grid.js';
import {
  setPoolZoom, applyPoolZoom, setupTileInfoMenu, refreshPoolTileOverlays,
  hidePoolContextMenu, showPoolContextMenu,
  closeFbModal, browsePath, navigateUpFb, confirmFbSelection,
  formatBytes,
} from '/js/pool/chrome.js';
import {
  gcdInt, setPreviewAspect, clearPreviewAspect,
  fitPreviewViewer, setupPreviewConsoleResize,
  showPreview, logConsole,
} from '/js/preview.js';



// Flush pool state before leaving
window.addEventListener('beforeunload', () => {
  if (!_poolPersistReady) return;
  try {
    const blob = new Blob([JSON.stringify(buildPoolStatePayload())], { type: 'application/json' });
    navigator.sendBeacon?.('/api/pool/state', blob);
  } catch (_) { /* ignore */ }
});

// Run on page load
window.addEventListener('DOMContentLoaded', init);

// ── ES module exports ───────────────────────────────────────────────────

export {
  state, elements, 
  init, switchTab, renderTabForm,
  bestInput, bestOutput, resolveGlobalImage, resolveGlobalImages,
  TAB_ACCEPTS, detectFileType,
  logConsole, fitPreviewViewer,
  probeGlobalVideo, updateGlobalInputs, updateStatusIndicators,
  showPreview,
  selectPoolItem, removePoolItem, sequencePositions,
  loadPoolItemMeta, setPreviewAspect, clearPreviewAspect,
  collectFaceMorphBody,
  collectWithoutBgBody, collectStyleTransferBody, collectRifeBody,
  renderFaceMorphForm,
  renderWithoutBgForm, renderStyleTransferForm, renderRifeForm,
  renderQuickTransmuteForm,
  renderWatcherForm, renderPoolForm, renderPoolGrid,
  checkHealth, addPathsToPool,
  sendPoolPathTo, applyPoolAsInput, formatBytes,
  ensureTileInfo, defaultTileInfo,
  setPoolZoom, applyPoolZoom, setupTileInfoMenu, showPoolContextMenu,
};
