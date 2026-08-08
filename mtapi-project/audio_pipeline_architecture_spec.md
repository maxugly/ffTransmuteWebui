# Audio Processing Pipeline Architecture Spec

> **Target Hardware:** Intel Core i5-1335U (10 cores, 12 threads) + Intel Iris Xe Graphics
> **Constraint:** Maximum compatibility, OpenVINO iGPU acceleration with robust CPU fallback, strict memory management.
> **Note on Sequencing:** This is a Phase 2 overarching pipeline specification. The standalone audio stretching engine (`audio_stretch_engine_spec.md`) should be implemented first as a Phase 1 increment. This Phase 2 pipeline will integrate the stretch engine into its chunked `AudioProcessor` later.

---

## 1. Required Packages & Environment

Add the following to your `requirements.txt`:

```text
# Inference & AI
openvino>=2024.0.0            # Unpinned or match existing img2img/txt2img OpenVINO version
torch torchvision torchaudio  # PyTorch backend required for model loading
demucs                        # Stem separation
audiosr                       # Audio super-resolution

# DSP & Stretching
python-stretch                # Signalsmith C++ wrapper
pyrubberband                  # Rubberband wrapper (requires rubberband-cli system binary)

# Data Handling
numpy                         # For Hann window overlap-add crossfading
soundfile
```

---

## 2. OpenVINO Conversion Commands

To run PyTorch/ONNX models via OpenVINO on the Iris Xe iGPU, they must be converted to the OpenVINO Intermediate Representation (IR) format.

**Demucs (HT-Demucs):**
Demucs natively exports to ONNX via its internal tools.
```bash
# 1. Export Demucs to ONNX (using demucs CLI)
python3 -m demucs.export htdemucs --format onnx -o ./models/demucs_onnx/

# 2. Convert ONNX to OpenVINO IR (FP16 for iGPU memory savings)
ovc ./models/demucs_onnx/htdemucs.onnx --compress_to_fp16 True --output_model ./models/ov_demucs/htdemucs.xml
```

**AudioSR (Latent Diffusion):**
AudioSR is composed of a VAE, an Encoder, and a UNet. Each must be traced to ONNX/IR.
```bash
# Assuming you have the PyTorch models downloaded locally
# Convert via OpenVINO Model Optimizer (ovc) targeting FP16
ovc ./models/audiosr/unet.onnx --compress_to_fp16 True --output_model ./models/ov_audiosr/unet.xml
ovc ./models/audiosr/vae.onnx --compress_to_fp16 True --output_model ./models/ov_audiosr/vae.xml
```

---

## 3. DeviceManager Logic (GPU/CPU Fallback)

This class handles OpenVINO core initialization, enforces the CPU thread limits (P-cores only to avoid thermal throttling), and gracefully degrades from Iris Xe to CPU if VRAM limits are hit.

```python
import openvino as ov
import logging

class DeviceManager:
    def __init__(self, max_ram_gb=12):
        self.core = ov.Core()
        self.available_devices = self.core.available_devices
        self.max_ram_gb = max_ram_gb
        self.logger = logging.getLogger("DeviceManager")
        
        self._configure_cpu()

    def _configure_cpu(self):
        # i5-1335U has 2 P-Cores (4 threads) and 8 E-Cores. 
        # Restrict threads to avoid thermal throttling during overnight processing.
        self.core.set_property("CPU", {
            "INFERENCE_NUM_THREADS": 6, 
            "ENFORCE_BF16": "YES" # Use BF16/VNNI instructions if available
        })

    def get_optimal_device(self, model_name: str, estimated_vram_gb: float) -> str:
        """Determines best device for the specific model."""
        has_gpu = any("GPU" in dev for dev in self.available_devices)
        
        if has_gpu and estimated_vram_gb <= (self.max_ram_gb * 0.8):
            self.logger.info(f"Targeting Intel Iris Xe (GPU) for {model_name}")
            return "GPU"
        
        self.logger.warning(f"Falling back to CPU for {model_name} (VRAM constraint/Unsupported)")
        return "CPU"

    def load_model(self, model_path: str, estimated_vram_gb: float):
        device = self.get_optimal_device(model_path, estimated_vram_gb)
        
        # Load model definition
        model = self.core.read_model(model=model_path)
        
        # Compile for specific hardware device
        config = {}
        if device == "GPU":
            config["PERFORMANCE_HINT"] = "LATENCY"
            # Optional: config["GPU_THROTTLE"] = "1" to manage chassis thermals
        else:
            config["PERFORMANCE_HINT"] = "THROUGHPUT"
            
        try:
            compiled_model = self.core.compile_model(model, device_name=device, config=config)
            return compiled_model
        except Exception as e:
            self.logger.error(f"Failed to compile for {device}, forcing CPU. Error: {e}")
            return self.core.compile_model(model, device_name="CPU", config={"PERFORMANCE_HINT": "THROUGHPUT"})
```

---

## 4. AudioProcessor & Chunking Logic

To prevent blowing out the 16GB RAM limit on the i5-1335U, audio is processed in 15-second chunks with a 2-second overlap, utilizing a Hann window crossfade to prevent clicking at the seams.

```python
import numpy as np
import gc
import soundfile as sf

class AudioProcessor:
    def __init__(self, device_manager):
        self.device_manager = device_manager
        self.chunk_duration = 15.0  # seconds
        self.overlap = 2.0          # seconds

    def process_overnight_batch(self, input_file: str, output_file: str, process_fn):
        """
        process_fn is a callback (e.g., Demucs inference, AudioSR inference)
        that takes a numpy array and returns a processed numpy array.
        """
        y, sr = sf.read(input_file)
        if y.ndim == 1:
            y = y[:, np.newaxis]

        chunk_samples = int(self.chunk_duration * sr)
        overlap_samples = int(self.overlap * sr)
        step = chunk_samples - overlap_samples

        total_samples = y.shape[0]
        output = np.zeros_like(y)
        
        # Crossfade window (Hann)
        window = np.hanning(overlap_samples * 2)[overlap_samples:]
        window = window[:, np.newaxis]

        for start_idx in range(0, total_samples, step):
            end_idx = min(start_idx + chunk_samples, total_samples)
            chunk = y[start_idx:end_idx]

            # --- INFERENCE EXECUTION ---
            # Model inference (Demucs, AudioSR, etc) via OpenVINO
            processed_chunk = process_fn(chunk, sr)

            # --- OVERLAP ADD / CROSSFADE ---
            if start_idx == 0:
                # First chunk goes straight in
                output[start_idx:end_idx] = processed_chunk
            else:
                # Fade out the tail of the existing buffer
                tail_start = start_idx
                tail_end = start_idx + overlap_samples
                actual_overlap = min(overlap_samples, output.shape[0] - tail_start)
                
                output[tail_start:tail_start+actual_overlap] *= (1.0 - window[:actual_overlap])
                
                # Fade in the head of the new chunk
                fade_in = processed_chunk[:actual_overlap] * window[:actual_overlap]
                output[tail_start:tail_start+actual_overlap] += fade_in
                
                # Copy the rest of the chunk
                rem_start = start_idx + actual_overlap
                output[rem_start:end_idx] = processed_chunk[actual_overlap:]

            # --- GARBAGE COLLECTION ---
            # Aggressively clear memory between chunks to protect 16GB limit
            del chunk, processed_chunk
            gc.collect()

        sf.write(output_file, output, sr)
        return output_file
```
