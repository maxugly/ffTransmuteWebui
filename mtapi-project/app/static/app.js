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
  captureCurrentFormState, applySavedFormState,
  isApplyingFormState,
  _poolSeqId, _poolSaveTimer, _poolPersistReady,
} from '/js/pool/persistence.js';
import {
  runOpWithCancel, runActiveOperation, stopActiveOperation,
  displayOpResult, setRunUiBusy,
  formatJobLine, stopJobProgressPoll, startJobProgressPoll,
  newJobToken, enqueueActiveOperation,
} from '/js/job-control.js';
import { renderMoshForm, updateMoshParams } from '/js/tabs/datamosh.js';
import { renderDeepDreamForm, collectDeepDreamBody } from '/js/tabs/deepdream.js';
import { renderTransmuteForm, renderMultiForm, renderAdvancedForm, addMultiClipPath } from '/js/tabs/transmute.js';
import { renderFaceMorphForm, collectFaceMorphBody } from '/js/tabs/facemorph.js';
import { renderWithoutBgForm, collectWithoutBgBody } from '/js/tabs/withoutbg.js';
import { renderFastSAMForm, collectFastSAMBody } from '/js/tabs/fastsam.js';
import { renderStyleTransferForm, collectStyleTransferBody } from '/js/tabs/styletransfer.js';
import { renderRifeForm, collectRifeBody } from '/js/tabs/rife.js';
import { renderImg2ImgForm, collectImg2ImgBody } from '/js/tabs/img2img.js';
import { renderTxt2ImgForm, collectTxt2ImgBody } from '/js/tabs/txt2img.js';
import { renderQrArtForm, collectQrBody, showQrScannability } from '/js/tabs/qr.js';
import { renderAgentForm, applyPendingToImg2Img, applyPendingToTxt2Img } from '/js/tabs/agent.js';
import { renderUpscaleForm, collectUpscaleBody } from '/js/tabs/upscale.js';
import { renderRifeRecohereForm, collectRifeRecohereBody } from '/js/tabs/riferecohere.js';
import { renderSpeedChangeForm, collectSpeedChangeBody } from '/js/tabs/speedchange.js';
import { loadQuickSettings, renderQuickTransmuteForm, runQuickTransmute, quickTransmuteLabel } from '/js/tabs/quick.js';
import { renderWatcherForm } from '/js/tabs/watcher.js';
import { renderConvertForm, collectConvertBody } from '/js/tabs/convert.js';
import { renderImagePoolForm } from '/js/pool/image-pool.js';
import { renderCutForm, collectCutBody } from '/js/tabs/cut.js';
import { renderZoompanForm, collectZoompanBody } from '/js/tabs/zoompan.js';
import { renderImageSortForm, collectImageSortBody } from '/js/tabs/imagesort.js';
import { renderImgCompareForm } from '/js/tabs/imgcompare.js';
import { renderNotesForm } from '/js/tabs/notes.js';
import { renderSettingsForm, applyUiTweaks, readStoredScrollbarWidth } from '/js/tabs/settings.js';
import { renderJobsForm, stopJobsPoll } from '/js/tabs/jobs.js';
import { renderImageEditForm, collectImageEditBody } from '/js/tabs/imageedit.js';
import { refreshInputPreview, bindInputPreviewListeners } from '/js/ui/input-preview.js';
import { setupNavSectionCollapse, ensureNavSectionForTab } from '/js/ui/nav-sections.js';
import { globalMediaIndex } from '/js/media-index.js';
import '/js/repair-queue.js';
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
  previewLive: false,
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
  withoutbg: {
    images: [], // {path, name}[]
    folder: null,
    selected: 0,
  },
  // fastsam
  fastsam: {},
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
    target_width: 1920,
    target_height: 1080,
    status: null,
    pollTimer: null,
  },
  pool: {
    items: [], // { path, name, size?, meta?, hash? }  — Video Pool
    selectedPath: null, // sticky selection (click) — syncs library ↔ sequence
    selectedPaths: new Set(), // multi-select (shift / ctrl) by canonical path
    selectionAnchor: null,
    selectedSeqId: null, // precise sequence entry id when a token is selected
    filterQuery: '', // live filter for pool grid (pool + sequence tabs)
    searchMode: 'fuzzy', // 'fuzzy' | 'strict'
    gridScrollTop: 0,
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
    // Join / export options
    target: null,             // preset id from /api/presets (null = legacy H.264)
    useRife: false,           // RIFE interpolate before stitch
    targetFps: null,          // exact output fps when useRife is true
    instantRife: false,       // auto densify NEED clips via Instant queue
    audioEngine: 'rubberband', // audio time-stretch engine for sequence join
    selectedVariantPaths: {}, // original path -> chosen variant path (rifed/export/...)
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
    // Sequence token chip size (0–5 levels; see SEQ_TOKEN_SIZE)
    seqTokenW: 2,
    seqTokenH: 2,
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
    sortMode: 'phash',
    sortStrategy: 'radial',
    sortOrder: 'nearest_first',
    output: '',
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
  // Image Compare tab (two stills + rate via imagesort_rank)
  imgCompare: {
    pathA: null,
    pathB: null,
    sortMode: 'phash',
    lastScore: null,
    lastScoreMode: null,
    lastError: null,
    rating: null,
    mode: 'separate',
    compareMode: 'separate',
    overlayOpacity: 50,
    abPosition: 50,
  },
  imageEdit: {
    engine: 'ffmpeg', // 'ffmpeg', 'imagemagick', 'pillow'
    outputFormat: 'png',
    stack: [], // operations stack
  },
  zoompan: {
    imagePath: null, refPath: null, imageW: 0, imageH: 0,
    startBox: null, endBox: null, durationSec: 5, fps: 30,
    aspect: 'auto', viewModeStart: 'full', viewModeEnd: 'full',
    compareTarget: 'end_ref', mode: 'separate', overlayOpacity: 50, abPosition: 50,
  },
  // User preferences and inactive-tab form snapshots. Runtime-only fields
  // (health, jobs, file-browser cursors, loading flags) stay outside these.
  settings: {
    thumbnailSize: 'H',
    wallStyle: 'pair',
    thumbnailsToRam: false,
    phashToRam: false,
    autosaveInterval: 30,
    viewportLazyThumbnails: true,
    scrollbarWidth: 6,
    warmModels: { deepdream: false, styletransfer: false, fastsam: false },
  },
  formState: {},
};

if (typeof window !== 'undefined') {
  window.state = state;
  window.globalMediaIndex = globalMediaIndex;
}

const SETTINGS_DEFAULTS = {
  thumbnailSize: 'H',
  thumbnailSizeIndex: 2,
  wallStyle: 'pair',
  thumbnailsToRam: false,
  phashToRam: false,
  autosaveInterval: 30,
  viewportLazyThumbnails: true,
  scrollbarWidth: 6,
  warmModels: { deepdream: false, styletransfer: false, fastsam: false },
};

function mapServerSettings(data) {
  if (!data || typeof data !== 'object') return {};
  const mapped = {};
  if (data.thumbnail_size) mapped.thumbnailSize = data.thumbnail_size;
  if (data.thumbnails_to_ram != null) mapped.thumbnailsToRam = !!data.thumbnails_to_ram;
  if (data.phash_to_ram != null) mapped.phashToRam = !!data.phash_to_ram;
  if (data.autosave_interval != null) mapped.autosaveInterval = data.autosave_interval;
  if (data.scrollbar_width != null) mapped.scrollbarWidth = data.scrollbar_width;
  if (data.warm_models && typeof data.warm_models === 'object') {
    mapped.warmModels = { ...SETTINGS_DEFAULTS.warmModels, ...data.warm_models };
  }
  const idx = { L: 0, M: 1, H: 2 }[mapped.thumbnailSize];
  if (idx != null) mapped.thumbnailSizeIndex = idx;
  return mapped;
}

/** Startup: server settings, then localStorage (local wins), then defaults. */
async function applySettingsPrecedence() {
  let server = {};
  try {
    const res = await fetch('/api/settings');
    if (res.ok) server = mapServerSettings(await res.json());
  } catch (_) { /* defaults */ }
  let local = {};
  try {
    const raw = JSON.parse(localStorage.getItem('mtapi.settings') || 'null');
    if (raw && typeof raw === 'object') local = raw;
  } catch (_) { /* ignore */ }
  if (local && local.viewportLazyThumbnails == null && local.preloadAllThumbnails != null) {
    local.viewportLazyThumbnails = local.preloadAllThumbnails !== true;
  }
  if (server && server.viewportLazyThumbnails == null && server.preloadAllThumbnails != null) {
    server.viewportLazyThumbnails = server.preloadAllThumbnails !== true;
  }
  state.settings = {
    ...SETTINGS_DEFAULTS,
    ...server,
    ...local,
    warmModels: {
      ...SETTINGS_DEFAULTS.warmModels,
      ...(server.warmModels || {}),
      ...(local.warmModels || {}),
    },
  };
  state.settings.scrollbarWidth = readStoredScrollbarWidth();
  applyUiTweaks(state.settings.scrollbarWidth);
}

async function waitForCatalogReady() {
  window.catalogStatus = window.catalogStatus || { catalog_ready: false };
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch('/api/catalog/status');
      if (res.ok) {
        const data = await res.json();
        window.catalogStatus = data;
        if (data && data.catalog_ready) return data;
      }
    } catch (_) { /* server still binding */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return window.catalogStatus;
}


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
// actionPanel = form host (#actionPanelForm) so tab re-renders don't wipe the
// bottom input preview; actionPanelRoot = outer .action-panel for layout classes.
const elements = {
  statusDot: document.getElementById('statusDot'),
  statusText: document.getElementById('statusText'),
  tabTitle: document.getElementById('tabTitle'),
  btnRun: document.getElementById('btnRun'),
  btnStop: document.getElementById('btnStop'),
  actionPanelRoot: document.getElementById('actionPanel'),
  actionPanel: document.getElementById('actionPanelForm') || document.getElementById('actionPanel'),
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
  fastsam:     'any',
  styletransfer:'any',
  rife:        'video',
  img2img:     'any',
  txt2img:     'none',
  qr_art:      'none',
  agent:       'none',
  upscale:     'any',
  riferecohere:'image',
  speedchange: 'video',
  advanced:    'video',
  quick:       'video',
  convert:     'any',
  cut:         'video',
  imagesort:   'image',
  imageedit:   'image',
  imgcompare:  'image',
  zoompan:     'image',
  notes:       'none',
  settings:    'none',
};

/** Tabs that show the global frame-range row (video pipeline / mosh / convert). */
const FRAME_RANGE_TABS = new Set([
  'mosh', 'deepdream', 'rife', 'img2img', 'speedchange', 'convert', 'transmute',
  'styletransfer', 'withoutbg', 'fastsam', 'facemorph', 'multi', 'advanced',
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
  const hasVideo = !!window.globalInputs.video.trim();
  const hasImage = !!window.globalInputs.image.trim();
  const hasPathIn = !!window.globalInputs.pathIn.trim();
  
  const videoRow = document.querySelector('.global-row[data-input="video"]');
  const imageRow = document.querySelector('.global-row[data-input="image"]');
  const pathInRow = document.querySelector('.global-row[data-input="pathIn"]');
  
  if (videoRow) videoRow.style.display = (hasImage || hasPathIn) ? 'none' : '';
  if (imageRow) imageRow.style.display = (hasVideo || hasPathIn) ? 'none' : '';
  if (pathInRow) pathInRow.style.display = (hasVideo || hasImage) ? 'none' : '';

  try { refreshInputPreview(); } catch (_) { /* ignore */ }
  syncGlobalPanelVisibility();
}

function syncGlobalPanelVisibility() {
  var panel = document.getElementById('globalInputsPanel');
  if (!panel) return;
  var hasAny = !!(window.globalInputs.video.trim() || window.globalInputs.image.trim() ||
                   window.globalInputs.pathIn.trim() || window.globalInputs.pathOut.trim());
  panel.classList.toggle('populated', hasAny);
  // Update quick button active states
  var map = { btnQuickVIn: 'video', btnQuickVOut: 'pathOut', btnQuickIIn: 'image', btnQuickIOut: 'pathIn' };
  Object.keys(map).forEach(function(id) {
    var btn = document.getElementById(id);
    var key = map[id];
    if (btn) btn.classList.toggle('active', !!window.globalInputs[key].trim());
  });
}

function _syncTabInputFromGlobal() {
  const tab = state.activeTab;
  const gi = window.globalInputs;

  // Show/hide global frame row on ops that can honor start_frame/end_frame
  var framesRow = document.getElementById('giFramesRow');
  if (framesRow) framesRow.style.display = tabUsesFrameRange(tab) ? '' : 'none';

  // Probe first video path so range max/total stay current
  // Probe first video path so range max/total stay current
  var probePath = '';
  if (gi.video.trim()) {
    var lines = gi.video.split('\n').map(function(l) { return l.trim(); }).filter(Boolean);
    if (lines.length) probePath = lines[0];
  } else if (gi.image.trim()) {
    var lines = gi.image.trim().split('\n').map(function(l) { return l.trim(); }).filter(Boolean);
    if (lines.length) probePath = lines[0];
  }

  if (tabUsesFrameRange(tab) && probePath && detectFileType(probePath) === 'video') {
    if (probePath !== gi._lastProbedPath) {
      probeGlobalVideo(probePath);
    }
  }

  // Update global overlay
  const overlay = document.getElementById('globalProbeOverlay');
  if (overlay) {
    if (probePath) {
      overlay.style.display = 'block';
      fetch(`/api/probe?path=${encodeURIComponent(probePath)}`).then(res => res.json()).then(data => {
        if (data.ok) {
          const res = `${data.width}x${data.height}`;
          const frames = data.true_frames ? `${data.true_frames} frames` : (data.frame_count ? `${data.frame_count} frames` : '1 frame');
          const size = data.file_size ? (data.file_size / (1024*1024)).toFixed(2) + 'MB' : '';
          const date = data.file_mtime ? new Date(data.file_mtime * 1000).toLocaleString() : '';
          overlay.textContent = `[ ${res} | ${frames} | ${size} | ${date} ]`;
        } else {
          overlay.style.display = 'none';
        }
      }).catch(() => { overlay.style.display = 'none'; });
    } else {
      overlay.style.display = 'none';
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
  if (!lines.length && gi.pathIn && gi.pathIn.trim()) {
    lines = splitLines(gi.pathIn);
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
  bindInputPreviewListeners();
  await applySettingsPrecedence();
  await waitForCatalogReady();
  await checkHealth();
  await fetchOperations();
  await restorePoolState();
  syncGlobalPanelVisibility();
  switchTab(state.activeTab || 'mosh');
  // Fit empty viewer once layout settles
  requestAnimationFrame(() => fitPreviewViewer());
}

// Event Listeners
function setupEventListeners() {
  // Capture DOM-backed form values as they change. This is delegated because
  // operation tabs mount/unmount their controls during navigation.
  elements.actionPanel?.addEventListener('input', () => {
    if (isApplyingFormState()) return;
    try { captureCurrentFormState(); scheduleSavePoolState(); } catch (_) {}
  });
  elements.actionPanel?.addEventListener('change', () => {
    if (isApplyingFormState()) return;
    try { captureCurrentFormState(); scheduleSavePoolState(); } catch (_) {}
  });
  // Navigation Tabs
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
      const tab = e.currentTarget.getAttribute('data-tab');
      switchTab(tab);
    });
  });

  // Action Buttons
  elements.btnRun.addEventListener('click', runActiveOperation);
  const btnQueue = document.getElementById('btnQueue');
  if (btnQueue) btnQueue.addEventListener('click', () => enqueueActiveOperation());
  elements.btnStop?.addEventListener('click', stopActiveOperation);
  elements.btnClearConsole.addEventListener('click', () => {
    elements.consoleBody.innerHTML = '~ terminal cleared';
  });

  // Folder Opening Shortcut
  elements.btnOpenFolder.addEventListener('click', async () => {
    const path = elements.mediaPath.textContent;
    if (path) {
      logConsole(`Opening folder for: ${path}`);
      try {
        const res = await fetch('/api/open-folder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: path })
        });
        const data = await res.json();
        if (!data.ok) {
          logConsole(`[ERROR] Failed to open folder: ${data.error}`);
        }
      } catch (err) {
        logConsole(`[ERROR] Network error opening folder: ${err.message}`);
      }
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
  // Quick header buttons
  var btnQuickVIn = document.getElementById('btnQuickVIn');
  if (btnQuickVIn) {
    btnQuickVIn.addEventListener('click', function() {
      window.openFileBrowser('giVideo', false, 'files', 'video');
    });
  }
  var btnQuickVOut = document.getElementById('btnQuickVOut');
  if (btnQuickVOut) {
    btnQuickVOut.addEventListener('click', function() {
      window.openFileBrowser('giPathOut', true, 'dir', 'all');
    });
  }
  var btnQuickIIn = document.getElementById('btnQuickIIn');
  if (btnQuickIIn) {
    btnQuickIIn.addEventListener('click', function() {
      window.openFileBrowser('giImage', false, 'files', 'image');
    });
  }
  var btnQuickIOut = document.getElementById('btnQuickIOut');
  if (btnQuickIOut) {
    btnQuickIOut.addEventListener('click', function() {
      window.openFileBrowser('giPathIn', true, 'dir', 'all');
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
  setupNavSectionCollapse();
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
  // Same-tab remount must not wipe a stable pool wall. Init calls switchTab
  // after restore; a prior click can already have built #poolGrid.
  if (tab === state.activeTab && elements.actionPanel) {
    const keep = tab === 'pool' ? document.getElementById('poolGrid')
      : tab === 'images' ? document.getElementById('imgPoolGrid')
      : tab === 'sequence' ? document.getElementById('poolCompose')
      : null;
    if (keep && elements.actionPanel.contains(keep)) {
      document.querySelectorAll('.nav-item').forEach((item) => {
        item.classList.toggle('active', item.getAttribute('data-tab') === tab);
      });
      if (tab === 'pool') {
        import('/js/pool/grid.js').then((m) => m.renderPoolGrid()).catch(() => {});
      } else if (tab === 'images') {
        import('/js/pool/image-pool.js').then((m) => m.renderImagePoolGrid()).catch(() => {});
      }
      return;
    }
  }
  // DOM forms are destroyed on tab changes. Capture their controls before the
  // next renderer replaces the panel so inactive tabs remain serializable.
  try { captureCurrentFormState(); } catch (_) { /* best effort */ }
  state.activeTab = tab;
  
  // Update Active Link UI
  document.querySelectorAll('.nav-item').forEach(item => {
    if (item.getAttribute('data-tab') === tab) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });

  // Ensure the section containing this tab is expanded
  ensureNavSectionForTab(tab);

  // Update Page Title
  let title = 'Operations';
  if (tab === 'mosh') title = 'Datamosh Smear';
  if (tab === 'deepdream') title = 'Google DeepDream';
  if (tab === 'facemorph') title = 'Face Morph';
  if (tab === 'withoutbg') title = 'withoutBG · Remove Background';
  if (tab === 'fastsam') title = 'FastSAM · Asset Extraction';
  if (tab === 'styletransfer') title = 'Style Transfer · Magenta';
  if (tab === 'rife') title = 'RIFE · AI Frame Interpolation';
  if (tab === 'img2img') title = 'Img2Img · OpenVINO GPU';
  if (tab === 'txt2img') title = 'Txt2Img · OpenVINO GPU';
  if (tab === 'qr_art') title = 'QR Art · Img2Img';
  if (tab === 'agent') title = 'Agent · Vision chat';
  if (tab === 'upscale') title = 'Upscale · NCNN Vulkan';
  if (tab === 'riferecohere') title = 'RIFE Recoherence';
  if (tab === 'speedchange') title = 'Speed Change';
  if (tab === 'transmute') title = 'Single-Clip Transmutations';
  if (tab === 'multi') title = 'Layout Templates (Join / Grid)';
  if (tab === 'quick') title = 'Quick Transmute';
  if (tab === 'watcher') title = 'Folder Watcher';
  if (tab === 'advanced') title = 'Advanced (Raw CLI)';
  if (tab === 'convert') title = 'Convert / Export';
  if (tab === 'cut') title = 'Cut';
  if (tab === 'imagesort') title = 'Image Sort → Video';
  if (tab === 'imgcompare') title = 'Image Compare';
  if (tab === 'imageedit') title = 'Image Edit';
  if (tab === 'zoompan') title = 'Pan & Zoom';
  if (tab === 'jobs') title = 'Jobs · Queue';
  if (tab === 'notes') title = 'Notes';
  if (tab === 'settings') title = 'Settings';
  // Library tabs: drop the big header title (sidebar already shows active item)
  if (tab === 'pool' || tab === 'sequence' || tab === 'images') title = '';
  if (elements.tabTitle) elements.tabTitle.textContent = title;

  // Hide Run / Queue on library / settings-only tabs (compare is interactive, not a job)
  const hideRun = (
    tab === 'pool' || tab === 'sequence' || tab === 'images'
    || tab === 'quick' || tab === 'watcher' || tab === 'notes' || tab === 'settings'
    || tab === 'agent' || tab === 'jobs'
    || tab === 'imgcompare'
  );
  if (elements.btnRun) {
    elements.btnRun.style.display = hideRun ? 'none' : '';
  }
  const btnQueue = document.getElementById('btnQueue');
  if (btnQueue) btnQueue.style.display = hideRun ? 'none' : '';

  // Stop watcher status polling when leaving the tab
  if (tab !== 'watcher' && state.watcher.pollTimer) {
    clearInterval(state.watcher.pollTimer);
    state.watcher.pollTimer = null;
  }
  if (tab !== 'jobs') {
    try { stopJobsPoll(); } catch (_) { /* ignore */ }
  }

  // Pool / Sequence / Image Pool take most of the workspace
  const appContent = document.querySelector('.app-content');
  if (appContent) {
    appContent.classList.toggle(
      'pool-workspace',
      tab === 'pool' || tab === 'sequence' || tab === 'images'
    );
  }

  // Notes / Settings: bare workspace (sidebar + panel only; no global / preview)
  document.body.classList.toggle('notes-tab-active', tab === 'notes');
  document.body.classList.toggle('settings-tab-active', tab === 'settings');

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
  try {
    elements.actionPanel?.querySelectorAll('.pool-card, .img-pool-card').forEach((el) => {
      window.__mtapiLazyLoader?.unobserve(el);
    });
  } catch (_) { /* ignore */ }
  elements.actionPanel.innerHTML = '';
  const root = elements.actionPanelRoot || elements.actionPanel;
  if (root) {
    root.classList.remove('pool-active');
    root.classList.remove('notes-active');
    root.classList.remove('settings-active');
  }

  if (tab === 'mosh') {
    renderMoshForm();
  } else if (tab === 'deepdream') {
    renderDeepDreamForm();
  } else if (tab === 'facemorph') {
    renderFaceMorphForm();
  } else if (tab === 'withoutbg') {
    renderWithoutBgForm();
  } else if (tab === 'fastsam') {
    renderFastSAMForm();
  } else if (tab === 'styletransfer') {
    renderStyleTransferForm();
  } else if (tab === 'rife') {
    renderRifeForm();
  } else if (tab === 'img2img') {
    renderImg2ImgForm();
    try { applyPendingToImg2Img(); } catch (_) { /* ignore */ }
  } else if (tab === 'txt2img') {
    renderTxt2ImgForm();
    try { applyPendingToTxt2Img(); } catch (_) { /* ignore */ }
  } else if (tab === 'qr_art') {
    renderQrArtForm();
  } else if (tab === 'agent') {
    renderAgentForm();
  } else if (tab === 'upscale') {
    renderUpscaleForm();
  } else if (tab === 'riferecohere') {
    renderRifeRecohereForm();
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
  } else if (tab === 'imageedit') {
    renderImageEditForm();
  } else if (tab === 'imgcompare') {
    renderImgCompareForm();
  } else if (tab === 'jobs') {
    renderJobsForm();
  } else if (tab === 'notes') {
    renderNotesForm();
  } else if (tab === 'settings') {
    renderSettingsForm();
  }

  // Bottom input preview (after form chrome; survives form-only re-renders)
  try { refreshInputPreview(); } catch (_) { /* ignore */ }
  try { applySavedFormState(tab); } catch (_) { /* ignore */ }
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

function applySidebarExpandedWidth() {
  const aside = document.querySelector('.app-sidebar');
  if (!aside) return;
  if (document.body.classList.contains('sidebar-collapsed')) {
    aside.style.width = '';
    return;
  }
  try {
    const saved = parseInt(localStorage.getItem('mtapi_sidebar_w') || '', 10);
    if (saved >= 120 && saved <= 600) {
      aside.style.width = saved + 'px';
      document.documentElement.style.setProperty('--sidebar-w', saved + 'px');
    }
  } catch (_) { /* ignore */ }
}

function toggleSidebarCollapse() {
  const collapsed = document.body.classList.toggle('sidebar-collapsed');
  const btn = document.getElementById('btnSidebarCollapse');
  if (btn) {
    btn.textContent = collapsed ? '▶' : '◀';
    btn.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  }
  applySidebarExpandedWidth();
  try { localStorage.setItem('mtapi_sidebar_collapsed', collapsed ? '1' : '0'); } catch (_) {}
  fitPreviewViewer();
}

function syncPreviewCollapseBtn() {
  const collapsed = document.body.classList.contains('preview-collapsed');
  const btn = document.getElementById('btnPreviewCollapse');
  if (!btn) return;
  btn.textContent = collapsed ? '▼' : '▲';
  btn.title = collapsed ? 'Show Media Output Preview' : 'Hide Media Output Preview';
  btn.setAttribute('aria-label', btn.title);
  btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
}

function togglePreviewCollapse() {
  document.body.classList.toggle('preview-collapsed');
  syncPreviewCollapseBtn();
  try {
    localStorage.setItem(
      'mtapi_preview_collapsed',
      document.body.classList.contains('preview-collapsed') ? '1' : '0',
    );
  } catch (_) { /* ignore */ }
  setTimeout(() => fitPreviewViewer(), 100);
}

function loadSavedCollapseState() {
  try {
    if (localStorage.getItem('mtapi_sidebar_collapsed') === '1') {
      document.body.classList.add('sidebar-collapsed');
      const sb = document.getElementById('btnSidebarCollapse');
      if (sb) { sb.textContent = '▶'; sb.title = 'Expand sidebar'; }
    }
    applySidebarExpandedWidth();
    if (localStorage.getItem('mtapi_preview_collapsed') === '1') {
      document.body.classList.add('preview-collapsed');
    }
    syncPreviewCollapseBtn();
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
  const aside = document.querySelector('.app-sidebar');
  if (!handle || !aside) return;

  applySidebarExpandedWidth();

  _setupDragResize(handle, {
    axis: 'x',
    onDrag: (deltaX, start) => {
      if (document.body.classList.contains('sidebar-collapsed')) return;
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
    captureCurrentFormState();
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
  refreshInputPreview,
  showPreview,
  selectPoolItem, removePoolItem, sequencePositions,
  loadPoolItemMeta, setPreviewAspect, clearPreviewAspect,
  collectFaceMorphBody,
  collectWithoutBgBody, collectStyleTransferBody,   collectRifeBody,
  collectImg2ImgBody,
  collectTxt2ImgBody,
  collectQrBody,
  collectRifeRecohereBody,
  collectSpeedChangeBody,
  collectUpscaleBody,
  renderFaceMorphForm,
  renderWithoutBgForm, renderStyleTransferForm, renderRifeForm,
  renderImg2ImgForm,
  renderTxt2ImgForm,
  renderQrArtForm,
  renderRifeRecohereForm,
  renderSpeedChangeForm,
  renderUpscaleForm,
  renderImageSortForm,
  renderQuickTransmuteForm,
  renderWatcherForm, renderPoolForm, renderPoolGrid,
  checkHealth, addPathsToPool,
  sendPoolPathTo, applyPoolAsInput, formatBytes,
  ensureTileInfo, defaultTileInfo,
  setPoolZoom, applyPoolZoom, setupTileInfoMenu, showPoolContextMenu,
  showQrScannability,
};
