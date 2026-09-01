import { state, elements, allInputPaths } from '/app.js';
import { setupContinuousKnob, knobUnitHtml, setupBinaryKnob } from '/js/ui/knobs.js';
import { flipRotateOptionsHtml } from '/js/utils.js';

// The operations stack for image editing
// Let's create a dynamic stack

function renderImageEditForm() {
  const html = `
    <div class="panel-title-desc dense">
      <h3>Image Edit (Format, Scale, Crop)</h3>
      <p class="dream-hint">Reformat images to standard sizes or convert to legacy formats.</p>
    </div>

    <!-- Export Settings -->
    <div class="form-group">
      <label>Processing Engine</label>
      <select id="ieEngine">
        <option value="ffmpeg">FFmpeg (Fast, standard formats)</option>
        <option value="imagemagick">ImageMagick (Powerful, legacy formats)</option>
        <option value="pillow">Pillow (Fast Python native)</option>
      </select>
    </div>

    <div class="form-group">
      <label>Output Format</label>
      <select id="ieFormat">
        <option value="png">PNG (Lossless, Alpha)</option>
        <option value="jpg">JPG (Compressed)</option>
        <option value="webp">WebP (Modern, Alpha)</option>
        <option value="tiff">TIFF (Legacy/Print)</option>
        <option value="bmp">BMP</option>
        <option value="tga">TGA</option>
      </select>
    </div>

    <div class="form-row">
      <label for="ieOutput">Output path</label>
      <div class="input-row">
        <input type="text" id="ieOutput" placeholder="blank = auto next to input">
        <button class="btn" onclick="openFileBrowser('ieOutput', false, 'file_save')">Save As</button>
      </div>
    </div>

    <!-- Operations Stack -->
    <div class="dream-section-title" style="margin-top: 1rem; display: flex; justify-content: space-between; align-items: center;">
      <span>Operations Stack</span>
      <div style="display: flex; gap: 4px;">
        <button class="btn btn-sm" id="btnAddOpScale">Scale</button>
        <button class="btn btn-sm" id="btnAddOpFlipRotate">Flip/Rotate</button>
        <button class="btn btn-sm" id="btnAddOpCrop">Crop</button>
        <button class="btn btn-sm" id="btnAddOpPad">Pad</button>
      </div>
    </div>

    <div id="ieStackContainer" style="display:flex; flex-direction: column; gap: 8px; margin-top: 8px;">
      <!-- Ops get injected here -->
    </div>

    <div id="ieCropPreview" class="ie-crop-preview" hidden></div>

    <div class="knob-row" style="margin-top: 1rem;">
      <div class="knob-bank">
        ${knobUnitHtml({ id: 'ieDryRun', label: 'Dry run', value: '0', binary: true, leftCap: 'Run', rightCap: 'Dry' })}
      </div>
      <p class="knob-row-legend">Dry = print command only, no file written.</p>
    </div>
  `;

  elements.actionPanel.innerHTML = html;

  setupBinaryKnob({
    knobId: 'ieDryRunKnob', indicatorId: 'ieDryRunKnobInd', hiddenId: 'ieDryRun',
    leftValue: '0', rightValue: '1', initial: '0',
  });

  document.getElementById('ieEngine').value = state.imageEdit.engine || 'ffmpeg';
  document.getElementById('ieEngine').addEventListener('change', (e) => {
    state.imageEdit.engine = e.target.value;
  });
  
  document.getElementById('ieFormat').value = state.imageEdit.outputFormat || 'png';
  document.getElementById('ieFormat').addEventListener('change', (e) => {
    state.imageEdit.outputFormat = e.target.value;
  });

  document.getElementById('btnAddOpScale').addEventListener('click', () => addStackOp('scale'));
  document.getElementById('btnAddOpFlipRotate').addEventListener('click', () => addStackOp('flip_rotate'));
  document.getElementById('btnAddOpCrop').addEventListener('click', () => addStackOp('crop'));
  document.getElementById('btnAddOpPad').addEventListener('click', () => addStackOp('pad'));

  renderStack();
}

function addStackOp(type) {
  const id = 'op_' + Date.now();
  if (type === 'scale') {
    state.imageEdit.stack.push({ id, type, width: 1920, height: 1080 });
  } else if (type === 'flip_rotate') {
    state.imageEdit.stack.push({ id, type, mode: 'rotate_90' });
  } else if (type === 'crop') {
    state.imageEdit.stack.push({ id, type, width: 1920, height: 1080, x: 0, y: 0 });
  } else if (type === 'pad') {
    state.imageEdit.stack.push({ id, type, width: 1920, height: 1080, color: 'black' });
  }
  renderStack();
}

function moveOp(index, dir) {
  const newIndex = index + dir;
  if (newIndex < 0 || newIndex >= state.imageEdit.stack.length) return;
  const temp = state.imageEdit.stack[index];
  state.imageEdit.stack[index] = state.imageEdit.stack[newIndex];
  state.imageEdit.stack[newIndex] = temp;
  renderStack();
}

function removeOp(index) {
  state.imageEdit.stack.splice(index, 1);
  renderStack();
}

window.ieMoveOp = moveOp;
window.ieRemoveOp = removeOp;
window.ieUpdateOp = function(index, field, value) {
  state.imageEdit.stack[index][field] = value;
};

function firstInputPath() {
  const paths = allInputPaths();
  return (paths && paths[0]) || '';
}

let _dimsCachePath = '';
let _dimsCache = null;
let _imgUrlCachePath = '';
let _imgUrlCache = null;

async function probeInputDims() {
  const path = firstInputPath();
  if (!path) return null;
  if (_dimsCachePath === path && _dimsCache) return _dimsCache;
  try {
    const res = await fetch(`/api/probe?path=${encodeURIComponent(path)}`);
    if (!res.ok) return null;
    const data = await res.json();
    const w = parseInt(data.width || data.w, 10);
    const h = parseInt(data.height || data.h, 10);
    if (w > 0 && h > 0) {
      _dimsCachePath = path;
      _dimsCache = { w, h };
      return _dimsCache;
    }
  } catch (_) { /* ignore */ }
  return null;
}

function ieFieldValue(index, suffix) {
  const el = document.getElementById(`ie${suffix}_${index}`);
  const v = parseInt(el ? el.value : '', 10);
  return Number.isFinite(v) ? v : 0;
}

window.ieSquareCrop = async function(index) {
  const op = state.imageEdit.stack[index];
  if (!op) return;
  let side = Math.max(ieFieldValue(index, 'W'), ieFieldValue(index, 'H'));
  const src = await probeInputDims();
  if (src) side = Math.min(src.w, src.h, side || 0) || side;
  if (!side) {
    window.alert('Set a width or height first (or pick a global input image) to make a square.');
    return;
  }
  op.width = side;
  op.height = side;
  renderStack();
};

window.ieAnchorX = async function(index, anchor) {
  const op = state.imageEdit.stack[index];
  if (!op) return;
  const w = ieFieldValue(index, 'W');
  const src = await probeInputDims();
  if (!src || !w) return;
  const x = anchor === 'L' ? 0 : anchor === 'R' ? src.w - w : Math.floor((src.w - w) / 2);
  op.x = Math.max(0, x);
  renderStack();
};

window.ieAnchorY = async function(index, anchor) {
  const op = state.imageEdit.stack[index];
  if (!op) return;
  const h = ieFieldValue(index, 'H');
  const src = await probeInputDims();
  if (!src || !h) return;
  const y = anchor === 'T' ? 0 : anchor === 'B' ? src.h - h : Math.floor((src.h - h) / 2);
  op.y = Math.max(0, y);
  renderStack();
};

function pct(part, whole) {
  if (!whole) return 0;
  return (part / whole) * 100;
}

/**
 * Live crop preview: show the source image with a shaded "removed" region and a
 * hole for the region the first crop op keeps. Re-probes source dims cheaply and
 * uses percentage-rect positioning so it stays accurate at any thumbnail scale.
 */
async function ieSyncCropPreview() {
  const host = document.getElementById('ieCropPreview');
  if (!host) return;

  const crops = (state.imageEdit.stack || []).filter((op) => op.type === 'crop');
  if (!crops.length) {
    host.hidden = true;
    host.innerHTML = '';
    return;
  }

  const src = await probeInputDims();
  const path = firstInputPath();
  if (!src || !path) {
    host.hidden = true;
    host.innerHTML = '';
    return;
  }

  const index = (state.imageEdit.stack || []).indexOf(crops[0]);
  const cw = ieFieldValue(index, 'W') || parseInt(crops[0].width, 10) || 0;
  const ch = ieFieldValue(index, 'H') || parseInt(crops[0].height, 10) || 0;
  const cx = ieFieldValue(index, 'X') || parseInt(crops[0].x, 10) || 0;
  const cy = ieFieldValue(index, 'Y') || parseInt(crops[0].y, 10) || 0;

  const oob = cw > src.w || ch > src.h || cx < 0 || cy < 0 || cx + cw > src.w || cy + ch > src.h;

  if (_imgUrlCachePath !== path) {
    _imgUrlCachePath = path;
    _imgUrlCache = `/api/image?path=${encodeURIComponent(path)}&t=${Date.now()}`;
  }
  const imgUrl = _imgUrlCache;
  const ar = src.w / src.h;
  const frameStyle = `width: min(100%, calc(46vh * ${ar.toFixed(4)}));` +
    ` aspect-ratio: ${src.w} / ${src.h};`;

  host.innerHTML = `
    <h4 class="ie-crop-preview-title">Crop preview${crops.length > 1 ? ' · first crop op' : ''}</h4>
    <div class="ie-crop-preview-frame" style="${frameStyle}">
      <img src="${imgUrl}" alt="crop preview">
      <div class="ie-crop-mask" style="
        left: ${pct(cx, src.w)}%; top: ${pct(cy, src.h)}%;
        width: ${pct(cw, src.w)}%; height: ${pct(ch, src.h)}%;
      "></div>
      <div class="ie-crop-rect${oob ? ' oob' : ''}" style="
        left: ${pct(cx, src.w)}%; top: ${pct(cy, src.h)}%;
        width: ${pct(cw, src.w)}%; height: ${pct(ch, src.h)}%;
      "></div>
    </div>
    <p class="ie-crop-preview-note">
      <span>Keeps ${cw}×${ch} at (${cx},${cy}) of ${src.w}×${src.h}</span>
      ${oob ? ' · <span style="color:rgb(255,120,80)">crop exceeds source — clamp or resize</span>' : ''}
    </p>
  `;
  host.hidden = false;
}
window.ieSyncCropPreview = ieSyncCropPreview;

function renderStack() {
  const container = document.getElementById('ieStackContainer');
  if (!container) return;
  
  if (state.imageEdit.stack.length === 0) {
    container.innerHTML = '<div style="padding: 1rem; text-align: center; color: var(--text-muted); background: var(--panel-bg); border-radius: var(--radius-sm); border: 1px dashed var(--panel-border);">No operations added. Output will be unmodified format conversion.</div>';
    ieSyncCropPreview();
    return;
  }

  let html = '';
  state.imageEdit.stack.forEach((op, idx) => {
    let content = '';
    if (op.type === 'scale') {
      content = `
        <div style="display:flex; gap: 8px; align-items:center;">
          W: <input type="number" class="timeline-value-input" value="${op.width}" onchange="ieUpdateOp(${idx}, 'width', this.value)" style="width: 60px;">
          H: <input type="number" class="timeline-value-input" value="${op.height}" onchange="ieUpdateOp(${idx}, 'height', this.value)" style="width: 60px;">
        </div>
      `;
    } else if (op.type === 'crop') {
      const anchorBtn = (fn, anchor, label, title) =>
        `<button class="btn btn-sm" style="padding: 1px 6px; font-size:0.7rem; line-height:1.2;" onclick="${fn}(${idx}, '${anchor}')" title="${title}">${label}</button>`;
      content = `
        <div style="display:flex; flex-direction:column; gap:6px;">
          <div style="display:flex; gap:8px; align-items:center;">
            W: <input id="ieW_${idx}" type="number" class="timeline-value-input" value="${op.width}" onchange="ieUpdateOp(${idx}, 'width', this.value)" oninput="ieSyncCropPreview()" style="width: 60px;">
            H: <input id="ieH_${idx}" type="number" class="timeline-value-input" value="${op.height}" onchange="ieUpdateOp(${idx}, 'height', this.value)" oninput="ieSyncCropPreview()" style="width: 60px;">
            <button class="btn btn-sm" style="padding: 1px 6px; font-size:0.7rem; line-height:1.2;" onclick="ieSquareCrop(${idx})" title="Set W=H to a square (min source side if known)">▣ Square</button>
          </div>
          <div style="display:flex; gap:6px; align-items:center;">
            X:
            <input id="ieX_${idx}" type="number" class="timeline-value-input" value="${op.x}" onchange="ieUpdateOp(${idx}, 'x', this.value)" oninput="ieSyncCropPreview()" style="width: 60px;">
            <span style="display:flex; gap:3px;">
              ${anchorBtn('ieAnchorX', 'L', 'L', 'Left: crop window flush to the left edge (X=0)')}
              ${anchorBtn('ieAnchorX', 'C', 'C', 'Center horizontally (X=(srcW-cropW)/2)')}
              ${anchorBtn('ieAnchorX', 'R', 'R', 'Right: crop window flush to the right edge (X=srcW-cropW)')}
            </span>
          </div>
          <div style="display:flex; gap:6px; align-items:center;">
            Y:
            <input id="ieY_${idx}" type="number" class="timeline-value-input" value="${op.y}" onchange="ieUpdateOp(${idx}, 'y', this.value)" oninput="ieSyncCropPreview()" style="width: 60px;">
            <span style="display:flex; gap:3px;">
              ${anchorBtn('ieAnchorY', 'T', 'T', 'Top: crop window flush to the top edge (Y=0)')}
              ${anchorBtn('ieAnchorY', 'M', 'M', 'Middle vertically (Y=(srcH-cropH)/2)')}
              ${anchorBtn('ieAnchorY', 'B', 'B', 'Bottom: crop window flush to the bottom edge (Y=srcH-cropH)')}
            </span>
          </div>
        </div>
      `;
    } else if (op.type === 'pad') {
      content = `
        <div style="display:flex; gap: 8px; align-items:center;">
          W: <input type="number" class="timeline-value-input" value="${op.width}" onchange="ieUpdateOp(${idx}, 'width', this.value)" style="width: 60px;">
          H: <input type="number" class="timeline-value-input" value="${op.height}" onchange="ieUpdateOp(${idx}, 'height', this.value)" style="width: 60px;">
          Color: <input type="text" class="timeline-value-input" value="${op.color}" onchange="ieUpdateOp(${idx}, 'color', this.value)" style="width: 80px;">
        </div>
      `;
    } else if (op.type === 'flip_rotate') {
      content = `
        <div style="display:flex; gap: 8px; align-items:center;">
          <label style="font-size:0.8rem;">Transform</label>
          <select style="flex:1;" onchange="ieUpdateOp(${idx}, 'mode', this.value)">
            ${flipRotateOptionsHtml(op.mode || 'rotate_90')}
          </select>
        </div>
      `;
    }

    html += `
      <div style="background: var(--panel-bg); border: 1px solid var(--panel-border); border-radius: var(--radius-sm); padding: 8px; display: flex; flex-direction: column; gap: 6px;">
        <div style="display:flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--panel-border); padding-bottom: 4px;">
          <span style="font-weight: 600; font-size: 0.85rem; text-transform: uppercase;">${op.type}</span>
          <div style="display:flex; gap: 4px;">
            <button class="btn" style="padding: 2px 6px; font-size:0.7rem;" onclick="ieMoveOp(${idx}, -1)" ${idx === 0 ? 'disabled' : ''}>▲</button>
            <button class="btn" style="padding: 2px 6px; font-size:0.7rem;" onclick="ieMoveOp(${idx}, 1)" ${idx === state.imageEdit.stack.length - 1 ? 'disabled' : ''}>▼</button>
            <button class="btn" style="padding: 2px 6px; font-size:0.7rem; color:var(--error);" onclick="ieRemoveOp(${idx})">✕</button>
          </div>
        </div>
        ${content}
      </div>
    `;
  });
  container.innerHTML = html;
  ieSyncCropPreview();
}

function collectImageEditBody(jobToken) {
  const paths = allInputPaths();
  if (paths.length === 0) {
    throw new Error('No input images specified. Use global inputs.');
  }

  const dry_run = document.getElementById('ieDryRun').value === '1';
  const outPath = document.getElementById('ieOutput').value.trim();

  return {
    paths: paths,
    output: outPath || null,
    engine: state.imageEdit.engine,
    outputFormat: state.imageEdit.outputFormat,
    stack: state.imageEdit.stack,
    dry_run: dry_run,
    job_token: jobToken
  };
}

export {
  renderImageEditForm,
  collectImageEditBody
};
