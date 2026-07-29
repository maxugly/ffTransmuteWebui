import { state, elements } from '/app.js';
import { setupContinuousKnob, setupBinaryKnob, knobUnitHtml } from '/js/ui/knobs.js';

// Mosh Form
// Mosh Form
function renderMoshForm() {
  const html = `
    <div class="panel-title-desc">
      <h3>Datamoshing & Vector Effects</h3>
      <p>Smear, bleed, and hijack video streams using low-level MPEG-4 codec hacks.</p>
    </div>

    <div class="form-group">
      <label>Datamosh Effect Mode</label>
      <select id="moshEffectSelect">
        <option value="melt" ${state.selectedMoshMode === 'melt' ? 'selected' : ''}>Continuous Melt (Vector Smear)</option>
        <option value="classic" ${state.selectedMoshMode === 'classic' ? 'selected' : ''}>Classic Mosh (Keyframe Suppress)</option>
        <option value="hijack" ${state.selectedMoshMode === 'hijack' ? 'selected' : ''}>Visual Hijack (P-Frame Injection)</option>
        <option value="destruct" ${state.selectedMoshMode === 'destruct' ? 'selected' : ''}>Residual Destruct (DCT Clear)</option>
        <option value="mv_hack" ${state.selectedMoshMode === 'mv_hack' ? 'selected' : ''}>Motion Vector Hack (Warp/Freeze)</option>
      </select>
    </div>

    <p class="field-desc" style="font-size: 0.78rem; color: var(--text-muted); margin-top: 4px;">
      Set input/output paths and frame range in the global bar above.
    </p>

    <!-- Mode Specific Parameters -->
    <div id="moshParamsContainer">
      <!-- Injected dynamically based on selected mode -->
    </div>
  `;

  elements.actionPanel.innerHTML = html;

  // Add listeners
  const select = document.getElementById('moshEffectSelect');
  select.addEventListener('change', (e) => {
    state.selectedMoshMode = e.target.value;
    updateMoshParams();
  });

  updateMoshParams();
}

function updateMoshParams() {
  const container = document.getElementById('moshParamsContainer');
  if (!container) return;
  container.innerHTML = '';
  
  const mode = state.selectedMoshMode;
  let html = '';

  if (mode === 'melt') {
    html = `
      <div class="dream-section-title">Smear</div>
      <div class="knob-bank">
        ${knobUnitHtml({ id: 'moshTail', label: 'Smear tail', value: '18' })}
      </div>
      <p class="dream-hint">Memory length in frames. Higher = longer, gooier drips.</p>

      <!-- Vector Joystick Pad for Melt mode -->
      <div class="vector-pad-wrapper" style="margin-top: 16px;">
        <label>Mosh Dynamics (Click & Drag Joystick)</label>
        <div style="display: flex; align-items: center; gap: 20px;">
          <div class="vector-pad" id="meltPad">
            <div class="vector-pad-crosshair-h"></div>
            <div class="vector-pad-crosshair-v"></div>
            <div class="vector-pad-knob" id="meltKnob"></div>
          </div>
          <div class="vector-pad-values">
            <span>Damping: <input type="text" class="pad-value-input" id="padMeltDamp" value="15%"></span>
            <span>V-Drift: <input type="text" class="pad-value-input" id="padMeltDrift" value="5%"></span>
          </div>
        </div>
      </div>

      <!-- Hidden inputs for Melt backend compatibility -->
      <input type="number" id="moshDamp" value="15" style="display: none;">
      <input type="number" id="moshDrift" value="1" style="display: none;">

    `;
  } else if (mode === 'classic') {
    html = `
      <div style="background: rgba(255, 255, 255, 0.02); border: 1px solid var(--panel-border); padding: 12px 16px; border-radius: var(--radius-md); font-size: 0.85rem; color: var(--text-muted); line-height: 1.4;">
        <strong>Classic Mode:</strong> Keyframe-suppression mosh (Avidemux style). Glitches only appear at camera cuts. If the video is a single shot, it will look unglitched.
      </div>

    `;
  } else if (mode === 'hijack') {
    html = `
      <div class="dream-section-title">Hijack</div>
      <div class="knob-bank">
        ${knobUnitHtml({ id: 'hijackSourceSelect', label: 'Source', value: 'file', binary: true, leftCap: 'Image', rightCap: 'Frame' })}
        ${knobUnitHtml({ id: 'hijackTransitionStyle', label: 'Transition', value: 'smear', binary: true, leftCap: 'Smear', rightCap: 'Freeze' })}
      </div>
      <p class="dream-hint">
        <strong>Smear</strong> keeps motion vectors (video motion drags the inject).
        <strong>Freeze</strong> zeroes vectors (image holds still). Residuals cleared either way.
      </p>

      <div class="form-group" id="groupHijackFile">
        <label>Injected Image Path</label>
        <div class="input-row">
          <input type="text" id="hijackImagePath" placeholder="/absolute/path/to/image.png">
          <button class="btn" onclick="openFileBrowser('hijackImagePath', false, 'file', 'image')">Browse</button>
        </div>
        <span class="field-desc">Image file to inject as the starting texture.</span>
      </div>

      <div class="form-group" id="groupHijackFrame" style="display: none;">
        <label>Source Frame Index to Extract</label>
        <input type="number" id="hijackSourceFrame" value="50" min="0" step="1">
        <span class="field-desc">The index of the frame (0-indexed) inside the video to clone and inject.</span>
      </div>

    `;
  } else if (mode === 'destruct') {
    html = `
      <div style="background: rgba(255, 255, 255, 0.02); border: 1px solid var(--panel-border); padding: 12px 16px; border-radius: var(--radius-md); font-size: 0.85rem; color: var(--text-muted); line-height: 1.4; margin-bottom: 16px;">
        <strong>Residual Destruct:</strong> Zeroes out the error-correction data (DCT coefficients) for P-frames in the specified range. Creates instant pixel bleed Trails.
      </div>
      
    `;
  } else if (mode === 'mv_hack') {
    html = `
      <div style="background: rgba(255, 255, 255, 0.02); border: 1px solid var(--panel-border); padding: 12px 16px; border-radius: var(--radius-md); font-size: 0.85rem; color: var(--text-muted); line-height: 1.4; margin-bottom: 16px;">
        <strong>Motion Vector Hack:</strong> Multiplies motion speed or offsets motion vector coordinates for a targeted range of frames.
      </div>

      <!-- Vector joystick and rotary knob layout -->
      <div style="display: flex; justify-content: center; gap: 40px; background: rgba(255, 255, 255, 0.015); border: 1px solid var(--panel-border); padding: 20px; border-radius: var(--radius-md); margin-bottom: 16px;">
        <!-- Vector Joystick Pad -->
        <div style="display: flex; flex-direction: column; align-items: center; gap: 8px;">
          <label style="font-size: 0.8rem; font-weight: 600; color: var(--text-muted);">Drift Direction Bias (Joystick)</label>
          <div class="vector-pad" id="vectorPad">
            <div class="vector-pad-crosshair-h"></div>
            <div class="vector-pad-crosshair-v"></div>
            <div class="vector-pad-knob" id="vectorKnob"></div>
          </div>
          <div class="vector-pad-values">
            <span>H: <input type="text" class="pad-value-input" id="padValH" value="0%"></span>
            <span>V: <input type="text" class="pad-value-input" id="padValV" value="0%"></span>
          </div>
        </div>

        <!-- DAW Rotary Knob -->
        <div style="display: flex; flex-direction: column; align-items: center; gap: 8px;">
          <label style="font-size: 0.8rem; font-weight: 600; color: var(--text-muted);">Motion Multiplier</label>
          <div class="daw-knob" id="mvKnob">
            <div class="daw-knob-dial"></div>
            <div class="daw-knob-indicator" id="mvKnobIndicator"></div>
          </div>
          <input type="text" class="daw-knob-value-input" id="mvKnobVal" value="1.0x">
        </div>
      </div>

      <!-- Hidden inputs for backend compatibility -->
      <input type="number" id="mvDriftH" value="0" style="display: none;">
      <input type="number" id="mvDriftV" value="0" style="display: none;">
      <input type="number" id="mvMultiplier" value="100" style="display: none;">
    `;
  }

  container.innerHTML = html;

  // Re-attach listeners dynamically
  if (mode === 'melt') {
    setupContinuousKnob({
      knobId: 'moshTailKnob', indicatorId: 'moshTailKnobInd', valueId: 'moshTailVal', hiddenId: 'moshTail',
      min: 1, max: 100, step: 1, decimals: 0,
    });
    // Set up Melt joystick pad
    setupMeltPad();

  } else if (mode === 'classic') {

  } else if (mode === 'hijack') {
    setupBinaryKnob({
      knobId: 'hijackSourceSelectKnob', indicatorId: 'hijackSourceSelectKnobInd', hiddenId: 'hijackSourceSelect',
      leftValue: 'file', rightValue: 'frame', initial: 'file',
    });
    setupBinaryKnob({
      knobId: 'hijackTransitionStyleKnob', indicatorId: 'hijackTransitionStyleKnobInd', hiddenId: 'hijackTransitionStyle',
      leftValue: 'smear', rightValue: 'freeze', initial: 'smear',
    });
    const syncHijackSource = () => {
      const isFile = (document.getElementById('hijackSourceSelect')?.value || 'file') === 'file';
      const gf = document.getElementById('groupHijackFile');
      const gr = document.getElementById('groupHijackFrame');
      if (gf) gf.style.display = isFile ? 'block' : 'none';
      if (gr) gr.style.display = isFile ? 'none' : 'block';
    };
    document.getElementById('hijackSourceSelect')?.addEventListener('change', syncHijackSource);
    syncHijackSource();

  } else if (mode === 'destruct') {

  } else if (mode === 'mv_hack') {
    setupVectorPad();
    setupDawKnob();

  }
}

function setupVectorPad() {
  const pad = document.getElementById('vectorPad');
  const knob = document.getElementById('vectorKnob');
  const valH = document.getElementById('padValH');
  const valV = document.getElementById('padValV');
  const inputH = document.getElementById('mvDriftH');
  const inputV = document.getElementById('mvDriftV');

  if (!pad || !knob || !valH || !valV || !inputH || !inputV) return;

  const maxVal = 20; // maximum offset mapping at edge of circle

  function updateUIFromCoords(dx, dy) {
    knob.style.left = `${(dx + 1) * 50}%`;
    knob.style.top = `${(dy + 1) * 50}%`;

    const driftH = Math.round(dx * maxVal);
    const driftV = Math.round(-dy * maxVal);

    if (document.activeElement !== valH) {
      valH.value = `${Math.round(-dx * 100)}%`;
    }
    if (document.activeElement !== valV) {
      valV.value = `${Math.round(-dy * 100)}%`;
    }

    // Negated horizontal coordinate mapping for backend parity
    inputH.value = -driftH;
    inputV.value = driftV;
  }

  function updateFromCoords(clientX, clientY) {
    const rect = pad.getBoundingClientRect();
    const halfW = rect.width / 2;
    const halfH = rect.height / 2;

    const dx = Math.max(-1, Math.min(1, (clientX - rect.left - halfW) / halfW));
    const dy = Math.max(-1, Math.min(1, (clientY - rect.top - halfH) / halfH));

    updateUIFromCoords(dx, dy);
  }

  function onMouseDown(e) {
    pad.classList.add('active');
    updateFromCoords(e.clientX, e.clientY);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    e.preventDefault();
  }

  function onMouseMove(e) {
    updateFromCoords(e.clientX, e.clientY);
  }

  function onMouseUp() {
    pad.classList.remove('active');
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
  }

  pad.addEventListener('mousedown', onMouseDown);

  // Editable input textboxes listeners
  function onTextSubmit() {
    let pctH = parseInt(valH.value.replace(/[^0-9-]/g, ''));
    if (isNaN(pctH)) pctH = 0;
    if (pctH < -100) pctH = -100;
    if (pctH > 100) pctH = 100;

    let pctV = parseInt(valV.value.replace(/[^0-9-]/g, ''));
    if (isNaN(pctV)) pctV = 0;
    if (pctV < -100) pctV = -100;
    if (pctV > 100) pctV = 100;

    const driftH = Math.round((pctH / 100) * maxVal);
    const driftV = Math.round((pctV / 100) * maxVal);

    // dx = -driftH / maxVal, dy = -driftV / maxVal
    updateUIFromCoords(-driftH / maxVal, -driftV / maxVal);
  }

  valH.addEventListener('change', onTextSubmit);
  valH.addEventListener('blur', onTextSubmit);
  valH.addEventListener('keydown', (e) => { if (e.key === 'Enter') { valH.blur(); e.preventDefault(); } });

  valV.addEventListener('change', onTextSubmit);
  valV.addEventListener('blur', onTextSubmit);
  valV.addEventListener('keydown', (e) => { if (e.key === 'Enter') { valV.blur(); e.preventDefault(); } });

  // Initial draw
  updateUIFromCoords(0, 0);
}

function setupMeltPad() {
  const pad = document.getElementById('meltPad');
  const knob = document.getElementById('meltKnob');
  const valDamp = document.getElementById('padMeltDamp');
  const valDrift = document.getElementById('padMeltDrift');
  
  const inputDamp = document.getElementById('moshDamp');
  const inputDrift = document.getElementById('moshDrift');

  if (!pad || !knob || !valDamp || !valDrift || !inputDamp || !inputDrift) return;

  const maxDrift = 20;

  function updateUI(dampVal, driftVal) {
    const dx = (dampVal - 50) / 50;
    const dy = -driftVal / maxDrift; // up is positive
    
    knob.style.left = `${(dx + 1) * 50}%`;
    knob.style.top = `${(dy + 1) * 50}%`;

    if (document.activeElement !== valDamp) {
      valDamp.value = `${dampVal}%`;
    }
    if (document.activeElement !== valDrift) {
      const driftPercent = Math.round((driftVal / maxDrift) * 100);
      valDrift.value = `${driftPercent}%`;
    }

    inputDamp.value = dampVal;
    inputDrift.value = driftVal;
  }

  function updateFromCoords(clientX, clientY) {
    const rect = pad.getBoundingClientRect();
    const halfW = rect.width / 2;
    const halfH = rect.height / 2;

    const dx = Math.max(-1, Math.min(1, (clientX - rect.left - halfW) / halfW));
    const dy = Math.max(-1, Math.min(1, (clientY - rect.top - halfH) / halfH));

    const dampVal = Math.round((dx + 1) * 50);
    const driftVal = Math.round(-dy * maxDrift);

    updateUI(dampVal, driftVal);
  }

  function onMouseDown(e) {
    pad.classList.add('active');
    updateFromCoords(e.clientX, e.clientY);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    e.preventDefault();
  }

  function onMouseMove(e) {
    updateFromCoords(e.clientX, e.clientY);
  }

  function onMouseUp() {
    pad.classList.remove('active');
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
  }

  pad.addEventListener('mousedown', onMouseDown);

  function onTextSubmit() {
    let dVal = parseInt(valDamp.value.replace(/[^0-9-]/g, ''));
    if (isNaN(dVal)) dVal = 15;
    if (dVal < 0) dVal = 0;
    if (dVal > 100) dVal = 100;

    let pctVal = parseInt(valDrift.value.replace(/[^0-9-]/g, ''));
    if (isNaN(pctVal)) pctVal = 5;
    if (pctVal < -100) pctVal = -100;
    if (pctVal > 100) pctVal = 100;
    
    const drVal = Math.round((pctVal / 100) * maxDrift);

    updateUI(dVal, drVal);
  }

  valDamp.addEventListener('change', onTextSubmit);
  valDamp.addEventListener('blur', onTextSubmit);
  valDamp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { valDamp.blur(); e.preventDefault(); } });

  valDrift.addEventListener('change', onTextSubmit);
  valDrift.addEventListener('blur', onTextSubmit);
  valDrift.addEventListener('keydown', (e) => { if (e.key === 'Enter') { valDrift.blur(); e.preventDefault(); } });

  // Initial draw
  updateUI(parseInt(inputDamp.value), parseInt(inputDrift.value));
}

function setupDawKnob() {
  const knob = document.getElementById('mvKnob');
  const indicator = document.getElementById('mvKnobIndicator');
  const valueDisplay = document.getElementById('mvKnobVal');
  const hiddenInput = document.getElementById('mvMultiplier');

  if (!knob || !indicator || !valueDisplay || !hiddenInput) return;

  const minAngle = -135;
  const maxAngle = 135;
  const rangeAngle = maxAngle - minAngle;

  const minVal = 0.0;
  const maxVal = 4.0;
  const rangeVal = maxVal - minVal;

  let currentVal = parseFloat(hiddenInput.value) / 100.0; 
  let startY = 0;
  let startVal = 1.0;
  const pixelRange = 150; 

  // Set initial position
  updateKnobUI(currentVal);

  function updateKnobUI(val) {
    const percent = (val - minVal) / rangeVal;
    const angle = minAngle + percent * rangeAngle;
    
    // Rotate indicator
    indicator.style.transform = `translate(-50%, -100%) rotate(${angle}deg)`;
    
    // Update labels and input field (multiplied by 100 for backend percent compatibility)
    if (document.activeElement !== valueDisplay) {
      valueDisplay.value = `${val.toFixed(1)}x`;
    }
    hiddenInput.value = Math.round(val * 100);
  }

  function onMouseDown(e) {
    knob.classList.add('active');
    startY = e.clientY;
    startVal = currentVal;
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    e.preventDefault();
  }

  function onMouseMove(e) {
    const deltaY = startY - e.clientY; // Upward drag is positive Y delta
    const deltaVal = (deltaY / pixelRange) * rangeVal;
    
    let newVal = startVal + deltaVal;
    if (newVal < minVal) newVal = minVal;
    if (newVal > maxVal) newVal = maxVal;
    
    currentVal = newVal;
    updateKnobUI(currentVal);
  }

  function onMouseUp() {
    knob.classList.remove('active');
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
  }

  knob.addEventListener('mousedown', onMouseDown);

  function onTextSubmit() {
    let raw = valueDisplay.value.replace(/[xX]/g, '').trim();
    let val = parseFloat(raw);
    if (isNaN(val)) val = 1.0;
    if (val < minVal) val = minVal;
    if (val > maxVal) val = maxVal;
    
    currentVal = val;
    updateKnobUI(currentVal);
  }

  valueDisplay.addEventListener('change', onTextSubmit);
  valueDisplay.addEventListener('blur', onTextSubmit);
  valueDisplay.addEventListener('keydown', (e) => { if (e.key === 'Enter') { valueDisplay.blur(); e.preventDefault(); } });
}


export { renderMoshForm, updateMoshParams, setupVectorPad, setupMeltPad, setupDawKnob };
