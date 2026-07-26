# System Telemetry & WebSockets (`telemetry`)

## Concept
A real-time hardware monitoring HUD for the WebUI. Because the system runs heavily optimized AI models on an integrated Intel iGPU with shared 16GB RAM, OOM (Out of Memory) crashes or aggressive swap-thrashing are the biggest risks. 

This module pushes live system resource stats to the frontend so the user can visually monitor the impact of their AI pipelines.

## Architecture & Hardware Guardrails
- **Transport**: WebSockets (via FastAPI `WebSocket`). 
- **Overhead Constraint**: Must consume < 0.1% CPU. Polling is strictly capped at **1Hz or 2Hz** (1-2 updates per second). Do NOT attempt 60Hz polling, as it will steal CPU cycles from FFmpeg and OpenVINO.
- **CPU & System RAM Data**: Gathered via the `psutil` Python library.
- **GPU & VRAM Data**: Gathered via `intel_gpu_top`.

## Implementation Design (Pipeline)
1. **The WebSocket Endpoint (`/ws/telemetry`)**:
   - Accepts incoming WS connections from the browser.
   - Enters an `asyncio` loop with a `await asyncio.sleep(1.0)` delay.
2. **Data Collection (The Monitor)**:
   - **CPU**: `psutil.cpu_percent(interval=None)`
   - **RAM**: `psutil.virtual_memory()` (returns total, used, and available memory).
   - **GPU (Intel Xe)**: 
     - Spawn a background asynchronous subprocess: `intel_gpu_top -J -s 1000` (outputs JSON every 1000ms).
     - *Note*: `intel_gpu_top` requires root/sudo privileges by default on many Linux distros. The host environment may need `setcap cap_perfmon=+ep /usr/bin/intel_gpu_top` or a `sudoers` exception for the backend to read it without a password.
3. **Payload Structure**:
   ```json
   {
     "type": "hardware_telemetry",
     "cpu_percent": 45.2,
     "ram_used_gb": 12.4,
     "ram_total_gb": 15.7,
     "gpu_busy_percent": 88.0,
     "timestamp": 1698239281.12
   }
   ```

## UI Requirements
- Found globally in the WebUI (e.g., top navbar or a floating dock).
- Simple text readouts (e.g., "RAM: 12.4/16GB | GPU: 88%").
- Colors shift to yellow/red when approaching limits (e.g., RAM > 90%).

## Future Expansion
By establishing the WebSocket infrastructure for telemetry, we open the door for:
- Live FFmpeg encoding progress bars.
- Live OpenVINO / VQGAN frame-by-frame streaming.
- Terminal log streaming directly into the WebUI.
