import {
  state, elements,
  basename, escapeHtml, formatDurationExact,
  logConsole,
  renderPoolForm, renderPoolGrid,
} from '/app.js';
import { displayOpResult } from '/js/job-control.js';
import { POOL_ZOOM, POOL_LAYOUT_DEFAULTS } from '/js/pool/constants.js';

let _poolSeqId = 1;
let _poolSaveTimer = null;
let _poolPersistReady = false; // don't save until restore finishes

// ── Pool persistence ──────────────────────────────────────────────────────

function scheduleSavePoolState() {
  if (!_poolPersistReady) return;
  markProjectDirty();
  if (_poolSaveTimer) clearTimeout(_poolSaveTimer);
  _poolSaveTimer = setTimeout(() => {
    _poolSaveTimer = null;
    savePoolStateNow();
  }, 400);
}

function buildPoolStatePayload() {
  return {
    items: state.pool.items.map(i => ({
      path: i.path,
      name: i.name || basename(i.path),
      hash: i.hash || null,
      size: i.size ?? null,
    })),
    sequence: state.pool.sequence.map(s => {
      const td = s.targetDuration;
      const n = (td != null && td !== '' && Number.isFinite(Number(td)) && Number(td) > 0)
        ? Number(td)
        : null;
      return {
        path: s.path,
        name: s.name || basename(s.path),
        target_duration: n,
      };
    }),
    selected_path: state.pool.selectedPath,
    reconcile: state.pool.reconcile || 'pad',
    aspect: state.pool.aspect || 'auto',
    aspect_custom: state.pool.aspectCustom || '',
    output_path: state.pool.outputPath || '',
    tile_zoom: state.pool.tileZoom || POOL_ZOOM.reset,
    tile_info: ensureTileInfo(),
    layout: ensurePoolLayout(),
    project_name: state.project.name || null,
    project_path: state.project.path || null,
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
  const el = document.getElementById('poolProjectName');
  if (el) {
    el.textContent = projectLabel();
    el.title = state.project.path || '';
  }
}

/** Apply loaded project/session JSON into live pool state and re-render. */
function applyPoolData(data, { asProject = false, projectPath = null, projectName = null } = {}) {
  const items = data.items || [];
  const sequence = data.sequence || [];

  state.pool.items = items.map(it => ({
    path: it.path,
    name: it.name || basename(it.path),
    hash: it.hash || null,
    size: it.size ?? null,
    meta: null,
  }));
  state.pool.sequence = sequence.map(s => {
    let td = s.target_duration ?? s.targetDuration ?? null;
    if (td != null) {
      td = Number(td);
      if (!Number.isFinite(td) || td <= 0) td = null;
    }
    return {
      id: _poolSeqId++,
      path: s.path,
      name: s.name || basename(s.path),
      targetDuration: td,
    };
  });
  state.pool.selectedPath = data.selected_path || null;
  state.pool.focusPath = data.selected_path || null;
  state.pool.hoverPath = null;
  state.pool.selectedSeqId = null;
  state.pool.reconcile = data.reconcile || 'pad';
  state.pool.aspect = data.aspect || 'auto';
  state.pool.aspectCustom = data.aspect_custom || '';
  state.pool.outputPath = data.output_path || '';

  if (typeof data.tile_zoom === 'number' && !isNaN(data.tile_zoom)) {
    state.pool.tileZoom = Math.max(POOL_ZOOM.min, Math.min(POOL_ZOOM.max, data.tile_zoom));
  } else {
    state.pool.tileZoom = POOL_ZOOM.reset;
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

  // Warm meta
  state.pool.items.forEach((item, idx) => {
    loadPoolItemMeta(item, idx);
  });
}

async function projectNew() {
  if (state.project.dirty || state.pool.items.length || state.pool.sequence.length) {
    if (!confirm('Start a new project? Unsaved changes will be lost (session autosave still has last autosave).')) {
      return;
    }
  }
  seqStop();
  state.pool.items = [];
  state.pool.sequence = [];
  state.pool.selectedPath = null;
  state.pool.selectedSeqId = null;
  state.pool.hoverPath = null;
  state.pool.focusPath = null;
  state.pool.matchResults = null;
  state.pool.outputPath = '';
  state.project = { path: null, name: null, dirty: false };
  logConsole('[PROJECT]: New untitled project');
  if (state.activeTab === 'pool') renderPoolForm();
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
    logConsole(
      `[PROJECT]: Opened ${data.name || data.path} — ${data.item_count} clips, ${data.sequence_count} in sequence`
    );
    if (state.activeTab === 'pool') renderPoolForm();
    else switchTab('pool');
  } catch (err) {
    logConsole(`[PROJECT OPEN]: ${err.message}`, 'error');
    alert(`Could not open project: ${err.message}`);
  } finally {
    await checkHealth();
  }
}

async function projectSave(saveAs = false) {
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

async function savePoolStateNow() {
  if (!_poolPersistReady) return;
  try {
    const res = await fetch('/api/pool/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPoolStatePayload()),
    });
    if (!res.ok) throw new Error(await res.text());
    // Quiet success — only log occasionally would be noisy; skip
  } catch (err) {
    logConsole(`[POOL SAVE]: ${err.message}`, 'error');
  }
}

async function restorePoolState() {
  try {
    // Prefer last named project if present; else session autosave
    let data = null;
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
              const timed = state.pool.sequence.filter(s => s.targetDuration != null).length;
              logConsole(
                `[PROJECT]: Restored ${data.name || data.path} — ${state.pool.items.length} clips, ${state.pool.sequence.length} in sequence`
                + (timed ? `, ${timed} timed` : '')
              );
              _poolPersistReady = true;
              return;
            }
          }
        }
      }
    } catch (_) { /* fall through to session */ }

    const res = await fetch('/api/pool/state');
    if (!res.ok) throw new Error(await res.text());
    data = await res.json();
    if (!data.ok) {
      logConsole(`[POOL]: No saved state (${data.error || 'empty'})`);
      _poolPersistReady = true;
      return;
    }

    applyPoolData(data, { asProject: false });
    // session restore — keep untitled unless payload had project_path
    if (data.project_path) {
      state.project.path = data.project_path;
      state.project.name = data.project_name || basename(data.project_path).replace(/\.ffproject\.json$/i, '');
      state.project.dirty = false;
    }
    const timed = state.pool.sequence.filter(s => s.targetDuration != null).length;
    logConsole(
      `[POOL]: Restored session — ${state.pool.items.length} clips, ${state.pool.sequence.length} in sequence`
      + (timed ? `, ${timed} timed` : '')
      + ((data.missing || []).length ? ` (${data.missing.length} missing skipped)` : '')
    );
    _poolPersistReady = true;
  } catch (err) {
    logConsole(`[POOL RESTORE]: ${err.message}`, 'error');
    _poolPersistReady = true;
  }
}

function refreshPoolToolbarCounts() {
  const el = document.querySelector('.pool-count');
  if (el) {
    el.textContent = `${state.pool.items.length} in pool · ${state.pool.sequence.length} in sequence`;
  }
  const stitchBtn = document.getElementById('btnPoolStitch');
  if (stitchBtn) stitchBtn.disabled = state.pool.sequence.length < 2;
  const seqClear = document.getElementById('btnSeqClear');
  if (seqClear) seqClear.disabled = state.pool.sequence.length === 0;
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
    alert('Need at least 2 clips in the sequence to stitch.');
    return;
  }

  const mode = document.getElementById('poolReconcile')?.value || state.pool.reconcile || 'pad';
  let aspect = document.getElementById('poolAspect')?.value || state.pool.aspect || 'auto';
  if (aspect === 'custom') {
    aspect = (document.getElementById('poolAspectCustom')?.value || state.pool.aspectCustom || '').trim();
    if (!aspect || !/^(\d+:\d+|\d+x\d+)$/i.test(aspect)) {
      alert('Custom AR needs W:H (e.g. 5:4) or WxH (e.g. 1080x1920).');
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

  const body = {
    input_paths: paths,
    mode,
    aspect,
    durations: anyTimed ? durations : null,
    output_path,
    dry_run: false,
  };

  elements.statusDot.className = 'status-dot loading';
  elements.statusText.textContent = 'Stitching…';
  const btn = document.getElementById('btnPoolStitch');
  if (btn) {
    btn.disabled = true;
    btn.dataset.label = btn.innerHTML;
    btn.innerHTML = 'Stitching…';
  }

  logConsole(`[STITCH]: POST /ops/join\n${JSON.stringify(body, null, 2)}`);

  try {
    const response = await fetch('/ops/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }
    const data = await response.json();
    displayOpResult(data);

    // Auto-import the stitched result into the pool
    if (data.ok && data.output_path) {
      addPathsToPool([data.output_path]);
      if (state.activeTab === 'pool') {
        renderPoolGrid();
        refreshPoolToolbarCounts();
      }
      logConsole(`[STITCH]: Output added to pool → ${data.output_path}`);
    }
  } catch (err) {
    elements.statusDot.className = 'status-dot error';
    elements.statusText.textContent = 'Stitch failed';
    logConsole(`[STITCH FAILED]: ${err.message}`, 'error');
    alert(`Stitch failed: ${err.message}`);
  } finally {
    if (btn) {
      btn.disabled = state.pool.sequence.length < 2;
      btn.innerHTML = btn.dataset.label || 'Stitch Sequence';
    }
    await checkHealth();
  }
}

function poolThumbUrl(item, which) {
  // Prefer content-hash once known — permanent cache key independent of path
  if (item.hash) {
    return `/api/thumbnail?hash=${encodeURIComponent(item.hash)}&which=${which}`;
  }
  return `/api/thumbnail?path=${encodeURIComponent(item.path)}&which=${which}`;
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


export {
  _poolSeqId, _poolSaveTimer, _poolPersistReady,
  scheduleSavePoolState, buildPoolStatePayload,
  projectLabel, markProjectDirty, updateProjectNameUI,
  applyPoolData, projectNew, projectOpen, projectSave,
  savePoolStateNow, restorePoolState,
  refreshPoolToolbarCounts, ensureVideoOutputPath,
  stitchPoolSequence,
  poolThumbUrl, shortHash, buildPoolMetaHtml,
};
