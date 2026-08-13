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

    <div id="qrPromptLib" class="prompt-library-bar" aria-label="Prompt library"></div>
    <div class="form-row">
      <label for="qrText">QR Data</label>
      <input type="text" id="qrText" placeholder="https://example.com or any text" style="flex:1 1 16rem">
    </div>
    <div class="form-row">
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
    <p class="form-row-hint">When checked, uses ControlNet QR Monster for structure + IP-Adapter for appearance. 512×512 forced.</p>

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
    </section>
  `;
  elements.actionPanel.innerHTML = html;

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
  var qrText = (document.getElementById('qrText')?.value || '').trim();
  if (!qrText) {
    alert('QR Data is required.');
    return null;
  }
  var prompt = (document.getElementById('qrPrompt')?.value || '').trim();
  if (!prompt) {
    alert('Prompt is required.');
    return null;
  }
  var seedRaw = (document.getElementById('qrSeed')?.value || '').trim();
  var seed = null;
  if (seedRaw !== '') {
    seed = parseInt(seedRaw, 10);
    if (isNaN(seed)) seed = null;
  }
  var useIpAdapter = document.getElementById('qrUseIpAdapter')?.checked || false;
  var ipImage = (document.getElementById('qrRefImage')?.value || '').trim();
  if (useIpAdapter && !ipImage) {
    alert('IP-Adapter is enabled but no reference image is set. Provide one or uncheck "Use IP-Adapter".');
    return null;
  }
  return {
    prompt: prompt,
    negative_prompt: (document.getElementById('qrNeg')?.value || '').trim(),
    qr_text: qrText,
    steps: parseInt(document.getElementById('qrSteps')?.value || '30', 10),
    guidance_scale: parseFloat(document.getElementById('qrGuidance')?.value || '9'),
    strength: parseFloat(document.getElementById('qrStrength')?.value || '0.35'),
    seed: seed,
    output_path: (document.getElementById('qrOutput')?.value || '').trim() || null,
    model_id: document.getElementById('qrModel')?.value || 'runwayml/stable-diffusion-v1-5',
    device: 'gpu',
    dry_run: document.getElementById('qrDryRun')?.value === '1',
    use_ip_adapter: useIpAdapter,
    ip_adapter_image: (useIpAdapter && ipImage) ? ipImage : '',
    ip_adapter_scale: parseFloat(document.getElementById('qrIpAdapterScale')?.value || '0.5'),
    controlnet_scale: parseFloat(document.getElementById('qrCtrlScale')?.value || '1.1'),
  };
}

export { renderQrArtForm, collectQrBody, showQrScannability };
