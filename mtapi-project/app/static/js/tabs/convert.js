import { state, elements, bestInput, logConsole } from '/app.js';
import { withFrameRange } from '/js/utils.js';

const PRESETS_BY_GROUP = {
  intermediate: [
    { id: 'prores_hq', label: 'ProRes 422 HQ (Apple intermediate \u00B7 Resolve / FCP)', blurb: 'High-quality edit intermediate. 10-bit 4:2:2. Large files, very editable. Prefer if you work with ProRes or want max quality.' },
    { id: 'prores_proxy', label: 'ProRes Proxy (lightweight intermediate \u00B7 offline edit)', blurb: 'Small/fast ProRes for rough cuts; not delivery.' },
    { id: 'dnxhr_lb', label: 'DNxHR LB (Avid / Resolve intermediate \u00B7 low bandwidth)', blurb: 'Same family as Folder Watcher default. Smallest DNxHR; good for proxies and Resolve Free on Linux.' },
    { id: 'dnxhr_sq', label: 'DNxHR SQ (Avid / Resolve intermediate \u00B7 standard quality)', blurb: 'Balanced size vs quality for general Resolve work.' },
    { id: 'dnxhr_hq', label: 'DNxHR HQ (Avid / Resolve intermediate \u00B7 high quality)', blurb: 'Heavier intermediate when LB/SQ look soft or you need more headroom.' },
  ],
  delivery: [
    { id: 'h264_avc', label: 'H.264 / AVC \u00B7 MP4 (universal playback)', blurb: 'Default \u201Cjust plays everywhere\u201D export. YouTube-ish, phones, most browsers, Discord, etc. AVC = Advanced Video Coding = H.264.' },
    { id: 'h264_avc_hq', label: 'H.264 / AVC \u00B7 MP4 high quality (near-master delivery)', blurb: 'Same universal codec, visually cleaner (CRF 18). Bigger files. Good for archival-ish masters.' },
    { id: 'h265_hevc', label: 'H.265 / HEVC \u00B7 MP4 (efficient modern devices)', blurb: 'Half the bitrate of H.264 for similar look. HEVC = High Efficiency Video Coding = H.265. Tag hvc1 for Apple.' },
    { id: 'h265_hevc_hq', label: 'H.265 / HEVC \u00B7 MP4 high quality', blurb: 'Cleaner HEVC (CRF 20). Still much smaller than ProRes/DNxHR.' },
    { id: 'webm_vp9', label: 'VP9 \u00B7 WebM (web / open formats)', blurb: 'Browser-friendly open stack. Good for web embeds; encode is slower than x264. Opus audio.' },
    { id: 'av1_mp4', label: 'AV1 \u00B7 MP4 (next-gen efficient delivery)', blurb: 'Newer than HEVC; excellent compression. Encode can be slow (SVT-AV1). Prefer when recipients can play AV1.' },
  ],
  archive: [
    { id: 'ffv1_mkv', label: 'FFV1 \u00B7 MKV (lossless archive / mezzanine)', blurb: 'Bit-exact-ish lossless video archive. Huge. Good \u201Cdon\u2019t lose any more generation\u201D store between pipelines. Not for Resolve Free import.' },
  ],
  frames: [
    { id: 'frames_png', label: 'PNG image sequence \u00B7 folder (lossless frames out \u00B7 pipeline-native)', blurb: 'Canonical dump. Same format/pattern as internal filter stages (DeepDream, RIFE). Outputs a folder of frame_000000.png files.' },
    { id: 'frames_webp', label: 'WebP image sequence \u00B7 folder (efficient stills out)', blurb: 'Smaller than PNG for human/export use. Not mid-chain for filters \u2014 re-import normalizes or encodes directly.' },
    { id: 'frames_jpg', label: 'JPEG / JPG image sequence \u00B7 folder (small stills out)', blurb: 'Smallest common dump. Lossy. Bad for multi-generation filter work.' },
    { id: 'frames_tiff', label: 'TIFF image sequence \u00B7 folder (print / VFX style stills)', blurb: 'Low priority. Prefer PNG for pipeline compatibility.' },
  ],
};

const GROUP_LABELS = {
  intermediate: 'Intermediates \u2014 for DaVinci Resolve / NLE import',
  delivery: 'Delivery \u2014 web, devices, sharing',
  archive: 'Archive / Mezzanine',
  frames: 'Image sequences \u2014 frames out',
};

const AUTO_NAMES = {
  'prores_hq': '_prores_hq.mov',
  'prores_proxy': '_prores_proxy.mov',
  'dnxhr_lb': '_dnxhr_lb.mov',
  'dnxhr_sq': '_dnxhr_sq.mov',
  'dnxhr_hq': '_dnxhr_hq.mov',
  'h264_avc': '_h264_avc.mp4',
  'h264_avc_hq': '_h264_avc_hq.mp4',
  'h265_hevc': '_h265_hevc.mp4',
  'h265_hevc_hq': '_h265_hevc_hq.mp4',
  'webm_vp9': '_vp9.webm',
  'av1_mp4': '_av1.mp4',
  'ffv1_mkv': '_ffv1.mkv',
  'frames_png': '_frames_png/',
  'frames_webp': '_frames_webp/',
  'frames_jpg': '_frames_jpg/',
  'frames_tiff': '_frames_tiff/',
};

function renderConvertForm() {
  const html = `
    <div class="panel-title-desc dense">
      <h3>Convert / Export</h3>
      <p class="dream-hint">
        Codecs &amp; frame dumps (ProRes/DNxHR · H.264/265 · FFV1 · PNG seq). Not geometry / Watcher.
      </p>
    </div>

    <div class="form-row">
      <label for="convertTarget">Target</label>
      <select id="convertTarget">
        ${Object.entries(GROUP_LABELS).map(([group, groupLabel]) => `
          <optgroup label="${groupLabel}">
            ${(PRESETS_BY_GROUP[group] || []).map(p => `
              <option value="${p.id}" title="${p.blurb.replace(/"/g, '&quot;')}">${p.label}</option>
            `).join('')}
          </optgroup>
        `).join('')}
      </select>
      <p class="form-row-hint" id="convertTargetHelp"></p>
    </div>

    <div class="form-row">
      <label for="convertInput">Input</label>
      <div class="input-row">
        <input type="text" id="convertInput" placeholder="video · GIF · frames folder">
        <button class="btn" type="button" id="btnConvertBrowseIn">Browse</button>
      </div>
    </div>

    <div class="form-row">
      <label for="convertOutput">Output</label>
      <div class="input-row">
        <input type="text" id="convertOutput" placeholder="blank = auto next to source">
        <button class="btn" type="button" id="btnConvertBrowseOut">Save As</button>
      </div>
      <p class="form-row-hint" id="convertOutputHint">auto-named next to source</p>
    </div>

    <div class="form-group" id="convertFpsGroup">
      <label for="convertFps">FPS <span class="field-desc">(used when assembling image folders; ignored for video sources)</span></label>
      <input type="number" id="convertFps" value="24" min="1" max="120" step="0.001">
    </div>

    <div class="form-group">
      <label class="checkbox-label">
        <input type="checkbox" id="convertDryRun"> Dry run (print command, don't execute)
      </label>
    </div>

    <div class="convert-glossary" id="convertGlossary">
      <h4>Quick glossary</h4>
      <table class="glossary-table">
        <tr><td><strong>AVC</strong></td><td>Advanced Video Coding = H.264</td></tr>
        <tr><td><strong>HEVC</strong></td><td>High Efficiency Video Coding = H.265</td></tr>
        <tr><td><strong>VP9</strong></td><td>Google open codec, WebM container</td></tr>
        <tr><td><strong>AV1</strong></td><td>AOMedia Video 1, royalty-free next-gen</td></tr>
        <tr><td><strong>ProRes</strong></td><td>Apple intermediate codec, MOV</td></tr>
        <tr><td><strong>DNxHR</strong></td><td>Avid intermediate, successor to DNxHD</td></tr>
        <tr><td><strong>FFV1</strong></td><td>Lossless archive codec, MKV</td></tr>
        <tr><td><strong>PNG</strong></td><td>Lossless stills; pipeline-native dump format</td></tr>
        <tr><td><strong>PCM</strong></td><td>Uncompressed audio, edit-friendly</td></tr>
        <tr><td><strong>AAC</strong></td><td>Lossy audio, MP4 standard</td></tr>
        <tr><td><strong>Opus</strong></td><td>Modern lossy audio, WebM standard</td></tr>
      </table>
      <p class="convert-note">
        <strong>PNG sequences are the shared language</strong> between Convert and neural
        filters (DeepDream, RIFE, pipeline chain). Dump to PNG, run filters, re-encode with
        any preset below. Also see <em>Folder Watcher</em> for batch DNxHR ingest.
      </p>
    </div>
  `;

  elements.actionPanel.innerHTML = html;

  const targetSel = document.getElementById('convertTarget');
  const help = document.getElementById('convertTargetHelp');
  const fpsGroup = document.getElementById('convertFpsGroup');
  const outputHint = document.getElementById('convertOutputHint');

  function updateHelp() {
    const val = targetSel.value;
    let preset = null;
    for (const g of Object.values(PRESETS_BY_GROUP)) {
      preset = g.find(p => p.id === val);
      if (preset) break;
    }
    if (!preset) return;

    const isFrames = val.startsWith('frames_');
    const autoName = AUTO_NAMES[val] || '.mp4';

    let text = `<strong>${preset.label.split('\u00B7')[0].trim()}</strong>: ${preset.blurb}`;
    if (isFrames) {
      text += `<br><br><strong>Output is a folder.</strong> Files: <code>frame_000000.ext</code> \u2026 (pipeline-native, start at 0).`;
    }
    text += `<br>Auto-name: <code>source_name${autoName}</code>`;

    help.innerHTML = text;

    if (isFrames) {
      fpsGroup.style.display = 'none';
      outputHint.textContent = 'Output will be a folder: source_name' + autoName;
    } else {
      fpsGroup.style.display = '';
      outputHint.textContent = 'Output will be auto-named next to source: source_name' + autoName;
    }
  }

  targetSel.addEventListener('change', updateHelp);
  updateHelp();

  document.getElementById('btnConvertBrowseIn')?.addEventListener('click', () => {
    openFileBrowser('convertInput', false, 'file', 'all');
  });
  document.getElementById('btnConvertBrowseOut')?.addEventListener('click', () => {
    openFileBrowser('convertOutput', false, 'file_save', 'all');
  });

  if (state.pendingInputPath && state.pendingInputTarget === 'convert') {
    const inp = document.getElementById('convertInput');
    if (inp) {
      inp.value = state.pendingInputPath;
      inp.dispatchEvent(new Event('input'));
    }
    state.pendingInputPath = null;
    state.pendingInputTarget = null;
  }
}

function collectConvertBody() {
  // First path only here; job-control batches allInputPaths when multi-line
  const input = bestInput('convertInput');
  const output = document.getElementById('convertOutput')?.value?.trim() || null;
  const target = document.getElementById('convertTarget')?.value || 'h264_avc';
  const fps = parseFloat(document.getElementById('convertFps')?.value) || 24;
  const dryRun = document.getElementById('convertDryRun')?.checked || false;

  if (!input) {
    alert('Please provide an input path (video, GIF, or image folder).\nMultiple videos: one path per line in Path video.');
    return null;
  }

  return withFrameRange({
    input_path: input,
    target: target,
    output_path: output,
    fps: fps,
    dry_run: dryRun,
  });
}

export { renderConvertForm, collectConvertBody };
