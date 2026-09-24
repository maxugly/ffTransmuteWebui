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
      <select id="upEngine" data-help-title="Engine — upscaler" data-help-text="Real-ESRGAN = clean digital upscale for anime/photo; SRMD = noise-aware film/DVD upscale (uses the Denoise knob). Default Real-ESRGAN.">
        <option value="realesrgan" selected>Real-ESRGAN — clean digital upscale</option>
        <option value="srmd">SRMD — noise-aware film/dvd upscale</option>
      </select>
    </div>

    <div class="form-row">
      <label for="upModel">Model <span class="hint-span">(Real-ESRGAN only)</span></label>
      <select id="upModel" data-help-title="Model — Real-ESRGAN model" data-help-text="realesr-animevideov3 (default, clean animation/video), realesrgan-x4plus (photo restoration), realesrgan-x4plus-anime, realesrnet-x4plus (lighter). Ignored under SRMD.">
        <option value="" selected>realesr-animevideov3 (default)</option>
        <option value="realesrgan-x4plus">realesrgan-x4plus — photo restoration</option>
        <option value="realesrgan-x4plus-anime">realesrgan-x4plus-anime</option>
        <option value="realesrnet-x4plus">realesrnet-x4plus</option>
      </select>
    </div>

    <div class="form-row">
      <label for="upNoiseVal">SRMD noise <span class="hint-span">(SRMD only)</span></label>
      ${knobUnitHtml({ id: 'upNoiseVal', label: 'Denoise', value: '-1', helpTitle: 'SRMD noise — denoise amount [-1–10]', helpText: 'Pre-upscale denoise strength. -1 = preserve grain, 0 = neutral, 10 = heavy denoise (can smear detail). Sane: -1–3; default -1.' })}
    </div>

    <div class="form-row">
      <label for="upGrainVal">Re-grain <span class="hint-span">(post-pass)</span></label>
      ${knobUnitHtml({ id: 'upGrainVal', label: 'Grain', value: '0', helpTitle: 'Re-grain — grain strength [0–24]', helpText: 'Post-upscale FFmpeg temporal-gaussian grain to fake film texture. 0 = off, ~12 = analog film grain. Sane: 0–16; default 0.' })}
    </div>

    <div class="form-row knobs">
      ${knobUnitHtml({ id: 'upScale', label: 'Scale', value: '4', helpTitle: 'Scale — output multiplier [2–4]', helpText: 'Upscales both dimensions by this factor (4 = 1024px wide becomes 4096). Higher = sharper but heavier + slower. Sane: 2–4; default 4.' })}
      ${knobUnitHtml({ id: 'upTile', label: 'Tile size', value: '256', helpTitle: 'Tile size — VRAM tile in px [0–1024]', helpText: 'Processes the image in tiles to fit VRAM; 0 = auto. 256 is safe for 16 GB — lower it on OOM. Sane: 128–512; default 256.' })}
      ${knobUnitHtml({ id: 'upTTA', label: 'TTA', value: '0', binary: true, leftCap: 'Off', rightCap: 'On', helpTitle: 'TTA — Off / On', helpText: 'Test-time augmentation: runs mirrored/rotated passes and averages — cleaner but ~2× slower. Off by default.' })}
    </div>

    <div class="form-row">
      <label>
        <input type="checkbox" id="upDryRun" data-help-title="Dry run — Run / Dry" data-help-text="Validates params and prints the command without writing output files."> Dry run
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

  setupContinuousKnob({
    knobId: 'upScaleKnob', indicatorId: 'upScaleKnobInd', valueId: 'upScaleVal', hiddenId: 'upScale',
    min: 2, max: 4, step: 1, decimals: 0,
  });
  setupContinuousKnob({
    knobId: 'upTileKnob', indicatorId: 'upTileKnobInd', valueId: 'upTileVal', hiddenId: 'upTile',
    min: 0, max: 1024, step: 32, decimals: 0,
  });
  setupBinaryKnob({
    knobId: 'upTTAKnob', indicatorId: 'upTTAKnobInd', hiddenId: 'upTTA',
    leftValue: '0', rightValue: '1', initial: '0',
  });
  setupContinuousKnob({
    knobId: 'upNoiseValKnob', indicatorId: 'upNoiseValKnobInd', valueId: 'upNoiseValVal', hiddenId: 'upNoiseVal',
    min: -1, max: 10, step: 1, decimals: 0,
  });
  setupContinuousKnob({
    knobId: 'upGrainValKnob', indicatorId: 'upGrainValKnobInd', valueId: 'upGrainValVal', hiddenId: 'upGrainVal',
    min: 0, max: 24, step: 1, decimals: 0,
  });

  // Hide SRMD noise when engine is realesrgan
  document.getElementById('upEngine')?.addEventListener('change', function(e) {
    var isSrmd = e.target.value === 'srmd';
    var noiseRow = document.getElementById('upNoiseVal')?.closest('.form-row');
    if (noiseRow) noiseRow.style.display = isSrmd ? '' : 'none';
    var modelRow = document.getElementById('upModel')?.closest('.form-row');
    if (modelRow) modelRow.style.display = isSrmd ? 'none' : '';
  });
  // Initial visibility
  var noiseRow = document.getElementById('upNoiseVal')?.closest('.form-row');
  if (noiseRow) noiseRow.style.display = 'none';
}

function collectUpscaleBody() {
  var input = document.getElementById('upInput')?.value.trim() || bestInput('upInput');
  if (!input) {
    alert('Please provide an Input path.');
    return null;
  }
  var output = document.getElementById('upOutput')?.value.trim() || '';
  var engine = document.getElementById('upEngine')?.value || 'realesrgan';
  var model = document.getElementById('upModel')?.value || '';
  var dry = document.getElementById('upDryRun')?.checked || false;

  var scale = parseInt(document.getElementById('upScale')?.value, 10);
  if (isNaN(scale)) scale = 4;
  var tile = parseInt(document.getElementById('upTile')?.value, 10);
  if (isNaN(tile)) tile = 256;
  var tta = String(document.getElementById('upTTA')?.value || '0') === '1';
  var noise = parseInt(document.getElementById('upNoiseVal')?.value, 10);
  if (isNaN(noise)) noise = -1;
  var grain = parseInt(document.getElementById('upGrainVal')?.value, 10);
  if (isNaN(grain)) grain = 0;

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
