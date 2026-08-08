import { state, elements, allInputPaths } from '/app.js';
import { setupContinuousKnob, knobUnitHtml, setupBinaryKnob } from '/js/ui/knobs.js';

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
        <button class="btn btn-sm" id="btnAddOpCrop">Crop</button>
        <button class="btn btn-sm" id="btnAddOpPad">Pad</button>
      </div>
    </div>

    <div id="ieStackContainer" style="display:flex; flex-direction: column; gap: 8px; margin-top: 8px;">
      <!-- Ops get injected here -->
    </div>

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
  document.getElementById('btnAddOpCrop').addEventListener('click', () => addStackOp('crop'));
  document.getElementById('btnAddOpPad').addEventListener('click', () => addStackOp('pad'));

  renderStack();
}

function addStackOp(type) {
  const id = 'op_' + Date.now();
  if (type === 'scale') {
    state.imageEdit.stack.push({ id, type, width: 1920, height: 1080 });
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

function renderStack() {
  const container = document.getElementById('ieStackContainer');
  if (!container) return;
  
  if (state.imageEdit.stack.length === 0) {
    container.innerHTML = '<div style="padding: 1rem; text-align: center; color: var(--text-muted); background: var(--panel-bg); border-radius: var(--radius-sm); border: 1px dashed var(--panel-border);">No operations added. Output will be unmodified format conversion.</div>';
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
      content = `
        <div style="display:flex; gap: 8px; align-items:center;">
          W: <input type="number" class="timeline-value-input" value="${op.width}" onchange="ieUpdateOp(${idx}, 'width', this.value)" style="width: 60px;">
          H: <input type="number" class="timeline-value-input" value="${op.height}" onchange="ieUpdateOp(${idx}, 'height', this.value)" style="width: 60px;">
          X: <input type="number" class="timeline-value-input" value="${op.x}" onchange="ieUpdateOp(${idx}, 'x', this.value)" style="width: 60px;">
          Y: <input type="number" class="timeline-value-input" value="${op.y}" onchange="ieUpdateOp(${idx}, 'y', this.value)" style="width: 60px;">
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
