/**
 * Cut workspace — uses the **global** video bar + frame range like every other op.
 *
 * No local video path / no private file picker.
 *   Range start/end thumbs ← global Frame range sliders
 *   Ref A / Ref B          ← Image Pool (or Browse still into Image Pool)
 *   Encode                ← dump range → encode .mp4 (POST /ops/cut)
 *
 * Compare UI is the shared module `/js/ui/image-compare.js`
 * (In↔Ref A, Out↔Ref B): separate | overlay | A/B wipe.
 */
import { state, elements, logConsole, showPreview, switchTab, bestInput } from '/app.js';
import { basename, escapeHtml, isImagePath, globalFrameRange } from '/js/utils.js';
import { probeGlobalVideo } from '/js/timeline.js';
import { poolThumbUrl } from '/js/pool/persistence.js';
import { ensureImagePool } from '/js/pool/image-pool.js';
import {
  defaultCompareState,
  normalizeCompareState,
  compareToolbarHtml,
  paintCompareView,
  bindCompareControls,
} from '/js/ui/image-compare.js';
import { runOpWithCancel } from '/js/job-control.js';

let _listenersBound = false;
let _rangeRefreshTimer = null;
let _videoRefreshTimer = null;
/** @type {{ destroy: () => void } | null} */
let _compareCtl = null;

const CUT_COMPARE_PREFIX = 'cut';

function ensureCut() {
  if (!state.cut) {
    state.cut = {
      refA: null,
      refB: null,
      ...defaultCompareState(),
      compareMode: 'separate', // legacy alias kept in sync by normalize
    };
  }
  // drop legacy sticky local path if present
  if (state.cut.videoPath !== undefined) delete state.cut.videoPath;

  // Map legacy compareMode ↔ shared mode field
  if (state.cut.compareMode && !state.cut.mode) {
    state.cut.mode = state.cut.compareMode;
  }
  normalizeCompareState(state.cut);
  state.cut.compareMode = state.cut.mode;
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

function _cutCompareState() {
  const cut = ensureCut();
  return {
    mode: cut.mode || cut.compareMode || 'separate',
    overlayOpacity: cut.overlayOpacity,
    abPosition: cut.abPosition,
  };
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
  const cut = ensureCut();
  const videoPath = resolveCutVideoPath();
  const { start, end, total } = workingRange();
  const cmp = _cutCompareState();
  const mode = cmp.mode;

  const startLabel = document.getElementById('cutStartFrameLabel');
  const endLabelEl = document.getElementById('cutEndFrameLabel');
  if (startLabel) {
    startLabel.textContent = mode === 'separate'
      ? `In · frame ${start}`
      : `In · frame ${start}${cut.refA ? ' + Ref A' : ''}`;
  }
  if (endLabelEl) {
    endLabelEl.textContent = mode === 'separate'
      ? `Out · frame ${end}`
      : `Out · frame ${end}${cut.refB ? ' + Ref B' : ''}`;
  }

  const startBox = document.getElementById('cutFirstFrame');
  const endBox = document.getElementById('cutLastFrame');
  const startSrc = videoPath ? rangeFrameThumbUrl(videoPath, start) : '';
  const endSrc = videoPath ? rangeFrameThumbUrl(videoPath, end) : '';
  const refASrc = cut.refA ? imageThumb(cut.refA) : '';
  const refBSrc = cut.refB ? imageThumb(cut.refB) : '';
  const emptyVideo = !videoPath ? 'Set global Video file(s)' : '…';

  const common = {
    mode,
    opacity: cmp.overlayOpacity,
    ab: cmp.abPosition,
    emptyMsg: emptyVideo,
    emptyClass: 'cut-frame-empty',
    baseLabel: 'Frame',
  };

  paintCompareView(startBox, {
    ...common,
    baseSrc: startSrc,
    baseKey: start,
    refSrc: refASrc,
    refLabel: 'Ref A',
    missingRefMsg: 'Load Ref A to compare',
  });
  paintCompareView(endBox, {
    ...common,
    baseSrc: endSrc,
    baseKey: end,
    refSrc: refBSrc,
    refLabel: 'Ref B',
    missingRefMsg: 'Load Ref B to compare',
  });
}

function _refCardHtml(letter, path, src) {
  return `
    <div class="cut-frame-card cut-ref-card">
      <div class="cut-frame-label">Ref ${letter} ${path ? '· loaded' : ''}</div>
      <div class="cut-frame-preview${path ? ' has-image' : ''}" id="cutRef${letter}">
        ${src
          ? `<img src="${src}" alt="Ref ${letter}" loading="lazy" onerror="this.classList.add('broken')">`
          : `<div class="cut-frame-empty">From Image Pool</div>`}
      </div>
      <div class="cut-ref-actions">
        <button type="button" class="btn btn-sm" id="btnCutRef${letter}Pool">From Image Pool</button>
        <button type="button" class="btn btn-sm" id="btnCutRef${letter}Browse">Browse…</button>
        <button type="button" class="btn btn-sm" id="btnCutRef${letter}Clear" ${path ? '' : 'disabled'}>Clear</button>
      </div>
      <div class="cut-ref-path" title="${escapeHtml(path || '')}">${escapeHtml(path || '—')}</div>
    </div>
  `;
}

function _refToolbarHtml(letter, path) {
  return `
    <div class="cut-ref-actions cut-ref-inline">
      <span class="cut-ref-inline-label">Ref ${letter}</span>
      <button type="button" class="btn btn-sm" id="btnCutRef${letter}Pool">Pool</button>
      <button type="button" class="btn btn-sm" id="btnCutRef${letter}Browse">Browse…</button>
      <button type="button" class="btn btn-sm" id="btnCutRef${letter}Clear" ${path ? '' : 'disabled'}>Clear</button>
      <span class="cut-ref-path" title="${escapeHtml(path || '')}">${escapeHtml(path ? basename(path) : '—')}</span>
    </div>
  `;
}

async function renderCutForm() {
  _bindGlobalListeners();
  ensureCut();

  if (_compareCtl) {
    try { _compareCtl.destroy(); } catch (_) { /* ignore */ }
    _compareCtl = null;
  }

  const videoPath = resolveCutVideoPath();
  const cut = ensureCut();
  const cmp = _cutCompareState();
  const mode = cmp.mode;

  // Make sure frame sliders know the real length (not the default 100)
  if (videoPath) {
    try {
      await probeGlobalVideo(videoPath, { force: true });
    } catch (_) { /* probe logs itself */ }
  }

  const { start, end, total } = workingRange();
  const refASrc = cut.refA ? imageThumb(cut.refA) : '';
  const refBSrc = cut.refB ? imageThumb(cut.refB) : '';

  const gridClass = mode === 'separate' ? 'cut-frames-grid' : 'cut-frames-grid cut-frames-grid-compare';

  const inOutCards = `
    <div class="cut-frame-card">
      <div class="cut-frame-label" id="cutStartFrameLabel">In · frame ${start}</div>
      <div class="cut-frame-preview img-compare-viewport" id="cutFirstFrame"></div>
      ${mode !== 'separate' ? _refToolbarHtml('A', cut.refA) : ''}
    </div>
    <div class="cut-frame-card">
      <div class="cut-frame-label" id="cutEndFrameLabel">Out · frame ${end}</div>
      <div class="cut-frame-preview img-compare-viewport" id="cutLastFrame"></div>
      ${mode !== 'separate' ? _refToolbarHtml('B', cut.refB) : ''}
    </div>
  `;

  const refCards = mode === 'separate'
    ? _refCardHtml('A', cut.refA, refASrc) + _refCardHtml('B', cut.refB, refBSrc)
    : '';

  const toolbar = compareToolbarHtml({
    idPrefix: CUT_COMPARE_PREFIX,
    state: cmp,
    label: 'Compare',
    modeTitles: {
      separate: 'Show In, Out, Ref A, Ref B as four cards',
      overlay: 'Stack ref on top of frame; adjust transparency to align',
      ab: 'Wipe slider between frame and reference',
    },
  });

  const html = `
    <div class="cut-workspace">
      <div class="panel-title-desc">
        <h3>Cut</h3>
        <p>
          Uses the <strong>global Video file(s)</strong> bar and
          <strong>Frame range</strong> sliders above — same as RIFE / Convert / DeepDream.
          Drag In/Out; previews follow. Refs from Image Pool.
          Compare modes use the shared image-compare control.
        </p>
      </div>

      ${toolbar}

      <div class="${gridClass}">
        ${inOutCards}
        ${refCards}
      </div>

      <div class="form-row" style="margin-top:1rem">
        <label for="cutOutput">Encode output</label>
        <div class="input-row">
          <input type="text" id="cutOutput" placeholder="blank = auto next to source (_cut_IN-OUT.mp4)">
          <button type="button" class="btn" id="btnCutEncode">Encode cut</button>
        </div>
        <p class="form-row-hint">
          Dump In–Out (frames ${start}–${end}) via filter-platform bookends, then encode .mp4.
          Or use the global <strong>Run</strong> button.
        </p>
      </div>

      <div class="cut-footer-hint">
        <p>
          <strong>1 Separate</strong> — four cards.
          <strong>2 Overlay</strong> — ref on top of In/Out; drag opacity to align.
          <strong>3 A/B</strong> — wipe left (frame) ↔ right (ref). Drag the wipe on the image or the slider.
          Refs: Image Pool → Send to → Cut · Ref A/B.
          Module: <code>js/ui/image-compare.js</code>.
        </p>
      </div>
    </div>
  `;

  elements.actionPanel.innerHTML = html;
  _bindCutForm();
  refreshCutRangePreviews();
}

/** Params for POST /ops/cut from global video + frame range. */
function collectCutBody() {
  const videoPath = resolveCutVideoPath();
  if (!videoPath) {
    alert('Set a video in the global Video file(s) bar.');
    return null;
  }
  const { start, end } = workingRange();
  const outEl = document.getElementById('cutOutput');
  return {
    input_path: videoPath,
    output_path: (outEl && outEl.value.trim()) || null,
    start_frame: start,
    end_frame: end,
    dry_run: false,
  };
}

function _bindCutForm() {
  const enc = document.getElementById('btnCutEncode');
  if (enc) {
    enc.addEventListener('click', async () => {
      const body = collectCutBody();
      if (!body) return;
      try {
        await runOpWithCancel('cut', body, { label: 'Encoding cut…' });
      } catch (_) { /* logged */ }
    });
  }

  _compareCtl = bindCompareControls({
    idPrefix: CUT_COMPARE_PREFIX,
    getState: () => _cutCompareState(),
    setState: (partial) => {
      const cut = ensureCut();
      if (partial.mode != null) {
        cut.mode = partial.mode;
        cut.compareMode = partial.mode;
      }
      if (partial.overlayOpacity != null) cut.overlayOpacity = partial.overlayOpacity;
      if (partial.abPosition != null) cut.abPosition = partial.abPosition;
    },
    getViewports: () => [
      document.getElementById('cutFirstFrame'),
      document.getElementById('cutLastFrame'),
    ],
    onModeChange: () => renderCutForm(),
  });

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

export { renderCutForm, ensureCut, resolveCutVideoPath, refreshCutRangePreviews, collectCutBody };
