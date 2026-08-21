import { elements } from '/app.js';
import { setupContinuousKnob, setupBinaryKnob, knobUnitHtml } from '/js/ui/knobs.js';

function renderQrArtForm() {
  const html = `
    <div class="panel-title-desc dense">
      <h3>QR Art · OpenVINO Img2Img + IP-Adapter</h3>
      <p class="dream-hint">
        Generates a scannable QR code from your text, then diffuses it with
        Stable Diffusion 1.5 img2img via OpenVINO. Optionally enable IP-Adapter
        to blend a reference image's style into the QR art using ControlNet QR Monster
        (structure) + IP-Adapter (appearance). Falls back to CPU on iGPU OOM.
        Writes PNG under <code>/tmp/mtapi_gen</code> if output is blank.
      </p>
    </div>

    <div class="form-row">
      <label>Mode</label>
      <div style="display: flex; gap: 12px; margin-top: 4px;">
        <label class="btn" id="qrModeQrLabel" style="flex: 1; cursor: pointer; text-align: center; justify-content: center; border-color: var(--primary); background: rgba(59, 130, 246, 0.08); color: white;">
          <input type="radio" name="qrMode" value="qr" checked style="display:none;">
          QR
        </label>
        <label class="btn" id="qrModeIllusionLabel" style="flex: 1; cursor: pointer; text-align: center; justify-content: center; border-color: var(--panel-border); background: transparent; color: var(--text-muted);">
          <input type="radio" name="qrMode" value="illusion" style="display:none;">
          Illusion
        </label>
      </div>
      <p class="form-row-hint" id="qrModeHint">Pattern = structure (mono works best). Appearance = the photo woven through it.</p>
    </div>

    <div id="qrPromptLib" class="prompt-library-bar" aria-label="Prompt library"></div>
    <div class="form-row" id="qrTextRow">
      <label for="qrText">QR Data</label>
      <input type="text" id="qrText" placeholder="https://example.com or any text" style="flex:1 1 16rem">
    </div>
    <div class="form-row" id="qrPatternRow" style="display:none">
      <label for="qrPatternImage">Pattern</label>
      <div class="input-row">
        <input type="text" id="qrPatternImage" placeholder="/path/to/pattern.png" style="flex:1 1 16rem">
        <button class="btn" type="button" id="btnQrBrowsePattern">Browse</button>
      </div>
    </div>
    <div class="form-row" id="qrAppearanceRow" style="display:none">
      <label for="qrAppearanceImage">Appearance</label>
      <div class="input-row">
        <input type="text" id="qrAppearanceImage" placeholder="/path/to/appearance.png" style="flex:1 1 16rem">
        <button class="btn" type="button" id="btnQrBrowseAppearance">Browse</button>
      </div>
    </div>
    <div class="form-row" id="qrPromptRow">
      <label for="qrPrompt">Prompt</label>
      <input type="text" id="qrPrompt" placeholder="anime city at night, neon lights, rain" style="flex:1 1 16rem">
    </div>
    <div class="form-row">
      <label for="qrNeg">Negative</label>
      <input type="text" id="qrNeg" placeholder="blurry, low quality, distorted (optional)" style="flex:1 1 16rem">
    </div>

    <div class="form-row">
      <label for="qrOutput">Output</label>
      <div class="input-row">
        <input type="text" id="qrOutput" placeholder="blank = /tmp/mtapi_gen/…">
        <button class="btn" type="button" id="btnQrBrowseOut">Save As</button>
      </div>
    </div>

    <div class="form-row">
      <label for="qrModel">Base Model</label>
      <select id="qrModel">
        <option value="rupeshs/sd-turbo-openvino" selected>sd-turbo-openvino (default)</option>
        <option value="runwayml/stable-diffusion-v1-5">SD 1.5 (slow first run)</option>
        <option value="OpenVINO/stable-diffusion-v1-5-int8">SD 1.5 INT8 (OV)</option>
      </select>
      <p class="form-row-hint">OpenVINO models are used directly; IP-Adapter mode auto-switches to PyTorch SD 1.5.</p>
    </div>

    <div class="form-row">
      <label for="qrRefImage">Reference Image (IP-Adapter)</label>
      <div class="input-row">
        <input type="text" id="qrRefImage" placeholder="/path/to/reference.png" style="flex:1 1 16rem">
        <button class="btn" type="button" id="btnQrBrowseRef">Browse</button>
      </div>
      <p class="form-row-hint">Drop any texture/photo here. Low scale = subtle style, High scale = clone the photo</p>
    </div>

    <div class="form-row">
      <label for="qrUseIpAdapter" style="display:flex;align-items:center;gap:0.5rem">
        <input type="checkbox" id="qrUseIpAdapter" style="margin:0">
        <span>Use IP-Adapter</span>
      </label>
    </div>
    <p class="form-row-hint" id="qrIpHint">When checked, uses ControlNet QR Monster for structure + IP-Adapter for appearance. 512×512 forced.</p>

    <div class="knob-row">
      <div class="knob-bank">
        ${knobUnitHtml({ id: 'qrSteps', label: 'Steps', value: '30' })}
        ${knobUnitHtml({ id: 'qrGuidance', label: 'Guidance', value: '9.0' })}
        ${knobUnitHtml({ id: 'qrStrength', label: 'Strength', value: '0.35' })}
        ${knobUnitHtml({ id: 'qrCtrlScale', label: 'Ctrl Scale', value: '1.1' })}
        ${knobUnitHtml({ id: 'qrIpAdapterScale', label: 'IP Scale', value: '0.5' })}
        ${knobUnitHtml({ id: 'qrDryRun', label: 'Dry run', value: '0', binary: true, leftCap: 'Run', rightCap: 'Dry' })}
      </div>
      <p class="knob-row-legend">
        <strong>Steps</strong> 20–40. <strong>Guidance</strong> 5–15. <strong>Strength</strong> 0.05–0.95 (QR preservation).
        <strong>Ctrl Scale</strong> 0.6–1.6 (ControlNet QR Monster). <strong>IP Scale</strong> 0–1 (IP-Adapter influence).
      </p>
    </div>

    <div class="form-row">
      <label for="qrSeed">Seed</label>
      <input type="text" id="qrSeed" placeholder="blank = random" style="flex:0 1 8rem">
    </div>

    <div id="qrScannability" class="qr-scannability" style="display:none" aria-live="polite">
      <span class="qr-badge" id="qrBadge"></span>
      <span class="qr-decoded" id="qrDecoded"></span>
    </div>

    <section class="tool-docs" aria-label="About QR Art">
      <h4 class="tool-docs-title">About · QR Art</h4>
      <p class="tool-docs-lede">
        Uses <code>OVStableDiffusionImg2ImgPipeline</code> via FastSD's Python env
        (<code>MTAPI_FASTSD_ROOT</code> / default scratch fastsdcpu). Device = GPU,
        auto-fallback to CPU on OOM. The QR code is used as the init image for
        img2img diffusion, preserving structure while applying the prompt style.
        Requires <code>qrcode</code>, <code>pyzbar</code>, <code>optimum-intel</code>,
        <code>diffusers</code> installed.
      </p>
      <h5 class="tool-docs-h">Illusion mode</h5>
      <p>
        <strong>Pattern</strong> (monochrome / high-contrast still) is fed to ControlNet as structure.
        <strong>Appearance</strong> (any still) is fed to IP-Adapter as the look to weave through the pattern.
        No QR payload is generated. No scannability badge. Empty prompt falls back to
        <code>"high quality, detailed"</code>.
      </p>
      <h5 class="tool-docs-h">IP-Adapter (Reference Image)</h5>
      <p>
        When <strong>Use IP-Adapter</strong> is checked, the generator switches to a PyTorch
        <code>StableDiffusionControlNetImg2ImgPipeline</code> with dual conditioning:
        <code>monster-labs/control_v1p_sd15_qrcode_monster</code> for <strong>structure</strong>
        and <code>h94/IP-Adapter</code> (<code>ip-adapter_sd15</code>) for <strong>appearance</strong>.
        Upload any texture/photo as the reference. The generated QR art will visually
        match the reference while remaining scannable. Resolution is forced to 512×512
        to keep peak RAM under 12GB on Intel 1335U. IP-Adapter auto-falls back to CPU if
        the iGPU hits a bad allocation.
      </p>

      <h5 class="tool-docs-h">Quick Reference · Parameter Cheatsheet</h5>
      <table class="qr-quick-ref">
        <thead><tr><th>Param</th><th>Range</th><th>QR Mode (scannable)</th><th>Illusion Mode (artistic)</th><th>What it does</th></tr></thead>
        <tbody>
          <tr><td>Steps</td><td>20–40</td><td>30</td><td>30–40</td><td>More steps = more detail, slower</td></tr>
          <tr><td>Guidance</td><td>5–15</td><td>7–9</td><td>5–8</td><td>Lower = follow prompt less, keep structure more</td></tr>
          <tr><td>Strength</td><td>0.05–0.95</td><td><strong>0.15–0.25</strong></td><td>0.3–0.6</td><td><strong>KEY: lower = more QR preserved</strong>. Your 0.35 was too high for scanning</td></tr>
          <tr><td>Ctrl Scale</td><td>0.6–1.6</td><td><strong>1.3–1.8</strong></td><td>1.0–1.3</td><td>ControlNet QR Monster weight. Higher = stricter pattern</td></tr>
          <tr><td>IP Scale</td><td>0–1</td><td>0.3–0.6</td><td>0.4–0.7</td><td>How much reference image bleeds in</td></tr>
        </tbody>
      </table>

      <h5 class="tool-docs-h">Image Inputs Explained</h5>
      <dl class="qr-input-guide">
        <dt><strong>Pattern</strong> (Illusion mode only)</dt>
        <dd>Monochrome, high-contrast structure map. Think: QR code, maze, barcode, line art, silhouette. White=background, black=foreground. <strong>Aspect ratio matters</strong> — use 1:1 (512×512) for best results; non-square gets center-cropped.</dd>

        <dt><strong>Appearance</strong> (Illusion mode only)</dt>
        <dd>The photo/texture to weave <em>through</em> the pattern. Any image works: photos, paintings, textures. Resolution doesn't matter (resized to 512×512). This is your "style reference."</dd>

        <dt><strong>Reference Image (IP-Adapter)</strong> (QR mode, when IP-Adapter checked)</dt>
        <dd>Same as Appearance above — style donor for the QR code. Used alongside generated QR structure.</dd>

        <dt><strong>QR Data</strong> (QR mode only)</dt>
        <dd>The actual text/URL to encode. Generates a real QR code internally as the structure.</dd>
      </dl>

      <h5 class="tool-docs-h">Resolution & Aspect Ratio</h5>
      <ul class="qr-res-notes">
        <li><strong>Internal resolution is always 512×512</strong> when IP-Adapter is active (both modes). Your inputs are resized/cropped to fit.</li>
        <li><strong>Pattern</strong>: use 1:1 square. Non-square → center-cropped → may lose corners.</li>
        <li><strong>Appearance/Reference</strong>: any aspect ratio OK — stretched to 512×512.</li>
        <li>Output PNG is 512×512. Upscale afterward if needed (use Upscale tab).</li>
      </ul>

      <h5 class="tool-docs-h">Why Your Run Failed to Scan</h5>
      <p class="qr-fail-note">
        <code>scannable=no</code> with <strong>Strength 0.35</strong>, <strong>Ctrl Scale 1.1</strong>, <strong>Guidance 9.0</strong> = too much diffusion freedom, not enough pattern enforcement.
        <br><strong>Fix for QR mode:</strong> Strength <strong>0.18</strong>, Ctrl Scale <strong>1.5</strong>, Guidance <strong>7.0</strong>.
        <br><strong>Fix for Illusion mode:</strong> Strength <strong>0.25</strong>, Ctrl Scale <strong>1.3</strong>, Guidance <strong>6.0</strong> — but illusion mode <em>never shows scannability badge</em> (no QR payload generated).
      </p>
    </section>
  `;
  elements.actionPanel.innerHTML = html;

  function updateQrModeUI(mode) {
    const isIllusion = mode === 'illusion';
    const qrTextRow = document.getElementById('qrTextRow');
    const qrPatternRow = document.getElementById('qrPatternRow');
    const qrAppearanceRow = document.getElementById('qrAppearanceRow');
    const qrPromptRow = document.getElementById('qrPromptRow');
    const qrScannability = document.getElementById('qrScannability');
    const qrRefRow = document.getElementById('qrRefImage')?.closest('.form-row');
    const qrUseIpRow = document.getElementById('qrUseIpAdapter')?.closest('.form-row');
    const qrIpHint = document.getElementById('qrIpHint');
    const hint = document.getElementById('qrModeHint');

    if (qrTextRow) qrTextRow.style.display = isIllusion ? 'none' : '';
    if (qrPatternRow) qrPatternRow.style.display = isIllusion ? '' : 'none';
    if (qrAppearanceRow) qrAppearanceRow.style.display = isIllusion ? '' : 'none';
    if (qrPromptRow) qrPromptRow.style.display = isIllusion ? 'none' : '';
    if (qrScannability) qrScannability.style.display = 'none';
    if (hint) hint.style.display = isIllusion ? '' : 'none';

    if (isIllusion) {
      if (qrRefRow) qrRefRow.style.display = 'none';
      if (qrUseIpRow) qrUseIpRow.style.display = 'none';
      if (qrIpHint) qrIpHint.style.display = 'none';
      document.getElementById('qrUseIpAdapter').checked = true;
    } else {
      if (qrRefRow) qrRefRow.style.display = '';
      if (qrUseIpRow) qrUseIpRow.style.display = '';
      if (qrIpHint) qrIpHint.style.display = '';
    }
  }

  const modeRadios = document.querySelectorAll('input[name="qrMode"]');
  modeRadios.forEach(radio => {
    radio.addEventListener('change', (e) => {
      const mode = e.target.value;
      const qrLabel = document.getElementById('qrModeQrLabel');
      const illLabel = document.getElementById('qrModeIllusionLabel');
      if (mode === 'qr') {
        qrLabel.style.borderColor = 'var(--primary)';
        qrLabel.style.background = 'rgba(59, 130, 246, 0.08)';
        qrLabel.style.color = 'white';
        illLabel.style.borderColor = 'var(--panel-border)';
        illLabel.style.background = 'transparent';
        illLabel.style.color = 'var(--text-muted)';
      } else {
        illLabel.style.borderColor = 'var(--primary)';
        illLabel.style.background = 'rgba(59, 130, 246, 0.08)';
        illLabel.style.color = 'white';
        qrLabel.style.borderColor = 'var(--panel-border)';
        qrLabel.style.background = 'transparent';
        qrLabel.style.color = 'var(--text-muted)';
      }
      updateQrModeUI(mode);
    });
  });

  updateQrModeUI('qr');

  setupContinuousKnob({
    knobId: 'qrStepsKnob', indicatorId: 'qrStepsKnobInd',
    valueId: 'qrStepsVal', hiddenId: 'qrSteps',
    min: 20, max: 40, step: 1, decimals: 0,
  });
  setupContinuousKnob({
    knobId: 'qrGuidanceKnob', indicatorId: 'qrGuidanceKnobInd',
    valueId: 'qrGuidanceVal', hiddenId: 'qrGuidance',
    min: 5, max: 15, step: 0.1, decimals: 1,
  });
  setupContinuousKnob({
    knobId: 'qrStrengthKnob', indicatorId: 'qrStrengthKnobInd',
    valueId: 'qrStrengthVal', hiddenId: 'qrStrength',
    min: 0.05, max: 0.95, step: 0.01, decimals: 2,
  });
  setupContinuousKnob({
    knobId: 'qrCtrlScaleKnob', indicatorId: 'qrCtrlScaleKnobInd',
    valueId: 'qrCtrlScaleVal', hiddenId: 'qrCtrlScale',
    min: 0.6, max: 1.6, step: 0.05, decimals: 2,
  });
  setupContinuousKnob({
    knobId: 'qrIpAdapterScaleKnob', indicatorId: 'qrIpAdapterScaleKnobInd',
    valueId: 'qrIpAdapterScaleVal', hiddenId: 'qrIpAdapterScale',
    min: 0.0, max: 1.0, step: 0.05, decimals: 2,
  });
  setupBinaryKnob({
    knobId: 'qrDryRunKnob', indicatorId: 'qrDryRunKnobInd', hiddenId: 'qrDryRun',
    leftValue: '0', rightValue: '1', initial: '0',
  });

  document.getElementById('btnQrBrowseOut')?.addEventListener('click', function() {
    if (typeof openFileBrowser === 'function') {
      openFileBrowser('qrOutput', false, 'file_save', 'all');
    }
  });

  document.getElementById('btnQrBrowseRef')?.addEventListener('click', function() {
    if (typeof openFileBrowser === 'function') {
      openFileBrowser('qrRefImage', false, 'file', 'image');
    }
  });

  document.getElementById('btnQrBrowsePattern')?.addEventListener('click', function() {
    if (typeof openFileBrowser === 'function') {
      openFileBrowser('qrPatternImage', false, 'file', 'image');
    }
  });

  document.getElementById('btnQrBrowseAppearance')?.addEventListener('click', function() {
    if (typeof openFileBrowser === 'function') {
      openFileBrowser('qrAppearanceImage', false, 'file', 'image');
    }
  });

  import('/js/ui/prompt-library.js').then(function (m) {
    m.attachPromptLibrary({
      containerEl: document.getElementById('qrPromptLib'),
      positiveEl: document.getElementById('qrPrompt'),
      negativeEl: document.getElementById('qrNeg'),
      sourceTab: 'qr_art',
    });
   });
}

function showQrScannability(meta) {
  var box = document.getElementById('qrScannability');
  var badge = document.getElementById('qrBadge');
  var decoded = document.getElementById('qrDecoded');
  if (!box || !badge || !decoded) return;
  if (!meta) { box.style.display = 'none'; return; }
  box.style.display = '';
  if (meta.scannable) {
    badge.textContent = 'Scannable';
    badge.className = 'qr-badge scannable';
    decoded.textContent = meta.decoded ? 'Decoded: ' + meta.decoded : '';
  } else {
    badge.textContent = 'Failed to scan';
    badge.className = 'qr-badge fail';
    decoded.textContent = meta.scan_error ? 'Error: ' + meta.scan_error : '';
  }
}

function collectQrBody() {
  var mode = (document.querySelector('input[name="qrMode"]:checked')?.value || 'qr').trim();
  if (!mode) mode = 'qr';

  var prompt = '';
  var qrText = '';
  var patternImage = '';
  var appearanceImage = '';

  if (mode === 'illusion') {
    patternImage = (document.getElementById('qrPatternImage')?.value || '').trim();
    appearanceImage = (document.getElementById('qrAppearanceImage')?.value || '').trim();
    if (!patternImage || !appearanceImage) {
      var giEl = document.getElementById('giImage');
      if (giEl) {
        var lines = giEl.value.split('\n').map(function(l){ return l.trim(); }).filter(Boolean);
        if (!patternImage && lines.length > 0) patternImage = lines[0];
        if (!appearanceImage && lines.length > 1) appearanceImage = lines[1];
      }
    }
    if (!patternImage) {
      alert('Illusion mode requires a Pattern image.');
      return null;
    }
    if (!appearanceImage) {
      alert('Illusion mode requires an Appearance image.');
      return null;
    }
  } else {
    qrText = (document.getElementById('qrText')?.value || '').trim();
    if (!qrText) {
      alert('QR Data is required.');
      return null;
    }
    prompt = (document.getElementById('qrPrompt')?.value || '').trim();
    if (!prompt) {
      alert('Prompt is required.');
      return null;
    }
  }

  var seedRaw = (document.getElementById('qrSeed')?.value || '').trim();
  var seed = null;
  if (seedRaw !== '') {
    seed = parseInt(seedRaw, 10);
    if (isNaN(seed)) seed = null;
  }
  var useIpAdapter = document.getElementById('qrUseIpAdapter')?.checked || false;
  var ipImage = (document.getElementById('qrRefImage')?.value || '').trim();
  if (useIpAdapter && !ipImage && mode !== 'illusion') {
    alert('IP-Adapter is enabled but no reference image is set. Provide one or uncheck "Use IP-Adapter".');
    return null;
  }

  var body = {
    mode: mode,
    prompt: mode === 'illusion' ? '' : prompt,
    negative_prompt: (document.getElementById('qrNeg')?.value || '').trim(),
    qr_text: qrText,
    pattern_image: patternImage,
    steps: parseInt(document.getElementById('qrSteps')?.value || '30', 10),
    guidance_scale: parseFloat(document.getElementById('qrGuidance')?.value || '9'),
    strength: parseFloat(document.getElementById('qrStrength')?.value || '0.35'),
    seed: seed,
    output_path: (document.getElementById('qrOutput')?.value || '').trim() || null,
    model_id: document.getElementById('qrModel')?.value || 'runwayml/stable-diffusion-v1-5',
    device: 'gpu',
    dry_run: document.getElementById('qrDryRun')?.value === '1',
    use_ip_adapter: useIpAdapter,
    ip_adapter_image: (useIpAdapter && ipImage) ? ipImage : (mode === 'illusion' ? appearanceImage : ''),
    ip_adapter_scale: parseFloat(document.getElementById('qrIpAdapterScale')?.value || '0.5'),
    controlnet_scale: parseFloat(document.getElementById('qrCtrlScale')?.value || '1.1'),
  };

  if (mode === 'illusion') {
    body.prompt = '';
    body.qr_text = '';
    body.use_ip_adapter = true;
    body.ip_adapter_image = appearanceImage;
  }

  return body;
}

export { renderQrArtForm, collectQrBody, showQrScannability };
