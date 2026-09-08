# Audio Stretching Engine Spec

## 1. Goal
Currently, time-stretching audio in the app (via operations like Speed Change and Speed Ramp) is locked to FFmpeg's `atempo` filter. While fast, standard phase vocoders often smear transients (ruining drums/hip-hop) and struggle with extreme speech stretching. 

This spec outlines the addition of an **Engine Selector** in the GUI that swaps out the core algorithm to better suit different types of audio, leveraging native Python libraries.

## 2. Proposed Engines
Based on the requirements, we will implement three engines under a unified wrapper:
- **`ffmpeg` (Default / Legacy):** Standard `atempo` phase vocoder. Fast, good for general purpose.
- **`signalsmith` (via `python-stretch`):** Best for preserving sharp transients without smearing. Ideal for Drums and Hip Hop.
- **`rubberband` (via `pyrubberband`):** Best for Speech and general polyphonic music. Smooth handling of formants and silence.

*(Note: `audiostretchy` was evaluated but skipped in favor of `pyrubberband` to keep the API purely in-memory/NumPy-based, minimizing file I/O overhead).*

---

## 3. Architecture & Backend Updates

### 3.1 Unified Wrapper Module
We will create a new Python module (`app/audio/stretch.py`) to house the array-processing logic. Since both target libraries process NumPy arrays, they share a very clean unified interface.

```python
import numpy as np
import soundfile as sf
import pyrubberband as pyrb
import shutil
# Note: Verify exact import name for python-stretch on PyPI (e.g., `import signalsmith.stretch`)
import python_stretch as ps

def stretch_audio_file(input_wav: str, output_wav: str, rate: float, engine: str = "rubberband", profile: str = "standard"):
    # Load audio into memory
    data, samplerate = sf.read(input_wav)
    
    # Ensure 2D array format (samples, channels)
    if data.ndim == 1:
        data = data[:, np.newaxis]

    if engine == "rubberband":
        if not shutil.which("rubberband"):
            raise RuntimeError("rubberband-cli is not installed on the system. Please install it (e.g., apt-get install rubberband-cli).")
        # pyrubberband natively expects (samples, channels)
        # Apply profile specific CLI arguments
        rbargs = {}
        if profile == "formant":
            rbargs["-F"] = "" # Formant preserving
        elif profile == "smooth":
            rbargs["-p"] = "none" # Example: prioritize phase
            
        stretched = pyrb.time_stretch(data, samplerate, rate, rbargs=rbargs)
    
    elif engine == "signalsmith":
        stretch_obj = ps.Signalsmith.Stretch()
        # python-stretch expects (channels, samples)
        stretch_obj.preset(data.shape[1], samplerate)
        stretch_obj.timeFactor = rate
        stretched = stretch_obj.process(data.T).T 
        
    else:
        raise ValueError(f"Unknown engine: {engine}")

    # Write back to disk
    sf.write(output_wav, stretched, samplerate)
```

### 3.2 Operation Updates (`speedchange_ops.py`)
Currently, speed operations do audio and video in a single FFmpeg pass via complex filtergraphs (e.g., `-filter_complex "[0:v]setpts...[v];[0:a]atempo...[a]"`).

We need to decouple this when a custom engine is requested. *(Note: `speedramp_ops.py` currently drops audio entirely, so this phase applies exclusively to `speedchange_ops.py`)*.

**Update Params Model:**
```python
audio_engine: Literal["ffmpeg", "rubberband", "signalsmith"] = Field(
    "ffmpeg", 
    description="Algorithm for time-stretching when audio_mode=preserve"
)
audio_profile: Literal["standard", "smooth", "formant"] = Field(
    "standard",
    description="Engine-specific processing profile (primarily for Rubberband)"
)
```

**Update Execution Logic (`async def speedchange(...)`):**
- **If `audio_mode == "preserve"` AND `audio_engine != "ffmpeg"`**:
  1. **Extract**: `ffmpeg -i input.mp4 -vn -c:a pcm_s16le temp_audio.wav`
  2. **Process**: Run `stretch_audio_file(temp_audio.wav, stretched_audio.wav, speed, p.audio_engine, p.audio_profile)`
  3. **Register Variant**: We don't throw this processed audio away. Instead, register it as a variant of the original video clip using the new variant registry: `from ..media.cache import register_variant` and then `await register_variant(p.input_path, kind="stretched_audio", variant_path=stretched_audio.wav, detail={"engine": p.audio_engine, "profile": p.audio_profile, "speed": speed})`. This allows us to reuse it later, compare engines, and avoid re-processing.
  4. **Mux**: Run the standard video `setpts` FFmpeg command, but remove the `atempo` graph. Instead, supply the processed audio variant: `-i stretched_audio.wav -map 0:v -map 1:a -c:a aac`.
- **If `audio_engine == "ffmpeg"`**: 
  - Execute the existing `_build_atempo_chain` logic (zero regression).

---

## 4. Frontend Updates
**Locations**: `app/static/js/tabs/speedchange.js` (and applicable speed tabs).

1. **New UI Element 1 (Engine)**: Add a dropdown `<select id="audioEngine">` directly below the "Audio Mode" dropdown. 
2. **New UI Element 2 (Profile)**: Add a secondary dropdown `<select id="audioProfile">` below the engine selector.
3. **Conditional Visibility**: 
   - `audioEngine` should *only* be visible/enabled when Audio Mode is set to `preserve`.
   - `audioProfile` should *only* be visible when the selected Engine is `rubberband`.
4. **Dropdown Options (Engine)**:
   - `FFmpeg (Standard)`
   - `Signalsmith (Punchy / Hip-Hop)`
   - `Rubberband (Smooth / Speech)`
5. **Dropdown Options (Profile)**:
   - `Crisp / Standard (Default)` -> "standard"
   - `Smooth (Music/Chords)` -> "smooth"
   - `Formant Preserving (Vocals)` -> "formant"
6. **Payload**: Pass the selected values as `audio_engine` and `audio_profile` in the `POST /ops/speedchange` body.

---

## 5. Dependencies & Environment
- **Python Packages**: Add `pyrubberband`, `python-stretch`, and `soundfile` to the virtual environment requirements.
- **System Binary**: `pyrubberband` is a Python wrapper that requires the `rubberband-cli` system binary. The deployment environment / Dockerfile must be updated to install it (e.g., `apt-get install rubberband-cli`).
