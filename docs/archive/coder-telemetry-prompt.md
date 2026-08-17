# Coder Prompt — System Telemetry & WebSockets (`telemetry`)

> **Target**: ffTransmuteWebui — backend websocket infrastructure + UI HUD
> **Spec reference**: `docs/telemetry-spec.md` (same directory)

---

## MISSION
Implement a FastAPI WebSocket endpoint that broadcasts system hardware telemetry (CPU, RAM, GPU) to the WebUI at a low-frequency (1Hz) to monitor OpenVINO/FFmpeg resource consumption.

## PHASE 1 — BACKEND: `main.py` & `telemetry.py`
Create `mtapi-project/app/telemetry.py`.

**Requirements:**
1. **Dependencies**: `psutil`, `asyncio`, `fastapi.WebSocket`.
2. **GPU Polling (`intel_gpu_top`)**:
   - Create an async background task that runs `intel_gpu_top -J -s 1000` via `asyncio.create_subprocess_exec`.
   - Read the JSON stdout line by line. Extract the GPU busy percentage (usually under `engines` -> `Render/3D/0` -> `busy`).
   - *Fallback*: If `intel_gpu_top` fails (due to missing `setcap` permissions or not installed), gracefully fallback to reporting GPU usage as `null` or `0` rather than crashing the server.
3. **CPU/RAM Polling (`psutil`)**:
   - Read `psutil.cpu_percent(interval=None)` and `psutil.virtual_memory()`.
4. **WebSocket Endpoint**:
   - In `main.py`, add an endpoint `@app.websocket("/ws/telemetry")`.
   - While the connection is open, loop every `1.0` seconds (1Hz), gather the latest stats, and send as JSON.

## PHASE 2 — FRONTEND: app.js + index.html
- **UI Element**: Add a persistent hardware HUD (e.g., in the top navbar or a floating bottom-right dock).
- **Format**: "CPU: 45% | RAM: 12.4/16GB | GPU: 88%"
- **Color Coding**: 
  - RAM > 14GB -> Red (Warning: Swap risk)
  - GPU > 95% -> Orange (Saturated)
- **Connection Logic**: 
  - Create a `WebSocket` connecting to `ws://<host>:<port>/ws/telemetry`.
  - Add auto-reconnect logic if the socket drops.
