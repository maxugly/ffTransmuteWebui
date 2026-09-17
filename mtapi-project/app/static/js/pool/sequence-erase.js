// Sequence Erase → RIFE → Conform client (vanilla ES6, no framework).
// Spec: docs/sequence-erase-pipeline-spec.md. Sequence-local masks +
// batch orchestration over the existing erase_remove / rife / conform ops.
//
// Identity: lineageId groups occurrences of one source (sequence[].id stays
// the occurrence identity). Masks belong to the lineage. Erase always starts
// from entry.path (the original) — never variantPath/conformedPath.
import { state, logConsole } from '/app.js';
import { basename, escapeHtml } from '/js/utils.js';
import { scheduleSavePoolState } from '/js/pool/persistence.js';

const ERASE_W = 960;
const ERASE_H = 540;
// Backing-store cap: the paint canvas is aspect-matched to the frame on
// load (base.naturalWidth/Height), never stretched. ERASE_MAX bounds the
// long side; PW/PH below carry the live dims for this editor instance.
const ERASE_MAX = 960;
const MASK_TTL_MS = 15000;

const _maskCache = new Map(); // lineageId → { at, record }
let _eraseRunState = new Map(); // lineageId → 'running' | 'done' | 'failed'

function _uuid() {
  try {
    if (crypto?.randomUUID) return crypto.randomUUID();
  } catch (_) { /* fall through */ }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function _isUuid(v) {
  return typeof v === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.trim());
}

/** Migration: one lineageId per distinct canonical source path (no media reads). */
function ensureSequenceLineages() {
  const byPath = new Map();
  const seq = state.pool.sequence || [];
  for (const e of seq) {
    if (!e || !e.path) continue;
    if (!_isUuid(e.lineageId)) {
      if (!byPath.has(e.path)) {
        const reuse = seq.find((o) => o && o.path === e.path && _isUuid(o.lineageId));
        byPath.set(e.path, reuse ? reuse.lineageId : _uuid());
      }
      e.lineageId = byPath.get(e.path);
    } else if (!byPath.has(e.path)) {
      byPath.set(e.path, e.lineageId);
    }
  }
  // Pool items mirror the lineage for save/load stability.
  for (const it of state.pool.items || []) {
    if (!it || !it.path) continue;
    if (byPath.has(it.path)) it.lineageId = byPath.get(it.path);
    else if (!_isUuid(it.lineageId)) it.lineageId = _uuid();
  }
  return byPath;
}

function eraseLineageId(entry) {
  if (!entry) return null;
  if (_isUuid(entry.lineageId)) return entry.lineageId;
  ensureSequenceLineages();
  return _isUuid(entry.lineageId) ? entry.lineageId : null;
}

async function fetchLineageMask(lid) {
  const hit = _maskCache.get(lid);
  if (hit && (Date.now() - hit.at) < MASK_TTL_MS) return hit.record;
  try {
    const res = await fetch(`/api/lineages/${encodeURIComponent(lid)}`);
    const data = await res.json();
    const rec = data && data.ok ? data.mask || null : null;
    _maskCache.set(lid, { at: Date.now(), record: rec });
    return rec;
  } catch (_) {
    return hit ? hit.record : null;
  }
}

function invalidateMaskCache(lid) {
  if (lid) _maskCache.delete(lid);
  else _maskCache.clear();
}

/** Chip marker: mask dot + stale marker (mask changed after processing). */
function eraseBadgeForEntry(entry) {
  if (!entry || !entry.eraseMaskId) return null;
  const cleanMask = entry.cleanSignature && entry.cleanSignature.mask_id;
  if (entry.cleanPath && cleanMask && cleanMask !== entry.eraseMaskId) {
    return {
      text: 'ERASE!',
      cls: 'seq-erase-badge is-stale',
      title: [
        'STATE: erase stale — the mask changed after this clean was made.',
        'Run the erase pipeline again to regenerate.',
      ].join('\n'),
    };
  }
  return {
    text: 'ERASE',
    cls: 'seq-erase-badge is-done',
    title: [
      'STATE: erase mask saved for this clip lineage.',
      `Mask: ${entry.eraseMaskId.slice(0, 12)}…`,
      entry.cleanPath ? `Clean: ${basename(entry.cleanPath)}` : 'Clean: not run',
    ].join('\n'),
  };
}

// ── selected-clip panel ───────────────────────────────────────────────────

function _selectedEntry() {
  const id = state.pool.selectedSeqId;
  const seq = state.pool.sequence || [];
  if (id != null) {
    const hit = seq.find((e) => String(e.id) === String(id));
    if (hit) return hit;
  }
  const idx = seq.findIndex((e) => e.path === state.pool.selectedPath);
  return idx >= 0 ? seq[idx] : null;
}

function _eraseSettings(entry) {
  const s = (entry && entry.eraseSettings) || {};
  return {
    hd_strategy: s.hd_strategy || 'Crop',
    crop_trigger: Number(s.crop_trigger) || 800,
    crop_margin: Number(s.crop_margin) || 128,
    resize_limit: Number(s.resize_limit) || 1280,
    device: s.device || 'GPU',
  };
}

/** Plain-language Source/Mask/Clean/RIFE/Conform state (spec §4.1). */
async function updateErasePanel() {
  const box = document.getElementById('seqEraseBox');
  if (!box) return;
  const entry = _selectedEntry();
  if (!entry) {
    box.innerHTML = '';
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const lid = eraseLineageId(entry);
  const mask = lid ? await fetchLineageMask(lid) : null;
  const maskId = mask ? mask.mask_id : (entry.eraseMaskId || null);
  const rifeTxt = entry.variantPath && entry.variantPath !== entry.path
    ? `selected ${basename(entry.variantPath)}`
    : (entry.rifeNeed === 'needsRife' ? 'will run' : 'not needed');
  const cleanTxt = entry.cleanPath ? basename(entry.cleanPath) : 'not run';
  const confTxt = entry.conformedPath ? basename(entry.conformedPath) : 'ready after RIFE';
  const runState = lid ? _eraseRunState.get(lid) : null;
  box.innerHTML = `
    <div class="seq-erase-lines" role="status">
      <span>Source: ${escapeHtml(basename(entry.path))}</span>
      <span>Mask: ${maskId ? `saved · ${mask.width}×${mask.height}` : 'none'}</span>
      <span>Clean: ${escapeHtml(cleanTxt)}</span>
      <span>RIFE: ${escapeHtml(rifeTxt)}</span>
      <span>Conform: ${escapeHtml(confTxt)}</span>
      ${runState ? `<span>Pipeline: ${escapeHtml(runState)}</span>` : ''}
    </div>
    <div class="seq-erase-btns">
      <button type="button" class="btn pool-info-mini" id="btnEraseMask">${maskId ? 'Edit erase mask' : 'Set erase mask'}</button>
      ${maskId ? '<button type="button" class="btn pool-info-mini" id="btnEraseMaskClear">Clear erase mask</button>' : ''}
      <button type="button" class="btn pool-info-mini" id="btnEraseRunSel" ${maskId ? '' : 'disabled'}>Run selected erase pipeline</button>
    </div>`;
  document.getElementById('btnEraseMask')?.addEventListener('click', () => openEraseMaskEditor(entry));
  document.getElementById('btnEraseMaskClear')?.addEventListener('click', () => clearEraseMask(entry));
  document.getElementById('btnEraseRunSel')?.addEventListener('click', () => runErasePipeline({ selectedOnly: true }));
}

// ── mask editor ───────────────────────────────────────────────────────────
// Paint canvas over the ORIGINAL source frame (pool thumb of entry.path),
// even when the Sequence shows a RIFE/conformed variant (spec §4.1).

function openEraseMaskEditor(entry) {
  closeEraseMaskEditor();
  const lid = eraseLineageId(entry);
  if (!lid) {
    logConsole('[ERASE]: no lineage for this clip', 'error');
    return;
  }
  const overlay = document.createElement('div');
  overlay.className = 'seq-erase-modal';
  overlay.id = 'seqEraseModal';
  overlay.innerHTML = `
    <div class="seq-erase-dialog" role="dialog" aria-label="Erase mask editor">
      <div class="seq-erase-title">Erase mask — ${escapeHtml(basename(entry.path))} <span class="seq-erase-sub">(original frame)</span></div>
      <div class="seq-erase-stage">
        <img id="seqEraseBase" alt="Original source frame">
        <canvas id="seqErasePaint" width="${ERASE_W}" height="${ERASE_H}"></canvas>
      </div>
      <div class="seq-erase-hint">Paint the watermark. Left-drag = paint, right-drag/Shift = erase, wheel = brush size. Empty canvas = rect fallback below.</div>
      <div class="seq-erase-row">
        <label>Brush <input type="number" id="seqEraseBrush" min="2" max="120" value="24"></label>
        <button type="button" class="btn pool-info-mini" id="seqEraseUndo">Undo</button>
        <button type="button" class="btn pool-info-mini" id="seqEraseClearC">Clear</button>
        <label title="Rect fallback when nothing is painted (area capped 25%)">Rect
          <input type="text" id="seqEraseRect" value="0.80,0.84,0.17,0.12" size="20">
        </label>
      </div>
      <div class="seq-erase-row">
        <label>HD <select id="seqEraseHD"><option>Crop</option><option>Original</option><option>Resize</option></select></label>
        <label>Device <select id="seqEraseDev"><option>GPU</option><option>CPU</option><option>AUTO</option></select></label>
        <span style="flex:1"></span>
        <button type="button" class="btn pool-info-mini" id="seqEraseCancel">Cancel</button>
        <button type="button" class="btn btn-primary" id="seqEraseSave">Save mask</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const paint = overlay.querySelector('#seqErasePaint');
  const pctx = paint.getContext('2d');
  // Transparent black = empty mask. NEVER fill opaque: the backend decodes
  // the mask PNG by its alpha channel, so an opaque background reads as a
  // 100% mask and LaMA regenerates the whole frame as texture.
  let PW = ERASE_W;
  let PH = ERASE_H;
  pctx.clearRect(0, 0, paint.width, paint.height);
  const undoStack = [];
  let brush = 24;
  let drawing = false;
  let erasing = false;

  const base = overlay.querySelector('#seqEraseBase');
  base.onload = () => {
    try {
      const nw = base.naturalWidth || 0;
      const nh = base.naturalHeight || 0;
      if (nw > 0 && nh > 0) {
        const s = Math.min(1, ERASE_MAX / Math.max(nw, nh));
        PW = Math.max(2, Math.round(nw * s));
        PH = Math.max(2, Math.round(nh * s));
        paint.width = PW;
        paint.height = PH;
        pctx.clearRect(0, 0, PW, PH);
        const stage = overlay.querySelector('.seq-erase-stage');
        if (stage) stage.style.aspectRatio = PW + ' / ' + PH;
        undoStack.length = 0;
        pushUndo();
      }
    } catch (_) { /* keep 960x540 fallback */ }
  };
  base.src = `/api/thumbnail?path=${encodeURIComponent(entry.path)}&which=first`;
  base.onerror = () => { base.style.display = 'none'; };

  const pushUndo = () => {
    try {
      undoStack.push(pctx.getImageData(0, 0, paint.width, paint.height));
      if (undoStack.length > 40) undoStack.shift();
    } catch (_) { /* ignore */ }
  };
  pushUndo();

  const pos = (e) => {
    const r = paint.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * PW,
      y: ((e.clientY - r.top) / r.height) * PH,
    };
  };
  const dot = (x, y, erase) => {
    pctx.save();
    if (erase) {
      // Erase back to transparency (unmasked), not to opaque black.
      pctx.globalCompositeOperation = 'destination-out';
      pctx.fillStyle = 'rgba(0,0,0,1)';
    } else {
      pctx.fillStyle = '#fff';
    }
    pctx.beginPath();
    pctx.arc(x, y, brush / 2, 0, Math.PI * 2);
    pctx.fill();
    pctx.restore();
  };
  paint.addEventListener('contextmenu', (e) => e.preventDefault());
  paint.addEventListener('pointerdown', (e) => {
    drawing = true;
    erasing = e.button === 2 || e.shiftKey;
    pushUndo();
    paint.setPointerCapture(e.pointerId);
    const p = pos(e);
    dot(p.x, p.y, erasing);
  });
  paint.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const p = pos(e);
    dot(p.x, p.y, e.shiftKey ? true : erasing);
  });
  const stop = () => { drawing = false; };
  paint.addEventListener('pointerup', stop);
  paint.addEventListener('pointercancel', stop);
  paint.addEventListener('wheel', (e) => {
    e.preventDefault();
    brush = Math.max(2, Math.min(120, brush + (e.deltaY < 0 ? 4 : -4)));
    const inp = overlay.querySelector('#seqEraseBrush');
    if (inp) inp.value = String(brush);
  }, { passive: false });

  overlay.querySelector('#seqEraseBrush')?.addEventListener('input', (e) => {
    brush = Math.max(2, Math.min(120, Number(e.target.value) || 24));
  });
  overlay.querySelector('#seqEraseUndo')?.addEventListener('click', () => {
    const prev = undoStack.pop();
    if (prev) {
      try { pctx.putImageData(prev, 0, 0); } catch (_) { /* ignore */ }
    }
    if (!undoStack.length) pushUndo();
  });
  overlay.querySelector('#seqEraseClearC')?.addEventListener('click', () => {
    pushUndo();
    pctx.clearRect(0, 0, paint.width, paint.height);
  });
  overlay.querySelector('#seqEraseCancel')?.addEventListener('click', closeEraseMaskEditor);
  overlay.addEventListener('pointerdown', (e) => {
    if (e.target === overlay) closeEraseMaskEditor();
  });
  const esc = (e) => {
    if (e.key === 'Escape') {
      closeEraseMaskEditor();
      document.removeEventListener('keydown', esc);
    }
  };
  document.addEventListener('keydown', esc);

  const prior = _eraseSettings(entry);
  const hd = overlay.querySelector('#seqEraseHD');
  const dev = overlay.querySelector('#seqEraseDev');
  if (hd) hd.value = prior.hd_strategy;
  if (dev) dev.value = prior.device;

  overlay.querySelector('#seqEraseSave')?.addEventListener('click', async () => {
    const cov = (() => {
      // Alpha channel decides server-side: sample the white fraction.
      try {
        const d = pctx.getImageData(0, 0, paint.width, paint.height).data;
        let n = 0;
        let hit = 0;
        for (let i = 3; i < d.length; i += 401 * 4) {
          n++;
          if (d[i] > 127) hit++;
        }
        return n ? hit / n : 0;
      } catch (_) { return 0; }
    })();
    const hasPaint = cov > 0;
    if (cov > 0.25 && !confirm(
      `Mask covers ${Math.round(cov * 100)}% of the frame (cap 25%) — ` +
      `LaMA hallucinates at that scale and the run will be refused. ` +
      `Save anyway?`)) {
      return;
    }
    let dataUrl = paint.toDataURL('image/png');
    if (!hasPaint) {
      // Rect fallback: clear canvas, then fill the normalized rect.
      const raw = (overlay.querySelector('#seqEraseRect').value || '').split(',').map(Number);
      const [rx, ry, rw, rh] = raw.length === 4 && raw.every(Number.isFinite) ? raw : [0.8, 0.84, 0.17, 0.12];
      pctx.clearRect(0, 0, paint.width, paint.height);
      pctx.fillStyle = '#fff';
      pctx.fillRect(rx * PW, ry * PH, rw * PW, rh * PH);
      dataUrl = paint.toDataURL('image/png');
    }
    const settings = {
      hd_strategy: hd ? hd.value : 'Crop',
      crop_trigger: 800, crop_margin: 128, resize_limit: 1280,
      device: dev ? dev.value : 'GPU',
    };
    await saveEraseMask(entry, dataUrl, settings, paint.width, paint.height);
    closeEraseMaskEditor();
  });
}

function closeEraseMaskEditor() {
  document.getElementById('seqEraseModal')?.remove();
}

async function saveEraseMask(entry, maskDataUrl, settings, mw, mh) {
  const lid = eraseLineageId(entry);
  if (!lid) return false;
  let res;
  try {
    res = await fetch(`/api/lineages/${encodeURIComponent(lid)}/mask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mask_b64: maskDataUrl, width: mw || ERASE_W, height: mh || ERASE_H,
        erase_settings: settings,
      }),
    });
  } catch (e) {
    logConsole(`[ERASE]: mask save failed — ${e.message}`, 'error');
    return false;
  }
  let data = null;
  try { data = await res.json(); } catch (_) { /* ignore */ }
  if (!data || !data.ok) {
    logConsole(`[ERASE]: mask save failed — ${data?.error || res.status}`, 'error');
    return false;
  }
  const rec = data.mask || null;
  entry.eraseSettings = { ...(rec?.erase_settings || settings) };
  entry.eraseMaskId = rec ? rec.mask_id : null;
  // Same lineage shares the mask: other occurrences pick up the new mask id
  // and their old clean artifacts read stale automatically (badge rule).
  for (const o of state.pool.sequence || []) {
    if (o !== entry && o.lineageId === lid) o.eraseMaskId = entry.eraseMaskId;
  }
  if (!state.pool.lineages || typeof state.pool.lineages !== 'object') {
    state.pool.lineages = {};
  }
  state.pool.lineages[lid] = {
    original_path: entry.path,
    mask_id: entry.eraseMaskId,
    mask_path: rec?.mask_path || null,
    width: mw || ERASE_W, height: mh || ERASE_H,
    erase_settings: entry.eraseSettings,
  };
  invalidateMaskCache(lid);
  logConsole(`[ERASE]: mask saved for ${basename(entry.path)} (${mw || ERASE_W}×${mh || ERASE_H}) — pipeline will regenerate clean/RIFE/conform`);
  scheduleSavePoolState();
  try {
    const { renderSequenceBox } = await import('/js/pool/sequence-composer.js');
    renderSequenceBox({ skipInstantKick: true });
  } catch (_) { /* render optional */ }
  updateErasePanel();
  return true;
}

async function clearEraseMask(entry) {
  const lid = eraseLineageId(entry);
  if (!lid) return;
  if (!confirm(`Clear the erase mask for ${basename(entry.path)}? Saved clean/RIFE/conform files are kept on disk.`)) return;
  try {
    await fetch(`/api/lineages/${encodeURIComponent(lid)}/mask`, { method: 'DELETE' });
  } catch (_) { /* ignore */ }
  entry.eraseMaskId = null;
  for (const o of state.pool.sequence || []) {
    if (o.lineageId === lid) o.eraseMaskId = null;
  }
  if (state.pool.lineages) delete state.pool.lineages[lid];
  invalidateMaskCache(lid);
  logConsole(`[ERASE]: mask cleared for ${basename(entry.path)}`);
  scheduleSavePoolState();
  try {
    const { renderSequenceBox } = await import('/js/pool/sequence-composer.js');
    renderSequenceBox({ skipInstantKick: true });
  } catch (_) { /* ignore */ }
  updateErasePanel();
}

// ── batch ─────────────────────────────────────────────────────────────────

async function _rifePlanFor(entry) {
  try {
    const { _densityInfoForEntry } = await import('/js/pool/sequence-rife.js');
    const info = _densityInfoForEntry(entry);
    if (info && info.needed) {
      return { enabled: true, multiplier: Math.max(2, Math.min(128, info.multiplier || 2)) };
    }
  } catch (_) { /* density rules unavailable */ }
  if (entry.rifeNeed === 'needsRife') return { enabled: true, multiplier: 2 };
  return { enabled: false, multiplier: 2 };
}

function _conformPlanFor() {
  try {
    const c = state.pool;
    if (!c.conformEnabled) return { enabled: false };
    return {
      enabled: true,
      mode: c.conformMode || c.reconcile || 'pad',
      aspect: c.aspectCustom && c.aspect === 'custom' ? c.aspectCustom : (c.aspect || '16:9'),
      width: null, height: null, // backend derives via the join canvas rule
      target_fps: c.conformTargetFps || null,
      preset: c.conformPreset || 'h264_avc_hq',
      audio_policy: 'encoded',
    };
  } catch (_) {
    return { enabled: false };
  }
}

async function collectEraseItems(selectedOnly) {
  ensureSequenceLineages();
  const seq = state.pool.sequence || [];
  const scope = selectedOnly
    ? ([_selectedEntry()].filter(Boolean))
    : seq.slice();
  const groups = new Map(); // lineageId → entries
  for (const e of scope) {
    const lid = eraseLineageId(e);
    if (!lid) continue;
    if (!groups.has(lid)) groups.set(lid, []);
    groups.get(lid).push(e);
  }
  const items = [];
  const skipped = [];
  for (const [lid, entries] of groups) {
    const mask = await fetchLineageMask(lid);
    const first = entries[0];
    if (!mask) {
      skipped.push({ lineage_id: lid, name: basename(first.path), reason: 'no mask' });
    }
    const rife = await _rifePlanFor(first);
    const conform = _conformPlanFor();
    // Original source only — never variantPath/conformedPath (spec §5.1).
    items.push({
      lineage_id: lid,
      original_path: first.path,
      erase: _eraseSettings(first),
      rife: {
        ...rife, model: 'rife-v4.6', tta: false, uhd: false,
        target_fps: state.pool.targetFps || null,
      },
      conform,
      occurrences: entries.map((e) => ({
        occurrence_id: String(e.id),
        target_duration: e.targetDuration || null,
        conformed_path: e.conformedPath || null,
        conform_signature: e.conformSignature || null,
      })),
    });
    // Remember the active mask id so chips can show stale markers later.
    if (mask) {
      for (const e of entries) e.eraseMaskId = mask.mask_id;
    }
  }
  return { items, skipped };
}

function _logStageLine(idx, total, name, stage) {
  logConsole(`[ERASE]: Erase pipeline ${idx + 1}/${total} · ${name} · ${stage}`);
}

async function applyEraseAdoptions(batchItems, planItems) {
  const seq = state.pool.sequence || [];
  const byId = new Map(seq.map((e) => [String(e.id), e]));
  const planByLid = new Map((planItems || []).map((p) => [p.lineage_id, p]));
  let touched = 0;
  for (const it of batchItems || []) {
    if (it.status !== 'completed' && !(it.adoptions && it.adoptions.length)) continue;
    for (const ad of it.adoptions || []) {
      const e = byId.get(String(ad.occurrence_id));
      if (!e) continue;
      if (ad.clean_path) {
        e.cleanPath = ad.clean_path;
        e.cleanSignature = it.clean_signature || e.cleanSignature || null;
        if (it.clean_signature && it.clean_signature.mask_id) {
          e.eraseMaskId = it.clean_signature.mask_id;
        }
      }
      if (ad.variant_path) {
        e.variantPath = ad.variant_path;
        e._rifeStatus = 'done';
        const plan = planByLid.get(it.lineage_id);
        const m = plan && plan.rife && Number(plan.rife.multiplier);
        if (m >= 2) e._rifeMultiplier = m;
      }
      if (ad.conformed_path) {
        e.conformedPath = ad.conformed_path;
        e.conformSignature = ad.conform_signature || null;
        e.conformStatus = 'valid';
      }
      e.eraseRunStatus = it.status;
      e.eraseRunError = it.error || ad.error || null;
      touched += 1;
    }
    if (it.status === 'failed' || it.status === 'cancelled') {
      for (const oid of it.occurrence_ids || []) {
        const e = byId.get(String(oid));
        if (e && !e.eraseRunStatus) {
          e.eraseRunStatus = it.status;
          e.eraseRunError = it.error || null;
        }
      }
    }
  }
  // RIFE multiplier bookkeeping: keep the planned M so Instant does not re-encode.
  try {
    const { refreshRifeNeed } = await import('/js/pool/sequence-rife.js');
    for (const e of seq) {
      try { refreshRifeNeed(e); } catch (_) { /* ignore */ }
    }
  } catch (_) { /* ignore */ }
  return touched;
}

async function runErasePipeline({ selectedOnly = false, dryRun = false } = {}) {
  const { items, skipped } = await collectEraseItems(selectedOnly);
  if (skipped.length) {
    for (const s of skipped) {
      logConsole(`[ERASE]: skipped ${s.name} — ${s.reason}`);
    }
  }
  if (!items.length) {
    logConsole('[ERASE]: nothing eligible — select a masked clip first', 'error');
    return null;
  }
  const total = items.length;
  for (let i = 0; i < items.length; i++) {
    _eraseRunState.set(items[i].lineage_id, 'running');
  }
  updateErasePanel();
  let data = null;
  try {
    const { runOpWithCancel } = await import('/js/job-control.js');
    data = await runOpWithCancel('erase_pipeline', { items, dry_run: dryRun }, {
      label: dryRun ? 'Erase pipeline (plan)…' : 'Erase pipeline…',
    });
  } catch (e) {
    logConsole(`[ERASE]: pipeline failed to start — ${e.message}`, 'error');
    for (const it of items) _eraseRunState.set(it.lineage_id, 'failed');
    updateErasePanel();
    return null;
  }
  const meta = (data && data.meta) || {};
  const batch = meta.items || [];
  // Ordered evidence: erase → RIFE → conform per lineage (spec §4.2).
  batch.forEach((it, i) => {
    const plan = items[i] || {};
    const name = basename(plan.original_path || it.lineage_id);
    const stages = ['erase'];
    if (it.variant_path || (dryRun && plan.rife && plan.rife.enabled)) {
      stages.push(`RIFE ×${plan.rife?.multiplier || '?'}`);
    }
    if ((it.adoptions || []).some((a) => a.conformed_path)
        || (dryRun && plan.conform && plan.conform.enabled)) {
      stages.push('conform');
    }
    stages.push(it.status === 'completed' ? 'complete' : it.status);
    _logStageLine(i, total, name, stages[0]);
    for (const s of stages.slice(1)) _logStageLine(i, total, name, s);
  });
  // Proof/debug surface: last batch response (used by Playwright proof).
  try { window.__lastErasePipeline = data; } catch (_) { /* ignore */ }
  const touched = dryRun ? 0 : await applyEraseAdoptions(batch, items);
  if (dryRun) {
    logConsole(`[ERASE]: dry run — plan only, nothing adopted (${items.length} lineage(s))`);
  }
  for (const it of batch) {
    _eraseRunState.set(it.lineage_id, it.status === 'completed' ? 'done' : it.status);
  }
  const s = meta.summary || {};
  logConsole(`[ERASE]: pipeline ${s.completed || 0}/${s.total || 0} completed `
    + `(${s.skipped || 0} skipped, ${s.failed || 0} failed, ${s.cancelled || 0} cancelled) · ${touched} occurrence(s) updated`);
  try {
    const { _invalidateVariantsCache } = await import('/js/pool/sequence-variants.js');
    for (const it of items) _invalidateVariantsCache(it.original_path);
  } catch (_) { /* ignore */ }
  scheduleSavePoolState();
  try {
    const { renderSequenceBox } = await import('/js/pool/sequence-composer.js');
    renderSequenceBox({ skipInstantKick: true });
  } catch (_) { /* ignore */ }
  updateErasePanel();
  return data;
}

/** Clear progress/status states and stale markers (spec controls). */
async function clearEraseStatus() {
  _eraseRunState = new Map();
  for (const e of state.pool.sequence || []) {
    e.eraseRunStatus = null;
    e.eraseRunError = null;
  }
  logConsole('[ERASE]: status cleared');
  scheduleSavePoolState();
  try {
    const { renderSequenceBox } = await import('/js/pool/sequence-composer.js');
    renderSequenceBox({ skipInstantKick: true });
  } catch (_) { /* ignore */ }
  updateErasePanel();
}

function initSequenceErase() {
  document.getElementById('btnEraseRunAll')?.addEventListener('click', () => runErasePipeline({}));
  document.getElementById('btnEraseClear')?.addEventListener('click', clearEraseStatus);
  try { ensureSequenceLineages(); } catch (_) { /* ignore */ }
}

export {
  ensureSequenceLineages, eraseLineageId, fetchLineageMask,
  eraseBadgeForEntry, updateErasePanel,
  openEraseMaskEditor, closeEraseMaskEditor, saveEraseMask, clearEraseMask,
  collectEraseItems, applyEraseAdoptions, runErasePipeline, clearEraseStatus,
  initSequenceErase, ERASE_W, ERASE_H,
};
