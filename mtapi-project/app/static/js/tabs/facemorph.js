import { state, elements, logConsole, resolveGlobalImages } from '/app.js';
import { basename, escapeHtml } from '/js/utils.js';
import { setupContinuousKnob, setupBinaryKnob, knobUnitHtml } from '/js/ui/knobs.js';

// ── Face Morph tab (facemorph package + optional DeepDream) ───────────────

function renderFaceMorphForm() {
  const imgs = state.faceMorph.images || [];
  const listHtml = imgs.length
    ? imgs.map((it, i) => `
        <div class="fm-item" data-idx="${i}">
          <span class="fm-ord">${String(i + 1).padStart(2, '0')}</span>
          <span class="fm-name" title="${escapeHtml(it.path)}">${escapeHtml(it.name || basename(it.path))}</span>
          <button type="button" class="btn fm-up" data-idx="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button type="button" class="btn fm-down" data-idx="${i}" ${i >= imgs.length - 1 ? 'disabled' : ''}>↓</button>
          <button type="button" class="btn fm-rm" data-idx="${i}">✕</button>
        </div>`).join('')
    : `<div class="fm-empty">Add at least 2 face images (folder or multi-select). Order = morph sequence.</div>`;

  const html = `
    <div class="panel-title-desc dense">
      <h3>Face Morph</h3>
      <p class="dream-hint">dlib 68-pt + Delaunay A→B→C… Optional DeepDream on faces or morph video.</p>
    </div>

    <div class="form-group" style="margin-bottom:6px">
      <div class="form-row" style="margin-bottom:3px">
        <label>Faces (${imgs.length})</label>
        <div class="sort-toolbar" style="margin:0; flex:1">
          <button type="button" class="btn btn-primary" id="btnFmAddFiles">+ Images</button>
          <button type="button" class="btn" id="btnFmAddFolder">+ Folder</button>
          <button type="button" class="btn" id="btnFmClear" ${imgs.length ? '' : 'disabled'}>Clear</button>
        </div>
        <p class="form-row-hint">↑↓ reorder · needs detectable face · folder = alpha order</p>
      </div>
      <div class="fm-list" id="fmList">${listHtml}</div>
    </div>

    <div class="form-row">
      <label for="fmOutput">Output</label>
      <div class="input-row">
        <input type="text" id="fmOutput" placeholder="blank = auto next to first image">
        <button type="button" class="btn" id="btnFmOutBrowse">Save As</button>
      </div>
    </div>

    <div class="knob-row">
      <div class="knob-bank">
        ${knobUnitHtml({ id: 'fmDuration', label: 'Sec/pair', value: '2.0' })}
        ${knobUnitHtml({ id: 'fmFps', label: 'FPS', value: '30' })}
        ${knobUnitHtml({ id: 'fmCrf', label: 'CRF', value: '18' })}
        ${knobUnitHtml({ id: 'fmKeepFrames', label: 'Keep PNG', value: '0', binary: true, leftCap: 'No', rightCap: 'Yes' })}
        ${knobUnitHtml({ id: 'fmTriangles', label: 'Triangles', value: '0', binary: true, leftCap: 'Off', rightCap: 'On' })}
        ${knobUnitHtml({ id: 'fmDryRun', label: 'Dry run', value: '0', binary: true, leftCap: 'Run', rightCap: 'Dry' })}
      </div>
      <p class="knob-row-legend">
        Sec/pair × pairs ≈ length. CRF 0 = lossless · 18 ≈ near-lossless.
      </p>
    </div>

    <div class="knob-row">
      <div class="knob-bank">
        ${knobUnitHtml({ id: 'fmAlign', label: 'Align faces', value: '0', binary: true, leftCap: 'Off', rightCap: 'On' })}
        ${knobUnitHtml({ id: 'fmAlignSize', label: 'Size', value: '1024' })}
      </div>
      <p class="knob-row-legend">
        FFHQ-style: center nose, level eyes, square crop. Size = output px (256–4096).
      </p>
    </div>

    <div class="form-row">
      <label for="fmDreamMode">Dream</label>
      <select id="fmDreamMode">
        <option value="none" selected>Morph only</option>
        <option value="after">Morph → DeepDream video</option>
        <option value="faces_first">DeepDream faces → morph</option>
      </select>
      <p class="form-row-hint"><strong>after</strong> = optical-flow on morph · <strong>faces_first</strong> = dream stills then morph</p>
    </div>
    <div class="fm-dream-opts" id="fmDreamOpts">
      <div class="form-row">
        <label for="fmDreamModel">Model</label>
        <select id="fmDreamModel">
          <option value="inception_v3" selected>InceptionV3</option>
          <option value="vgg16">VGG16</option>
          <option value="resnet50">ResNet50</option>
        </select>
        <label for="fmDreamPreset">Layers</label>
        <select id="fmDreamPreset">
          <option value="shallow">Shallow</option>
          <option value="mid">Mid</option>
          <option value="classic" selected>Classic</option>
          <option value="deep">Deep</option>
          <option value="full">Full</option>
        </select>
      </div>
      <div class="knob-row">
        <div class="knob-bank">
          ${knobUnitHtml({ id: 'fmDreamIters', label: 'Iterations', value: '10' })}
          ${knobUnitHtml({ id: 'fmDreamOctaves', label: 'Octaves', value: '2' })}
          ${knobUnitHtml({ id: 'fmDreamStep', label: 'Step', value: '0.015' })}
          ${knobUnitHtml({ id: 'fmDreamPreview', label: 'Preview W', value: '640' })}
          ${knobUnitHtml({ id: 'fmDreamFlow', label: 'Opt. flow', value: '1', binary: true, leftCap: 'Off', rightCap: 'On' })}
        </div>
        <p class="knob-row-legend">Preview W ≤ 800 for speed. Optical flow only for dream mode “after”.</p>
      </div>
    </div>
  `;
  elements.actionPanel.innerHTML = html;

  setupContinuousKnob({
    knobId: 'fmDurationKnob', indicatorId: 'fmDurationKnobInd', valueId: 'fmDurationVal', hiddenId: 'fmDuration',
    min: 0.5, max: 8, step: 0.1, decimals: 1,
  });
  setupContinuousKnob({
    knobId: 'fmFpsKnob', indicatorId: 'fmFpsKnobInd', valueId: 'fmFpsVal', hiddenId: 'fmFps',
    min: 12, max: 60, step: 1, decimals: 0,
  });
  setupContinuousKnob({
    knobId: 'fmCrfKnob', indicatorId: 'fmCrfKnobInd', valueId: 'fmCrfVal', hiddenId: 'fmCrf',
    min: 0, max: 28, step: 1, decimals: 0,
  });
  setupBinaryKnob({
    knobId: 'fmKeepFramesKnob', indicatorId: 'fmKeepFramesKnobInd', hiddenId: 'fmKeepFrames',
    leftValue: '0', rightValue: '1', initial: '0',
  });
  setupBinaryKnob({
    knobId: 'fmDryRunKnob', indicatorId: 'fmDryRunKnobInd', hiddenId: 'fmDryRun',
    leftValue: '0', rightValue: '1', initial: '0',
  });
  setupBinaryKnob({
    knobId: 'fmTrianglesKnob', indicatorId: 'fmTrianglesKnobInd', hiddenId: 'fmTriangles',
    leftValue: '0', rightValue: '1', initial: '0',
  });
  setupBinaryKnob({
    knobId: 'fmAlignKnob', indicatorId: 'fmAlignKnobInd', hiddenId: 'fmAlign',
    leftValue: '0', rightValue: '1', initial: '0',
  });
  setupContinuousKnob({
    knobId: 'fmAlignSizeKnob', indicatorId: 'fmAlignSizeKnobInd', valueId: 'fmAlignSizeVal', hiddenId: 'fmAlignSize',
    min: 256, max: 4096, step: 32, decimals: 0,
  });
  setupContinuousKnob({
    knobId: 'fmDreamItersKnob', indicatorId: 'fmDreamItersKnobInd', valueId: 'fmDreamItersVal', hiddenId: 'fmDreamIters',
    min: 1, max: 40, step: 1, decimals: 0,
  });
  setupContinuousKnob({
    knobId: 'fmDreamOctavesKnob', indicatorId: 'fmDreamOctavesKnobInd', valueId: 'fmDreamOctavesVal', hiddenId: 'fmDreamOctaves',
    min: 1, max: 5, step: 1, decimals: 0,
  });
  setupContinuousKnob({
    knobId: 'fmDreamStepKnob', indicatorId: 'fmDreamStepKnobInd', valueId: 'fmDreamStepVal', hiddenId: 'fmDreamStep',
    min: 0.005, max: 0.08, step: 0.005, decimals: 3,
  });
  setupContinuousKnob({
    knobId: 'fmDreamPreviewKnob', indicatorId: 'fmDreamPreviewKnobInd', valueId: 'fmDreamPreviewVal', hiddenId: 'fmDreamPreview',
    min: 0, max: 1280, step: 20, decimals: 0,
    format: (v) => (v <= 0 ? 'full' : String(Math.round(v))),
  });
  setupBinaryKnob({
    knobId: 'fmDreamFlowKnob', indicatorId: 'fmDreamFlowKnobInd', hiddenId: 'fmDreamFlow',
    leftValue: '0', rightValue: '1', initial: '1',
  });

  const syncDreamOpts = () => {
    const mode = document.getElementById('fmDreamMode')?.value || 'none';
    document.getElementById('fmDreamOpts')?.classList.toggle('hidden', mode === 'none');
  };
  document.getElementById('fmDreamMode')?.addEventListener('change', syncDreamOpts);
  syncDreamOpts();

  document.getElementById('btnFmAddFiles')?.addEventListener('click', async () => {
    try {
      const res = await fetch(`/api/picker?mode=files&filter=image&start_path=`);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      const paths = data.paths || (data.path ? [data.path] : []);
      paths.forEach((p) => {
        if (!p) return;
        if (state.faceMorph.images.some((x) => x.path === p)) return;
        state.faceMorph.images.push({ path: p, name: basename(p) });
      });
      renderFaceMorphForm();
    } catch (err) {
      alert(`Picker failed: ${err.message}`);
    }
  });
  document.getElementById('btnFmAddFolder')?.addEventListener('click', async () => {
    try {
      const res = await fetch(`/api/picker?mode=dir&start_path=`);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      if (!data.path) return;
      // list dir via a lightweight API — use media path listing through shell of images by asking backend morph preview?
      // For now: store as folder and expand on run via image_dir
      const listRes = await fetch(`/api/images/list?path=${encodeURIComponent(data.path)}`);
      if (listRes.ok) {
        const listed = await listRes.json();
        (listed.files || []).forEach((p) => {
          if (state.faceMorph.images.some((x) => x.path === p)) return;
          state.faceMorph.images.push({ path: p, name: basename(p) });
        });
        logConsole(`[FACEMORPH]: Folder ${data.path} — ${(listed.files || []).length} image(s)`);
      } else {
        // fallback: just remember folder path as single "virtual" entry via image_dir on collect
        state.faceMorph.folder = data.path;
        logConsole(`[FACEMORPH]: Folder ${data.path} — will expand at run if list API missing`);
      }
      renderFaceMorphForm();
    } catch (err) {
      alert(`Folder pick failed: ${err.message}`);
    }
  });
  document.getElementById('btnFmClear')?.addEventListener('click', () => {
    state.faceMorph.images = [];
    state.faceMorph.folder = null;
    renderFaceMorphForm();
  });
  document.getElementById('btnFmOutBrowse')?.addEventListener('click', () => {
    openFileBrowser('fmOutput', false, 'file_save', 'all');
  });

  document.querySelectorAll('.fm-rm').forEach((btn) => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.dataset.idx, 10);
      state.faceMorph.images.splice(i, 1);
      renderFaceMorphForm();
    });
  });
  document.querySelectorAll('.fm-up').forEach((btn) => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.dataset.idx, 10);
      if (i <= 0) return;
      const a = state.faceMorph.images;
      [a[i - 1], a[i]] = [a[i], a[i - 1]];
      renderFaceMorphForm();
    });
  });
  document.querySelectorAll('.fm-down').forEach((btn) => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.dataset.idx, 10);
      const a = state.faceMorph.images;
      if (i >= a.length - 1) return;
      [a[i], a[i + 1]] = [a[i + 1], a[i]];
      renderFaceMorphForm();
    });
  });
}

function collectFaceMorphBody() {
  var images = (state.faceMorph.images || []).map((x) => x.path);
  if (images.length < 2 && !state.faceMorph.folder) {
    var fallbacks = resolveGlobalImages();
    if (fallbacks.length >= 2) {
      images = fallbacks;
    } else {
      alert('Add at least 2 face images (or a folder with 2+ faces).');
      return null;
    }
  }
  const dream_mode = document.getElementById('fmDreamMode')?.value || 'none';
  const body = {
    image_paths: images.length >= 2 ? images : null,
    image_dir: images.length < 2 ? (state.faceMorph.folder || null) : null,
    output_path: document.getElementById('fmOutput')?.value?.trim() || null,
    duration: parseFloat(document.getElementById('fmDuration')?.value || '2'),
    fps: parseInt(document.getElementById('fmFps')?.value || '30', 10),
    crf: parseInt(document.getElementById('fmCrf')?.value || '18', 10),
    keep_frames: document.getElementById('fmKeepFrames')?.value === '1',
    show_triangles: document.getElementById('fmTriangles')?.value === '1',
    align_faces: document.getElementById('fmAlign')?.value === '1',
    align_size: parseInt(document.getElementById('fmAlignSize')?.value || '1024', 10),
    dream_mode,
    dream_model_name: document.getElementById('fmDreamModel')?.value || 'inception_v3',
    dream_layer_preset: document.getElementById('fmDreamPreset')?.value || 'classic',
    dream_iterations: parseInt(document.getElementById('fmDreamIters')?.value || '10', 10),
    dream_octaves: parseInt(document.getElementById('fmDreamOctaves')?.value || '2', 10),
    dream_step: parseFloat(document.getElementById('fmDreamStep')?.value || '0.015'),
    dream_preview_width: parseInt(document.getElementById('fmDreamPreview')?.value || '640', 10),
    dream_optical_flow: document.getElementById('fmDreamFlow')?.value === '1',
    dream_temporal_blend: 0.85,
    dry_run: document.getElementById('fmDryRun')?.value === '1',
  };
  return body;
}

export { renderFaceMorphForm, collectFaceMorphBody };
