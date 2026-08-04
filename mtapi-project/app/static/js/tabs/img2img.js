import { elements, bestInput } from '/app.js';
import { setupContinuousKnob, setupBinaryKnob, knobUnitHtml } from '/js/ui/knobs.js';
import { withFrameRange } from '/js/utils.js';

/**
 * Img2Img (OpenVINO / FastSD GPU) — still or video.
 * Mark frames with comma indices (0-based) or leave blank for all.
 */

function renderImg2ImgForm() {
  const html = `
    <div class="panel-title-desc dense">
      <h3>Img2Img · OpenVINO (GPU)</h3>
      <p class="dream-hint">
        FastSD OpenVINO on <strong>GPU</strong>. Prompt rewrites marked frames; unmarked frames copy through.
        Still PNG/JPG or video (dump → stage → encode).
      </p>
    </div>

    <div class="form-row">
      <label for="i2iInput">Input</label>
      <div class="input-row">
        <input type="text" id="i2iInput" placeholder="/absolute/path/to/image.png or video.mp4">
        <button class="btn" type="button" id="btnI2iBrowseIn">Browse</button>
      </div>
      <p class="form-row-hint">Uses global Video/Image bar if this is blank</p>
    </div>

    <div class="form-row">
      <label for="i2iOutput">Output</label>
      <div class="input-row">
        <input type="text" id="i2iOutput" placeholder="blank = auto next to source">
        <button class="btn" type="button" id="btnI2iBrowseOut">Save As</button>
      </div>
    </div>

    <div id="i2iPromptLib" class="prompt-library-bar" aria-label="Prompt library"></div>
    <div class="form-row">
      <label for="i2iPrompt">Prompt</label>
      <input type="text" id="i2iPrompt" placeholder="watercolor illustration, soft light" style="flex:1 1 16rem">
      <button type="button" class="btn" id="btnI2iFromImage" title="Vision CLI writes SD1.5 prompt from input image">Prompt from image</button>
    </div>
    <div class="form-row">
      <label for="i2iNeg">Negative</label>
      <input type="text" id="i2iNeg" placeholder="blurry, low quality (optional)" style="flex:1 1 16rem">
    </div>

    <div class="form-row">
      <label for="i2iFrames">Mark frames</label>
      <input type="text" id="i2iFrames" placeholder="all · or 0,5,10 · or range 0-20" style="flex:1 1 12rem">
      <p class="form-row-hint">0-based indices after dump. Blank = every frame. Video only matters for multi-frame.</p>
    </div>

    <div class="form-row">
      <label for="i2iModel">Model</label>
      <select id="i2iModel">
        <option value="rupeshs/sd-turbo-openvino" selected>sd-turbo-openvino (default)</option>
        <option value="rupeshs/LCM-dreamshaper-v7-openvino">LCM-dreamshaper-v7-openvino</option>
        <option value="rupeshs/sd15-lcm-square-openvino-int8">sd15-lcm-square-openvino-int8</option>
      </select>
    </div>

    <div class="knob-row">
      <div class="knob-bank">
        ${knobUnitHtml({ id: 'i2iStrength', label: 'Strength', value: '0.35' })}
        ${knobUnitHtml({ id: 'i2iSteps', label: 'Steps', value: '4' })}
        ${knobUnitHtml({ id: 'i2iGuidance', label: 'Guidance', value: '1.0' })}
        ${knobUnitHtml({ id: 'i2iMaxSide', label: 'Max side', value: '0' })}
        ${knobUnitHtml({ id: 'i2iDryRun', label: 'Dry run', value: '0', binary: true, leftCap: 'Run', rightCap: 'Dry' })}
      </div>
      <p class="knob-row-legend">
        <strong>Strength</strong> — low keeps structure, high rewrites.<br>
        <strong>Steps</strong> — base steps (OpenVINO path scales like FastSD).<br>
        <strong>Max side</strong> — 0 = native (%%8); try 512/768 if VRAM tight.
      </p>
    </div>

    <section class="tool-docs" aria-label="About img2img">
      <h4 class="tool-docs-title">About · Img2Img</h4>
      <p class="tool-docs-lede">
        Runs <code>OVStableDiffusionImg2ImgPipeline</code> under FastSD’s Python
        (<code>MTAPI_FASTSD_ROOT</code> / default scratch fastsdcpu). Device = GPU.
        Needs that env installed; mtapi’s own venv does not include OpenVINO.
      </p>
      <h5 class="tool-docs-h">Mark frames</h5>
      <p>Comma list <code>0,12,24</code> or range <code>0-20</code>. Unmarked frames are copied. For a single still, leave blank.</p>
    </section>
  `;
  elements.actionPanel.innerHTML = html;

  setupContinuousKnob({
    knobId: 'i2iStrengthKnob', indicatorId: 'i2iStrengthKnobInd',
    valueId: 'i2iStrengthVal', hiddenId: 'i2iStrength',
    min: 0.05, max: 0.95, step: 0.01, decimals: 2,
  });
  setupContinuousKnob({
    knobId: 'i2iStepsKnob', indicatorId: 'i2iStepsKnobInd',
    valueId: 'i2iStepsVal', hiddenId: 'i2iSteps',
    min: 1, max: 30, step: 1, decimals: 0,
  });
  setupContinuousKnob({
    knobId: 'i2iGuidanceKnob', indicatorId: 'i2iGuidanceKnobInd',
    valueId: 'i2iGuidanceVal', hiddenId: 'i2iGuidance',
    min: 0, max: 8, step: 0.1, decimals: 1,
  });
  setupContinuousKnob({
    knobId: 'i2iMaxSideKnob', indicatorId: 'i2iMaxSideKnobInd',
    valueId: 'i2iMaxSideVal', hiddenId: 'i2iMaxSide',
    min: 0, max: 1024, step: 64, decimals: 0,
  });
  setupBinaryKnob({
    knobId: 'i2iDryRunKnob', indicatorId: 'i2iDryRunKnobInd', hiddenId: 'i2iDryRun',
    leftValue: '0', rightValue: '1', initial: '0',
  });

  document.getElementById('btnI2iBrowseIn')?.addEventListener('click', function() {
    if (typeof openFileBrowser === 'function') {
      openFileBrowser('i2iInput', false, 'file', 'all');
    }
  });
  document.getElementById('btnI2iBrowseOut')?.addEventListener('click', function() {
    if (typeof openFileBrowser === 'function') {
      openFileBrowser('i2iOutput', false, 'file_save', 'all');
    }
  });

  import('/js/ui/prompt-library.js').then(function (m) {
    m.attachPromptLibrary({
      containerEl: document.getElementById('i2iPromptLib'),
      positiveEl: document.getElementById('i2iPrompt'),
      negativeEl: document.getElementById('i2iNeg'),
      sourceTab: 'img2img',
    });
  });

  document.getElementById('btnI2iFromImage')?.addEventListener('click', async function() {
    var input = (document.getElementById('i2iInput')?.value || '').trim();
    if (!input && typeof bestInput === 'function') {
      try { input = bestInput() || ''; } catch (_) { /* ignore */ }
    }
    if (!input) {
      var gi = window.globalInputs || {};
      input = (gi.image || gi.video || '').split('\n').map(function(l) { return l.trim(); }).filter(Boolean)[0] || '';
    }
    if (!input) {
      alert('Set an input image path first.');
      return;
    }
    // stills only for vision prompt
    if (/\.(mp4|mkv|mov|webm|avi|m4v)$/i.test(input)) {
      alert('Prompt from image needs a still (png/jpg). Use Agent tab on a frame extract, or pick a PNG.');
      return;
    }
    try {
      var { runOpWithCancel } = await import('/js/job-control.js');
      var { logConsole } = await import('/app.js');
      logConsole('[IMG2IMG]: requesting SD1.5 prompt via agent…');
      var data = await runOpWithCancel('image_to_prompt', {
        image_path: input,
        backend: 'grok',
      }, { label: 'Prompt from image…' });
      if (!data || !data.ok) {
        alert('Prompt failed: ' + ((data && data.error) || 'unknown'));
        return;
      }
      var text = '';
      if (data.items && data.items[0] && (data.items[0].prompt || data.items[0].content)) {
        text = data.items[0].prompt || data.items[0].content;
      } else if (data.stdout) {
        var m = String(data.stdout).match(/^PROMPT:\s*(.+)$/m);
        text = m ? m[1].trim() : String(data.stdout).split('\n')[0].trim();
      }
      if (text) {
        var el = document.getElementById('i2iPrompt');
        if (el) el.value = text;
        logConsole('[IMG2IMG]: prompt set — ' + text.slice(0, 120));
      }
    } catch (err) {
      alert('Prompt from image failed: ' + err.message);
    }
  });
}

function _parseFrameMarks(raw) {
  raw = (raw || '').trim();
  if (!raw || raw.toLowerCase() === 'all') {
    return { frame_indices: null, frame_range: null };
  }
  // range a-b
  var m = raw.match(/^(\d+)\s*[-–:]\s*(\d+)$/);
  if (m) {
    return { frame_indices: null, frame_range: [parseInt(m[1], 10), parseInt(m[2], 10)] };
  }
  var parts = raw.split(/[\s,;]+/).filter(Boolean);
  var idxs = [];
  for (var i = 0; i < parts.length; i++) {
    var n = parseInt(parts[i], 10);
    if (!isNaN(n) && n >= 0) idxs.push(n);
  }
  return { frame_indices: idxs.length ? idxs : null, frame_range: null };
}

function collectImg2ImgBody() {
  var input = (document.getElementById('i2iInput')?.value || '').trim()
    || (typeof bestInput === 'function' ? bestInput('i2iInput') : '')
    || '';
  // bestInput may ignore id — also try globals
  if (!input && typeof bestInput === 'function') {
    try { input = bestInput() || ''; } catch (_) { /* ignore */ }
  }
  if (!input) {
    var gi = window.globalInputs || {};
    input = (gi.video || gi.image || '').split('\n').map(function(l) {
      return l.trim();
    }).filter(Boolean)[0] || '';
  }
  if (!input) {
    alert('Provide an input image or video path.');
    return null;
  }
  var prompt = (document.getElementById('i2iPrompt')?.value || '').trim();
  if (!prompt) {
    alert('Prompt is required.');
    return null;
  }
  var marks = _parseFrameMarks(document.getElementById('i2iFrames')?.value);
  var body = {
    input_path: input,
    output_path: (document.getElementById('i2iOutput')?.value || '').trim() || null,
    prompt: prompt,
    negative_prompt: (document.getElementById('i2iNeg')?.value || '').trim(),
    strength: parseFloat(document.getElementById('i2iStrength')?.value || '0.35'),
    inference_steps: parseInt(document.getElementById('i2iSteps')?.value || '4', 10),
    guidance_scale: parseFloat(document.getElementById('i2iGuidance')?.value || '1'),
    model_id: document.getElementById('i2iModel')?.value || 'rupeshs/sd-turbo-openvino',
    device: 'gpu',
    max_side: parseInt(document.getElementById('i2iMaxSide')?.value || '0', 10) || 0,
    frame_indices: marks.frame_indices,
    frame_range: marks.frame_range,
    dry_run: document.getElementById('i2iDryRun')?.value === '1',
  };
  // Frame range from global bar for video (1-based → ops start_frame/end_frame)
  if (typeof withFrameRange === 'function') {
    body = withFrameRange(body);
  }
  return body;
}

export { renderImg2ImgForm, collectImg2ImgBody };
