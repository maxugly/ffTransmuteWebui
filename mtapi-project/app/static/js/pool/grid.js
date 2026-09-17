// Pool grid rendering + dock layout — extracted from app.js
import { basename, escapeHtml, formatDurationExact } from '/js/utils.js';
import { POOL_ZOOM, TILE_INFO_FIELDS } from '/js/pool/constants.js';
import {
  ensurePoolLayout, applyPoolLayout, togglePoolSection, expandMatchesRoom,
  setupPoolLayoutChrome, bindPoolDragResize,
} from '/js/pool/layout.js';
import {
  projectNew, projectOpen, projectSave, savePoolStateNow,
  scheduleSavePoolState, stitchPoolSequence, refreshPoolToolbarCounts,
  projectLabel, shortHash, buildPoolMetaHtml, isApplyingFormState,
} from '/js/pool/persistence.js';
import {
  findPoolItem, displayFocusPath, setPoolHover, clearPoolHover,
  setPoolFocus, updateSelectionHighlights, updatePoolFocusFrame,
  setupSequenceDropZone, addPathToSequence, clearSequence,
  renderSequenceBox, updateSeqTransportUI, findSelectedSeqIndex,
  moveSelectedInSequence, removeSequenceAt, updateSeqClipSettings,
  onSeqClipDurationChange, applySeqTokenTimeStyles,
  seqPlay, seqPause, seqStop, seqPrev, seqNext,
  _maybeAutoRifeAll, setSeqTokenSize, applySeqTokenSize,
} from '/js/pool/sequence.js';
import { openTagPicker } from '/js/pool/sequence-tag.js';
import {
  selectPoolItem, removePoolItem, clearPool,
  addPathsToPool, importPoolFiles, importPoolFolder,
  sendPoolPathTo, applyPoolAsInput, scrollToSelected,
} from '/js/pool/items.js';
import { quickTransmuteLabel } from '/js/tabs/quick.js';
import {
  state, elements,
  ensureTileInfo,
  logConsole, formatBytes, showPreview,
  setPoolZoom, applyPoolZoom,
  setupTileInfoMenu, showPoolContextMenu,
} from '/app.js';
import { clearPending as lazyClearPending } from '/js/lazy-loader.js';
import { metaRetryHtml } from '/js/pool/freshness.js';
import { globalMediaIndex } from '/js/media-index.js';
import {
  beginRender, endRender, markFirstWindowReady, markHydrated,
  repairItem,
} from '/js/repair-queue.js';
import { installPoolScrollPaint } from '/js/pool/layout.js';
import { createVirtualGrid } from '/js/pool/virtual-grid.js';
import { prepareWallTenants, attachWallTenant, detachWallTenant } from '/js/pool/wall-thumbs.js';
import { ensureTabRoot } from '/js/pool/tab-roots.js';

let _statusTimer = null;
let _poolVirtualGrid = null;
let _poolVirtualCanvas = null;

function ensureSelectedPaths() {
  if (!(state.pool.selectedPaths instanceof Set)) {
    const seed = Array.isArray(state.pool.selectedPaths)
      ? state.pool.selectedPaths
      : (state.pool.selectedPath ? [state.pool.selectedPath] : []);
    state.pool.selectedPaths = new Set(seed.filter(Boolean));
  }
  if (state.pool.selectedPath) state.pool.selectedPaths.add(state.pool.selectedPath);
  return state.pool.selectedPaths;
}

function metadataUnavailableHtml() {
  return `<span class="pool-meta-unavailable">metadata unavailable</span>`
    + `<button type="button" class="btn pool-info-mini pool-retry-meta">Repair Metadata</button>`;
}

function videoCardMetaHtml(item) {
  if (item?.meta) return buildPoolMetaHtml(item);
  if (item?.metaError) return metaRetryHtml(item.metaError);
  const st = (() => {
    try { return globalMediaIndex.get(item)?.metadata_state?.status; } catch (_) { return ''; }
  })();
  if (st === 'queued' || st === 'repairing') {
    return `<span class="pool-meta-loading">reading metadata…</span>`;
  }
  return metadataUnavailableHtml();
}

function paintVideoCard(card, item) {
  if (!card || !item) return;
  try { globalMediaIndex.put(item); } catch (_) { /* ignore */ }
  const el = card.querySelector('.pool-overlay-text');
  if (el) el.innerHTML = videoCardMetaHtml(item);
}

// ── Join / Sequence helpers ─────────────────────────────────────────────────

let JOIN_PRESETS = null;
async function fillJoinTargetOptions() {
  const sel = document.getElementById('poolTarget');
  if (!sel || sel.dataset.filled) return;
  if (!JOIN_PRESETS) {
    try { JOIN_PRESETS = await (await fetch('/api/presets')).json(); }
    catch { JOIN_PRESETS = {}; }
  }
  const groups = {};
  for (const [pid, ep] of Object.entries(JOIN_PRESETS)) {
    (groups[ep.group] ||= []).push(`<option value="${pid}" title="${(ep.blurb||'').replace(/"/g,'&quot;')}">${ep.label}</option>`);
  }
  sel.innerHTML = '<option value="">Legacy H.264 (default)</option>' +
    Object.entries(groups).map(([g, opts]) => `<optgroup label="${g}">${opts.join('')}</optgroup>`).join('');
  sel.dataset.filled = '1';
  sel.value = state.pool.target || '';
}

async function _variantNodeHtml(path) {
  // Local cache / persisted map only — never GET /api/variants per card paint.
  let variants = {};
  try {
    const { peekVariants } = await import('/js/pool/sequence.js');
    const local = typeof peekVariants === 'function' ? peekVariants(path) : null;
    variants = local || {};
  } catch {
    variants = {};
  }
  const kinds = Object.keys(variants);
  if (!kinds.length) return '';
  const rows = kinds.map(kind => variants[kind].map(v => `
    <div class="variant-row${v.path && state.pool.selectedVariantPaths?.[path] === v.path ? ' selected' : ''}"
         data-variant-path="${v.path || ''}" data-variant-kind="${kind}">
      <span class="variant-kind">${kind}</span>
      ${v.detail ? `<span class="variant-detail">${Object.entries(v.detail).map(([k,val])=>`${k}=${val}`).join(' · ')}</span>` : ''}
    </div>`).join('')).join('');
  return `<div class="variant-node"><span class="variant-head">Variants</span>${rows}</div>`;
}

// ─── Video Pool ───────────────────────────────────────────────────────────

// Pool toolbar carries the sequence tools (single instance, no dup ids).
// They belong to the sequence view; keep them hidden on the pool tab so its
// chrome is identical to the pre-stateful layout.
function syncSeqToolsVisibility() {
  const show = state.activeTab === 'sequence';
  for (const id of ['btnSeqClear', 'btnTogglePool']) {
    const el = document.getElementById(id);
    if (el) el.hidden = !show;
  }
}

function renderPoolForm() {
  // Stateful tab: pool owns toolbar + grid inside its permanent root.
  // Fast path is root-scoped (a document-wide check would see the sequence
  // root's nodes and either skip a needed build or rebuild a live wall).
  const root = ensureTabRoot('pool') || elements.actionPanel;
  const existing = root.querySelector('#poolGrid');
  if (existing) {
    syncSeqToolsVisibility();
    applyPoolZoom();
    renderPoolGrid();
    updateSelectionHighlights();
    updateCatalogStatus();
    return;
  }

  const count = state.pool.items.length;
  const selected = state.pool.selectedPath;
  const seqCount = state.pool.sequence?.length || 0;

  const html = `
    <div class="pool-workspace-inner">
      <div class="pool-top">
        ${_poolToolbarHtml(count, selected, seqCount, { showSeqTools: true })}
          <div class="pool-grid-wrap" id="poolGridWrap">
            <div class="pool-grid pool-scroll-canvas" id="poolGrid" tabindex="0"></div>
          </div>
      </div>
    </div>
  `;

  root.innerHTML = html;
  (elements.actionPanelRoot || elements.actionPanel).classList.add('pool-active');

  _bindPoolToolbar(root);
  zoomBindings(root);
  _bindTileInfoMenu();
  installPoolScrollPaint();
  syncSeqToolsVisibility();

  applyPoolZoom();
  renderPoolGrid();
  updateSelectionHighlights();
  updateCatalogStatus();
}

/**
 * @param {number} count
 * @param {string|null} selected
 * @param {number} [seqCount]
 * @param {{ showSeqTools?: boolean }} [opts]  Sequence tab: Clear Sequence + Hide Pool
 */
function _poolToolbarHtml(count, selected, seqCount, opts) {
  opts = opts || {};
  const showSeqTools = opts.showSeqTools === true || (opts.showSeqTools == null && seqCount != null);
  // Always treat missing as 0 so the Clear Sequence button can still appear on Sequence tab
  if (seqCount == null) seqCount = state.pool.sequence?.length || 0;
  const projectLabelVal = projectLabel();
  const q = state.pool.filterQuery || '';
  return `
    <div class="pool-toolbar">
      <div class="pool-toolbar-actions">
        <div class="pool-project-group">
          <button type="button" class="btn" id="btnProjectNew" title="New empty project">New</button>
          <button type="button" class="btn" id="btnProjectOpen" title="Open .ffproject.json">Open…</button>
          <button type="button" class="btn btn-primary" id="btnProjectSave" title="Save project">Save</button>
          <button type="button" class="btn" id="btnProjectSaveAs" title="Save project as…">Save As…</button>
          <span class="pool-project-name" id="poolProjectName" title="${escapeHtml(state.project.path || '')}">${escapeHtml(projectLabelVal)}</span>
        </div>

        <input type="search" class="pool-filter-input" id="poolFilterInput"
          placeholder="Filter video pool…" value="${escapeHtml(q)}"
          title="Filter by name, path, codec, hash…"
          autocomplete="off" spellcheck="false">
        <label class="pool-search-mode" title="Strict uses a precomputed search string. Fuzzy keeps subsequence matching.">
          Search
          <select id="poolSearchMode" class="pool-search-mode-select">
            <option value="fuzzy" ${(state.pool.searchMode || 'fuzzy') !== 'strict' ? 'selected' : ''}>Fuzzy</option>
            <option value="strict" ${state.pool.searchMode === 'strict' ? 'selected' : ''}>Strict</option>
          </select>
        </label>

        <button class="btn btn-primary" id="btnPoolImportFiles" type="button">+ Files</button>
        <button class="btn" id="btnPoolImportFolder" type="button">+ Folder</button>
        <label class="pool-recursive-toggle" title="Also scan subdirectories">
          <input type="checkbox" id="poolRecursiveScan"> Subfolders
        </label>
        <button class="btn" id="btnPoolClear" type="button" ${count === 0 ? 'disabled' : ''}>Clear Video Pool</button>
        ${showSeqTools ? `<button class="btn" id="btnSeqClear" type="button" ${seqCount === 0 ? 'disabled' : ''} title="Remove all clips from the stitch sequence">Clear Sequence</button>` : ''}
        ${showSeqTools ? `<button class="btn pool-toggle-btn" id="btnTogglePool" type="button" title="Show / hide clip grid">${_poolToggleLabel()}</button>` : ''}

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
        <span class="pool-count">${count} in video pool${showSeqTools ? ' · ' + seqCount + ' in sequence' : ''}</span>
        <div class="catalog-status" id="catalogStatus" aria-live="polite"></div>
        <button type="button" class="btn pool-info-mini" id="btnRepairMetadata" title="Queue missing hash, metadata, and thumbnails">Repair Metadata</button>
        <div class="pool-use-wrap" ${selected ? '' : 'hidden'}>
          <label for="poolUseTarget" class="pool-use-label">Use as input</label>
          <select id="poolUseTarget" class="pool-use-select">
            <option value="">— target —</option>
            <option value="sequence">Add to sequence</option>
            <option value="cut">Cut (global video + range)</option>
            <option value="mosh">Datamosh input</option>
            <option value="transmute">Transmute input</option>
            <option value="multi">Add to Multi clips</option>
            <option value="advanced">Advanced input</option>
          </select>
          <button class="btn btn-primary" id="btnPoolUse" type="button">Apply</button>
        </div>
        <button class="btn pool-jump-btn" id="btnJumpSelected" type="button" title="Jump to selected clip in grid" ${selected ? '' : 'hidden'}>!</button>
      </div>
    </div>`;
}

function _poolToggleLabel() {
  const L = ensurePoolLayout();
  return L.collapsed.pool ? '\u25C9 Show Pool' : '\u25C7 Hide Pool';
}

function _bindPoolToolbar(root) {
  // Root-scoped: btnProject* ids also exist in the image pool toolbar, so a
  // document-wide lookup could bind the wrong (first-mounted) root's buttons
  // and leave this root's buttons dead (§5 needs-guard disposition).
  const $ = (id) => (root || document).querySelector(`#${id}`);
  $('btnProjectNew')?.addEventListener('click', projectNew);
  $('btnProjectOpen')?.addEventListener('click', projectOpen);
  $('btnProjectSave')?.addEventListener('click', () => projectSave(false));
  $('btnProjectSaveAs')?.addEventListener('click', () => projectSave(true));

  $('btnPoolImportFiles')?.addEventListener('click', importPoolFiles);
  $('btnPoolImportFolder')?.addEventListener('click', importPoolFolder);
  $('btnPoolClear')?.addEventListener('click', clearPool);
  // Bind via wrapper so circular-import undefined never silently no-ops the click
  const seqClearBtn = $('btnSeqClear');
  if (seqClearBtn) {
    seqClearBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        clearSequence({ confirm: true });
      } catch (err) {
        console.error('[SEQ] Clear Sequence failed', err);
        logConsole(`[SEQ]: Clear failed — ${err.message}`, 'error');
      }
    });
  }
  $('btnTogglePool')?.addEventListener('click', () => togglePoolSection('pool'));
  $('btnPoolUse')?.addEventListener('click', applyPoolAsInput);
  $('btnJumpSelected')?.addEventListener('click', scrollToSelected);

  const filterEl = $('poolFilterInput');
  if (filterEl) {
    filterEl.value = state.pool.filterQuery || '';
    filterEl.addEventListener('input', () => {
      state.pool.filterQuery = filterEl.value;
      renderPoolGrid();
      _updatePoolFilterCount();
    });
    filterEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        filterEl.value = '';
        state.pool.filterQuery = '';
        renderPoolGrid();
        _updatePoolFilterCount();
        e.preventDefault();
      }
    });
  }

  const modeEl = $('poolSearchMode');
  if (modeEl) {
    modeEl.value = state.pool.searchMode === 'strict' ? 'strict' : 'fuzzy';
    modeEl.addEventListener('change', () => {
      state.pool.searchMode = modeEl.value === 'strict' ? 'strict' : 'fuzzy';
      renderPoolGrid();
      _updatePoolFilterCount();
      scheduleSavePoolState();
    });
  }

  $('btnRepairMetadata')?.addEventListener('click', () => {
    for (const it of state.pool.items || []) repairItem(it, { force: false });
    updateCatalogStatus();
  });
}

/** Substring or simple subsequence fuzzy match (case-insensitive). */
function fuzzyMatch(query, text) {
  if (!query) return true;
  const q = String(query).toLowerCase().trim();
  if (!q) return true;
  const t = String(text || '').toLowerCase();
  if (!t) return false;
  if (t.includes(q)) return true;
  // space-separated tokens: all must match somewhere
  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length > 1) {
    return tokens.every((tok) => t.includes(tok) || _fuzzySubseq(tok, t));
  }
  return _fuzzySubseq(q, t);
}

function _fuzzySubseq(q, t) {
  let qi = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) qi++;
  }
  return qi === q.length;
}

function poolItemSearchText(item) {
  const m = item.meta || {};
  return [
    item.name,
    item.path,
    item.hash,
    m.hash,
    m.video_codec,
    m.audio_codec,
    m.width && m.height ? `${m.width}x${m.height}` : '',
    m.fps != null ? String(m.fps) : '',
  ].filter(Boolean).join(' ');
}

function filteredPoolItems() {
  const q = String(state.pool.filterQuery || '').trim();
  const items = state.pool.items || [];
  if (!q) return items.slice();
  const mode = state.pool.searchMode === 'strict' ? 'strict' : 'fuzzy';
  if (mode === 'strict') {
    const needle = q.toLowerCase();
    return items.filter((it) => {
      if (!it._searchString) {
        try { globalMediaIndex.refreshSearchString(it); } catch (_) { /* ignore */ }
      }
      return String(it._searchString || poolItemSearchText(it).toLowerCase()).includes(needle);
    });
  }
  return items.filter((it) => fuzzyMatch(q, poolItemSearchText(it)));
}

function _updatePoolFilterCount() {
  const el = document.querySelector('.pool-count');
  if (!el) return;
  const total = state.pool.items.length;
  const shown = filteredPoolItems().length;
  const seqCount = state.pool.sequence?.length;
  const seqClearBtn = document.getElementById('btnSeqClear');
  const seqBox = document.getElementById('poolSequenceBox');
  // Hidden/detached sequence roots must not flip the pool tab's count line.
  const hasSeq = (seqClearBtn && !seqClearBtn.hidden && !seqClearBtn.closest('.tab-root[hidden]'))
    || (seqBox && !seqBox.closest('.tab-root[hidden]'));
  const q = (state.pool.filterQuery || '').trim();
  let text = q
    ? `${shown} shown · ${total} in video pool`
    : `${total} in video pool`;
  if (hasSeq) text += ` · ${seqCount || 0} in sequence`;
  el.textContent = text;
}

function _bindTileInfoMenu() {
  setupTileInfoMenu();
}

function zoomBindings(root) {
  const $ = (id) => (root || document).querySelector(`#${id}`);
  $('btnZoomMin')?.addEventListener('click', () => setPoolZoom(POOL_ZOOM.min));
  $('btnZoomOut')?.addEventListener('click', () => setPoolZoom(state.pool.tileZoom - POOL_ZOOM.step));
  $('btnZoomReset')?.addEventListener('click', () => setPoolZoom(POOL_ZOOM.reset));
  $('btnZoomIn')?.addEventListener('click', () => setPoolZoom(state.pool.tileZoom + POOL_ZOOM.step));
  $('btnZoomMax')?.addEventListener('click', () => setPoolZoom(POOL_ZOOM.max));
}

function _bindSequencePanel() {
  document.getElementById('btnPoolStitch')?.addEventListener('click', stitchPoolSequence);
  import('/js/pool/sequence-erase.js?v=2').then((m) => {
    try { m.initSequenceErase(); } catch (_) { /* erase panel optional */ }
  }).catch(() => {});
  document.getElementById('btnPoolOutBrowse')?.addEventListener('click', () => {
    window.openFileBrowser('poolOutput', false, 'file_save');
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

  document.getElementById('poolTarget')?.addEventListener('change', (e) => {
    state.pool.target = e.target.value || null;
    scheduleSavePoolState();
  });
  document.getElementById('poolUseRife')?.addEventListener('change', (e) => {
    state.pool.useRife = e.target.checked;
    scheduleSavePoolState();
    renderSequenceBox({ skipInstantKick: true });
  });
  document.getElementById('poolInstantRife')?.addEventListener('change', (e) => {
    state.pool.instantRife = e.target.checked;
    // Tab-switch form restore replays saved values as change events — setting
    // state is its job, but only a real gesture may start Instant work.
    if (isApplyingFormState()) return;
    // Instant implies RIFE interpolate — turn both on together
    if (e.target.checked) {
      state.pool.useRife = true;
      const ur = document.getElementById('poolUseRife');
      if (ur) ur.checked = true;
      // Clear prior FAIL so a fresh Instant ON can re-queue (no tight auto-retry)
      for (const ent of state.pool.sequence || []) {
        if (ent._rifeStatus === 'failed') {
          ent._rifeStatus = null;
          ent._rifeError = null;
        }
      }
    }
    scheduleSavePoolState();
    renderSequenceBox({ skipInstantKick: true });
    if (state.pool.instantRife) {
      // Probe + queue immediately — no re-touching Time
      _maybeAutoRifeAll({ quiet: false });
    }
  });
  document.getElementById('poolTargetFps')?.addEventListener('change', (e) => {
    const v = parseFloat(e.target.value);
    state.pool.targetFps = (v > 0) ? v : null;
    // Form restore replays the saved value — not a user edit, never a start.
    if (isApplyingFormState()) return;
    scheduleSavePoolState();
    if (state.pool.instantRife && state.pool.useRife) _maybeAutoRifeAll();
  });
  document.getElementById('poolTargetFps')?.addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    state.pool.targetFps = (v > 0) ? v : null;
    scheduleSavePoolState();
    renderSequenceBox();
  });
  document.getElementById('poolAudioEngine')?.addEventListener('change', (e) => {
    state.pool.audioEngine = e.target.value || 'rubberband';
    scheduleSavePoolState();
  });
  document.getElementById('poolConform')?.addEventListener('change', (e) => {
    state.pool.conformEnabled = e.target.checked;
    if (isApplyingFormState()) return;
    if (e.target.checked && !state.pool.conformMode) {
      state.pool.conformMode = state.pool.reconcile || 'pad';
      const m = document.getElementById('poolConformMode');
      if (m) m.value = state.pool.conformMode;
    }
    scheduleSavePoolState();
    renderSequenceBox({ skipInstantKick: true });
    import('/js/pool/sequence-conform.js').then((m) => {
      try { m.updateStitchButton(); } catch (_) {}
    }).catch(() => {});
  });
  document.getElementById('poolConformMode')?.addEventListener('change', (e) => {
    state.pool.conformMode = e.target.value || 'pad';
    if (isApplyingFormState()) return;
    scheduleSavePoolState();
    import('/js/pool/sequence-conform.js').then((m) => {
      try { m.invalidateConforms('mode changed'); } catch (_) {}
      try { m.updateStitchButton(); } catch (_) {}
    }).catch(() => {});
    renderSequenceBox({ skipInstantKick: true });
  });
  document.getElementById('poolConformPreset')?.addEventListener('change', (e) => {
    state.pool.conformPreset = e.target.value || 'h264_avc_hq';
    if (isApplyingFormState()) return;
    scheduleSavePoolState();
    import('/js/pool/sequence-conform.js').then((m) => {
      try { m.invalidateConforms('preset changed'); } catch (_) {}
      try { m.updateStitchButton(); } catch (_) {}
    }).catch(() => {});
    renderSequenceBox({ skipInstantKick: true });
  });
  document.getElementById('poolConformFps')?.addEventListener('change', (e) => {
    const v = parseFloat(e.target.value);
    state.pool.conformTargetFps = (v > 0) ? v : null;
    if (isApplyingFormState()) return;
    scheduleSavePoolState();
    import('/js/pool/sequence-conform.js').then((m) => {
      try { m.invalidateConforms('target fps changed'); } catch (_) {}
      try { m.updateStitchButton(); } catch (_) {}
    }).catch(() => {});
    renderSequenceBox({ skipInstantKick: true });
  });
  document.getElementById('poolAutoConform')?.addEventListener('change', (e) => {
    state.pool.autoConformAfterRife = e.target.checked;
    scheduleSavePoolState();
  });

  document.getElementById('matchDistance')?.addEventListener('input', (e) => {
    state.pool.matchMaxDistance = parseInt(e.target.value, 10) || 0;
    const val = document.getElementById('matchDistanceVal');
    if (val) val.textContent = String(state.pool.matchMaxDistance);
  });
  document.getElementById('matchMode')?.addEventListener('change', (e) => {
    state.pool.matchMode = e.target.value;
  });
  document.getElementById('btnFindNext')?.addEventListener('click', runPoolMatch);

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
  document.getElementById('btnSeqRemove')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const idx = findSelectedSeqIndex();
    if (idx >= 0) removeSequenceAt(idx);
  });
  document.getElementById('btnSeqClearDock')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      clearSequence({ confirm: true });
    } catch (err) {
      console.error('[SEQ] Clear Sequence (dock) failed', err);
      logConsole(`[SEQ]: Clear failed — ${err.message}`, 'error');
    }
  });

  // Sequence chip size (width / height levels)
  document.getElementById('btnSeqTokenWMinus')?.addEventListener('click', (e) => {
    e.stopPropagation();
    setSeqTokenSize('w', -1);
  });
  document.getElementById('btnSeqTokenWPlus')?.addEventListener('click', (e) => {
    e.stopPropagation();
    setSeqTokenSize('w', +1);
  });
  document.getElementById('btnSeqTokenHMinus')?.addEventListener('click', (e) => {
    e.stopPropagation();
    setSeqTokenSize('h', -1);
  });
  document.getElementById('btnSeqTokenHPlus')?.addEventListener('click', (e) => {
    e.stopPropagation();
    setSeqTokenSize('h', +1);
  });
  try { applySeqTokenSize(); } catch (_) { /* ignore */ }

  const durInput = document.getElementById('seqClipDuration');
  durInput?.addEventListener('change', onSeqClipDurationChange);
  durInput?.addEventListener('blur', onSeqClipDurationChange);
  // Typing is a preview only: the hint reflects the raw text, but the entry
  // is not touched (no save, no render, no RIFE kick) until the value is
  // committed via change / blur / Enter. Typing "20" must not start work
  // for the intermediate "2".
  durInput?.addEventListener('input', () => {
    const idx = findSelectedSeqIndex();
    if (idx < 0) return;
    const raw = durInput.value.trim();
    const v = parseFloat(raw);
    const entry = state.pool.sequence[idx];
    const meta = findPoolItem(entry.path)?.meta;
    const native = meta?.duration;
    const hint = document.getElementById('seqClipDurHint');
    if (hint) {
      if (Number.isFinite(v) && v > 0 && native > 0) {
        const factor = v / native;
        const pct = Math.round((native / v) * 100);
        hint.textContent = `native ${formatDurationExact(native)} → ${formatDurationExact(v)} (${pct}% speed ${factor >= 1 ? 'slower' : 'faster'})`;
      } else if (native > 0) {
        hint.textContent = `native ${formatDurationExact(native)} (no stretch)`;
      } else {
        hint.textContent = 'set target length to stretch in time';
      }
    }
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
    if (state.pool.instantRife && state.pool.useRife) _maybeAutoRifeAll({ quiet: true });
  });

  document.getElementById('seqTagBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const idx = findSelectedSeqIndex();
    if (idx < 0) return;
    const entry = state.pool.sequence[idx];
    if (!entry) return;
    openTagPicker(e.currentTarget, entry.id);
  });

  const useRifeEl = document.getElementById('poolUseRife');
  const instantRifeEl = document.getElementById('poolInstantRife');
  const targetFpsEl = document.getElementById('poolTargetFps');
  const audioEngineEl = document.getElementById('poolAudioEngine');
  if (useRifeEl) useRifeEl.checked = !!state.pool.useRife;
  if (instantRifeEl) instantRifeEl.checked = !!state.pool.instantRife;
  if (targetFpsEl) targetFpsEl.value = state.pool.targetFps || '';
  if (audioEngineEl) audioEngineEl.value = state.pool.audioEngine || 'rubberband';
  const conformEl = document.getElementById('poolConform');
  const conformModeEl = document.getElementById('poolConformMode');
  const conformPresetEl = document.getElementById('poolConformPreset');
  const conformFpsEl = document.getElementById('poolConformFps');
  const autoConformEl = document.getElementById('poolAutoConform');
  if (conformEl) conformEl.checked = !!state.pool.conformEnabled;
  if (conformModeEl) conformModeEl.value = state.pool.conformMode || state.pool.reconcile || 'pad';
  if (conformPresetEl) conformPresetEl.value = state.pool.conformPreset || 'h264_avc_hq';
  if (conformFpsEl) conformFpsEl.value = state.pool.conformTargetFps || '';
  if (autoConformEl) autoConformEl.checked = state.pool.autoConformAfterRife !== false;
  fillJoinTargetOptions();
  import('/js/pool/sequence-conform.js').then((m) => {
    try { m.updateStitchButton(); } catch (_) {}
  }).catch(() => {});
}

function _composeHtml() {
  const seqCount = state.pool.sequence.length;
  const rec = state.pool.reconcile || 'pad';
  const outVal = state.pool.outputPath || '';
  const L = ensurePoolLayout();
  const col = L.collapsed;

  return `
    <div class="pool-compose" id="poolCompose">
      <div class="pool-sequence-panel${col.sequence ? ' is-collapsed' : ''}" id="poolSequencePanel">
        <div class="pool-section-head" data-collapse="sequence">
          <button type="button" class="pool-collapse-btn" title="Collapse / expand sequence" aria-expanded="${!col.sequence}">
            <span class="pool-collapse-chevron">${col.sequence ? '▸' : '▾'}</span>
          </button>
          <span class="pool-section-title">Sequence</span>
          <span class="seq-total-time" id="seqTotalTime" hidden title="Sum of clip times (Time override if set, else native duration)"></span>
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
            <span class="seq-reorder-sep" aria-hidden="true"></span>
            <button type="button" class="btn seq-ctrl seq-remove" id="btnSeqRemove" title="Remove selected from sequence" disabled>&minus;</button>
            <span class="seq-reorder-sep" aria-hidden="true"></span>
            <button type="button" class="btn seq-ctrl seq-clear-all" id="btnSeqClearDock" title="Clear entire sequence" ${seqCount === 0 ? 'disabled' : ''}>Clear</button>
            <span class="seq-reorder-sep" aria-hidden="true"></span>
            <span class="seq-token-size" title="Sequence chip size" onclick="event.stopPropagation()">
              <span class="seq-size-label">W</span>
              <button type="button" class="btn seq-ctrl" id="btnSeqTokenWMinus" title="Narrower chips">−</button>
              <button type="button" class="btn seq-ctrl" id="btnSeqTokenWPlus" title="Wider chips">+</button>
              <span class="seq-size-label">H</span>
              <button type="button" class="btn seq-ctrl" id="btnSeqTokenHMinus" title="Shorter chips">−</button>
              <button type="button" class="btn seq-ctrl" id="btnSeqTokenHPlus" title="Taller chips">+</button>
            </span>
          </div>
        </div>
        <div class="pool-section-body" data-section="sequence">
          <div class="pool-sequence-box" id="poolSequenceBox" tabindex="0"
            data-seq-w="${state.pool.seqTokenW ?? 2}" data-seq-h="${state.pool.seqTokenH ?? 2}"></div>
          <div class="seq-clip-settings" id="seqClipSettings" hidden>
            <span class="seq-clip-settings-label">Selected clip</span>
            <span class="seq-clip-settings-name" id="seqClipName">—</span>
            <label class="pool-opt-label" title="Stretch or compress this clip to a target length in the stitch">Time (s)
              <input type="number" id="seqClipDuration" min="0.05" step="0.05" placeholder="native" class="seq-clip-dur-input">
            </label>
            <button type="button" class="btn pool-info-mini" id="btnSeqClipDurClear" title="Use original duration">Native</button>
            <span class="seq-clip-settings-hint" id="seqClipDurHint"></span>
            <label class="pool-opt-label" title="Revisit mark: per-chip color tag, independent of the Time stretch colors. The button itself shows the color.">Tag
              <button type="button" class="seq-tag-btn" id="seqTagBtn" title="Tag this clip — click to pick a revisit color"></button>
            </label>
            <span class="seq-clip-settings-hint" id="seqUseCount" title="How many sequence chips share this clip's source file"></span>
            <div class="seq-erase-box" id="seqEraseBox" hidden></div>
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
              <label class="pool-opt-label" title="Export codec (DNxHR / ProRes / H.264 / …)">Format
                <select id="poolTarget">
                  <option value="">Legacy H.264 (default)</option>
                  <!-- options injected by JS from /api/presets -->
                </select>
              </label>
              <label class="checkbox-label" title="Before stitch: densify clips whose content fps after time-stretch is below target (slow-mo needs RIFE)">
                <input type="checkbox" id="poolUseRife"> RIFE interpolate
              </label>
              <label class="checkbox-label" title="Queue RIFE for clips that need it. Uses main Run busy state + Stop (one encode at a time; long clips allowed).">
                <input type="checkbox" id="poolInstantRife"> Instant RIFE
              </label>
              <label class="pool-opt-label" title="Sequence content fps target. Empty = most common clip fps in sequence (ignores odd/slow-mo outliers). Slowed clips need denser frames to stay smooth at this rate.">RIFE fps
                <input type="number" id="poolTargetFps" min="1" step="1" placeholder="auto = common fps" class="seq-clip-dur-input">
              </label>
              <label class="pool-opt-label" title="Audio time-stretching engine for sequence join">Audio
                <select id="poolAudioEngine" class="pool-engine-select">
                  <option value="rubberband" ${(state.pool.audioEngine || 'rubberband') === 'rubberband' ? 'selected' : ''}>Rubberband (Pitch-Preserved)</option>
                  <option value="atempo" disabled>Standard (atempo) [Coming Soon]</option>
                  <option value="pitch" disabled>Pitch-Shift (Vinyl) [Coming Soon]</option>
                  <option value="mute" disabled>Mute [Coming Soon]</option>
                </select>
              </label>
              <label class="checkbox-label" title="Conform: normalize each clip to one canvas/preset before stitch (cache beside source; copy fast-path when all match). Off = current Stitch behavior.">
                <input type="checkbox" id="poolConform"> Conform
              </label>
              <label class="pool-opt-label" title="Conform geometry (default follows Fit)">C-mode
                <select id="poolConformMode">
                  <option value="pad" ${(state.pool.conformMode || 'pad') === 'pad' ? 'selected' : ''}>Pad</option>
                  <option value="crop" ${(state.pool.conformMode || 'pad') === 'crop' ? 'selected' : ''}>Crop</option>
                  <option value="stretch" ${(state.pool.conformMode || 'pad') === 'stretch' ? 'selected' : ''}>Stretch</option>
                </select>
              </label>
              <label class="pool-opt-label" title="Conform preset (copy needs output preset to match)">C-preset
                <select id="poolConformPreset">
                  <option value="h264_avc_hq" ${(state.pool.conformPreset || 'h264_avc_hq') === 'h264_avc_hq' ? 'selected' : ''}>H.264 HQ</option>
                  <option value="h265_hevc" ${state.pool.conformPreset === 'h265_hevc' ? 'selected' : ''}>H.265 HEVC</option>
                  <option value="dnxhr_hq" ${state.pool.conformPreset === 'dnxhr_hq' ? 'selected' : ''}>DNxHR HQ</option>
                  <option value="prores_hq" ${state.pool.conformPreset === 'prores_hq' ? 'selected' : ''}>ProRes HQ</option>
                </select>
              </label>
              <label class="pool-opt-label" title="Conform target fps (blank = keep native)">C-fps
                <input type="number" id="poolConformFps" min="1" step="1" placeholder="native" class="seq-clip-dur-input" value="${state.pool.conformTargetFps || ''}">
              </label>
              <label class="checkbox-label" title="Auto-conform after RIFE (follows Instant RIFE arming; no scan on open)">
                <input type="checkbox" id="poolAutoConform" ${state.pool.autoConformAfterRife !== false ? 'checked' : ''}> Auto↯RIFE
              </label>
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
            <button class="btn seq-ctrl" id="btnEraseRunAll" type="button" title="Erase → RIFE → Conform every masked Sequence lineage (deduped, originals untouched)">Erase▸Run</button>
            <button class="btn seq-ctrl" id="btnEraseClear" type="button" title="Clear erase pipeline progress/status states">Erase▸Clear</button>
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
            <button type="button" class="btn btn-primary pool-match-btn" id="btnFindNext" ${state.pool.selectedPath ? '' : 'disabled'} title="Compare selection frame to pool via pHash">
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
    </div>`;
}

function renderSequenceForm() {
  // Stateful tab: pool root owns toolbar + grid (built once, shared with the
  // pool tab); the sequence root owns only the resize handle + composer.
  // The sequence view shows both roots stacked, so no id exists twice.
  renderPoolForm();
  const root = ensureTabRoot('sequence') || elements.actionPanel;
  if (root.querySelector('#poolCompose')) {
    applyPoolZoom();
    renderPoolGrid();
    updateSelectionHighlights();
    updateCatalogStatus();
    return;
  }

  const L = ensurePoolLayout();
  const col = L.collapsed;

  const html = `
      <div class="pool-v-resize${col.pool ? ' is-collapsed' : ''}" id="poolVResize" title="Drag to resize dock"></div>

      ${_composeHtml()}
  `;

  root.innerHTML = html;
  (elements.actionPanelRoot || elements.actionPanel).classList.add('pool-active');

  _bindSequencePanel();
  // Pool-root chrome (_bindTileInfoMenu, zoomBindings) is bound once at pool
  // build; rebinding here would double-bind the shared toolbar buttons.

  setupSequenceDropZone();
  updateSeqClipSettings();
  setupPoolLayoutChrome();
  applyPoolZoom();
  renderPoolGrid();
  renderSequenceBox();
  updatePoolFocusFrame(displayFocusPath());
  updateSelectionHighlights();
  updateSeqTransportUI();
  refreshPoolToolbarCounts();
  updateCatalogStatus();
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

function _cardItem(card) {
  const path = card?.dataset?.path;
  return path ? findPoolItem(path) : null;
}

function ensurePoolCardSkeleton(card) {
  if (card.dataset.skel === '1') return;
  card.innerHTML = `
      <div class="pool-card-actions">
        <div class="pool-send-wrap">
          <button type="button" class="btn pool-send-btn" title="Send this clip to a tool">Send to ▾</button>
        </div>
        <button class="pool-card-remove" type="button" title="Remove from pool">✕</button>
      </div>
      <span class="pool-seq-indicator" hidden></span>
      <div class="pool-frames pool-wall">
        <div class="pool-frame"></div>
      </div>
      <div class="pool-overlay">
        <div class="pool-overlay-text"></div>
      </div>
      <button class="pool-card-info-btn" type="button" title="Clip info">ⓘ</button>
      <div class="pool-variants"></div>
    `;
  card.dataset.skel = '1';
}

function bindPoolCard(card) {
  if (card.dataset.eventsBound === '1') return;
  card.dataset.eventsBound = '1';
  card.addEventListener('click', (e) => {
    const retry = e.target.closest('.pool-retry-meta');
    if (retry) {
      e.preventDefault();
      e.stopPropagation();
      const live = findPoolItem(card.dataset.path);
      if (live) repairItem(live, { force: true });
      return;
    }
    if (e.target.closest('.pool-card-remove, .pool-send-wrap, .pool-card-info-btn, .variant-row')) return;
    const path = card.dataset.path;
    if (path) selectPoolItem(path, { shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey });
    document.getElementById('poolGrid')?.focus?.({ preventScroll: true });
  });
  card.addEventListener('mouseenter', () => {
    if (card.dataset.path) setPoolHover(card.dataset.path);
  });
  card.addEventListener('mouseleave', (e) => {
    const to = e.relatedTarget;
    if (to && (to.closest?.('.pool-card') || to.closest?.('.seq-token'))) return;
    clearPoolHover();
  });
  card.addEventListener('dragstart', (e) => {
    if (e.target.closest('.pool-send-wrap, .pool-card-remove')) {
      e.preventDefault();
      return;
    }
    const path = card.dataset.path;
    if (!path) return;
    e.dataTransfer.setData('application/x-pool-path', path);
    e.dataTransfer.setData('text/plain', path);
    e.dataTransfer.effectAllowed = 'copy';
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', () => card.classList.remove('dragging'));
  card.addEventListener('click', (e) => {
    const rm = e.target.closest('.pool-card-remove');
    if (!rm) return;
    e.stopPropagation();
    const path = card.dataset.path;
    const idx = state.pool.items.findIndex((i) => i.path === path);
    if (idx >= 0) removePoolItem(idx);
  });
  card.addEventListener('click', (e) => {
    const info = e.target.closest('.pool-card-info-btn');
    if (!info) return;
    e.stopPropagation();
    const item = _cardItem(card);
    if (item) showClipInfoOverlay(item);
  });
  card.addEventListener('click', (e) => {
    const sendBtn = e.target.closest('.pool-send-btn');
    if (!sendBtn) return;
    e.stopPropagation();
    e.preventDefault();
    const item = _cardItem(card);
    if (item) _openSendMenu(card, sendBtn, item);
  });
  card.addEventListener('mousedown', (e) => {
    if (e.target.closest('.pool-send-wrap')) e.stopPropagation();
  });
  card.addEventListener('dblclick', (e) => {
    if (e.target.closest('.pool-card-remove, .pool-send-wrap')) return;
    if (card.dataset.path) addPathToSequence(card.dataset.path);
  });
  card.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.pool-card-remove')) return;
    e.preventDefault();
    e.stopPropagation();
    const path = card.dataset.path;
    if (!path) return;
    selectPoolItem(path);
    showPoolContextMenu(e.clientX, e.clientY, path);
  });
  card.addEventListener('click', (e) => {
    const row = e.target.closest('.variant-row');
    if (!row) return;
    e.stopPropagation();
    const p = row.dataset.variantPath;
    const itemPath = card.dataset.path;
    if (!p || !itemPath) return;
    state.pool.selectedVariantPaths = state.pool.selectedVariantPaths || {};
    state.pool.selectedVariantPaths[itemPath] = p;
    scheduleSavePoolState();
    renderPoolGrid();
  });
}

function _applyCardVisuals(card, item, index) {
  const path = item.path;
  const selected = ensureSelectedPaths();
  const isSelected = selected.has(path) || state.pool.selectedPath === path;
  const isHovered = state.pool.hoverPath === path;
  const seqPos = sequencePositions(path);
  card.classList.toggle('selected', isSelected);
  card.classList.toggle('hovered', isHovered);
  card.classList.toggle('seq-active', seqPos.length > 0);
  card.dataset.path = path;
  if (item.hash) card.dataset.hash = item.hash;
  else delete card.dataset.hash;
  card.dataset.idx = String(index);
  card.draggable = true;
  card.title = 'Drag into sequence to stitch';

  const badge = card.querySelector('.pool-seq-indicator');
  if (badge) {
    if (seqPos.length) {
      badge.hidden = false;
      badge.textContent = seqPos.join(' ');
    } else {
      badge.hidden = true;
      badge.textContent = '';
    }
  }
}

function mountPoolCard(card, item, index) {
  resetPoolCard(card);
  ensurePoolCardSkeleton(card);
  bindPoolCard(card);
  _applyCardVisuals(card, item, index);
  paintVideoCard(card, item);
  attachWallTenant(card, item);
  const variantContainer = card.querySelector('.pool-variants');
  if (variantContainer && variantContainer.dataset.for !== item.path) {
    variantContainer.dataset.for = item.path;
    variantContainer.innerHTML = '';
    requestAnimationFrame(() => {
      if (card.dataset.path !== item.path) return;
      _variantNodeHtml(item.path).then((html) => {
        if (card.dataset.path !== item.path) return;
        variantContainer.innerHTML = html;
      });
    });
  }
}

function resetPoolCard(card) {
  if (!card) return;
  detachWallTenant(card);
  card.dataset.path = '';
  card.dataset.hash = '';
  card.dataset.idx = '';
  card.classList.remove('selected', 'hovered', 'seq-active', 'dragging', 'menu-open');
  const variants = card.querySelector('.pool-variants');
  if (variants) { variants.dataset.for = ''; variants.innerHTML = ''; }
}

function updatePoolCard(card, item, index) {
  refreshPoolCard(card, item, index);
}

function refreshPoolCard(card, item, index) {
  _applyCardVisuals(card, item, index);
  const metaEl = card.querySelector('.pool-overlay-text');
  if (metaEl) metaEl.innerHTML = videoCardMetaHtml(item);
  // Thumbs are assigned-once at mount; do NOT touch img.src here.
}

function _openSendMenu(card, sendBtn, item) {
  const existing = document.querySelector('.pool-send-menu-portal');
  if (existing) {
    if (existing._sourceCard === card) {
      existing.remove();
      card.classList.remove('menu-open');
      return;
    }
    existing._sourceCard?.classList.remove('menu-open');
    existing.remove();
  }

  card.classList.add('menu-open');
  const rect = sendBtn.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.className = 'pool-send-menu pool-send-menu-portal';
  menu._sourceCard = card;
  menu.style.position = 'fixed';
  menu.style.right = `${window.innerWidth - rect.right}px`;
  menu.style.zIndex = '99999';
  menu.innerHTML = `
        <button type="button" class="pool-send-item pool-send-quick" data-send="quick">${escapeHtml(quickTransmuteLabel())}</button>
        <div class="pool-send-sep"></div>
        <button type="button" class="pool-send-item" data-send="mosh">Datamosh</button>
        <button type="button" class="pool-send-item" data-send="deepdream">DeepDream</button>
        <button type="button" class="pool-send-item" data-send="rife">RIFE</button>
        <button type="button" class="pool-send-item" data-send="speedchange">Speed Change</button>
        <button type="button" class="pool-send-item" data-send="upscale">Upscale</button>
        <button type="button" class="pool-send-item" data-send="fastsam">FastSAM</button>
        <button type="button" class="pool-send-item" data-send="img2img">Img2Img</button>
        <button type="button" class="pool-send-item" data-send="agent">Agent</button>
        <button type="button" class="pool-send-item" data-send="convert">Convert / Export</button>
        <button type="button" class="pool-send-item" data-send="transmute">Transmute</button>
        <button type="button" class="pool-send-item" data-send="multi">Multi (Join/Grid)</button>
        <button type="button" class="pool-send-item" data-send="advanced">Raw CLI</button>
        <button type="button" class="pool-send-item" data-send="sequence">Sequence</button>
        <button type="button" class="pool-send-item" data-send="cut">Cut</button>
        <button type="button" class="pool-send-item" data-send="preview">Preview only</button>
        <div class="pool-send-sep"></div>
        <button type="button" class="pool-send-item" data-send="save_first_png">Save first frame PNG…</button>
        <button type="button" class="pool-send-item" data-send="save_last_png">Save last frame PNG…</button>
      `;
  document.body.appendChild(menu);
  const pad = 6;
  const menuRect = menu.getBoundingClientRect();
  let top = rect.bottom + 3;
  if (top + menuRect.height > window.innerHeight - pad) top = rect.top - menuRect.height - 3;
  if (top < pad) top = pad;
  menu.style.top = `${top}px`;

  menu.querySelectorAll('.pool-send-item').forEach((opt) => {
    opt.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      const target = opt.dataset.send;
      menu.remove();
      card.classList.remove('menu-open');
      sendPoolPathTo(item.path, target);
    });
  });
  const dismiss = (ev) => {
    if (!menu.contains(ev.target) && ev.target !== sendBtn) {
      menu.remove();
      card.classList.remove('menu-open');
      document.removeEventListener('click', dismiss, true);
    }
  };
  setTimeout(() => document.addEventListener('click', dismiss, true), 0);
}

function _bindGridKeyboard(wrap) {
  if (!wrap || wrap.dataset.keysBound) return;
  wrap.dataset.keysBound = '1';
  wrap.addEventListener('keydown', (e) => {
    if (!e.key || !e.key.startsWith('Arrow')) return;
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT')) return;
    const items = filteredPoolItems();
    if (!items.length) return;
    const grid = wrap.querySelector('.pool-grid');
    const rect = grid?.getBoundingClientRect();
    const colWidth = rect ? rect.width / Math.max(1, Math.floor(rect.width / (state.pool.tileZoom || 200))) : 200;
    const cols = Math.max(1, Math.floor((rect ? rect.width : 9999) / (state.pool.tileZoom || 200)));
    let idx = items.findIndex((it) => it.path === state.pool.selectedPath);
    if (idx < 0) idx = 0;
    let next = idx;
    if (e.key === 'ArrowRight') next = Math.min(items.length - 1, idx + 1);
    else if (e.key === 'ArrowLeft') next = Math.max(0, idx - 1);
    else if (e.key === 'ArrowDown') next = Math.min(items.length - 1, idx + cols);
    else if (e.key === 'ArrowUp') next = Math.max(0, idx - cols);
    else return;
    e.preventDefault();
    e.stopPropagation();
    selectPoolItem(items[next].path, { shiftKey: e.shiftKey });
    const card = Array.from(wrap.querySelectorAll('.pool-card')).find(c => c.dataset.path === items[next].path);
    if (card?.scrollIntoView) card.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
}

function updateCatalogStatus() {
  const el = document.getElementById('catalogStatus');
  if (!el) return;
  const counts = globalMediaIndex.catalogCounts(state.pool.items || []);
  const html = [
    `<span>Restored ${counts.restored}</span>`,
    `<span>Known metadata ${counts.knownMetadata}</span>`,
    `<span>Known thumbnails ${counts.knownThumbnails}</span>`,
    `<span>Missing ${counts.missing}</span>`,
    `<span>Queued ${counts.queued}</span>`,
    `<span>Repairing ${counts.repairing}</span>`,
    `<span>Failed ${counts.failed}</span>`,
  ].join(' · ');
  if (el.dataset.sig === html) return;
  el.dataset.sig = html;
  el.innerHTML = html;
}

function renderPoolGrid() {
  const canvas = document.getElementById('poolGrid');
  const wrap = canvas?.closest('.pool-grid-wrap') || document.getElementById('poolGridWrap');
  if (!canvas || !wrap) return;
  // Hidden-DOM rule (§6): background renders may write but never measure a
  // hidden/detached grid. Mark dirty; the show path re-renders and consumes it.
  const gridHidden = !wrap.isConnected || !!wrap.closest('.tab-root[hidden]');

  beginRender();
  try {
    // Empty: no items at all
    if (state.pool.items.length === 0) {
      _poolVirtualGrid?.destroy();
      _poolVirtualGrid = null;
      _poolVirtualCanvas = null;
      lazyClearPending();
      canvas.style.height = '';
      canvas.innerHTML = `
      <div class="pool-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
          <rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>
        </svg>
        <p>No videos in the pool.</p>
        <p class="pool-empty-hint">Import files/folder, then drag cards into the sequence strip.</p>
      </div>
      `;
      _updatePoolFilterCount();
      updateCatalogStatus();
      return;
    }

    const items = filteredPoolItems();
    if (items.length === 0) {
      _poolVirtualGrid?.destroy();
      _poolVirtualGrid = null;
      _poolVirtualCanvas = null;
      const q = escapeHtml(state.pool.filterQuery || '');
      canvas.style.height = '';
      canvas.innerHTML = `
      <div class="pool-empty">
        <p>No clips match <strong>${q}</strong>.</p>
        <p class="pool-empty-hint">Clear the filter (Esc) or try a shorter query.</p>
      </div>
      `;
      _updatePoolFilterCount();
      updateCatalogStatus();
      return;
    }

    const empty = canvas.querySelector('.pool-empty');
    if (empty) empty.remove();

    prepareWallTenants(items);

    if (gridHidden) {
      wrap.dataset.dirtyGrid = '1';
      _updatePoolFilterCount();
      updateCatalogStatus();
      return;
    }
    delete wrap.dataset.dirtyGrid;

    // Chrome only: visible window plus overscan. Image nodes are stable tenants.
    canvas.classList.add('pool-grid');
    if (!_poolVirtualGrid || _poolVirtualCanvas !== canvas) {
      _poolVirtualGrid?.destroy();
      _poolVirtualCanvas = canvas;
      _poolVirtualGrid = createVirtualGrid({
        wrap,
        canvas,
        getItems: () => filteredPoolItems(),
        renderCard: mountPoolCard,
        updateCard: updatePoolCard,
        recycleCard: resetPoolCard,
        bindCard: (card) => { card.classList.add('pool-card'); },
        placeholderCard: mountPoolCard,
        minColWidth: 200,
      });
      if (typeof window !== 'undefined') {
        window.__mtapiPoolVirtualGrid = _poolVirtualGrid;
        window.__mtapiPoolVirtualScrollTo = (path) => _poolVirtualGrid?.scrollToPath(path, { behavior: 'smooth', block: 'center' });
      }
    }
    _poolVirtualGrid.sync({ force: true });

    // Persist scroll
    if (!wrap.dataset.scrollPersist) {
      wrap.dataset.scrollPersist = '1';
      wrap.addEventListener('scroll', () => {
        state.pool.gridScrollTop = wrap.scrollTop;
      }, { passive: true });
    }

    _bindGridKeyboard(wrap);
    markFirstWindowReady();
    try { performance.mark('firstVisibleCard'); } catch (_) { /* ignore */ }
    _updatePoolFilterCount();
    updateCatalogStatus();
  } finally {
    endRender();
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('mtapi.catalogRepair', () => {
    if (_statusTimer) return;
    _statusTimer = setTimeout(() => {
      _statusTimer = null;
      try {
         updateCatalogStatus();
         renderPoolGrid();
         applySeqTokenTimeStyles();
        const path = displayFocusPath();
        const frame = document.getElementById('poolFocusFrame');
        if (frame) frame.dataset.focusPath = '';
        if (path) updatePoolFocusFrame(path);
      } catch (_) { /* ignore */ }
    }, 50);
  });
}

// ── Frame match (pHash next-clip finder) ──────────────────────────────────

async function runPoolMatch() {
  const path = state.pool.selectedPath || state.pool.focusPath;
  if (!path) {
    alert('Select a clip first (click a tile).');
    return;
  }
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

  if (matches.length >= 3 && L.matchHeight < 200) {
    L.matchHeight = 220;
    L.composeHeight = Math.max(L.composeHeight, 320);
    applyPoolLayout();
  }

  const qPath = data.query?.path || '';
  const header = `<div class="pool-match-summary">${matches.length} match${matches.length === 1 ? '' : 'es'} · mode ${escapeHtml(data.mode)} · ≤${data.max_distance}</div>`;

  const rows = matches.map((m, i) => {
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

  /**
   * Clicking a match must actually select that clip in the pool grid.
   * Failures that made this feel "dead":
   *  - fuzzy filter still on → card not in DOM → no highlight/scroll
   *  - pool panel collapsed on Sequence → card not visible
   *  - row click only soft-previewed without full select in some paths
   */
  async function selectMatchInPool(path) {
    if (!path) return;
    // Show the pool grid if user hid it on Sequence
    try {
      const L = ensurePoolLayout();
      if (L.collapsed.pool) {
        L.collapsed.pool = false;
        applyPoolLayout();
      }
    } catch (_) { /* ignore */ }
    // Drop filter so the target card is actually rendered
    if (state.pool.filterQuery) {
      state.pool.filterQuery = '';
      const filterEl = document.getElementById('poolFilter');
      if (filterEl) filterEl.value = '';
    }
    if (!findPoolItem(path)) {
      await addPathsToPool([path]);
    }
    // Full select (preview + focus + toolbar + sequence sync)
    selectPoolItem(path);
    // Rebuild grid so .selected lands on a real card, then scroll to it
    try {
      renderPoolGrid();
      _updatePoolFilterCount();
    } catch (_) { /* ignore */ }
    // Second pass: highlights + scroll after cards exist
    try {
      updateSelectionHighlights();
      const card = Array.from(document.querySelectorAll('.pool-card'))
        .find((c) => c.dataset.path === path);
      if (card?.scrollIntoView) {
        card.scrollIntoView({ block: 'center', behavior: 'smooth' });
        card.classList.add('selected');
      }
    } catch (_) { /* ignore */ }
    // Mark the match row as active for feedback in the matches list
    box.querySelectorAll('.pool-match-row').forEach((r) => {
      r.classList.toggle('is-selected', r.dataset.path === path);
    });
    logConsole(`[MATCH]: selected ${basename(path)}`);
  }

  box.querySelectorAll('.pool-match-row').forEach(row => {
    const path = row.dataset.path;
    row.querySelectorAll('[data-act]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const act = btn.dataset.act;
        if (act === 'select') {
          selectMatchInPool(path).catch(() => {});
        } else if (act === 'seq') {
          if (!findPoolItem(path)) await addPathsToPool([path]);
          await selectMatchInPool(path);
          addPathToSequence(path);
        } else if (act === 'preview') {
          selectMatchInPool(path);
          showPreview(path);
        }
      });
    });
    // Whole row click = select in pool (same as Select button)
    row.addEventListener('click', (e) => {
      if (e.target.closest('[data-act]')) return;
      selectMatchInPool(path).catch(() => {});
    });
  });
}

export {
  renderPoolForm, renderSequenceForm, renderPoolGrid, sequencePositions,
  showClipInfoOverlay, runPoolMatch, renderMatchResults,
  filteredPoolItems, ensureSelectedPaths, updateCatalogStatus, metadataUnavailableHtml,
};
