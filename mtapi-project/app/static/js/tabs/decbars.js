/**
 * DECbars — Robotic Rap Step Sequencer Tab (spec: docs/decbars-spec.md).
 *
 * Spatially linear time-proportional sequencer with triplet mode,
 * espeak-ng word chopping, Essentia beat analysis, and Web Audio playback.
 *
 * Help law: All hover hints use data-help-title and data-help-text. Zero title= attributes.
 */
import { elements, bestInput } from '/app.js?v=2';
import { escapeHtml as esc } from '/js/utils.js';
import { openAudioExportDialog } from '/js/ui/audio-export.js';

const help = (title, text) => `data-help-title="${esc(title)}" data-help-text="${esc(text)}"`;

// Sequencer state
const decState = {
  bpm: 120.0,
  zoom: 1.0,           // 1.0 = 80px per beat
  baseBeatPx: 80,
  subdivision: 2,      // 1=quarter, 2=eighth, 4=sixteenth
  triplets: false,     // false=straight (2 or 4 divisions), true=triplets (3 divisions per beat)
  totalBeats: 32,      // 8 bars of 4/4
  backingTrackPath: '',
  backingDuration: 0,
  words: [],           // Palette words: [{ id, word, url, duration, path }]
  placedWords: [],     // Sequencer words: [{ id, word, url, duration, path, beatOffset, gainDb }]
  isPlaying: false,
  playheadBeat: 0.0,
  autoFlowMode: '2_per_step', // 1_per_step, 2_per_step, 4_per_step, triplet_3
  voice: 'en',
  speed: 160,
  pitch: 50,
  format: 'flac',
  output: '',
  settings: {},
};

let audioCtx = null;
let backingAudioBuffer = null;
const wordAudioBuffers = new Map(); // url -> AudioBuffer
let activeSources = [];
let animFrameId = null;
let playStartTime = 0;
let playStartOffset = 0;

function getAudioContext() {
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      audioCtx = new AudioContextClass();
    }
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  return audioCtx;
}

async function loadBuffer(url) {
  if (wordAudioBuffers.has(url)) return wordAudioBuffers.get(url);
  const ctx = getAudioContext();
  if (!ctx) return null;
  try {
    const res = await fetch(url);
    const arr = await res.arrayBuffer();
    const buf = await ctx.decodeAudioData(arr);
    wordAudioBuffers.set(url, buf);
    return buf;
  } catch (e) {
    console.error('Failed to load audio buffer', url, e);
    return null;
  }
}

export async function renderDecbarsForm() {
  const host = elements.actionPanel;
  if (!host) return;

  if (!decState.backingTrackPath) {
    try {
      const g = (bestInput('decBeatPath') || '').trim();
      if (g) decState.backingTrackPath = g;
    } catch (_) {}
  }

  host.innerHTML = `
    <div class="decbars-workspace">
      <!-- Toolbar -->
      <div class="decbars-toolbar">
        <div class="decbars-tool-group">
          <label for="decBeatPath">Beat Path</label>
          <input type="text" id="decBeatPath" style="width: 200px;" placeholder="/path/to/beat.wav"
            value="${esc(decState.backingTrackPath)}" ${help('Backing Beat Path', 'Absolute filesystem path to an instrumental track or beat file.')}>
          <button id="decBtnBrowseBeat" class="decbars-btn" ${help('Browse Beat File', 'Open the file browser to pick an audio file.')}>Browse</button>
          <button id="decBtnFromGlobal" class="decbars-btn" ${help('Use Global Input', 'Load the media path from the top Global Media In bar.')}>Globals</button>
          <button id="decBtnAnalyze" class="decbars-btn" ${help('Analyze Beat', 'Extract BPM, beats, onsets, and duration from the backing track using Essentia.')}>⚡ Analyze</button>
        </div>

        <div class="decbars-tool-group">
          <label for="decBpm">BPM</label>
          <input type="number" id="decBpm" style="width: 65px;" min="40" max="240" step="0.1" value="${decState.bpm}"
            ${help('Tempo (BPM)', 'Beats per minute. Drives the spatial timeline scale.')}>
        </div>

        <div class="decbars-tool-group">
          <label for="decTriplets">Triplets</label>
          <button id="decBtnTriplets" class="decbars-btn ${decState.triplets ? 'active' : ''}"
            ${help('Triplet Mode', 'Switch grid subdivisions to 3 equal parts per beat (e.g. 1/8T or 1/16T). Words scale to 1/3 beat width.')}>
            ${decState.triplets ? 'Triplets: ON' : 'Triplets: OFF'}
          </button>
        </div>

        <div class="decbars-tool-group">
          <label for="decSubdiv">Grid</label>
          <select id="decSubdiv" ${help('Grid Subdivision', 'Magnetic snap and ruler resolution.')}>
            <option value="1" ${decState.subdivision === 1 ? 'selected' : ''}>1/4 note (beat)</option>
            <option value="2" ${decState.subdivision === 2 ? 'selected' : ''}>1/8 note (step)</option>
            <option value="4" ${decState.subdivision === 4 ? 'selected' : ''}>1/16 note</option>
          </select>
        </div>

        <div class="decbars-tool-group">
          <label for="decAutoFlow">Auto-Flow</label>
          <select id="decAutoFlow" ${help('Auto-Flow Density', 'Spacing when spreading chopped words onto the timeline grid.')}>
            <option value="2_per_step" ${decState.autoFlowMode === '2_per_step' ? 'selected' : ''}>2 words / beat (1/8 notes)</option>
            <option value="1_per_step" ${decState.autoFlowMode === '1_per_step' ? 'selected' : ''}>1 word / beat (1/4 notes)</option>
            <option value="triplet_3" ${decState.autoFlowMode === 'triplet_3' ? 'selected' : ''}>3 words / beat (Triplets)</option>
            <option value="4_per_step" ${decState.autoFlowMode === '4_per_step' ? 'selected' : ''}>4 words / beat (1/16 notes)</option>
          </select>
          <button id="decBtnAutoFlow" class="decbars-btn" ${help('Apply Auto-Flow', 'Place all palette words onto the sequencer track at the chosen density.')}>▶ Auto-Flow</button>
        </div>

        <div class="decbars-tool-group" style="margin-left: auto;">
          <button id="decBtnPlay" class="decbars-btn primary" ${help('Play / Pause', 'Play or pause the step sequencer and backing track using the Web Audio API.')}>▶ Play</button>
          <button id="decBtnClear" class="decbars-btn" ${help('Clear Track', 'Remove all word blocks from the sequencer track.')}>✕ Clear</button>
          <button id="decBtnExportGear" class="decbars-btn" aria-label="Audio Export Settings" ${help('Export Settings', 'Configure sample rate, channels, bit depth or bitrate for export.')}>⚙</button>
          <button id="decBtnExport" class="decbars-btn primary" ${help('Export Mix', 'Mix backing track with placed words into a final FLAC/WAV/MP3 file using FFmpeg.')}>Export</button>
        </div>
      </div>

      <!-- Main Layout -->
      <div class="decbars-main">
        <!-- Sidebar -->
        <div class="decbars-sidebar">
          <div class="decbars-card-title">Lyrics & Chopper</div>
          <textarea id="decLyricsText" class="decbars-lyrics-area" placeholder="Enter robot bars here (e.g. Stephen Hawking on the mic)..."
            ${help('Lyrics Text', 'Enter words to synthesize and chop into movable sequencer blocks.')}>stephen hawking robotic bars locked into the pocket drop the beat</textarea>

          <div style="display: flex; gap: 6px;">
            <button id="decBtnChop" class="decbars-btn primary" style="flex: 1;"
              ${help('Chop Words', 'Synthesize lyrics with espeak-ng, trim silence, and populate the word palette.')}>✂ Chop Words</button>
          </div>

          <div class="decbars-card-title" style="margin-top: 10px;">Word Palette (Drag / Click to place)</div>
          <div id="decWordPalette" class="decbars-word-palette" ${help('Word Palette', 'Available chopped word tokens. Click or drag to add to timeline.')}>
            <span style="color: #72767d; font-size: 11px;">Click 'Chop Words' above to generate word tokens.</span>
          </div>

          <div class="decbars-card-title" style="margin-top: 10px;">Voice Settings</div>
          <div style="display: flex; flex-direction: column; gap: 6px; font-size: 11px;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <span>Synthesizer:</span>
              <select id="decVoiceSelect" style="width: 140px;" ${help('Synthesizer Voice', 'Select speech synthesizer engine: DECtalk Perfect Paul (Stephen Hawking) or eSpeak.')}>
                <option value="dectalk" ${decState.voice === 'dectalk' ? 'selected' : ''}>DECtalk (Perfect Paul)</option>
                <option value="en" ${decState.voice === 'en' ? 'selected' : ''}>eSpeak-ng (US)</option>
              </select>
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <span>Speed (WPM):</span>
              <input type="number" id="decVoiceSpeed" style="width: 60px;" value="${decState.speed}" min="80" max="300"
                ${help('Voice Speed', 'Speech speed in words per minute (espeak-ng -s / dectalk -r).')}>
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <span>Pitch:</span>
              <input type="number" id="decVoicePitch" style="width: 60px;" value="${decState.pitch}" min="0" max="99"
                ${help('Voice Pitch', 'Speech pitch level (espeak-ng -p).')}>
            </div>
          </div>
        </div>

        <!-- Sequencer Timeline -->
        <div class="decbars-sequencer-wrap">
          <div id="decSeqScroll" class="decbars-sequencer-scroll">
            <div id="decTimelineContainer" class="decbars-timeline-canvas-container">
              <!-- Ruler -->
              <div id="decRuler" class="decbars-ruler"></div>

              <!-- Playhead -->
              <div id="decPlayhead" class="decbars-playhead" style="left: 0px;"></div>

              <!-- Tracks -->
              <div class="decbars-tracks">
                <!-- Backing Track Lane -->
                <div class="decbars-track-lane backing-lane" id="decBackingLane">
                  <span class="decbars-lane-label">Backing Beat</span>
                  <div id="decBackingWave" style="position: absolute; left: 0; top: 0; height: 100%; pointer-events: none;"></div>
                </div>

                <!-- Vocal Lane 1 -->
                <div class="decbars-track-lane" id="decVocalLane1" style="height: 80px;">
                  <span class="decbars-lane-label">Vocal Track 1</span>
                  <div id="decBlocksContainer" style="position: absolute; left: 0; top: 0; width: 100%; height: 100%;"></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Status Bar -->
      <div class="decbars-status-bar">
        <span id="decStatusMsg" class="decbars-status-text">Ready.</span>
        <span id="decPosDisplay" style="font-family: monospace; color: #5865f2;">1.1.0 (0.00s)</span>
      </div>
    </div>
  `;

  bindDecbarsEvents(host);
  updateTimelineGeometry();
  renderPalette();
  renderPlacedBlocks();
}

function bindDecbarsEvents(host) {
  const find = (id) => host.querySelector('#' + id);

  // BPM change
  find('decBpm').onchange = (e) => {
    decState.bpm = Math.max(30, Math.min(300, parseFloat(e.target.value) || 120));
    updateTimelineGeometry();
  };

  // Triplet Toggle
  find('decBtnTriplets').onclick = () => {
    decState.triplets = !decState.triplets;
    const btn = find('decBtnTriplets');
    btn.textContent = decState.triplets ? 'Triplets: ON' : 'Triplets: OFF';
    btn.classList.toggle('active', decState.triplets);
    updateTimelineGeometry();
    renderPlacedBlocks();
  };

  // Subdivision
  find('decSubdiv').onchange = (e) => {
    decState.subdivision = parseInt(e.target.value, 10);
    updateTimelineGeometry();
  };

  // Auto-flow selector
  find('decAutoFlow').onchange = (e) => {
    decState.autoFlowMode = e.target.value;
  };

  // Auto-flow button
  find('decBtnAutoFlow').onclick = () => {
    applyAutoFlow();
  };

  // Voice selector
  find('decVoiceSelect').onchange = (e) => {
    decState.voice = e.target.value;
  };

  // Chop words
  find('decBtnChop').onclick = async () => {
    const text = find('decLyricsText').value.trim();
    if (!text) return;
    const status = find('decStatusMsg');
    status.textContent = `Synthesizing words with ${decState.voice === 'dectalk' ? 'DECtalk' : 'espeak-ng'}…`;
    try {
      const speed = parseInt(find('decVoiceSpeed').value, 10) || 160;
      const pitch = parseInt(find('decVoicePitch').value, 10) || 50;
      decState.speed = speed;
      decState.pitch = pitch;

      const res = await fetch('/api/decbars/synthesize-words', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice: decState.voice, speed, pitch }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Failed to synthesize');
      decState.words = data.words || [];
      renderPalette();
      status.textContent = `Chapped ${decState.words.length} words.`;
    } catch (err) {
      status.textContent = 'Error: ' + err.message;
    }
  };

  // Beat Path input change
  const beatInput = find('decBeatPath');
  if (beatInput) {
    beatInput.onchange = (e) => {
      decState.backingTrackPath = e.target.value.trim();
    };
  }

  // Browse beat
  const btnBrowse = find('decBtnBrowseBeat');
  if (btnBrowse) {
    btnBrowse.onclick = () => {
      if (typeof window.openFileBrowser === 'function') {
        window.openFileBrowser('decBeatPath', false, 'files', 'audio');
      }
    };
  }

  // From global
  const btnFromGlobal = find('decBtnFromGlobal');
  if (btnFromGlobal) {
    btnFromGlobal.onclick = () => {
      let got = '';
      try { got = (bestInput('decBeatPath') || '').trim(); } catch (_) { got = ''; }
      if (!got) {
        const gi = window.globalInputs || {};
        got = (gi.audio || gi.video || gi.pathIn || '').split('\n').map((l) => l.trim()).filter(Boolean)[0] || '';
      }
      if (got) {
        decState.backingTrackPath = got;
        if (beatInput) beatInput.value = got;
        const status = find('decStatusMsg');
        if (status) status.textContent = 'Loaded beat from global: ' + got;
      } else {
        alert('Global Media In is empty. Enter an audio/video path in the top bar or use Browse.');
      }
    };
  }

  // Analyze beat
  find('decBtnAnalyze').onclick = async () => {
    const path = find('decBeatPath').value.trim();
    if (!path) {
      alert('Please enter an absolute backing track path');
      return;
    }
    decState.backingTrackPath = path;
    const status = find('decStatusMsg');
    status.textContent = 'Analyzing backing track beat with Essentia…';
    try {
      const res = await fetch('/api/decbars/analyze-beat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio_path: path }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Analysis failed');
      if (data.bpm) {
        decState.bpm = data.bpm;
        find('decBpm').value = data.bpm;
      }
      if (data.duration) {
        decState.backingDuration = data.duration;
        const totalBeats = Math.ceil((data.duration / 60) * decState.bpm);
        decState.totalBeats = Math.max(32, totalBeats + 4);
      }
      status.textContent = `Detected ${data.bpm} BPM (Duration: ${data.duration}s)`;
      updateTimelineGeometry();
    } catch (err) {
      status.textContent = 'Error: ' + err.message;
    }
  };

  // Play / Pause
  find('decBtnPlay').onclick = () => {
    if (decState.isPlaying) {
      stopPlayback();
    } else {
      startPlayback();
    }
  };

  // Clear track
  find('decBtnClear').onclick = () => {
    decState.placedWords = [];
    renderPlacedBlocks();
  };

  // Export Gear Dialog
  find('decBtnExportGear').onclick = () => {
    const capabilities = {
      flac: { label: 'FLAC', compression: [0, 12], sample_bits: [16, 24] },
      wav: { label: 'WAV', sample_bits: [16, 24, 32] },
      mp3: { label: 'MP3', bitrates: [64, 128, 192, 256, 320] },
    };
    openAudioExportDialog(decState.format, capabilities, decState.settings[decState.format] || {}, (updated) => {
      decState.settings[decState.format] = updated;
    });
  };

  // Export Mix
  find('decBtnExport').onclick = async () => {
    if (!decState.backingTrackPath) {
      alert('Please specify a backing beat path first.');
      return;
    }
    const status = find('decStatusMsg');
    status.textContent = 'Rendering mix with FFmpeg…';
    try {
      const beatSec = 60.0 / decState.bpm;
      const wordPayload = decState.placedWords.map((pw) => ({
        id: pw.id,
        path: pw.path,
        time_sec: pw.beatOffset * beatSec,
        gain_db: pw.gainDb || 0.0,
      }));

      const res = await fetch('/api/decbars/render-mix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          beat_path: decState.backingTrackPath,
          words: wordPayload,
          format: decState.format,
          settings: decState.settings[decState.format] || {},
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Mix render failed');
      status.textContent = `Mix saved to: ${data.output}`;
    } catch (err) {
      status.textContent = 'Export error: ' + err.message;
    }
  };
}

function updateTimelineGeometry() {
  const container = document.getElementById('decTimelineContainer');
  const ruler = document.getElementById('decRuler');
  if (!container || !ruler) return;

  const pxPerBeat = decState.baseBeatPx * decState.zoom;
  const totalPx = decState.totalBeats * pxPerBeat;
  container.style.width = `${totalPx}px`;

  // Draw ruler marks
  ruler.innerHTML = '';
  const beatsPerBar = 4;
  for (let b = 0; b < decState.totalBeats; b++) {
    const isBar = b % beatsPerBar === 0;
    const barNum = Math.floor(b / beatsPerBar) + 1;
    const beatInBar = (b % beatsPerBar) + 1;

    const mark = document.createElement('div');
    mark.className = isBar ? 'decbars-ruler-bar' : 'decbars-ruler-beat';
    mark.style.left = `${b * pxPerBeat}px`;
    if (isBar) {
      mark.textContent = `${barNum}.1`;
    }
    ruler.appendChild(mark);

    // Subdivisions
    const subDivs = decState.triplets ? 3 : decState.subdivision;
    if (subDivs > 1) {
      for (let s = 1; s < subDivs; s++) {
        const subMark = document.createElement('div');
        subMark.className = 'decbars-ruler-sub';
        subMark.style.left = `${b * pxPerBeat + (s / subDivs) * pxPerBeat}px`;
        ruler.appendChild(subMark);
      }
    }
  }
}

function renderPalette() {
  const pal = document.getElementById('decWordPalette');
  if (!pal) return;
  pal.innerHTML = '';
  if (!decState.words.length) {
    pal.innerHTML = '<span style="color: #72767d; font-size: 11px;">Click "Chop Words" above to generate word tokens.</span>';
    return;
  }

  decState.words.forEach((w, idx) => {
    const chip = document.createElement('div');
    chip.className = 'decbars-palette-chip';
    chip.innerHTML = `<span>${esc(w.word)}</span><span style="font-size: 9px; opacity: 0.75;">${w.duration}s</span>`;
    chip.setAttribute('data-help-title', `Word: ${w.word}`);
    chip.setAttribute('data-help-text', `Click to append to timeline at next beat, or double-click to audition.`);

    chip.onclick = () => {
      // Append word to next open beat
      const lastBeat = decState.placedWords.length
        ? decState.placedWords[decState.placedWords.length - 1].beatOffset + (decState.triplets ? 1 / 3 : 1 / decState.subdivision)
        : 0;
      decState.placedWords.push({
        id: `${w.id}_${Date.now()}_${idx}`,
        word: w.word,
        url: w.url,
        duration: w.duration,
        path: w.path,
        beatOffset: lastBeat,
        gainDb: 0,
      });
      renderPlacedBlocks();
    };

    chip.ondblclick = (e) => {
      e.stopPropagation();
      playSingleSample(w.url);
    };

    pal.appendChild(chip);
  });
}

function renderPlacedBlocks() {
  const container = document.getElementById('decBlocksContainer');
  if (!container) return;
  container.innerHTML = '';

  const pxPerBeat = decState.baseBeatPx * decState.zoom;
  const beatSec = 60.0 / decState.bpm;

  decState.placedWords.forEach((pw, idx) => {
    const block = document.createElement('div');
    block.className = 'decbars-word-block';

    const leftPx = pw.beatOffset * pxPerBeat;
    // Spatially linear representation:
    // Slot width corresponds strictly to its metric duration
    let stepBeats = 1 / decState.subdivision;
    if (decState.triplets) {
      stepBeats = 1 / 3;
    }
    const widthPx = Math.max(24, stepBeats * pxPerBeat - 4);

    block.style.left = `${leftPx}px`;
    block.style.width = `${widthPx}px`;

    block.innerHTML = `
      <div class="decbars-word-title">${esc(pw.word)}</div>
      <div class="decbars-word-meta">
        <span>${pw.beatOffset.toFixed(2)}b</span>
        <span class="dec-del-btn" style="cursor: pointer; color: #fca5a5;">✕</span>
      </div>
    `;

    block.querySelector('.dec-del-btn').onclick = (e) => {
      e.stopPropagation();
      decState.placedWords.splice(idx, 1);
      renderPlacedBlocks();
    };

    // Audition on click
    block.onclick = () => {
      playSingleSample(pw.url);
    };

    container.appendChild(block);
  });
}

function applyAutoFlow() {
  if (!decState.words.length) return;
  decState.placedWords = [];

  let stepDelta = 0.5; // 2 per beat (1/8 notes)
  if (decState.autoFlowMode === '1_per_step') {
    stepDelta = 1.0;
  } else if (decState.autoFlowMode === 'triplet_3') {
    stepDelta = 1 / 3;
  } else if (decState.autoFlowMode === '4_per_step') {
    stepDelta = 0.25;
  }

  decState.words.forEach((w, idx) => {
    decState.placedWords.push({
      id: `${w.id}_flow_${idx}`,
      word: w.word,
      url: w.url,
      duration: w.duration,
      path: w.path,
      beatOffset: idx * stepDelta,
      gainDb: 0,
    });
  });

  renderPlacedBlocks();
}

async function playSingleSample(url) {
  const ctx = getAudioContext();
  if (!ctx) return;
  const buf = await loadBuffer(url);
  if (!buf) return;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
}

async function startPlayback() {
  const ctx = getAudioContext();
  if (!ctx) return;
  decState.isPlaying = true;
  document.getElementById('decBtnPlay').textContent = '⏹ Stop';

  const beatSec = 60.0 / decState.bpm;
  playStartTime = ctx.currentTime;
  playStartOffset = decState.playheadBeat * beatSec;

  // Schedule words
  for (const pw of decState.placedWords) {
    const wordStartSec = pw.beatOffset * beatSec;
    if (wordStartSec >= playStartOffset) {
      loadBuffer(pw.url).then((buf) => {
        if (!decState.isPlaying || !buf) return;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const gainNode = ctx.createGain();
        gainNode.connect(ctx.destination);
        src.connect(gainNode);
        const schedTime = playStartTime + (wordStartSec - playStartOffset);
        src.start(schedTime);
        activeSources.push(src);
      });
    }
  }

  // Animation loop for playhead
  function tick() {
    if (!decState.isPlaying) return;
    const elapsedSec = ctx.currentTime - playStartTime + playStartOffset;
    const currentBeat = elapsedSec / beatSec;
    decState.playheadBeat = currentBeat;

    const pxPerBeat = decState.baseBeatPx * decState.zoom;
    const playhead = document.getElementById('decPlayhead');
    const posDisp = document.getElementById('decPosDisplay');
    if (playhead) {
      playhead.style.left = `${currentBeat * pxPerBeat}px`;
    }
    if (posDisp) {
      const bar = Math.floor(currentBeat / 4) + 1;
      const bInBar = Math.floor(currentBeat % 4) + 1;
      posDisp.textContent = `${bar}.${bInBar} (${elapsedSec.toFixed(2)}s)`;
    }

    if (currentBeat >= decState.totalBeats) {
      stopPlayback();
      return;
    }
    animFrameId = requestAnimationFrame(tick);
  }
  animFrameId = requestAnimationFrame(tick);
}

function stopPlayback() {
  decState.isPlaying = false;
  if (animFrameId) cancelAnimationFrame(animFrameId);
  activeSources.forEach((s) => {
    try { s.stop(); } catch (_) {}
  });
  activeSources = [];
  const playBtn = document.getElementById('decBtnPlay');
  if (playBtn) playBtn.textContent = '▶ Play';
  decState.playheadBeat = 0;
  const playhead = document.getElementById('decPlayhead');
  if (playhead) playhead.style.left = '0px';
}
