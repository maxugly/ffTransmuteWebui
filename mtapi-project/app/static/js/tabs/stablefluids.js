import { state, elements } from '/app.js';

let mediaRecorder = null;
let recording = false;

function checkStableFluidsBuild() {
  return fetch('/stablefluids/index.html', { method: 'HEAD' })
    .then(r => r.ok)
    .catch(() => false);
}

function waitForCanvas(iframe, onFound) {
  const poll = () => {
    try {
      const doc = iframe.contentDocument;
      if (!doc) {
        setTimeout(poll, 250);
        return;
      }
      const canvas = doc.querySelector('canvas');
      if (canvas) {
        onFound(canvas);
        return;
      }
    } catch (_) {
      onFound(null);
      return;
    }
    setTimeout(poll, 250);
  };
  poll();
}

function startRecording(canvas) {
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
    recording = false;
    const btn = document.getElementById('btnSfRecord');
    if (btn) {
      btn.textContent = 'Record';
      btn.disabled = false;
    }
  };
  mediaRecorder.start();
  recording = true;
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
}

function renderStableFluidsForm() {
  checkStableFluidsBuild().then(present => {
    state.stableFluids.buildPresent = present;
    const recordBtnDisabled = present ? '' : 'disabled';
    const iframeBlock = present
      ? `<iframe id="sfIframe" src="/stablefluids/" style="width:100%; height:70vh; border:none; background:#000;"></iframe>`
      : `<div class="sf-placeholder" style="border:1px dashed #555; padding:24px; border-radius:8px; background:#1a1a1a;">
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

    elements.actionPanel.innerHTML = `
      <div class="panel-title-desc">
        <h3>Stable Fluids · WebGL Sim</h3>
        <p class="dream-hint">Self-hosted WebGL fluid simulation · no Unity needed · record canvas to WebM</p>
      </div>
      <div class="form-group">
        <button type="button" class="btn btn-primary" id="btnSfRecord" ${recordBtnDisabled}>Record</button>
      </div>
      ${iframeBlock}
      <section class="tool-docs" aria-label="About Stable Fluids">
        <h4 class="tool-docs-title">About · Stable Fluids</h4>
        <p class="tool-docs-lede">Self-hosted WebGL fluid sim by keijiro. No Unity runtime required — runs as a static site.</p>
        <h5 class="tool-docs-h">Recording</h5>
        <p>Click <strong>Record</strong> to capture the canvas at 60 fps as VP9 WebM. The file downloads automatically when you stop.</p>
      </section>
    `;

    const btn = document.getElementById('btnSfRecord');
    if (btn && present) {
      btn.addEventListener('click', () => {
        if (recording) {
          stopRecording();
          btn.textContent = 'Record';
          btn.disabled = false;
        } else {
          const iframe = document.getElementById('sfIframe');
          waitForCanvas(iframe, (canvas) => {
            if (canvas) {
              startRecording(canvas);
              btn.textContent = 'Stop';
            } else {
              btn.disabled = true;
              btn.textContent = 'Record';
            }
          });
        }
      });
    }
  });
}

export { renderStableFluidsForm };
