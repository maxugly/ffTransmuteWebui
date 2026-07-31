# Audio Analysis & MIDI Generation Pipeline — Spec

> **Status:** Proposed  
> **Audience:** Builder agents (codewhale, codex)  
> **Related:** Previous key/tempo detection implementations

---

## 1. Purpose

Implement an advanced, lightweight audio analysis pipeline that extracts Transients (onsets), BPM, Key, and generates a polyphonic MIDI file from audio/video inputs. This metadata will be sent back to the WebUI to map to video effects.

We are avoiding heavy deep-learning models for basic DSP tasks and utilizing highly optimized libraries (C/C++ bound to Python) for real-time performance. For Audio-to-MIDI, we use Spotify's Basic Pitch.

---

## 2. Core Technologies

### 2.1 Audio-to-MIDI: Spotify Basic Pitch
- **Description:** A lightweight neural network specifically engineered by Spotify's Audio Intelligence Lab.
- **Capabilities:** Generates highly accurate MIDI files, supports polyphony (multiple notes at once), and captures pitch bends.
- **Hardware Fit:** Very small footprint. Can run the standard Python version on a CPU (e.g., i5) without issue.
- **OpenVINO Optimization (Optional):** The model can be exported to ONNX. By installing `onnxruntime-openvino`, inference can be forced onto an Iris Xe GPU, freeing the CPU for video rendering.

### 2.2 Transient, BPM, and Key Detection
Avoid deep learning for these; standard DSP libraries provide real-time speed with zero overhead.

- **Aubio:** C library with Python bindings. Extremely fast. Handles onset (transient) detection, pitch tracking, and tempo/beat tracking.
- **Essentia:** C++ library with Python bindings. Optimized for low computational cost. Excellent for high-level musical feature extraction (key/scale estimation, SuperFlux onset detection, rhythmic analysis).
- **Madmom:** Extremely lightweight Recurrent Neural Networks (RNNs) for the absolute most accurate beat and downbeat tracking. Runs instantly on CPU.

---

## 3. Architecture & Integration Workflow

When a video or audio file is processed by the server:

1. **Extract Audio:** Use FFmpeg to extract a temporary `.wav` file.
2. **Run Detectors in Parallel:**
   - Pass the `.wav` to **Aubio** to get a list of transient timestamps (in seconds).
   - Pass the `.wav` to **Essentia** to extract BPM and Key.
   - Pass the `.wav` to **Basic Pitch** to generate the `.mid` file.
3. **Return JSON Response:** Package the timestamps, BPM, Key, and the path to the generated MIDI file into a JSON response for the frontend.

---

## 4. Implementation Reference

### 4.1 Dependencies

Install the required packages via pip:
```bash
pip install basic-pitch aubio essentia madmom
```

### 4.2 Python Integration Logic

Here is the baseline logic using `basic-pitch` and `aubio`:

```python
import json
from basic_pitch.inference import predict_and_save
from aubio import source, onset

def process_audio_track(file_path, output_midi_path):
    # 1. Generate MIDI using Basic Pitch
    predict_and_save(
        audio_path_list=[file_path],
        output_directory=output_midi_path,
        save_midi=True,
        sonify_midi=False,
        save_model_outputs=False,
        save_notes=False
    )
    
    # 2. Detect Transients using Aubio
    win_s = 512         # Window size
    hop_s = win_s // 2  # Hop size
    s = source(file_path, 0, hop_s)
    samplerate = s.samplerate
    
    o = onset("default", win_s, hop_s, samplerate)
    transients = []
    
    while True:
        samples, read = s()
        if o(samples):
            transients.append(o.get_last_s())
        if read < hop_s:
            break
            
    # 3. Return structured data to the WebUI frontend
    return json.dumps({
        "midi_file": f"{output_midi_path}/output.mid",
        "transients": transients,
        "total_transients": len(transients)
    })
```

*(Note: Expand the above snippet to include Essentia/Madmom for BPM and Key extraction as needed).*

---

## 5. Agent Instructions

1. **Setup:** Ensure `basic-pitch`, `aubio`, `essentia`, and `madmom` are installed in the `mtapi-project` virtual environment. Add them to `requirements.txt`.
2. **Backend Route:** Create a unified endpoint (e.g., `POST /ops/audio-analyze`) that handles the `process_audio_track` logic.
3. **Frontend Integration:** Hook this JSON metadata into the WebUI so that other video processing tabs can utilize the BPM, Key, and transient timestamps to drive visual effects.
4. **Validation:** Test with a sample audio file to ensure the generated MIDI is valid and transient timestamps accurately reflect the audio onsets without crashing or blocking the server.
