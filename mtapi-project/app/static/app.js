// State
import { isVideoPath, basename, formatDurationExact, escapeHtml } from '/js/utils.js';
import { setupContinuousKnob, setupBinaryKnob, knobUnitHtml } from '/js/ui/knobs.js';
import { POOL_LAYOUT_DEFAULTS, VIDEO_EXTS, TILE_INFO_FIELDS, POOL_ZOOM } from '/js/pool/constants.js';
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
import { renderQuickTransmuteForm, runQuickTransmute } from '/js/tabs/quick.js';
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

// ─── Media Pool ───────────────────────────────────────────────────────────

function renderPoolForm() {
  const count = state.pool.items.length;
  const seqCount = state.pool.sequence.length;
  const selected = state.pool.selectedPath;
  const rec = state.pool.reconcile || 'pad';
  const outVal = state.pool.outputPath || '';

  const L = ensurePoolLayout();
  const col = L.collapsed;

  const html = `
    <div class="pool-workspace-inner">
      <div class="pool-top">
        <div class="pool-toolbar">
          <div class="pool-toolbar-actions">
            <div class="pool-project-group">
              <button type="button" class="btn" id="btnProjectNew" title="New empty project">New</button>
              <button type="button" class="btn" id="btnProjectOpen" title="Open .ffproject.json">Open…</button>
              <button type="button" class="btn btn-primary" id="btnProjectSave" title="Save project">Save</button>
              <button type="button" class="btn" id="btnProjectSaveAs" title="Save project as…">Save As…</button>
              <span class="pool-project-name" id="poolProjectName" title="${escapeHtml(state.project.path || '')}">${escapeHtml(projectLabel())}</span>
            </div>

            <button class="btn btn-primary" id="btnPoolImportFiles" type="button">+ Files</button>
            <button class="btn" id="btnPoolImportFolder" type="button">+ Folder</button>
            <button class="btn" id="btnPoolClear" type="button" ${count === 0 ? 'disabled' : ''}>Clear Pool</button>
            <button class="btn" id="btnSeqClear" type="button" ${seqCount === 0 ? 'disabled' : ''}>Clear Sequence</button>

            <div class="pool-zoom-group" title="Tile size">
              <button type="button" class="btn pool-zoom-btn" id="btnZoomMin" title="Minimum size">min</button>
              <button type="button" class="btn pool-zoom-btn" id="btnZoomOut" title="Zoom out">−</button>
              <button type="button" class="btn pool-zoom-btn pool-zoom-reset" id="btnZoomReset" title="Reset size (default)">reset</button>
              <button type="button" class="btn pool-zoom-btn" id="btnZoomIn" title="Zoom in">+</button>
              <button type="button" class="btn pool-zoom-btn" id="btnZoomMax" title="Maximum size">max</button>
            </div>

            <div class="pool-info-menu-wrap">
              <button type="button" class="btn" id="btnTileInfoMenu" title="Choose tile overlay fields">Info ▾</button>
              <div class="pool-info-menu" id="tileInfoMenu" hidden>
                <div class="pool-info-menu-title">Show on tiles</div>
                <div class="pool-info-menu-actions">
                  <button type="button" class="btn pool-info-mini" id="btnTileInfoAll">All</button>
                  <button type="button" class="btn pool-info-mini" id="btnTileInfoNone">None</button>
                </div>
                <div class="pool-info-checks" id="tileInfoChecks"></div>
              </div>
            </div>
          </div>
          <div class="pool-toolbar-meta">
            <span class="pool-count">${count} in pool · ${seqCount} in sequence</span>
            ${selected ? `
              <div class="pool-use-wrap">
                <label for="poolUseTarget" class="pool-use-label">Use as input</label>
                <select id="poolUseTarget" class="pool-use-select">
                  <option value="">— target —</option>
                  <option value="sequence">Add to sequence</option>
                  <option value="mosh">Datamosh input</option>
                  <option value="transmute">Transmute input</option>
                  <option value="multi">Add to Multi clips</option>
                  <option value="advanced">Advanced input</option>
                </select>
                <button class="btn btn-primary" id="btnPoolUse" type="button">Apply</button>
              </div>
            ` : ''}
          </div>
        </div>

        <div class="pool-grid-wrap">
          <div class="pool-grid" id="poolGrid"></div>
        </div>
      </div>

      <div class="pool-v-resize" id="poolVResize" title="Drag to resize dock"></div>

      <div class="pool-compose" id="poolCompose">
        <div class="pool-sequence-panel${col.sequence ? ' is-collapsed' : ''}" id="poolSequencePanel">
          <div class="pool-section-head" data-collapse="sequence">
            <button type="button" class="pool-collapse-btn" title="Collapse / expand sequence" aria-expanded="${!col.sequence}">
              <span class="pool-collapse-chevron">${col.sequence ? '▸' : '▾'}</span>
            </button>
            <span class="pool-section-title">Sequence</span>
            <div class="seq-transport" id="seqTransport" onclick="event.stopPropagation()">
              <button type="button" class="btn seq-ctrl" id="btnSeqPrev" title="Previous clip" ${seqCount === 0 ? 'disabled' : ''}>⏮</button>
              <button type="button" class="btn seq-ctrl seq-ctrl-play" id="btnSeqPlay" title="Play sequence" ${seqCount === 0 ? 'disabled' : ''}>▶</button>
              <button type="button" class="btn seq-ctrl" id="btnSeqPause" title="Pause" disabled>⏸</button>
              <button type="button" class="btn seq-ctrl" id="btnSeqStop" title="Stop" disabled>■</button>
              <button type="button" class="btn seq-ctrl" id="btnSeqNext" title="Next clip" ${seqCount === 0 ? 'disabled' : ''}>⏭</button>
              <button type="button" class="btn seq-ctrl ${state.pool.playback.loop ? 'active' : ''}" id="btnSeqLoop" title="Loop sequence" ${seqCount === 0 ? 'disabled' : ''}>🔁</button>
              <span class="seq-play-status" id="seqPlayStatus">—</span>
              <span class="seq-reorder-sep" aria-hidden="true"></span>
              <button type="button" class="btn seq-ctrl seq-reorder" id="btnSeqMoveFirst" title="Move selected to start" disabled>&lt;&lt;</button>
              <button type="button" class="btn seq-ctrl seq-reorder" id="btnSeqMoveLeft" title="Move selected earlier" disabled>&lt;</button>
              <button type="button" class="btn seq-ctrl seq-reorder" id="btnSeqMoveRight" title="Move selected later" disabled>&gt;</button>
              <button type="button" class="btn seq-ctrl seq-reorder" id="btnSeqMoveLast" title="Move selected to end" disabled>&gt;&gt;</button>
            </div>
          </div>
          <div class="pool-section-body" data-section="sequence">
            <div class="pool-sequence-box" id="poolSequenceBox" tabindex="0"></div>
            <div class="seq-clip-settings" id="seqClipSettings" hidden>
              <span class="seq-clip-settings-label">Selected clip</span>
              <span class="seq-clip-settings-name" id="seqClipName">—</span>
              <label class="pool-opt-label" title="Stretch or compress this clip to a target length in the stitch">Time (s)
                <input type="number" id="seqClipDuration" min="0.05" step="0.05" placeholder="native" class="seq-clip-dur-input">
              </label>
              <button type="button" class="btn pool-info-mini" id="btnSeqClipDurClear" title="Use original duration">Native</button>
              <span class="seq-clip-settings-hint" id="seqClipDurHint"></span>
            </div>
            <div class="pool-sequence-bar">
              <div class="pool-sequence-opts">
                <label class="pool-opt-label" title="How clips are scaled onto the canvas">Fit
                  <select id="poolReconcile">
                    <option value="pad" ${rec === 'pad' ? 'selected' : ''}>Pad (scale up, letterbox if AR differs)</option>
                    <option value="crop" ${rec === 'crop' ? 'selected' : ''}>Crop (scale up, center-crop if AR differs)</option>
                    <option value="stretch" ${rec === 'stretch' ? 'selected' : ''}>Stretch (warp AR)</option>
                  </select>
                </label>
                <label class="pool-opt-label" title="Target canvas aspect ratio">AR
                  <select id="poolAspect">
                    <option value="auto" ${(state.pool.aspect || 'auto') === 'auto' ? 'selected' : ''}>Auto</option>
                    <option value="1:1" ${state.pool.aspect === '1:1' ? 'selected' : ''}>1:1</option>
                    <option value="16:9" ${state.pool.aspect === '16:9' ? 'selected' : ''}>16:9</option>
                    <option value="9:16" ${state.pool.aspect === '9:16' ? 'selected' : ''}>9:16</option>
                    <option value="3:2" ${state.pool.aspect === '3:2' ? 'selected' : ''}>3:2</option>
                    <option value="2:3" ${state.pool.aspect === '2:3' ? 'selected' : ''}>2:3</option>
                    <option value="4:3" ${state.pool.aspect === '4:3' ? 'selected' : ''}>4:3</option>
                    <option value="3:4" ${state.pool.aspect === '3:4' ? 'selected' : ''}>3:4</option>
                    <option value="custom" ${state.pool.aspect === 'custom' ? 'selected' : ''}>Custom…</option>
                  </select>
                </label>
                <input type="text" id="poolAspectCustom" class="pool-aspect-custom"
                  placeholder="W:H or WxH" title="Custom aspect e.g. 5:4 or 1080x1920"
                  value="${escapeHtml(state.pool.aspectCustom || '')}"
                  style="display:${state.pool.aspect === 'custom' ? 'inline-block' : 'none'}; width: 100px;">
                <div class="input-row pool-out-row">
                  <input type="text" id="poolOutput" placeholder="Output path (blank = auto .mp4)" value="${escapeHtml(outVal)}">
                  <button class="btn" type="button" id="btnPoolOutBrowse">Save As</button>
                </div>
              </div>
              <button class="btn btn-primary pool-stitch-btn" id="btnPoolStitch" type="button" ${seqCount < 2 ? 'disabled' : ''}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16">
                  <polygon points="5 3 19 12 5 21 5 3"/>
                </svg>
                Stitch Sequence
              </button>
            </div>
          </div>
        </div>

        <div class="pool-h-resize" id="poolHResize" title="Drag to resize panels"></div>

        <div class="pool-focus-panel" id="poolFocusPanel">
          <div class="pool-focus-header">
            <div class="pool-section-head pool-section-head-inline" data-collapse="selection">
              <button type="button" class="pool-collapse-btn" title="Collapse / expand selection frames" aria-expanded="${!col.selection}">
                <span class="pool-collapse-chevron">${col.selection ? '▸' : '▾'}</span>
              </button>
              <span class="pool-section-title">Selection</span>
            </div>
            <div class="pool-match-controls">
              <label class="pool-match-label" title="pHash Hamming distance (0 = exact under hash)">
                ≤
                <input type="range" id="matchDistance" min="0" max="24" value="${state.pool.matchMaxDistance}" step="1">
                <span id="matchDistanceVal">${state.pool.matchMaxDistance}</span>
              </label>
              <select id="matchMode" class="pool-match-mode" title="Match direction">
                <option value="next" ${state.pool.matchMode === 'next' ? 'selected' : ''}>Next (last→first)</option>
                <option value="prev" ${state.pool.matchMode === 'prev' ? 'selected' : ''}>Prev (first→last)</option>
                <option value="both" ${state.pool.matchMode === 'both' ? 'selected' : ''}>Both</option>
              </select>
              <button type="button" class="btn btn-primary pool-match-btn" id="btnFindNext" ${selected ? '' : 'disabled'} title="Compare selection frame to pool via pHash">
                Find matches
              </button>
            </div>
          </div>

          <div class="pool-section-body${col.selection ? ' is-collapsed' : ''}" data-section="selection" id="poolSelectionBody">
            <div class="pool-focus-frame" id="poolFocusFrame">
              <div class="pool-focus-empty">Hover or click a clip</div>
            </div>
          </div>

          <div class="pool-sel-match-resize" id="poolSelMatchResize" title="Drag to resize selection vs matches"></div>

          <div class="pool-match-block${col.matches ? ' is-collapsed' : ''}" id="poolMatchBlock">
            <div class="pool-section-head" data-collapse="matches">
              <button type="button" class="pool-collapse-btn" title="Collapse / expand matches" aria-expanded="${!col.matches}">
                <span class="pool-collapse-chevron">${col.matches ? '▸' : '▾'}</span>
              </button>
              <span class="pool-section-title">Matches</span>
              <span class="pool-match-count-badge" id="matchCountBadge"></span>
              <button type="button" class="btn pool-info-mini" id="btnExpandMatches" title="Give matches more room (collapse selection, grow dock)">Expand</button>
            </div>
            <div class="pool-section-body" data-section="matches">
              <div class="pool-match-results" id="poolMatchResults" hidden></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  elements.actionPanel.innerHTML = html;
  elements.actionPanel.classList.add('pool-active');

  document.getElementById('btnProjectNew')?.addEventListener('click', projectNew);
  document.getElementById('btnProjectOpen')?.addEventListener('click', projectOpen);
  document.getElementById('btnProjectSave')?.addEventListener('click', () => projectSave(false));
  document.getElementById('btnProjectSaveAs')?.addEventListener('click', () => projectSave(true));

  document.getElementById('btnPoolImportFiles')?.addEventListener('click', importPoolFiles);
  document.getElementById('btnPoolImportFolder')?.addEventListener('click', importPoolFolder);
  document.getElementById('btnPoolClear')?.addEventListener('click', clearPool);
  document.getElementById('btnSeqClear')?.addEventListener('click', clearSequence);
  document.getElementById('btnPoolUse')?.addEventListener('click', applyPoolAsInput);
  document.getElementById('btnPoolStitch')?.addEventListener('click', stitchPoolSequence);
  document.getElementById('btnPoolOutBrowse')?.addEventListener('click', () => {
    openFileBrowser('poolOutput', false, 'file_save');
  });
  document.getElementById('poolReconcile')?.addEventListener('change', (e) => {
    state.pool.reconcile = e.target.value;
    scheduleSavePoolState();
  });
  document.getElementById('poolAspect')?.addEventListener('change', (e) => {
    state.pool.aspect = e.target.value;
    const custom = document.getElementById('poolAspectCustom');
    if (custom) custom.style.display = state.pool.aspect === 'custom' ? 'inline-block' : 'none';
    scheduleSavePoolState();
  });
  document.getElementById('poolAspectCustom')?.addEventListener('input', (e) => {
    state.pool.aspectCustom = e.target.value.trim();
    scheduleSavePoolState();
  });
  document.getElementById('poolOutput')?.addEventListener('input', (e) => {
    state.pool.outputPath = e.target.value;
    scheduleSavePoolState();
  });

  // Zoom controls
  document.getElementById('btnZoomMin')?.addEventListener('click', () => setPoolZoom(POOL_ZOOM.min));
  document.getElementById('btnZoomOut')?.addEventListener('click', () => setPoolZoom(state.pool.tileZoom - POOL_ZOOM.step));
  document.getElementById('btnZoomReset')?.addEventListener('click', () => setPoolZoom(POOL_ZOOM.reset));
  document.getElementById('btnZoomIn')?.addEventListener('click', () => setPoolZoom(state.pool.tileZoom + POOL_ZOOM.step));
  document.getElementById('btnZoomMax')?.addEventListener('click', () => setPoolZoom(POOL_ZOOM.max));

  // Frame match controls
  document.getElementById('matchDistance')?.addEventListener('input', (e) => {
    state.pool.matchMaxDistance = parseInt(e.target.value, 10) || 0;
    const val = document.getElementById('matchDistanceVal');
    if (val) val.textContent = String(state.pool.matchMaxDistance);
  });
  document.getElementById('matchMode')?.addEventListener('change', (e) => {
    state.pool.matchMode = e.target.value;
  });
  document.getElementById('btnFindNext')?.addEventListener('click', runPoolMatch);

  // Tile info menu
  setupTileInfoMenu();

  // Sequence transport
  document.getElementById('btnSeqPlay')?.addEventListener('click', seqPlay);
  document.getElementById('btnSeqPause')?.addEventListener('click', seqPause);
  document.getElementById('btnSeqStop')?.addEventListener('click', seqStop);
  document.getElementById('btnSeqPrev')?.addEventListener('click', seqPrev);
  document.getElementById('btnSeqNext')?.addEventListener('click', seqNext);
  document.getElementById('btnSeqLoop')?.addEventListener('click', () => {
    state.pool.playback.loop = !state.pool.playback.loop;
    document.getElementById('btnSeqLoop')?.classList.toggle('active', state.pool.playback.loop);
    updateSeqTransportUI();
  });
  document.getElementById('btnSeqMoveFirst')?.addEventListener('click', (e) => {
    e.stopPropagation();
    moveSelectedInSequence('start');
  });
  document.getElementById('btnSeqMoveLeft')?.addEventListener('click', (e) => {
    e.stopPropagation();
    moveSelectedInSequence(-1);
  });
  document.getElementById('btnSeqMoveRight')?.addEventListener('click', (e) => {
    e.stopPropagation();
    moveSelectedInSequence(1);
  });
  document.getElementById('btnSeqMoveLast')?.addEventListener('click', (e) => {
    e.stopPropagation();
    moveSelectedInSequence('end');
  });

  const durInput = document.getElementById('seqClipDuration');
  durInput?.addEventListener('change', onSeqClipDurationChange);
  durInput?.addEventListener('blur', onSeqClipDurationChange);
  let _durInputSaveTimer = null;
  durInput?.addEventListener('input', () => {
    // live preview of color/label without waiting for blur — don't rewrite the input
    const idx = findSelectedSeqIndex();
    if (idx < 0) return;
    const raw = durInput.value.trim();
    if (!raw) {
      state.pool.sequence[idx].targetDuration = null;
    } else {
      const v = parseFloat(raw);
      if (Number.isFinite(v) && v > 0) {
        state.pool.sequence[idx].targetDuration = v;
        state.pool.selectedSeqId = state.pool.sequence[idx].id;
      }
    }
    // Update only duration text colors on tokens (avoid full rebind / focus loss)
    applySeqTokenTimeStyles();
    // update hint only
    const hint = document.getElementById('seqClipDurHint');
    const entry = state.pool.sequence[idx];
    const meta = findPoolItem(entry.path)?.meta;
    const native = meta?.duration;
    if (hint) {
      if (entry.targetDuration != null && entry.targetDuration > 0 && native > 0) {
        const factor = entry.targetDuration / native;
        const pct = Math.round((native / entry.targetDuration) * 100);
        hint.textContent = `native ${formatDurationExact(native)} → ${formatDurationExact(entry.targetDuration)} (${pct}% speed ${factor >= 1 ? 'slower' : 'faster'})`;
      } else if (native > 0) {
        hint.textContent = `native ${formatDurationExact(native)} (no stretch)`;
      } else {
        hint.textContent = 'set target length to stretch in time';
      }
    }
    if (_durInputSaveTimer) clearTimeout(_durInputSaveTimer);
    _durInputSaveTimer = setTimeout(() => scheduleSavePoolState(), 300);
  });
  durInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onSeqClipDurationChange();
      durInput.blur();
    }
  });
  document.getElementById('btnSeqClipDurClear')?.addEventListener('click', () => {
    const idx = findSelectedSeqIndex();
    if (idx < 0) return;
    state.pool.sequence[idx].targetDuration = null;
    const inp = document.getElementById('seqClipDuration');
    if (inp) inp.value = '';
    updateSeqClipSettings();
    renderSequenceBox();
    scheduleSavePoolState();
    logConsole(`[SEQ]: Cleared time stretch for ${state.pool.sequence[idx].name}`);
  });

  setupSequenceDropZone();
  updateSeqClipSettings();
  setupPoolLayoutChrome();
  applyPoolZoom();
  renderPoolGrid();
  renderSequenceBox();
  updatePoolFocusFrame(displayFocusPath());
  updateSelectionHighlights();
  updateSeqTransportUI();
  // Re-show last match results if any
  if (state.pool.matchResults) {
    renderMatchResults(state.pool.matchResults);
  }
}


function sequencePositions(path) {
  const out = [];
  state.pool.sequence.forEach((s, i) => {
    if (s.path === path) out.push(i + 1);
  });
  return out;
}

function showClipInfoOverlay(item) {
  const m = item.meta || {};
  const name = item.name || basename(item.path);
  const path = item.path || '';
  const hash = item.hash || m.hash || '';
  const dur = m.duration != null ? formatDurationExact(m.duration) : '—';
  const fps = m.fps != null && m.fps > 0 ? `${m.fps} fps` : '—';
  const frames = m.frames != null ? `${m.frames}` : '—';
  const vcodec = m.video_codec || '—';
  const acodec = m.audio_codec || '—';
  const size = m.size != null ? formatBytes(m.size) : (item.size != null ? formatBytes(item.size) : '—');
  const dims = m.width && m.height ? `${m.width}×${m.height}` : '—';
  const seqPos = sequencePositions(path);
  const seqStr = seqPos.length > 0 ? seqPos.join(' ') : '—';
  const cacheTag = m.cached === true ? 'cached' : (m.cached === false ? 'new' : '—');
  const history = m.history_count != null ? m.history_count : (item.history_count || 0);
  const opens = m.open_count != null ? m.open_count : (item.open_count || 0);

  const rows = [
    ['name', name],
    ['path', path],
    ['hash', hash ? shortHash(hash) : '—'],
    ['sequence', seqStr, 'info-seq'],
    ['duration', dur],
    ['resolution', dims],
    ['fps', fps],
    ['frames', frames],
    ['video codec', vcodec],
    ['audio codec', acodec],
    ['file size', size],
    ['cache', cacheTag],
    ['opens / history', `${opens} / ${history}`],
  ];

  const overlay = document.createElement('div');
  overlay.className = 'pool-info-overlay';
  overlay.innerHTML = `<div class="pool-info-panel">
    <button class="pool-info-close" type="button" title="Close">✕</button>
    <h3>${escapeHtml(name)}</h3>
    ${rows.map(([label, value, extraClass]) => {
      const cls = extraClass ? `info-value ${extraClass}` : 'info-value';
      return `<div class="info-row">
        <span class="info-label">${label}</span>
        <span class="${cls}">${escapeHtml(String(value))}</span>
      </div>`;
    }).join('')}
  </div>`;

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.closest('.pool-info-close')) {
      overlay.remove();
    }
  });

  document.body.appendChild(overlay);
}

function renderPoolGrid() {
  const grid = document.getElementById('poolGrid');
  if (!grid) return;

  if (state.pool.items.length === 0) {
    grid.innerHTML = `
      <div class="pool-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
          <rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>
        </svg>
        <p>No videos in the pool.</p>
        <p class="pool-empty-hint">Import files/folder, then drag cards into the sequence strip.</p>
      </div>
    `;
    return;
  }

  grid.innerHTML = '';
  state.pool.items.forEach((item, idx) => {
    const card = document.createElement('article');
    const isSelected = state.pool.selectedPath === item.path;
    const isHovered = state.pool.hoverPath === item.path;
    const seqPos = sequencePositions(item.path);
    card.className = `pool-card${isSelected ? ' selected' : ''}${isHovered ? ' hovered' : ''}${seqPos.length > 0 ? ' seq-active' : ''}`;
    card.dataset.path = item.path;
    card.dataset.idx = String(idx);
    card.draggable = true;
    card.title = 'Drag into sequence to stitch';

    const firstSrc = poolThumbUrl(item, 'first');
    const lastSrc = poolThumbUrl(item, 'last');
    const meta = item.meta;
    const loadingMeta = !meta && !item.metaError;
    const info = ensureTileInfo();
    const showLabels = info.frame_labels !== false;
    const metaHtml = loadingMeta
      ? '<span class="pool-meta-loading">hashing + probing…</span>'
      : buildPoolMetaHtml(item);
    const hasOverlay = loadingMeta || (metaHtml && metaHtml.trim().length > 0);

    card.innerHTML = `
      <div class="pool-card-actions">
        <div class="pool-send-wrap">
          <button type="button" class="btn pool-send-btn" title="Send this clip to a tool">Send to ▾</button>
          <div class="pool-send-menu" hidden>
            <button type="button" class="pool-send-item pool-send-quick" data-send="quick">${escapeHtml(quickTransmuteLabel())}</button>
            <div class="pool-send-sep"></div>
            <button type="button" class="pool-send-item" data-send="mosh">Datamosh</button>
            <button type="button" class="pool-send-item" data-send="deepdream">DeepDream</button>
            <button type="button" class="pool-send-item" data-send="transmute">Transmute</button>
            <button type="button" class="pool-send-item" data-send="multi">Multi (Join/Grid)</button>
            <button type="button" class="pool-send-item" data-send="advanced">Raw CLI</button>
            <button type="button" class="pool-send-item" data-send="sequence">Sequence</button>
            <button type="button" class="pool-send-item" data-send="preview">Preview only</button>
            <div class="pool-send-sep"></div>
            <button type="button" class="pool-send-item" data-send="save_first_png">Save first frame PNG…</button>
            <button type="button" class="pool-send-item" data-send="save_last_png">Save last frame PNG…</button>
          </div>
        </div>
        <button class="pool-card-remove" type="button" title="Remove from pool" data-remove="${idx}">✕</button>
      </div>
      ${seqPos.length > 0 ? `<span class="pool-seq-indicator">${seqPos.join(' ')}</span>` : ''}
      <div class="pool-frames">
        <div class="pool-frame">
          <img class="pool-thumb" src="${firstSrc}" alt="First frame" loading="lazy" data-which="first" draggable="false"
               onerror="this.classList.add('broken'); this.alt='no frame';">
          ${showLabels ? '<span class="pool-frame-label">FIRST</span>' : ''}
        </div>
        <div class="pool-frame">
          <img class="pool-thumb" src="${lastSrc}" alt="Last frame" loading="lazy" data-which="last" draggable="false"
               onerror="this.classList.add('broken'); this.alt='no frame';">
          ${showLabels ? '<span class="pool-frame-label">LAST</span>' : ''}
        </div>
      </div>
      ${hasOverlay ? `
      <div class="pool-overlay${!loadingMeta && !metaHtml.trim() ? ' empty' : ''}">
        <div class="pool-overlay-text" id="poolMeta-${idx}">
          ${metaHtml}
        </div>
      </div>` : `<div class="pool-overlay-text" id="poolMeta-${idx}" style="display:none"></div>`}
      <button class="pool-card-info-btn" type="button" title="Clip info" data-info-idx="${idx}">ⓘ</button>
    `;

    card.addEventListener('click', (e) => {
      if (e.target.closest('.pool-card-remove, .pool-send-wrap, .pool-card-info-btn')) return;
      selectPoolItem(item.path);
    });

    card.addEventListener('mouseenter', () => setPoolHover(item.path));
    card.addEventListener('mouseleave', (e) => {
      // Leaving for another card/token keeps hover via that element's enter
      const to = e.relatedTarget;
      if (to && (to.closest?.('.pool-card') || to.closest?.('.seq-token'))) return;
      clearPoolHover();
    });

    card.addEventListener('dragstart', (e) => {
      if (e.target.closest('.pool-send-wrap, .pool-card-remove')) {
        e.preventDefault();
        return;
      }
      e.dataTransfer.setData('application/x-pool-path', item.path);
      e.dataTransfer.setData('text/plain', item.path);
      e.dataTransfer.effectAllowed = 'copy';
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));

    card.querySelector('.pool-card-remove')?.addEventListener('click', (e) => {
      e.stopPropagation();
      removePoolItem(idx);
    });

    card.querySelector('.pool-card-info-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      showClipInfoOverlay(item);
    });

    // Send-to dropdown
    const sendWrap = card.querySelector('.pool-send-wrap');
    const sendBtn = card.querySelector('.pool-send-btn');
    const sendMenu = card.querySelector('.pool-send-menu');
    sendBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const wasOpen = sendMenu && !sendMenu.hidden;
      // Close every other open menu / drop stacking boost
      document.querySelectorAll('.pool-card.menu-open').forEach(c => {
        if (c !== card) {
          c.classList.remove('menu-open');
          const m = c.querySelector('.pool-send-menu');
          if (m) m.hidden = true;
        }
      });
      if (!sendMenu) return;
      if (wasOpen) {
        sendMenu.hidden = true;
        card.classList.remove('menu-open');
      } else {
        sendMenu.hidden = false;
        card.classList.add('menu-open'); // lifts whole card above siblings
      }
    });
    sendMenu?.querySelectorAll('.pool-send-item').forEach(opt => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const target = opt.dataset.send;
        if (sendMenu) sendMenu.hidden = true;
        card.classList.remove('menu-open');
        sendPoolPathTo(item.path, target);
      });
    });
    // Don't start card drag from the send control
    sendWrap?.addEventListener('mousedown', (e) => e.stopPropagation());
    sendWrap?.addEventListener('pointerdown', (e) => e.stopPropagation());

    // Double-click adds to sequence
    card.addEventListener('dblclick', (e) => {
      if (e.target.closest('.pool-card-remove, .pool-send-wrap')) return;
      addPathToSequence(item.path);
    });

    // Right-click context menu (Quick Transmute + send targets)
    card.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.pool-card-remove')) return;
      e.preventDefault();
      e.stopPropagation();
      selectPoolItem(item.path);
      showPoolContextMenu(e.clientX, e.clientY, item.path);
    });

    grid.appendChild(card);

    if (!meta && !item.metaError) {
      loadPoolItemMeta(item, idx);
    }
  });
}

// ── Frame match (pHash next-clip finder) ──────────────────────────────────

async function runPoolMatch() {
  const path = state.pool.selectedPath || state.pool.focusPath;
  if (!path) {
    alert('Select a clip first (click a tile).');
    return;
  }
  // Persist pool first so server candidate list is current
  await savePoolStateNow();

  const maxDist = state.pool.matchMaxDistance ?? 10;
  const mode = state.pool.matchMode || 'next';
  const btn = document.getElementById('btnFindNext');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Matching…';
  }
  state.pool.matchLoading = true;
  elements.statusDot.className = 'status-dot loading';
  elements.statusText.textContent = 'Matching frames…';
  logConsole(`[MATCH]: ${mode} for ${basename(path)} (max distance ${maxDist})`);

  try {
    const url = `/api/pool/match?path=${encodeURIComponent(path)}&mode=${encodeURIComponent(mode)}&max_distance=${maxDist}&limit=40`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    state.pool.matchResults = data;
    renderMatchResults(data);
    if (data.ok) {
      logConsole(`[MATCH]: ${data.match_count} hit(s) of ${data.candidates_scanned} scanned`);
      elements.statusDot.className = 'status-dot';
      elements.statusText.textContent = `${data.match_count} matches`;
    } else {
      logConsole(`[MATCH]: ${data.error || 'failed'}`, 'error');
      elements.statusDot.className = 'status-dot error';
      elements.statusText.textContent = 'Match failed';
    }
  } catch (err) {
    logConsole(`[MATCH ERROR]: ${err.message}`, 'error');
    elements.statusDot.className = 'status-dot error';
    elements.statusText.textContent = 'Match failed';
    alert(`Match failed: ${err.message}`);
  } finally {
    state.pool.matchLoading = false;
    if (btn) {
      btn.disabled = !(state.pool.selectedPath || state.pool.focusPath);
      btn.textContent = 'Find matches';
    }
  }
}

function renderMatchResults(data) {
  const box = document.getElementById('poolMatchResults');
  if (!box) return;

  const badge = document.getElementById('matchCountBadge');
  const L = ensurePoolLayout();

  if (!data) {
    box.hidden = true;
    box.innerHTML = '';
    if (badge) badge.textContent = '';
    return;
  }

  box.hidden = false;
  // Uncollapse matches so results are visible
  if (L.collapsed.matches) {
    L.collapsed.matches = false;
    applyPoolLayout();
  }

  if (!data.ok) {
    box.innerHTML = `<div class="pool-match-empty">${escapeHtml(data.error || 'Match failed')}</div>`;
    if (badge) badge.textContent = 'err';
    return;
  }

  const matches = data.matches || [];
  if (badge) badge.textContent = String(matches.length);

  if (matches.length === 0) {
    box.innerHTML = `
      <div class="pool-match-empty">
        No matches within distance ≤ ${data.max_distance}.
        Try raising the slider or import more clips.
      </div>`;
    return;
  }

  // Auto-give matches a bit more room when we have hits (once)
  if (matches.length >= 3 && L.matchHeight < 200) {
    L.matchHeight = 220;
    L.composeHeight = Math.max(L.composeHeight, 320);
    applyPoolLayout();
  }

  const qPath = data.query?.path || '';
  const header = `<div class="pool-match-summary">${matches.length} match${matches.length === 1 ? '' : 'es'} · mode ${escapeHtml(data.mode)} · ≤${data.max_distance}</div>`;

  const rows = matches.map((m, i) => {
    // Query frame vs match frame thumbs
    const qWhich = m.query_frame || 'last';
    const mWhich = m.match_frame || 'first';
    const qSrc = data.query?.hash
      ? `/api/thumbnail?hash=${encodeURIComponent(data.query.hash)}&which=${qWhich}`
      : `/api/thumbnail?path=${encodeURIComponent(qPath)}&which=${qWhich}`;
    const mSrc = m.hash
      ? `/api/thumbnail?hash=${encodeURIComponent(m.hash)}&which=${mWhich}`
      : `/api/thumbnail?path=${encodeURIComponent(m.path)}&which=${mWhich}`;

    return `
      <article class="pool-match-row" data-path="${escapeHtml(m.path)}" data-idx="${i}">
        <div class="pool-match-pair">
          <div class="pool-match-thumb">
            <img src="${qSrc}" alt="query" loading="lazy" draggable="false">
            <span>${qWhich}</span>
          </div>
          <div class="pool-match-arrow">→</div>
          <div class="pool-match-thumb">
            <img src="${mSrc}" alt="match" loading="lazy" draggable="false">
            <span>${mWhich}</span>
          </div>
        </div>
        <div class="pool-match-meta">
          <div class="pool-match-name" title="${escapeHtml(m.path)}">${escapeHtml(m.name)}</div>
          <div class="pool-match-stats">
            <span class="tier tier-${escapeHtml(m.tier)}">${escapeHtml(m.tier)}</span>
            <span>d=${m.distance}</span>
            <span>${m.similarity}%</span>
            <span>${escapeHtml(m.direction)}</span>
          </div>
          <div class="pool-match-actions">
            <button type="button" class="btn pool-match-act" data-act="select">Select</button>
            <button type="button" class="btn pool-match-act" data-act="seq">+ Seq</button>
            <button type="button" class="btn pool-match-act" data-act="preview">Play</button>
          </div>
        </div>
      </article>
    `;
  }).join('');

  box.innerHTML = header + `<div class="pool-match-list">${rows}</div>`;

  box.querySelectorAll('.pool-match-row').forEach(row => {
    const path = row.dataset.path;
    row.querySelectorAll('[data-act]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const act = btn.dataset.act;
        if (act === 'select') {
          // Ensure in pool (should be)
          if (!findPoolItem(path)) addPathsToPool([path]);
          selectPoolItem(path);
          setPoolFocus(path);
        } else if (act === 'seq') {
          if (!findPoolItem(path)) addPathsToPool([path]);
          addPathToSequence(path);
        } else if (act === 'preview') {
          showPreview(path);
          setPoolFocus(path);
        }
      });
    });
    row.addEventListener('click', () => {
      setPoolFocus(path);
      showPreview(path);
    });
  });
}

// ── Tile zoom + info menu ─────────────────────────────────────────────────

function setPoolZoom(px) {
  const clamped = Math.max(POOL_ZOOM.min, Math.min(POOL_ZOOM.max, Math.round(px)));
  state.pool.tileZoom = clamped;
  applyPoolZoom();
  scheduleSavePoolState();
}

function applyPoolZoom() {
  const grid = document.getElementById('poolGrid');
  if (!grid) return;
  const z = state.pool.tileZoom || POOL_ZOOM.reset;
  grid.style.setProperty('--pool-tile-min', `${z}px`);
  grid.dataset.zoom = String(z);
  // Mark reset button
  document.querySelectorAll('.pool-zoom-btn').forEach(btn => btn.classList.remove('active'));
  if (z === POOL_ZOOM.reset) {
    document.getElementById('btnZoomReset')?.classList.add('active');
  } else if (z <= POOL_ZOOM.min) {
    document.getElementById('btnZoomMin')?.classList.add('active');
  } else if (z >= POOL_ZOOM.max) {
    document.getElementById('btnZoomMax')?.classList.add('active');
  }
}

function setupTileInfoMenu() {
  const btn = document.getElementById('btnTileInfoMenu');
  const menu = document.getElementById('tileInfoMenu');
  const checks = document.getElementById('tileInfoChecks');
  if (!btn || !menu || !checks) return;

  ensureTileInfo();
  checks.innerHTML = TILE_INFO_FIELDS.map(f => `
    <label class="pool-info-check">
      <input type="checkbox" data-tile-info="${f.key}" ${state.pool.tileInfo[f.key] ? 'checked' : ''}>
      <span>${escapeHtml(f.label)}</span>
    </label>
  `).join('');

  const closeMenu = () => {
    menu.hidden = true;
    state.pool.tileInfoMenuOpen = false;
  };
  const openMenu = () => {
    menu.hidden = false;
    state.pool.tileInfoMenuOpen = true;
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.hidden) openMenu();
    else closeMenu();
  });

  checks.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      const key = cb.dataset.tileInfo;
      state.pool.tileInfo[key] = cb.checked;
      refreshPoolTileOverlays();
      scheduleSavePoolState();
    });
  });

  document.getElementById('btnTileInfoAll')?.addEventListener('click', (e) => {
    e.stopPropagation();
    TILE_INFO_FIELDS.forEach(f => { state.pool.tileInfo[f.key] = true; });
    checks.querySelectorAll('input').forEach(cb => { cb.checked = true; });
    refreshPoolTileOverlays();
    scheduleSavePoolState();
  });
  document.getElementById('btnTileInfoNone')?.addEventListener('click', (e) => {
    e.stopPropagation();
    TILE_INFO_FIELDS.forEach(f => { state.pool.tileInfo[f.key] = false; });
    checks.querySelectorAll('input').forEach(cb => { cb.checked = false; });
    refreshPoolTileOverlays();
    scheduleSavePoolState();
  });

  // Close on outside click (once per form render — use capture on document)
  const onDoc = (e) => {
    if (!menu.hidden && !menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
      closeMenu();
    }
  };
  // Remove previous listener if re-rendered
  if (window._poolInfoMenuDocHandler) {
    document.removeEventListener('click', window._poolInfoMenuDocHandler);
  }
  window._poolInfoMenuDocHandler = onDoc;
  document.addEventListener('click', onDoc);

  menu.addEventListener('click', (e) => e.stopPropagation());
}

function refreshPoolTileOverlays() {
  // Rebuild overlays + frame labels without full grid re-fetch
  const info = ensureTileInfo();
  state.pool.items.forEach((item, idx) => {
    const card = Array.from(document.querySelectorAll('.pool-card')).find(c => c.dataset.path === item.path);
    if (!card) return;

    // Frame labels
    card.querySelectorAll('.pool-frame').forEach((frameEl, fi) => {
      let label = frameEl.querySelector('.pool-frame-label');
      if (info.frame_labels) {
        if (!label) {
          label = document.createElement('span');
          label.className = 'pool-frame-label';
          label.textContent = fi === 0 ? 'FIRST' : 'LAST';
          frameEl.appendChild(label);
        }
      } else if (label) {
        label.remove();
      }
    });

    const metaHtml = item.meta || item.metaError
      ? buildPoolMetaHtml(item)
      : (item.metaError ? buildPoolMetaHtml(item) : null);

    let overlay = card.querySelector('.pool-overlay');
    let metaEl = document.getElementById(`poolMeta-${idx}`);

    if (!item.meta && !item.metaError) {
      // still loading — leave probing text
      return;
    }

    if (!metaHtml || !metaHtml.trim()) {
      if (overlay) overlay.remove();
      // keep hidden anchor for future updates
      if (!metaEl) {
        metaEl = document.createElement('div');
        metaEl.id = `poolMeta-${idx}`;
        metaEl.style.display = 'none';
        card.appendChild(metaEl);
      } else {
        metaEl.style.display = 'none';
        metaEl.innerHTML = '';
      }
      return;
    }

    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'pool-overlay';
      overlay.innerHTML = `<div class="pool-overlay-text" id="poolMeta-${idx}"></div>`;
      card.appendChild(overlay);
      metaEl = overlay.querySelector('.pool-overlay-text');
    }
    if (metaEl) {
      metaEl.style.display = '';
      metaEl.innerHTML = metaHtml;
    }
  });
}


// Close any open Send-to menus on outside click
document.addEventListener('click', (e) => {
  if (e.target.closest('.pool-send-wrap')) return;
  document.querySelectorAll('.pool-send-menu:not([hidden])').forEach(m => { m.hidden = true; });
  document.querySelectorAll('.pool-card.menu-open').forEach(c => c.classList.remove('menu-open'));
  if (!e.target.closest('.pool-ctx-menu')) hidePoolContextMenu();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hidePoolContextMenu();
});

// ── Pool right-click context menu ─────────────────────────────────────────

function hidePoolContextMenu() {
  const m = document.getElementById('poolCtxMenu');
  if (m) m.remove();
}

function showPoolContextMenu(x, y, path) {
  hidePoolContextMenu();
  const menu = document.createElement('div');
  menu.id = 'poolCtxMenu';
  menu.className = 'pool-ctx-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = `
    <button type="button" class="pool-ctx-item pool-ctx-quick" data-act="quick">${escapeHtml(quickTransmuteLabel())}</button>
    <div class="pool-ctx-sep"></div>
    <button type="button" class="pool-ctx-item" data-act="sequence">Add to sequence</button>
    <button type="button" class="pool-ctx-item" data-act="preview">Preview</button>
    <button type="button" class="pool-ctx-item" data-act="mosh">Send → Datamosh</button>
    <button type="button" class="pool-ctx-item" data-act="deepdream">Send → DeepDream</button>
    <button type="button" class="pool-ctx-item" data-act="transmute">Send → Transmute</button>
    <button type="button" class="pool-ctx-item" data-act="multi">Send → Multi</button>
    <button type="button" class="pool-ctx-item" data-act="advanced">Send → Raw CLI</button>
    <div class="pool-ctx-sep"></div>
    <button type="button" class="pool-ctx-item" data-act="save_first_png">Save first frame PNG…</button>
    <button type="button" class="pool-ctx-item" data-act="save_last_png">Save last frame PNG…</button>
    <div class="pool-ctx-sep"></div>
    <button type="button" class="pool-ctx-item pool-ctx-muted" data-act="quick_setup">Configure Quick Transmute…</button>
  `;
  document.body.appendChild(menu);

  // Position, clamp to viewport
  const pad = 6;
  const rect = menu.getBoundingClientRect();
  let left = x;
  let top = y;
  if (left + rect.width > window.innerWidth - pad) left = window.innerWidth - rect.width - pad;
  if (top + rect.height > window.innerHeight - pad) top = window.innerHeight - rect.height - pad;
  if (left < pad) left = pad;
  if (top < pad) top = pad;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  menu.querySelectorAll('.pool-ctx-item').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const act = btn.dataset.act;
      hidePoolContextMenu();
      if (act === 'quick_setup') {
        switchTab('quick');
        return;
      }
      sendPoolPathTo(path, act);
    });
  });
}

// File Browser Logic
// mode: 'file' | 'files' | 'file_save' | 'dir'
// filter: 'video' | 'image' | 'project' | 'all' (passed to /api/picker)
window.openFileBrowser = async function(targetInputId, selectDirOnly = false, mode = 'file', filter = null) {
  let pickerMode = 'file';
  if (selectDirOnly) pickerMode = 'dir';
  else if (mode === 'file_save') pickerMode = 'save';
  else if (mode === 'dir') pickerMode = 'dir';
  else if (mode === 'files') pickerMode = 'files';

  // Infer filter from target when not specified
  let fileFilter = filter;
  if (!fileFilter) {
    if (targetInputId === 'hijackImagePath') fileFilter = 'image';
    else if (mode === 'file_save' || pickerMode === 'save') fileFilter = 'video';
    else if (pickerMode === 'dir') fileFilter = 'all';
    else fileFilter = 'video';
  }
  
  let startPath = '';
  if (targetInputId !== 'addMultiClip') {
    const currentVal = document.getElementById(targetInputId)?.value;
    if (currentVal && currentVal.startsWith('/')) {
      startPath = currentVal.substring(0, currentVal.lastIndexOf('/'));
    }
  }

  elements.statusDot.className = 'status-dot loading';
  elements.statusText.textContent = 'Waiting for file picker...';
  
  try {
    const url = `/api/picker?mode=${pickerMode}`
      + `&start_path=${encodeURIComponent(startPath)}`
      + `&filter=${encodeURIComponent(fileFilter)}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(await response.text());
    
    const data = await response.json();
    if (pickerMode === 'files' && data.paths && data.paths.length) {
      const input = document.getElementById(targetInputId);
      if (input) {
        input.value = data.paths.join('\n');
        input.dispatchEvent(new Event('input'));
      }
      logConsole('[PICKED]: ' + data.paths.length + ' file(s)');
    } else if (data.path) {
      if (targetInputId === 'addMultiClip') {
        addMultiClipPath(data.path);
      } else {
        const input = document.getElementById(targetInputId);
        if (input) {
          input.value = data.path;
          input.dispatchEvent(new Event('input'));
        }
      }
      logConsole(`[PICKED]: ${data.path}`);
    } else {
      logConsole(`[PICKER]: Cancelled by user`);
    }
  } catch (err) {
    logConsole(`[PICKER ERROR]: ${err.message}`);
    alert(`Could not open system file picker. Make sure kdialog is running or enter path manually.`);
  } finally {
    await checkHealth();
  }
};

function closeFbModal() {
  elements.fbModal.classList.remove('active');
}

async function browsePath(path = '') {
  try {
    const response = await fetch(`/api/browse?path=${encodeURIComponent(path)}`);
    if (!response.ok) throw new Error(await response.text());
    
    const data = await response.json();
    state.fb.currentPath = data.current_path;
    elements.fbPathInput.value = data.current_path;
    
    // Render Shortcuts
    elements.fbShortcuts.innerHTML = '';
    data.shortcuts.forEach(shortcut => {
      const btn = document.createElement('button');
      btn.className = 'fb-shortcut-btn';
      btn.textContent = shortcut.name;
      btn.addEventListener('click', () => browsePath(shortcut.path));
      elements.fbShortcuts.appendChild(btn);
    });

    // Render List
    elements.fbList.innerHTML = '';
    
    // Parent Directory ".."
    if (data.parent_path) {
      const parentItem = document.createElement('li');
      parentItem.className = 'fb-item fb-up-btn';
      parentItem.innerHTML = `
        <span class="fb-item-icon">📁</span>
        <span class="fb-item-name">.. (Go Up)</span>
      `;
      parentItem.addEventListener('click', () => browsePath(data.parent_path));
      elements.fbList.appendChild(parentItem);
    }

    if (data.entries.length === 0) {
      elements.fbList.innerHTML += `<li class="fb-empty">Folder is empty</li>`;
      return;
    }

    data.entries.forEach(entry => {
      // If selectDirOnly is true, we still list files but make them unselectable
      const isDir = entry.is_dir;
      const isSelected = state.fb.selectedPath === entry.path;
      
      const li = document.createElement('li');
      li.className = `fb-item ${isSelected ? 'selected' : ''}`;
      
      let icon = isDir ? '📁' : '📄';
      if (!isDir) {
        const ext = entry.name.substring(entry.name.lastIndexOf('.')).toLowerCase();
        if (['.mp4', '.m4v', '.mov', '.avi', '.mkv'].includes(ext)) icon = '🎬';
        else if (['.png', '.jpg', '.jpeg', '.gif'].includes(ext)) icon = '🖼️';
        else if (['.m4a', '.mp3', '.wav'].includes(ext)) icon = '🎵';
      }

      const sizeText = entry.size !== null ? formatBytes(entry.size) : '';

      li.innerHTML = `
        <span class="fb-item-icon ${isDir ? 'dir' : 'file'}">${icon}</span>
        <span class="fb-item-name">${entry.name}</span>
        <span class="fb-item-size">${sizeText}</span>
      `;
      
      // Double click navigates into directory
      li.addEventListener('dblclick', () => {
        if (isDir) {
          browsePath(entry.path);
        }
      });
      
      // Single click selects
      li.addEventListener('click', () => {
        // Toggle selected state
        document.querySelectorAll('.fb-item').forEach(el => el.classList.remove('selected'));
        
        if (state.fb.selectDirOnly && !isDir) {
          // Can't select file in directory-only mode
          state.fb.selectedPath = '';
          state.fb.selectedName = '';
          state.fb.selectedIsDir = false;
          return;
        }

        li.classList.add('selected');
        state.fb.selectedPath = entry.path;
        state.fb.selectedName = entry.name;
        state.fb.selectedIsDir = isDir;
      });

      elements.fbList.appendChild(li);
    });

  } catch (err) {
    logConsole(`[BROWSE ERROR]: ${err.message}`);
  }
}

function navigateUpFb() {
  // Simple extraction of parent path
  const current = state.fb.currentPath;
  if (!current) return;
  const lastIndex = current.lastIndexOf('/');
  if (lastIndex > 0) {
    const parent = current.substring(0, lastIndex);
    browsePath(parent);
  } else if (lastIndex === 0) {
    browsePath('/');
  }
}

function confirmFbSelection() {
  let finalPath = '';
  
  if (state.fb.resolveMode === 'file_save') {
    // If it's a save file dialog and nothing is clicked, we check the path input box or select current path
    // But let's assume they want the currentPath plus the filename if they typed one.
    // For simplicity: if they select a file, use it. If they select a folder, ask for a filename or use folder path.
    // Better QOL: prompt for a name if they select a directory
    if (state.fb.selectedPath && !state.fb.selectedIsDir) {
      finalPath = state.fb.selectedPath;
    } else {
      const filename = prompt("Enter output filename (e.g. output.mp4):", "output.mp4");
      if (!filename) return; // cancel
      finalPath = state.fb.currentPath + '/' + filename;
    }
  } else {
    // Standard pick
    if (!state.fb.selectedPath) {
      // Fallback: choose current directory if they wanted a dir, or error
      if (state.fb.selectDirOnly) {
        finalPath = state.fb.currentPath;
      } else {
        alert("Please select a file.");
        return;
      }
    } else {
      finalPath = state.fb.selectedPath;
    }
  }
  
  // Populate the target input
  if (state.fb.targetInputId === 'addMultiClip') {
    addMultiClipPath(finalPath);
  } else {
    const input = document.getElementById(state.fb.targetInputId);
    if (input) {
      input.value = finalPath;
      // Trigger change event if needed
      input.dispatchEvent(new Event('input'));
    }
  }
  
  closeFbModal();
}

// Format utils
function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// ── Preview AR + console split ────────────────────────────────────────────

function gcdInt(a, b) {
  a = Math.abs(Math.round(a));
  b = Math.abs(Math.round(b));
  while (b) { const t = b; b = a % b; a = t; }
  return a || 1;
}

/** Set preview box to source aspect ratio; never crops (object-fit: contain). */
function setPreviewAspect(w, h) {
  const viewer = elements.mediaViewer;
  if (!viewer || !w || !h || w <= 0 || h <= 0) return;
  viewer.dataset.arW = String(w);
  viewer.dataset.arH = String(h);
  viewer.classList.add('has-media');
  const badge = document.getElementById('mediaArBadge');
  if (badge) {
    const g = gcdInt(w, h);
    badge.textContent = `${w}×${h} · ${Math.round(w / g)}:${Math.round(h / g)}`;
  }
  fitPreviewViewer();
}

function clearPreviewAspect() {
  const viewer = elements.mediaViewer;
  if (!viewer) return;
  viewer.classList.remove('has-media');
  delete viewer.dataset.arW;
  delete viewer.dataset.arH;
  viewer.style.width = '';
  viewer.style.height = '';
  const badge = document.getElementById('mediaArBadge');
  if (badge) badge.textContent = '';
}

/** Fit viewer inside stage using source AR — letterbox only if stage differs. */
function fitPreviewViewer() {
  const stage = document.getElementById('mediaViewerStage');
  const viewer = elements.mediaViewer;
  if (!stage || !viewer) return;

  const sw = stage.clientWidth;
  const sh = stage.clientHeight;
  if (sw < 8 || sh < 8) return;

  let arW = parseFloat(viewer.dataset.arW);
  let arH = parseFloat(viewer.dataset.arH);
  if (!arW || !arH) {
    // Empty / unknown: soft square placeholder up to stage
    const side = Math.min(sw, sh);
    viewer.style.width = `${side}px`;
    viewer.style.height = `${side}px`;
    return;
  }

  // Largest rect of aspect arW:arH that fits in stage
  let vw = sw;
  let vh = sw * (arH / arW);
  if (vh > sh) {
    vh = sh;
    vw = sh * (arW / arH);
  }
  viewer.style.width = `${Math.max(1, Math.floor(vw))}px`;
  viewer.style.height = `${Math.max(1, Math.floor(vh))}px`;
}

function setupPreviewConsoleResize() {
  const handle = document.getElementById('previewConsoleResize');
  const panel = document.getElementById('previewPanel');
  const consoleBox = document.getElementById('consoleBox');
  if (!handle || !panel || !consoleBox) return;

  // Restore saved console height
  try {
    const saved = parseInt(localStorage.getItem('mtapi_console_h') || '', 10);
    if (saved >= 72 && saved <= 800) {
      panel.style.setProperty('--console-h', `${saved}px`);
    }
  } catch (_) { /* ignore */ }

  bindPoolDragResize(handle, {
    axis: 'y',
    onMove: (dy, start) => {
      // stage | handle | console at bottom — drag handle UP (dy<0) grows terminal
      const height = Math.max(72, Math.min(panel.clientHeight * 0.72, start.consoleH - dy));
      panel.style.setProperty('--console-h', `${Math.round(height)}px`);
      fitPreviewViewer();
    },
    startVals: () => {
      const cs = getComputedStyle(panel).getPropertyValue('--console-h').trim();
      const px = parseInt(cs, 10);
      return { consoleH: Number.isFinite(px) ? px : consoleBox.offsetHeight || 180 };
    },
  });

  // After resize ends, persist — bindPoolDragResize already calls scheduleSavePoolState which is pool-only.
  // Hook pointerup on handle for localStorage
  handle.addEventListener('pointerup', () => {
    try {
      const cs = getComputedStyle(panel).getPropertyValue('--console-h').trim();
      const px = parseInt(cs, 10);
      if (px >= 72) localStorage.setItem('mtapi_console_h', String(px));
    } catch (_) { /* ignore */ }
    fitPreviewViewer();
  });

  // Refit on window resize
  window.addEventListener('resize', () => fitPreviewViewer());
  // Observe stage size changes
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => fitPreviewViewer());
    const stage = document.getElementById('mediaViewerStage');
    if (stage) ro.observe(stage);
  }
}

// Preview media file
function showPreview(filePath) {
  const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
  const filename = filePath.substring(filePath.lastIndexOf('/') + 1);
  
  elements.mediaName.textContent = filename;
  elements.mediaPath.textContent = filePath;
  elements.mediaInfo.style.display = 'flex';
  
  elements.mediaViewer.innerHTML = '';
  clearPreviewAspect();
  
  if (['.mp4', '.m4v', '.mov', '.avi', '.mkv', '.webm'].includes(ext)) {
    const video = document.createElement('video');
    video.src = `/api/video?path=${encodeURIComponent(filePath)}&t=${Date.now()}`;
    video.controls = true;
    video.autoplay = true;
    video.loop = true;
    video.muted = true;
    video.addEventListener('loadedmetadata', () => {
      if (video.videoWidth && video.videoHeight) {
        setPreviewAspect(video.videoWidth, video.videoHeight);
      }
    });
    elements.mediaViewer.appendChild(video);
    // Also try probe meta if already in pool (instant AR before metadata)
    const item = findPoolItem(filePath);
    if (item?.meta?.width && item?.meta?.height) {
      setPreviewAspect(item.meta.width, item.meta.height);
    }
  } else if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) {
    const img = document.createElement('img');
    img.src = `/api/image?path=${encodeURIComponent(filePath)}&t=${Date.now()}`;
    img.onload = () => {
      if (img.naturalWidth && img.naturalHeight) {
        setPreviewAspect(img.naturalWidth, img.naturalHeight);
      }
    };
    elements.mediaViewer.appendChild(img);
  } else if (['.m4a', '.mp3', '.wav'].includes(ext)) {
    elements.mediaViewer.innerHTML = `
      <div class="media-placeholder">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 18V5l12-2v13"/>
          <circle cx="6" cy="18" r="3"/>
          <circle cx="18" cy="16" r="3"/>
        </svg>
        <p>Audio Extracted successfully!</p>
        <audio controls src="/api/video?path=${encodeURIComponent(filePath)}" style="margin-top: 12px; width: 80%;"></audio>
      </div>
    `;
    setPreviewAspect(16, 9);
  } else {
    elements.mediaViewer.innerHTML = `
      <div class="media-placeholder">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
        </svg>
        <p>File generated: <strong>${filename}</strong></p>
        <p style="font-size: 0.75rem;">Path: ${filePath}</p>
      </div>
    `;
    setPreviewAspect(16, 9);
  }
}

// Console logger
function logConsole(text, type = 'normal') {
  const line = document.createElement('div');
  
  if (type === 'command') {
    line.className = 'console-cmd';
    line.textContent = `$ ${text}`;
  } else if (type === 'stdout') {
    line.className = 'console-stdout';
    line.textContent = text;
  } else if (type === 'stderr') {
    line.className = 'console-stderr';
    line.textContent = text;
  } else if (type === 'error') {
    line.className = 'console-error';
    line.textContent = text;
  } else {
    line.textContent = text;
  }
  
  elements.consoleBody.appendChild(line);
  elements.consoleBody.scrollTop = elements.consoleBody.scrollHeight;
}

// Flush pool state before leaving
window.addEventListener('beforeunload', () => {
  if (!_poolPersistReady) return;
  // best-effort sync beacon
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
  ensureTileInfo,
};
