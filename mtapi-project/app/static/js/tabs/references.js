/**
 * References tab — two sub-tabs sharing one bare workspace:
 *   YT Footage (license/disclosure/monetize/watermarks/strategy cards)
 *   Video Models (the Big Chart — one card, one table)
 * Left nav (.nav-item data-tab="refs" / "refs-models") and the top
 * segmented bar stay in sync via switchTab.
 */
import { state, elements, switchTab } from '/app.js';
import { escapeHtml } from '/js/utils.js';

const SVG_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
const SVG_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
const SVG_WARN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>';
const SVG_INFO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>';
const SVG_EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>';
const SVG_SHIELD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></svg>';
const SVG_MONEY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" x2="12" y1="2" y2="22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>';
const SVG_LAYERS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/><path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"/><path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"/></svg>';
const SVG_UPRIGHT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7"/><path d="M7 7h10v10"/></svg>';
const SVG_FILM = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="14" rx="2"/><line x1="8" y1="22" x2="16" y2="22"/><line x1="12" y1="18" x2="12" y2="22"/></svg>';

function renderReferencesForm() {
  const sub = state.activeTab === 'refs-models' ? 'models'
    : state.activeTab === 'refs-images' ? 'imgmodels' : 'yt';
  const wide = sub === 'models' || sub === 'imgmodels';
  const html = `
    <div class="ref-workspace${wide ? ' ref-workspace-wide' : ''}">
      <div class="ref-subtabs" id="refSubtabs">
        <button class="ref-subtab${sub === 'yt' ? ' active' : ''}" data-ref-tab="refs">YT Footage</button>
        <button class="ref-subtab${sub === 'models' ? ' active' : ''}" data-ref-tab="refs-models">Video Models</button>
        <button class="ref-subtab${sub === 'imgmodels' ? ' active' : ''}" data-ref-tab="refs-images">Image Models</button>
      </div>
      ${sub === 'models' ? buildModelsSection() : sub === 'imgmodels' ? buildImageModelsSection() : buildYtSections()}
    </div>
  `;
  elements.actionPanel.innerHTML = html;
  (elements.actionPanelRoot || elements.actionPanel).classList.add('ref-active');
  elements.actionPanel.querySelectorAll('#refSubtabs .ref-subtab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-ref-tab');
      if (target && target !== state.activeTab) switchTab(target);
    });
  });
  bindSortableTables();
}

function buildYtSections() {
  return `
      ${buildLicenseSection()}
      <div class="ref-grid-2col">
        ${buildDisclosureSection()}
        ${buildMonetizeSection()}
      </div>
      <div class="ref-grid-2col">
        ${buildWatermarksSection()}
        ${buildStrategySection()}
      </div>
  `;
}

/* ═══════════════════════════════════════════════
   Video Models — The Big Chart (one card, one table)
   ═══════════════════════════════════════════════ */
const MODELS_ROWS = [
  { model: 'LTX-Video 2B / 13B', native: '512x768 — trained solely on 512x768', sweet: '768x512 / 640x640', warn: 'larger outputs may not improve quality', max: '768x768', dur: '5s', notes: 'Super cheap, super coherent at low res' },
  { model: 'LTX 2.0', native: '720p base', sweet: '768x448', max: '1280x704', dur: '5-6s', notes: '' },
  { model: 'LTX 2.3', native: '1080p (4K support)', sweet: '960x960', max: '4K', dur: '5-8s', notes: "First LTX that's true 1080p native" },
  { model: 'Wan 2.1 1.3B', native: '480p', sweet: '480p — 720p possible but less stable than 480p', max: '720p', dur: '5s', notes: '' },
  { model: 'Wan 2.1 14B / 2.2', native: '480p + 720p', sweet: '720p', max: '720p', dur: '5s', notes: '' },
  { model: 'Seedance 1.0 Lite', native: '480p-720p', sweet: '480p rapid iteration, 720p balanced', max: '720p', dur: '5s', notes: '' },
  { model: 'Seedance 1.0 Pro / Pro Fast', native: '1080p max but trained 720p', sweet: '720p / 640x640 — 1080p is final polish tier', max: '1080p', dur: '5-6s', notes: 'Your current model', highlight: true },
  { model: 'Seedance 2.0', native: '1080p+', sweet: '720p — outputs 480p/720p/1080p/4K, Fast only 480p/720p', max: '4K / 1080p', dur: '5-10s multi-shot', notes: 'Native audio now' },
  { model: 'Seedance 2.5 / 3.0', native: '1080p/4K', sweet: '720p for physics, 1080p for final', max: '4K', dur: '10-15s', notes: 'Same family' },
  { model: 'Hailuo 2.3 / 02', native: '768p / 1080p', sweet: '768p — tier is 512p/768p/1080p, 768p is default physics', max: '1080p (6s only at 1080p)', dur: '6s', notes: '' },
  { model: 'Vidu 1.0 / 1.5 / 2.0', native: '1080p', sweet: '540p drafts, 720p default, 1080p final', max: '1080p', dur: '4s or 8s', notes: '' },
  { model: 'Vidu Q1 / Q3-Pro / S1', native: '540p / 1080p', sweet: '720p default', max: '1080p up to 16s', dur: 'Flexible 1-16s', notes: 'Q3 = best audio' },
  { model: 'Kling 2.0 / 2.1 / 2.5 Turbo / 2.6', native: '1080p', sweet: '720p Standard (~1300x708), 1080p Pro', max: '1080p', dur: '5-10s', notes: 'Standard = 720p, Pro = 1080p' },
  { model: 'Kling 3.0 / O3', native: 'Native 4K — 3840x2160 native rendering, no upscaling', sweet: '1080p Pro for physics, 4K for final — max 4K (3840x2160)', max: '4K 60fps', dur: '10-15s', notes: 'First true native 4K model' },
  { model: 'Luma Ray2', native: '540p/720p', sweet: '720p', max: '720p', dur: '5-9s', notes: '' },
  { model: 'Luma Ray3 / Ray3.14', native: 'Native 1080p — delivering native 1080p', sweet: '1080p — architecture scaled to produce crisp 1080p natively', max: '1080p + 4K upscaler', dur: '5-10s', notes: 'Your best for wall crash debris', highlight: true },
  { model: 'Veo 3 / Veo 3 Fast / Veo 3.1', native: '720p/1080p/4K', sweet: '720p default, 1080p or 4K for final', max: '4K', dur: '8s', notes: 'Fast = double speed at 720p, Standard = HQ' },
  { model: 'Pixverse 6.0 / Real Motion 3.5 Turbo / Motion 2.0', native: '720p', sweet: '640x640 / 720p', max: '1080p', dur: '—', notes: '' },
];

/* ── Generic sortable-table helpers (Video + Image models) ── */
function sortRows(rows, sort, valueFn, tieFn) {
  const { key, dir } = sort;
  return [...rows].sort((a, b) => {
    const va = valueFn(a, key);
    const vb = valueFn(b, key);
    if (!va && vb) return 1;   // empties always last
    if (va && !vb) return -1;
    if (!va && !vb) return 0;
    const cmp = va.localeCompare(vb, undefined, { numeric: true, sensitivity: 'base' });
    if (cmp !== 0 || !tieFn) return cmp * dir;
    return tieFn(a, b);        // tiebreak always ascending
  });
}

function sortHeaders(cols, sort) {
  return cols.map((c) => `<th data-sort="${c.key}" class="sortable${sort.key === c.key ? ' sorted' : ''}">${esc(c.label)}<span class="ref-sort-arrow">${sort.key === c.key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}</span></th>`).join('');
}

function paintSortableTable(table, cfg) {
  const tbody = table.querySelector('tbody');
  if (tbody) tbody.innerHTML = sortRows(cfg.rows, cfg.sort, cfg.valueFn, cfg.tieFn).map(cfg.rowFn).join('');
  table.querySelectorAll('th[data-sort]').forEach((th) => {
    const active = th.getAttribute('data-sort') === cfg.sort.key;
    th.classList.toggle('sorted', active);
    const arrow = th.querySelector('.ref-sort-arrow');
    if (arrow) arrow.textContent = active ? (cfg.sort.dir === 1 ? ' ▲' : ' ▼') : '';
  });
}

function bindSortableTables() {
  const table = elements.actionPanel.querySelector('.ref-models-table');
  if (!table) return;
  const cfg = table.getAttribute('data-mtable') === 'image' ? imageTableCfg() : videoTableCfg();
  table.querySelectorAll('th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.getAttribute('data-sort');
      if (cfg.sort.key === key) {
        cfg.sort.dir *= -1;
      } else {
        cfg.sort.key = key;
        cfg.sort.dir = 1;
      }
      paintSortableTable(table, cfg);
    });
  });
}

/* Sort state — defaults: Video = Model A→Z, Image = Company A→Z */
let modelsSort = { key: 'model', dir: 1 };
let imageModelsSort = { key: 'company', dir: 1 };

const MODELS_COLS = [
  { key: 'model', label: 'Model' },
  { key: 'native', label: 'Native Training Res' },
  { key: 'sweet', label: 'Sweet Spot for Physics / Coherence — Cheap' },
  { key: 'max', label: 'Max Output' },
  { key: 'dur', label: 'Duration Sweet Spot' },
  { key: 'notes', label: 'Notes' },
];

function modelsSortValue(r, key) {
  if (key === 'sweet') return [r.sweet, r.warn || ''].filter((v) => v && v !== '—').join(' — ');
  const v = r[key] || '';
  return v === '—' ? '' : v;
}

function videoTableCfg() {
  return { rows: MODELS_ROWS, sort: modelsSort, valueFn: modelsSortValue, tieFn: null, rowFn: modelRow };
}

function buildModelsSection() {
  return `
    <div class="ref-card">
      <div class="ref-card-head">
        <div class="ref-card-head-icon">${SVG_FILM}</div>
        <h2>Video Models<span class="ref-sub">The Big Chart — native res, cheap physics sweet spot, max output</span></h2>
      </div>
      <div class="ref-card-body ref-table-scroll">
        <table class="ref-table ref-models-table" data-mtable="video">
          <thead><tr>
            ${sortHeaders(MODELS_COLS, modelsSort)}
          </tr></thead>
          <tbody>
            ${sortRows(MODELS_ROWS, modelsSort, modelsSortValue, null).map(modelRow).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

function modelRow(r) {
  const sweet = r.warn
    ? `<span class="ref-lic-name">${esc(r.sweet)}</span><div class="ref-warn"><span class="ref-badge ref-badge-amber">${SVG_WARN} ${esc(r.warn)}</span></div>`
    : `<span class="ref-cell">${esc(r.sweet)}</span>`;
  const notes = r.notes
    ? (r.highlight
      ? `<span class="ref-badge ref-badge-green">${SVG_CHECK} ${esc(r.notes)}</span>`
      : `<span class="ref-cell">${esc(r.notes)}</span>`)
    : '<span class="ref-muted">—</span>';
  return `<tr${r.highlight ? ' class="ref-highlight"' : ''}>
    <td><span class="ref-lic-name">${esc(r.model)}</span></td>
    <td><span class="ref-cell">${esc(r.native)}</span></td>
    <td>${sweet}</td>
    <td><span class="ref-cell">${esc(r.max)}</span></td>
    <td><span class="ref-cell">${esc(r.dur)}</span></td>
    <td>${notes}</td>
  </tr>`;
}

/* ═══════════════════════════════════════════════
   Image Models — same card/table treatment, 6 cols
   ═══════════════════════════════════════════════ */
const IMAGE_MODELS_ROWS = [
  { company: 'ALIBABA', model: 'Wan Image', native: '1024', optimal: '1024x1024', buckets: '1:1, 16:9, 9:16', notes: "Wan's image version, same as video but single frame" },
  { company: 'ALIBABA', model: 'Qwen, Qwen 2, Qwen 3', native: '1328p dynamic 256p→1328p during training', optimal: '1328x1328 - base_resolution 1328 for Qwen family', buckets: '1328x1328, 1440x810, etc', notes: 'New high-res native, likes bigger than Flux' },
  { company: 'ALIBABA TONGYI', model: 'ZImage', native: '1024 - Flux / Z-Image: 1024', optimal: '1024x1024 - 1536x1536', buckets: '1024x1024', notes: 'Lumina 2 architecture' },
  { company: 'BAIDU', model: 'Ernie / Ernie Image', native: '1024', optimal: '1024x1024', buckets: '1:1, 3:4', notes: "Baidu's Flux competitor" },
  { company: 'BFL', model: 'Flux.1, Flux.1 Dev', native: '1024x1024 - As Flux is a 1024px model, Training resolution: 1024x1024', optimal: '1024x1024 portrait, 1360x768 widescreen', buckets: '1024x1024, 1280x768, 2048x2048 fine-tuned buckets', notes: 'Sweet spot 1MP total' },
  { company: 'BFL', model: 'Flux.1 Krea, Kontext', native: '1024', optimal: '1024x1024 - 1536x1536', buckets: 'Same as Flux.1', notes: 'Krea = more aesthetic, Kontext = edit version' },
  { company: 'BFL', model: 'Flux.2, Flux.2 Klein', native: '1024-2048', optimal: '1024 to 2048x2048 - Up to 4MP native (2000x2000)', buckets: 'Up to 2048x2048 max', notes: 'First true 2K native image model' },
  { company: 'BOOGU', model: 'Boogu', native: '1024', optimal: '1024x1024', buckets: '1:1, 9:16', notes: 'Indie SDXL fork' },
  { company: 'BYTEDANCE', model: 'Seedream 3.0 / 4.0', native: '1024-2048', optimal: '1024x1024 for draft, 2048x2048 for final', buckets: '1:1, 16:9, 4:3', notes: "Bytedance's image flagship, multi-aspect native" },
  { company: 'GOOGLE', model: 'Imagen 4', native: '1024 / 2048', optimal: '1024x1024 / 2048x2048 (1:1), 1408x768 / 2816x1536 (16:9)', buckets: '1024x1024, 2048x2048, 2816x1536', notes: 'Output supports up to 2048x2048' },
  { company: 'GOOGLE', model: 'Nano Banana', native: '1024', optimal: '1024x1024', buckets: 'Auto', notes: 'Gemini 2.0 Flash Image internal name' },
  { company: 'HIDREAM', model: 'HiDream, HiDream-O1', native: '1024-1328', optimal: '1024x1024, 1366x768', buckets: '1MP area', notes: 'SD3.5-based, very close to Flux' },
  { company: 'KREA AI', model: 'Krea 2', native: '1328', optimal: '1328x1328', buckets: '1328x1328', notes: 'Same family as Qwen, likes 1328' },
  { company: 'META', model: 'Muse Image', native: '1024', optimal: '1024x1024', buckets: '1:1', notes: "Meta's internal SDXL replacement" },
  { company: 'MICROSOFT', model: 'MAI, Mage Flow', native: '1024', optimal: '1024x1024', buckets: '1:1', notes: "Microsoft's Flux finetunes" },
  { company: 'OPENAI', model: 'OpenAI / GPT Image 1', native: '1024-2048', optimal: '1024x1024, 1536x1024, 1024x1536', buckets: 'Auto buckets', notes: 'Native 1K-2K, no fixed bucket' },
  { company: 'PONY DIFFUSION', model: 'Pony Diffusion V6 XL, V7', native: '1024px optimized - Resolution: 1024x1024', optimal: '832x1216, 1024x1024, 1216x832 - Standard Pony resolutions', buckets: '768x1344 ~ 1344x768', notes: 'Keep total ∼1MP' },
  { company: 'REVE AI', model: 'Reve', native: '1024', optimal: '1024x1024', buckets: '1:1, 16:9', notes: 'Aesthetic SDXL' },
  { company: 'SDXL COMMUNITY', model: 'Illustrious', native: '1024x1024 native - supports 512 to 1536', optimal: '1024x1024 - 1536x1536', buckets: '768x1344, 832x1216, 1024x1024, 1152x896, 1216x832, 1344x768', notes: 'SDXL community king' },
  { company: 'SDXL COMMUNITY', model: 'NoobAI XL', native: '1024x1024 - Total area around 1024x1024, Native 1024x1024 supports 768-1536', optimal: '832x1216 is best per author', buckets: 'Same 7 buckets as Illustrious', notes: 'Finetune of Illustrious, Danbooru tags' },
  { company: 'STABILITY', model: 'Stable Diffusion 1.x', native: '512x512', optimal: '512x512, 768x512', buckets: '512x512', notes: 'Ancient, avoid upscaling' },
  { company: 'STABILITY', model: 'Stable Diffusion XL', native: '1024x1024 - trained for 40k steps at 1024x1024, set to 1024 by default for best results', optimal: '1024x1024', buckets: '1024x1024, 1152x896, 1344x768', notes: '' },
  { company: 'XAI', model: 'Grok Image', native: '1024', optimal: '1024x1024', buckets: 'Auto', notes: 'Flux-based' },
  { company: 'OTHER', model: 'Anima, Chroma, Lens', native: '1920 - base_resolution 1920', optimal: '1920x1080 - 1920x1920', buckets: '1920px native', notes: 'Cosmos/Anima family, true 1080p+ native' },
];

const IMAGE_MODELS_COLS = [
  { key: 'company', label: 'Company' },
  { key: 'model', label: 'Model' },
  { key: 'native', label: 'Native Training Res' },
  { key: 'optimal', label: 'Optimal Gen Res - Best Quality' },
  { key: 'buckets', label: 'Buckets That Work' },
  { key: 'notes', label: 'Notes' },
];

function imageModelsSortValue(r, key) {
  const v = r[key] || '';
  return v === '—' ? '' : v;
}

function imageTableCfg() {
  return {
    rows: IMAGE_MODELS_ROWS,
    sort: imageModelsSort,
    valueFn: imageModelsSortValue,
    tieFn: (a, b) => String(a.model || '').localeCompare(String(b.model || ''), undefined, { numeric: true, sensitivity: 'base' }),
    rowFn: imageModelRow,
  };
}

function buildImageModelsSection() {
  return `
    <div class="ref-card">
      <div class="ref-card-head">
        <div class="ref-card-head-icon">${SVG_EYE}</div>
        <h2>Image Models<span class="ref-sub">Native res, best-quality gen res, working buckets</span></h2>
      </div>
      <div class="ref-card-body ref-table-scroll">
        <table class="ref-table ref-models-table" data-mtable="image">
          <thead><tr>
            ${sortHeaders(IMAGE_MODELS_COLS, imageModelsSort)}
          </tr></thead>
          <tbody>
            ${sortRows(IMAGE_MODELS_ROWS, imageModelsSort, imageModelsSortValue, imageTableCfg().tieFn).map(imageModelRow).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

function imageModelRow(r) {
  const notes = r.notes ? `<span class="ref-cell">${esc(r.notes)}</span>` : '<span class="ref-muted">—</span>';
  return `<tr>
    <td><span class="ref-lic-name">${esc(r.company)}</span></td>
    <td><span class="ref-lic-name">${esc(r.model)}</span></td>
    <td><span class="ref-cell">${esc(r.native)}</span></td>
    <td><span class="ref-cell">${esc(r.optimal)}</span></td>
    <td><span class="ref-cell">${esc(r.buckets)}</span></td>
    <td>${notes}</td>
  </tr>`;
}

/* ═══════════════════════════════════════════════
   Section A — License Table
   ═══════════════════════════════════════════════ */
function buildLicenseSection() {
  return `
    <div class="ref-card">
      <div class="ref-card-head">
        <div class="ref-card-head-icon">${SVG_SHIELD}</div>
        <h2>A — License<span class="ref-sub">Can I get sued?</span></h2>
      </div>
      <div class="ref-card-body">
        <table class="ref-table">
          <thead><tr>
            <th style="width:38%">License</th>
            <th class="ref-col-center" style="width:20%">Commercial?</th>
            <th class="ref-col-center" style="width:18%">Credit?</th>
            <th class="ref-col-center" style="width:24%">For YPP?</th>
          </tr></thead>
          <tbody>
            ${licRow('CC0 / Public Domain', 'Pexels, Pixabay, Mixkit, NASA, Prelinger, National Archives', 'yes', 'no', 'yes-star')}
            ${licRow('CC BY', '', 'yes', 'yes', 'yes-star')}
            ${licRow('CC BY-NC / NC-SA', '', 'no', 'yes', 'no')}
            ${licRow('Videvo Free / Videezy Free', 'check per clip', 'maybe', 'yes', 'risk')}
            ${licRow('Free AI tool with watermark', 'Runway free, Pika free etc', 'tos', 'no', 'no-wm')}
            ${licRow('Paid AI / Meta AI clean export', 'full ownership', 'yes', 'no', 'yes', true)}
          </tbody>
        </table>
        <p class="ref-note">* Public domain is legal, but YPP needs original commentary — see Monetize section.</p>
      </div>
    </div>`;
}

function licRow(name, sub, c1, c2, c3, highlight) {
  return `<tr${highlight ? ' class="ref-highlight"' : ''}>
    <td><span class="ref-lic-name">${esc(name)}</span>${sub ? `<div class="ref-lic-sub">${esc(sub)}</div>` : ''}</td>
    <td class="ref-col-center">${badge(c1)}</td>
    <td class="ref-col-center">${badge(c2)}</td>
    <td class="ref-col-center">${badge(c3)}</td>
  </tr>`;
}

function badge(type) {
  if (type === 'yes')      return `<span class="ref-badge ref-badge-green">${SVG_CHECK} Yes</span>`;
  if (type === 'yes-star') return `<span class="ref-badge ref-badge-green">${SVG_CHECK} Yes*</span>`;
  if (type === 'no')       return `<span class="ref-badge ref-badge-red">${SVG_X} No</span>`;
  if (type === 'maybe')    return `<span class="ref-badge ref-badge-amber">${SVG_WARN} Varies</span>`;
  if (type === 'tos')      return `<span class="ref-badge ref-badge-gray">Per ToS</span>`;
  if (type === 'risk')     return `<span class="ref-badge ref-badge-amber">${SVG_WARN} Risky</span>`;
  if (type === 'no-wm')    return `<span class="ref-badge ref-badge-red">${SVG_X} No — WM</span>`;
  return '';
}

/* ═══════════════════════════════════════════════
   Section B — Disclosure Checklist
   ═══════════════════════════════════════════════ */
function buildDisclosureSection() {
  return `
    <div class="ref-card">
      <div class="ref-card-head">
        <div class="ref-card-head-icon">${SVG_EYE}</div>
        <h2>B — Disclosure<span class="ref-sub">Will I get penalized?</span></h2>
      </div>
      <div class="ref-card-body">
        <ul class="ref-checklist">
          ${checkItem('green', SVG_CHECK, 'Toggle YES to "altered or synthetic content"', 'if ANY AI visuals / voice in video')}
          ${checkItem('green', SVG_CHECK, 'Disclosure does NOT kill monetization,', 'hiding it does')}
          ${checkItem('green', SVG_CHECK, 'YouTube adds small label automatically,', "that's normal")}
          ${checkItem('amber', SVG_WARN, 'Invisible tags (C2PA / IPTC) often stripped', 'by re-encoding / crop / noise / datamosh — manual toggle still required')}
        </ul>
      </div>
    </div>`;
}

function checkItem(color, icon, strong, detail) {
  return `<li class="ref-check">
    <span class="ref-check-icon ${color}">${icon}</span>
    <span class="ref-check-text"><strong>${esc(strong)}</strong>${detail ? ` <span class="ref-muted">— ${esc(detail)}</span>` : ''}</span>
  </li>`;
}

/* ═══════════════════════════════════════════════
   Section C — Monetization (split cards)
   ═══════════════════════════════════════════════ */
function buildMonetizeSection() {
  return `
    <div class="ref-card">
      <div class="ref-card-head">
        <div class="ref-card-head-icon">${SVG_MONEY}</div>
        <h2>C — Monetization<span class="ref-sub">Will YPP approve?</span></h2>
      </div>
      <div class="ref-card-body">
        <div class="ref-split">
          <div class="ref-split-card red">
            <div class="ref-split-title">${SVG_X} Kills Monetization</div>
            <ul class="ref-split-list">
              <li>compilation of stock / public domain with no commentary</li>
              <li>AI voice reading Wikipedia over stock</li>
              <li>large AI watermarks</li>
              <li>mass-produced template</li>
            </ul>
          </div>
          <div class="ref-split-card green">
            <div class="ref-split-title">${SVG_CHECK} Safe for Monetization</div>
            <ul class="ref-split-list">
              <li>same footage + YOUR voiceover + analysis / story / education</li>
              <li>significant editing, transformative</li>
            </ul>
          </div>
        </div>
        <div class="ref-callout">
          ${SVG_INFO}
          <p>Simply re-uploading public domain video may not be eligible — needs original commentary</p>
        </div>
      </div>
    </div>`;
}

/* ═══════════════════════════════════════════════
   Section D — Watermarks & Invisible Tags
   ═══════════════════════════════════════════════ */
function buildWatermarksSection() {
  return `
    <div class="ref-card">
      <div class="ref-card-head">
        <div class="ref-card-head-icon">${SVG_LAYERS}</div>
        <h2>D — Watermarks & Tags<span class="ref-sub">What survives?</span></h2>
      </div>
      <div class="ref-card-body">
        <table class="ref-table">
          <thead><tr>
            <th style="width:32%">Processing</th>
            <th class="ref-col-center" style="width:22%">Metadata</th>
            <th class="ref-col-center" style="width:22%">Invisible</th>
            <th class="ref-col-center" style="width:24%">Visible WM</th>
          </tr></thead>
          <tbody>
            ${wmRow('Square crop', 'survives', 'survives', 'degraded')}
            ${wmRow('Color grade', 'survives', 'degraded', 'survives')}
            ${wmRow('Add noise / grain', 'survives', 'degraded', 'survives')}
            ${wmRow('Re-export / ffmpeg', 'stripped', 'degraded', 'survives')}
            ${wmRow('Datamosh', 'stripped', 'stripped', 'degraded')}
          </tbody>
        </table>
        <div class="ref-legend">
          <span class="ref-status"><span class="ref-dot green">${SVG_CHECK}</span> Survives</span>
          <span class="ref-status"><span class="ref-dot amber">${SVG_WARN}</span> Degraded</span>
          <span class="ref-status"><span class="ref-dot red">${SVG_X}</span> Stripped</span>
        </div>
      </div>
    </div>`;
}

function wmRow(proc, m, inv, vis) {
  return `<tr>
    <td><span class="ref-lic-name">${esc(proc)}</span></td>
    <td class="ref-col-center">${wmStatus(m)}</td>
    <td class="ref-col-center">${wmStatus(inv)}</td>
    <td class="ref-col-center">${wmStatus(vis)}</td>
  </tr>`;
}

function wmStatus(type) {
  if (type === 'survives')  return `<span class="ref-status ref-status-green"><span class="ref-dot green">${SVG_CHECK}</span> Survives</span>`;
  if (type === 'degraded')  return `<span class="ref-status ref-status-amber"><span class="ref-dot amber">${SVG_WARN}</span> Degraded</span>`;
  return `<span class="ref-status ref-status-red"><span class="ref-dot red">${SVG_X}</span> Stripped</span>`;
}

/* ═══════════════════════════════════════════════
   Section E — Channel Strategy Checklist
   ═══════════════════════════════════════════════ */
function buildStrategySection() {
  return `
    <div class="ref-card">
      <div class="ref-card-head">
        <div class="ref-card-head-icon"><span style="font-size:12px;font-weight:700">${SVG_UPRIGHT}</span></div>
        <h2>E — Channel Strategy<span class="ref-sub">Can I mix?</span></h2>
      </div>
      <div class="ref-card-body">
        <ul class="ref-checklist">
          ${checkItem('green', SVG_CHECK, 'One non-monetizable video does NOT burn channel', '')}
          ${checkItem('green', SVG_CHECK, 'Video-level demonetization (yellow $) != channel demonetization', '')}
          ${checkItem('green', SVG_CHECK, 'YPP review looks at MAJORITY of PUBLIC videos', '')}
          ${checkItem('green', SVG_CHECK, 'If applying for YPP: set experimental non-monetizable videos to Unlisted / Private,', 'or have majority original content public')}
          ${checkItem('green', SVG_CHECK, 'You can reapply after 30 days', '')}
        </ul>
      </div>
    </div>

    <div class="ref-footer">
      <span class="ref-footer-icon">R</span>
      <span>Rule of thumb: <strong>Legal = license</strong>, <strong>YouTube = originality + disclosure</strong>. Do both.</span>
      <span class="ref-muted">No trackers — Keep this card open while editing</span>
    </div>`;
}

function esc(s) {
  return escapeHtml(String(s || ''));
}

export { renderReferencesForm };
