// State
let state = {
  activeTab: 'mosh',
  operations: {},
  health: { ok: true, warnings: [] },
  fb: {
    currentPath: '',
    selectedPath: '',
    selectedName: '',
    selectedIsDir: false,
    targetInputId: '',
    selectDirOnly: false,
    resolveMode: 'file' // 'file' or 'dir'
  },
  multiClips: [],
  selectedMoshMode: 'melt', // 'melt' or 'classic'
  moshVideoFrames: 100,
  pool: {
    items: [], // { path, name, size?, meta?, hash? }
    selectedPath: null, // sticky selection (click) — syncs library ↔ sequence
    hoverPath: null,    // temporary hover only (does not change selection)
    loading: false,
    // Sequence composer: ordered clips to stitch
    sequence: [], // { id, path, name }
    focusPath: null, // deprecated alias; display uses hoverPath || selectedPath
    seqDragId: null,
    reconcile: 'pad',
    aspect: 'auto',       // auto|1:1|16:9|…|custom
    aspectCustom: '',     // when aspect === 'custom': W:H or WxH
    outputPath: '',
    // Sequence preview playback
    playback: {
      playing: false,
      index: 0,
      loop: false,
      video: null, // HTMLVideoElement while active
    },
    // Tile display
    tileZoom: 200, // minmax track size in px (reset = current default)
    tileInfo: null, // filled from defaultTileInfo()
    tileInfoMenuOpen: false,
    // Frame match (pHash next-clip finder)
    matchMaxDistance: 10,
    matchMode: 'next', // next | prev | both
    matchResults: null, // last API response
    matchLoading: false,
    // Resizable / collapsible dock layout
    layout: {
      composeHeight: 280,
      focusWidth: 340,
      selectionHeight: 0, // 0 = auto aspect-ratio (no dead space)
      matchHeight: 180,
      collapsed: {
        sequence: false,
        selection: false,
        matches: false,
      },
    },
  }
};

const POOL_LAYOUT_DEFAULTS = {
  composeHeight: 280,
  focusWidth: 340,
  selectionHeight: 0, // 0 = auto (aspect-ratio 32/9 for dual frames)
  matchHeight: 180,
  collapsed: { sequence: false, selection: false, matches: false },
};

function ensurePoolLayout() {
  if (!state.pool.layout) state.pool.layout = { ...POOL_LAYOUT_DEFAULTS, collapsed: { ...POOL_LAYOUT_DEFAULTS.collapsed } };
  const L = state.pool.layout;
  L.collapsed = L.collapsed || { ...POOL_LAYOUT_DEFAULTS.collapsed };
  for (const k of ['sequence', 'selection', 'matches']) {
    if (L.collapsed[k] === undefined) L.collapsed[k] = false;
  }
  return L;
}

let _poolSeqId = 1;
let _poolSaveTimer = null;
let _poolPersistReady = false; // don't save until restore finishes

const VIDEO_EXTS = ['.mp4', '.m4v', '.mov', '.avi', '.mkv', '.webm', '.mpeg', '.mpg', '.wmv', '.flv', '.ts', '.mts', '.m2ts'];

/** Tile overlay fields (checkbox menu). order = menu + render order. */
const TILE_INFO_FIELDS = [
  { key: 'name', label: 'File name' },
  { key: 'path', label: 'Full path' },
  { key: 'hash', label: 'Content hash' },
  { key: 'opens', label: 'Open / history counts' },
  { key: 'duration', label: 'Duration' },
  { key: 'fps', label: 'Frame rate' },
  { key: 'frames', label: 'Frame count' },
  { key: 'video_codec', label: 'Video codec' },
  { key: 'audio_codec', label: 'Audio codec' },
  { key: 'size', label: 'File size' },
  { key: 'dims', label: 'Resolution' },
  { key: 'frame_labels', label: 'FIRST / LAST labels' },
];

const POOL_ZOOM = {
  min: 100,
  max: 440,
  reset: 200, // matches original card density
  step: 28,
};

function defaultTileInfo() {
  const o = {};
  TILE_INFO_FIELDS.forEach(f => { o[f.key] = true; });
  return o;
}

function ensureTileInfo() {
  if (!state.pool.tileInfo) state.pool.tileInfo = defaultTileInfo();
  // fill any new keys added later
  TILE_INFO_FIELDS.forEach(f => {
    if (state.pool.tileInfo[f.key] === undefined) state.pool.tileInfo[f.key] = true;
  });
  return state.pool.tileInfo;
}

// init defaults
state.pool.tileInfo = defaultTileInfo();
state.pool.tileZoom = POOL_ZOOM.reset;

// DOM Elements
const elements = {
  statusDot: document.getElementById('statusDot'),
  statusText: document.getElementById('statusText'),
  tabTitle: document.getElementById('tabTitle'),
  btnRun: document.getElementById('btnRun'),
  actionPanel: document.getElementById('actionPanel'),
  mediaViewer: document.getElementById('mediaViewer'),
  mediaInfo: document.getElementById('mediaInfo'),
  mediaName: document.getElementById('mediaName'),
  mediaPath: document.getElementById('mediaPath'),
  consoleBody: document.getElementById('consoleBody'),
  btnClearConsole: document.getElementById('btnClearConsole'),
  btnOpenFolder: document.getElementById('btnOpenFolder'),
  
  // Modal File Browser
  fbModal: document.getElementById('fbModal'),
  fbUpBtn: document.getElementById('fbUpBtn'),
  fbPathInput: document.getElementById('fbPathInput'),
  fbShortcuts: document.getElementById('fbShortcuts'),
  fbList: document.getElementById('fbList'),
  btnCloseFb: document.getElementById('btnCloseFb'),
  btnCancelFb: document.getElementById('btnCancelFb'),
  btnConfirmFb: document.getElementById('btnConfirmFb')
};

// Initialize
async function init() {
  setupEventListeners();
  setupPreviewConsoleResize();
  await checkHealth();
  await fetchOperations();
  await restorePoolState();
  switchTab('mosh');
  // Fit empty viewer once layout settles
  requestAnimationFrame(() => fitPreviewViewer());
}

// Event Listeners
function setupEventListeners() {
  // Navigation Tabs
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
      const tab = e.currentTarget.getAttribute('data-tab');
      switchTab(tab);
    });
  });

  // Action Buttons
  elements.btnRun.addEventListener('click', runActiveOperation);
  elements.btnClearConsole.addEventListener('click', () => {
    elements.consoleBody.innerHTML = '~ terminal cleared';
  });

  // Folder Opening Shortcut (Simulated info)
  elements.btnOpenFolder.addEventListener('click', () => {
    const path = elements.mediaPath.textContent;
    if (path) {
      logConsole(`Output folder: ${path.substring(0, path.lastIndexOf('/'))}`);
    }
  });

  // File Browser Modal Buttons
  elements.btnCloseFb.addEventListener('click', closeFbModal);
  elements.btnCancelFb.addEventListener('click', closeFbModal);
  elements.fbUpBtn.addEventListener('click', navigateUpFb);
  elements.btnConfirmFb.addEventListener('click', confirmFbSelection);
}

// API Calls
async function checkHealth() {
  try {
    const response = await fetch('/health');
    const data = await response.json();
    state.health = data;
    if (data.warnings && data.warnings.length > 0) {
      elements.statusDot.className = 'status-dot loading';
      elements.statusText.textContent = `${data.warnings.length} Warnings`;
      logConsole(`[HEALTH WARNINGS]:\n${data.warnings.join('\n')}`);
    } else {
      elements.statusDot.className = 'status-dot';
      elements.statusText.textContent = 'System Ready';
    }
  } catch (err) {
    elements.statusDot.className = 'status-dot error';
    elements.statusText.textContent = 'Offline';
    logConsole(`[HEALTH ERROR]: Cannot connect to API backend: ${err.message}`);
  }
}

async function fetchOperations() {
  try {
    const response = await fetch('/ops');
    const data = await response.json();
    state.operations = data;
  } catch (err) {
    logConsole(`[ERROR]: Failed to load operations spec: ${err.message}`);
  }
}

// Tab Switching
function switchTab(tab) {
  state.activeTab = tab;
  
  // Update Active Link UI
  document.querySelectorAll('.nav-item').forEach(item => {
    if (item.getAttribute('data-tab') === tab) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });

  // Update Page Title
  let title = 'Operations';
  if (tab === 'mosh') title = 'Datamosh Smear';
  if (tab === 'transmute') title = 'Single-Clip Transmutations';
  if (tab === 'multi') title = 'Layout Templates (Join / Grid)';
  if (tab === 'advanced') title = 'Advanced (Raw CLI)';
  // Pool tab: drop the big header title (sidebar already shows active item)
  if (tab === 'pool') title = '';
  elements.tabTitle.textContent = title;

  // Hide Run on library tab (pool has its own Stitch control)
  if (elements.btnRun) {
    elements.btnRun.style.display = tab === 'pool' ? 'none' : '';
  }

  // Pool takes most of the workspace
  const appContent = document.querySelector('.app-content');
  if (appContent) {
    appContent.classList.toggle('pool-workspace', tab === 'pool');
  }

  // Render Form for the Tab
  renderTabForm(tab);
}

// Render Specific Tab Forms
function renderTabForm(tab) {
  elements.actionPanel.innerHTML = '';
  elements.actionPanel.classList.remove('pool-active');

  if (tab === 'mosh') {
    renderMoshForm();
  } else if (tab === 'transmute') {
    renderTransmuteForm();
  } else if (tab === 'multi') {
    renderMultiForm();
  } else if (tab === 'advanced') {
    renderAdvancedForm();
  } else if (tab === 'pool') {
    renderPoolForm();
  }
}

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

    <div class="form-group">
      <label>Input Video File</label>
      <div class="input-row">
        <input type="text" id="moshInput" placeholder="/absolute/path/to/input.mp4">
        <button class="btn" onclick="openFileBrowser('moshInput', false)">Browse</button>
      </div>
      <span class="field-desc">Choose a video file to datamosh.</span>
    </div>

    <div class="form-group">
      <label>Output Video File</label>
      <div class="input-row">
        <input type="text" id="moshOutput" placeholder="/absolute/path/to/output.mp4">
        <button class="btn" onclick="openFileBrowser('moshOutput', false, 'file_save')">Save As</button>
      </div>
      <span class="field-desc">Where the glitched output video will be written.</span>
    </div>

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
    syncMoshOutput();
  });

  const moshInput = document.getElementById('moshInput');
  moshInput.addEventListener('input', syncMoshOutput);

  updateMoshParams();
}

function updateMoshParams() {
  const container = document.getElementById('moshParamsContainer');
  if (!container) return;
  container.innerHTML = '';
  
  const mode = state.selectedMoshMode;
  let html = '';

  const maxFrames = state.moshVideoFrames || 100;

  if (mode === 'melt') {
    html = `
      <div class="form-group">
        <label>Smear Tail (Memory): <span class="slider-val" id="valTail">18</span></label>
        <div class="slider-container">
          <input type="range" id="moshTail" min="1" max="100" value="18">
        </div>
        <span class="field-desc">Number of smear frames. Higher = longer, gooier drips.</span>
      </div>

      <!-- Vector Joystick Pad for Melt mode -->
      <div class="vector-pad-wrapper" style="margin-top: 16px;">
        <label>Mosh Dynamics (Click & Drag Joystick)</label>
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
      <div class="form-group">
        <label>Hijack Source Type</label>
        <select id="hijackSourceSelect">
          <option value="file">Image File (from disk)</option>
          <option value="frame">Extract Frame (from this video)</option>
        </select>
        <span class="field-desc">Choose whether to inject a custom image file or grab an existing frame of the video.</span>
      </div>

      <div class="form-group" id="groupHijackFile">
        <label>Injected Image Path</label>
        <div class="input-row">
          <input type="text" id="hijackImagePath" placeholder="/absolute/path/to/image.png">
          <button class="btn" onclick="openFileBrowser('hijackImagePath', false)">Browse</button>
        </div>
        <span class="field-desc">Image file to inject as the starting texture.</span>
      </div>

      <div class="form-group" id="groupHijackFrame" style="display: none;">
        <label>Source Frame Index to Extract</label>
        <input type="number" id="hijackSourceFrame" value="50" min="0" step="1">
        <span class="field-desc">The index of the frame (0-indexed) inside the video to clone and inject.</span>
      </div>

      <!-- Dual Range Timeline Slider -->
      <div class="timeline-wrapper">
        <label>Mosh Target Range (Frames)</label>
        <div class="timeline-container">
          <div class="timeline-track"></div>
          <div class="timeline-range" id="timelineRange"></div>
          <input type="range" id="timelineStart" class="timeline-thumb" min="1" max="${maxFrames}" value="50">
          <input type="range" id="timelineEnd" class="timeline-thumb" min="1" max="${maxFrames}" value="${maxFrames}">
        </div>
        <div class="timeline-labels">
          <span>Start: <input type="text" class="timeline-value-input" id="valStartFrame" value="50"></span>
          <span>End: <input type="text" class="timeline-value-input" id="valEndFrame" value="${maxFrames}"></span>
        </div>
      </div>

      <!-- Hidden inputs for backend compatibility -->
      <input type="number" id="hijackStartFrame" value="50" style="display: none;">
      <input type="number" id="hijackEndFrame" value="${maxFrames}" style="display: none;">

      <div class="form-group">
        <label>Transition Style</label>
        <select id="hijackTransitionStyle">
          <option value="smear">Smear (Keep Motion Vectors, Clear Residuals)</option>
          <option value="freeze">Freeze (Zero Motion Vectors, Clear Residuals)</option>
        </select>
        <span class="field-desc">Choose whether the motion of the video drags the image or if it holds frozen still.</span>
      </div>
    `;
  } else if (mode === 'destruct') {
    html = `
      <div style="background: rgba(255, 255, 255, 0.02); border: 1px solid var(--panel-border); padding: 12px 16px; border-radius: var(--radius-md); font-size: 0.85rem; color: var(--text-muted); line-height: 1.4; margin-bottom: 16px;">
        <strong>Residual Destruct:</strong> Zeroes out the error-correction data (DCT coefficients) for P-frames in the specified range. Creates instant pixel bleed Trails.
      </div>
      
      <!-- Dual Range Timeline Slider -->
      <div class="timeline-wrapper">
        <label>Mosh Target Range (Frames)</label>
        <div class="timeline-container">
          <div class="timeline-track"></div>
          <div class="timeline-range" id="timelineRange"></div>
          <input type="range" id="timelineStart" class="timeline-thumb" min="1" max="${maxFrames}" value="1">
          <input type="range" id="timelineEnd" class="timeline-thumb" min="1" max="${maxFrames}" value="${maxFrames}">
        </div>
        <div class="timeline-labels">
          <span>Start: <input type="text" class="timeline-value-input" id="valStartFrame" value="1"></span>
          <span>End: <input type="text" class="timeline-value-input" id="valEndFrame" value="${maxFrames}"></span>
        </div>
      </div>

      <!-- Hidden inputs for backend compatibility -->
      <input type="number" id="destructStart" value="1" style="display: none;">
      <input type="number" id="destructEnd" value="${maxFrames}" style="display: none;">
    `;
  } else if (mode === 'mv_hack') {
    html = `
      <div style="background: rgba(255, 255, 255, 0.02); border: 1px solid var(--panel-border); padding: 12px 16px; border-radius: var(--radius-md); font-size: 0.85rem; color: var(--text-muted); line-height: 1.4; margin-bottom: 16px;">
        <strong>Motion Vector Hack:</strong> Multiplies motion speed or offsets motion vector coordinates for a targeted range of frames.
      </div>

      <!-- Dual Range Timeline Slider -->
      <div class="timeline-wrapper">
        <label>Mosh Target Range (Frames)</label>
        <div class="timeline-container">
          <div class="timeline-track"></div>
          <div class="timeline-range" id="timelineRange"></div>
          <input type="range" id="timelineStart" class="timeline-thumb" min="1" max="${maxFrames}" value="1">
          <input type="range" id="timelineEnd" class="timeline-thumb" min="1" max="${maxFrames}" value="${maxFrames}">
        </div>
        <div class="timeline-labels">
          <span>Start: <input type="text" class="timeline-value-input" id="valStartFrame" value="1"></span>
          <span>End: <input type="text" class="timeline-value-input" id="valEndFrame" value="${maxFrames}"></span>
        </div>
      </div>

      <!-- Hidden inputs for backend compatibility -->
      <input type="number" id="mvStart" value="1" style="display: none;">
      <input type="number" id="mvEnd" value="${maxFrames}" style="display: none;">

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
    const tail = document.getElementById('moshTail');
    if (tail) tail.addEventListener('input', (e) => document.getElementById('valTail').textContent = e.target.value);
    
    // Set up Melt joystick pad
    setupMeltPad();
  } else if (mode === 'hijack') {
    const hjSelect = document.getElementById('hijackSourceSelect');
    hjSelect.addEventListener('change', (e) => {
      const isFile = e.target.value === 'file';
      document.getElementById('groupHijackFile').style.display = isFile ? 'block' : 'none';
      document.getElementById('groupHijackFrame').style.display = isFile ? 'none' : 'block';
    });

    setupTimelineSlider('hijackStartFrame', 'hijackEndFrame', 50, maxFrames);
  } else if (mode === 'destruct') {
    setupTimelineSlider('destructStart', 'destructEnd', 1, maxFrames);
  } else if (mode === 'mv_hack') {
    setupVectorPad();
    setupDawKnob();
    setupTimelineSlider('mvStart', 'mvEnd', 1, maxFrames);
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
    // Clamp inside unit circle
    const dist = Math.sqrt(dx * dx + dy * dy);
    let cdx = dx, cdy = dy;
    if (dist > 1) {
      cdx /= dist;
      cdy /= dist;
    }

    knob.style.left = `${(cdx + 1) * 50}%`;
    knob.style.top = `${(cdy + 1) * 50}%`;

    const driftH = Math.round(cdx * maxVal);
    const driftV = Math.round(-cdy * maxVal);

    if (document.activeElement !== valH) {
      valH.value = `${Math.round(-cdx * 100)}%`;
    }
    if (document.activeElement !== valV) {
      valV.value = `${Math.round(-cdy * 100)}%`;
    }

    // Negated horizontal coordinate mapping for backend parity
    inputH.value = -driftH;
    inputV.value = driftV;
  }

  function updateFromCoords(clientX, clientY) {
    const rect = pad.getBoundingClientRect();
    const halfW = rect.width / 2;
    const halfH = rect.height / 2;

    const dx = (clientX - rect.left - halfW) / halfW;
    const dy = (clientY - rect.top - halfH) / halfH;

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

    let dx = (clientX - rect.left - halfW) / halfW;
    let dy = (clientY - rect.top - halfH) / halfH;

    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > 1) {
      dx /= dist;
      dy /= dist;
    }

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

function syncMoshOutput() {
  const moshInput = document.getElementById('moshInput').value;
  const moshOutput = document.getElementById('moshOutput');
  if (moshInput && moshOutput) {
    const extIndex = moshInput.lastIndexOf('.');
    if (extIndex !== -1) {
      const base = moshInput.substring(0, extIndex);
      const ext = moshInput.substring(extIndex);
      const mode = state.selectedMoshMode;
      let suffix = '_mosh';
      if (mode === 'melt') suffix = '_melt';
      else if (mode === 'classic') suffix = '_classic';
      else if (mode === 'hijack') suffix = '_hijack';
      else if (mode === 'destruct') suffix = '_destruct';
      else if (mode === 'mv_hack') suffix = '_mvhack';
      moshOutput.value = base + suffix + ext;
    }
    
    // Probe the input video properties to update timeline max range
    probeMoshInputVideo();
  }
}

let currentProbedPath = '';
async function probeMoshInputVideo() {
  const path = document.getElementById('moshInput')?.value;
  if (!path || path === currentProbedPath) return;
  currentProbedPath = path;

  try {
    const res = await fetch(`/api/probe?path=${encodeURIComponent(path)}`);
    if (!res.ok) return;
    const data = await res.json();
    if (data.ok && data.frames) {
      state.moshVideoFrames = data.frames;
      
      // Update DOM range inputs dynamically if they exist
      const startEl = document.getElementById('timelineStart');
      const endEl = document.getElementById('timelineEnd');
      if (startEl && endEl) {
        startEl.max = data.frames;
        endEl.max = data.frames;
        
        let sVal = parseInt(startEl.value);
        let eVal = parseInt(endEl.value);
        if (sVal > data.frames) sVal = 1;
        if (eVal > data.frames) eVal = data.frames;
        startEl.value = sVal;
        endEl.value = eVal;
        
        // Trigger update Event
        startEl.dispatchEvent(new Event('input'));
      }
    }
  } catch (err) {
    console.error("Failed to probe video:", err);
  }
}

function setupTimelineSlider(hiddenStartId, hiddenEndId, defaultStart, defaultEnd) {
  const startInput = document.getElementById('timelineStart');
  const endInput = document.getElementById('timelineEnd');
  const rangeHighlight = document.getElementById('timelineRange');
  const valStart = document.getElementById('valStartFrame');
  const valEnd = document.getElementById('valEndFrame');
  
  const hiddenStart = document.getElementById(hiddenStartId);
  const hiddenEnd = document.getElementById(hiddenEndId);

  if (!startInput || !endInput || !rangeHighlight || !hiddenStart || !hiddenEnd || !valStart || !valEnd) return;

  const maxFrames = state.moshVideoFrames || 100;

  startInput.min = 1;
  startInput.max = maxFrames;
  endInput.min = 1;
  endInput.max = maxFrames;

  let initStart = parseInt(hiddenStart.value) || defaultStart;
  let initEnd = parseInt(hiddenEnd.value) || defaultEnd;

  if (initStart > maxFrames) initStart = 1;
  if (initEnd > maxFrames || initEnd === 999999) initEnd = maxFrames;

  startInput.value = initStart;
  endInput.value = initEnd;

  function updateTimeline() {
    let startVal = parseInt(startInput.value);
    let endVal = parseInt(endInput.value);

    // Keep at least 1 frame of distance
    if (startVal >= endVal) {
      if (this === startInput) {
        startInput.value = endVal - 1;
        startVal = endVal - 1;
      } else {
        endInput.value = startVal + 1;
        endVal = startVal + 1;
      }
    }

    const percentLeft = ((startVal - 1) / (maxFrames - 1)) * 100;
    const percentRight = ((endVal - 1) / (maxFrames - 1)) * 100;

    rangeHighlight.style.left = `${percentLeft}%`;
    rangeHighlight.style.width = `${percentRight - percentLeft}%`;

    if (document.activeElement !== valStart) {
      valStart.value = startVal;
    }
    if (document.activeElement !== valEnd) {
      valEnd.value = endVal;
    }

    hiddenStart.value = startVal;
    hiddenEnd.value = endVal;
  }

  startInput.addEventListener('input', updateTimeline);
  endInput.addEventListener('input', updateTimeline);

  // Range dragging variables
  let rangeDragging = false;
  let dragStartX = 0;
  let dragStartValL = 0;
  let dragStartValR = 0;

  function onRangeMouseDown(e) {
    const rect = rangeHighlight.getBoundingClientRect();
    const clickX = e.clientX;
    
    // Drag only if we clicked inside the highlight range bar
    if (clickX >= rect.left && clickX <= rect.right) {
      rangeDragging = true;
      dragStartX = clickX;
      dragStartValL = parseInt(startInput.value);
      dragStartValR = parseInt(endInput.value);
      
      rangeHighlight.classList.add('active');
      
      window.addEventListener('mousemove', onRangeMouseMove);
      window.addEventListener('mouseup', onRangeMouseUp);
      e.preventDefault();
    }
  }

  function onRangeMouseMove(e) {
    if (!rangeDragging) return;

    const trackRect = startInput.getBoundingClientRect();
    const trackWidth = trackRect.width;
    if (trackWidth <= 0) return;
    
    const deltaX = e.clientX - dragStartX;
    const deltaFrames = Math.round((deltaX / trackWidth) * (maxFrames - 1));
    
    let newStart = dragStartValL + deltaFrames;
    let newEnd = dragStartValR + deltaFrames;
    
    const rangeSpan = dragStartValR - dragStartValL;
    
    if (newStart < 1) {
      newStart = 1;
      newEnd = newStart + rangeSpan;
    }
    if (newEnd > maxFrames) {
      newEnd = maxFrames;
      newStart = newEnd - rangeSpan;
    }
    
    startInput.value = newStart;
    endInput.value = newEnd;
    
    updateTimeline();
  }

  function onRangeMouseUp() {
    rangeDragging = false;
    rangeHighlight.classList.remove('active');
    window.removeEventListener('mousemove', onRangeMouseMove);
    window.removeEventListener('mouseup', onRangeMouseUp);
  }

  rangeHighlight.addEventListener('mousedown', onRangeMouseDown);

  // Editable inputs key listeners
  function onTextSubmit() {
    let sVal = parseInt(valStart.value.replace(/[^0-9]/g, ''));
    let eVal = parseInt(valEnd.value.replace(/[^0-9]/g, ''));
    
    if (isNaN(sVal)) sVal = 1;
    if (isNaN(eVal)) eVal = maxFrames;

    if (sVal < 1) sVal = 1;
    if (eVal > maxFrames) eVal = maxFrames;

    if (sVal >= eVal) {
      if (this === valStart) {
        sVal = eVal - 1;
      } else {
        eVal = sVal + 1;
      }
    }

    startInput.value = sVal;
    endInput.value = eVal;
    
    updateTimeline();
  }

  valStart.addEventListener('change', onTextSubmit);
  valStart.addEventListener('blur', onTextSubmit);
  valStart.addEventListener('keydown', (e) => { if (e.key === 'Enter') { valStart.blur(); e.preventDefault(); } });

  valEnd.addEventListener('change', onTextSubmit);
  valEnd.addEventListener('blur', onTextSubmit);
  valEnd.addEventListener('keydown', (e) => { if (e.key === 'Enter') { valEnd.blur(); e.preventDefault(); } });

  // Initial update
  updateTimeline();
}

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
  stretch_exact: { summary: "Stretch to exact resolution", fields: ['width', 'height'] }
};

let activeTransmuteOp = 'first_frame';

function renderTransmuteForm() {
  let optionsHtml = '';
  Object.keys(transmuteOpsDetails).forEach(opId => {
    optionsHtml += `<option value="${opId}" ${activeTransmuteOp === opId ? 'selected' : ''}>${transmuteOpsDetails[opId].summary}</option>`;
  });

  const html = `
    <div class="panel-title-desc">
      <h3>Single-Clip Operations</h3>
      <p>Quick filters to extract frames/audio, change geometry, crop, pad, or reverse files. Fast stream-copy and standard transcoding.</p>
    </div>

    <div class="form-group">
      <label>Select Operation</label>
      <select id="transmuteOpSelect">
        ${optionsHtml}
      </select>
    </div>

    <div class="form-group">
      <label>Input File</label>
      <div class="input-row">
        <input type="text" id="transmuteInput" placeholder="/absolute/path/to/input.mp4">
        <button class="btn" onclick="openFileBrowser('transmuteInput', false)">Browse</button>
      </div>
      <span class="field-desc">Choose a video file to transmute.</span>
    </div>

    <div class="form-group">
      <label>Output File <span style="font-weight: normal; font-size: 0.75rem; color: var(--text-muted);">(Optional)</span></label>
      <div class="input-row">
        <input type="text" id="transmuteOutput" placeholder="Leave empty for auto-naming">
        <button class="btn" onclick="openFileBrowser('transmuteOutput', false, 'file_save')">Save As</button>
      </div>
      <span class="field-desc">If blank, output will be auto-named and saved in the input directory.</span>
    </div>

    <!-- Extra Params Container -->
    <div id="transmuteExtras">
      <!-- Injected dynamically -->
    </div>

    <div class="form-group horizontal">
      <label for="transmuteDryRun">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
        Dry Run Mode (Output shell command only)
      </label>
      <label class="switch">
        <input type="checkbox" id="transmuteDryRun">
        <span class="slider"></span>
      </label>
    </div>
  `;

  elements.actionPanel.innerHTML = html;
  
  // Set listener for selection
  const select = document.getElementById('transmuteOpSelect');
  select.addEventListener('change', (e) => {
    activeTransmuteOp = e.target.value;
    updateTransmuteExtras();
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
    const desc = isPng ? "PNG compression scale. 2-31, lower is higher quality." : "JPEG compression scale. 2-31, lower is higher quality.";
    html += `
      <div class="form-group">
        <label>Extract Quality: <span class="slider-val" id="valQuality">2</span></label>
        <div class="slider-container">
          <input type="range" id="transmuteQuality" min="2" max="31" value="2">
        </div>
        <span class="field-desc">${desc}</span>
      </div>
    `;
  }

  if (fields.includes('seconds_from_end')) {
    html += `
      <div class="form-group">
        <label>Seconds From End</label>
        <input type="number" id="transmuteSecondsFromEnd" value="0.1" step="0.1" min="0.0">
        <span class="field-desc">How far from the end of the video clip to seek before extracting the frame.</span>
      </div>
    `;
  }

  if (fields.includes('width') || fields.includes('height')) {
    html += `
      <div style="display: flex; gap: 16px; margin-bottom: 16px;">
        <div class="form-group" style="flex: 1; margin-bottom: 0;">
          <label>Width (px)</label>
          <input type="number" id="transmuteWidth" value="1920" step="2" min="16">
        </div>
        <div class="form-group" style="flex: 1; margin-bottom: 0;">
          <label>Height (px)</label>
          <input type="number" id="transmuteHeight" value="1080" step="2" min="16">
        </div>
      </div>
      <span class="field-desc" style="display: block; margin-top: -8px; margin-bottom: 16px;">Resolution dimensions. Whole, even numbers only.</span>
    `;
  }

  extrasContainer.innerHTML = html;

  // Set up listeners for new sliders
  const quality = document.getElementById('transmuteQuality');
  if (quality) {
    quality.addEventListener('input', (e) => {
      document.getElementById('valQuality').textContent = e.target.value;
    });
  }
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

    <div class="form-group horizontal">
      <label for="multiDryRun">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
        Dry Run Mode (Output shell command only)
      </label>
      <label class="switch">
        <input type="checkbox" id="multiDryRun">
        <span class="slider"></span>
      </label>
    </div>
  `;

  elements.actionPanel.innerHTML = html;

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

    <div class="form-group horizontal">
      <label for="advDryRun">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
        Dry Run Mode (Output shell command only)
      </label>
      <label class="switch">
        <input type="checkbox" id="advDryRun">
        <span class="slider"></span>
      </label>
    </div>
  `;

  elements.actionPanel.innerHTML = html;
}


// ─── Media Pool ───────────────────────────────────────────────────────────

function isVideoPath(path) {
  if (!path) return false;
  const lower = path.toLowerCase();
  return VIDEO_EXTS.some(ext => lower.endsWith(ext));
}

function basename(path) {
  if (!path) return '';
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.substring(i + 1) : path;
}

function formatDurationExact(seconds) {
  if (seconds == null || isNaN(seconds)) return '—';
  const s = Math.max(0, Number(seconds));
  // Exact seconds with millis for short clips, 3 decimal places max
  if (s < 60) return `${s.toFixed(3)}s`;
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  if (m < 60) return `${m}m ${rem.toFixed(3)}s`;
  const h = Math.floor(m / 60);
  const mins = m % 60;
  return `${h}h ${mins}m ${rem.toFixed(3)}s`;
}

function renderPoolForm() {
  const count = state.pool.items.length;
  const seqCount = state.pool.sequence.length;
  const selected = state.pool.selectedPath;
  const rec = state.pool.reconcile || 'pad';
  const outVal = state.pool.outputPath || '';

  const L = ensurePoolLayout();
  const col = L.collapsed;

  const html = `
    <div class="pool-workspace-inner">
      <div class="pool-top">
        <div class="pool-toolbar">
          <div class="pool-toolbar-actions">
            <button class="btn btn-primary" id="btnPoolImportFiles" type="button">+ Files</button>
            <button class="btn" id="btnPoolImportFolder" type="button">+ Folder</button>
            <button class="btn" id="btnPoolClear" type="button" ${count === 0 ? 'disabled' : ''}>Clear Pool</button>
            <button class="btn" id="btnSeqClear" type="button" ${seqCount === 0 ? 'disabled' : ''}>Clear Sequence</button>

            <div class="pool-zoom-group" title="Tile size">
              <button type="button" class="btn pool-zoom-btn" id="btnZoomMin" title="Minimum size">min</button>
              <button type="button" class="btn pool-zoom-btn" id="btnZoomOut" title="Zoom out">−</button>
              <button type="button" class="btn pool-zoom-btn pool-zoom-reset" id="btnZoomReset" title="Reset size (default)">reset</button>
              <button type="button" class="btn pool-zoom-btn" id="btnZoomIn" title="Zoom in">+</button>
              <button type="button" class="btn pool-zoom-btn" id="btnZoomMax" title="Maximum size">max</button>
            </div>

            <div class="pool-info-menu-wrap">
              <button type="button" class="btn" id="btnTileInfoMenu" title="Choose tile overlay fields">Info ▾</button>
              <div class="pool-info-menu" id="tileInfoMenu" hidden>
                <div class="pool-info-menu-title">Show on tiles</div>
                <div class="pool-info-menu-actions">
                  <button type="button" class="btn pool-info-mini" id="btnTileInfoAll">All</button>
                  <button type="button" class="btn pool-info-mini" id="btnTileInfoNone">None</button>
                </div>
                <div class="pool-info-checks" id="tileInfoChecks"></div>
              </div>
            </div>
          </div>
          <div class="pool-toolbar-meta">
            <span class="pool-count">${count} in pool · ${seqCount} in sequence</span>
            ${selected ? `
              <div class="pool-use-wrap">
                <label for="poolUseTarget" class="pool-use-label">Use as input</label>
                <select id="poolUseTarget" class="pool-use-select">
                  <option value="">— target —</option>
                  <option value="sequence">Add to sequence</option>
                  <option value="mosh">Datamosh input</option>
                  <option value="transmute">Transmute input</option>
                  <option value="multi">Add to Multi clips</option>
                  <option value="advanced">Advanced input</option>
                </select>
                <button class="btn btn-primary" id="btnPoolUse" type="button">Apply</button>
              </div>
            ` : ''}
          </div>
        </div>

        <div class="pool-grid-wrap">
          <div class="pool-grid" id="poolGrid"></div>
        </div>
      </div>

      <div class="pool-v-resize" id="poolVResize" title="Drag to resize dock"></div>

      <div class="pool-compose" id="poolCompose">
        <div class="pool-sequence-panel${col.sequence ? ' is-collapsed' : ''}" id="poolSequencePanel">
          <div class="pool-section-head" data-collapse="sequence">
            <button type="button" class="pool-collapse-btn" title="Collapse / expand sequence" aria-expanded="${!col.sequence}">
              <span class="pool-collapse-chevron">${col.sequence ? '▸' : '▾'}</span>
            </button>
            <span class="pool-section-title">Sequence</span>
            <div class="seq-transport" id="seqTransport" onclick="event.stopPropagation()">
              <button type="button" class="btn seq-ctrl" id="btnSeqPrev" title="Previous clip" ${seqCount === 0 ? 'disabled' : ''}>⏮</button>
              <button type="button" class="btn seq-ctrl seq-ctrl-play" id="btnSeqPlay" title="Play sequence" ${seqCount === 0 ? 'disabled' : ''}>▶</button>
              <button type="button" class="btn seq-ctrl" id="btnSeqPause" title="Pause" disabled>⏸</button>
              <button type="button" class="btn seq-ctrl" id="btnSeqStop" title="Stop" disabled>■</button>
              <button type="button" class="btn seq-ctrl" id="btnSeqNext" title="Next clip" ${seqCount === 0 ? 'disabled' : ''}>⏭</button>
              <button type="button" class="btn seq-ctrl ${state.pool.playback.loop ? 'active' : ''}" id="btnSeqLoop" title="Loop sequence" ${seqCount === 0 ? 'disabled' : ''}>🔁</button>
              <span class="seq-play-status" id="seqPlayStatus">—</span>
              <span class="seq-reorder-sep" aria-hidden="true"></span>
              <button type="button" class="btn seq-ctrl seq-reorder" id="btnSeqMoveFirst" title="Move selected to start" disabled>&lt;&lt;</button>
              <button type="button" class="btn seq-ctrl seq-reorder" id="btnSeqMoveLeft" title="Move selected earlier" disabled>&lt;</button>
              <button type="button" class="btn seq-ctrl seq-reorder" id="btnSeqMoveRight" title="Move selected later" disabled>&gt;</button>
              <button type="button" class="btn seq-ctrl seq-reorder" id="btnSeqMoveLast" title="Move selected to end" disabled>&gt;&gt;</button>
            </div>
          </div>
          <div class="pool-section-body" data-section="sequence">
            <div class="pool-sequence-box" id="poolSequenceBox" tabindex="0"></div>
            <div class="seq-clip-settings" id="seqClipSettings" hidden>
              <span class="seq-clip-settings-label">Selected clip</span>
              <span class="seq-clip-settings-name" id="seqClipName">—</span>
              <label class="pool-opt-label" title="Stretch or compress this clip to a target length in the stitch">Time (s)
                <input type="number" id="seqClipDuration" min="0.05" step="0.05" placeholder="native" class="seq-clip-dur-input">
              </label>
              <button type="button" class="btn pool-info-mini" id="btnSeqClipDurClear" title="Use original duration">Native</button>
              <span class="seq-clip-settings-hint" id="seqClipDurHint"></span>
            </div>
            <div class="pool-sequence-bar">
              <div class="pool-sequence-opts">
                <label class="pool-opt-label" title="How clips are scaled onto the canvas">Fit
                  <select id="poolReconcile">
                    <option value="pad" ${rec === 'pad' ? 'selected' : ''}>Pad (scale up, letterbox if AR differs)</option>
                    <option value="crop" ${rec === 'crop' ? 'selected' : ''}>Crop (scale up, center-crop if AR differs)</option>
                    <option value="stretch" ${rec === 'stretch' ? 'selected' : ''}>Stretch (warp AR)</option>
                  </select>
                </label>
                <label class="pool-opt-label" title="Target canvas aspect ratio">AR
                  <select id="poolAspect">
                    <option value="auto" ${(state.pool.aspect || 'auto') === 'auto' ? 'selected' : ''}>Auto</option>
                    <option value="1:1" ${state.pool.aspect === '1:1' ? 'selected' : ''}>1:1</option>
                    <option value="16:9" ${state.pool.aspect === '16:9' ? 'selected' : ''}>16:9</option>
                    <option value="9:16" ${state.pool.aspect === '9:16' ? 'selected' : ''}>9:16</option>
                    <option value="3:2" ${state.pool.aspect === '3:2' ? 'selected' : ''}>3:2</option>
                    <option value="2:3" ${state.pool.aspect === '2:3' ? 'selected' : ''}>2:3</option>
                    <option value="4:3" ${state.pool.aspect === '4:3' ? 'selected' : ''}>4:3</option>
                    <option value="3:4" ${state.pool.aspect === '3:4' ? 'selected' : ''}>3:4</option>
                    <option value="custom" ${state.pool.aspect === 'custom' ? 'selected' : ''}>Custom…</option>
                  </select>
                </label>
                <input type="text" id="poolAspectCustom" class="pool-aspect-custom"
                  placeholder="W:H or WxH" title="Custom aspect e.g. 5:4 or 1080x1920"
                  value="${escapeHtml(state.pool.aspectCustom || '')}"
                  style="display:${state.pool.aspect === 'custom' ? 'inline-block' : 'none'}; width: 100px;">
                <div class="input-row pool-out-row">
                  <input type="text" id="poolOutput" placeholder="Output path (blank = auto .mp4)" value="${escapeHtml(outVal)}">
                  <button class="btn" type="button" id="btnPoolOutBrowse">Save As</button>
                </div>
              </div>
              <button class="btn btn-primary pool-stitch-btn" id="btnPoolStitch" type="button" ${seqCount < 2 ? 'disabled' : ''}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16">
                  <polygon points="5 3 19 12 5 21 5 3"/>
                </svg>
                Stitch Sequence
              </button>
            </div>
          </div>
        </div>

        <div class="pool-h-resize" id="poolHResize" title="Drag to resize panels"></div>

        <div class="pool-focus-panel" id="poolFocusPanel">
          <div class="pool-focus-header">
            <div class="pool-section-head pool-section-head-inline" data-collapse="selection">
              <button type="button" class="pool-collapse-btn" title="Collapse / expand selection frames" aria-expanded="${!col.selection}">
                <span class="pool-collapse-chevron">${col.selection ? '▸' : '▾'}</span>
              </button>
              <span class="pool-section-title">Selection</span>
            </div>
            <div class="pool-match-controls">
              <label class="pool-match-label" title="pHash Hamming distance (0 = exact under hash)">
                ≤
                <input type="range" id="matchDistance" min="0" max="24" value="${state.pool.matchMaxDistance}" step="1">
                <span id="matchDistanceVal">${state.pool.matchMaxDistance}</span>
              </label>
              <select id="matchMode" class="pool-match-mode" title="Match direction">
                <option value="next" ${state.pool.matchMode === 'next' ? 'selected' : ''}>Next (last→first)</option>
                <option value="prev" ${state.pool.matchMode === 'prev' ? 'selected' : ''}>Prev (first→last)</option>
                <option value="both" ${state.pool.matchMode === 'both' ? 'selected' : ''}>Both</option>
              </select>
              <button type="button" class="btn btn-primary pool-match-btn" id="btnFindNext" ${selected ? '' : 'disabled'} title="Compare selection frame to pool via pHash">
                Find matches
              </button>
            </div>
          </div>

          <div class="pool-section-body${col.selection ? ' is-collapsed' : ''}" data-section="selection" id="poolSelectionBody">
            <div class="pool-focus-frame" id="poolFocusFrame">
              <div class="pool-focus-empty">Hover or click a clip</div>
            </div>
          </div>

          <div class="pool-sel-match-resize" id="poolSelMatchResize" title="Drag to resize selection vs matches"></div>

          <div class="pool-match-block${col.matches ? ' is-collapsed' : ''}" id="poolMatchBlock">
            <div class="pool-section-head" data-collapse="matches">
              <button type="button" class="pool-collapse-btn" title="Collapse / expand matches" aria-expanded="${!col.matches}">
                <span class="pool-collapse-chevron">${col.matches ? '▸' : '▾'}</span>
              </button>
              <span class="pool-section-title">Matches</span>
              <span class="pool-match-count-badge" id="matchCountBadge"></span>
              <button type="button" class="btn pool-info-mini" id="btnExpandMatches" title="Give matches more room (collapse selection, grow dock)">Expand</button>
            </div>
            <div class="pool-section-body" data-section="matches">
              <div class="pool-match-results" id="poolMatchResults" hidden></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  elements.actionPanel.innerHTML = html;
  elements.actionPanel.classList.add('pool-active');

  document.getElementById('btnPoolImportFiles')?.addEventListener('click', importPoolFiles);
  document.getElementById('btnPoolImportFolder')?.addEventListener('click', importPoolFolder);
  document.getElementById('btnPoolClear')?.addEventListener('click', clearPool);
  document.getElementById('btnSeqClear')?.addEventListener('click', clearSequence);
  document.getElementById('btnPoolUse')?.addEventListener('click', applyPoolAsInput);
  document.getElementById('btnPoolStitch')?.addEventListener('click', stitchPoolSequence);
  document.getElementById('btnPoolOutBrowse')?.addEventListener('click', () => {
    openFileBrowser('poolOutput', false, 'file_save');
  });
  document.getElementById('poolReconcile')?.addEventListener('change', (e) => {
    state.pool.reconcile = e.target.value;
    scheduleSavePoolState();
  });
  document.getElementById('poolAspect')?.addEventListener('change', (e) => {
    state.pool.aspect = e.target.value;
    const custom = document.getElementById('poolAspectCustom');
    if (custom) custom.style.display = state.pool.aspect === 'custom' ? 'inline-block' : 'none';
    scheduleSavePoolState();
  });
  document.getElementById('poolAspectCustom')?.addEventListener('input', (e) => {
    state.pool.aspectCustom = e.target.value.trim();
    scheduleSavePoolState();
  });
  document.getElementById('poolOutput')?.addEventListener('input', (e) => {
    state.pool.outputPath = e.target.value;
    scheduleSavePoolState();
  });

  // Zoom controls
  document.getElementById('btnZoomMin')?.addEventListener('click', () => setPoolZoom(POOL_ZOOM.min));
  document.getElementById('btnZoomOut')?.addEventListener('click', () => setPoolZoom(state.pool.tileZoom - POOL_ZOOM.step));
  document.getElementById('btnZoomReset')?.addEventListener('click', () => setPoolZoom(POOL_ZOOM.reset));
  document.getElementById('btnZoomIn')?.addEventListener('click', () => setPoolZoom(state.pool.tileZoom + POOL_ZOOM.step));
  document.getElementById('btnZoomMax')?.addEventListener('click', () => setPoolZoom(POOL_ZOOM.max));

  // Frame match controls
  document.getElementById('matchDistance')?.addEventListener('input', (e) => {
    state.pool.matchMaxDistance = parseInt(e.target.value, 10) || 0;
    const val = document.getElementById('matchDistanceVal');
    if (val) val.textContent = String(state.pool.matchMaxDistance);
  });
  document.getElementById('matchMode')?.addEventListener('change', (e) => {
    state.pool.matchMode = e.target.value;
  });
  document.getElementById('btnFindNext')?.addEventListener('click', runPoolMatch);

  // Tile info menu
  setupTileInfoMenu();

  // Sequence transport
  document.getElementById('btnSeqPlay')?.addEventListener('click', seqPlay);
  document.getElementById('btnSeqPause')?.addEventListener('click', seqPause);
  document.getElementById('btnSeqStop')?.addEventListener('click', seqStop);
  document.getElementById('btnSeqPrev')?.addEventListener('click', seqPrev);
  document.getElementById('btnSeqNext')?.addEventListener('click', seqNext);
  document.getElementById('btnSeqLoop')?.addEventListener('click', () => {
    state.pool.playback.loop = !state.pool.playback.loop;
    document.getElementById('btnSeqLoop')?.classList.toggle('active', state.pool.playback.loop);
    updateSeqTransportUI();
  });
  document.getElementById('btnSeqMoveFirst')?.addEventListener('click', (e) => {
    e.stopPropagation();
    moveSelectedInSequence('start');
  });
  document.getElementById('btnSeqMoveLeft')?.addEventListener('click', (e) => {
    e.stopPropagation();
    moveSelectedInSequence(-1);
  });
  document.getElementById('btnSeqMoveRight')?.addEventListener('click', (e) => {
    e.stopPropagation();
    moveSelectedInSequence(1);
  });
  document.getElementById('btnSeqMoveLast')?.addEventListener('click', (e) => {
    e.stopPropagation();
    moveSelectedInSequence('end');
  });

  document.getElementById('seqClipDuration')?.addEventListener('change', onSeqClipDurationChange);
  document.getElementById('seqClipDuration')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onSeqClipDurationChange();
  });
  document.getElementById('btnSeqClipDurClear')?.addEventListener('click', () => {
    const idx = findSelectedSeqIndex();
    if (idx < 0) return;
    state.pool.sequence[idx].targetDuration = null;
    const inp = document.getElementById('seqClipDuration');
    if (inp) inp.value = '';
    updateSeqClipSettings();
    scheduleSavePoolState();
    logConsole(`[SEQ]: Cleared time stretch for ${state.pool.sequence[idx].name}`);
  });

  setupSequenceDropZone();
  updateSeqClipSettings();
  setupPoolLayoutChrome();
  applyPoolZoom();
  renderPoolGrid();
  renderSequenceBox();
  updatePoolFocusFrame(displayFocusPath());
  updateSelectionHighlights();
  updateSeqTransportUI();
  // Re-show last match results if any
  if (state.pool.matchResults) {
    renderMatchResults(state.pool.matchResults);
  }
}

// ── Resizable / collapsible pool dock ─────────────────────────────────────

function applyPoolLayout() {
  const L = ensurePoolLayout();
  const compose = document.getElementById('poolCompose');
  const focus = document.getElementById('poolFocusPanel');
  const frame = document.getElementById('poolFocusFrame');
  const matchResults = document.getElementById('poolMatchResults');
  const selectionBody = document.getElementById('poolSelectionBody');
  const seqPanel = document.getElementById('poolSequencePanel');
  const matchBlock = document.getElementById('poolMatchBlock');

  if (compose) {
    compose.style.height = `${L.composeHeight}px`;
    compose.style.flex = `0 0 ${L.composeHeight}px`;
  }
  if (focus) {
    focus.style.width = `${L.focusWidth}px`;
    focus.style.flex = `0 0 ${L.focusWidth}px`;
  }
  if (frame && !L.collapsed.selection) {
    // 0 / unset → natural aspect-ratio (tight). Manual drag sets pixel height.
    if (L.selectionHeight && L.selectionHeight > 0) {
      frame.dataset.manualH = '1';
      frame.style.setProperty('--sel-h', `${L.selectionHeight}px`);
      frame.style.height = `${L.selectionHeight}px`;
    } else {
      frame.dataset.manualH = '0';
      frame.style.removeProperty('--sel-h');
      frame.style.height = '';
      frame.style.minHeight = '';
    }
  }
  if (matchResults && !L.collapsed.matches) {
    matchResults.style.flex = '1 1 auto';
    matchResults.style.minHeight = '80px';
    matchResults.style.maxHeight = 'none';
    // Prefer explicit height when set so list can scroll large
    if (L.matchHeight) {
      matchResults.style.height = `${L.matchHeight}px`;
    }
  }

  // Collapse classes
  if (seqPanel) seqPanel.classList.toggle('is-collapsed', !!L.collapsed.sequence);
  if (selectionBody) selectionBody.classList.toggle('is-collapsed', !!L.collapsed.selection);
  if (matchBlock) matchBlock.classList.toggle('is-collapsed', !!L.collapsed.matches);

  // Chevrons
  document.querySelectorAll('[data-collapse]').forEach(head => {
    const key = head.getAttribute('data-collapse');
    const chev = head.querySelector('.pool-collapse-chevron');
    const btn = head.querySelector('.pool-collapse-btn');
    const collapsed = !!L.collapsed[key];
    if (chev) chev.textContent = collapsed ? '▸' : '▾';
    if (btn) btn.setAttribute('aria-expanded', String(!collapsed));
  });
}

function togglePoolSection(key) {
  const L = ensurePoolLayout();
  L.collapsed[key] = !L.collapsed[key];
  applyPoolLayout();
  scheduleSavePoolState();
}

function expandMatchesRoom() {
  const L = ensurePoolLayout();
  L.collapsed.selection = true;
  L.collapsed.matches = false;
  L.composeHeight = Math.max(L.composeHeight, 360);
  L.focusWidth = Math.max(L.focusWidth, 380);
  L.matchHeight = Math.max(L.matchHeight, 240);
  applyPoolLayout();
  scheduleSavePoolState();
}

function setupPoolLayoutChrome() {
  applyPoolLayout();

  // Collapse toggles — click header or chevron button
  document.querySelectorAll('[data-collapse]').forEach(head => {
    const key = head.getAttribute('data-collapse');
    const onToggle = (e) => {
      // Don't steal clicks from transport / match controls inside header
      if (e.target.closest('.seq-transport, .pool-match-controls, #btnExpandMatches, select, input, a')) return;
      e.preventDefault();
      togglePoolSection(key);
    };
    head.addEventListener('click', onToggle);
  });

  document.getElementById('btnExpandMatches')?.addEventListener('click', (e) => {
    e.stopPropagation();
    expandMatchesRoom();
  });

  // Vertical resize: grid vs compose dock
  bindPoolDragResize(document.getElementById('poolVResize'), {
    axis: 'y',
    onMove: (dy, start) => {
      const L = ensurePoolLayout();
      const next = Math.max(140, Math.min(window.innerHeight * 0.75, start.composeHeight - dy));
      L.composeHeight = Math.round(next);
      applyPoolLayout();
    },
    startVals: () => ({ composeHeight: ensurePoolLayout().composeHeight }),
  });

  // Horizontal resize: sequence vs focus
  bindPoolDragResize(document.getElementById('poolHResize'), {
    axis: 'x',
    onMove: (dx, start) => {
      const L = ensurePoolLayout();
      const compose = document.getElementById('poolCompose');
      const maxW = compose ? compose.clientWidth - 160 : 600;
      L.focusWidth = Math.round(Math.max(220, Math.min(maxW, start.focusWidth - dx)));
      applyPoolLayout();
    },
    startVals: () => ({ focusWidth: ensurePoolLayout().focusWidth }),
  });

  // Selection frame vs matches
  bindPoolDragResize(document.getElementById('poolSelMatchResize'), {
    axis: 'y',
    onMove: (dy, start) => {
      const L = ensurePoolLayout();
      if (L.collapsed.selection || L.collapsed.matches) return;
      const baseH = start.selectionHeight > 0
        ? start.selectionHeight
        : (document.getElementById('poolFocusFrame')?.offsetHeight || 96);
      L.selectionHeight = Math.round(Math.max(48, Math.min(280, baseH + dy)));
      L.matchHeight = Math.round(Math.max(80, start.matchHeight - dy));
      applyPoolLayout();
    },
    startVals: () => {
      const L = ensurePoolLayout();
      const frameEl = document.getElementById('poolFocusFrame');
      return {
        selectionHeight: L.selectionHeight > 0 ? L.selectionHeight : (frameEl?.offsetHeight || 0),
        matchHeight: L.matchHeight,
      };
    },
  });
}

function bindPoolDragResize(el, { axis, onMove, startVals }) {
  if (!el) return;
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const startPtr = axis === 'y' ? e.clientY : e.clientX;
    const start = startVals();
    document.body.classList.add('pool-resizing');

    const onMovePtr = (ev) => {
      const cur = axis === 'y' ? ev.clientY : ev.clientX;
      const delta = cur - startPtr;
      onMove(delta, start);
    };
    const onUp = () => {
      el.releasePointerCapture(e.pointerId);
      el.removeEventListener('pointermove', onMovePtr);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      document.body.classList.remove('pool-resizing');
      scheduleSavePoolState();
    };
    el.addEventListener('pointermove', onMovePtr);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  });
}

function renderPoolGrid() {
  const grid = document.getElementById('poolGrid');
  if (!grid) return;

  if (state.pool.items.length === 0) {
    grid.innerHTML = `
      <div class="pool-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
          <rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>
        </svg>
        <p>No videos in the pool.</p>
        <p class="pool-empty-hint">Import files/folder, then drag cards into the sequence strip.</p>
      </div>
    `;
    return;
  }

  grid.innerHTML = '';
  state.pool.items.forEach((item, idx) => {
    const card = document.createElement('article');
    const isSelected = state.pool.selectedPath === item.path;
    const isHovered = state.pool.hoverPath === item.path;
    card.className = `pool-card${isSelected ? ' selected' : ''}${isHovered ? ' hovered' : ''}`;
    card.dataset.path = item.path;
    card.dataset.idx = String(idx);
    card.draggable = true;
    card.title = 'Drag into sequence to stitch';

    const firstSrc = poolThumbUrl(item, 'first');
    const lastSrc = poolThumbUrl(item, 'last');
    const meta = item.meta;
    const loadingMeta = !meta && !item.metaError;
    const info = ensureTileInfo();
    const showLabels = info.frame_labels !== false;
    const metaHtml = loadingMeta
      ? '<span class="pool-meta-loading">hashing + probing…</span>'
      : buildPoolMetaHtml(item);
    const hasOverlay = loadingMeta || (metaHtml && metaHtml.trim().length > 0);

    card.innerHTML = `
      <div class="pool-card-actions">
        <div class="pool-send-wrap">
          <button type="button" class="btn pool-send-btn" title="Send this clip to a tool">Send to ▾</button>
          <div class="pool-send-menu" hidden>
            <button type="button" class="pool-send-item" data-send="mosh">Datamosh</button>
            <button type="button" class="pool-send-item" data-send="transmute">Transmute</button>
            <button type="button" class="pool-send-item" data-send="multi">Multi (Join/Grid)</button>
            <button type="button" class="pool-send-item" data-send="advanced">Raw CLI</button>
            <button type="button" class="pool-send-item" data-send="sequence">Sequence</button>
            <button type="button" class="pool-send-item" data-send="preview">Preview only</button>
            <div class="pool-send-sep"></div>
            <button type="button" class="pool-send-item" data-send="save_first_png">Save first frame PNG…</button>
            <button type="button" class="pool-send-item" data-send="save_last_png">Save last frame PNG…</button>
          </div>
        </div>
        <button class="pool-card-remove" type="button" title="Remove from pool" data-remove="${idx}">✕</button>
      </div>
      <div class="pool-frames">
        <div class="pool-frame">
          <img class="pool-thumb" src="${firstSrc}" alt="First frame" loading="lazy" data-which="first" draggable="false"
               onerror="this.classList.add('broken'); this.alt='no frame';">
          ${showLabels ? '<span class="pool-frame-label">FIRST</span>' : ''}
        </div>
        <div class="pool-frame">
          <img class="pool-thumb" src="${lastSrc}" alt="Last frame" loading="lazy" data-which="last" draggable="false"
               onerror="this.classList.add('broken'); this.alt='no frame';">
          ${showLabels ? '<span class="pool-frame-label">LAST</span>' : ''}
        </div>
      </div>
      ${hasOverlay ? `
      <div class="pool-overlay${!loadingMeta && !metaHtml.trim() ? ' empty' : ''}">
        <div class="pool-overlay-text" id="poolMeta-${idx}">
          ${metaHtml}
        </div>
      </div>` : `<div class="pool-overlay-text" id="poolMeta-${idx}" style="display:none"></div>`}
    `;

    card.addEventListener('click', (e) => {
      if (e.target.closest('.pool-card-remove, .pool-send-wrap')) return;
      selectPoolItem(item.path);
    });

    card.addEventListener('mouseenter', () => setPoolHover(item.path));
    card.addEventListener('mouseleave', (e) => {
      // Leaving for another card/token keeps hover via that element's enter
      const to = e.relatedTarget;
      if (to && (to.closest?.('.pool-card') || to.closest?.('.seq-token'))) return;
      clearPoolHover();
    });

    card.addEventListener('dragstart', (e) => {
      if (e.target.closest('.pool-send-wrap, .pool-card-remove')) {
        e.preventDefault();
        return;
      }
      e.dataTransfer.setData('application/x-pool-path', item.path);
      e.dataTransfer.setData('text/plain', item.path);
      e.dataTransfer.effectAllowed = 'copy';
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));

    card.querySelector('.pool-card-remove')?.addEventListener('click', (e) => {
      e.stopPropagation();
      removePoolItem(idx);
    });

    // Send-to dropdown
    const sendWrap = card.querySelector('.pool-send-wrap');
    const sendBtn = card.querySelector('.pool-send-btn');
    const sendMenu = card.querySelector('.pool-send-menu');
    sendBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const wasOpen = sendMenu && !sendMenu.hidden;
      // Close every other open menu / drop stacking boost
      document.querySelectorAll('.pool-card.menu-open').forEach(c => {
        if (c !== card) {
          c.classList.remove('menu-open');
          const m = c.querySelector('.pool-send-menu');
          if (m) m.hidden = true;
        }
      });
      if (!sendMenu) return;
      if (wasOpen) {
        sendMenu.hidden = true;
        card.classList.remove('menu-open');
      } else {
        sendMenu.hidden = false;
        card.classList.add('menu-open'); // lifts whole card above siblings
      }
    });
    sendMenu?.querySelectorAll('.pool-send-item').forEach(opt => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const target = opt.dataset.send;
        if (sendMenu) sendMenu.hidden = true;
        card.classList.remove('menu-open');
        sendPoolPathTo(item.path, target);
      });
    });
    // Don't start card drag from the send control
    sendWrap?.addEventListener('mousedown', (e) => e.stopPropagation());
    sendWrap?.addEventListener('pointerdown', (e) => e.stopPropagation());

    // Double-click adds to sequence
    card.addEventListener('dblclick', (e) => {
      if (e.target.closest('.pool-card-remove, .pool-send-wrap')) return;
      addPathToSequence(item.path);
    });

    grid.appendChild(card);

    if (!meta && !item.metaError) {
      loadPoolItemMeta(item, idx);
    }
  });
}

// ── Sequence composer ─────────────────────────────────────────────────────

function findPoolItem(path) {
  return state.pool.items.find(i => i.path === path) || null;
}

/** Path shown in the Selection frame: temporary hover, else sticky selection. */
function displayFocusPath() {
  return state.pool.hoverPath || state.pool.selectedPath || null;
}

/** Temporary hover — updates Selection preview only; does not change selection. */
function setPoolHover(path) {
  if (!path) {
    clearPoolHover();
    return;
  }
  state.pool.hoverPath = path;
  state.pool.focusPath = path; // keep legacy field in sync for any remaining callers
  updatePoolFocusFrame(path);
  updateSelectionHighlights();
}

function clearPoolHover() {
  if (!state.pool.hoverPath) return;
  state.pool.hoverPath = null;
  state.pool.focusPath = state.pool.selectedPath;
  updatePoolFocusFrame(state.pool.selectedPath);
  updateSelectionHighlights();
}

/** Sticky click selection — library and sequence stay in sync by path. */
function setPoolFocus(path, opts = {}) {
  // Back-compat: hard focus = select; soft = hover only
  if (opts.soft) {
    setPoolHover(path);
    return;
  }
  if (path) selectPoolItem(path);
}

/** Sync .selected / .hovered classes across pool cards and sequence tokens. */
function updateSelectionHighlights() {
  const sel = state.pool.selectedPath;
  const hov = state.pool.hoverPath;
  document.querySelectorAll('.pool-card').forEach(el => {
    const p = el.dataset.path;
    el.classList.toggle('selected', !!sel && p === sel);
    el.classList.toggle('hovered', !!hov && p === hov);
    el.classList.toggle('focused', !!hov && p === hov); // alias for existing CSS
  });
  document.querySelectorAll('.seq-token').forEach(el => {
    const p = el.dataset.path;
    el.classList.toggle('selected', !!sel && p === sel);
    el.classList.toggle('hovered', !!hov && p === hov);
    el.classList.toggle('focused', (!!hov && p === hov) || (!!sel && p === sel && !hov));
  });
}

function updatePoolFocusFrame(path) {
  const frame = document.getElementById('poolFocusFrame');
  if (!frame) return;

  if (!path) {
    frame.innerHTML = `<div class="pool-focus-empty">Hover or click a clip</div>`;
    return;
  }

  let item = findPoolItem(path);
  if (!item) {
    // Sequence-only path not in pool (shouldn't happen often)
    item = { path, name: basename(path), hash: null, meta: null };
  }

  const firstSrc = poolThumbUrl(item, 'first');
  const lastSrc = poolThumbUrl(item, 'last');
  const name = item.name || basename(path);
  const m = item.meta || {};
  const dur = m.duration != null ? formatDurationExact(m.duration) : '';
  const hash = item.hash || m.hash || '';

  frame.innerHTML = `
    <div class="pool-focus-frames">
      <div class="pool-frame">
        <img class="pool-thumb" src="${firstSrc}" alt="First" draggable="false"
             onerror="this.classList.add('broken')">
        <span class="pool-frame-label">FIRST</span>
      </div>
      <div class="pool-frame">
        <img class="pool-thumb" src="${lastSrc}" alt="Last" draggable="false"
             onerror="this.classList.add('broken')">
        <span class="pool-frame-label">LAST</span>
      </div>
    </div>
    <div class="pool-focus-meta pool-overlay-text">
      <div class="pool-meta-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
      <div class="pool-meta-path" title="${escapeHtml(path)}">${escapeHtml(path)}</div>
      <div class="pool-meta-row">
        ${hash ? `<span class="pool-hash">#${escapeHtml(shortHash(hash))}</span>` : ''}
        ${dur ? `<span>${dur}</span>` : ''}
        ${m.fps ? `<span>${m.fps} fps</span>` : ''}
        ${m.frames != null ? `<span>${m.frames} fr</span>` : ''}
      </div>
    </div>
  `;

  // Lazy-load meta if unknown
  const poolItem = findPoolItem(path);
  if (poolItem && !poolItem.meta && !poolItem.metaError) {
    const idx = state.pool.items.indexOf(poolItem);
    loadPoolItemMeta(poolItem, idx).then(() => {
      if (displayFocusPath() === path) updatePoolFocusFrame(path);
      renderSequenceBox(); // refresh duration labels on tokens
    });
  }
}

function setupSequenceDropZone() {
  const box = document.getElementById('poolSequenceBox');
  if (!box) return;

  box.addEventListener('dragover', (e) => {
    e.preventDefault();
    const types = e.dataTransfer.types;
    if (types.includes('application/x-pool-path') || types.includes('application/x-seq-id') || types.includes('text/plain')) {
      e.dataTransfer.dropEffect = types.includes('application/x-seq-id') ? 'move' : 'copy';
      box.classList.add('drag-over');
    }
  });

  box.addEventListener('dragleave', (e) => {
    if (!box.contains(e.relatedTarget)) box.classList.remove('drag-over');
  });

  box.addEventListener('drop', (e) => {
    e.preventDefault();
    box.classList.remove('drag-over');

    const seqId = e.dataTransfer.getData('application/x-seq-id');
    const poolPath = e.dataTransfer.getData('application/x-pool-path') || e.dataTransfer.getData('text/plain');

    // Drop target index from token under cursor
    const tokenEl = e.target.closest('.seq-token');
    let insertAt = state.pool.sequence.length;
    if (tokenEl) {
      const tid = tokenEl.dataset.id;
      const idx = state.pool.sequence.findIndex(s => String(s.id) === String(tid));
      if (idx >= 0) {
        // Insert before or after based on mouse X midpoint
        const rect = tokenEl.getBoundingClientRect();
        const before = e.clientX < rect.left + rect.width / 2;
        insertAt = before ? idx : idx + 1;
      }
    }

    if (seqId) {
      // Reorder existing token
      const from = state.pool.sequence.findIndex(s => String(s.id) === String(seqId));
      if (from < 0) return;
      const [item] = state.pool.sequence.splice(from, 1);
      if (insertAt > from) insertAt -= 1;
      state.pool.sequence.splice(insertAt, 0, item);
      renderSequenceBox();
      selectPoolItem(item.path);
      scheduleSavePoolState();
      return;
    }

    if (poolPath && isVideoPath(poolPath)) {
      addPathToSequence(poolPath, insertAt);
    }
  });
}

function addPathToSequence(path, insertAt = null) {
  if (!path || !isVideoPath(path)) return;
  const item = findPoolItem(path);
  const name = item?.name || basename(path);
  const entry = {
    id: _poolSeqId++,
    path,
    name,
    targetDuration: null, // seconds; null = native length
  };
  if (insertAt == null || insertAt < 0 || insertAt > state.pool.sequence.length) {
    state.pool.sequence.push(entry);
  } else {
    state.pool.sequence.splice(insertAt, 0, entry);
  }
  logConsole(`[SEQ]: + ${name}`);
  renderSequenceBox();
  selectPoolItem(path); // select in library + sequence together
  // Refresh stitch button / counts without full re-render if possible
  refreshPoolToolbarCounts();
  updateSeqTransportUI();
  scheduleSavePoolState();
}

function removeSequenceAt(idx) {
  if (idx < 0 || idx >= state.pool.sequence.length) return;
  const [removed] = state.pool.sequence.splice(idx, 1);
  logConsole(`[SEQ]: − ${removed.name}`);
  // Adjust playback index if needed
  if (state.pool.playback.index >= state.pool.sequence.length) {
    state.pool.playback.index = Math.max(0, state.pool.sequence.length - 1);
  }
  renderSequenceBox();
  refreshPoolToolbarCounts();
  updateSeqTransportUI();
  scheduleSavePoolState();
}

function clearSequence() {
  if (state.pool.sequence.length === 0) return;
  seqStop();
  state.pool.sequence = [];
  logConsole('[SEQ]: Cleared');
  renderSequenceBox();
  refreshPoolToolbarCounts();
  updateSeqTransportUI();
  scheduleSavePoolState();
}

function renderSequenceBox() {
  const box = document.getElementById('poolSequenceBox');
  if (!box) return;

  const stitchBtn = document.getElementById('btnPoolStitch');
  if (stitchBtn) stitchBtn.disabled = state.pool.sequence.length < 2;

  if (state.pool.sequence.length === 0) {
    box.innerHTML = `<div class="seq-placeholder">Drop videos here to build a stitch sequence…</div>`;
    updateSeqTransportUI();
    return;
  }

  box.innerHTML = '';
  const playIdx = state.pool.playback.playing || state.pool.playback.index >= 0
    ? state.pool.playback.index
    : -1;

  state.pool.sequence.forEach((entry, idx) => {
    const tok = document.createElement('span');
    const isPlaying = state.pool.playback.playing && playIdx === idx;
    const isSelected = state.pool.selectedPath === entry.path;
    const isHovered = state.pool.hoverPath === entry.path;
    tok.className = `seq-token${isSelected ? ' selected' : ''}${isHovered ? ' hovered' : ''}${isSelected && !isHovered ? ' focused' : ''}${isPlaying ? ' playing' : ''}`;
    tok.draggable = true;
    tok.dataset.id = String(entry.id);
    tok.dataset.path = entry.path;
    tok.dataset.idx = String(idx);
    tok.title = entry.path;

    const dur = findPoolItem(entry.path)?.meta?.duration;
    const durLabel = dur != null ? ` ${formatDurationExact(dur)}` : '';

    tok.innerHTML = `
      <span class="seq-token-idx">${idx + 1}</span>
      <span class="seq-token-name">${escapeHtml(entry.name)}</span>
      <span class="seq-token-dur">${durLabel}</span>
      <button type="button" class="seq-token-x" title="Remove">✕</button>
    `;

    tok.addEventListener('click', (e) => {
      if (e.target.closest('.seq-token-x')) return;
      state.pool.playback.index = idx;
      selectPoolItem(entry.path); // also selects matching library tile
      updateSeqTransportUI();
    });
    tok.addEventListener('mouseenter', () => {
      if (!state.pool.playback.playing) setPoolHover(entry.path);
    });
    tok.addEventListener('mouseleave', (e) => {
      const to = e.relatedTarget;
      if (to && (to.closest?.('.pool-card') || to.closest?.('.seq-token'))) return;
      clearPoolHover();
    });

    tok.querySelector('.seq-token-x')?.addEventListener('click', (e) => {
      e.stopPropagation();
      removeSequenceAt(idx);
    });

    tok.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-seq-id', String(entry.id));
      e.dataTransfer.setData('text/plain', entry.path);
      e.dataTransfer.effectAllowed = 'move';
      state.pool.seqDragId = entry.id;
      tok.classList.add('dragging');
    });
    tok.addEventListener('dragend', () => {
      tok.classList.remove('dragging');
      state.pool.seqDragId = null;
      scheduleSavePoolState();
    });

    box.appendChild(tok);

    // Visual separator (arrow) between tokens except last
    if (idx < state.pool.sequence.length - 1) {
      const sep = document.createElement('span');
      sep.className = 'seq-sep';
      sep.textContent = '→';
      sep.setAttribute('aria-hidden', 'true');
      box.appendChild(sep);
    }
  });
  updateSeqTransportUI();
}

// ── Sequence playback (preview in right media viewer) ─────────────────────

function updateSeqTransportUI() {
  const n = state.pool.sequence.length;
  const pb = state.pool.playback;
  const playBtn = document.getElementById('btnSeqPlay');
  const pauseBtn = document.getElementById('btnSeqPause');
  const stopBtn = document.getElementById('btnSeqStop');
  const prevBtn = document.getElementById('btnSeqPrev');
  const nextBtn = document.getElementById('btnSeqNext');
  const loopBtn = document.getElementById('btnSeqLoop');
  const status = document.getElementById('seqPlayStatus');
  const moveFirst = document.getElementById('btnSeqMoveFirst');
  const moveLeft = document.getElementById('btnSeqMoveLeft');
  const moveRight = document.getElementById('btnSeqMoveRight');
  const moveLast = document.getElementById('btnSeqMoveLast');

  if (playBtn) playBtn.disabled = n === 0;
  if (prevBtn) prevBtn.disabled = n === 0;
  if (nextBtn) nextBtn.disabled = n === 0;
  if (loopBtn) {
    loopBtn.disabled = n === 0;
    loopBtn.classList.toggle('active', !!pb.loop);
  }
  if (pauseBtn) pauseBtn.disabled = !pb.playing;
  if (stopBtn) stopBtn.disabled = !pb.playing && !pb.video;

  // Reorder: need a selected clip that appears in the sequence
  const selIdx = findSelectedSeqIndex();
  const canReorder = n >= 2 && selIdx >= 0;
  if (moveFirst) moveFirst.disabled = !canReorder || selIdx === 0;
  if (moveLeft) moveLeft.disabled = !canReorder || selIdx === 0;
  if (moveRight) moveRight.disabled = !canReorder || selIdx >= n - 1;
  if (moveLast) moveLast.disabled = !canReorder || selIdx >= n - 1;

  if (status) {
    if (n === 0) {
      status.textContent = '—';
    } else if (pb.playing) {
      const name = state.pool.sequence[pb.index]?.name || '';
      status.textContent = `▶ ${pb.index + 1}/${n} ${name}`;
    } else if (pb.video && pb.video.paused) {
      status.textContent = `⏸ ${pb.index + 1}/${n}`;
    } else if (selIdx >= 0) {
      status.textContent = `sel ${selIdx + 1}/${n}`;
    } else {
      status.textContent = `${Math.min((pb.index || 0) + 1, n)}/${n}`;
    }
  }

  // Highlight playing token without full re-render when possible
  document.querySelectorAll('.seq-token').forEach(el => {
    const idx = parseInt(el.dataset.idx, 10);
    el.classList.toggle('playing', pb.playing && idx === pb.index);
  });
}

/** Index of the selected clip in the sequence (uses playback index when it matches path). */
function findSelectedSeqIndex() {
  const seq = state.pool.sequence;
  const path = state.pool.selectedPath;
  if (!path || !seq.length) return -1;
  const pi = state.pool.playback.index;
  if (Number.isInteger(pi) && pi >= 0 && pi < seq.length && seq[pi].path === path) {
    return pi;
  }
  return seq.findIndex(s => s.path === path);
}

/**
 * Move the selected sequence entry.
 * @param {-1|1|'start'|'end'} action
 */
function moveSelectedInSequence(action) {
  const seq = state.pool.sequence;
  const from = findSelectedSeqIndex();
  if (from < 0 || seq.length < 2) return;

  let to;
  if (action === 'start') to = 0;
  else if (action === 'end') to = seq.length - 1;
  else if (action === -1 || action === 1) to = from + action;
  else return;

  to = Math.max(0, Math.min(seq.length - 1, to));
  if (to === from) return;

  const [item] = seq.splice(from, 1);
  seq.splice(to, 0, item);

  // Keep selection + playback index on the moved entry
  state.pool.selectedPath = item.path;
  state.pool.focusPath = item.path;
  state.pool.playback.index = to;

  logConsole(`[SEQ]: Moved ${item.name} ${from + 1} → ${to + 1}`);
  renderSequenceBox();
  updateSelectionHighlights();
  updateSeqTransportUI();
  updateSeqClipSettings();
  scheduleSavePoolState();
}

/** Panel: per-clip time stretch when a sequence entry is selected. */
function updateSeqClipSettings() {
  const panel = document.getElementById('seqClipSettings');
  if (!panel) return;
  const idx = findSelectedSeqIndex();
  if (idx < 0) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const entry = state.pool.sequence[idx];
  const nameEl = document.getElementById('seqClipName');
  const inp = document.getElementById('seqClipDuration');
  const hint = document.getElementById('seqClipDurHint');
  if (nameEl) nameEl.textContent = `${idx + 1}. ${entry.name}`;
  if (inp) {
    inp.value = entry.targetDuration != null && entry.targetDuration > 0
      ? String(entry.targetDuration)
      : '';
  }
  const meta = findPoolItem(entry.path)?.meta;
  const native = meta?.duration;
  if (hint) {
    if (entry.targetDuration != null && entry.targetDuration > 0 && native > 0) {
      const factor = entry.targetDuration / native;
      const pct = Math.round(factor * 100);
      hint.textContent = `native ${formatDurationExact(native)} → ${formatDurationExact(entry.targetDuration)} (${pct}% speed ${factor >= 1 ? 'slower' : 'faster'})`;
    } else if (native > 0) {
      hint.textContent = `native ${formatDurationExact(native)} (no stretch)`;
    } else {
      hint.textContent = 'set target length to stretch in time';
    }
  }
}

function onSeqClipDurationChange() {
  const idx = findSelectedSeqIndex();
  if (idx < 0) return;
  const inp = document.getElementById('seqClipDuration');
  const raw = inp?.value?.trim();
  if (!raw) {
    state.pool.sequence[idx].targetDuration = null;
  } else {
    const v = parseFloat(raw);
    if (!Number.isFinite(v) || v <= 0) {
      alert('Duration must be a positive number of seconds.');
      updateSeqClipSettings();
      return;
    }
    state.pool.sequence[idx].targetDuration = v;
    logConsole(`[SEQ]: ${state.pool.sequence[idx].name} target time = ${v}s`);
  }
  updateSeqClipSettings();
  scheduleSavePoolState();
}

function _detachPlaybackVideo() {
  const v = state.pool.playback.video;
  if (v) {
    v.onended = null;
    v.onerror = null;
    v.onplay = null;
    v.onpause = null;
    try { v.pause(); } catch (_) { /* ignore */ }
  }
  state.pool.playback.video = null;
}

function seqLoadClip(index, { autoplay = true } = {}) {
  const seq = state.pool.sequence;
  if (!seq.length) return null;
  index = Math.max(0, Math.min(index, seq.length - 1));
  state.pool.playback.index = index;
  const entry = seq[index];
  if (!entry) return null;

  // Select this clip in library + sequence (sticky), then play
  state.pool.playback.index = index;
  selectPoolItem(entry.path);

  // Build player in the main media viewer
  const filePath = entry.path;
  const filename = entry.name || basename(filePath);
  elements.mediaName.textContent = filename;
  elements.mediaPath.textContent = filePath;
  elements.mediaInfo.style.display = 'flex';
  elements.mediaViewer.innerHTML = '';
  clearPreviewAspect();

  const video = document.createElement('video');
  video.src = `/api/video?path=${encodeURIComponent(filePath)}&t=${Date.now()}`;
  video.controls = true;
  video.autoplay = autoplay;
  video.muted = false;
  video.playsInline = true;
  video.style.width = '100%';
  video.style.height = '100%';
  video.style.objectFit = 'contain';
  video.addEventListener('loadedmetadata', () => {
    if (video.videoWidth && video.videoHeight) {
      setPreviewAspect(video.videoWidth, video.videoHeight);
    }
  });
  const poolItem = findPoolItem(filePath);
  if (poolItem?.meta?.width && poolItem?.meta?.height) {
    setPreviewAspect(poolItem.meta.width, poolItem.meta.height);
  }

  _detachPlaybackVideo();
  state.pool.playback.video = video;

  video.onended = () => {
    if (!state.pool.playback.playing) return;
    const next = state.pool.playback.index + 1;
    if (next < state.pool.sequence.length) {
      seqLoadClip(next, { autoplay: true });
      updateSeqTransportUI();
      renderSequenceBox();
    } else if (state.pool.playback.loop) {
      seqLoadClip(0, { autoplay: true });
      updateSeqTransportUI();
      renderSequenceBox();
    } else {
      state.pool.playback.playing = false;
      updateSeqTransportUI();
      logConsole('[SEQ PLAY]: Finished');
    }
  };

  video.onerror = () => {
    logConsole(`[SEQ PLAY]: Failed to load ${filePath}`, 'error');
    // Skip to next if playing
    if (state.pool.playback.playing) {
      const next = state.pool.playback.index + 1;
      if (next < state.pool.sequence.length) {
        seqLoadClip(next, { autoplay: true });
      } else {
        state.pool.playback.playing = false;
      }
      updateSeqTransportUI();
    }
  };

  video.onplay = () => {
    state.pool.playback.playing = true;
    updateSeqTransportUI();
  };
  video.onpause = () => {
    // Don't mark stopped on brief seeks; only if user paused
    if (video.ended) return;
    if (!video.seeking) {
      // keep playing=true only if we'll auto-advance? User pause should pause sequence
      // Check if still the active video
      if (state.pool.playback.video === video && !video.ended) {
        // leave playing flag; pause button state via video.paused
        updateSeqTransportUI();
      }
    }
  };

  elements.mediaViewer.appendChild(video);
  if (autoplay) {
    state.pool.playback.playing = true;
    video.play().catch(err => {
      logConsole(`[SEQ PLAY]: autoplay blocked — ${err.message}. Click play on the video.`);
      state.pool.playback.playing = false;
      updateSeqTransportUI();
    });
  }
  updateSeqTransportUI();
  return video;
}

function seqPlay() {
  if (state.pool.sequence.length === 0) return;
  const pb = state.pool.playback;
  // Resume paused current video if still loaded
  if (pb.video && !pb.video.ended && pb.video.paused && pb.video.src) {
    pb.playing = true;
    pb.video.play().catch(() => {});
    updateSeqTransportUI();
    return;
  }
  const startIdx = Math.min(pb.index || 0, state.pool.sequence.length - 1);
  logConsole(`[SEQ PLAY]: Starting at clip ${startIdx + 1}/${state.pool.sequence.length}`);
  seqLoadClip(startIdx, { autoplay: true });
  renderSequenceBox();
}

function seqPause() {
  const v = state.pool.playback.video;
  if (v && !v.paused) {
    v.pause();
    state.pool.playback.playing = false;
    updateSeqTransportUI();
    logConsole('[SEQ PLAY]: Paused');
  }
}

function seqStop() {
  _detachPlaybackVideo();
  state.pool.playback.playing = false;
  state.pool.playback.index = 0;
  updateSeqTransportUI();
  // Clear playing highlight
  document.querySelectorAll('.seq-token.playing').forEach(el => el.classList.remove('playing'));
  logConsole('[SEQ PLAY]: Stopped');
}

function seqPrev() {
  if (state.pool.sequence.length === 0) return;
  const idx = Math.max(0, (state.pool.playback.index || 0) - 1);
  const wasPlaying = state.pool.playback.playing;
  seqLoadClip(idx, { autoplay: wasPlaying });
  if (!wasPlaying) state.pool.playback.playing = false;
  renderSequenceBox();
}

function seqNext() {
  if (state.pool.sequence.length === 0) return;
  const idx = Math.min(state.pool.sequence.length - 1, (state.pool.playback.index || 0) + 1);
  const wasPlaying = state.pool.playback.playing;
  seqLoadClip(idx, { autoplay: wasPlaying });
  if (!wasPlaying) state.pool.playback.playing = false;
  renderSequenceBox();
}

// ── Pool persistence ──────────────────────────────────────────────────────

function scheduleSavePoolState() {
  if (!_poolPersistReady) return;
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
    sequence: state.pool.sequence.map(s => ({
      path: s.path,
      name: s.name || basename(s.path),
      target_duration: s.targetDuration != null ? s.targetDuration : null,
    })),
    selected_path: state.pool.selectedPath,
    reconcile: state.pool.reconcile || 'pad',
    aspect: state.pool.aspect || 'auto',
    aspect_custom: state.pool.aspectCustom || '',
    output_path: state.pool.outputPath || '',
    tile_zoom: state.pool.tileZoom || POOL_ZOOM.reset,
    tile_info: ensureTileInfo(),
    layout: ensurePoolLayout(),
  };
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
    const res = await fetch('/api/pool/state');
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    if (!data.ok) {
      logConsole(`[POOL]: No saved state (${data.error || 'empty'})`);
      _poolPersistReady = true;
      return;
    }

    const items = data.items || [];
    const sequence = data.sequence || [];

    state.pool.items = items.map(it => ({
      path: it.path,
      name: it.name || basename(it.path),
      hash: it.hash || null,
      size: it.size ?? null,
      meta: null,
    }));
    state.pool.sequence = sequence.map(s => ({
      id: _poolSeqId++,
      path: s.path,
      name: s.name || basename(s.path),
      targetDuration: (s.target_duration != null && s.target_duration > 0) ? s.target_duration : null,
    }));
    state.pool.selectedPath = data.selected_path || null;
    state.pool.focusPath = data.selected_path || null;
    state.pool.hoverPath = null;
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
      // Migrate old default fixed heights that left dead space under dual frames
      const sh = state.pool.layout.selectionHeight;
      if (sh === 120 || sh === 140 || sh === undefined || sh === null) {
        state.pool.layout.selectionHeight = 0;
      }
    } else {
      state.pool.layout = { ...POOL_LAYOUT_DEFAULTS, collapsed: { ...POOL_LAYOUT_DEFAULTS.collapsed } };
    }

    const missing = data.missing || [];
    if (items.length || sequence.length) {
      logConsole(
        `[POOL]: Restored ${items.length} clip(s), ${sequence.length} in sequence`
        + (missing.length ? ` (${missing.length} missing on disk skipped)` : '')
      );
    }
    if (missing.length) {
      logConsole(`[POOL]: Missing paths dropped:\n${missing.slice(0, 8).join('\n')}`);
    }

    _poolPersistReady = true;

    // Warm meta/thumbs in background (hash cache makes this fast)
    state.pool.items.forEach((item, idx) => {
      loadPoolItemMeta(item, idx);
    });
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

// ── Frame match (pHash next-clip finder) ──────────────────────────────────

async function runPoolMatch() {
  const path = state.pool.selectedPath || state.pool.focusPath;
  if (!path) {
    alert('Select a clip first (click a tile).');
    return;
  }
  // Persist pool first so server candidate list is current
  await savePoolStateNow();

  const maxDist = state.pool.matchMaxDistance ?? 10;
  const mode = state.pool.matchMode || 'next';
  const btn = document.getElementById('btnFindNext');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Matching…';
  }
  state.pool.matchLoading = true;
  elements.statusDot.className = 'status-dot loading';
  elements.statusText.textContent = 'Matching frames…';
  logConsole(`[MATCH]: ${mode} for ${basename(path)} (max distance ${maxDist})`);

  try {
    const url = `/api/pool/match?path=${encodeURIComponent(path)}&mode=${encodeURIComponent(mode)}&max_distance=${maxDist}&limit=40`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    state.pool.matchResults = data;
    renderMatchResults(data);
    if (data.ok) {
      logConsole(`[MATCH]: ${data.match_count} hit(s) of ${data.candidates_scanned} scanned`);
      elements.statusDot.className = 'status-dot';
      elements.statusText.textContent = `${data.match_count} matches`;
    } else {
      logConsole(`[MATCH]: ${data.error || 'failed'}`, 'error');
      elements.statusDot.className = 'status-dot error';
      elements.statusText.textContent = 'Match failed';
    }
  } catch (err) {
    logConsole(`[MATCH ERROR]: ${err.message}`, 'error');
    elements.statusDot.className = 'status-dot error';
    elements.statusText.textContent = 'Match failed';
    alert(`Match failed: ${err.message}`);
  } finally {
    state.pool.matchLoading = false;
    if (btn) {
      btn.disabled = !(state.pool.selectedPath || state.pool.focusPath);
      btn.textContent = 'Find matches';
    }
  }
}

function renderMatchResults(data) {
  const box = document.getElementById('poolMatchResults');
  if (!box) return;

  const badge = document.getElementById('matchCountBadge');
  const L = ensurePoolLayout();

  if (!data) {
    box.hidden = true;
    box.innerHTML = '';
    if (badge) badge.textContent = '';
    return;
  }

  box.hidden = false;
  // Uncollapse matches so results are visible
  if (L.collapsed.matches) {
    L.collapsed.matches = false;
    applyPoolLayout();
  }

  if (!data.ok) {
    box.innerHTML = `<div class="pool-match-empty">${escapeHtml(data.error || 'Match failed')}</div>`;
    if (badge) badge.textContent = 'err';
    return;
  }

  const matches = data.matches || [];
  if (badge) badge.textContent = String(matches.length);

  if (matches.length === 0) {
    box.innerHTML = `
      <div class="pool-match-empty">
        No matches within distance ≤ ${data.max_distance}.
        Try raising the slider or import more clips.
      </div>`;
    return;
  }

  // Auto-give matches a bit more room when we have hits (once)
  if (matches.length >= 3 && L.matchHeight < 200) {
    L.matchHeight = 220;
    L.composeHeight = Math.max(L.composeHeight, 320);
    applyPoolLayout();
  }

  const qPath = data.query?.path || '';
  const header = `<div class="pool-match-summary">${matches.length} match${matches.length === 1 ? '' : 'es'} · mode ${escapeHtml(data.mode)} · ≤${data.max_distance}</div>`;

  const rows = matches.map((m, i) => {
    // Query frame vs match frame thumbs
    const qWhich = m.query_frame || 'last';
    const mWhich = m.match_frame || 'first';
    const qSrc = data.query?.hash
      ? `/api/thumbnail?hash=${encodeURIComponent(data.query.hash)}&which=${qWhich}`
      : `/api/thumbnail?path=${encodeURIComponent(qPath)}&which=${qWhich}`;
    const mSrc = m.hash
      ? `/api/thumbnail?hash=${encodeURIComponent(m.hash)}&which=${mWhich}`
      : `/api/thumbnail?path=${encodeURIComponent(m.path)}&which=${mWhich}`;

    return `
      <article class="pool-match-row" data-path="${escapeHtml(m.path)}" data-idx="${i}">
        <div class="pool-match-pair">
          <div class="pool-match-thumb">
            <img src="${qSrc}" alt="query" loading="lazy" draggable="false">
            <span>${qWhich}</span>
          </div>
          <div class="pool-match-arrow">→</div>
          <div class="pool-match-thumb">
            <img src="${mSrc}" alt="match" loading="lazy" draggable="false">
            <span>${mWhich}</span>
          </div>
        </div>
        <div class="pool-match-meta">
          <div class="pool-match-name" title="${escapeHtml(m.path)}">${escapeHtml(m.name)}</div>
          <div class="pool-match-stats">
            <span class="tier tier-${escapeHtml(m.tier)}">${escapeHtml(m.tier)}</span>
            <span>d=${m.distance}</span>
            <span>${m.similarity}%</span>
            <span>${escapeHtml(m.direction)}</span>
          </div>
          <div class="pool-match-actions">
            <button type="button" class="btn pool-match-act" data-act="select">Select</button>
            <button type="button" class="btn pool-match-act" data-act="seq">+ Seq</button>
            <button type="button" class="btn pool-match-act" data-act="preview">Play</button>
          </div>
        </div>
      </article>
    `;
  }).join('');

  box.innerHTML = header + `<div class="pool-match-list">${rows}</div>`;

  box.querySelectorAll('.pool-match-row').forEach(row => {
    const path = row.dataset.path;
    row.querySelectorAll('[data-act]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const act = btn.dataset.act;
        if (act === 'select') {
          // Ensure in pool (should be)
          if (!findPoolItem(path)) addPathsToPool([path]);
          selectPoolItem(path);
          setPoolFocus(path);
        } else if (act === 'seq') {
          if (!findPoolItem(path)) addPathsToPool([path]);
          addPathToSequence(path);
        } else if (act === 'preview') {
          showPreview(path);
          setPoolFocus(path);
        }
      });
    });
    row.addEventListener('click', () => {
      setPoolFocus(path);
      showPreview(path);
    });
  });
}

// ── Tile zoom + info menu ─────────────────────────────────────────────────

function setPoolZoom(px) {
  const clamped = Math.max(POOL_ZOOM.min, Math.min(POOL_ZOOM.max, Math.round(px)));
  state.pool.tileZoom = clamped;
  applyPoolZoom();
  scheduleSavePoolState();
}

function applyPoolZoom() {
  const grid = document.getElementById('poolGrid');
  if (!grid) return;
  const z = state.pool.tileZoom || POOL_ZOOM.reset;
  grid.style.setProperty('--pool-tile-min', `${z}px`);
  grid.dataset.zoom = String(z);
  // Mark reset button
  document.querySelectorAll('.pool-zoom-btn').forEach(btn => btn.classList.remove('active'));
  if (z === POOL_ZOOM.reset) {
    document.getElementById('btnZoomReset')?.classList.add('active');
  } else if (z <= POOL_ZOOM.min) {
    document.getElementById('btnZoomMin')?.classList.add('active');
  } else if (z >= POOL_ZOOM.max) {
    document.getElementById('btnZoomMax')?.classList.add('active');
  }
}

function setupTileInfoMenu() {
  const btn = document.getElementById('btnTileInfoMenu');
  const menu = document.getElementById('tileInfoMenu');
  const checks = document.getElementById('tileInfoChecks');
  if (!btn || !menu || !checks) return;

  ensureTileInfo();
  checks.innerHTML = TILE_INFO_FIELDS.map(f => `
    <label class="pool-info-check">
      <input type="checkbox" data-tile-info="${f.key}" ${state.pool.tileInfo[f.key] ? 'checked' : ''}>
      <span>${escapeHtml(f.label)}</span>
    </label>
  `).join('');

  const closeMenu = () => {
    menu.hidden = true;
    state.pool.tileInfoMenuOpen = false;
  };
  const openMenu = () => {
    menu.hidden = false;
    state.pool.tileInfoMenuOpen = true;
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.hidden) openMenu();
    else closeMenu();
  });

  checks.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      const key = cb.dataset.tileInfo;
      state.pool.tileInfo[key] = cb.checked;
      refreshPoolTileOverlays();
      scheduleSavePoolState();
    });
  });

  document.getElementById('btnTileInfoAll')?.addEventListener('click', (e) => {
    e.stopPropagation();
    TILE_INFO_FIELDS.forEach(f => { state.pool.tileInfo[f.key] = true; });
    checks.querySelectorAll('input').forEach(cb => { cb.checked = true; });
    refreshPoolTileOverlays();
    scheduleSavePoolState();
  });
  document.getElementById('btnTileInfoNone')?.addEventListener('click', (e) => {
    e.stopPropagation();
    TILE_INFO_FIELDS.forEach(f => { state.pool.tileInfo[f.key] = false; });
    checks.querySelectorAll('input').forEach(cb => { cb.checked = false; });
    refreshPoolTileOverlays();
    scheduleSavePoolState();
  });

  // Close on outside click (once per form render — use capture on document)
  const onDoc = (e) => {
    if (!menu.hidden && !menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
      closeMenu();
    }
  };
  // Remove previous listener if re-rendered
  if (window._poolInfoMenuDocHandler) {
    document.removeEventListener('click', window._poolInfoMenuDocHandler);
  }
  window._poolInfoMenuDocHandler = onDoc;
  document.addEventListener('click', onDoc);

  menu.addEventListener('click', (e) => e.stopPropagation());
}

function refreshPoolTileOverlays() {
  // Rebuild overlays + frame labels without full grid re-fetch
  const info = ensureTileInfo();
  state.pool.items.forEach((item, idx) => {
    const card = Array.from(document.querySelectorAll('.pool-card')).find(c => c.dataset.path === item.path);
    if (!card) return;

    // Frame labels
    card.querySelectorAll('.pool-frame').forEach((frameEl, fi) => {
      let label = frameEl.querySelector('.pool-frame-label');
      if (info.frame_labels) {
        if (!label) {
          label = document.createElement('span');
          label.className = 'pool-frame-label';
          label.textContent = fi === 0 ? 'FIRST' : 'LAST';
          frameEl.appendChild(label);
        }
      } else if (label) {
        label.remove();
      }
    });

    const metaHtml = item.meta || item.metaError
      ? buildPoolMetaHtml(item)
      : (item.metaError ? buildPoolMetaHtml(item) : null);

    let overlay = card.querySelector('.pool-overlay');
    let metaEl = document.getElementById(`poolMeta-${idx}`);

    if (!item.meta && !item.metaError) {
      // still loading — leave probing text
      return;
    }

    if (!metaHtml || !metaHtml.trim()) {
      if (overlay) overlay.remove();
      // keep hidden anchor for future updates
      if (!metaEl) {
        metaEl = document.createElement('div');
        metaEl.id = `poolMeta-${idx}`;
        metaEl.style.display = 'none';
        card.appendChild(metaEl);
      } else {
        metaEl.style.display = 'none';
        metaEl.innerHTML = '';
      }
      return;
    }

    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'pool-overlay';
      overlay.innerHTML = `<div class="pool-overlay-text" id="poolMeta-${idx}"></div>`;
      card.appendChild(overlay);
      metaEl = overlay.querySelector('.pool-overlay-text');
    }
    if (metaEl) {
      metaEl.style.display = '';
      metaEl.innerHTML = metaHtml;
    }
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function loadPoolItemMeta(item, idx) {
  try {
    // ensure_thumbs=true: first open hashes + extracts frames; later is a cache hit
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

  // Update only the meta overlay if still on pool tab (resolve index by path in case list shifted)
  if (state.activeTab !== 'pool') return;
  const liveIdx = state.pool.items.findIndex(i => i.path === item.path);
  if (liveIdx < 0) return;
  const el = document.getElementById(`poolMeta-${liveIdx}`);
  if (el) el.innerHTML = buildPoolMetaHtml(item);

  // Point thumbs at hash-keyed URLs once we know the hash (browser cache still fine)
  if (item.hash) {
    const card = Array.from(document.querySelectorAll('.pool-card')).find(c => c.dataset.path === item.path);
    if (card) {
      card.dataset.hash = item.hash;
      card.querySelectorAll('img.pool-thumb').forEach(img => {
        const which = img.dataset.which || 'first';
        const next = poolThumbUrl(item, which);
        // Only swap if still path-based; avoid reload flicker when already hash URL
        if (img.getAttribute('src') && img.getAttribute('src').includes('path=')) {
          img.src = next;
        }
      });
    }
  }

  // Refresh sequence token durations / focus frame if this path is involved
  if (state.pool.sequence.some(s => s.path === item.path)) {
    renderSequenceBox();
  }
  if (displayFocusPath() === item.path) {
    updatePoolFocusFrame(item.path);
  }
  // Persist hash once known
  if (item.hash) scheduleSavePoolState();
}

function selectPoolItem(path) {
  if (!path) return;
  state.pool.selectedPath = path;
  state.pool.hoverPath = null; // sticky wins; clear temporary hover
  state.pool.focusPath = path;

  // Don't clobber sequence player with silent preview if mid-play
  if (!state.pool.playback.playing) {
    showPreview(path);
  }
  updatePoolFocusFrame(path);
  updateSelectionHighlights(); // library cards + sequence tokens share selection
  updateSeqTransportUI(); // enable/disable << < > >>
  updateSeqClipSettings();
  scheduleSavePoolState();

  // Scroll selected pool card / sequence token into view if present
  const card = Array.from(document.querySelectorAll('.pool-card')).find(c => c.dataset.path === path);
  if (card?.scrollIntoView) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  const tok = Array.from(document.querySelectorAll('.seq-token')).find(t => t.dataset.path === path);
  if (tok?.scrollIntoView) tok.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });

  // Enable find-matches when something is selected
  const findBtn = document.getElementById('btnFindNext');
  if (findBtn && !state.pool.matchLoading) findBtn.disabled = false;

  // Refresh toolbar only (Use as input controls)
  const toolbarMeta = document.querySelector('.pool-toolbar-meta');
  if (toolbarMeta) {
    toolbarMeta.innerHTML = `
      <span class="pool-count">${state.pool.items.length} in pool · ${state.pool.sequence.length} in sequence</span>
      <div class="pool-use-wrap">
        <label for="poolUseTarget" class="pool-use-label">Use as input</label>
        <select id="poolUseTarget" class="pool-use-select">
          <option value="">— target —</option>
          <option value="sequence">Add to sequence</option>
          <option value="mosh">Datamosh input</option>
          <option value="transmute">Transmute input</option>
          <option value="multi">Add to Multi clips</option>
          <option value="advanced">Advanced input</option>
        </select>
        <button class="btn btn-primary" id="btnPoolUse" type="button">Apply</button>
      </div>
    `;
    document.getElementById('btnPoolUse')?.addEventListener('click', applyPoolAsInput);
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
}

function addPathsToPool(paths) {
  let added = 0;
  let skipped = 0;
  const existingPaths = new Set(state.pool.items.map(i => i.path));

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
    added++;
  }

  logConsole(`[POOL]: +${added} video(s)${skipped ? `, skipped ${skipped}` : ''}`);
  if (added > 0) scheduleSavePoolState();
  return added;
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
    addPathsToPool(paths);
    if (state.activeTab === 'pool') renderPoolForm();
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
    const scanRes = await fetch(`/api/pool/scan?path=${encodeURIComponent(dir)}&recursive=false`);
    if (!scanRes.ok) throw new Error(await scanRes.text());
    const scan = await scanRes.json();
    if (!scan.ok) throw new Error(scan.error || 'scan failed');
    const paths = (scan.videos || []).map(v => v.path);
    if (paths.length === 0) {
      logConsole(`[POOL]: No videos found in ${dir}`);
      alert('No video files found in that folder.');
      return;
    }
    // Preserve sizes from scan when available
    const sizeMap = new Map((scan.videos || []).map(v => [v.path, v.size]));
    const before = state.pool.items.length;
    addPathsToPool(paths);
    state.pool.items.forEach(item => {
      if (item.size == null && sizeMap.has(item.path)) {
        item.size = sizeMap.get(item.path);
      }
    });
    logConsole(`[POOL]: Folder import from ${dir} (${state.pool.items.length - before} new)`);
    if (state.activeTab === 'pool') renderPoolForm();
  } catch (err) {
    logConsole(`[POOL ERROR]: ${err.message}`, 'error');
    alert(`Folder import failed: ${err.message}`);
  } finally {
    await checkHealth();
  }
}

function WORKSPACE_HINT() {
  // Prefer last selected pool item's dir, else first item, else empty (server default)
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

/** Send a pool clip path into a tool tab / sequence / preview / frame export. */
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

  // Form fields re-created on tab switch — set after switch
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
  } else {
    logConsole(`[POOL]: Unknown send target: ${target}`, 'error');
  }
}

/**
 * Save first or last frame as full-res PNG.
 * Opens native Save As dialog; falls back to auto path next to the video.
 */
async function savePoolFramePng(videoPath, which) {
  which = which === 'last' ? 'last' : 'first';
  const stem = basename(videoPath).replace(/\.[^.]+$/, '');
  const dir = videoPath.substring(0, videoPath.lastIndexOf('/')) || '';
  const suggested = `${dir}/${stem}_${which}.png`;

  elements.statusDot.className = 'status-dot loading';
  elements.statusText.textContent = `Saving ${which} frame…`;

  let outputPath = null;
  try {
    // Native save dialog
    const pickUrl = `/api/picker?mode=save&start_path=${encodeURIComponent(suggested)}`;
    const pickRes = await fetch(pickUrl);
    if (pickRes.ok) {
      const pick = await pickRes.json();
      if (pick.path) {
        outputPath = pick.path;
        if (!outputPath.toLowerCase().endsWith('.png')) {
          outputPath = outputPath.replace(/\.[^.]+$/, '') + '.png';
        }
      } else {
        // User cancelled picker — abort (don't write silently)
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

    logConsole(`[EXPORT]: ${which} frame → ${data.output_path} (${formatBytes(data.size || 0)})`);
    elements.statusDot.className = 'status-dot';
    elements.statusText.textContent = 'Frame saved';
    // Preview the PNG
    showPreview(data.output_path);
  } catch (err) {
    logConsole(`[EXPORT ERROR]: ${err.message}`, 'error');
    elements.statusDot.className = 'status-dot error';
    elements.statusText.textContent = 'Export failed';
    alert(`Could not save ${which} frame: ${err.message}`);
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

// Close any open Send-to menus on outside click
document.addEventListener('click', (e) => {
  if (e.target.closest('.pool-send-wrap')) return;
  document.querySelectorAll('.pool-send-menu:not([hidden])').forEach(m => { m.hidden = true; });
  document.querySelectorAll('.pool-card.menu-open').forEach(c => c.classList.remove('menu-open'));
});

// File Browser Logic
window.openFileBrowser = async function(targetInputId, selectDirOnly = false, mode = 'file') {
  let pickerMode = 'file';
  if (selectDirOnly) pickerMode = 'dir';
  else if (mode === 'file_save') pickerMode = 'save';
  else if (mode === 'dir') pickerMode = 'dir';
  
  let startPath = '';
  if (targetInputId !== 'addMultiClip') {
    const currentVal = document.getElementById(targetInputId)?.value;
    if (currentVal && currentVal.startsWith('/')) {
      startPath = currentVal.substring(0, currentVal.lastIndexOf('/'));
    }
  }

  elements.statusDot.className = 'status-dot loading';
  elements.statusText.textContent = 'Waiting for file picker...';
  
  try {
    const url = `/api/picker?mode=${pickerMode}&start_path=${encodeURIComponent(startPath)}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(await response.text());
    
    const data = await response.json();
    if (data.path) {
      if (targetInputId === 'addMultiClip') {
        addMultiClipPath(data.path);
      } else {
        const input = document.getElementById(targetInputId);
        if (input) {
          input.value = data.path;
          input.dispatchEvent(new Event('input'));
        }
      }
      logConsole(`[PICKED]: ${data.path}`);
    } else {
      logConsole(`[PICKER]: Cancelled by user`);
    }
  } catch (err) {
    logConsole(`[PICKER ERROR]: ${err.message}`);
    alert(`Could not open system file picker. Make sure kdialog is running or enter path manually.`);
  } finally {
    await checkHealth();
  }
};

function closeFbModal() {
  elements.fbModal.classList.remove('active');
}

async function browsePath(path = '') {
  try {
    const response = await fetch(`/api/browse?path=${encodeURIComponent(path)}`);
    if (!response.ok) throw new Error(await response.text());
    
    const data = await response.json();
    state.fb.currentPath = data.current_path;
    elements.fbPathInput.value = data.current_path;
    
    // Render Shortcuts
    elements.fbShortcuts.innerHTML = '';
    data.shortcuts.forEach(shortcut => {
      const btn = document.createElement('button');
      btn.className = 'fb-shortcut-btn';
      btn.textContent = shortcut.name;
      btn.addEventListener('click', () => browsePath(shortcut.path));
      elements.fbShortcuts.appendChild(btn);
    });

    // Render List
    elements.fbList.innerHTML = '';
    
    // Parent Directory ".."
    if (data.parent_path) {
      const parentItem = document.createElement('li');
      parentItem.className = 'fb-item fb-up-btn';
      parentItem.innerHTML = `
        <span class="fb-item-icon">📁</span>
        <span class="fb-item-name">.. (Go Up)</span>
      `;
      parentItem.addEventListener('click', () => browsePath(data.parent_path));
      elements.fbList.appendChild(parentItem);
    }

    if (data.entries.length === 0) {
      elements.fbList.innerHTML += `<li class="fb-empty">Folder is empty</li>`;
      return;
    }

    data.entries.forEach(entry => {
      // If selectDirOnly is true, we still list files but make them unselectable
      const isDir = entry.is_dir;
      const isSelected = state.fb.selectedPath === entry.path;
      
      const li = document.createElement('li');
      li.className = `fb-item ${isSelected ? 'selected' : ''}`;
      
      let icon = isDir ? '📁' : '📄';
      if (!isDir) {
        const ext = entry.name.substring(entry.name.lastIndexOf('.')).toLowerCase();
        if (['.mp4', '.m4v', '.mov', '.avi', '.mkv'].includes(ext)) icon = '🎬';
        else if (['.png', '.jpg', '.jpeg', '.gif'].includes(ext)) icon = '🖼️';
        else if (['.m4a', '.mp3', '.wav'].includes(ext)) icon = '🎵';
      }

      const sizeText = entry.size !== null ? formatBytes(entry.size) : '';

      li.innerHTML = `
        <span class="fb-item-icon ${isDir ? 'dir' : 'file'}">${icon}</span>
        <span class="fb-item-name">${entry.name}</span>
        <span class="fb-item-size">${sizeText}</span>
      `;
      
      // Double click navigates into directory
      li.addEventListener('dblclick', () => {
        if (isDir) {
          browsePath(entry.path);
        }
      });
      
      // Single click selects
      li.addEventListener('click', () => {
        // Toggle selected state
        document.querySelectorAll('.fb-item').forEach(el => el.classList.remove('selected'));
        
        if (state.fb.selectDirOnly && !isDir) {
          // Can't select file in directory-only mode
          state.fb.selectedPath = '';
          state.fb.selectedName = '';
          state.fb.selectedIsDir = false;
          return;
        }

        li.classList.add('selected');
        state.fb.selectedPath = entry.path;
        state.fb.selectedName = entry.name;
        state.fb.selectedIsDir = isDir;
      });

      elements.fbList.appendChild(li);
    });

  } catch (err) {
    logConsole(`[BROWSE ERROR]: ${err.message}`);
  }
}

function navigateUpFb() {
  // Simple extraction of parent path
  const current = state.fb.currentPath;
  if (!current) return;
  const lastIndex = current.lastIndexOf('/');
  if (lastIndex > 0) {
    const parent = current.substring(0, lastIndex);
    browsePath(parent);
  } else if (lastIndex === 0) {
    browsePath('/');
  }
}

function confirmFbSelection() {
  let finalPath = '';
  
  if (state.fb.resolveMode === 'file_save') {
    // If it's a save file dialog and nothing is clicked, we check the path input box or select current path
    // But let's assume they want the currentPath plus the filename if they typed one.
    // For simplicity: if they select a file, use it. If they select a folder, ask for a filename or use folder path.
    // Better QOL: prompt for a name if they select a directory
    if (state.fb.selectedPath && !state.fb.selectedIsDir) {
      finalPath = state.fb.selectedPath;
    } else {
      const filename = prompt("Enter output filename (e.g. output.mp4):", "output.mp4");
      if (!filename) return; // cancel
      finalPath = state.fb.currentPath + '/' + filename;
    }
  } else {
    // Standard pick
    if (!state.fb.selectedPath) {
      // Fallback: choose current directory if they wanted a dir, or error
      if (state.fb.selectDirOnly) {
        finalPath = state.fb.currentPath;
      } else {
        alert("Please select a file.");
        return;
      }
    } else {
      finalPath = state.fb.selectedPath;
    }
  }
  
  // Populate the target input
  if (state.fb.targetInputId === 'addMultiClip') {
    addMultiClipPath(finalPath);
  } else {
    const input = document.getElementById(state.fb.targetInputId);
    if (input) {
      input.value = finalPath;
      // Trigger change event if needed
      input.dispatchEvent(new Event('input'));
    }
  }
  
  closeFbModal();
}

// Format utils
function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// Running Operations
async function runActiveOperation() {
  const tab = state.activeTab;
  let opId = '';
  let body = {};
  
  if (tab === 'mosh') {
    const input = document.getElementById('moshInput')?.value;
    const output = document.getElementById('moshOutput')?.value;
    
    if (!input || !output) {
      alert("Please provide both Input and Output paths.");
      return;
    }
    
    const mode = state.selectedMoshMode;
    if (mode === 'melt') {
      opId = 'datamosh_melt';
      body = {
        input_path: input,
        output_path: output,
        tail: parseInt(document.getElementById('moshTail').value),
        hdamp: parseInt(document.getElementById('moshDamp').value),
        vdrift: parseInt(document.getElementById('moshDrift').value)
      };
    } else if (mode === 'classic') {
      opId = 'datamosh_classic';
      body = {
        input_path: input,
        output_path: output
      };
    } else if (mode === 'hijack') {
      opId = 'datamosh_hijack';
      const injectMode = document.getElementById('hijackSourceSelect').value;
      body = {
        input_path: input,
        output_path: output,
        inject_mode: injectMode,
        inject_image_path: injectMode === 'file' ? document.getElementById('hijackImagePath').value : null,
        inject_frame_num: injectMode === 'frame' ? parseInt(document.getElementById('hijackSourceFrame').value) : 0,
        start_frame: parseInt(document.getElementById('hijackStartFrame').value),
        end_frame: parseInt(document.getElementById('hijackEndFrame').value),
        transition_style: document.getElementById('hijackTransitionStyle').value
      };
    } else if (mode === 'destruct') {
      opId = 'datamosh_destruct';
      body = {
        input_path: input,
        output_path: output,
        start_frame: parseInt(document.getElementById('destructStart').value),
        end_frame: parseInt(document.getElementById('destructEnd').value)
      };
    } else if (mode === 'mv_hack') {
      opId = 'datamosh_mv_hack';
      body = {
        input_path: input,
        output_path: output,
        start_frame: parseInt(document.getElementById('mvStart').value),
        end_frame: parseInt(document.getElementById('mvEnd').value),
        multiplier: parseFloat(document.getElementById('mvMultiplier').value) / 100.0,
        drift_h: parseInt(document.getElementById('mvDriftH').value),
        drift_v: parseInt(document.getElementById('mvDriftV').value)
      };
    }
  } else if (tab === 'transmute') {
    const input = document.getElementById('transmuteInput')?.value;
    const output = document.getElementById('transmuteOutput')?.value || null;
    const dryRun = document.getElementById('transmuteDryRun')?.checked || false;
    
    if (!input) {
      alert("Please provide an Input path.");
      return;
    }
    
    opId = activeTransmuteOp;
    body = {
      input_path: input,
      output_path: output,
      dry_run: dryRun
    };

    // Add extra params if needed
    const fields = transmuteOpsDetails[activeTransmuteOp].fields;
    if (fields.includes('quality')) {
      body.quality = parseInt(document.getElementById('transmuteQuality').value);
    }
    if (fields.includes('seconds_from_end')) {
      body.seconds_from_end = parseFloat(document.getElementById('transmuteSecondsFromEnd').value);
    }
    if (fields.includes('width')) {
      body.width = parseInt(document.getElementById('transmuteWidth').value);
      body.height = parseInt(document.getElementById('transmuteHeight').value);
    }
  } else if (tab === 'multi') {
    const mode = activeMultiMode; // 'join' or 'grid'
    const reconcile = document.getElementById('multiReconcile')?.value || 'pad';
    const output = document.getElementById('multiOutput')?.value || null;
    const dryRun = document.getElementById('multiDryRun')?.checked || false;
    
    if (state.multiClips.length < (mode === 'grid' ? 4 : 2)) {
      alert(mode === 'grid' ? "Grid mode requires exactly 4 clips." : "Stitch mode requires 2 or more clips.");
      return;
    }
    if (mode === 'grid' && state.multiClips.length !== 4) {
      alert("Grid mode requires exactly 4 clips (currently you have " + state.multiClips.length + ").");
      return;
    }

    opId = mode;
    body = {
      input_paths: state.multiClips,
      mode: reconcile,
      output_path: output,
      dry_run: dryRun
    };
  } else if (tab === 'advanced') {
    const input = document.getElementById('advInput')?.value;
    const flagsStr = document.getElementById('advFlags')?.value || '';
    const output = document.getElementById('advOutput')?.value || null;
    const dryRun = document.getElementById('advDryRun')?.checked || false;

    if (!input) {
      alert("Please provide an Input path.");
      return;
    }

    opId = 'transmute_raw';
    // split flags by whitespace, filter empty
    const flags = flagsStr.split(/\s+/).filter(f => f.length > 0);
    body = {
      input_arg: input,
      flags: flags,
      output_path: output,
      dry_run: dryRun
    };
  }

  // Execute Request
  elements.statusDot.className = 'status-dot loading';
  elements.statusText.textContent = 'Processing...';
  elements.btnRun.disabled = true;
  elements.btnRun.innerHTML = `<span style="animation: pulse-dot 1s infinite;">●</span> Processing...`;
  
  logConsole(`[EXECUTE]: POST /ops/${opId}\nParameters: ${JSON.stringify(body, null, 2)}`);

  try {
    const response = await fetch(`/ops/${opId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    displayOpResult(data);
  } catch (err) {
    elements.statusDot.className = 'status-dot error';
    elements.statusText.textContent = 'Failed';
    logConsole(`[EXECUTION FAILED]: ${err.message}`);
  } finally {
    elements.btnRun.disabled = false;
    elements.btnRun.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polygon points="5 3 19 12 5 21 5 3"/>
      </svg>
      Run Operation
    `;
  }
}

// Display Operation Results
function displayOpResult(res) {
  logConsole(`[RESULT]: ok=${res.ok}`);
  if (res.command) {
    logConsole(`[COMMAND EXECUTED]:\n${res.command}`, 'command');
  }
  if (res.stdout) {
    logConsole(`[STDOUT]:\n${res.stdout}`, 'stdout');
  }
  if (res.stderr) {
    logConsole(`[STDERR]:\n${res.stderr}`, 'stderr');
  }

  if (!res.ok) {
    elements.statusDot.className = 'status-dot error';
    elements.statusText.textContent = 'Failed';
    logConsole(`[ERROR]: ${res.error || 'Operation failed'}`, 'error');
    alert(`Operation failed: ${res.error || 'Check console details'}`);
    return;
  }

  elements.statusDot.className = 'status-dot';
  elements.statusText.textContent = 'Success';

  // Preview the output if not a dry run and output path exists
  if (!res.dry_run && res.output_path) {
    showPreview(res.output_path);
  } else if (res.dry_run) {
    logConsole(`[DRY RUN]: Complete. No files written.`);
    elements.mediaViewer.innerHTML = `
      <div class="media-placeholder">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
        </svg>
        <p>Dry Run Successful. Command generated in Console.</p>
      </div>
    `;
    elements.mediaInfo.style.display = 'none';
  }
}

// ── Preview AR + console split ────────────────────────────────────────────

function gcdInt(a, b) {
  a = Math.abs(Math.round(a));
  b = Math.abs(Math.round(b));
  while (b) { const t = b; b = a % b; a = t; }
  return a || 1;
}

/** Set preview box to source aspect ratio; never crops (object-fit: contain). */
function setPreviewAspect(w, h) {
  const viewer = elements.mediaViewer;
  if (!viewer || !w || !h || w <= 0 || h <= 0) return;
  viewer.dataset.arW = String(w);
  viewer.dataset.arH = String(h);
  viewer.classList.add('has-media');
  const badge = document.getElementById('mediaArBadge');
  if (badge) {
    const g = gcdInt(w, h);
    badge.textContent = `${w}×${h} · ${Math.round(w / g)}:${Math.round(h / g)}`;
  }
  fitPreviewViewer();
}

function clearPreviewAspect() {
  const viewer = elements.mediaViewer;
  if (!viewer) return;
  viewer.classList.remove('has-media');
  delete viewer.dataset.arW;
  delete viewer.dataset.arH;
  viewer.style.width = '';
  viewer.style.height = '';
  const badge = document.getElementById('mediaArBadge');
  if (badge) badge.textContent = '';
}

/** Fit viewer inside stage using source AR — letterbox only if stage differs. */
function fitPreviewViewer() {
  const stage = document.getElementById('mediaViewerStage');
  const viewer = elements.mediaViewer;
  if (!stage || !viewer) return;

  const sw = stage.clientWidth;
  const sh = stage.clientHeight;
  if (sw < 8 || sh < 8) return;

  let arW = parseFloat(viewer.dataset.arW);
  let arH = parseFloat(viewer.dataset.arH);
  if (!arW || !arH) {
    // Empty / unknown: soft square placeholder up to stage
    const side = Math.min(sw, sh);
    viewer.style.width = `${side}px`;
    viewer.style.height = `${side}px`;
    return;
  }

  // Largest rect of aspect arW:arH that fits in stage
  let vw = sw;
  let vh = sw * (arH / arW);
  if (vh > sh) {
    vh = sh;
    vw = sh * (arW / arH);
  }
  viewer.style.width = `${Math.max(1, Math.floor(vw))}px`;
  viewer.style.height = `${Math.max(1, Math.floor(vh))}px`;
}

function setupPreviewConsoleResize() {
  const handle = document.getElementById('previewConsoleResize');
  const panel = document.getElementById('previewPanel');
  const consoleBox = document.getElementById('consoleBox');
  if (!handle || !panel || !consoleBox) return;

  // Restore saved console height
  try {
    const saved = parseInt(localStorage.getItem('mtapi_console_h') || '', 10);
    if (saved >= 72 && saved <= 800) {
      panel.style.setProperty('--console-h', `${saved}px`);
    }
  } catch (_) { /* ignore */ }

  bindPoolDragResize(handle, {
    axis: 'y',
    onMove: (dy, start) => {
      // stage | handle | console at bottom — drag handle UP (dy<0) grows terminal
      const height = Math.max(72, Math.min(panel.clientHeight * 0.72, start.consoleH - dy));
      panel.style.setProperty('--console-h', `${Math.round(height)}px`);
      fitPreviewViewer();
    },
    startVals: () => {
      const cs = getComputedStyle(panel).getPropertyValue('--console-h').trim();
      const px = parseInt(cs, 10);
      return { consoleH: Number.isFinite(px) ? px : consoleBox.offsetHeight || 180 };
    },
  });

  // After resize ends, persist — bindPoolDragResize already calls scheduleSavePoolState which is pool-only.
  // Hook pointerup on handle for localStorage
  handle.addEventListener('pointerup', () => {
    try {
      const cs = getComputedStyle(panel).getPropertyValue('--console-h').trim();
      const px = parseInt(cs, 10);
      if (px >= 72) localStorage.setItem('mtapi_console_h', String(px));
    } catch (_) { /* ignore */ }
    fitPreviewViewer();
  });

  // Refit on window resize
  window.addEventListener('resize', () => fitPreviewViewer());
  // Observe stage size changes
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => fitPreviewViewer());
    const stage = document.getElementById('mediaViewerStage');
    if (stage) ro.observe(stage);
  }
}

// Preview media file
function showPreview(filePath) {
  const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
  const filename = filePath.substring(filePath.lastIndexOf('/') + 1);
  
  elements.mediaName.textContent = filename;
  elements.mediaPath.textContent = filePath;
  elements.mediaInfo.style.display = 'flex';
  
  elements.mediaViewer.innerHTML = '';
  clearPreviewAspect();
  
  if (['.mp4', '.m4v', '.mov', '.avi', '.mkv', '.webm'].includes(ext)) {
    const video = document.createElement('video');
    video.src = `/api/video?path=${encodeURIComponent(filePath)}&t=${Date.now()}`;
    video.controls = true;
    video.autoplay = true;
    video.loop = true;
    video.muted = true;
    video.addEventListener('loadedmetadata', () => {
      if (video.videoWidth && video.videoHeight) {
        setPreviewAspect(video.videoWidth, video.videoHeight);
      }
    });
    elements.mediaViewer.appendChild(video);
    // Also try probe meta if already in pool (instant AR before metadata)
    const item = findPoolItem(filePath);
    if (item?.meta?.width && item?.meta?.height) {
      setPreviewAspect(item.meta.width, item.meta.height);
    }
  } else if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) {
    const img = document.createElement('img');
    img.src = `/api/image?path=${encodeURIComponent(filePath)}&t=${Date.now()}`;
    img.onload = () => {
      if (img.naturalWidth && img.naturalHeight) {
        setPreviewAspect(img.naturalWidth, img.naturalHeight);
      }
    };
    elements.mediaViewer.appendChild(img);
  } else if (['.m4a', '.mp3', '.wav'].includes(ext)) {
    elements.mediaViewer.innerHTML = `
      <div class="media-placeholder">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 18V5l12-2v13"/>
          <circle cx="6" cy="18" r="3"/>
          <circle cx="18" cy="16" r="3"/>
        </svg>
        <p>Audio Extracted successfully!</p>
        <audio controls src="/api/video?path=${encodeURIComponent(filePath)}" style="margin-top: 12px; width: 80%;"></audio>
      </div>
    `;
    setPreviewAspect(16, 9);
  } else {
    elements.mediaViewer.innerHTML = `
      <div class="media-placeholder">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
        </svg>
        <p>File generated: <strong>${filename}</strong></p>
        <p style="font-size: 0.75rem;">Path: ${filePath}</p>
      </div>
    `;
    setPreviewAspect(16, 9);
  }
}

// Console logger
function logConsole(text, type = 'normal') {
  const line = document.createElement('div');
  
  if (type === 'command') {
    line.className = 'console-cmd';
    line.textContent = `$ ${text}`;
  } else if (type === 'stdout') {
    line.className = 'console-stdout';
    line.textContent = text;
  } else if (type === 'stderr') {
    line.className = 'console-stderr';
    line.textContent = text;
  } else if (type === 'error') {
    line.className = 'console-error';
    line.textContent = text;
  } else {
    line.textContent = text;
  }
  
  elements.consoleBody.appendChild(line);
  elements.consoleBody.scrollTop = elements.consoleBody.scrollHeight;
}

// Flush pool state before leaving
window.addEventListener('beforeunload', () => {
  if (!_poolPersistReady) return;
  // best-effort sync beacon
  try {
    const blob = new Blob([JSON.stringify(buildPoolStatePayload())], { type: 'application/json' });
    navigator.sendBeacon?.('/api/pool/state', blob);
  } catch (_) { /* ignore */ }
});

// Run on page load
window.addEventListener('DOMContentLoaded', init);
