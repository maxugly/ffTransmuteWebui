# Kickoff Prompt: Unified Speed & Time Tab

**Role:** Builder
**Task:** Implement the "Unified Speed & Time" tab redesign, deprecating the standalone RIFE tab. Update the backend/API to support this unified operation, and write comprehensive Playwright browser tests to verify all modes and mathematical readouts.

## Context & Spec
You are implementing the UI and backend logic defined in `docs/unified-speed-tab-spec.md`. 
The core objective is to merge the overlapping "Speed" and "RIFE Slo-Mo" tabs into a single deterministic tab that uses either a "Target Length" or "Target Multiplier" as its source of truth.

Read `docs/STATUS.md`, `docs/AGENTS.md`, and `docs/unified-speed-tab-spec.md` before starting.

## Requirements

### 1. Backend & API (`app/operations/speedchange_ops.py` & `app/operations/rife_ops.py`)
- Merge or orchestrate the logic so a single operation payload can handle both speed changes (FFmpeg `setpts`/`atempo`) and optional RIFE interpolation.
- Ensure audio stretching (`atempo` / `asetpts`) accurately matches the final speed multiplier when audio mode is "preserve" or "pitch".
- When RIFE is enabled, ensure the intermediate frames are generated correctly via the directory filter approach (`filter-platform-spec.md`), and the final encode sets the correct target FPS to achieve the desired output duration.

### 2. Frontend UI (`js/tabs/speedchange.js` & `app/static/index.html`)
- Rip out the old "RIFE Slo-Mo" tab entirely.
- Redesign the "Speed" tab according to the layout and modes in `docs/unified-speed-tab-spec.md`:
  - **Target Mode:** Length vs. Multiplier.
  - **RIFE Integration:** ON/OFF toggle, plus Snap vs. Free (Extra) when in Multiplier mode.
- **The Real-Time Readout:** This is critical. You must write robust JS logic to parse the input video's metadata (Duration, FPS, Total Frames) and dynamically update the readout panel on every user interaction.
- The readout must strictly display:
  - Exact Multiplier (calculated or set)
  - Final Duration & Final FPS
  - Target Total Frames
  - Required RIFE Multiplier & Generated Total Frames (only when RIFE is ON)

### 3. Testing & Verification (Playwright)
You must write Playwright tests to verify the UI modes and mathematical accuracy in a fully headed browser. The tests must verify:
- **UI State Toggles:** Switching between Length and Multiplier modes shows/hides the correct inputs.
- **Math Readout Verification:**
  - Mock an input video (e.g., 4s, 30fps).
  - Select "Multiplier" = 0.5x. Assert readout shows Final Duration = 8.0s, Target Total Frames = 120.
  - Select "Length" = 10.0s. Assert Exact Multiplier = 0.4x.
  - Toggle RIFE ON, select "Multiplier" = 3.3x, select "Free (Extra)". Assert Required RIFE Multiplier = 4x, Generated Total Frames > Target Total Frames.
- **End-to-End Execution Verification:** Submit the job and verify the final output file actually matches the promised Final Duration and FPS. Verify the audio stream is properly stretched (`ffprobe`).

## System Invariants Checklist (Non-Negotiable)
- [ ] No subprocesses in `main.py`. Use `shell.run_command`.
- [ ] Absolute I/O paths only.
- [ ] UI must be vanilla HTML5/JS/CSS. No React/Tailwind.
- [ ] Do not invent a second dump/encode stack for RIFE. Use the existing filter platform `dump -> filters -> encode`.
- [ ] Progress reporting must work during the operation (`report_progress()`).
- [ ] Verify the actual WebUI by clicking via Playwright, not just testing the API via curl.

When you are finished, confirm all tests pass, the output file matches the exact duration/FPS readouts, and the UI behaves strictly according to the spec.
