import { state, elements } from '/app.js';
import { setupContinuousKnob, setupBinaryKnob, knobUnitHtml } from '/js/ui/knobs.js';

// Transmute single-clip form
const transmuteOpsDetails = {
  first_frame: { summary: "Extract first frame as PNG", fields: ['quality'] },
  last_frame: { summary: "Extract last frame as JPG", fields: ['seconds_from_end', 'quality'] },
  extract_audio: { summary: "Pull audio track out as M4A", fields: [] },
  crop_16x9: { summary: "Center-crop to 16:9 aspect ratio", fields: [] },
  letterbox_16x9: { summary: "Letterbox (pad) to 16:9", fields: [] },
  square_crop: { summary: "Center-crop to a 1:1 square", fields: [] },
  square_letterbox: { summary: "Letterbox (pad) to a 1:1 square", fields: [] },
  reverse: { summary: "Reverse video and audio completely", fields: [] },
  crop_exact: { summary: "Center-crop to exact resolution", fields: ['width', 'height'] },
  stretch_exact: { summary: "Stretch to exact resolution", fields: ['width', 'height'] },
  speed_ramp: { summary: "Speed ramp (spin-up / spin-down)", fields: ['speed_ramp'] }
};

let activeTransmuteOp = 'first_frame';

function renderTransmuteForm() {
  let optionsHtml = '';
  Object.keys(transmuteOpsDetails).forEach(opId => {
    optionsHtml += `<option value="${opId}" ${activeTransmuteOp === opId ? 'selected' : ''}>${transmuteOpsDetails[opId].summary}</option>`;
  });

  const html = `
    <div class="panel-title-desc dense">
      <h3>Single-Clip Operations</h3>
      <p class="dream-hint">Extract frames/audio, geometry, crop, pad, reverse — stream-copy when possible.</p>
    </div>

    <div class="form-row">
      <label for="transmuteOpSelect">Op</label>
      <select id="transmuteOpSelect">${optionsHtml}</select>
    </div>
    <div class="form-row">
      <label for="transmuteInput">Input</label>
      <div class="input-row">
        <input type="text" id="transmuteInput" placeholder="/absolute/path/to/input.mp4">
        <button class="btn" onclick="openFileBrowser('transmuteInput', false)">Browse</button>
      </div>
    </div>
    <div class="form-row">
      <label for="transmuteOutput">Output</label>
      <div class="input-row">
        <input type="text" id="transmuteOutput" placeholder="blank = auto next to input">
        <button class="btn" onclick="openFileBrowser('transmuteOutput', false, 'file_save')">Save As</button>
      </div>
    </div>

    <div id="transmuteExtras"></div>

    <div class="knob-row">
      <div class="knob-bank">
        ${knobUnitHtml({ id: 'transmuteDryRun', label: 'Dry run', value: '0', binary: true, leftCap: 'Run', rightCap: 'Dry' })}
      </div>
      <p class="knob-row-legend">Dry = print command only, no file written.</p>
    </div>
  `;

  elements.actionPanel.innerHTML = html;
  
  // Set listener for selection
  const select = document.getElementById('transmuteOpSelect');
  select.addEventListener('change', (e) => {
    activeTransmuteOp = e.target.value;
    updateTransmuteExtras();
  });

  setupBinaryKnob({
    knobId: 'transmuteDryRunKnob', indicatorId: 'transmuteDryRunKnobInd', hiddenId: 'transmuteDryRun',
    leftValue: '0', rightValue: '1', initial: '0',
  });

  updateTransmuteExtras();
}

function updateTransmuteExtras() {
  const extrasContainer = document.getElementById('transmuteExtras');
  if (!extrasContainer) return;
  extrasContainer.innerHTML = '';

  const fields = transmuteOpsDetails[activeTransmuteOp].fields;
  let html = '';

  if (fields.includes('quality')) {
    const isPng = activeTransmuteOp === 'first_frame';
    const desc = isPng
      ? 'PNG quality 2–31 (lower = better).'
      : 'JPEG quality 2–31 (lower = better).';
    html += `
      <div class="knob-row">
        <div class="knob-bank">
          ${knobUnitHtml({ id: 'transmuteQuality', label: 'Quality', value: '2' })}
        </div>
        <p class="knob-row-legend">${desc}</p>
      </div>
    `;
  }

  if (fields.includes('seconds_from_end')) {
    html += `
      <div class="knob-row">
        <div class="knob-bank">
          ${knobUnitHtml({ id: 'transmuteSecondsFromEnd', label: 'From end (s)', value: '0.1' })}
        </div>
        <p class="knob-row-legend">Seconds before end to grab the frame.</p>
      </div>
    `;
  }

  if (fields.includes('width') || fields.includes('height')) {
    html += `
      <div class="knob-row">
        <div class="knob-bank">
          ${knobUnitHtml({ id: 'transmuteWidth', label: 'Width', value: '1920' })}
          ${knobUnitHtml({ id: 'transmuteHeight', label: 'Height', value: '1080' })}
        </div>
        <p class="knob-row-legend">Pixels (prefer even).</p>
      </div>
    `;
  }

  if (fields.includes('speed_ramp')) {
    html += `
    <div class="knob-row">
      <div class="knob-bank">
        ${knobUnitHtml({ id: 'rampDirection', label: 'Direction', value: 'spin_down', binary: true, leftCap: 'Spin Up', rightCap: 'Spin Down' })}
        ${knobUnitHtml({ id: 'rampDuration', label: 'Duration (s)', value: '5.0' })}
        ${knobUnitHtml({ id: 'rampStartSpeed', label: 'Start ×', value: '4.0' })}
        ${knobUnitHtml({ id: 'rampEndSpeed', label: 'End ×', value: '0.33' })}
      </div>
      <p class="knob-row-legend" id="rampInfoLine">Set knobs to see required source duration.</p>
    </div>
  `;
  }

  extrasContainer.innerHTML = html;

  if (fields.includes('quality')) {
    setupContinuousKnob({
      knobId: 'transmuteQualityKnob', indicatorId: 'transmuteQualityKnobInd',
      valueId: 'transmuteQualityVal', hiddenId: 'transmuteQuality',
      min: 2, max: 31, step: 1, decimals: 0,
    });
  }
  if (fields.includes('seconds_from_end')) {
    setupContinuousKnob({
      knobId: 'transmuteSecondsFromEndKnob', indicatorId: 'transmuteSecondsFromEndKnobInd',
      valueId: 'transmuteSecondsFromEndVal', hiddenId: 'transmuteSecondsFromEnd',
      min: 0, max: 5, step: 0.05, decimals: 2,
    });
  }
  if (fields.includes('width') || fields.includes('height')) {
    setupContinuousKnob({
      knobId: 'transmuteWidthKnob', indicatorId: 'transmuteWidthKnobInd',
      valueId: 'transmuteWidthVal', hiddenId: 'transmuteWidth',
      min: 16, max: 7680, step: 2, decimals: 0, sensitivity: 220,
    });
    setupContinuousKnob({
      knobId: 'transmuteHeightKnob', indicatorId: 'transmuteHeightKnobInd',
      valueId: 'transmuteHeightVal', hiddenId: 'transmuteHeight',
      min: 16, max: 4320, step: 2, decimals: 0, sensitivity: 220,
    });
  }

  if (fields.includes('speed_ramp')) {
    setupBinaryKnob({
      knobId: 'rampDirectionKnob', indicatorId: 'rampDirectionKnobInd',
      hiddenId: 'rampDirection',
      leftValue: 'spin_up', rightValue: 'spin_down', initial: 'spin_down',
    });
    setupContinuousKnob({
      knobId: 'rampDurationKnob', indicatorId: 'rampDurationKnobInd',
      valueId: 'rampDurationVal', hiddenId: 'rampDuration',
      min: 0.5, max: 60, step: 0.1, decimals: 1,
    });
    setupContinuousKnob({
      knobId: 'rampStartSpeedKnob', indicatorId: 'rampStartSpeedKnobInd',
      valueId: 'rampStartSpeedVal', hiddenId: 'rampStartSpeed',
      min: 0.1, max: 20, step: 0.05, decimals: 2,
    });
    setupContinuousKnob({
      knobId: 'rampEndSpeedKnob', indicatorId: 'rampEndSpeedKnobInd',
      valueId: 'rampEndSpeedVal', hiddenId: 'rampEndSpeed',
      min: 0.1, max: 20, step: 0.05, decimals: 2,
    });

    // Swap defaults when direction toggles
    const dirEl = document.getElementById('rampDirection');
    if (dirEl) {
      dirEl.addEventListener('change', () => {
        const dir = dirEl.value;
        const startEl = document.getElementById('rampStartSpeed');
        const endEl = document.getElementById('rampEndSpeed');
        if (dir === 'spin_down') {
          startEl.value = '4.0'; endEl.value = '0.33';
        } else {
          startEl.value = '0.33'; endEl.value = '4.0';
        }
        updateRampInfoLine();
      });
    }

    // Update info line on knob changes
    ['rampDuration', 'rampStartSpeed', 'rampEndSpeed', 'rampLoopMode', 'rampCurveShape'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', updateRampInfoLine);
    });
    // Also listen on the hidden inputs that knobs update
    ['rampDuration', 'rampStartSpeed', 'rampEndSpeed'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('input', updateRampInfoLine);
      }
    });
  }
}

function updateRampInfoLine() {
  const line = document.getElementById('rampInfoLine');
  if (!line) return;
  const dur = parseFloat(document.getElementById('rampDuration')?.value) || 5;
  const S = parseFloat(document.getElementById('rampStartSpeed')?.value) || 4;
  const E = parseFloat(document.getElementById('rampEndSpeed')?.value) || 0.33;
  if (S <= 0 || E <= 0 || S === E) {
    line.textContent = 'Start and end speed must differ and be > 0.';
    return;
  }
  // Compute how much source footage is needed (same math as backend)
  const ratio = Math.max(S, E) / Math.min(S, E);
  const T_needed = Math.log(ratio) * Math.min(S, E) * dur / (ratio - 1);
  line.textContent = `Source needed: ${T_needed.toFixed(1)}s  →  output ~${dur.toFixed(1)}s  ` +
    `(start ${S.toFixed(2)}× → end ${E.toFixed(2)}×)`;
}

// Multi-clip Join/Grid Form
let activeMultiMode = 'join'; // 'join' or 'grid'

function renderMultiForm() {
  const html = `
    <div class="panel-title-desc">
      <h3>Multi-Clip Stitching & Tiling</h3>
      <p>Combine multiple video clips together. Join stitches them end-to-end; Grid tiles 4 clips into a 2x2 collage.</p>
    </div>

    <div class="form-group">
      <label>Layout Mode</label>
      <div style="display: flex; gap: 12px; margin-top: 4px;">
        <label class="btn" style="flex: 1; cursor: pointer; text-align: center; justify-content: center; ${activeMultiMode === 'join' ? 'border-color: var(--primary); background: rgba(59, 130, 246, 0.08); color: white;' : ''}">
          <input type="radio" name="multiMode" value="join" ${activeMultiMode === 'join' ? 'checked' : ''} style="display:none;">
          Stitch (Join End-to-End)
        </label>
        <label class="btn" style="flex: 1; cursor: pointer; text-align: center; justify-content: center; ${activeMultiMode === 'grid' ? 'border-color: var(--primary); background: rgba(59, 130, 246, 0.08); color: white;' : ''}">
          <input type="radio" name="multiMode" value="grid" ${activeMultiMode === 'grid' ? 'checked' : ''} style="display:none;">
          Tile 2x2 Grid (4 Clips)
        </label>
      </div>
    </div>

    <div class="form-group">
      <label style="justify-content: space-between; width: 100%;">
        <span>Input Video Clips</span>
        <button class="btn" style="padding: 2px 8px; font-size: 0.75rem; border-radius: var(--radius-sm);" onclick="openFileBrowser('addMultiClip', false)">+ Add Clip</button>
      </label>
      <div class="multi-list" id="multiClipsList">
        <!-- Injected dynamically -->
      </div>
      <span class="field-desc" id="multiModeHelp">For Stitch, add 2 or more videos. For Grid, add exactly 4.</span>
    </div>

    <div class="form-group">
      <label>Reconciliation Mode</label>
      <select id="multiReconcile">
        <option value="pad">Pad (add black bars, keep aspect)</option>
        <option value="crop">Crop (fill width/height, center-crop)</option>
        <option value="stretch">Stretch (rescale to match, aspect distort)</option>
      </select>
      <span class="field-desc">How to unify differing resolutions before combining them.</span>
    </div>

    <div class="form-group">
      <label>Output Video File <span style="font-weight: normal; font-size: 0.75rem; color: var(--text-muted);">(Optional)</span></label>
      <div class="input-row">
        <input type="text" id="multiOutput" placeholder="Leave empty for auto-naming">
        <button class="btn" onclick="openFileBrowser('multiOutput', false, 'file_save')">Save As</button>
      </div>
      <span class="field-desc">Where the merged output video will be written.</span>
    </div>

    <div class="dream-section-title">Run</div>
    <div class="knob-bank">
      ${knobUnitHtml({ id: 'multiDryRun', label: 'Dry run', value: '0', binary: true, leftCap: 'Run', rightCap: 'Dry' })}
    </div>
    <p class="dream-hint">Dry = print shell command only, no file written.</p>
  `;

  elements.actionPanel.innerHTML = html;

  setupBinaryKnob({
    knobId: 'multiDryRunKnob', indicatorId: 'multiDryRunKnobInd', hiddenId: 'multiDryRun',
    leftValue: '0', rightValue: '1', initial: '0',
  });

  // Add listeners
  const modeRadios = document.querySelectorAll('input[name="multiMode"]');
  modeRadios.forEach(radio => {
    radio.addEventListener('change', (e) => {
      activeMultiMode = e.target.value;
      
      // Update wrapper styles
      e.target.closest('div').querySelectorAll('label').forEach(lbl => {
        lbl.style.borderColor = 'var(--panel-border)';
        lbl.style.background = 'transparent';
        lbl.style.color = 'var(--text-muted)';
      });
      const selectedLabel = e.target.closest('label');
      selectedLabel.style.borderColor = 'var(--primary)';
      selectedLabel.style.background = 'rgba(59, 130, 246, 0.08)';
      selectedLabel.style.color = 'white';

      const helpText = document.getElementById('multiModeHelp');
      if (activeMultiMode === 'join') {
        helpText.textContent = 'For Stitch, add 2 or more videos.';
      } else {
        helpText.textContent = 'For Grid, add exactly 4 videos: top-left, top-right, bottom-left, bottom-right.';
      }
      renderMultiClipsList();
    });
  });

  renderMultiClipsList();
}

function renderMultiClipsList() {
  const container = document.getElementById('multiClipsList');
  if (!container) return;
  container.innerHTML = '';

  if (state.multiClips.length === 0) {
    container.innerHTML = `<div class="multi-empty">No clips added. Click "+ Add Clip" to select files.</div>`;
    return;
  }

  state.multiClips.forEach((path, idx) => {
    const filename = path.substring(path.lastIndexOf('/') + 1);
    
    // Label for 2x2 grid slots
    let positionLabel = '';
    if (activeMultiMode === 'grid') {
      if (idx === 0) positionLabel = '<span style="color:var(--primary); font-weight:600; font-size:0.7rem; margin-right:6px;">[Top-Left]</span>';
      else if (idx === 1) positionLabel = '<span style="color:var(--primary); font-weight:600; font-size:0.7rem; margin-right:6px;">[Top-Right]</span>';
      else if (idx === 2) positionLabel = '<span style="color:var(--primary); font-weight:600; font-size:0.7rem; margin-right:6px;">[Bottom-Left]</span>';
      else if (idx === 3) positionLabel = '<span style="color:var(--primary); font-weight:600; font-size:0.7rem; margin-right:6px;">[Bottom-Right]</span>';
      else positionLabel = '<span style="color:var(--error); font-weight:600; font-size:0.7rem; margin-right:6px;">[Extra - Will crop]</span>';
    }

    const item = document.createElement('div');
    item.className = 'multi-item';
    item.innerHTML = `
      <span title="${path}">${positionLabel}${idx+1}. ${filename}</span>
      <div style="display:flex; gap: 4px;">
        <button class="btn" style="padding: 2px 6px; font-size:0.7rem;" onclick="moveMultiClip(${idx}, -1)" ${idx === 0 ? 'disabled' : ''}>▲</button>
        <button class="btn" style="padding: 2px 6px; font-size:0.7rem;" onclick="moveMultiClip(${idx}, 1)" ${idx === state.multiClips.length - 1 ? 'disabled' : ''}>▼</button>
        <button class="btn" style="padding: 2px 6px; font-size:0.7rem; color:var(--error); border-color:rgba(239, 68, 68, 0.1);" onclick="removeMultiClip(${idx})">✕</button>
      </div>
    `;
    container.appendChild(item);
  });
}

function addMultiClipPath(path) {
  state.multiClips.push(path);
  renderMultiClipsList();
}

window.removeMultiClip = function(idx) {
  state.multiClips.splice(idx, 1);
  renderMultiClipsList();
};

window.moveMultiClip = function(idx, direction) {
  const newIndex = idx + direction;
  if (newIndex < 0 || newIndex >= state.multiClips.length) return;
  const temp = state.multiClips[idx];
  state.multiClips[idx] = state.multiClips[newIndex];
  state.multiClips[newIndex] = temp;
  renderMultiClipsList();
};

// Advanced Form
function renderAdvancedForm() {
  const html = `
    <div class="panel-title-desc">
      <h3>Raw transmute pass-through</h3>
      <p>Direct entry for arbitrary flag combinations (e.g. crop first frame, letterbox reversed, etc.). Matches CLI format.</p>
    </div>

    <div class="form-group">
      <label>Input Argument</label>
      <div class="input-row">
        <input type="text" id="advInput" placeholder="file, folder, or comma-separated list">
        <button class="btn" onclick="openFileBrowser('advInput', false)">Browse</button>
      </div>
      <span class="field-desc">Can be a video file path, a folder, or comma-joined video file paths.</span>
    </div>

    <div class="form-group">
      <label>Flags / Arguments</label>
      <input type="text" id="advFlags" placeholder="e.g. -f -s">
      <span class="field-desc">Flags separated by spaces, e.g. <code>-f -s -q 2</code> (first frame, square-crop, quality 2).</span>
    </div>

    <div class="form-group">
      <label>Output File <span style="font-weight: normal; font-size: 0.75rem; color: var(--text-muted);">(Optional)</span></label>
      <div class="input-row">
        <input type="text" id="advOutput" placeholder="Leave empty for auto-naming">
        <button class="btn" onclick="openFileBrowser('advOutput', false, 'file_save')">Save As</button>
      </div>
      <span class="field-desc">Where the output file will be written. Auto-named if blank.</span>
    </div>

    <div class="dream-section-title">Run</div>
    <div class="knob-bank">
      ${knobUnitHtml({ id: 'advDryRun', label: 'Dry run', value: '0', binary: true, leftCap: 'Run', rightCap: 'Dry' })}
    </div>
    <p class="dream-hint">Dry = print shell command only, no file written.</p>
  `;

  elements.actionPanel.innerHTML = html;

  setupBinaryKnob({
    knobId: 'advDryRunKnob', indicatorId: 'advDryRunKnobInd', hiddenId: 'advDryRun',
    leftValue: '0', rightValue: '1', initial: '0',
  });
}

export {
  transmuteOpsDetails,
  activeTransmuteOp,
  activeMultiMode,
  renderTransmuteForm,
  updateTransmuteExtras,
  updateRampInfoLine,
  renderMultiForm,
  renderMultiClipsList,
  addMultiClipPath,
  renderAdvancedForm,
};
