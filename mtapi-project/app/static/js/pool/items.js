import { state, elements, logConsole, showPreview, renderPoolForm, renderStyleTransferForm, renderFaceMorphForm, renderWithoutBgForm, checkHealth, switchTab, formatBytes } from '/app.js';
import { isVideoPath, basename, formatDurationExact } from '/js/utils.js';
import { shortHash, buildPoolMetaHtml, poolThumbUrl, scheduleSavePoolState } from '/js/pool/persistence.js';
import { applySeqTokenTimeStyles, updateSeqClipSettings, displayFocusPath, updatePoolFocusFrame, setPoolFocus, updateSelectionHighlights, updateSeqTransportUI, seqStop, addPathToSequence, _maybeAutoRifeForPath } from '/js/pool/sequence.js';
import { runQuickTransmute } from '/js/tabs/quick.js';
import { addMultiClipPath } from '/js/tabs/transmute.js';

// ── Pool item operations ─────────────────────────────────────────────────

async function loadPoolItemMeta(item, idx) {
  try {
    const res = await fetch(`/api/media_info?path=${encodeURIComponent(item.path)}&ensure_thumbs=true`);
    const data = await res.json();
    if (data && data.ok) {
      item.meta = data;
      item.hash = data.hash || item.hash;
      item.history_count = data.history_count;
      item.open_count = data.open_count;
      if (data.size != null) item.size = data.size;
      if (data.name) item.name = data.name;
      const tag = data.cached ? 'cache hit' : 'hashed new';
      const elap = data.elapsed_s != null ? ` in ${data.elapsed_s}s` : '';
      logConsole(`[POOL]: ${item.name || item.path} → #${shortHash(data.hash)} (${tag}${elap})`);
    } else {
      item.metaError = data?.error || 'probe failed';
      item.meta = { video_codec: '?', audio_codec: '?', duration: null, fps: null, frames: null, size: item.size };
    }
  } catch (err) {
    item.metaError = err.message;
    item.meta = { video_codec: '?', audio_codec: '?', duration: null, fps: null, frames: null, size: item.size };
  }

  if (state.activeTab !== 'pool') return;
  const liveIdx = state.pool.items.findIndex(i => i.path === item.path);
  if (liveIdx < 0) return;
  const el = document.getElementById(`poolMeta-${liveIdx}`);
  if (el) el.innerHTML = buildPoolMetaHtml(item);

  if (item.hash) {
    const card = Array.from(document.querySelectorAll('.pool-card')).find(c => c.dataset.path === item.path);
    if (card) {
      card.dataset.hash = item.hash;
      card.querySelectorAll('img.pool-thumb').forEach(img => {
        const which = img.dataset.which || 'first';
        const next = poolThumbUrl(item, which);
        if (img.getAttribute('src') && img.getAttribute('src').includes('path=')) {
          img.src = next;
        }
      });
    }
  }

  if (state.pool.sequence.some(s => s.path === item.path)) {
    applySeqTokenTimeStyles();
    updateSeqClipSettings();
    _maybeAutoRifeForPath(item.path);
  }
  if (displayFocusPath() === item.path) {
    updatePoolFocusFrame(item.path);
  }
  if (item.hash) scheduleSavePoolState();
}

function scrollToSelected() {
  const path = state.pool.selectedPath;
  if (!path) return;
  const card = Array.from(document.querySelectorAll('.pool-card')).find(c => c.dataset.path === path);
  if (card?.scrollIntoView) card.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function selectPoolItem(path) {
  if (!path) return;
  state.pool.selectedPath = path;
  state.pool.hoverPath = null;
  state.pool.focusPath = path;
  if (state.pool.selectedSeqId != null) {
    const cur = state.pool.sequence.find(s => s.id === state.pool.selectedSeqId);
    if (!cur || cur.path !== path) {
      const first = state.pool.sequence.find(s => s.path === path);
      state.pool.selectedSeqId = first ? first.id : null;
    }
  } else {
    const first = state.pool.sequence.find(s => s.path === path);
    state.pool.selectedSeqId = first ? first.id : null;
  }

  if (!state.pool.playback.playing) {
    showPreview(path);
  }
  updatePoolFocusFrame(path);
  updateSelectionHighlights();
  updateSeqTransportUI();
  updateSeqClipSettings();
  scheduleSavePoolState();

  scrollToSelected();
  const tok = Array.from(document.querySelectorAll('.seq-token')).find(t => t.dataset.path === path);
  if (tok?.scrollIntoView) tok.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });

  const findBtn = document.getElementById('btnFindNext');
  if (findBtn && !state.pool.matchLoading) findBtn.disabled = false;

  const toolbarMeta = document.querySelector('.pool-toolbar-meta');
  if (toolbarMeta) {
    toolbarMeta.innerHTML = `
      <span class="pool-count">${state.pool.items.length} in video pool · ${state.pool.sequence.length} in sequence</span>
      <div class="pool-use-wrap">
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
      <button class="btn pool-jump-btn" id="btnJumpSelected" type="button" title="Jump to selected clip in grid">!</button>
    `;
    document.getElementById('btnPoolUse')?.addEventListener('click', applyPoolAsInput);
    document.getElementById('btnJumpSelected')?.addEventListener('click', scrollToSelected);
  }
}

function removePoolItem(idx) {
  const removed = state.pool.items[idx];
  if (!removed) return;
  state.pool.items.splice(idx, 1);
  if (state.pool.selectedPath === removed.path) {
    state.pool.selectedPath = null;
    state.pool.focusPath = null;
  }
  if (state.pool.hoverPath === removed.path) {
    state.pool.hoverPath = null;
  }
    logConsole(`[POOL]: Removed ${removed.name || removed.path}`);
  scheduleSavePoolState();
  if (state.activeTab === 'pool') renderPoolForm();
  else if (state.activeTab === 'sequence') {
    import('/js/pool/grid.js').then(m => { m.renderSequenceForm(); }).catch(() => {});
  }
}

function clearPool() {
  if (state.pool.items.length === 0) return;
  if (!confirm(`Clear all ${state.pool.items.length} clips from the pool?`)) return;
  seqStop();
  state.pool.items = [];
  state.pool.selectedPath = null;
  logConsole('[POOL]: Cleared');
  scheduleSavePoolState();
  if (state.activeTab === 'pool') renderPoolForm();
  else if (state.activeTab === 'sequence') {
    import('/js/pool/grid.js').then(m => { m.renderSequenceForm(); }).catch(() => {});
  }
}

function addPathsToPool(paths) {
  let added = 0;
  let skipped = 0;
  const existingPaths = new Set(state.pool.items.map(i => i.path));
  let firstNew = null;

  for (const raw of paths) {
    if (!raw) continue;
    const path = raw.trim();
    if (!path) continue;
    if (!isVideoPath(path)) {
      skipped++;
      continue;
    }
    if (existingPaths.has(path)) {
      skipped++;
      continue;
    }
    existingPaths.add(path);
    state.pool.items.push({
      path,
      name: basename(path),
      size: null,
      meta: null,
      hash: null,
    });
    if (!firstNew) firstNew = path;
    added++;
  }

  logConsole(`[POOL]: +${added} video(s)${skipped ? `, skipped ${skipped}` : ''}`);
  if (added > 0) scheduleSavePoolState();
  return { added, firstNew };
}

async function importPoolFiles() {
  elements.statusDot.className = 'status-dot loading';
  elements.statusText.textContent = 'Waiting for file picker…';
  try {
    const res = await fetch(`/api/picker?mode=files&start_path=${encodeURIComponent(WORKSPACE_HINT())}`);
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    const paths = Array.isArray(data.paths) && data.paths.length
      ? data.paths
      : (data.path ? [data.path] : []);
    if (paths.length === 0) {
      logConsole('[POOL]: File import cancelled');
      return;
    }
    const { firstNew } = addPathsToPool(paths);
    if (state.activeTab === 'pool') {
      renderPoolForm();
      if (firstNew) selectPoolItem(firstNew);
    } else if (state.activeTab === 'sequence') {
      import('/js/pool/grid.js').then(m => { m.renderSequenceForm(); });
    }
  } catch (err) {
    logConsole(`[POOL ERROR]: ${err.message}`, 'error');
    alert(`Could not open file picker: ${err.message}`);
  } finally {
    await checkHealth();
  }
}

async function importPoolFolder() {
  elements.statusDot.className = 'status-dot loading';
  elements.statusText.textContent = 'Waiting for folder picker…';
  try {
    const res = await fetch(`/api/picker?mode=dir&start_path=${encodeURIComponent(WORKSPACE_HINT())}`);
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    const dir = data.path;
    if (!dir) {
      logConsole('[POOL]: Folder import cancelled');
      return;
    }
    logConsole(`[POOL]: Scanning ${dir}…`);
    const recursive = document.getElementById('poolRecursiveScan')?.checked ? 'true' : 'false';
    const scanRes = await fetch(`/api/pool/scan?path=${encodeURIComponent(dir)}&recursive=${recursive}`);
    if (!scanRes.ok) throw new Error(await scanRes.text());
    const scan = await scanRes.json();
    if (!scan.ok) throw new Error(scan.error || 'scan failed');
    const paths = (scan.videos || []).map(v => v.path);
    if (paths.length === 0) {
      logConsole(`[POOL]: No videos found in ${dir}`);
      alert('No video files found in that folder.');
      return;
    }
    const scanData = new Map((scan.videos || []).map(v => [v.path, v]));
    const { added, firstNew } = addPathsToPool(paths);
    state.pool.items.forEach(item => {
      const data = scanData.get(item.path);
      if (data) {
        if (item.size == null) item.size = data.size;
        if (data.hash) item.hash = data.hash;
        if (data.meta) item.meta = data.meta;
        if (data.thumbs) item.thumbs = data.thumbs;
        if (data.history_count != null) item.history_count = data.history_count;
        if (data.open_count != null) item.open_count = data.open_count;
        if (data.cached) item.cached = data.cached;
      }
    });
    logConsole(`[POOL]: Folder import from ${dir} (${added} new)`);
    if (state.activeTab === 'pool') {
      renderPoolForm();
      if (firstNew) selectPoolItem(firstNew);
    } else if (state.activeTab === 'sequence') {
      import('/js/pool/grid.js').then(m => { m.renderSequenceForm(); });
    }
  } catch (err) {
    logConsole(`[POOL ERROR]: ${err.message}`, 'error');
    alert(`Folder import failed: ${err.message}`);
  } finally {
    await checkHealth();
  }
}

function WORKSPACE_HINT() {
  if (state.pool.selectedPath) {
    const p = state.pool.selectedPath;
    return p.substring(0, p.lastIndexOf('/')) || '';
  }
  if (state.pool.items.length > 0) {
    const p = state.pool.items[0].path;
    return p.substring(0, p.lastIndexOf('/')) || '';
  }
  return '';
}

function sendPoolPathTo(path, target) {
  if (!path) return;
  if (!target) {
    alert('Choose a destination.');
    return;
  }

  selectPoolItem(path);
  setPoolFocus(path);

  if (target === 'preview') {
    showPreview(path);
    logConsole(`[POOL]: Preview → ${path}`);
    return;
  }

  if (target === 'save_first_png') {
    savePoolFramePng(path, 'first');
    return;
  }
  if (target === 'save_last_png') {
    savePoolFramePng(path, 'last');
    return;
  }

  if (target === 'quick') {
    runQuickTransmute(path);
    return;
  }

  if (target === 'sequence') {
    addPathToSequence(path);
    logConsole(`[POOL]: Sent to sequence → ${basename(path)}`);
    return;
  }

  if (target === 'multi') {
    addMultiClipPath(path);
    logConsole(`[POOL]: Sent to multi clips → ${path}`);
    switchTab('multi');
    return;
  }

  // Cut uses global Video bar only (no private path field)
  if (target === 'cut') {
    const gi = document.getElementById('giVideo');
    if (gi) {
      gi.value = path;
      gi.dispatchEvent(new Event('input'));
    }
    window.globalInputs.video = path;
    // force re-probe so frame range matches this clip
    window.globalInputs._lastProbedPath = null;
    window.globalInputs._probeOk = false;
    logConsole(`[POOL]: Sent to Cut (global video) → ${path}`);
    switchTab('cut');
    return;
  }

  state.pendingInputPath = path;
  state.pendingInputTarget = target;

  if (target === 'mosh') {
    switchTab('mosh');
    const input = document.getElementById('moshInput');
    if (input) {
      input.value = path;
      input.dispatchEvent(new Event('input'));
    }
    logConsole(`[POOL]: Sent to Datamosh → ${path}`);
  } else if (target === 'deepdream') {
    switchTab('deepdream');
    const input = document.getElementById('dreamInput');
    if (input) {
      input.value = path;
      input.dispatchEvent(new Event('input'));
    }
    logConsole(`[POOL]: Sent to DeepDream → ${path}`);
  } else if (target === 'transmute') {
    switchTab('transmute');
    const input = document.getElementById('transmuteInput');
    if (input) {
      input.value = path;
      input.dispatchEvent(new Event('input'));
    }
    logConsole(`[POOL]: Sent to Transmute → ${path}`);
  } else if (target === 'advanced') {
    switchTab('advanced');
    const input = document.getElementById('advInput');
    if (input) {
      input.value = path;
      input.dispatchEvent(new Event('input'));
    }
    logConsole(`[POOL]: Sent to Advanced → ${path}`);
  } else if (target === 'rife') {
    switchTab('rife');
    const input = document.getElementById('rifeInput');
    if (input) {
      input.value = path;
      input.dispatchEvent(new Event('input'));
    }
    logConsole(`[POOL]: Sent to RIFE → ${path}`);
  } else if (target === 'speedchange') {
    switchTab('speedchange');
    const input = document.getElementById('scInput');
    if (input) {
      input.value = path;
      input.dispatchEvent(new Event('input'));
    }
    logConsole(`[POOL]: Sent to Speed Change → ${path}`);
  } else if (target === 'upscale') {
    switchTab('upscale');
    const input = document.getElementById('upInput');
    if (input) {
      input.value = path;
      input.dispatchEvent(new Event('input'));
    }
    logConsole(`[POOL]: Sent to Upscale → ${path}`);
  } else if (target === 'fastsam') {
    switchTab('fastsam');
    const input = document.getElementById('fastsamInput');
    if (input) {
      input.value = path;
      input.dispatchEvent(new Event('input'));
    }
    logConsole(`[POOL]: Sent to FastSAM → ${path}`);
  } else if (target === 'convert') {
    switchTab('convert');
    const input = document.getElementById('convertInput');
    if (input) {
      input.value = path;
      input.dispatchEvent(new Event('input'));
    }
    logConsole(`[POOL]: Sent to Convert → ${path}`);
  } else if (target === 'styletransfer') {
    if (!state.styleTransfer) state.styleTransfer = { contents: [], stylePath: '', output: '', outputDir: '', selected: 0 };
    if (!state.styleTransfer.contents.some((c) => c.path === path)) {
      state.styleTransfer.contents.push({ path, name: basename(path) });
    }
    switchTab('styletransfer');
    renderStyleTransferForm();
    logConsole(`[POOL]: Sent to Style Transfer → ${path}`);
  } else if (target === 'facemorph') {
    if (!state.faceMorph) state.faceMorph = { images: [], output: '', selected: 0 };
    if (!state.faceMorph.images.some((x) => x.path === path)) {
      state.faceMorph.images.push({ path, name: basename(path) });
    }
    switchTab('facemorph');
    renderFaceMorphForm();
    logConsole(`[POOL]: Sent to Face Morph → ${path}`);
  } else if (target === 'withoutbg') {
    if (!state.withoutbg) state.withoutbg = { images: [], outputDir: '', prefix: 'withoutbg', fmt: 'png', backend: 'local', selected: 0 };
    if (!state.withoutbg.images.some((x) => x.path === path)) {
      state.withoutbg.images.push({ path, name: basename(path) });
    }
    switchTab('withoutbg');
    renderWithoutBgForm();
    logConsole(`[POOL]: Sent to withoutBG → ${path}`);
  } else if (target === 'img2img') {
    switchTab('img2img');
    const input = document.getElementById('i2iInput');
    if (input) {
      input.value = path;
      input.dispatchEvent(new Event('input'));
    }
    logConsole(`[POOL]: Sent to Img2Img → ${path}`);
  } else if (target === 'agent') {
    if (!state.agent) state.agent = { backend: 'deepseek', skill: 'chat', model: '', images: [], history: [] };
    if (!state.agent.images.includes(path)) {
      state.agent.images.push(path);
    }
    switchTab('agent');
    logConsole(`[POOL]: Sent to Agent → ${path}`);
  } else {
    logConsole(`[POOL]: Unknown send target: ${target}`, 'error');
  }
}

async function savePoolFramePng(videoPath, which) {
  which = which === 'last' ? 'last' : 'first';
  const stem = basename(videoPath).replace(/\.[^.]+$/, '');
  const dir = videoPath.substring(0, videoPath.lastIndexOf('/')) || '';
  const suggested = `${dir}/${stem}_${which}.png`;

  elements.statusDot.className = 'status-dot loading';
  elements.statusText.textContent = `Saving ${which} frame PNG…`;

  let outputPath = null;
  try {
    const pickUrl =
      `/api/picker?mode=save&filter=image` +
      `&start_path=${encodeURIComponent(suggested)}`;
    const pickRes = await fetch(pickUrl);
    if (pickRes.ok) {
      const pick = await pickRes.json();
      if (pick.path) {
        outputPath = pick.path;
        if (!/\.png$/i.test(outputPath)) {
          outputPath = outputPath.replace(/\.[^.]+$/, '') + '.png';
          if (!/\.png$/i.test(outputPath)) outputPath = `${outputPath}.png`;
        }
      } else {
        logConsole(`[EXPORT]: Cancelled (${which} frame)`);
        await checkHealth();
        return;
      }
    }
  } catch (err) {
    logConsole(`[EXPORT]: Picker unavailable, using auto path — ${err.message}`);
    outputPath = suggested;
  }

  if (!outputPath) outputPath = suggested;

  try {
    const res = await fetch('/api/export_frame', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: videoPath,
        which,
        output_path: outputPath,
      }),
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'export failed');

    logConsole(`[EXPORT]: ${which} frame PNG → ${data.output_path} (${formatBytes(data.size || 0)})`);
    elements.statusDot.className = 'status-dot';
    elements.statusText.textContent = 'Frame PNG saved';
    showPreview(data.output_path);
  } catch (err) {
    logConsole(`[EXPORT ERROR]: ${err.message}`, 'error');
    elements.statusDot.className = 'status-dot error';
    elements.statusText.textContent = 'Export failed';
    alert(`Could not save ${which} frame PNG: ${err.message}`);
  } finally {
    await checkHealth();
  }
}

function applyPoolAsInput() {
  const path = state.pool.selectedPath;
  if (!path) {
    alert('Select a clip first.');
    return;
  }
  const target = document.getElementById('poolUseTarget')?.value;
  if (!target) {
    alert('Choose a target (Sequence / Datamosh / Transmute / Multi / Advanced).');
    return;
  }
  sendPoolPathTo(path, target);
}

export {
  loadPoolItemMeta, selectPoolItem, removePoolItem, clearPool,
  addPathsToPool, importPoolFiles, importPoolFolder, WORKSPACE_HINT,
  sendPoolPathTo, savePoolFramePng, applyPoolAsInput, scrollToSelected,
};
