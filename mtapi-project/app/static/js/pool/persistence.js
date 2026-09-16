import {
  state, elements,
  logConsole,
  renderPoolForm, renderPoolGrid, defaultTileInfo,
  checkHealth, switchTab, formatBytes, addPathsToPool,
} from '/app.js';
import { seqStop, _maybeAutoRifeAll, recoverSequenceVariants, setInstantHydrationGate, disarmInstantRife } from '/js/pool/sequence.js';
import { ensurePoolLayout } from '/js/pool/layout.js';
import { ensureTileInfo } from '/app.js';
import { basename, escapeHtml, formatDurationExact } from '/js/utils.js';
import { displayOpResult, runOpWithCancel, isMainJobBusy } from '/js/job-control.js';
import { POOL_ZOOM, POOL_LAYOUT_DEFAULTS } from '/js/pool/constants.js';
import { getTabRoot, mountedTabRoots, isCachedTab } from '/js/pool/tab-roots.js';

let _poolSeqId = 1;

function nextSeqId() {
  return _poolSeqId++;
}

let _poolSaveTimer = null;
let _poolPersistReady = false; // don't save until restore finishes
let _applyingFormState = false;

const FORM_STATE_SKIP = new Set(['btnRun', 'btnStop', 'btnQueue', 'btnClearConsole']);
const META_KEYS = ['duration', 'fps', 'width', 'height', 'video_codec', 'audio_codec', 'frames', 'has_audio'];

const DESK_TAB_DEFAULTS = {
  faceMorph: { images: [], folder: null, selected: 0 },
  withoutbg: { images: [], folder: null, selected: 0 },
  styleTransfer: { contents: [], stylePath: null, selected: 0 },
  quick: { reconcile: 'pad', aspect: 'auto', aspectCustom: '' },
  watcher: {
    enabled: false, pool_ingest: false, pool_add_sequence: false,
    in_dir: '', out_dir: '', dun_dir: '',
    resize_mode: 'letterbox', target_width: 1920, target_height: 1080,
  },
  imageSort: {
    images: [], folder: null, selected: 0,
    sortMode: 'phash', sortStrategy: 'radial', sortOrder: 'nearest_first', output: '',
  },
  cut: {
    refA: null, refB: null, mode: 'separate', compareMode: 'separate',
    overlayOpacity: 50, abPosition: 50,
  },
  zoompan: {
    imagePath: null, refPath: null, imageW: 0, imageH: 0,
    startBox: null, endBox: null, durationSec: 5, fps: 30,
    aspect: 'auto', viewModeStart: 'full', viewModeEnd: 'full',
    compareTarget: 'end_ref', mode: 'separate', overlayOpacity: 50, abPosition: 50,
  },
  imgCompare: {
    pathA: null, pathB: null, sortMode: 'phash',
    lastScore: null, lastScoreMode: null, lastError: null, rating: null,
    mode: 'separate', compareMode: 'separate', overlayOpacity: 50, abPosition: 50,
  },
  imageEdit: { engine: 'ffmpeg', outputFormat: 'png', stack: [] },
};

function isApplyingFormState() {
  return _applyingFormState;
}

function serializeMeta(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const out = {};
  for (const key of META_KEYS) {
    if (meta[key] !== undefined && meta[key] !== null) out[key] = meta[key];
  }
  return Object.keys(out).length ? out : null;
}

function serializeSignature(sig) {
  if (!sig || typeof sig !== 'object') return null;
  const size = Number(sig.size);
  const mtimeNs = Number(sig.mtime_ns);
  if (!Number.isFinite(size) || !Number.isFinite(mtimeNs)) return null;
  return { size: Math.trunc(size), mtime_ns: Math.trunc(mtimeNs) };
}

function serializeCounter(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function serializePoolItem(item) {
  const err = typeof item.metaError === 'string'
    ? item.metaError
    : (typeof item.meta_error === 'string' ? item.meta_error : null);
  return {
    path: item.path,
    name: item.name || basename(item.path),
    hash: item.hash || null,
    size: item.size ?? null,
    meta: serializeMeta(item.meta),
    metaError: err,
    meta_signature: serializeSignature(item.meta_signature),
    history_count: serializeCounter(item.history_count ?? item.meta?.history_count),
    open_count: serializeCounter(item.open_count ?? item.meta?.open_count),
    thumbsFailed: item.thumbsFailed || null,
  };
}

function hydratePoolItem(it) {
  const err = typeof it.metaError === 'string'
    ? it.metaError
    : (typeof it.meta_error === 'string' ? it.meta_error : null);
  return {
    path: it.path,
    name: it.name || basename(it.path),
    hash: it.hash || null,
    size: it.size ?? null,
    meta: serializeMeta(it.meta),
    metaError: err,
    meta_signature: serializeSignature(it.meta_signature),
    history_count: serializeCounter(it.history_count),
    open_count: serializeCounter(it.open_count),
    thumbs: it.thumbs || null,
    thumbsFailed: it.thumbsFailed || it.thumbs_failed || null,
  };
}

function schemaVersionOf(data) {
  const n = Number(data?.project_version ?? data?.version);
  if (!Number.isFinite(n) || n < 1) return 1;
  return n;
}

function hydrateDeskTabs(stateObj) {
  const s = (stateObj && typeof stateObj === 'object') ? stateObj : {};
  for (const [key, def] of Object.entries(DESK_TAB_DEFAULTS)) {
    if (!s[key] || typeof s[key] !== 'object') s[key] = { ...def };
    else s[key] = { ...def, ...s[key] };
  }
  return s;
}

/** v1 → v2: assume missing/malformed version is 1; hydrate missing tab keys. */
function migratePoolPayload(data) {
  if (!data || typeof data !== 'object') return data || {};
  const from = schemaVersionOf(data);
  if (data.desk && typeof data.desk === 'object') {
    data.desk.state = hydrateDeskTabs(data.desk.state);
    data.desk.schema_version = 2;
  }
  data.version = 2;
  if (data.project_version != null) data.project_version = 2;
  data._migratedFrom = from;
  return data;
}

/** Read one scope's controls (same filters as captureCurrentFormState). */
function captureFormStateInScope(scopeEl, tab) {
  if (!scopeEl) return;
  const controls = {};
  scopeEl.querySelectorAll('input[id], select[id], textarea[id]').forEach((el) => {
    if (FORM_STATE_SKIP.has(el.id) || el.type === 'button' || el.type === 'submit') return;
    controls[el.id] = {
      value: el.value,
      checked: el.type === 'checkbox' || el.type === 'radio' ? !!el.checked : undefined,
    };
  });
  state.formState[tab] = controls;
}

/** Capture the currently mounted tab controls before its DOM is destroyed. */
function captureCurrentFormState() {
  const tab = state.activeTab;
  if (!tab || !elements.actionPanel) return;
  if (tab === 'settings') return;
  // Permanent tab roots are captured per-tab by captureAllMountedFormState;
  // the legacy path only owns direct (uncached) panel children.
  const controls = {};
  elements.actionPanel.querySelectorAll('input[id], select[id], textarea[id]').forEach((el) => {
    if (el.closest && el.closest('.tab-root')) return;
    if (FORM_STATE_SKIP.has(el.id) || el.type === 'button' || el.type === 'submit') return;
    controls[el.id] = {
      value: el.value,
      checked: el.type === 'checkbox' || el.type === 'radio' ? !!el.checked : undefined,
    };
  });
  state.formState[tab] = controls;
}

/**
 * Capture every mounted tab root (including hidden and detached-held ones —
 * reads, never measurements) plus the active uncached panel content.
 * Replaces the single-tab leave-capture on explicit saves and beforeunload:
 * background roots hold newer user edits than the leaving tab, and a partial
 * snapshot would stamp stale values as truth on later saves.
 */
function captureAllMountedFormState() {
  if (!elements.actionPanel) return;
  for (const { tab, root } of mountedTabRoots()) {
    if (tab === 'settings') continue;
    try { captureFormStateInScope(root, tab); } catch (_) { /* best effort */ }
  }
  const tab = state.activeTab;
  if (tab && !isCachedTab(tab)) {
    try { captureCurrentFormState(); } catch (_) { /* best effort */ }
  }
}

/**
 * Restore controls after a tab renderer mounts them.
 * Change is dispatched so knobs refresh, but `_applyingFormState` suppresses
 * delegated resave / watcher POSTs (duplicate snapshot side effects).
 */
function applySavedFormState(tab) {
  if (tab === 'settings') return;
  const controls = state.formState?.[tab];
  if (!controls || !elements.actionPanel) return;
  // Resolve inside the tab's own root when mounted (attached or held):
  // pool/sequence share control ids across roots, so a document-wide lookup
  // could replay one tab's values onto another tab's live inputs.
  const scope = getTabRoot(tab) || elements.actionPanel;
  _applyingFormState = true;
  try {
    Object.entries(controls).forEach(([id, saved]) => {
      let el = null;
      try {
        el = scope.querySelector(`#${CSS.escape(id)}`) || document.getElementById(id);
      } catch (_) {
        el = document.getElementById(id);
      }
      if (!el || !saved) return;
      if (el.type === 'checkbox' || el.type === 'radio') el.checked = !!saved.checked;
      else if (saved.value != null) el.value = saved.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
  } finally {
    _applyingFormState = false;
  }
}

function buildDeskSnapshot() {
  return {
    schema_version: 2,
    global_inputs: {
      video: window.globalInputs?.video || '',
      image: window.globalInputs?.image || '',
      path_in: window.globalInputs?.pathIn || '',
      path_out: window.globalInputs?.pathOut || '',
      frame_start: Number(window.globalInputs?.frameStart || 1),
      frame_end: Number(window.globalInputs?.frameEnd || 100),
    },
    active_tab: state.activeTab,
    form_state: state.formState || {},
    state: {
      project: { ...state.project },
      faceMorph: state.faceMorph,
      withoutbg: state.withoutbg,
      styleTransfer: state.styleTransfer,
      quick: state.quick,
      watcher: {
        enabled: !!state.watcher?.enabled,
        pool_ingest: !!state.watcher?.pool_ingest,
        pool_add_sequence: !!state.watcher?.pool_add_sequence,
        in_dir: state.watcher?.in_dir || '',
        out_dir: state.watcher?.out_dir || '',
        dun_dir: state.watcher?.dun_dir || '',
        resize_mode: state.watcher?.resize_mode || 'letterbox',
        target_width: Number(state.watcher?.target_width || 1920),
        target_height: Number(state.watcher?.target_height || 1080),
      },
      imageSort: state.imageSort,
      cut: state.cut,
      zoompan: state.zoompan || {},
      imgCompare: state.imgCompare || {},
      imageEdit: state.imageEdit || {},
      settings: state.settings,
    },
  };
}

function applyDeskSnapshot(desk, { restoreSettings = true } = {}) {
  if (!desk || typeof desk !== 'object') return;
  const gi = desk.global_inputs || {};
  window.globalInputs.video = gi.video || '';
  window.globalInputs.image = gi.image || '';
  window.globalInputs.pathIn = gi.path_in || '';
  window.globalInputs.pathOut = gi.path_out || '';
  window.globalInputs.frameStart = Number(gi.frame_start || 1);
  window.globalInputs.frameEnd = Number(gi.frame_end || 100);
  const setVal = (id, val) => {
    const el = document.getElementById(id);
    if (el && val != null) el.value = val;
  };
  setVal('giVideo', window.globalInputs.video);
  setVal('giImage', window.globalInputs.image);
  setVal('giPathIn', window.globalInputs.pathIn);
  setVal('giPathOut', window.globalInputs.pathOut);
  if (desk.active_tab) state.activeTab = desk.active_tab;
  if (desk.form_state && typeof desk.form_state === 'object') state.formState = desk.form_state;
  const s = hydrateDeskTabs(desk.state || {});
  if (s.project && typeof s.project === 'object') {
    state.project = { ...state.project, ...s.project, dirty: !!s.project.dirty };
  }
  for (const key of ['faceMorph', 'withoutbg', 'styleTransfer', 'quick', 'imageSort', 'cut', 'zoompan', 'imgCompare', 'imageEdit']) {
    if (s[key] && typeof s[key] === 'object') state[key] = { ...(state[key] || {}), ...s[key] };
  }
  if (s.watcher && typeof s.watcher === 'object') {
    state.watcher = { ...state.watcher, ...s.watcher };
  }
  // Settings are global (localStorage + /api/settings). Session/project
  // snapshots must never overwrite them — that made size/toggles appear
  // to "not persist" on reload.
  void restoreSettings;
}

// ── Pool persistence ──────────────────────────────────────────────────────

function scheduleSavePoolState() {
  if (!_poolPersistReady) return;
  markProjectDirty();
  if (_poolSaveTimer) clearTimeout(_poolSaveTimer);
  _poolSaveTimer = setTimeout(() => {
    _poolSaveTimer = null;
    savePoolStateNow();
  }, Math.max(400, Number(state.settings?.autosaveInterval || 30) * 1000));
}

function buildPoolStatePayload() {
  const multipliers = {};
  for (const entry of state.pool.sequence) {
    if (entry.path && entry._rifeMultiplier) {
      multipliers[entry.path] = entry._rifeMultiplier;
    }
  }

  return {
    version: 2,
    // Save basis for stale-merge: the server unions in membership rows that
    // arrived after this client loaded (watcher ingest), instead of letting
    // a stale autosave wipe them. Absent/null = explicit replace.
    _basis_updated_at: state.pool.serverUpdatedAt ?? null,
    items: state.pool.items.map(serializePoolItem),
    images: (state.imagePool?.items || []).map(serializePoolItem),
    sequence: state.pool.sequence.map(s => {
      const td = s.targetDuration;
      const n = (td != null && td !== '' && Number.isFinite(Number(td)) && Number(td) > 0)
        ? Number(td)
        : null;
      // Revisit tag: lowercase #rrggbb or null (validated, never trusted raw).
      const _tag = (typeof s.tagColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(s.tagColor.trim()))
        ? s.tagColor.trim().toLowerCase()
        : null;
      return {
        path: s.path,
        name: s.name || basename(s.path),
        target_duration: n,
        _had_target: !!s._hadTarget,
        tag_color: _tag,
        variant_path: s.variantPath || null,
        conformed_path: s.conformedPath || null,
        conform_signature: s.conformSignature || null,
        conform_status: s.conformStatus || null,
        // Remember densify strength so Instant does not re-RIFE after reload
        rife_multiplier: (s._rifeMultiplier != null && s._rifeMultiplier > 0)
          ? Number(s._rifeMultiplier)
          : null,
        variant_hash: s._variantHash || null,
        rife_need: (s.rifeNeed === 'rifed' || s.rifeNeed === 'needsRife' || s.rifeNeed === 'noRifeNeeded')
          ? s.rifeNeed
          : null,
      };
    }),
    selected_path: state.pool.selectedPath,
    selected_paths: state.pool.selectedPaths instanceof Set
      ? [...state.pool.selectedPaths]
      : (state.pool.selectedPath ? [state.pool.selectedPath] : []),
    search_mode: state.pool.searchMode === 'strict' ? 'strict' : 'fuzzy',
    grid_scroll_top: Number(state.pool.gridScrollTop) || 0,
    selected_image_path: state.imagePool?.selectedPath || null,
    reconcile: state.pool.reconcile || 'pad',
    aspect: state.pool.aspect || 'auto',
    aspect_custom: state.pool.aspectCustom || '',
    output_path: state.pool.outputPath || '',
    target: state.pool.target || null,
    use_rife: !!state.pool.useRife,
    target_fps: state.pool.targetFps || null,
    instant_rife: !!state.pool.instantRife,
    audio_engine: state.pool.audioEngine || 'rubberband',
    conform_enabled: !!state.pool.conformEnabled,
    conform_mode: state.pool.conformMode || state.pool.reconcile || 'pad',
    conform_preset: state.pool.conformPreset || 'h264_avc_hq',
    conform_target_fps: state.pool.conformTargetFps || null,
    auto_conform_after_rife: state.pool.autoConformAfterRife !== false,
    selected_variant_paths: state.pool.selectedVariantPaths || {},
    tile_zoom: state.pool.tileZoom || POOL_ZOOM.reset,
    tile_info: ensureTileInfo(),
    seq_token_w: state.pool.seqTokenW ?? 2,
    seq_token_h: state.pool.seqTokenH ?? 2,
    layout: ensurePoolLayout(),
    project_name: state.project.name || null,
    project_path: state.project.path || null,
    // Session-only: whether named project file may lag the desk (never auto-written).
    project_dirty: !!(state.project.path && state.project.dirty),
    desk: buildDeskSnapshot(),
  };
}

function projectLabel() {
  if (state.project.name) {
    return (state.project.dirty ? '• ' : '') + state.project.name;
  }
  return state.project.dirty ? '• Untitled project' : 'Untitled project';
}

function markProjectDirty() {
  if (!_poolPersistReady) return;
  if (!state.project.dirty) {
    state.project.dirty = true;
    updateProjectNameUI();
  } else {
    state.project.dirty = true;
  }
}

function updateProjectNameUI() {
  // poolProjectName exists in both the video and image pool toolbars —
  // update every instance, not just the first in document order.
  document.querySelectorAll('#poolProjectName').forEach((el) => {
    el.textContent = projectLabel();
    el.title = state.project.path || '';
  });
}

/** Apply loaded project/session JSON into live pool state and re-render. */
function applyPoolData(data, { asProject = false, projectPath = null, projectName = null } = {}) {
  setInstantHydrationGate(false);
  // Loading state is not a start gesture: NEED badges recompute live, but no
  // Instant encode may begin until the user toggles Instant, edits Time, or
  // adds a clip (those arm it explicitly).
  try { disarmInstantRife(); } catch (_) { /* ignore */ }
  data = migratePoolPayload(data);
  // Named projects must never overwrite global settings.
  applyDeskSnapshot(data.desk, { restoreSettings: !asProject });
  const items = data.items || [];
  const sequence = data.sequence || [];
  const images = data.images || [];
  const basis = Number(data.updated_at);
  state.pool.serverUpdatedAt = Number.isFinite(basis) ? basis : null;

  state.pool.items = items.map(hydratePoolItem);
  state.pool.sequence = sequence.map(s => {
    let td = s.target_duration ?? s.targetDuration ?? null;
    if (td != null) {
      td = Number(td);
      if (!Number.isFinite(td) || td <= 0) td = null;
    }
    const vp = s.variant_path ?? s.variantPath ?? null;
    let rm = s.rife_multiplier ?? s._rifeMultiplier ?? null;
    if (rm != null) {
      rm = Number(rm);
      if (!Number.isFinite(rm) || rm < 2) rm = null;
    }
    // If we have a densify path but no M (legacy sessions), assume at least ×2
    if (vp && rm == null) rm = 2;
    const vh = s.variant_hash ?? s._variantHash ?? null;
    const cp = s.conformed_path ?? s.conformedPath ?? null;
    const csig = s.conform_signature ?? s.conformSignature ?? null;
    const cstat = s.conform_status ?? s.conformStatus ?? (cp ? 'valid' : null);
    const _rawTag = s.tag_color ?? s.tagColor ?? null;
    const _tag = (typeof _rawTag === 'string' && /^#[0-9a-fA-F]{6}$/.test(_rawTag.trim()))
      ? _rawTag.trim().toLowerCase()
      : null;
    return {
      id: nextSeqId(),
      path: s.path,
      name: s.name || basename(s.path),
      targetDuration: td,
      _hadTarget: !!s._had_target,
      tagColor: _tag,
      variantPath: vp,
      conformedPath: cp,
      conformSignature: (csig && typeof csig === 'object') ? csig : null,
      conformStatus: (cstat === 'valid' || cstat === 'stale' || cstat === 'invalid'
        || cstat === 'pending' || cstat === 'running') ? cstat : (cp ? 'valid' : null),
      _rifeMultiplier: rm,
      _variantHash: (typeof vh === 'string' && vh) ? vh : null,
      rifeNeed: (s.rife_need === 'rifed' || s.rife_need === 'needsRife' || s.rife_need === 'noRifeNeeded')
        ? s.rife_need
        : ((vp && rm) ? 'rifed' : null),
      _rifeStatus: (vp && rm) ? 'done' : null,
    };
  });
  state.pool.selectedPath = data.selected_path || null;
  state.pool.selectedPaths = new Set(
    Array.isArray(data.selected_paths) && data.selected_paths.length
      ? data.selected_paths
      : (data.selected_path ? [data.selected_path] : []),
  );
  state.pool.selectionAnchor = state.pool.selectedPath;
  state.pool.searchMode = data.search_mode === 'strict' ? 'strict' : 'fuzzy';
  state.pool.gridScrollTop = Number(data.grid_scroll_top) || 0;
  state.pool.focusPath = data.selected_path || null;
  state.pool.hoverPath = null;
  state.pool.selectedSeqId = null;
  state.pool.reconcile = data.reconcile || 'pad';
  state.pool.aspect = data.aspect || 'auto';
  state.pool.aspectCustom = data.aspect_custom || '';
  state.pool.outputPath = data.output_path || '';
  state.pool.target = data.target || null;
  state.pool.useRife = !!data.use_rife;
  state.pool.targetFps = data.target_fps || null;
  state.pool.instantRife = !!data.instant_rife;
  state.pool.audioEngine = data.audio_engine || 'rubberband';
  state.pool.conformEnabled = !!data.conform_enabled;
  state.pool.conformMode = data.conform_mode || data.reconcile || 'pad';
  state.pool.conformPreset = data.conform_preset || 'h264_avc_hq';
  state.pool.conformTargetFps = data.conform_target_fps || null;
  state.pool.autoConformAfterRife = data.auto_conform_after_rife !== false;
  state.pool.selectedVariantPaths = data.selected_variant_paths || {};

  // Image Pool (v2; missing images → [])
  if (!state.imagePool) {
    state.imagePool = { items: [], selectedPath: null, filterQuery: '', loading: false };
  }
  state.imagePool.items = images.map(hydratePoolItem);
  state.imagePool.selectedPath = data.selected_image_path || null;
  if (state.imagePool.selectedPath) {
    const stillThere = state.imagePool.items.some(i => i.path === state.imagePool.selectedPath);
    if (!stillThere) state.imagePool.selectedPath = null;
  }

  if (typeof data.tile_zoom === 'number' && !isNaN(data.tile_zoom)) {
    state.pool.tileZoom = Math.max(POOL_ZOOM.min, Math.min(POOL_ZOOM.max, data.tile_zoom));
  } else {
    state.pool.tileZoom = POOL_ZOOM.reset;
  }
  {
    const clampLvl = (v, d) => {
      const n = parseInt(v, 10);
      if (!Number.isFinite(n)) return d;
      return Math.max(0, Math.min(5, n));
    };
    state.pool.seqTokenW = clampLvl(data.seq_token_w ?? data.seqTokenW, 2);
    state.pool.seqTokenH = clampLvl(data.seq_token_h ?? data.seqTokenH, 2);
  }
  if (data.tile_info && typeof data.tile_info === 'object') {
    state.pool.tileInfo = { ...defaultTileInfo(), ...data.tile_info };
  } else {
    state.pool.tileInfo = defaultTileInfo();
  }
  if (data.layout && typeof data.layout === 'object') {
    const base = { ...POOL_LAYOUT_DEFAULTS, collapsed: { ...POOL_LAYOUT_DEFAULTS.collapsed } };
    state.pool.layout = {
      ...base,
      ...data.layout,
      collapsed: { ...base.collapsed, ...(data.layout.collapsed || {}) },
    };
    const sh = state.pool.layout.selectionHeight;
    if (sh === 120 || sh === 140 || sh === undefined || sh === null) {
      state.pool.layout.selectionHeight = 0;
    }
  } else {
    state.pool.layout = { ...POOL_LAYOUT_DEFAULTS, collapsed: { ...POOL_LAYOUT_DEFAULTS.collapsed } };
  }

  if (asProject) {
    state.project.path = projectPath || data.path || null;
    state.project.name = projectName || data.name || (state.project.path ? basename(state.project.path).replace(/\.ffproject\.json$/i, '') : null);
    state.project.dirty = false;
  }

  const missing = data.missing || [];
  if (missing.length) {
    logConsole(`[PROJECT]: ${missing.length} missing path(s) skipped:\n${missing.slice(0, 8).join('\n')}`);
  }

  try {
    import('/js/media-index.js').then((m) => {
      m.globalMediaIndex.seed(state.pool.items);
      m.globalMediaIndex.seed(state.imagePool?.items);
      try { window.__mtapiRepairQueue?.markHydrated?.(); } catch (_) { /* ignore */ }
    }).catch(() => {});
  } catch (_) { /* ignore */ }

  // Metadata is cache-first. Valid persisted records skip /api/media_info
  // and /api/media_signature. Re-probe global frame count for sliders.
  const firstVideo = String(window.globalInputs?.video || '')
    .split('\n').map((l) => l.trim()).find(Boolean);
  if (firstVideo) {
    import('/js/timeline.js').then((m) => {
      try { m.probeGlobalVideo(firstVideo); } catch (_) { /* ignore */ }
    }).catch(() => {});
  }

  // Restore can finish after the pool wall already mounted (empty). Refresh
  // cards without remounting the form.
  if (state.activeTab === 'pool' && document.getElementById('poolGrid')) {
    import('/js/pool/grid.js').then((m) => m.renderPoolGrid()).catch(() => {});
  } else if (state.activeTab === 'images' && document.getElementById('imgPoolGrid')) {
    import('/js/pool/image-pool.js').then((m) => m.renderImagePoolGrid()).catch(() => {});
  }
}

async function projectNew() {
  const hasImages = (state.imagePool?.items || []).length > 0;
  if (state.project.dirty || state.pool.items.length || state.pool.sequence.length || hasImages) {
    if (!confirm('Start a new project? Unsaved changes will be lost (session autosave still has last autosave).')) {
      return;
    }
  }
  seqStop();
  import('/js/lazy-loader.js').then((m) => {
    try { m.clearPending(); m.disconnectAll(); } catch (_) { /* ignore */ }
  }).catch(() => {});
  state.pool.items = [];
  state.pool.sequence = [];
  state.pool.selectedPath = null;
  state.pool.selectedPaths = new Set();
  state.pool.selectionAnchor = null;
  state.pool.gridScrollTop = 0;
  state.pool.selectedSeqId = null;
  state.pool.hoverPath = null;
  state.pool.focusPath = null;
  state.pool.matchResults = null;
  state.pool.outputPath = '';
  state.pool.target = null;
  state.pool.useRife = false;
  state.pool.targetFps = null;
  state.pool.instantRife = false;
  state.pool.selectedVariantPaths = {};
  state.pool.audioEngine = 'rubberband';
  state.pool.conformEnabled = false;
  state.pool.conformMode = 'pad';
  state.pool.conformPreset = 'h264_avc_hq';
  state.pool.conformTargetFps = null;
  state.pool.autoConformAfterRife = true;
  if (state.imagePool) {
    state.imagePool.items = [];
    state.imagePool.selectedPath = null;
    state.imagePool.filterQuery = '';
  }
  if (state.cut) {
    state.cut.videoPath = null;
    state.cut.refA = null;
    state.cut.refB = null;
  }
  state.project = { path: null, name: null, dirty: false };
  logConsole('[PROJECT]: New untitled project');
  if (state.activeTab === 'pool') renderPoolForm();
  else if (state.activeTab === 'images') {
    import('/js/pool/image-pool.js').then(m => m.renderImagePoolForm());
  }
  await savePoolStateNow();
}

async function projectOpen() {
  if (state.project.dirty) {
    if (!confirm('Open another project? Unsaved changes in the current project may be lost.')) {
      return;
    }
  }
  elements.statusDot.className = 'status-dot loading';
  elements.statusText.textContent = 'Open project…';
  try {
    const start = state.project.path
      ? state.project.path.substring(0, state.project.path.lastIndexOf('/'))
      : '';
    const pickRes = await fetch(
      `/api/picker?mode=file&filter=project&start_path=${encodeURIComponent(start || '')}`
    );
    if (!pickRes.ok) throw new Error(await pickRes.text());
    const pick = await pickRes.json();
    if (!pick.path) {
      logConsole('[PROJECT]: Open cancelled');
      await checkHealth();
      return;
    }
    const res = await fetch(`/api/project/load?path=${encodeURIComponent(pick.path)}`);
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'load failed');

    applyPoolData(data, {
      asProject: true,
      projectPath: data.path,
      projectName: data.name,
    });
    // Open renders from persisted records only (spec §8.3): no registry
    // hydration, no probes, no reads. The armed scan hydrates on gesture.
    setInstantHydrationGate(true);
    // Session mirrors the opened desk so F5 prefers session (not a stale dual-write).
    _poolPersistReady = true;
    await savePoolStateNow();
    const imgN = data.image_count ?? (data.images || []).length;
    logConsole(
      `[PROJECT]: Opened ${data.name || data.path} — ${data.item_count} clips, ${imgN} images, ${data.sequence_count} in sequence`
    );
    if (state.activeTab === 'pool') renderPoolForm();
    else if (state.activeTab === 'images') {
      import('/js/pool/image-pool.js').then(m => m.renderImagePoolForm());
    } else switchTab('pool');
  } catch (err) {
    logConsole(`[PROJECT OPEN]: ${err.message}`, 'error');
    alert(`Could not open project: ${err.message}`);
  } finally {
    await checkHealth();
  }
}

/**
 * Guard explicit Save when wiping a non-empty on-disk sequence with an empty one.
 * Returns false if the user cancelled.
 */
async function confirmEmptySequenceOverwrite(path) {
  if (!path || state.pool.sequence.length > 0) return true;
  try {
    const res = await fetch(`/api/project/load?path=${encodeURIComponent(path)}`);
    if (!res.ok) return true;
    const data = await res.json();
    if (!data.ok) return true;
    const n = data.sequence_count ?? (data.sequence || []).length;
    if (n > 0) {
      return confirm(
        `Current sequence is empty, but the project file has ${n} clip(s).\n\n`
        + 'Overwrite the saved project with an empty sequence?'
      );
    }
  } catch (_) { /* allow save if check fails */ }
  return true;
}

async function projectSave(saveAs = false) {
  captureAllMountedFormState();
  let path = state.project.path;
  if (saveAs || !path) {
    const suggested = path
      || `${(state.pool.sequence[0]?.path || state.pool.items[0]?.path || '/home/m/snc/cod/ffTransmuteWebui/untitled').replace(/\/[^/]+$/, '')}/untitled.ffproject.json`;
    try {
      const pickRes = await fetch(
        `/api/picker?mode=save&filter=project&start_path=${encodeURIComponent(suggested)}`
      );
      if (!pickRes.ok) throw new Error(await pickRes.text());
      const pick = await pickRes.json();
      if (!pick.path) {
        logConsole('[PROJECT]: Save cancelled');
        return;
      }
      path = pick.path;
      if (!/\.ffproject\.json$/i.test(path) && !/\.ffproj$/i.test(path)) {
        if (/\.json$/i.test(path)) path = path.replace(/\.json$/i, '.ffproject.json');
        else path = path + '.ffproject.json';
      }
    } catch (err) {
      logConsole(`[PROJECT SAVE]: Picker failed — ${err.message}`, 'error');
      alert(`Save dialog failed: ${err.message}`);
      return;
    }
  }

  // Empty sequence must not silently clobber a rich on-disk project (explicit Save only).
  if (!(await confirmEmptySequenceOverwrite(path))) {
    logConsole('[PROJECT]: Save cancelled (empty sequence overwrite refused)');
    return;
  }

  const name = state.project.name
    || basename(path).replace(/\.ffproject\.json$/i, '').replace(/\.ffproj$/i, '');

  elements.statusDot.className = 'status-dot loading';
  elements.statusText.textContent = 'Saving project…';
  try {
    const body = {
      ...buildPoolStatePayload(),
      path,
      name,
    };
    const res = await fetch('/api/project/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'save failed');

    state.project.path = data.path;
    state.project.name = data.name || name;
    state.project.dirty = false;
    updateProjectNameUI();
    logConsole(`[PROJECT]: Saved ${state.project.name} → ${data.path}`);
    elements.statusDot.className = 'status-dot';
    elements.statusText.textContent = 'Project saved';
  } catch (err) {
    logConsole(`[PROJECT SAVE]: ${err.message}`, 'error');
    elements.statusDot.className = 'status-dot error';
    elements.statusText.textContent = 'Save failed';
    alert(`Could not save project: ${err.message}`);
  } finally {
    await checkHealth();
  }
}

/**
 * Session autosave only. NEVER writes named *.ffproject.json.
 * Named projects are sacred — only projectSave / Save As may touch them.
 * (Fix: quiet dual-save was emptying project A after clear → Save As B.)
 */
async function savePoolStateNow() {
  if (!_poolPersistReady) return;
  try {
    captureAllMountedFormState();
    const payload = buildPoolStatePayload();
    const res = await fetch('/api/pool/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(await res.text());
    try {
      const data = await res.json();
      if (data && Number.isFinite(Number(data.updated_at))) {
        state.pool.serverUpdatedAt = Number(data.updated_at);
      }
    } catch (_) { /* basis refresh is best-effort */ }
    // Do NOT clear dirty — only explicit projectSave does.
    // Do NOT POST /api/project/save here.
  } catch (err) {
    logConsole(`[POOL SAVE]: ${err.message}`, 'error');
  }
}

async function restorePoolState() {
  try {
    // Prefer session autosave (latest desk edits). Named project files are only
    // updated on explicit Save — so last-project-first would wipe recent work
    // and forced the old dual-save bug.
    let data = null;
    const res = await fetch('/api/pool/state');
    if (res.ok) {
      data = await res.json();
      if (data.ok) {
        applyPoolData(data, { asProject: false });
        // Restore renders persisted records only (spec §8.3) — no reads on open.
        setInstantHydrationGate(true);
        if (data.project_path) {
          state.project.path = data.project_path;
          state.project.name = data.project_name
            || basename(data.project_path).replace(/\.ffproject\.json$/i, '');
          // Restore dirty from session (true only if user had unsaved edits vs named file).
          state.project.dirty = data.project_dirty === true;
          updateProjectNameUI();
        }
        const timed = state.pool.sequence.filter(s => s.targetDuration != null).length;
        const imgN = state.imagePool?.items?.length || 0;
        logConsole(
          `[POOL]: Restored session — ${state.pool.items.length} clips, ${imgN} images, ${state.pool.sequence.length} in sequence`
          + (timed ? `, ${timed} timed` : '')
          + (data.project_path ? ` (open: ${data.project_name || basename(data.project_path)})` : '')
          + ((data.missing || []).length ? ` (${data.missing.length} missing skipped)` : '')
        );
        _poolPersistReady = true;
        return;
      }
    }

    // No session → fall back to last named project (explicit last Save).
    try {
      const lastRes = await fetch('/api/project/last');
      if (lastRes.ok) {
        const last = await lastRes.json();
        if (last.path) {
          const pr = await fetch(`/api/project/load?path=${encodeURIComponent(last.path)}`);
          if (pr.ok) {
            data = await pr.json();
            if (data.ok) {
              applyPoolData(data, {
                asProject: true,
                projectPath: data.path,
                projectName: data.name,
              });
              // Restore renders persisted records only (spec §8.3) — no reads on open.
              setInstantHydrationGate(true);
              _poolPersistReady = true;
              await savePoolStateNow();
              const timed = state.pool.sequence.filter(s => s.targetDuration != null).length;
              const imgN = state.imagePool?.items?.length || 0;
              logConsole(
                `[PROJECT]: Restored ${data.name || data.path} — ${state.pool.items.length} clips, ${imgN} images, ${state.pool.sequence.length} in sequence`
                + (timed ? `, ${timed} timed` : '')
              );
              return;
            }
          }
        }
      }
    } catch (_) { /* empty desk */ }

    logConsole('[POOL]: No saved state (empty)');
    _poolPersistReady = true;
    setInstantHydrationGate(true);
    try { window.__mtapiRepairQueue?.markHydrated?.(); } catch (_) { /* ignore */ }
  } catch (err) {
    logConsole(`[POOL RESTORE]: ${err.message}`, 'error');
    _poolPersistReady = true;
    setInstantHydrationGate(true);
  }
}

function refreshPoolToolbarCounts() {
  // Scope to the video pool root: the image pool has its own .pool-count.
  const poolRoot = getTabRoot('pool');
  const el = poolRoot
    ? poolRoot.querySelector('.pool-count')
    : document.querySelector('.pool-count:not(#imgPoolCount)');
  if (el) {
    const seqClearBtn = document.getElementById('btnSeqClear');
    const seqBox = document.getElementById('poolSequenceBox');
    const hasSeqUi = (seqClearBtn && !seqClearBtn.hidden && !seqClearBtn.closest('.tab-root[hidden]'))
      || (seqBox && !seqBox.closest('.tab-root[hidden]'));
    el.textContent = hasSeqUi
      ? `${state.pool.items.length} in video pool · ${state.pool.sequence.length} in sequence`
      : `${state.pool.items.length} in video pool`;
  }
  const stitchBtn = document.getElementById('btnPoolStitch');
  if (stitchBtn) stitchBtn.disabled = state.pool.sequence.length < 2;
  const empty = state.pool.sequence.length === 0;
  const seqClear = document.getElementById('btnSeqClear');
  if (seqClear) seqClear.disabled = empty;
  const seqClearDock = document.getElementById('btnSeqClearDock');
  if (seqClearDock) seqClearDock.disabled = empty;
}

/** Ensure a path has a video container extension ffmpeg can mux. */
function ensureVideoOutputPath(path) {
  if (!path) return path;
  const p = String(path).trim();
  if (!p) return p;
  const VIDEO_OUT_EXTS = ['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi'];
  const lower = p.toLowerCase();
  if (VIDEO_OUT_EXTS.some(ext => lower.endsWith(ext))) return p;
  // Bare name or wrong/missing extension → force .mp4
  if (/\.[a-z0-9]{1,5}$/i.test(p)) {
    return p.replace(/\.[a-z0-9]{1,5}$/i, '.mp4');
  }
  return `${p}.mp4`;
}

async function stitchPoolSequence() {
  const paths = state.pool.sequence.map(s => s.path);
  if (paths.length < 2) {
    logConsole('[STITCH]: Need at least 2 clips in the sequence to stitch.', 'error');
    if (elements.statusText) elements.statusText.textContent = 'Need ≥2 clips';
    return;
  }

  // --- INSTANT CLICK FEEDBACK (never hide) — sync, before any await ---
  const _clickN = paths.length;
  try {
    logConsole(`[CLICK]: Stitch clicked — ${_clickN} clips`);
    if (elements.statusDot) elements.statusDot.className = 'status-dot loading';
    if (elements.statusText) elements.statusText.textContent = `Stitch clicked — ${_clickN} clips…`;
    const _btnEarly = document.getElementById('btnPoolStitch');
    if (_btnEarly) {
      _btnEarly.disabled = true;
      _btnEarly.dataset.label = _btnEarly.innerHTML;
      _btnEarly.innerHTML = 'Stitching…';
    }
  } catch (_) { /* never block stitch on UI */ }

  const mode = document.getElementById('poolReconcile')?.value || state.pool.reconcile || 'pad';
  let aspect = document.getElementById('poolAspect')?.value || state.pool.aspect || 'auto';
  if (aspect === 'custom') {
    aspect = (document.getElementById('poolAspectCustom')?.value || state.pool.aspectCustom || '').trim();
    if (!aspect || !/^(\d+:\d+|\d+x\d+)$/i.test(aspect)) {
      logConsole('[STITCH]: Custom AR needs W:H (e.g. 5:4) or WxH (e.g. 1080x1920).', 'error');
      if (elements.statusText) elements.statusText.textContent = 'Bad custom AR';
      const _btnErr = document.getElementById('btnPoolStitch');
      if (_btnErr) { _btnErr.disabled = state.pool.sequence.length < 2; _btnErr.innerHTML = _btnErr.dataset.label || 'Stitch Sequence'; }
      return;
    }
  }
  let outputRaw = document.getElementById('poolOutput')?.value?.trim() || state.pool.outputPath || '';
  // ffmpeg needs a real container extension (e.g. .mp4). A path like ".../1" fails muxer init.
  let output_path = outputRaw ? ensureVideoOutputPath(outputRaw) : null;
  if (output_path && output_path !== outputRaw) {
    logConsole(`[STITCH]: Output had no video extension — using ${output_path}`);
    const outInput = document.getElementById('poolOutput');
    if (outInput) outInput.value = output_path;
    state.pool.outputPath = output_path;
  }

  // Per-clip target durations (null = native)
  const durations = state.pool.sequence.map(s =>
    (s.targetDuration != null && s.targetDuration > 0) ? s.targetDuration : null
  );
  const anyTimed = durations.some(d => d != null);

  // Early busy check — don't run 60s of work then fail
  if (isMainJobBusy()) {
    logConsole('[STITCH]: blocked — a job is already running. Use Stop first, or wait.', 'error');
    if (elements.statusText) elements.statusText.textContent = 'Busy — stop current job first';
    const _btnBusy = document.getElementById('btnPoolStitch');
    if (_btnBusy) { _btnBusy.disabled = state.pool.sequence.length < 2; _btnBusy.innerHTML = _btnBusy.dataset.label || 'Stitch Sequence'; }
    return;
  }

  // Show recover step if it has work — was hidden behind the 60s stall
  const _needsRecover = (state.pool.sequence || []).some(s => s.variantPath && s.variantPath !== s.path);
  if (_needsRecover) logConsole(`[STITCH]: checking ${_clickN} variant links…`);
  const _tRec = Date.now();
  try { await recoverSequenceVariants(); } catch (_) { /* targeted recover only */ }
  if (_needsRecover) logConsole(`[STITCH]: variant check done in ${((Date.now() - _tRec)/1000).toFixed(1)}s`);

  const conformOn = !!document.getElementById('poolConform')?.checked
    || !!state.pool.conformEnabled;
  const body = {
    input_paths: paths.map((p, i) => {
      const entry = state.pool.sequence[i];
      if (entry && entry.variantPath && entry.variantPath !== entry.path) return entry.variantPath;
      const globalVariant = (state.pool.selectedVariantPaths || {})[p];
      if (globalVariant) return globalVariant;
      return p;
    }),
    mode,
    aspect,
    durations: anyTimed ? durations : null,
    target: state.pool.target || null,
    // RIFE is an import-time per-clip step: input_paths already carry the
    // `_rifed` variants (see recoverSequenceVariants / selectedVariantPaths).
    // The stitch just muxes those fixed-fps clips — never re-RIFE at join.
    use_rife: false,
    target_fps: null,
    audio_engine: state.pool.audioEngine || 'rubberband',
    conform_enabled: conformOn,
    conform_mode: document.getElementById('poolConformMode')?.value || state.pool.conformMode || mode,
    conform_aspect: aspect,
    conform_preset: document.getElementById('poolConformPreset')?.value || state.pool.conformPreset || 'h264_avc_hq',
    conform_target_fps: (() => {
      const v = parseFloat(document.getElementById('poolConformFps')?.value || '');
      return v > 0 ? v : (state.pool.conformTargetFps || null);
    })(),
    conform_audio_policy: 'encoded',
    output_path,
    dry_run: false,
  };

  // (busy already checked before variant recover — this catches race)
  if (isMainJobBusy()) {
    logConsole('[STITCH]: blocked — a job is already running. Use Stop first, or wait.', 'error');
    if (elements.statusText) elements.statusText.textContent = 'Busy — stop current job first';
    const _btnRace = document.getElementById('btnPoolStitch');
    if (_btnRace) { _btnRace.disabled = state.pool.sequence.length < 2; _btnRace.innerHTML = _btnRace.dataset.label || 'Stitch Sequence'; }
    return;
  }

  const btn = document.getElementById('btnPoolStitch');
  if (btn) {
    // already set to Stitching… on click — keep it, just ensure enabled state
    btn.disabled = true;
    if (!btn.dataset.label) btn.dataset.label = btn.innerHTML;
    btn.innerHTML = 'Stitching…';
  }

  logConsole(`[STITCH]: POST /ops/join (main job + Stop)\n${JSON.stringify(body, null, 2)}`);

  try {
    // Same busy Run/Stop path as Instant RIFE and tab Run
    const data = await runOpWithCancel('join', body, {
      label: `Stitch ${paths.length} clips`,
    });
    // displayOpResult already called inside runOpWithCancel

    if (data && data.ok && data.output_path) {
      // Adopt conformed siblings onto their sequence entries (spec §6):
      // the server returns them aligned with body.input_paths.
      try {
        const cps = (data.meta && data.meta.conformed_paths) || null;
        const sigs = (data.meta && data.meta.conformed_signatures) || null;
        if (Array.isArray(cps) && cps.length === body.input_paths.length) {
          body.input_paths.forEach((usedPath, i) => {
            const entry = state.pool.sequence.find((e) => {
              if (e.path === usedPath) return true;
              if (e.variantPath && e.variantPath === usedPath) return true;
              const gv = (state.pool.selectedVariantPaths || {})[e.path];
              return gv && gv === usedPath;
            });
            if (entry && cps[i]) {
              entry.conformedPath = cps[i];
              entry.conformSignature = (sigs && sigs[i]) || entry.conformSignature || null;
              entry.conformStatus = 'valid';
            }
          });
          // Persist promptly (not on the autosave timer): the named-project
            // save/load contract requires conformed paths to survive.
            try { savePoolStateNow(); } catch (_) { scheduleSavePoolState(); }
            import('/js/pool/sequence.js').then((m) => {
              try { m.renderSequenceBox({ skipInstantKick: true }); } catch (_) {}
              try { m.updateStitchButton(); } catch (_) {}
            }).catch(() => {});
            const n = cps.filter(Boolean).length;
            if (n) logConsole(`[STITCH]: Adopted ${n} conformed sibling(s) onto sequence entries`);
        }
      } catch (_) { /* adopt is best-effort */ }
      addPathsToPool([data.output_path]);
      if (state.activeTab === 'pool') {
        renderPoolGrid();
        refreshPoolToolbarCounts();
      }
      logConsole(`[STITCH]: Output added to pool → ${data.output_path}`);
      if (data.meta && data.meta.stitch_mode) {
        logConsole(`[STITCH]: mode=${data.meta.stitch_mode} — ${data.meta.copy_reason || ''}`);
      }
    } else if (data && data.error === 'Cancelled by user') {
      logConsole('[STITCH]: stopped by user', 'error');
    }
  } catch (err) {
    elements.statusDot.className = 'status-dot error';
    elements.statusText.textContent = 'Stitch failed';
    logConsole(`[STITCH FAILED]: ${err.message}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = state.pool.sequence.length < 2;
      btn.innerHTML = btn.dataset.label || 'Stitch Sequence';
    }
    await checkHealth();
  }
}

/** False when the record already paid for a failed extract — do not GET 404. */
function itemShowsThumb(item, which) {
  const w = which || 'first';
  if (!item) return false;
  if (item.thumbsFailed && item.thumbsFailed[w]) return false;
  if (w === 'wall') {
    return !!(item.hash || item.path);
  }
  if (!item.hash) return false;
  if (item.thumbs && item.thumbs[w] === false) return false;
  return true;
}

function wallPreviewWhich() {
  return (state.settings && state.settings.wallStyle === 'first') ? 'wall' : 'wall_pair';
}

function poolThumbUrl(item, which) {
  const w = which || 'first';
  if (w === 'wall' || w === 'wall_pair') {
    const kind = w === 'wall_pair' ? 'wall_pair' : wallPreviewWhich();
    const rev = item && item.thumb_rev && (item.thumb_rev[kind] || item.thumb_rev.wall);
    const version = rev != null ? rev : 1;
    if (item.hash) {
      return `/api/thumbnail?hash=${encodeURIComponent(item.hash)}&which=${kind}&v=${version}`;
    }
    return `/api/thumbnail?path=${encodeURIComponent(item.path)}&which=${kind}&v=${version}`;
  }
  const size = String(state.settings?.thumbnailSize || 'H').toUpperCase();
  const rev = item && item.thumb_rev && item.thumb_rev[w];
  const version = rev != null ? rev : 3;
  // Prefer content-hash once known — permanent cache key independent of path
  if (item.hash) {
    return `/api/thumbnail?hash=${encodeURIComponent(item.hash)}&which=${w}&s=${encodeURIComponent(size)}&v=${version}`;
  }
  return `/api/thumbnail?path=${encodeURIComponent(item.path)}&which=${w}&s=${encodeURIComponent(size)}&v=${version}`;
}

function shortHash(h) {
  if (!h) return '—';
  return h.length > 12 ? `${h.slice(0, 8)}…${h.slice(-4)}` : h;
}

function buildPoolMetaHtml(item) {
  const info = ensureTileInfo();
  const m = item.meta || {};
  const name = item.name || basename(item.path);
  const path = item.path || '';
  const hash = item.hash || m.hash || '';
  const dur = m.duration != null ? formatDurationExact(m.duration) : '—';
  const fps = m.fps != null && m.fps > 0 ? `${m.fps} fps` : '—';
  const frames = m.frames != null ? `${m.frames} frames` : '—';
  const vcodec = m.video_codec || '—';
  const acodec = m.audio_codec || '—';
  const size = m.size != null ? formatBytes(m.size) : (item.size != null ? formatBytes(item.size) : '—');
  const dims = m.width && m.height ? `${m.width}×${m.height}` : '';
  const histN = m.history_count != null ? m.history_count : (item.history_count || 0);
  const opens = m.open_count != null ? m.open_count : (item.open_count || 0);
  const cacheTag = m.cached === true ? 'hit' : (m.cached === false ? 'new' : '');

  const parts = [];
  if (info.name) {
    parts.push(`<div class="pool-meta-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>`);
  }
  if (info.path) {
    parts.push(`<div class="pool-meta-path" title="${escapeHtml(path)}">${escapeHtml(path)}</div>`);
  }

  const row1 = [];
  if (info.hash && hash) {
    row1.push(`<span class="pool-hash" title="${escapeHtml(hash)}">#${escapeHtml(shortHash(hash))}${cacheTag ? ` · ${cacheTag}` : ''}</span>`);
  } else if (info.hash && !hash) {
    row1.push(`<span class="pool-hash">#—</span>`);
  }
  if (info.opens) {
    row1.push(`<span title="times opened / history events">${opens} open · ${histN} hist</span>`);
  }
  if (row1.length) parts.push(`<div class="pool-meta-row">${row1.join('')}</div>`);

  const row2 = [];
  if (info.duration) row2.push(`<span>${dur}</span>`);
  if (info.fps) row2.push(`<span>${fps}</span>`);
  if (info.frames) row2.push(`<span>${frames}</span>`);
  if (row2.length) parts.push(`<div class="pool-meta-row">${row2.join('')}</div>`);

  const row3 = [];
  if (info.video_codec) row3.push(`<span>v:${escapeHtml(vcodec)}</span>`);
  if (info.audio_codec) row3.push(`<span>a:${escapeHtml(acodec)}</span>`);
  if (info.size) row3.push(`<span>${size}</span>`);
  if (info.dims && dims) row3.push(`<span>${dims}</span>`);
  if (row3.length) parts.push(`<div class="pool-meta-row">${row3.join('')}</div>`);

  return parts.join('');
}


// Avoid import cycles with settings.js: expose a global callback and listen
// for the fallback CustomEvent the spec requires.
window.scheduleSavePoolState = scheduleSavePoolState;
window.addEventListener('mtapi.saveSettings', () => {
  try { scheduleSavePoolState(); } catch (_) { /* ignore */ }
});
window.addEventListener('mtapi.settingsChanged', () => {
  import('/js/pool/freshness.js')
    .then((m) => m.refreshAssignedPoolThumbs())
    .catch(() => {});
});

export {
  _poolSeqId, _poolSaveTimer, _poolPersistReady,
  nextSeqId,
  captureCurrentFormState, captureAllMountedFormState, applySavedFormState, buildDeskSnapshot, applyDeskSnapshot,
  scheduleSavePoolState, buildPoolStatePayload,
  projectLabel, markProjectDirty, updateProjectNameUI,
  applyPoolData, projectNew, projectOpen, projectSave,
  savePoolStateNow, restorePoolState,
  refreshPoolToolbarCounts, ensureVideoOutputPath,
  stitchPoolSequence,
  poolThumbUrl, wallPreviewWhich, itemShowsThumb, shortHash, buildPoolMetaHtml,
  isApplyingFormState, serializePoolItem, hydratePoolItem, migratePoolPayload,
};
