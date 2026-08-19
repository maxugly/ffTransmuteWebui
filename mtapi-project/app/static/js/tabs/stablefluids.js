import { state, elements, resolveGlobalImages } from '/app.js';
import { createStableFluidsSim } from '/js/stablefluids_webgpu.js';

let mediaRecorder = null;
let stopNativeSim = null;       // () => void from the WebGPU module
let stageToken = 0;             // guards async stage builds (rapid mode toggles)
let canvasRef = null;           // canvas currently being captured (native or iframe)
let teardownHookInstalled = false;

// ── helpers ───────────────────────────────────────────────────────────────

function currentMode() {
  const r = document.querySelector('input[name="sfMode"]:checked');
  return r ? r.value : (state.stableFluids.mode || 'webgpu');
}

function setSeedEnabled(enabled) {
  const inp = document.getElementById('sfSeedImage');
  const btn = document.getElementById('btnSfSeedBrowse');
  const hint = document.getElementById('sfSeedHint');
  if (inp) inp.disabled = !enabled;
  if (btn) btn.disabled = !enabled;
  if (hint) hint.textContent = enabled ? '' : 'Requires WebGPU native mode';
}

/** Seed image (Phase 3): dedicated field → first Image Pool still → none. */
function seedImagePath() {
  const el = document.getElementById('sfSeedImage');
  const explicit = el ? el.value.trim() : '';
  if (explicit) return explicit;
  const g = typeof resolveGlobalImages === 'function' ? resolveGlobalImages() : [];
  if (g[0]) return g[0];
  return '';
}

function seedImageUrl() {
  const p = seedImagePath();
  return p ? `/api/image?path=${encodeURIComponent(p)}` : '';
}

// ── build probe (iframe mode) ─────────────────────────────────────────────

function checkStableFluidsBuild() {
  return fetch('/stablefluids/index.html', { method: 'HEAD' })
    .then(r => r.ok)
    .catch(() => false);
}

function waitForCanvas(iframe, onFound) {
  const poll = () => {
    try {
      const doc = iframe.contentDocument;
      if (!doc) { setTimeout(poll, 250); return; }
      const canvas = doc.querySelector('canvas');
      if (canvas) { onFound(canvas); return; }
    } catch (_) {
      onFound(null);
      return;
    }
    setTimeout(poll, 250);
  };
  poll();
}

// ── recording (shared: native canvas or iframe canvas) ────────────────────

function startRecording(canvas) {
  if (!canvas) return;
  const stream = canvas.captureStream(60);
  const mimeCandidates = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  let options = { mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond: 25_000_000 };
  for (const mime of mimeCandidates) {
    if (MediaRecorder.isTypeSupported(mime)) {
      options = { mimeType: mime, videoBitsPerSecond: 25_000_000 };
      break;
    }
  }
  const chunks = [];
  mediaRecorder = new MediaRecorder(stream, options);
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  mediaRecorder.onstop = () => {
    const blob = new Blob(chunks, { type: options.mimeType || 'video/webm' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `fluid_${Date.now()}.webm`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setRecording(false);
  };
  mediaRecorder.start();
  setRecording(true);
}

function setRecording(on) {
  state.stableFluids.recording = on;
  const btn = document.getElementById('btnSfRecord');
  if (!btn) return;
  btn.textContent = on ? 'Stop' : 'Record';
  btn.disabled = on ? false : !state.stableFluids.buildPresent;
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
}

function teardown() {
  try { if (typeof stopNativeSim === 'function') stopNativeSim(); } catch (_) { /* ignore */ }
  stopNativeSim = null;
  canvasRef = null;
  try { if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop(); } catch (_) { /* ignore */ }
  mediaRecorder = null;
}

// ── stage renderers ───────────────────────────────────────────────────────

function renderIframeStage() {
  const stage = document.getElementById('sfStage');
  if (!stage) return;
  state.stableFluids.buildPresent = true;
  stage.innerHTML = `
    <iframe id="sfIframe" src="/stablefluids/" style="width:100%; height:70vh; border:none; background:#000;"></iframe>
  `;
  setRecording(false);
}

function renderIframePlaceholder() {
  const stage = document.getElementById('sfStage');
  if (!stage) return;
  state.stableFluids.buildPresent = false;
  stage.innerHTML = `
    <div class="sf-placeholder" style="border:1px dashed #555; padding:24px; border-radius:8px; background:#1a1a1a;">
      <p><strong>Stable Fluids build not found.</strong></p>
      <p>Self-host keijiro's WebGL sim (live at <code>www.keijiro.tokyo/StableFluids/</code>):</p>
      <pre style="background:#111; padding:12px; border-radius:4px; overflow-x:auto;">wget --mirror --convert-links http://www.keijiro.tokyo/StableFluids/
cd StableFluids/Build
for f in StableFluids.data.unityweb StableFluids.framework.js.unityweb StableFluids.wasm.unityweb; do
  wget "http://www.keijiro.tokyo/StableFluids/Build/$f"
done
wget https://cdn.simplecss.org/simple.min.css -O ../simple.min.css
# copy StableFluids/ into app/static/stablefluids/</pre>
      <p>Then reload this tab.</p>
    </div>`;
}

function renderWebGpuPlaceholder(message) {
  const stage = document.getElementById('sfStage');
  if (!stage) return;
  state.stableFluids.buildPresent = false;
  stage.innerHTML = `
    <div class="sf-placeholder" style="border:1px dashed #555; padding:24px; border-radius:8px; background:#1a1a1a;">
      <p><strong>WebGPU native mode unavailable.</strong></p>
      <p style="white-space:pre-wrap;">${message}</p>
      <button type="button" class="btn btn-primary" id="btnSfSwitchIframe">Use WebGL (iframe) instead</button>
    </div>`;
  const switchBtn = document.getElementById('btnSfSwitchIframe');
  if (switchBtn) {
    switchBtn.addEventListener('click', () => {
      const r = document.getElementById('sfModeIframe');
      if (r) r.checked = true;
      document.querySelectorAll('input[name="sfMode"]').forEach(rr => {
        if (rr.value === 'iframe') rr.checked = true;
        else rr.checked = false;
      });
      state.stableFluids.mode = 'iframe';
      setSeedEnabled(false);
      renderStage('iframe');
    });
  }
}

function initWebGpuStage() {
  const stage = document.getElementById('sfStage');
  if (!stage) return;
  teardown(); // stop a previous native sim (seed change / restore re-entry)
  if (!navigator.gpu) {
    renderWebGpuPlaceholder('This browser has no WebGPU (`navigator.gpu` undefined).\nUse Chrome/Edge 113+ (or Chromium with the WebGPU flag), then reload.');
    return;
  }
  stage.innerHTML = `
    <canvas id="sfCanvas" style="width:100%; max-width:560px; aspect-ratio:1; background:#000; border:1px solid #444; touch-action:none;"></canvas>
    <div id="sfNativeStatus" style="margin-top:8px; font-size:.85em; color:#aaa; min-height:1.2em;"></div>`;
  state.stableFluids.buildPresent = true;
  const token = ++stageToken;
  const canvas = document.getElementById('sfCanvas');
  canvasRef = canvas;
  const status = document.getElementById('sfNativeStatus');
  const onError = (m) => {
    if (status) status.textContent = m;
  };
  const seedUrl = seedImageUrl();
  createStableFluidsSim({ canvas, seedUrl, onError }).then((res) => {
    if (token !== stageToken) {
      // stage was replaced while awaiting init — discard
      if (res && res.ok && typeof res.stop === 'function') { try { res.stop(); } catch (_) { /* ignore */ } }
      return;
    }
    if (!res.ok) {
      renderWebGpuPlaceholder('WebGPU init failed: ' + String(res.error));
      return;
    }
    stopNativeSim = res.stop;
    if (!state.stableFluids.recording) setRecording(false);
  });
}

function renderStage(mode) {
  const stage = document.getElementById('sfStage');
  if (!stage) return;
  teardown();
  stageToken++;
  if (mode === 'iframe') {
    setSeedEnabled(false);
    state.stableFluids.mode = 'iframe';
    checkStableFluidsBuild().then(present => {
      if (present) renderIframeStage();
      else renderIframePlaceholder();
      setRecording(false);
    });
  } else {
    setSeedEnabled(true);
    state.stableFluids.mode = 'webgpu';
    initWebGpuStage();
  }
}

// ── main renderer ─────────────────────────────────────────────────────────

function renderStableFluidsForm() {
  if (!teardownHookInstalled) {
    teardownHookInstalled = true;
    window.__sfTeardown = teardown;
  }

  elements.actionPanel.innerHTML = `
    <div class="panel-title-desc">
      <h3>Stable Fluids · Sim</h3>
      <p class="dream-hint">Client-side GPU fluid sim · Unity WebGL iframe or native WebGPU · record canvas to WebM</p>
    </div>

    <div class="form-group">
      <button type="button" class="btn btn-primary" id="btnSfRecord">Record</button>
    </div>

    <div class="form-group">
      <label>Render mode</label>
      <label style="display:flex; gap:6px; align-items:center; margin:2px 0;">
        <input type="radio" name="sfMode" id="sfModeWebgpu" value="webgpu"
               ${state.stableFluids.mode !== 'iframe' ? 'checked' : ''}>
        WebGPU (native)
      </label>
      <label style="display:flex; gap:6px; align-items:center; margin:2px 0;">
        <input type="radio" name="sfMode" id="sfModeIframe" value="iframe"
               ${state.stableFluids.mode === 'iframe' ? 'checked' : ''}>
        WebGL (iframe)
      </label>
    </div>

    <div class="form-group" id="sfSeedRow">
      <label for="sfSeedImage">Seed image (initial dye field) — Phase 3 WebGPU only</label>
      <div class="input-row">
        <input type="text" id="sfSeedImage" class="form-input" placeholder="Absolute path to an image, or blank to use first Image Pool still"
               value="${state.stableFluids.seedPath || ''}">
        <button type="button" class="btn" id="btnSfSeedBrowse">Browse…</button>
        <span id="sfSeedHint" style="font-size:.85em; color:#c88;"></span>
      </div>
    </div>

    <div id="sfStage"></div>

    <section class="tool-docs" aria-label="About Stable Fluids">
      <h4 class="tool-docs-title">About · Stable Fluids</h4>
      <p class="tool-docs-lede">Jos Stam's "Stable Fluids" ported from keijiro — self-hosted, fully client-side.</p>
      <h5 class="tool-docs-h">Render modes</h5>
      <p><strong>WebGPU (native):</strong> a pure WebGPU compute port (~three passes: advection, pressure, projection). Supports seed-image injection: drag a still into the sim as its starting dye field. 512² sim, 512² output.</p>
      <p><strong>WebGL (iframe):</strong> embeds the self-hosted Unity WebGL build from <code>/stablefluids/</code>. No image injection (the stock build ignores messages).</p>
      <h5 class="tool-docs-h">Recording</h5>
      <p>Click <strong>Record</strong> to capture the canvas at 60 fps as VP9 WebM. The file downloads automatically when you stop.</p>
      <p>Drag with the mouse (or hold during drag) in the canvas to stir fluid and add colored dye.</p>
    </section>
  `;

  // mode radios
  document.querySelectorAll('input[name="sfMode"]').forEach(r => {
    r.addEventListener('change', () => {
      state.stableFluids.mode = currentMode();
      renderStage(state.stableFluids.mode);
    });
  });

  // seed browse → shared file browser (image files only)
  const browseBtn = document.getElementById('btnSfSeedBrowse');
  if (browseBtn) {
    browseBtn.addEventListener('click', () => {
      if (typeof window.openFileBrowser === 'function') {
        window.openFileBrowser('sfSeedImage', false, 'files', 'image');
      }
    });
  }
  // seed change → apply persisted value to state + restart native sim with it
  const seedInput = document.getElementById('sfSeedImage');
  let seedLastSeen = seedInput ? seedInput.value.trim() : '';
  let seedTimer = 0;
  if (seedInput) {
    seedInput.addEventListener('change', () => {
      const val = seedInput.value.trim();
      state.stableFluids.seedPath = val;
      if (val === seedLastSeen) return; // redundant restore/echo change
      seedLastSeen = val;
      if (currentMode() !== 'webgpu') return;
      clearTimeout(seedTimer);
      seedTimer = setTimeout(() => initWebGpuStage(), 150);
    });
  }

  // record
  const btn = document.getElementById('btnSfRecord');
  btn.disabled = true;
  btn.addEventListener('click', () => {
    if (state.stableFluids.recording) {
      stopRecording();
      return;
    }
    if (currentMode() === 'webgpu') {
      const canvas = document.getElementById('sfCanvas');
      if (!canvas) return;
      startRecording(canvas);
      return;
    }
    const iframe = document.getElementById('sfIframe');
    if (!iframe) return;
    waitForCanvas(iframe, (canvas) => {
      if (canvas) {
        startRecording(canvas);
      }
    });
  });

  // initial stage
  renderStage(currentMode());
}

export { renderStableFluidsForm };