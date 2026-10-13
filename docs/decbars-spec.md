# DECbars — Robotic Rap Step Sequencer Spec

> **Status:** Spec — ready for implementation.  
> **Scope:** One new tab (`decbars`), a spatially linear time-accurate step sequencer with triplet support, an `espeak-ng` word synthesizer & slicer, beat analysis integration, and Web Audio / FFmpeg mixdown.  
> **System Invariants:** No frontend frameworks (Invariant 7), pure vanilla ES6 + Web Audio API, subprocesses via `shell.run_command` with argv lists (Invariant 2), failures HTTP 200 + `{"ok": false}` (Invariant 10), absolute paths (Invariant 3), throwaways in `mtapi-project/junk/decbars/` (Invariant 8), no native `title=` tooltips (house HelpStrip law).

---

## 1. What DECbars Is

DECbars is a robotic rap production workbench and time-proportional step sequencer designed to lock synthesized speech into the musical pocket of any backing track:

1. **Backing Track & Tempo Analysis**:
   - Load an instrumental or beat (from file path, upload, or Media Pool).
   - Automatically detect BPM, beat grid, and onsets using the repo's existing Essentia / madmom audio analysis stack, with manual tap-tempo and BPM override.
2. **Speech Synthesis & Word Slicing**:
   - Text input for lyrics/bars.
   - Uses `espeak-ng` (formant-synthesizer / robotic Stephen Hawking / DECtalk cadence) as the primary zero-download local engine.
   - Synthesizes and isolates individual word/syllable audio clips with clean attack and decay envelopes.
3. **Spatially Time-Proportional Step Sequencer**:
   - **True spatial-to-time representation**: Pixel width directly reflects musical time ($\text{width} = \text{duration} \times \text{pixels\_per\_second}$). A quarter note occupies exactly half the horizontal space of a half note and double that of an eighth note.
   - **Triplet Mode Toggle**: Allows switching the active grid quantization between straight subdivisions ($1/4$, $1/8$, $1/16$, $1/32$) and triplet subdivisions ($1/4\text{T}$, $1/8\text{T}$, $1/16\text{T}$, etc.), spacing 3 equal notes in the span of 2 straight steps with exact visual proportion ($1/3$ beat width).
   - **Auto-Flow Quantization**: Automatically spreads words across the grid (e.g. default 2 words per beat/step, or 1 word per step, or straight triplets).
   - **Interactive Arrangement**: Drag, snap, reorder, nudge, mute, or stretch word blocks along the timeline.
4. **Monitoring & Mixdown**:
   - Low-latency browser playback using the Web Audio API with sample-accurate clock scheduling (`AudioContext.currentTime`).
   - Server-side high-quality mixdown and export (FLAC/WAV/MP3) using the shared FFmpeg exporter and codec gear dialog (`app/audio/export.py`).

---

## 2. Workspace & UI Layout

DECbars uses the full workspace layout (`hideRun` in `app.js`): no video preview panel, accepts global inputs (audio/video instrumental tracks via `Media In`), and expands to 100% viewport width and height without limiting scroll frames or fixed-height canvas constraints.

```
┌────────────────────────────────────────────────────────────────────────┐
│ #decbarsWorkspace (flex column, dense 1080p-first layout)              │
├────────────────────────────────────────────────────────────────────────┤
│ Top Bar: Track Loader · BPM (auto/manual) · Meter (4/4) · Swing · Grid │
│          [Auto-Flow: 2 w/step] [Triplets: ON/OFF] [Play/Pause] [Export]│
├───────────────────────┬────────────────────────────────────────────────┤
│ Left Panel (300px)    │ Center: Spatially Linear Sequencer & Timeline │
│ ┌───────────────────┐ │ ┌────────────────────────────────────────────┐ │
│ │ Lyrics Textarea   │ │ │ Ruler / Beat markers (1.1, 1.2, 1.3, 1.4)  │ │
│ │  + "Chop Words"   │ │ ├────────────────────────────────────────────┤ │
│ ├───────────────────┤ │ │ Backing Track (Waveform display / Mute/Vol)│ │
│ │ Word Palette      │ │ ├────────────────────────────────────────────┤ │
│ │ (Draggable chips) │ │ │ Vocal Track 1 (Word blocks, proportional)  │ │
│ ├───────────────────┤ │ ├────────────────────────────────────────────┤ │
│ │ Engine & Voice    │ │ │ Vocal Track 2 / Ad-lib                     │ │
│ │ (espeak-ng args)  │ │ └────────────────────────────────────────────┘ │
│ └───────────────────┘ │ Zoom / Scrollbar (70% – 200% horizontal zoom)  │
└───────────────────────┴────────────────────────────────────────────────┘
```

### 2.1 Spatially Linear Timeline Engine

In standard step sequencers (e.g. 16-step drum machines), steps are uniform boxes regardless of tempo or metric duration. In DECbars:

- **Horizontal Scale Constant**: $\text{px\_per\_beat} = \text{zoom} \times \text{base\_beat\_px}$ (default 80px per quarter note at 100% zoom).
- **Time to Coordinate**:
  $$\text{pixel\_x}(t) = t \times \left( \frac{\text{BPM}}{60} \right) \times \text{px\_per\_beat}$$
- **Duration to Width**:
  $$\text{pixel\_width}(\Delta t) = \Delta t \times \left( \frac{\text{BPM}}{60} \right) \times \text{px\_per\_beat}$$
  - Whole note (4 beats) = $4 \times \text{px\_per\_beat}$ (320px).
  - Half note (2 beats) = $2 \times \text{px\_per\_beat}$ (160px).
  - Quarter note (1 beat) = $1 \times \text{px\_per\_beat}$ (80px).
  - Eighth note ($1/2$ beat) = $0.5 \times \text{px\_per\_beat}$ (40px).
  - Sixteenth note ($1/4$ beat) = $0.25 \times \text{px\_per\_beat}$ (20px).
- **Triplet Quantization**:
  When Triplet Mode is enabled for subdivision level $N$ (e.g., $1/8\text{T}$):
  - A quarter-note beat is divided into 3 equal slots instead of 2.
  - Step width = $\frac{1}{3} \times \text{px\_per\_beat} \approx 26.66\text{px}$.
  - Grid snap lines render at $0$, $\frac{1}{3}$, and $\frac{2}{3}$ of the beat.
  - Word blocks placed in triplet mode occupy exactly $\frac{1}{3}$ beat width, preserving the strict 1:1 spatial-to-temporal equivalence.

---

## 3. Speech Synthesis & Word Chopping Engine

### 3.1 Synthesis Pipeline (`app/audio/decbars.py`)

1. **Word Generation**:
   - The user enters text: e.g. `"Robot bars locked in the pocket"`.
   - Text is parsed into clean word tokens: `["Robot", "bars", "locked", "in", "the", "pocket"]`.
   - Synthesis via `espeak-ng`:
     ```bash
     espeak-ng -s 160 -p 50 -w mtapi-project/junk/decbars/<session>/words/<idx>_<word>.wav "<word>"
     ```
   - Each word is generated with trimmed silence (using a 10ms raised-cosine fade in/out to eliminate DC clicks).
   - Returns a manifest of word tokens, durations, and sample paths.

2. **Auto-Flow Placement**:
   - Modes:
     - `2_per_step` (default): Places 2 words per beat (eighth notes).
     - `1_per_step`: Places 1 word per beat (quarter notes).
     - `4_per_step`: Places 4 words per beat (sixteenth notes).
     - `triplet_3`: Places 3 words per beat (eighth-note triplets).
   - Computes initial start offsets $t_0, t_1, \dots, t_n$.
   - Warns or applies micro-time-compression if a word's natural spoken duration exceeds its assigned slot length.

---

## 4. Server API Contract (`app/routes/decbars.py`)

All endpoints adhere strictly to **Invariant 10** (HTTP 200 + `{"ok": false, "error": "..."}` on operational failures).

| Route | Method | Payload / Params | Description |
|---|---|---|---|
| `/api/decbars/analyze-beat` | POST | `{"audio_path": str}` | Extracts BPM, downbeat times, beat markers, and duration. Reuses Essentia/madmom beat tracker. |
| `/api/decbars/synthesize-words` | POST | `{"text": str, "voice": str, "speed": int, "pitch": int}` | Synthesizes words using `espeak-ng`, returns word tokens with durations and temporary audio URLs. |
| `/api/decbars/render-mix` | POST | `{"beat_path": str, "words": [{"id": str, "url": str, "time_sec": float, "gain_db": float}], "format": str, "settings": dict, "out_path": str}` | Mixes backing track and positioned words into final audio file using FFmpeg. |

---

## 5. WebUI & Interactions (`js/tabs/decbars.js`)

1. **Bare Workspace Navigation**:
   - Registered under **Neural FX** or **Audio** as `decbars` (`DECbars`).
   - Integrates with HelpStrip: every interactive button, slider, and selector carries `data-help-title` and `data-help-text`. No native `title=` attributes.
2. **Interactive Sequencer Grid**:
   - Canvas or CSS flex-based timeline with absolute time markings.
   - Ruler bar with measure numbers (`1.1`, `1.2`, `1.3`, `1.4`, `2.1`...) and playhead cursor.
   - Word blocks:
     - Draggable with grid snapping (magnetic snap to current straight or triplet subdivision).
     - Double-click to preview word sound.
     - Right-click or delete button to remove.
     - Drag handle to adjust word volume / gain.
3. **Audio Playback Engine**:
   - Backing track loaded into an `AudioBufferSourceNode`.
   - Individual word clips cached as `AudioBuffer` objects.
   - Play/Pause triggers scheduled playback using `ctx.currentTime`:
     ```javascript
     wordBuffers.forEach(item => {
       const src = ctx.createBufferSource();
       src.buffer = item.buffer;
       src.connect(masterGain);
       src.start(startTime + item.timeOffset);
     });
     ```

---

## 6. Implementation & Verification Plan

1. **Gate Pre-flight**: Ensure `./check-gate.sh` passes 5/5.
2. **Backend Unit Tests** (`tests/test_decbars.py`):
   - Test word tokenization and `espeak-ng` execution (verifying argv safety, no shell=True).
   - Test audio mixing command generation with absolute paths.
   - Test invalid inputs and ensure HTTP 200 + `ok: false`.
3. **Browser Proof** (`junk/decbars-prove.mjs` via Playwright):
   - Launch server, navigate to DECbars tab.
   - Enter lyrics, click "Chop Words", assert generated word tokens appear in the palette.
   - Toggle Triplet mode, assert ruler and grid update proportionally.
   - Trigger playback, verify zero console errors, verify HelpStrip compliance.
