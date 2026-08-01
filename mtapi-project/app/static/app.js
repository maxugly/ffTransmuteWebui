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
import { renderSpeedChangeForm, collectSpeedChangeBody } from '/js/tabs/speedchange.js';
import { loadQuickSettings, renderQuickTransmuteForm, runQuickTransmute, quickTransmuteLabel } from '/js/tabs/quick.js';
import { renderWatcherForm } from '/js/tabs/watcher.js';
import { renderConvertForm, collectConvertBody } from '/js/tabs/convert.js';
import { renderImagePoolForm } from '/js/pool/image-pool.js';
import { renderCutForm } from '/js/tabs/cut.js';
import { renderZoompanForm, collectZoompanBody } from '/js/tabs/zoompan.js';
import { renderImageSortForm, collectImageSortBody } from '/js/tabs/imagesort.js';
import { renderNotesForm } from '/js/tabs/notes.js';
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
    selected: 0, // keyboard / click selection
  },
  // withoutBG batch
  withoutbg: {
    images: [], // {path, name}[]
    folder: null,
    selected: 0,
  },
  // Neural style transfer (content list + one style image)
  styleTransfer: {
    contents: [], // {path, name}[]
    stylePath: null,
    selected: 0,
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
    items: [], // { path, name, size?, meta?, hash? }  — Video Pool
    selectedPath: null, // sticky selection (click) — syncs library ↔ sequence
    selectedSeqId: null, // precise sequence entry id when a token is selected
    filterQuery: '', // live fuzzy filter for pool grid (pool + sequence tabs)
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
  },
  // Image Pool — stills only (separate from Video Pool)
  imagePool: {
    items: [], // { path, name, size?, meta?, hash? }
    selectedPath: null,
    filterQuery: '',
    loading: false,
  },
  // Image Sort → Video (single ordered list; index 0 = base)
  imageSort: {
    images: [], // {path, name, score?}[] — slot [0] is always base
    folder: null,
    selected: 0, // index of selected row for shared reorder buttons
  },
  // Cut workspace: clip endpoints + two reference stills + shared image-compare state
  // Compare fields: mode / overlayOpacity / abPosition — see js/ui/image-compare.js
  cut: {
    refA: null,              // absolute image path (pairs with In)
    refB: null,              // absolute image path (pairs with Out)
    mode: 'separate',        // separate | overlay | ab (shared image-compare)
    compareMode: 'separate', // legacy alias kept in sync with mode
    overlayOpacity: 50,      // 0–100 ref opacity in overlay mode
    abPosition: 50,          // 0–100 wipe handle (left=base, right=ref)
  },
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
  styletransfer:'any',
  rife:        'video',
  speedchange: 'video',
  advanced:    'video',
  quick:       'video',
  convert:     'any',
  cut:         'video',
  imagesort:   'image',
  zoompan:     'image',
  notes:       'none',
};

/** Tabs that show the global frame-range row (video pipeline / mosh / convert). */
const FRAME_RANGE_TABS = new Set([
  'mosh', 'deepdream', 'rife', 'speedchange', 'convert', 'transmute',
  'styletransfer', 'withoutbg', 'facemorph', 'multi', 'advanced',
  'cut', // cut workspace shows global range next to first/last
  'imagesort',
]);

function tabUsesFrameRange(tab) {
  return FRAME_RANGE_TABS.has(tab);
}

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
  const prevVideo = window.globalInputs.video;
  window.globalInputs.video   = document.getElementById('giVideo')?.value || '';
  window.globalInputs.image   = document.getElementById('giImage')?.value || '';
  window.globalInputs.pathIn  = document.getElementById('giPathIn')?.value || '';
  window.globalInputs.pathOut = document.getElementById('giPathOut')?.value || '';
  // New first-line video → invalidate probe cache so range re-probes
  const first = (window.globalInputs.video || '').split('\n').map(l => l.trim()).find(Boolean) || '';
  const prevFirst = (prevVideo || '').split('\n').map(l => l.trim()).find(Boolean) || '';
  if (first !== prevFirst) {
    window.globalInputs._lastProbedPath = null;
    window.globalInputs._probeOk = false;
  }
  updateStatusIndicators();
  // Sync per-tab local fields from global inputs + show/hide frame row
  _syncTabInputFromGlobal();
}

function _syncTabInputFromGlobal() {
  const tab = state.activeTab;
  const gi = window.globalInputs;

  // Show/hide global frame row on ops that can honor start_frame/end_frame
  var framesRow = document.getElementById('giFramesRow');
  if (framesRow) framesRow.style.display = tabUsesFrameRange(tab) ? '' : 'none';

  // Probe first video path so range max/total stay current
  if (tabUsesFrameRange(tab)) {
    var probePath = '';
    if (gi.video.trim()) {
      var lines = gi.video.split('\n').map(function(l) { return l.trim(); }).filter(Boolean);
      if (lines.length) probePath = lines[0];
    }
    if (!probePath && gi.image.trim() && detectFileType(gi.image.trim()) === 'video') {
      probePath = gi.image.trim();
    }
    if (probePath && probePath !== gi._lastProbedPath) {
      probeGlobalVideo(probePath);
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
    if (accepts === 'none') {
      el.textContent = '';
      el.title = '';
      return;
    }
    var val = (gi[r.key] || '').trim();
    if (!r.needs)      { el.textContent = '\u274C'; el.title = 'Not used by this tab'; }
    else if (val)      { el.textContent = '\u2705'; el.title = 'Active'; }
    else               { el.textContent = ''; el.title = ''; }
  });
}

/**
 * All non-empty paths from global video/image (multi-line) or a local field.
 * Prefer global video for video/any tabs, else global image, else local field
 * (also multi-line). Order preserved; de-dupe exact paths.
 */
function allInputPaths(fieldId) {
  const tab = state.activeTab;
  const accepts = TAB_ACCEPTS[tab] || 'any';
  const gi = window.globalInputs;
  function splitLines(s) {
    return String(s || '').split('\n').map(function(l) { return l.trim(); }).filter(Boolean);
  }
  let lines = [];
  if ((accepts === 'video' || accepts === 'any') && gi.video.trim()) {
    lines = splitLines(gi.video);
  }
  if (!lines.length && (accepts === 'image' || accepts === 'any') && gi.image.trim()) {
    lines = splitLines(gi.image);
  }
  if (!lines.length && fieldId) {
    const el = document.getElementById(fieldId);
    if (el) lines = splitLines(el.value);
  }
  // de-dupe preserve order
  const seen = new Set();
  const out = [];
  for (const p of lines) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/** First path only — single-clip convenience. Prefer allInputPaths for batch. */
function bestInput(fieldId) {
  const paths = allInputPaths(fieldId);
  return paths.length ? paths[0] : '';
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
  setupFrameScrubber();
  setupListKeys();
  setupEventListeners();
  setupPreviewConsoleResize();
  setupAllPanelResize();
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
  // Sidebar collapse
  const btnSidebar = document.getElementById('btnSidebarCollapse');
  if (btnSidebar) {
    btnSidebar.addEventListener('click', () => toggleSidebarCollapse());
  }
  // Preview collapse
  const btnPreview = document.getElementById('btnPreviewCollapse');
  if (btnPreview) {
    btnPreview.addEventListener('click', () => togglePreviewCollapse());
  }
  loadSavedCollapseState();
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
  if (tab === 'speedchange') title = 'Speed Change';
  if (tab === 'transmute') title = 'Single-Clip Transmutations';
  if (tab === 'multi') title = 'Layout Templates (Join / Grid)';
  if (tab === 'quick') title = 'Quick Transmute';
  if (tab === 'watcher') title = 'Folder Watcher';
  if (tab === 'advanced') title = 'Advanced (Raw CLI)';
  if (tab === 'convert') title = 'Convert / Export';
  if (tab === 'cut') title = 'Cut';
  if (tab === 'imagesort') title = 'Image Sort → Video';
  if (tab === 'zoompan') title = 'Pan & Zoom';
  if (tab === 'notes') title = 'Notes';
  // Library tabs: drop the big header title (sidebar already shows active item)
  if (tab === 'pool' || tab === 'sequence' || tab === 'images') title = '';
  elements.tabTitle.textContent = title;

  // Hide Run on library / settings-only tabs (Cut has no encode yet)
  if (elements.btnRun) {
    elements.btnRun.style.display = (
      tab === 'pool' || tab === 'sequence' || tab === 'images' || tab === 'cut'
      || tab === 'quick' || tab === 'watcher' || tab === 'notes'
    ) ? 'none' : '';
  }

  // Stop watcher status polling when leaving the tab
  if (tab !== 'watcher' && state.watcher.pollTimer) {
    clearInterval(state.watcher.pollTimer);
    state.watcher.pollTimer = null;
  }

  // Pool / Sequence / Image Pool take most of the workspace
  const appContent = document.querySelector('.app-content');
  if (appContent) {
    appContent.classList.toggle(
      'pool-workspace',
      tab === 'pool' || tab === 'sequence' || tab === 'images'
    );
  }

  // Notes: bare workspace (sidebar + two text boxes only)
  document.body.classList.toggle('notes-tab-active', tab === 'notes');

  // Render Form for the Tab
  renderTabForm(tab);
  updateStatusIndicators();
  // Show/hide global frame row per tab
  var framesRow = document.getElementById('giFramesRow');
  if (framesRow) framesRow.style.display = tabUsesFrameRange(tab) ? '' : 'none';
  // Re-sync probe when switching onto a range-aware tab
  _syncTabInputFromGlobal();
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
  } else if (tab === 'speedchange') {
    renderSpeedChangeForm();
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
  } else if (tab === 'convert') {
    renderConvertForm();
  } else if (tab === 'pool') {
    renderPoolForm();
  } else if (tab === 'sequence') {
    renderSequenceForm();
  } else if (tab === 'images') {
    renderImagePoolForm();
  } else if (tab === 'cut') {
    renderCutForm();
  } else if (tab === 'zoompan') {
    renderZoompanForm();
  } else if (tab === 'imagesort') {
    renderImageSortForm();
  } else if (tab === 'notes') {
    renderNotesForm();
  }
}
import { probeGlobalVideo, setupGlobalTimeline, setupTimelineSlider } from '/js/timeline.js';
import { setupFrameScrubber, resetFrameScrubber } from '/js/frame-scrubber.js';
import { setupListKeys } from '/js/ui/list-keys.js';
import {
  renderPoolForm, renderSequenceForm, renderPoolGrid, sequencePositions,
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

// ── Sidebar & preview collapse ────────────────────────────────────────────

function toggleSidebarCollapse() {
  const collapsed = document.body.classList.toggle('sidebar-collapsed');
  const btn = document.getElementById('btnSidebarCollapse');
  if (btn) {
    btn.textContent = collapsed ? '▶' : '◀';
    btn.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  }
  try { localStorage.setItem('mtapi_sidebar_collapsed', collapsed ? '1' : '0'); } catch (_) {}
  fitPreviewViewer();
}

function togglePreviewCollapse() {
  const collapsed = document.body.classList.toggle('preview-collapsed');
  const btn = document.getElementById('btnPreviewCollapse');
  if (btn) {
    btn.textContent = collapsed ? '◀' : '▶';
    btn.title = collapsed ? 'Expand preview' : 'Collapse preview';
  }
  try { localStorage.setItem('mtapi_preview_collapsed', collapsed ? '1' : '0'); } catch (_) {}
  setTimeout(() => fitPreviewViewer(), 100);
}

function loadSavedCollapseState() {
  try {
    if (localStorage.getItem('mtapi_sidebar_collapsed') === '1') {
      document.body.classList.add('sidebar-collapsed');
      const sb = document.getElementById('btnSidebarCollapse');
      if (sb) { sb.textContent = '▶'; sb.title = 'Expand sidebar'; }
    }
    if (localStorage.getItem('mtapi_preview_collapsed') === '1') {
      document.body.classList.add('preview-collapsed');
      const pb = document.getElementById('btnPreviewCollapse');
      if (pb) { pb.textContent = '◀'; pb.title = 'Expand preview'; }
    }
  } catch (_) {}
}

// ── Panel resize drag ─────────────────────────────────────────────────────

function _setupDragResize(el, { axis, onDrag, startVals, onEnd }) {
  if (!el) return;
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const startPtr = axis === 'x' ? e.clientX : e.clientY;
    const start = startVals ? startVals() : {};
    document.body.classList.add(axis === 'x' ? 'panel-resizing' : 'sidebar-resizing');

    const onMove = (ev) => {
      const cur = axis === 'x' ? ev.clientX : ev.clientY;
      onDrag(cur - startPtr, start);
    };
    const onUp = () => {
      el.releasePointerCapture(e.pointerId);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      document.body.classList.remove('panel-resizing', 'sidebar-resizing');
      if (onEnd) onEnd();
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  });
}

function setupSidebarResize() {
  const handle = document.getElementById('sidebarResize');
  const aside = document.querySelector('aside');
  if (!handle || !aside) return;

  // Restore saved width (apply as inline style so it beats collapsed CSS)
  try {
    const saved = parseInt(localStorage.getItem('mtapi_sidebar_w') || '', 10);
    if (saved >= 56 && saved <= 600) {
      aside.style.width = saved + 'px';
      document.documentElement.style.setProperty('--sidebar-w', saved + 'px');
    }
  } catch (_) {}

  _setupDragResize(handle, {
    axis: 'x',
    onDrag: (deltaX, start) => {
      const newW = Math.max(120, Math.min(600, start.startWidth + deltaX));
      aside.style.width = newW + 'px';
      document.documentElement.style.setProperty('--sidebar-w', newW + 'px');
    },
    startVals: () => {
      const w = aside.getBoundingClientRect().width;
      return { startWidth: w };
    },
    onEnd: () => {
      const w = aside.getBoundingClientRect().width;
      try { localStorage.setItem('mtapi_sidebar_w', String(Math.round(w))); } catch (_) {}
    },
  });
}

function setupPanelResize() {
  const content = document.querySelector('.app-content');
  if (!content) return;

  // Create divider dynamically so it doesn't interfere with grid
  const divider = document.createElement('div');
  divider.className = 'panel-divider';
  divider.id = 'panelDivider';
  divider.style.position = 'absolute';
  divider.style.top = '0';
  divider.style.bottom = '0';
  divider.style.width = '6px';
  divider.style.zIndex = '6';
  divider.style.cursor = 'col-resize';
  divider.style.borderLeft = '1px solid var(--panel-border)';
  content.style.position = 'relative';
  content.appendChild(divider);

  function updateDividerPos() {
    const leftPanel = content.children[0];
    if (!leftPanel || document.body.classList.contains('preview-collapsed')) {
      divider.style.display = 'none';
      return;
    }
    divider.style.display = '';
    const leftW = leftPanel.getBoundingClientRect().right - content.getBoundingClientRect().left;
    divider.style.left = (leftW - 3) + 'px';
  }
  updateDividerPos();

  // Restore saved split
  try {
    const saved = localStorage.getItem('mtapi_panel_split');
    if (saved) {
      content.style.gridTemplateColumns = saved;
      requestAnimationFrame(updateDividerPos);
    }
  } catch (_) {}

  _setupDragResize(divider, {
    axis: 'x',
    onDrag: (deltaX, start) => {
      const rect = content.getBoundingClientRect();
      if (rect.width <= 0 || document.body.classList.contains('preview-collapsed')) return;
      const newLeftW = Math.max(300, Math.min(rect.width - 200, start.startLeftW + deltaX - 3));
      const rightW = rect.width - newLeftW;
      content.style.gridTemplateColumns = `${newLeftW}px ${rightW}px`;
      divider.style.left = (newLeftW - 3) + 'px';
    },
    startVals: () => {
      const leftW = content.children[0]?.getBoundingClientRect().width || content.getBoundingClientRect().width * 0.5;
      return { startLeftW: leftW };
    },
    onEnd: () => {
      const cols = content.style.gridTemplateColumns;
      try { localStorage.setItem('mtapi_panel_split', cols); } catch (_) {}
    },
  });

  window.addEventListener('resize', updateDividerPos);
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(updateDividerPos);
    ro.observe(content);
  }
}

function setupAllPanelResize() {
  setupSidebarResize();
  setupPanelResize();
}

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
  bestInput, allInputPaths, bestOutput, resolveGlobalImage, resolveGlobalImages,
  TAB_ACCEPTS, detectFileType,
  logConsole, fitPreviewViewer,
  probeGlobalVideo, updateGlobalInputs, updateStatusIndicators,
  showPreview,
  selectPoolItem, removePoolItem, sequencePositions,
  loadPoolItemMeta, setPreviewAspect, clearPreviewAspect,
  collectFaceMorphBody,
  collectWithoutBgBody, collectStyleTransferBody, collectRifeBody,
  collectSpeedChangeBody,
  renderFaceMorphForm,
  renderWithoutBgForm, renderStyleTransferForm, renderRifeForm,
  renderSpeedChangeForm,
  renderImageSortForm,
  renderQuickTransmuteForm,
  renderWatcherForm, renderPoolForm, renderPoolGrid,
  checkHealth, addPathsToPool,
  sendPoolPathTo, applyPoolAsInput, formatBytes,
  ensureTileInfo, defaultTileInfo,
  setPoolZoom, applyPoolZoom, setupTileInfoMenu, showPoolContextMenu,
};
