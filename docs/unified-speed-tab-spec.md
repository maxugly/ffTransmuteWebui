# Spec: Unified Speed & Time Tab

> **Status:** Draft (UI Overhaul)
> **Goal:** Consolidate "Speed" and "RIFE Slo-Mo" tabs into a single, deterministic source of truth for time/speed manipulation.

## 1. The Problem
Currently, "Speed" and "RIFE Slo-Mo" exist as separate tabs or overlap confusingly. Users can set independent variables (FPS, RIFE multiplier, Speed factor) that mathematically conflict. Furthermore, the reporting bar often outputs incorrect final durations (e.g., estimating 2.6s for a 4s video at 0.5x speed). 

## 2. Core Concept: The Target Mode
The tab is anchored by a single primary selector: **Target Mode**. This dictates what drives the underlying math and determines which controls are visible.

### Mode A: Target Length (Duration)
The user defines exactly how long the output video should be (e.g., `10.0` seconds).
- **Inputs shown:** Target Length (seconds).
- **Hidden:** Manual Speed Multiplier knob.
- **Math:** Speed factor is automatically calculated as `Input Duration / Target Length`.

### Mode B: Target Multiplier (Speed Factor)
The user defines the exact speed multiplier (e.g., `0.5x` for half speed).
- **Inputs shown:** Speed Multiplier (0.1x - 10.0x).
- **Hidden:** Target Length input.
- **Math:** Target length is automatically calculated as `Input Duration / Speed Multiplier`.

## 3. RIFE (Interpolation) Integration
RIFE can be toggled **ON** or **OFF** in either Target Mode. 
- **If OFF:** No RIFE-related controls are shown. The speed change relies purely on FFmpeg `setpts`/`atempo` (dropping or duplicating frames).
- **If ON:** RIFE is used to generate intermediate frames for smooth slow-motion.

### The "Snap vs. Free (Extra)" Toggle
When **Target Mode = Multiplier** AND **RIFE = ON**, a secondary toggle appears:
- **Snap (Default):** The Speed Multiplier knob locks into exact valid RIFE multipliers (e.g., 2x, 4x, 8x).
- **Free (Extra):** The user can set an arbitrary speed multiplier (e.g., 3.3x). The system calculates the next highest valid RIFE multiplier (e.g., 4x) to ensure enough frames are generated. The UI readouts will reflect the "extra" frames generated before the final trim/adjust to hit the exact requested 3.3x speed.

## 4. The Real-Time Readout (Source of Truth)
A constantly updating panel below the controls provides the hard math for the final output. It must update strictly on user input change and accurately reflect the calculations.

**Always Displayed:**
- **Original Properties:** `Duration: [X]s | FPS: [Y] | Total Frames: [Z]`
- **Target Properties:** `Final Duration: [X]s | Final FPS: [Y]`
- **Exact Multiplier:** The precise calculated speed multiplier (whether set manually or derived from Target Length). Example: `Exact Speed: 0.5x`
- **Target Total Frames:** Exactly how many frames are required to achieve the requested length/speed.

**Displayed ONLY when RIFE is ON:**
- **Required RIFE Multiplier:** The native RIFE multiplier chosen by the system (rounded up to the next valid step if necessary). Example: `RIFE Multiplier: 4x`
- **Generated Total Frames:** The actual number of frames the RIFE pass will create before any final conforming/trimming to hit the target. Example: `Generated Frames: 480 (overshot target of 330)`

## 5. UI Layout Example
```text
[ Speed & Time Tab ]

Target Mode: ( ) Length   (*) Multiplier
Speed Multiplier: [===========O======] 0.5x

RIFE Interpolation: [ ON ]
Mode: (*) Snap to RIFE multipliers   ( ) Free (Extra frames)
RIFE Model: [ rife-v4.6 ]

------------------------------------------------
REAL-TIME OUTPUT READOUT
Original: 4.00s @ 30 FPS (120 frames)

Exact Speed: 0.5x
Final Duration: 8.00s
Final FPS: 60 FPS
Target Total Frames: 480 frames

Required RIFE Multiplier: 2x
Generated Total Frames: 480 frames
------------------------------------------------
```
