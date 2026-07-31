/**
 * Cut workspace — uses the **global** video bar + frame range like every other op.
 *
 * No local video path / no private file picker.
 *   Range start/end thumbs ← global Frame range sliders
 *   Ref A / Ref B          ← Image Pool (or Browse still into Image Pool)
 *
 * Encode of the trim is not here yet.
 */
import { state, elements, logConsole, showPreview, switchTab, bestInput } from '/app.js';
import { basename, escapeHtml, isImagePath, globalFrameRange } from '/js/utils.js';
import { probeGlobalVideo } from '/js/timeline.js';
import { poolThumbUrl } from '/js/pool/persistence.js';
import { ensureImagePool } from '/js/pool/image-pool.js';

let _listenersBound = false;
let _rangeRefreshTimer = null;
let _videoRefreshTimer = null;

function ensureCut() {
  if (!state.cut) {
    state.cut = { refA: null, refB: null };
  }
  // drop legacy sticky local path if present
  if (state.cut.videoPath !== undefined) delete state.cut.videoPath;
  return state.cut;
}

/** Active clip = first path in global Video file(s) bar. */
function resolveCutVideoPath() {
  const fromBest = (typeof bestInput === 'function') ? bestInput() : '';
  if (fromBest) return fromBest.trim();
  const gi = (window.globalInputs?.video || '').trim();
  if (!gi) return null;
  return gi.split('\n').map(l => l.trim()).find(Boolean) || null;
}

function rangeFrameThumbUrl(path, frameNum) {
  if (!path) return '';
  const n = parseInt(frameNum, 10);
  if (!Number.isFinite(n) || n < 1) return '';
  return `/api/thumbnail?path=${encodeURIComponent(path)}&frame=${n}&_=${n}`;
}

function imageThumb(path) {
  if (!path) return '';
  const item = ensureImagePool().items.find(i => i.path === path);
  if (item) return poolThumbUrl(item, 'first');
  return `/api/thumbnail?path=${encodeURIComponent(path)}&which=first`;
}

function workingRange() {
  const range = globalFrameRange();
  let start = range.start_frame;
  let end = range.end_frame;
  const total = parseInt(window.globalInputs?.totalFrames, 10) || 0;
  if (end >= 999999 && total > 0) end = total;
  if (total > 0) {
    start = Math.min(Math.max(1, start), total);
    end = Math.min(Math.max(start, end), total);
  }
  return { start, end, total };
}

function _bindGlobalListeners() {
  if (_listenersBound) return;
  _listenersBound = true;

  document.addEventListener('mtapi:frame-range', () => {
    if (state.activeTab !== 'cut') return;
    if (_rangeRefreshTimer) clearTimeout(_rangeRefreshTimer);
    _rangeRefreshTimer = setTimeout(() => {
      _rangeRefreshTimer = null;
      refreshCutRangePreviews();
    }, 100);
  });

  document.addEventListener('mtapi:video-probed', () => {
    if (state.activeTab !== 'cut') return;
    refreshCutRangePreviews();
  });

  // Global video bar edits while Cut is open
  const giVideo = document.getElementById('giVideo');
  if (giVideo) {
    const onVideo = () => {
      if (state.activeTab !== 'cut') return;
      if (_videoRefreshTimer) clearTimeout(_videoRefreshTimer);
      _videoRefreshTimer = setTimeout(() => {
        _videoRefreshTimer = null;
        renderCutForm();
      }, 200);
    };
    giVideo.addEventListener('input', onVideo);
    giVideo.addEventListener('change', onVideo);
  }
}

/**
 * Update range start/end thumbs + labels without rebuilding the whole form.
 */
function refreshCutRangePreviews() {
  if (state.activeTab !== 'cut') return;
  const videoPath = resolveCutVideoPath();
  const { start, end, total } = workingRange();

  const clipEl = document.getElementById('cutClipPath');
  if (clipEl) {
    clipEl.textContent = videoPath || '— set Video file(s) in the global bar above —';
    clipEl.title = videoPath || '';
  }

  const hint = document.getElementById('cutRangeHint');
  if (hint) {
    if (!videoPath) {
      hint.textContent = 'no video in global bar';
    } else if (!total || total <= 1) {
      hint.textContent = 'probing frame count…';
    } else {
      hint.textContent = `working range: frames ${start}–${end}  ·  ${total} in clip`;
    }
  }

  const startLabel = document.getElementById('cutStartFrameLabel');
  const endLabelEl = document.getElementById('cutEndFrameLabel');
  if (startLabel) startLabel.textContent = `In · frame ${start}`;
  if (endLabelEl) endLabelEl.textContent = `Out · frame ${end}`;

  const startBox = document.getElementById('cutFirstFrame');
  const endBox = document.getElementById('cutLastFrame');
  if (!videoPath) {
    if (startBox) startBox.innerHTML = '<div class="cut-frame-empty">Set global Video file(s)</div>';
    if (endBox) endBox.innerHTML = '<div class="cut-frame-empty">Set global Video file(s)</div>';
    return;
  }

  const startSrc = rangeFrameThumbUrl(videoPath, start);
  const endSrc = rangeFrameThumbUrl(videoPath, end);

  _setFrameImg(startBox, startSrc, start, 'In');
  _setFrameImg(endBox, endSrc, end, 'Out');
}

function _setFrameImg(box, src, frame, alt) {
  if (!box) return;
  let img = box.querySelector('img');
  if (!src) {
    box.innerHTML = '<div class="cut-frame-empty">…</div>';
    return;
  }
  if (!img) {
    box.innerHTML = '';
    img = document.createElement('img');
    img.alt = alt;
    img.loading = 'lazy';
    img.addEventListener('error', () => img.classList.add('broken'));
    box.appendChild(img);
  }
  if (img.getAttribute('data-frame') !== String(frame) || !img.src.includes(`frame=${frame}`)) {
    img.classList.remove('broken');
    img.setAttribute('data-frame', String(frame));
    img.src = src;
  }
}

async function renderCutForm() {
  _bindGlobalListeners();
  ensureCut();

  const videoPath = resolveCutVideoPath();
  const cut = ensureCut();

  // Make sure frame sliders know the real length (not the default 100)
  if (videoPath) {
    try {
      await probeGlobalVideo(videoPath, { force: true });
    } catch (_) { /* probe logs itself */ }
  }

  const { start, end, total } = workingRange();
  const firstSrc = videoPath ? rangeFrameThumbUrl(videoPath, start) : '';
  const lastSrc = videoPath ? rangeFrameThumbUrl(videoPath, end) : '';
  const refASrc = cut.refA ? imageThumb(cut.refA) : '';
  const refBSrc = cut.refB ? imageThumb(cut.refB) : '';

  const html = `
    <div class="cut-workspace">
      <div class="panel-title-desc">
        <h3>Cut</h3>
        <p>
          Uses the <strong>global Video file(s)</strong> bar and
          <strong>Frame range</strong> sliders above — same as RIFE / Convert / DeepDream.
          Drag In/Out; the two previews follow. Refs come from the Image Pool.
        </p>
      </div>

      <div class="cut-video-row">
        <label class="cut-field-label">Clip (from global Video)</label>
        <div class="cut-global-path" id="cutClipPath" title="${escapeHtml(videoPath || '')}">
          ${escapeHtml(videoPath || '— set Video file(s) in the global bar above —')}
        </div>
        <div class="cut-meta-line">
          <span class="cut-range-hint" id="cutRangeHint">
            ${!videoPath
              ? 'no video in global bar'
              : (!total || total <= 1
                ? 'probing frame count…'
                : `working range: frames ${start}–${end}  ·  ${total} in clip`)}
          </span>
        </div>
        <div class="cut-ref-actions" style="margin-top:6px">
          <button type="button" class="btn btn-sm" id="btnCutPreview" ${videoPath ? '' : 'disabled'}>Preview clip</button>
          <button type="button" class="btn btn-sm" id="btnCutOpenPool">Video Pool…</button>
        </div>
      </div>

      <div class="cut-frames-grid">
        <div class="cut-frame-card">
          <div class="cut-frame-label" id="cutStartFrameLabel">In · frame ${start}</div>
          <div class="cut-frame-preview" id="cutFirstFrame">
            ${firstSrc
              ? `<img src="${firstSrc}" alt="In" data-frame="${start}" loading="lazy" onerror="this.classList.add('broken')">`
              : `<div class="cut-frame-empty">Set global Video file(s)</div>`}
          </div>
        </div>
        <div class="cut-frame-card">
          <div class="cut-frame-label" id="cutEndFrameLabel">Out · frame ${end}</div>
          <div class="cut-frame-preview" id="cutLastFrame">
            ${lastSrc
              ? `<img src="${lastSrc}" alt="Out" data-frame="${end}" loading="lazy" onerror="this.classList.add('broken')">`
              : `<div class="cut-frame-empty">Set global Video file(s)</div>`}
          </div>
        </div>
        <div class="cut-frame-card cut-ref-card">
          <div class="cut-frame-label">Ref A ${cut.refA ? '· loaded' : ''}</div>
          <div class="cut-frame-preview${cut.refA ? ' has-image' : ''}" id="cutRefA">
            ${refASrc
              ? `<img src="${refASrc}" alt="Ref A" loading="lazy" onerror="this.classList.add('broken')">`
              : `<div class="cut-frame-empty">From Image Pool</div>`}
          </div>
          <div class="cut-ref-actions">
            <button type="button" class="btn btn-sm" id="btnCutRefAPool">From Image Pool</button>
            <button type="button" class="btn btn-sm" id="btnCutRefABrowse">Browse…</button>
            <button type="button" class="btn btn-sm" id="btnCutRefAClear" ${cut.refA ? '' : 'disabled'}>Clear</button>
          </div>
          <div class="cut-ref-path" title="${escapeHtml(cut.refA || '')}">${escapeHtml(cut.refA || '—')}</div>
        </div>
        <div class="cut-frame-card cut-ref-card">
          <div class="cut-frame-label">Ref B ${cut.refB ? '· loaded' : ''}</div>
          <div class="cut-frame-preview${cut.refB ? ' has-image' : ''}" id="cutRefB">
            ${refBSrc
              ? `<img src="${refBSrc}" alt="Ref B" loading="lazy" onerror="this.classList.add('broken')">`
              : `<div class="cut-frame-empty">From Image Pool</div>`}
          </div>
          <div class="cut-ref-actions">
            <button type="button" class="btn btn-sm" id="btnCutRefBPool">From Image Pool</button>
            <button type="button" class="btn btn-sm" id="btnCutRefBBrowse">Browse…</button>
            <button type="button" class="btn btn-sm" id="btnCutRefBClear" ${cut.refB ? '' : 'disabled'}>Clear</button>
          </div>
          <div class="cut-ref-path" title="${escapeHtml(cut.refB || '')}">${escapeHtml(cut.refB || '—')}</div>
        </div>
      </div>

      <div class="cut-footer-hint">
        <p>
          Set the clip in <strong>Video file(s)</strong> (or Video Pool → send to Cut).
          Drag <strong>Frame range</strong> for In/Out. Refs: Image Pool → Send to → Cut · Ref A/B.
        </p>
      </div>
    </div>
  `;

  elements.actionPanel.innerHTML = html;
  _bindCutForm();
  // Second paint after async probe may have updated totals
  refreshCutRangePreviews();
}

function _bindCutForm() {
  document.getElementById('btnCutPreview')?.addEventListener('click', () => {
    const p = resolveCutVideoPath();
    if (p) showPreview(p);
  });
  document.getElementById('btnCutOpenPool')?.addEventListener('click', () => switchTab('pool'));

  _bindRefSlot('A', 'refA');
  _bindRefSlot('B', 'refB');
}

function _bindRefSlot(letter, key) {
  const cut = ensureCut();

  document.getElementById(`btnCutRef${letter}Pool`)?.addEventListener('click', () => {
    const ip = ensureImagePool();
    if (ip.selectedPath && isImagePath(ip.selectedPath)) {
      cut[key] = ip.selectedPath;
      logConsole(`[CUT]: Ref ${letter} ← ${basename(ip.selectedPath)}`);
      renderCutForm();
      return;
    }
    if (ip.items.length === 1) {
      cut[key] = ip.items[0].path;
      ip.selectedPath = ip.items[0].path;
      logConsole(`[CUT]: Ref ${letter} ← ${basename(ip.items[0].path)}`);
      renderCutForm();
      return;
    }
    state._cutPendingRef = key;
    if (ip.items.length === 0) {
      alert('Image Pool is empty. Import stills, select one — it will fill Ref ' + letter + '.');
    } else {
      alert('Click an image in the Image Pool to fill Cut Ref ' + letter + '.');
    }
    switchTab('images');
  });

  document.getElementById(`btnCutRef${letter}Browse`)?.addEventListener('click', async () => {
    try {
      // Same global-style image picker filter as the global Image Browse
      const res = await fetch('/api/picker?mode=file&filter=image');
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      if (!data.path) return;
      if (!isImagePath(data.path)) {
        alert('Pick an image file (PNG/JPG/WebP/…).');
        return;
      }
      cut[key] = data.path;
      const { addPathsToImagePool } = await import('/js/pool/image-pool.js');
      addPathsToImagePool([data.path]);
      logConsole(`[CUT]: Ref ${letter} ← ${data.path}`);
      renderCutForm();
    } catch (err) {
      logConsole(`[CUT]: Browse failed — ${err.message}`, 'error');
    }
  });

  document.getElementById(`btnCutRef${letter}Clear`)?.addEventListener('click', () => {
    cut[key] = null;
    renderCutForm();
  });
}

export { renderCutForm, ensureCut, resolveCutVideoPath, refreshCutRangePreviews };
