import { elements, state, logConsole, bestInput } from '/app.js';
import { setupContinuousKnob, setupBinaryKnob, knobUnitHtml } from '/js/ui/knobs.js';

function renderUpscaleForm() {
  var html = `
    <div class="panel-title-desc dense">
      <h3>Upscale · NCNN Vulkan</h3>
      <p class="dream-hint">
        AI upscale with <strong>Real-ESRGAN</strong> (clean digital) or
        <strong>SRMD</strong> (noise-aware film). Re-grain post-pass available.
        Images: direct CLI. Video: dump &rarr; upscale &rarr; encode.
      </p>
    </div>

    <div class="form-row">
      <label for="upInput">Input</label>
      <div class="input-group">
        <input type="text" id="upInput" placeholder="/absolute/path/to/image.png or video.mp4">
        <button type="button" class="btn" id="btnUpBrowse">Browse</button>
      </div>
      <p class="form-row-hint">Uses global Video/Image bar if this is blank</p>
    </div>

    <div class="form-row">
      <label for="upOutput">Output</label>
      <div class="input-group">
        <input type="text" id="upOutput" placeholder="blank = auto next to source">
        <button type="button" class="btn" id="btnUpSaveAs">Save As</button>
      </div>
    </div>

    <div class="form-row">
      <label for="upEngine">Engine</label>
      <select id="upEngine">
        <option value="realesrgan" selected>Real-ESRGAN — clean digital upscale</option>
        <option value="srmd">SRMD — noise-aware film/dvd upscale</option>
      </select>
    </div>

    <div class="form-row">
      <label for="upModel">Model <span class="hint-span">(Real-ESRGAN only)</span></label>
      <select id="upModel">
        <option value="" selected>realesr-animevideov3 (default)</option>
        <option value="realesrgan-x4plus">realesrgan-x4plus — photo restoration</option>
        <option value="realesrgan-x4plus-anime">realesrgan-x4plus-anime</option>
        <option value="realesrnet-x4plus">realesrnet-x4plus</option>
      </select>
    </div>

    <div class="form-row">
      <label for="upSRMDNoise">SRMD noise <span class="hint-span">(SRMD only)</span></label>
      <div class="knob-row" id="knobUpNoise">
        <span class="knob-unit">${knobUnitHtml('upNoiseVal', '-1', -1, 10, 1)}</span>
        <span class="knob-hint">-1 = preserve grain, 10 = heavy denoise</span>
      </div>
    </div>

    <div class="form-row">
      <label for="upGrain">Re-grain <span class="hint-span">(post-pass)</span></label>
      <div class="knob-row" id="knobUpGrain">
        <span class="knob-unit">${knobUnitHtml('upGrainVal', '0', 0, 24, 1)}</span>
        <span class="knob-hint">0 = off, ~12 = analog film grain</span>
      </div>
    </div>

    <div class="form-row">
      <div class="form-row knobs" style="grid-template-columns:repeat(3,1fr)">
        <div class="knob-wrap">
          <label for="knobUpScale">Scale</label>
          <div class="knob-unit" id="knobUpScale">2</div>
        </div>
        <div class="knob-wrap">
          <label for="knobUpTile">Tile size</label>
          <div class="knob-unit" id="knobUpTile">256</div>
        </div>
        <div class="knob-wrap">
          <label for="knobUpTTA">TTA</label>
          <div class="knob-unit binary-knob" id="knobUpTTA">Off</div>
        </div>
      </div>
      <p style="margin:2px 0 0 0;font-size:11px;color:var(--text-muted)">
        <strong>Scale</strong> — output multiplier.
        <strong>Tile</strong> — 0=auto, 256 safe for 16GB.
        <strong>TTA</strong> — cleaner but 2x slower.
      </p>
    </div>

    <div class="form-row">
      <label>
        <input type="checkbox" id="upDryRun"> Dry run
      </label>
    </div>

    <section class="tool-docs" aria-label="About upscale">
      <h4 class="tool-docs-title">About · Upscale</h4>
      <p class="tool-docs-lede">
        Runs <code>realesrgan-ncnn-vulkan</code> or <code>realsr-ncnn-vulkan</code>
        (Real-ESRGAN) / <code>srmd-ncnn-vulkan</code> (SRMD) on dumped PNG frames
        or single images. NCNN Vulkan on GPU.
        Needs binary on PATH or in <code>mtapi-project/bin/</code>.
        Re-grain adds FFmpeg <code>noise</code> temporal-gaussian grain.
      </p>
    </section>
  `;
  elements.actionPanel.innerHTML = html;

  setupContinuousKnob('knobUpScale', 2, 4, 1, 4, function(v) {
    document.getElementById('knobUpScale').querySelector('.knob-val').textContent = v;
  });
  setupContinuousKnob('knobUpTile', 0, 1024, 32, 256, function(v) {
    document.getElementById('knobUpTile').querySelector('.knob-val').textContent = v;
  });
  setupBinaryKnob('knobUpTTA', 'Off', 'On', false, function() {});
  setupContinuousKnob('upNoiseVal', -1, 10, 1, 3, function(v) {
    document.getElementById('upNoiseVal').querySelector('.knob-val').textContent = v;
  });
  setupContinuousKnob('upGrainVal', 0, 24, 1, 0, function(v) {
    document.getElementById('upGrainVal').querySelector('.knob-val').textContent = v;
  });

  // Hide SRMD noise when engine is realesrgan
  document.getElementById('upEngine')?.addEventListener('change', function(e) {
    var isSrmd = e.target.value === 'srmd';
    var noiseRow = document.getElementById('knobUpNoise')?.closest('.form-row');
    if (noiseRow) noiseRow.style.display = isSrmd ? '' : 'none';
    var modelRow = document.getElementById('upModel')?.closest('.form-row');
    if (modelRow) modelRow.style.display = isSrmd ? 'none' : '';
  });
  // Initial visibility
  var noiseRow = document.getElementById('knobUpNoise')?.closest('.form-row');
  if (noiseRow) noiseRow.style.display = 'none';
}

function collectUpscaleBody() {
  var input = document.getElementById('upInput')?.value.trim() || bestInput('upInput');
  if (!input) {
    alert('Please provide an Input path.');
    return null;
  }
  var engine = document.getElementById('upEngine')?.value || 'realesrgan';
  var model = document.getElementById('upModel')?.value || '';
  var dry = document.getElementById('upDryRun')?.checked || false;

  var scaleEl = document.getElementById('knobUpScale')?.querySelector('.knob-val');
  var scale = scaleEl ? parseInt(scaleEl.textContent, 10) || 4 : 4;

  var tileEl = document.getElementById('knobUpTile')?.querySelector('.knob-val');
  var tile = tileEl ? parseInt(tileEl.textContent, 10) || 256 : 256;

  var ttaEl = document.getElementById('knobUpTTA')?.querySelector('.knob-val');
  var tta = ttaEl ? ttaEl.textContent === 'On' : false;

  var noiseEl = document.getElementById('upNoiseVal')?.querySelector('.knob-val');
  var noise = noiseEl ? parseInt(noiseEl.textContent, 10) : 3;

  var grainEl = document.getElementById('upGrainVal')?.querySelector('.knob-val');
  var grain = grainEl ? parseInt(grainEl.textContent, 10) || 0 : 0;

  return {
    input_path: input,
    output_path: output || null,
    engine: engine,
    scale: scale,
    tile_size: tile,
    model_name: model,
    srmd_noise: noise,
    tta: tta,
    grain_strength: grain,
    dry_run: dry,
  };
}

export { renderUpscaleForm, collectUpscaleBody };
